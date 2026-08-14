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
