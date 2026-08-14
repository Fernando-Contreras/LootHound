// Historial de movimientos + captura manual rápida (efectivo).

import { el, mount, toast, confirmDialog, withBusy } from '../dom.js';
import * as fin from '../finance.js';
import * as store from '../store.js';
import { suggestRule, ruleExists, matchRule, recategorizePlan } from '../categorize.js';
import { fingerprint } from '../dedupe.js';

export function renderTransactions(root, state, actions) {
  const f = state.filters;

  const filtered = fin.filterTransactions(state.transactions, {
    from: f.from || null,
    to: f.to || null,
    accountIds: f.accountIds,
    categoryIds: f.categoryIds,
    kinds: f.kinds,
    search: f.search,
  });
  const totals = fin.summarize(filtered);

  mount(root,
    el('div', { class: 'view' },
      quickAdd(state, actions),

      el('section', { class: 'card' },
        el('div', { class: 'card__head' },
          el('h3', {}, 'Movimientos'),
          el('span', { class: 'muted' },
            `${filtered.length} · ${fin.formatMoney(totals.expense)} en gastos · ` +
            `${fin.formatMoney(totals.income)} en ingresos`),
        ),

        filters(state, actions),

        filtered.length
          ? txTable(filtered, state, actions)
          : el('p', { class: 'muted empty' }, 'Nada que mostrar con estos filtros.'),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Captura rápida — pensada para efectivo: monto, categoría, listo.
// ---------------------------------------------------------------------------
function quickAdd(state, actions) {
  const cashAccount = [...state.accountMap.values()].find((a) => a.kind === 'cash');
  const expenseCats = [...state.categoryMap.values()]
    .filter((c) => c.kind === 'expense' || c.kind === 'both');

  const form = el('form', { class: 'card quickadd' },
    el('h3', {}, 'Registro rápido'),
    el('div', { class: 'quickadd__row' },
      el('label', { class: 'quickadd__amount' }, 'Monto',
        el('input', {
          name: 'amount', type: 'number', step: '0.01', min: '0.01',
          required: true, placeholder: '0.00', inputmode: 'decimal', autofocus: true,
        })),

      el('label', {}, 'Categoría',
        el('select', { name: 'category_id', required: true },
          expenseCats.map((c) => el('option', { value: c.id }, c.name)))),

      el('label', {}, 'Cuenta',
        el('select', { name: 'account_id', required: true },
          [...state.accountMap.values()].map((a) => el('option', {
            value: a.id, selected: cashAccount && a.id === cashAccount.id,
          }, a.name)))),

      el('label', {}, 'Fecha',
        el('input', { name: 'occurred_on', type: 'date', required: true, value: fin.todayISO() })),

      el('label', {}, 'Tipo',
        el('select', { name: 'kind' },
          el('option', { value: 'expense' }, 'Gasto'),
          el('option', { value: 'income' }, 'Ingreso'),
          el('option', { value: 'transfer' }, 'Transferencia'))),

      el('label', { class: 'quickadd__note' }, 'Nota (opcional)',
        el('input', { name: 'description', type: 'text', placeholder: 'Ej. taco de la esquina', maxlength: '200' })),

      el('button', { class: 'btn btn--primary', type: 'submit' }, 'Agregar'),
    ),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const amount = Number(form.amount.value);
    if (!(amount > 0)) return toast('El monto debe ser mayor a cero.', 'error');

    const catName = state.categoryMap.get(form.category_id.value)?.name || 'Movimiento';
    const description = form.description.value.trim() || catName;

    const tx = {
      account_id: form.account_id.value,
      category_id: form.category_id.value,
      occurred_on: form.occurred_on.value,
      description,
      amount,
      kind: form.kind.value,
      source: 'manual',
      categorized_by: 'user',
    };
    // el índice de repetición se calcula contra lo que ya existe ese día
    const twins = state.transactions.filter((t) =>
      t.account_id === tx.account_id && t.occurred_on === tx.occurred_on &&
      Number(t.amount) === amount && t.kind === tx.kind &&
      t.description.toUpperCase() === description.toUpperCase()).length;
    tx.fingerprint = fingerprint(tx, twins);

    await withBusy(btn, async () => {
      try {
        await store.createTransaction(tx);
        toast('Movimiento agregado.', 'ok');
        form.amount.value = '';
        form.description.value = '';
        form.amount.focus();
        await actions.reload();
      } catch (err) {
        toast(store.dbErrorMessage(err), 'error', 6000);
      }
    });
  });

  return form;
}

// ---------------------------------------------------------------------------
function filters(state, actions) {
  const f = state.filters;
  const set = (patch) => actions.setFilters({ ...f, ...patch });

  return el('div', { class: 'filters' },
    el('input', {
      type: 'search', placeholder: 'Buscar descripción...', value: f.search || '',
      oninput: debounce((e) => set({ search: e.target.value }), 250),
    }),
    el('input', {
      type: 'date', value: f.from || '', 'aria-label': 'Desde',
      onchange: (e) => set({ from: e.target.value }),
    }),
    el('input', {
      type: 'date', value: f.to || '', 'aria-label': 'Hasta',
      onchange: (e) => set({ to: e.target.value }),
    }),
    el('select', {
      'aria-label': 'Cuenta',
      onchange: (e) => set({ accountIds: e.target.value ? [e.target.value] : [] }),
    },
      el('option', { value: '' }, 'Todas las cuentas'),
      [...state.accountMap.values()].map((a) => el('option', {
        value: a.id, selected: f.accountIds?.[0] === a.id,
      }, a.name))),
    el('select', {
      'aria-label': 'Categoría',
      onchange: (e) => set({ categoryIds: e.target.value ? [e.target.value] : [] }),
    },
      el('option', { value: '' }, 'Todas las categorías'),
      [...state.categoryMap.values()].map((c) => el('option', {
        value: c.id, selected: f.categoryIds?.[0] === c.id,
      }, c.name))),
    el('select', {
      'aria-label': 'Tipo',
      onchange: (e) => set({ kinds: e.target.value ? [e.target.value] : [] }),
    },
      el('option', { value: '' }, 'Todo'),
      el('option', { value: 'expense', selected: f.kinds?.[0] === 'expense' }, 'Gastos'),
      el('option', { value: 'income', selected: f.kinds?.[0] === 'income' }, 'Ingresos'),
      el('option', { value: 'transfer', selected: f.kinds?.[0] === 'transfer' }, 'Transferencias')),
    el('button', { class: 'btn btn--ghost', onclick: () => actions.setFilters({}) }, 'Limpiar'),
  );
}

// ---------------------------------------------------------------------------
function txTable(txs, state, actions) {
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'table table--tx' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Fecha'),
        el('th', {}, 'Descripción'),
        el('th', {}, 'Categoría'),
        el('th', {}, 'Cuenta'),
        el('th', { class: 'num' }, 'Monto'),
        el('th', { 'aria-label': 'Acciones' }),
      )),
      el('tbody', {}, txs.slice(0, 500).map((tx) => txRow(tx, state, actions))),
    ),
    txs.length > 500 && el('p', { class: 'muted' },
      `Mostrando 500 de ${txs.length}. Acota el rango de fechas para ver el resto.`),
  );
}

