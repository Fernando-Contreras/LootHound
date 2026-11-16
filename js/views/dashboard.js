// Dashboard: balance del mes, desglose por categoría, tendencia.
// Ningún cálculo se hace aquí: todo sale de finance.js.

import { el, mount, toast, withBusy } from '../dom.js';
import { donut, legend, monthlyBars, rankBars } from '../charts.js';
import * as fin from '../finance.js';
import * as store from '../store.js';
import { reviewItems, confirmIncomePatch, markTransferPatch } from '../review.js';

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

      // ---- ingresos grandes que hay que confirmar ---------------------
      reviewCard(reviewItems({
        transactions: state.transactions, categoryMap: state.categoryMap,
      }).filter((i) => i.tx.occurred_on >= from && i.tx.occurred_on <= to), state, actions),

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

      cashCard(monthTxs, state, actions),

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

/**
 * Ingresos grandes que la app no sabe si son ingreso de verdad o dinero tuyo
 * que sólo cambió de cuenta. Mientras no se confirmen cuentan como ingreso, así
 * que pueden inflar el mes: por eso salen arriba del todo.
 */
function reviewCard(items, state, actions) {
  if (!items.length) return null;
  const total = items.reduce((a, i) => a + Number(i.tx.amount), 0);
  const cuenta = (id) => state.accountMap.get(id)?.name ?? '—';
  const patchCtx = { categoryMap: state.categoryMap, categoryByName: state.categoryByName };

  const fila = ({ tx, reason, pair }) => {
    const guardar = async (btn, hacer, mensaje) => withBusy(btn, async () => {
      try { await hacer(); toast(mensaje, 'ok'); await actions.reload(); }
      catch (err) { toast(store.dbErrorMessage(err), 'error', 8000); }
    });

    const esIngreso = el('button', { class: `btn ${reason === 'pareja' ? 'btn--ghost' : 'btn--primary'} btn--sm`, type: 'button' }, 'Sí, es ingreso');
    esIngreso.addEventListener('click', () => guardar(esIngreso,
      () => store.updateTransaction(tx.id, confirmIncomePatch(tx, patchCtx)), 'Listo, cuenta como ingreso.'));

    const esMio = el('button', { class: `btn ${reason === 'pareja' ? 'btn--primary' : 'btn--ghost'} btn--sm`, type: 'button' }, 'Es mío (traspaso)');
    esMio.addEventListener('click', () => guardar(esMio, async () => {
      await store.updateTransaction(tx.id, markTransferPatch(patchCtx));
      // la otra mitad, si la app la tenía como gasto, también era un traspaso
      if (pair && pair.kind === 'expense') await store.updateTransaction(pair.id, markTransferPatch(patchCtx));
    }, 'Listo, ya no cuenta como ingreso.'));

    return el('li', { class: 'reviewlist__item' },
      el('div', { class: 'reviewlist__main' },
        el('strong', {}, fin.formatMoney(tx.amount)), ' · ', fin.dateLabel(tx.occurred_on), ' · ', cuenta(tx.account_id),
        el('div', { class: 'muted' }, tx.description.slice(0, 90)),
        el('div', { class: 'note' }, reason === 'pareja'
          ? `El ${fin.dateLabel(pair.occurred_on)} salió exactamente esa cantidad de ${cuenta(pair.account_id)}: parece dinero que moviste entre tus cuentas.`
          : 'Entró dinero que no reconozco como sueldo ni rendimientos. ¿Es un ingreso tuyo de verdad?')),
      el('div', { class: 'reviewlist__actions' }, esIngreso, esMio));
  };

  return el('section', { class: 'card card--warn' },
    el('h3', {}, `Por revisar: ${items.length} ${items.length === 1 ? 'ingreso' : 'ingresos'} (${fin.formatMoney(total)})`),
    el('p', { class: 'muted' },
      'Mientras no los confirmes cuentan como ingreso y pueden inflar tu mes. ' +
      'Con un clic queda decidido y no se vuelve a preguntar.'),
    el('ul', { class: 'reviewlist' }, items.slice(0, 8).map(fila)),
    items.length > 8 && el('p', { class: 'note' }, `Y ${items.length - 8} más; aparecen al resolver éstos.`));
}

/**
 * Conciliación de efectivo: lo único que la app no puede saber sola.
 * Los retiros salen de los estados de cuenta; los gastos los capturas tú.
 * La diferencia es lo que deberías traer en la cartera.
 */
function cashCard(monthTxs, state, actions) {
  const cash = [...state.accountMap.values()].find((a) => a.kind === 'cash');
  if (!cash) return null;

  const r = fin.cashReconciliation(monthTxs, cash.id);
  if (!r || (r.withdrawn === 0 && r.spent === 0)) return null;

  return el('section', { class: 'card cashcard' },
    el('div', { class: 'card__head' },
      el('h3', {}, 'Efectivo'),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        onclick: () => actions.goToTransactions({ accountIds: [cash.id] }),
      }, 'Ver movimientos'),
    ),
    el('div', { class: 'cashcard__row' },
      el('div', {}, el('span', { class: 'stat__label' }, 'Retiraste'),
        el('strong', {}, fin.formatMoney(r.withdrawn))),
      el('span', { class: 'cashcard__op' }, '−'),
      el('div', {}, el('span', { class: 'stat__label' }, 'Registraste'),
        el('strong', {}, fin.formatMoney(r.spent))),
      el('span', { class: 'cashcard__op' }, '='),
      el('div', {}, el('span', { class: 'stat__label' }, 'Deberías traer'),
        el('strong', { class: r.expectedOnHand < 0 ? 'is-bad' : '' },
          fin.formatMoney(r.expectedOnHand))),
    ),
    el('p', { class: 'note' },
      r.expectedOnHand < 0
        ? 'Registraste más efectivo del que sacaste. Revisa si algún gasto quedó duplicado.'
        : r.expectedOnHand > 0
          ? `Si traes menos de ${fin.formatMoney(r.expectedOnHand)} en la cartera, te faltó capturar algún gasto.`
          : 'Todo el efectivo que sacaste ya está capturado.'),
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
    }, `${up ? '▲' : changePct < 0 ? '▼' : '='} ${Math.round(Math.abs(changePct))}%`);
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
