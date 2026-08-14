// Dashboard: balance del mes, desglose por categoría, tendencia.
// Ningún cálculo se hace aquí: todo sale de finance.js.

import { el, mount } from '../dom.js';
import { donut, legend, monthlyBars, rankBars } from '../charts.js';
import * as fin from '../finance.js';

export function renderDashboard(root, state, actions) {
  const month = state.month;
  const { from, to } = fin.monthRange(month);

  const monthTxs = fin.filterTransactions(state.transactions, { from, to });
  const prev = fin.monthRange(fin.previousMonth(month));
  const prevTxs = fin.filterTransactions(state.transactions, { from: prev.from, to: prev.to });

  const totals = fin.summarize(monthTxs);
  const cmp = fin.comparePeriods(monthTxs, prevTxs);
  const cats = fin.byCategory(monthTxs, 'expense', state.categoryMap);
  const accounts = fin.byAccount(monthTxs, state.accountMap);
  const months = fin.byMonth(state.transactions).slice(-6);
  const merchants = fin.topMerchants(monthTxs, 5);

  mount(root,
    el('div', { class: 'view' },

      // ---- selector de mes -------------------------------------------
      el('div', { class: 'monthbar' },
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
      ),

      // ---- tarjetas de balance ---------------------------------------
      el('div', { class: 'stats' },
        stat('Ingresos', fin.formatMoney(totals.income), 'in', cmp.incomeChangePct),
        stat('Gastos', fin.formatMoney(totals.expense), 'out', cmp.expenseChangePct, true),
        stat('Balance', fin.formatMoney(totals.net), totals.net >= 0 ? 'in' : 'out'),
        stat('Promedio diario', fin.formatMoney(fin.dailyAverage(monthTxs, from, minISO(to))), 'neutral'),
      ),

      totals.transfers > 0 && el('p', { class: 'note note--inline' },
        `No se cuentan ${fin.formatMoney(totals.transfers)} en transferencias ` +
        '(pagos de tarjeta y movimientos entre tus cuentas): mueven dinero, no lo gastan.'),

      // ---- por categoría ---------------------------------------------
      el('div', { class: 'grid grid--2' },
        el('section', { class: 'card' },
          el('h3', {}, 'Gasto por categoría'),
          cats.length
            ? el('div', { class: 'donut-wrap' },
                donut(cats, {
                  centerValue: fin.formatMoney(totals.expense),
                  centerLabel: 'gastado',
                }),
                legend(cats, { onSelect: (s) => actions.goToTransactions({ categoryIds: [s.id] }) }),
              )
            : empty('Sin gastos este mes.'),
        ),

        el('section', { class: 'card' },
          el('h3', {}, 'Últimos 6 meses'),
          monthlyBars(months),
          el('div', { class: 'bars__key' },
            el('span', {}, el('i', { class: 'dot dot--in' }), 'Ingresos'),
            el('span', {}, el('i', { class: 'dot dot--out' }), 'Gastos'),
          ),
        ),
      ),

      el('div', { class: 'grid grid--2' },
        el('section', { class: 'card' },
          el('h3', {}, 'Por cuenta'),
          accounts.length
            ? el('table', { class: 'table' },
                el('thead', {}, el('tr', {},
                  el('th', {}, 'Cuenta'), el('th', {}, 'Gastos'),
                  el('th', {}, 'Ingresos'), el('th', {}, 'Movs'))),
                el('tbody', {}, accounts.map((a) => el('tr', {},
                  el('td', {}, a.name),
                  el('td', { class: 'num' }, fin.formatMoney(a.expense)),
                  el('td', { class: 'num' }, fin.formatMoney(a.income)),
                  el('td', { class: 'num' }, String(a.count)),
                ))),
              )
            : empty('Sin movimientos este mes.'),
        ),

        el('section', { class: 'card' },
          el('h3', {}, 'Dónde más gastaste'),
          merchants.length ? rankBars(merchants) : empty('Sin gastos este mes.'),
        ),
      ),
    ),
  );
}

function stat(label, value, tone, changePct = null, invertTone = false) {
  let delta = null;
  if (changePct !== null && changePct !== undefined) {
    const up = changePct > 0;
    // en gastos, subir es malo; en ingresos, subir es bueno
    const good = invertTone ? !up : up;
    delta = el('span', {
      class: `stat__delta ${changePct === 0 ? '' : good ? 'is-good' : 'is-bad'}`,
      title: 'Contra el mes anterior',
    }, `${up ? '▲' : changePct < 0 ? '▼' : '='} ${Math.abs(changePct)}%`);
  }
  return el('div', { class: `stat stat--${tone}` },
    el('span', { class: 'stat__label' }, label),
    el('strong', { class: 'stat__value' }, value),
    delta,
  );
}

const empty = (msg) => el('p', { class: 'muted empty' }, msg);

function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Para el promedio diario: si el mes es el actual, corta en hoy. */
function minISO(to) {
  const today = fin.todayISO();
  return to > today ? today : to;
}