function txRow(tx, state, actions) {
  const cat = state.categoryMap.get(tx.category_id);
  const expenseCats = [...state.categoryMap.values()]
    .filter((c) => c.kind === (tx.kind === 'income' ? 'income' : 'expense') || c.kind === 'both');

  return el('tr', { class: `txrow txrow--${tx.kind}` },
    el('td', { class: 'txrow__date' }, fin.dateLabel(tx.occurred_on)),
    el('td', {},
      el('span', { class: 'txrow__desc', title: tx.description }, tx.description),
      tx.original_currency && el('small', { class: 'txrow__fx' },
        ` ${tx.original_currency} ${tx.original_amount} @ ${tx.fx_rate}`),
      tx.source === 'pdf_import' && el('span', { class: 'tag tag--pdf', title: 'Importado de un PDF' }, 'PDF'),
      tx.note && el('small', { class: 'txrow__note' }, tx.note),
    ),
    el('td', {},
      el('select', {
        class: 'select-inline',
        style: { borderColor: cat?.color || 'var(--line)' },
        onchange: (e) => changeCategory(tx, e.target.value, state, actions),
      },
        el('option', { value: '' }, '— sin categoría —'),
        expenseCats.map((c) => el('option', {
          value: c.id, selected: c.id === tx.category_id,
        }, c.name))),
      tx.categorized_by === 'rule' && el('span', { class: 'tag tag--rule', title: 'La puso una regla' }, 'auto'),
    ),
    el('td', {}, state.accountMap.get(tx.account_id)?.name || '—'),
    el('td', { class: `num amount amount--${tx.kind}` }, fin.formatSigned(tx)),
    el('td', {},
      el('button', {
        class: 'iconbtn', title: 'Eliminar', 'aria-label': 'Eliminar movimiento',
        onclick: async () => {
          const ok = await confirmDialog('¿Eliminar movimiento?',
            `${tx.description} — ${fin.formatMoney(tx.amount)}`, { danger: true, okLabel: 'Eliminar' });
          if (!ok) return;
          try {
            await store.deleteTransaction(tx.id);
            toast('Movimiento eliminado.', 'ok');
            await actions.reload();
          } catch (err) { toast(store.dbErrorMessage(err), 'error'); }
        },
      }, '✕'),
    ),
  );
}

