// ===========================================================================
// Presupuesto mensual.
//
// No hay que capturar nada: el presupuesto sale de lo que ya gastaste. Esta
// vista sólo muestra el cálculo y deja ajustar los topes que quieras fijar tú.
//
// Ningún número se calcula aquí — todo viene de finance.js.
// ===========================================================================

import { el, mount, toast, withBusy } from '../dom.js';
import * as fin from '../finance.js';
import * as store from '../store.js';

export function renderBudget(root, state, actions) {
  const month = state.month;
  const { from, to } = fin.monthRange(month);
  const monthTxs = fin.filterTransactions(state.transactions, { from, to });

  const prev = fin.monthRange(fin.previousMonth(month));
  const prevTxs = fin.filterTransactions(state.transactions, { from: prev.from, to: prev.to });

  const sugerido = fin.suggestBudget(state.transactions, state.categoryMap, { upTo: month });
  const income = fin.typicalIncome(state.transactions, { upTo: month });
  const pace = fin.spendingPace(monthTxs, month);

  // Los topes guardados ganan sobre la sugerencia.
  const topes = new Map();
  for (const l of sugerido.lines) topes.set(l.category_id, l.suggested);
  for (const b of state.budgets ?? []) {
    if (b.month === null || b.month === month) {
      if (b.amount !== null) topes.set(b.category_id, Number(b.amount));
    }
  }

  const progreso = fin.budgetProgress(monthTxs, topes, state.categoryMap);
  const observaciones = fin.budgetInsights({
    monthTxs, prevTxs, categories: state.categoryMap, income, pace, budget: progreso,
  });

  mount(root,
    el('div', { class: 'view' },
      monthBar(month, actions),

      sugerido.monthsUsed === 0
        ? sinDatos()
        : [
            resumen(income, pace, progreso, monthTxs),
            observaciones.length ? insightsCard(observaciones) : null,
            tablaPresupuesto(progreso, sugerido, state, actions, month),
            confianza(sugerido),
          ],
    ),
  );
}

// ---------------------------------------------------------------------------
function monthBar(month, actions) {
  return el('div', { class: 'monthbar' },
    el('button', {
      class: 'btn btn--ghost', 'aria-label': 'Mes anterior',
      onclick: () => actions.setMonth(fin.previousMonth(month)),
    }, '‹'),
    el('h2', { class: 'monthbar__label' }, fin.monthLabel(month)),
    el('button', {
      class: 'btn btn--ghost', 'aria-label': 'Mes siguiente',
      disabled: month >= fin.currentMonth(),
      onclick: () => actions.setMonth(nextMonth(month)),
    }, '›'),
  );
}

const sinDatos = () => el('section', { class: 'card' },
  el('h3', {}, 'Todavía no hay con qué'),
  el('p', { class: 'muted' },
    'El presupuesto se calcula con tus meses ya cerrados. Importa al menos un ' +
    'estado de cuenta de un mes completo y aquí aparecerá solo, sin que tengas ' +
    'que capturar nada.'),
);

// ---------------------------------------------------------------------------
function resumen(income, pace, progreso, monthTxs) {
  const ahorro = fin.savingsRate(monthTxs);
  const ingresoRef = income.median || ahorro.income;

  // Contra qué se compara el ingreso, en orden de qué tan confiable es:
  //   mes cerrado      → lo que realmente se gastó
  //   mes avanzado     → la proyección del ritmo actual
  //   mes recién empezado → el presupuesto, porque la proyección es ruido
  //     (y así este número concuerda con el de "Podrías apartar")
  const gastoDeReferencia = !pace.isCurrentMonth ? ahorro.expense
    : pace.reliable ? pace.projected
    : (progreso.totalBudget || pace.projected);
  const restante = Math.round((ingresoRef - gastoDeReferencia) * 100) / 100;

  return el('div', { class: 'stats' },
    stat('Ingreso típico', fin.formatMoney(ingresoRef), 'in',
      income.monthsUsed ? `mediana de ${income.monthsUsed} mes${income.monthsUsed === 1 ? '' : 'es'}` : null),
    stat('Gastado', fin.formatMoney(pace.spent), 'out',
      pace.isCurrentMonth ? `en ${pace.daysElapsed} de ${pace.daysInMonth} días` : 'mes cerrado'),
    pace.isCurrentMonth
      ? stat('Si sigues así', fin.formatMoney(pace.projected),
          // Sin datos suficientes no se pinta de rojo: sería alarmar por ruido.
          pace.reliable && pace.projected > ingresoRef && ingresoRef > 0 ? 'out' : 'neutral',
          pace.reliable
            ? `${fin.formatMoney(pace.perDay)} al día`
            : 'aún es pronto para fiarse')
      : stat('Balance', fin.formatMoney(ahorro.net), ahorro.net >= 0 ? 'in' : 'out', null),
    stat('Te quedaría', fin.formatMoney(restante),
      restante >= 0 ? 'in' : 'out',
      !pace.isCurrentMonth && ahorro.rate !== null
        ? `${Math.round(ahorro.rate)}% de ahorro real`
        : pace.reliable ? 'según tu ritmo' : 'según tu presupuesto'),
  );
}

