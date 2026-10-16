// Historial de movimientos + captura manual rápida (efectivo).

import { el, mount, toast, confirmDialog, withBusy } from '../dom.js';
import * as fin from '../finance.js';
import * as store from '../store.js';
import { suggestRule, ruleExists, matchRule, recategorizePlan } from '../categorize.js';
import {
  validateTransaction, categoriesFor, changedFields, newManualFingerprint,
  KINDS, KIND_LABELS,
} from '../txedit.js';

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
  const expenseCats = categoriesFor('expense', state.categoryMap);

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
          KINDS.map((k) => el('option', { value: k }, KIND_LABELS[k])))),

      el('label', { class: 'quickadd__note' }, 'Nombre (opcional)',
        el('input', { name: 'description', type: 'text', placeholder: 'Ej. taco de la esquina', maxlength: '200' })),

      el('button', { class: 'btn btn--primary', type: 'submit' }, 'Agregar'),
    ),
  );

  // Las categorías dependen del tipo: antes siempre salían las de gasto, así que
  // era imposible registrar un ingreso en "Sueldo" desde aquí.
  form.kind.addEventListener('change', () => {
    const cats = categoriesFor(form.kind.value, state.categoryMap);
    const prev = form.category_id.value;
    form.category_id.replaceChildren(...cats.map((c) => el('option', {
      value: c.id, selected: c.id === prev,
    }, c.name)));
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const catName = state.categoryMap.get(form.category_id.value)?.name || 'Movimiento';

    // La misma validación que el editor: una sola fuente de reglas.
    const res = validateTransaction({
      occurred_on: form.occurred_on.value,
      description: form.description.value.trim() || catName,
      amount: form.amount.value,
      kind: form.kind.value,
      account_id: form.account_id.value,
      category_id: form.category_id.value,
    }, { accountMap: state.accountMap, categoryMap: state.categoryMap });
    if (!res.ok) return toast(Object.values(res.errors)[0], 'error', 6000);

    // Huella aleatoria: lo capturado a mano puede repetirse (dos cafés iguales
    // el mismo día son dos gastos). Antes se calculaba por contenido y chocaba
    // con la huella de un movimiento que ya se había editado o repetido.
    const { transfer_reason, ...resto } = res.patch;
    const tx = { ...resto, source: 'manual', fingerprint: newManualFingerprint() };

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
  const expenseCats = categoriesFor(tx.kind, state.categoryMap);
  // Si la categoría actual no encaja con el tipo (p. ej. una regla vieja), se
  // sigue mostrando: esconderla haría parecer que el movimiento no tiene.
  if (cat && !expenseCats.some((c) => c.id === cat.id)) expenseCats.push(cat);

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
    el('td', { class: 'txrow__actions' },
      el('button', {
        class: 'iconbtn iconbtn--edit', title: 'Editar', 'aria-label': 'Editar movimiento',
        onclick: () => editDialog(tx, state, actions),
      }, '✎'),
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

  // Lo capturado a mano lleva un nombre libre ("Comida", "taco de la esquina"):
  // convertirlo en regla ensuciaría la lista con palabras que no son comercios.
  if (tx.source === 'manual') return;

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

// ---------------------------------------------------------------------------
// Editar un movimiento (fecha, nombre, monto, tipo, categoría, cuenta, nota).
// ---------------------------------------------------------------------------
function editDialog(tx, state, actions) {
  const accounts = [...state.accountMap.values()];
  const campo = (name, label, control, extra = null) => el('label', { class: 'editform__field' },
    el('span', {}, label), control, extra,
    el('small', { class: 'field-error', dataset: { error: name }, hidden: true }));

  const catSelect = el('select', { name: 'category_id' });
  const fillCategories = (kind, selected) => {
    const cats = categoriesFor(kind, state.categoryMap);
    catSelect.replaceChildren(
      el('option', { value: '' }, '— sin categoría —'),
      ...cats.map((c) => el('option', { value: c.id, selected: c.id === selected }, c.name)),
    );
  };

  const counterSelect = el('select', { name: 'counter_account_id' },
    el('option', { value: '' }, '— ninguna —'),
    accounts.map((a) => el('option', {
      value: a.id, selected: a.id === tx.counter_account_id,
    }, a.name)));
  const counterField = campo('counter_account_id', 'A qué cuenta fue (si es traspaso)', counterSelect);

  const kindSelect = el('select', { name: 'kind' },
    KINDS.map((k) => el('option', { value: k, selected: k === tx.kind }, KIND_LABELS[k])));

  const form = el('form', { class: 'editform', novalidate: true },
    el('h3', {}, 'Editar movimiento'),
    el('div', { class: 'editform__grid' },
      campo('occurred_on', 'Fecha',
        el('input', { name: 'occurred_on', type: 'date', value: tx.occurred_on, required: true })),
      campo('amount', 'Monto',
        el('input', {
          name: 'amount', type: 'number', step: '0.01', min: '0.01',
          value: String(tx.amount), inputmode: 'decimal', required: true,
        })),
      campo('description', 'Nombre',
        el('input', { name: 'description', type: 'text', value: tx.description, maxlength: '200', required: true })),
      campo('kind', 'Tipo', kindSelect),
      campo('category_id', 'Categoría', catSelect),
      campo('account_id', 'Cuenta',
        el('select', { name: 'account_id' },
          accounts.map((a) => el('option', { value: a.id, selected: a.id === tx.account_id }, a.name)))),
      counterField,
      campo('note', 'Nota (opcional)',
        el('textarea', { name: 'note', rows: '2', maxlength: '500' }, tx.note || '')),
    ),

    tx.source === 'pdf_import' && el('p', { class: 'note' },
      'Este movimiento vino de un PDF. Puedes corregirlo; seguirá reconociéndose ' +
      'como "ya registrado" si vuelves a subir ese estado de cuenta.'),
    tx.original_currency && el('p', { class: 'note' },
      `Cargo original: ${tx.original_currency} ${tx.original_amount} a ${tx.fx_rate}. ` +
      'El monto de arriba es en pesos.'),

    el('div', { class: 'modal__actions' },
      el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => dlg.close() }, 'Cancelar'),
      el('button', { class: 'btn btn--primary', type: 'submit' }, 'Guardar cambios'),
    ),
  );

  const dlg = el('dialog', { class: 'modal modal--wide' }, form);
  dlg.addEventListener('close', () => dlg.remove(), { once: true });

  const syncKind = () => {
    fillCategories(kindSelect.value, catSelect.value || tx.category_id);
    counterField.hidden = kindSelect.value !== 'transfer';
  };
  fillCategories(tx.kind, tx.category_id);
  counterField.hidden = tx.kind !== 'transfer';
  // Al cambiar el tipo, la categoría se queda sólo si todavía le sirve.
  kindSelect.addEventListener('change', () => { catSelect.value = ''; syncKind(); });

  const showErrors = (errors) => {
    for (const small of form.querySelectorAll('.field-error')) {
      const msg = errors[small.dataset.error];
      small.textContent = msg || '';
      small.hidden = !msg;
    }
    const first = Object.keys(errors)[0];
    if (first) form.elements[first]?.focus();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const values = Object.fromEntries(new FormData(form).entries());

    const res = validateTransaction(values, {
      accountMap: state.accountMap, categoryMap: state.categoryMap, previous: tx,
    });
    showErrors(res.errors);
    if (!res.ok) return;

    const { fingerprint: huella, ...nucleo } = res.patch;
    const diff = changedFields(tx, nucleo);
    if (!Object.keys(diff).length) {
      toast('No cambiaste nada.', 'ok');
      dlg.close();
      return;
    }
    if (huella) diff.fingerprint = huella;

    await withBusy(btn, async () => {
      try {
        await store.updateTransaction(tx.id, diff);
        toast('Movimiento actualizado.', 'ok');
        dlg.close();
        await actions.reload();
      } catch (err) {
        toast(store.dbErrorMessage(err), 'error', 8000);
      }
    });
  });

  document.body.append(dlg);
  dlg.showModal();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
