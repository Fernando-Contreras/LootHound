// ===========================================================================
// FUENTE ÚNICA DE VERDAD para todo cálculo de dinero.
//
// Regla del proyecto (igual que en Stoic): ninguna suma, resta, promedio o
// porcentaje se escribe en otro archivo. Si necesitas un número nuevo, se
// agrega aquí. La UI sólo consume estas funciones.
//
// Convención de signos — vive SÓLO en `signedAmount()`:
//   `amount` en la base de datos es SIEMPRE positivo.
//   El signo lo determina `kind`:
//     expense  → negativo
//     income   → positivo
//     transfer → 0 en los totales (mueve dinero entre cuentas propias:
//                pagar la tarjeta desde el débito, o meter a una Cajita de Nu,
//                no es ni gasto ni ingreso; contarlo inflaría ambos lados).
// ===========================================================================

/** Único lugar donde un movimiento se convierte en número con signo. */
export function signedAmount(tx) {
  if (tx.kind === 'expense') return -Number(tx.amount);
  if (tx.kind === 'income') return Number(tx.amount);
  return 0; // transfer
}

/** ¿Este movimiento entra en los totales de ingreso/gasto? */
export function isCountable(tx) {
  return tx.kind === 'expense' || tx.kind === 'income';
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------------------
// Resúmenes
// ---------------------------------------------------------------------------

/** Totales de un conjunto de movimientos. */
export function summarize(txs) {
  let income = 0, expense = 0, transfers = 0;
  for (const tx of txs) {
    if (tx.kind === 'income') income += Number(tx.amount);
    else if (tx.kind === 'expense') expense += Number(tx.amount);
    else transfers += Number(tx.amount);
  }
  return {
    income: round2(income),
    expense: round2(expense),
    net: round2(income - expense),
    transfers: round2(transfers),
    count: txs.length,
  };
}

/**
 * Desglose por categoría.
 * @param {Array} txs
 * @param {'expense'|'income'} kind
 * @param {Map<string,object>} categories  id → categoría
 */
export function byCategory(txs, kind, categories) {
  const buckets = new Map();
  let total = 0;
  for (const tx of txs) {
    if (tx.kind !== kind) continue;
    const id = tx.category_id || '__none__';
    const cur = buckets.get(id) || { id, amount: 0, count: 0 };
    cur.amount += Number(tx.amount);
    cur.count += 1;
    buckets.set(id, cur);
    total += Number(tx.amount);
  }
  return [...buckets.values()]
    .map((b) => {
      const cat = categories?.get(b.id);
      return {
        ...b,
        amount: round2(b.amount),
        name: cat?.name || 'Sin categoría',
        color: cat?.color || '#94a3b8',
        share: total > 0 ? b.amount / total : 0,
      };
    })
    .sort((a, b) => b.amount - a.amount);
}

/** Desglose por cuenta. */
export function byAccount(txs, accounts) {
  const buckets = new Map();
  for (const tx of txs) {
    const cur = buckets.get(tx.account_id) ||
      { id: tx.account_id, income: 0, expense: 0, count: 0 };
    if (tx.kind === 'income') cur.income += Number(tx.amount);
    else if (tx.kind === 'expense') cur.expense += Number(tx.amount);
    cur.count += 1;
    buckets.set(tx.account_id, cur);
  }
  return [...buckets.values()].map((b) => ({
    ...b,
    income: round2(b.income),
    expense: round2(b.expense),
    net: round2(b.income - b.expense),
    name: accounts?.get(b.id)?.name || '—',
  })).sort((a, b) => b.expense - a.expense);
}

/** Serie mensual, ordenada de más viejo a más nuevo. */
export function byMonth(txs) {
  const buckets = new Map();
  for (const tx of txs) {
    const key = String(tx.occurred_on).slice(0, 7); // YYYY-MM
    const cur = buckets.get(key) || { month: key, income: 0, expense: 0, count: 0 };
    if (tx.kind === 'income') cur.income += Number(tx.amount);
    else if (tx.kind === 'expense') cur.expense += Number(tx.amount);
    cur.count += 1;
    buckets.set(key, cur);
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, income: round2(b.income), expense: round2(b.expense), net: round2(b.income - b.expense) }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** Promedio de gasto diario dentro de un rango. */
export function dailyAverage(txs, fromISO, toISO) {
  const { expense } = summarize(txs);
  const days = daysBetween(fromISO, toISO);
  return days > 0 ? round2(expense / days) : 0;
}

/** Los N comercios donde más se gastó. */
export function topMerchants(txs, n = 5) {
  const buckets = new Map();
  for (const tx of txs) {
    if (tx.kind !== 'expense') continue;
    const key = tx.description.toUpperCase();
    const cur = buckets.get(key) || { description: tx.description, amount: 0, count: 0 };
    cur.amount += Number(tx.amount);
    cur.count += 1;
    buckets.set(key, cur);
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, amount: round2(b.amount) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, n);
}

/**
 * Conciliación de efectivo.
 *
 * El efectivo es el único dinero sin rastro digital, así que se deduce:
 *   lo que sacaste del cajero  −  lo que capturaste como gasto en efectivo
 *   =  lo que debería quedar en tu cartera
 *
 * Si el número no cuadra con lo que traes, te faltó capturar algún gasto.
 * Los retiros salen solos de los estados de cuenta (BBVA débito los marca como
 * "RETIRO SIN TARJETA"), así que esto no requiere capturar nada extra.
 *
 * @param {Array} txs            todos los movimientos del periodo
 * @param {string} cashAccountId id de la cuenta "Efectivo"
 */
export function cashReconciliation(txs, cashAccountId) {
  if (!cashAccountId) return null;

  let withdrawn = 0;   // transferencias que ENTRAN al efectivo
  let spent = 0;       // gastos pagados en efectivo
  let returned = 0;    // efectivo que devolviste al banco (raro, pero pasa)

  for (const tx of txs) {
    const amount = Number(tx.amount);
    if (tx.kind === 'transfer' && tx.counter_account_id === cashAccountId) {
      withdrawn += amount;                    // salió del banco → entró a la cartera
    } else if (tx.kind === 'transfer' && tx.account_id === cashAccountId) {
      returned += amount;                     // salió de la cartera → volvió al banco
    } else if (tx.account_id === cashAccountId) {
      if (tx.kind === 'expense') spent += amount;
      else if (tx.kind === 'income') withdrawn += amount;  // efectivo que te dieron
    }
  }

  const expected = round2(withdrawn - spent - returned);
  return {
    withdrawn: round2(withdrawn),
    spent: round2(spent),
    returned: round2(returned),
    /** Lo que deberías traer en la cartera si capturaste todo. */
    expectedOnHand: expected,
    /** Sin capturar nada, todo el retiro aparece como "pendiente". */
    unaccounted: round2(withdrawn - spent - returned),
  };
}

/** Compara dos periodos y devuelve la variación porcentual del gasto. */
export function comparePeriods(current, previous) {
  const a = summarize(current);
  const b = summarize(previous);
  const pct = (now, before) => {
    if (before === 0) return now === 0 ? 0 : null; // null = sin base de comparación
    return round2(((now - before) / before) * 100);
  };
  return {
    current: a,
    previous: b,
    expenseChangePct: pct(a.expense, b.expense),
    incomeChangePct: pct(a.income, b.income),
  };
}

// ===========================================================================
// PRESUPUESTO
//
// Se calcula solo, a partir de lo que ya gastaste. La idea es no tener que
// sentarse a inventar números cada mes.
//
// Se usa la MEDIANA y no el promedio a propósito: un mes con un viaje o una
// compra grande jala el promedio hacia arriba y acabaría "presupuestando" ese
// gasto extraordinario todos los meses. La mediana lo ignora.
// ===========================================================================

/** Mediana de una lista de números. */
export function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : round2((s[m - 1] + s[m]) / 2);
}

/**
 * Sugiere un presupuesto mensual por categoría con base en el historial.
 *
 * @param {Array} txs           todos los movimientos
 * @param {Map} categories      id → categoría
 * @param {object} options
 * @param {string} options.upTo mes 'YYYY-MM' hasta el cual mirar (exclusivo)
 * @param {number} options.months cuántos meses cerrados considerar
 */
export function suggestBudget(txs, categories, { upTo = currentMonth(), months = 6 } = {}) {
  // Sólo meses YA CERRADOS: incluir el mes en curso, que va a la mitad,
  // arrastraría la sugerencia hacia abajo.
  const cerrados = [...new Set(txs
    .filter((t) => t.kind === 'expense')
    .map((t) => String(t.occurred_on).slice(0, 7))
    .filter((m) => m < upTo))]
    .sort()
    .slice(-months);

  // Primero, cuánto se gastó en cada categoría en cada mes.
  const gastoPorMes = new Map();          // mes → (categoría → monto)
  const todasLasCategorias = new Set();
  for (const mes of cerrados) {
    const { from, to } = monthRange(mes);
    const delMes = filterTransactions(txs, { from, to, kinds: ['expense'] });
    const deEsteMes = new Map();
    for (const b of byCategory(delMes, 'expense', categories)) {
      deEsteMes.set(b.id, b.amount);
      todasLasCategorias.add(b.id);
    }
    gastoPorMes.set(mes, deEsteMes);
  }

  // Después, una serie por categoría con UN valor por mes, rellenando con
  // cero los meses donde no hubo gasto.
  //
  // Ese relleno es lo que hace que la mediana sirva: un viaje que ocurrió una
  // vez en tres meses da la serie [0, 0, 30000], cuya mediana es 0 — o sea, no
  // se presupuesta como gasto mensual. Sin el cero quedaría [30000] y parecería
  // que viajas todos los meses.
  const porCategoria = new Map();
  for (const id of todasLasCategorias) {
    porCategoria.set(id, cerrados.map((mes) => gastoPorMes.get(mes).get(id) ?? 0));
  }

  const lineas = [...porCategoria.entries()].map(([id, montos]) => {
    const cat = categories?.get(id);
    return {
      category_id: id === '__none__' ? null : id,
      name: cat?.name || 'Sin categoría',
      color: cat?.color || '#94a3b8',
      suggested: round2(median(montos)),
      average: round2(montos.reduce((a, b) => a + b, 0) / montos.length),
      max: round2(Math.max(...montos)),
      months: montos.length,
    };
  }).filter((l) => l.suggested > 0)
    .sort((a, b) => b.suggested - a.suggested);

  return {
    lines: lineas,
    total: round2(lineas.reduce((a, l) => a + l.suggested, 0)),
    monthsUsed: cerrados.length,
    /** Con uno o dos meses la sugerencia es poco más que una copia. */
    confidence: cerrados.length >= 4 ? 'alta' : cerrados.length >= 2 ? 'media' : 'baja',
  };
}

/** Ingreso mensual típico, para saber contra qué comparar el gasto. */
export function typicalIncome(txs, { upTo = currentMonth(), months = 6 } = {}) {
  const porMes = byMonth(txs.filter((t) => t.kind === 'income'))
    .filter((m) => m.month < upTo)
    .slice(-months);
  return {
    median: round2(median(porMes.map((m) => m.income))),
    monthsUsed: porMes.length,
  };
}

/**
 * Cómo va el mes contra el presupuesto.
 * `budget` es un Map de category_id → monto (null = sin tope).
 */
export function budgetProgress(monthTxs, budget, categories) {
  const gastado = byCategory(monthTxs, 'expense', categories);
  const porId = new Map(gastado.map((g) => [g.id, g]));

  const ids = new Set([...porId.keys(), ...budget.keys()]);
  const lineas = [...ids].map((id) => {
    const g = porId.get(id);
    const limite = budget.get(id) ?? null;
    const usado = g?.amount ?? 0;
    const cat = categories?.get(id);
    return {
      category_id: id === '__none__' ? null : id,
      name: cat?.name || g?.name || 'Sin categoría',
      color: cat?.color || g?.color || '#94a3b8',
      spent: round2(usado),
      limit: limite,
      remaining: limite === null ? null : round2(limite - usado),
      ratio: limite ? usado / limite : null,
      over: limite !== null && usado > limite,
    };
  }).sort((a, b) => b.spent - a.spent);

  const conLimite = lineas.filter((l) => l.limit !== null);
  return {
    lines: lineas,
    totalSpent: round2(lineas.reduce((a, l) => a + l.spent, 0)),
    totalBudget: round2(conLimite.reduce((a, l) => a + l.limit, 0)),
    overCount: lineas.filter((l) => l.over).length,
  };
}

/**
 * Ritmo de gasto: a cómo vas y a dónde llegarías si sigues igual.
 * Sólo tiene sentido para el mes en curso.
 */
export function spendingPace(monthTxs, month) {
  const { from, to } = monthRange(month);
  const hoy = todayISO();
  const esMesActual = month === currentMonth();
  const corte = esMesActual && hoy < to ? hoy : to;

  const diasTranscurridos = daysBetween(from, corte);
  const diasDelMes = daysBetween(from, to);
  const { expense } = summarize(monthTxs);

  const porDia = diasTranscurridos > 0 ? expense / diasTranscurridos : 0;
  return {
    spent: round2(expense),
    perDay: round2(porDia),
    daysElapsed: diasTranscurridos,
    daysInMonth: diasDelMes,
    daysLeft: Math.max(0, diasDelMes - diasTranscurridos),
    /** A dónde llegaría el mes si el ritmo no cambia. */
    projected: round2(porDia * diasDelMes),
    isCurrentMonth: esMesActual,
    /**
     * Con pocos días la proyección no significa nada: una compra grande el
     * día 1 proyecta un mes catastrófico. Por debajo de una semana el número
     * se muestra, pero no se usa para alarmar.
     */
    reliable: !esMesActual || diasTranscurridos >= 7,
  };
}

/**
 * Cuánto de lo que entra te queda. Negativo = gastaste más de lo que ganaste.
 * Las transferencias no cuentan de ningún lado (ver signedAmount).
 */
export function savingsRate(txs) {
  const { income, expense, net } = summarize(txs);
  return {
    income, expense, net,
    rate: income > 0 ? round2((net / income) * 100) : null,
  };
}

/**
 * Observaciones sobre los números. Nada de consejos de inversión: sólo lo que
 * los propios datos dicen, con el detalle que lo respalda.
 *
 * @returns {Array<{tone, title, detail}>}
 */
export function budgetInsights({ monthTxs, prevTxs, categories, income, pace, budget }) {
  const obs = [];
  const ahorro = savingsRate(monthTxs);
  const cats = byCategory(monthTxs, 'expense', categories);

  // --- lo más importante: ¿alcanza? ---------------------------------------
  const ingresoEsperado = income.median || ahorro.income;

  // Con menos de una semana transcurrida no se proyecta nada: sería alarmar
  // (o tranquilizar) con ruido. Se dice lo que hay y ya.
  if (pace.isCurrentMonth && !pace.reliable) {
    obs.push({
      tone: 'info',
      title: `Van ${formatMoney(pace.spent)} en ${pace.daysElapsed} día${pace.daysElapsed === 1 ? '' : 's'}`,
      detail: 'Todavía es muy pronto para proyectar el mes: una sola compra ' +
        'grande distorsiona el cálculo. A partir del día 7 aparece la proyección.',
    });
  } else if (ingresoEsperado > 0) {
    const proyectado = pace.isCurrentMonth ? pace.projected : ahorro.expense;
    const sobra = round2(ingresoEsperado - proyectado);
    if (sobra < 0) {
      obs.push({
        tone: 'bad',
        title: `Vas a quedar corto por ${formatMoney(Math.abs(sobra))}`,
        detail: pace.isCurrentMonth
          ? `Al ritmo actual (${formatMoney(pace.perDay)} al día) el mes cerraría en ` +
            `${formatMoney(proyectado)}, contra ${formatMoney(ingresoEsperado)} de ingreso típico.`
          : `Gastaste ${formatMoney(proyectado)} contra ${formatMoney(ingresoEsperado)} de ingreso.`,
      });
    } else {
      obs.push({
        tone: 'good',
        title: `Te quedarían ${formatMoney(sobra)} este mes`,
        detail: `${Math.round((sobra / ingresoEsperado) * 100)}% de tu ingreso típico ` +
          `(${formatMoney(ingresoEsperado)}).`,
      });
    }
  }

  // --- concentración del gasto --------------------------------------------
  // Sólo cuando ya hay suficientes movimientos: al día 2, "Comida es el 100%
  // de tu gasto" es cierto y completamente inútil.
  if (cats.length && ahorro.expense > 0 && monthTxs.length >= 8) {
    const top = cats[0];
    if (top.share >= 0.35) {
      obs.push({
        tone: 'warn',
        title: `${top.name} se lleva ${Math.round(top.share * 100)}% de tu gasto`,
        detail: `${formatMoney(top.amount)} de ${formatMoney(ahorro.expense)}. ` +
          'Si quieres mover la aguja, es la categoría con más margen.',
      });
    }
  }

  // --- comparación con el mes anterior ------------------------------------
  // Sólo si el mes ya lleva camino: comparar dos días contra un mes completo
  // siempre diría "gastas mucho menos", lo cual no informa nada.
  if (prevTxs?.length && pace.reliable) {
    const cmp = comparePeriods(monthTxs, prevTxs);
    if (cmp.expenseChangePct !== null && Math.abs(cmp.expenseChangePct) >= 15) {
      const subio = cmp.expenseChangePct > 0;
      obs.push({
        tone: subio ? 'warn' : 'good',
        title: `Gastas ${Math.round(Math.abs(cmp.expenseChangePct))}% ` +
          `${subio ? 'más' : 'menos'} que el mes pasado`,
        detail: `${formatMoney(cmp.current.expense)} contra ${formatMoney(cmp.previous.expense)}.`,
      });
    }
  }

  // --- categorías pasadas de su tope --------------------------------------
  const pasadas = budget?.lines?.filter((l) => l.over) ?? [];
  for (const l of pasadas.slice(0, 3)) {
    obs.push({
      tone: 'warn',
      title: `${l.name} se pasó ${formatMoney(Math.abs(l.remaining))}`,
      detail: `Llevas ${formatMoney(l.spent)} de ${formatMoney(l.limit)} presupuestados.`,
    });
  }

  // --- cuánto se puede apartar ---------------------------------------------
  // Aritmética sobre tus propios datos: lo que entra menos lo que gastas de
  // forma recurrente. No es un consejo de inversión, es una resta.
  if (income.median > 0 && budget?.totalBudget > 0) {
    const margen = round2(income.median - budget.totalBudget);
    if (margen > 0) {
      obs.push({
        tone: 'info',
        title: `Podrías apartar ${formatMoney(margen)} al mes`,
        detail: `Es lo que sobra entre tu ingreso típico (${formatMoney(income.median)}) ` +
          `y tu gasto recurrente presupuestado (${formatMoney(budget.totalBudget)}). ` +
          'Los gastos esporádicos, como un viaje, salen de ahí.',
      });
    } else {
      obs.push({
        tone: 'bad',
        title: 'Tu gasto recurrente se come todo el ingreso',
        detail: `Presupuestas ${formatMoney(budget.totalBudget)} al mes contra ` +
          `${formatMoney(income.median)} que entran. Sin margen, cualquier ` +
          'imprevisto se va a deuda.',
      });
    }
  }

  // --- ritmo diario --------------------------------------------------------
  if (pace.isCurrentMonth && pace.daysLeft > 0 && budget?.totalBudget > 0) {
    const restante = round2(budget.totalBudget - budget.totalSpent);
    if (restante > 0) {
      obs.push({
        tone: 'info',
        title: `Te quedan ${formatMoney(restante / pace.daysLeft)} al día`,
        detail: `${formatMoney(restante)} para los ${pace.daysLeft} días que faltan del mes.`,
      });
    }
  }

  return obs;
}

// ---------------------------------------------------------------------------
// Filtros
// ---------------------------------------------------------------------------

/**
 * Filtra movimientos. Todos los campos del filtro son opcionales.
 * @param {Array} txs
 * @param {{from?:string, to?:string, accountIds?:string[], categoryIds?:string[],
 *          kinds?:string[], search?:string, includeTransfers?:boolean}} f
 */
export function filterTransactions(txs, f = {}) {
  const search = f.search ? f.search.trim().toUpperCase() : null;
  return txs.filter((tx) => {
    if (f.from && tx.occurred_on < f.from) return false;
    if (f.to && tx.occurred_on > f.to) return false;
    if (f.accountIds?.length && !f.accountIds.includes(tx.account_id)) return false;
    if (f.categoryIds?.length && !f.categoryIds.includes(tx.category_id)) return false;
    if (f.kinds?.length && !f.kinds.includes(tx.kind)) return false;
    if (f.includeTransfers === false && tx.kind === 'transfer') return false;
    if (search) {
      const hay = `${tx.description} ${tx.note || ''}`.toUpperCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Fechas — todo en ISO 'YYYY-MM-DD', sin objetos Date, para que la zona
// horaria nunca corra un movimiento al día anterior.
// ---------------------------------------------------------------------------

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 'YYYY-MM' → { from, to } con el primer y último día del mes. */
export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

export function currentMonth() {
  return todayISO().slice(0, 7);
}

/** Mes anterior a 'YYYY-MM'. */
export function previousMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function daysBetween(fromISO, toISO) {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86400000) + 1;
}

const MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MESES_LARGOS[m - 1]} ${y}`;
}

export function dateLabel(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return `${d} ${MESES_LARGOS[m - 1]?.slice(0, 3)} ${y}`;
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

const MXN = new Intl.NumberFormat('es-MX', {
  style: 'currency', currency: 'MXN', minimumFractionDigits: 2,
});

export function formatMoney(n) {
  return MXN.format(Number(n) || 0);
}

/** Formato con signo explícito según el `kind`, para las listas. */
export function formatSigned(tx) {
  const n = Number(tx.amount) || 0;
  if (tx.kind === 'transfer') return `↔ ${MXN.format(n)}`;
  return `${tx.kind === 'expense' ? '−' : '+'} ${MXN.format(n)}`;
}