function stat(label, value, tone, hint) {
  return el('div', { class: `stat stat--${tone}` },
    el('span', { class: 'stat__label' }, label),
    el('strong', { class: 'stat__value' }, value),
    hint && el('span', { class: 'stat__delta' }, hint),
  );
}

// ---------------------------------------------------------------------------
function insightsCard(observaciones) {
  return el('section', { class: 'card' },
    el('h3', {}, 'Qué dicen tus números'),
    el('ul', { class: 'insights' },
      observaciones.map((o) => el('li', { class: `insight insight--${o.tone}` },
        el('strong', {}, o.title),
        el('span', { class: 'muted' }, o.detail),
      ))),
  );
}

// ---------------------------------------------------------------------------
function tablaPresupuesto(progreso, sugerido, state, actions, month) {
  const sugeridoPorId = new Map(sugerido.lines.map((l) => [l.category_id, l]));

  return el('section', { class: 'card' },
    el('div', { class: 'card__head' },
      el('h3', {}, 'Presupuesto por categoría'),
      el('span', { class: 'muted' },
        `${fin.formatMoney(progreso.totalSpent)} de ${fin.formatMoney(progreso.totalBudget)}`),
    ),
    el('p', { class: 'note' },
      'Los topes salen de la mediana de tus meses cerrados. Se usa la mediana y ' +
      'no el promedio para que un viaje o una compra grande no se convierta en ' +
      'tu gasto “normal”. Puedes escribir otro monto y se guarda.'),

    el('div', { class: 'table-wrap' },
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Categoría'),
          el('th', { class: 'num' }, 'Gastado'),
          el('th', { class: 'num' }, 'Tope'),
          el('th', {}, 'Avance'),
          el('th', { class: 'num' }, 'Queda'))),
        el('tbody', {}, progreso.lines.map((l) =>
          fila(l, sugeridoPorId.get(l.category_id), state, actions, month))),
      ),
    ),
  );
}

function fila(l, sugerencia, state, actions, month) {
  const pct = l.ratio === null ? null : Math.min(l.ratio, 1.5);

  return el('tr', { class: l.over ? 'is-over' : '' },
    el('td', {},
      el('span', { class: 'chip__dot', style: { background: l.color } }),
      ' ', l.name,
      sugerencia && sugerencia.months < 2 && el('span', {
        class: 'tag', title: 'Calculado con un solo mes',
      }, '1 mes'),
    ),
    el('td', { class: 'num' }, fin.formatMoney(l.spent)),
    el('td', { class: 'num' },
      el('input', {
        type: 'number', step: '50', min: '0', class: 'input-tope',
        value: l.limit ?? '',
        placeholder: sugerencia ? String(sugerencia.suggested) : '—',
        title: sugerencia
          ? `Sugerido ${fin.formatMoney(sugerencia.suggested)} · promedio ${fin.formatMoney(sugerencia.average)} · máximo ${fin.formatMoney(sugerencia.max)}`
          : 'Sin historial para sugerir',
        onchange: (e) => guardarTope(e.target, l, month, actions),
      })),
    el('td', {},
      pct === null
        ? el('span', { class: 'muted' }, '—')
        : el('span', { class: 'rank__track' },
            el('span', {
              class: 'rank__fill',
              style: {
                width: `${Math.min(pct, 1) * 100}%`,
                background: l.over ? 'var(--out)' : pct > 0.85 ? 'var(--warn)' : 'var(--in)',
              },
            }))),
    el('td', { class: `num ${l.over ? 'is-bad' : ''}` },
      l.remaining === null ? '—' : fin.formatMoney(l.remaining)),
  );
}

async function guardarTope(input, linea, month, actions) {
  const valor = input.value.trim();
  const amount = valor === '' ? null : Number(valor);
  if (amount !== null && !(amount >= 0)) {
    return toast('El tope debe ser un número positivo.', 'error');
  }
  if (!linea.category_id) {
    return toast('Esa categoría no se puede presupuestar.', 'error');
  }
  try {
    // `month: null` = tope permanente, no sólo de este mes.
    await store.saveBudget({ category_id: linea.category_id, amount, month: null });
    toast(amount === null
      ? `${linea.name} vuelve al tope sugerido.`
      : `Tope de ${linea.name}: ${fin.formatMoney(amount)}.`, 'ok');
    await actions.reload();
  } catch (err) {
    toast(store.dbErrorMessage(err), 'error', 8000);
  }
}

// ---------------------------------------------------------------------------
function confianza(sugerido) {
  const textos = {
    baja: 'Con un solo mes cerrado, esto es casi una copia de ese mes. ' +
      'Conforme subas más estados de cuenta, los topes se van afinando solos.',
    media: 'Va con pocos meses de historia. Sigue subiendo estados de cuenta ' +
      'y los topes se vuelven más certeros.',
    alta: 'Suficiente historia para que los topes sean representativos.',
  };
  return el('p', { class: 'note note--inline' },
    `Calculado con ${sugerido.monthsUsed} mes${sugerido.monthsUsed === 1 ? '' : 'es'} ` +
    `cerrado${sugerido.monthsUsed === 1 ? '' : 's'}. ${textos[sugerido.confidence]}`);
}

function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