/**
 * Al corregir una categoría a mano, se ofrece convertir la corrección en regla
 * para que la próxima importación ya salga bien.
 */
async function changeCategory(tx, categoryId, state, actions) {
  try {
    await store.updateTransaction(tx.id, {
      category_id: categoryId || null,
      categorized_by: categoryId ? 'user' : 'none',
    });
    await actions.reload();
  } catch (err) {
    return toast(store.dbErrorMessage(err), 'error');
  }
  if (!categoryId) return;

  const suggestion = suggestRule(tx.description);
  if (!suggestion || ruleExists(state.rules, suggestion.pattern, suggestion.match_type)) return;

  // ¿la regla actual ya mandaría a esa categoría? entonces no hay nada que aprender
  const already = matchRule(tx, state.rules);
  if (already?.category_id === categoryId) return;

  const catName = state.categoryMap.get(categoryId)?.name || '';
  const ok = await confirmDialog(
    '¿Crear una regla?',
    `De ahora en adelante, todo lo que contenga "${suggestion.pattern}" se ` +
    `categorizará como ${catName}.`,
    { okLabel: 'Crear regla' },
  );
  if (!ok) return;

  try {
    const nueva = await store.createRule({
      pattern: suggestion.pattern,
      match_type: suggestion.match_type,
      category_id: categoryId,
      priority: 50, // las que hace el usuario ganan sobre las de fábrica
    });

    // Aplicar la regla también hacia atrás: si acabas de decir que "Ganancia"
    // es Rendimientos, las 30 Ganancias que ya tenías deben acomodarse solas.
    const cambios = recategorizePlan(state.transactions, [nueva, ...state.rules]);
    const n = cambios.length ? await store.recategorize(cambios) : 0;

    toast(n
      ? `Regla creada y aplicada a ${n} movimiento${n === 1 ? '' : 's'} más.`
      : `Regla creada: "${suggestion.pattern}" → ${catName}`, 'ok', 5000);
    await actions.reload();
  } catch (err) {
    toast(store.dbErrorMessage(err), 'error');
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
