// Reglas de categorización + gestión de categorías y cuentas.

import { el, mount, toast, confirmDialog, withBusy } from '../dom.js';
import * as store from '../store.js';
import { previewRule } from '../categorize.js';
import * as fin from '../finance.js';

export function renderRules(root, state, actions) {
  mount(root,
    el('div', { class: 'view' },
      identityCard(state, actions),
      newRuleForm(state, actions),
      rulesTable(state, actions),
      categoriesCard(state, actions),
      accountsCard(state, actions),
      dangerZone(state),
    ),
  );
}

// ---------------------------------------------------------------------------
/**
 * Tus nombres tal como aparecen en los estados de cuenta.
 * Es lo que permite que un SPEI que te mandaste a ti mismo NO cuente como
 * ingreso. Sin esto, cada traspaso entre tus cuentas se contaría dos veces.
 */
function identityCard(state, actions) {
  const names = state.settings?.holder_names ?? [];

  const form = el('form', { class: 'formrow formrow--tight' },
    el('input', {
      name: 'name', placeholder: 'JUAN FERNANDO SALINAS CONTRERAS',
      required: true, maxlength: '80', style: { flex: '2 1 260px' },
    }),
    el('button', { class: 'btn btn--primary', type: 'submit' }, 'Agregar'),
  );

  const save = async (list) => {
    try {
      await store.saveSettings({ holder_names: list });
      await actions.reload();
    } catch (err) { toast(store.dbErrorMessage(err), 'error'); }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = form.name.value.trim();
    if (!value) return;
    if (names.some((n) => n.toLowerCase() === value.toLowerCase())) {
      return toast('Ese nombre ya está en la lista.', 'error');
    }
    await save([...names, value]);
    form.reset();
  });

  return el('section', { class: 'card' },
    el('h3', {}, 'Tus nombres en los estados de cuenta'),
    el('p', { class: 'muted' },
      'Cuando te transfieres dinero entre tus propias cuentas, el banco escribe ' +
      'tu nombre como contraparte. Con esto la app reconoce que no es un ingreso ' +
      'nuevo, sino tu mismo dinero cambiando de lugar.'),

    names.length
      ? el('div', { class: 'chips' }, names.map((n) => el('span', { class: 'chip' },
          n,
          el('button', {
            class: 'iconbtn', title: 'Quitar', type: 'button',
            onclick: () => save(names.filter((x) => x !== n)),
          }, '✕'),
        )))
      : el('p', { class: 'callout callout--warn' },
          'Sin nombres configurados, tus transferencias entre cuentas se van a ' +
          'contar como ingresos y gastos. Agrega tu nombre completo tal como ' +
          'aparece en tus estados de cuenta.'),

    form,
  );
}

// ---------------------------------------------------------------------------
function newRuleForm(state, actions) {
  const form = el('form', { class: 'card' },
    el('h3', {}, 'Nueva regla'),
    el('p', { class: 'muted' },
      'Cuando la descripción de un movimiento contenga la palabra clave, se le ' +
      'pondrá esa categoría automáticamente al importar.'),

    el('div', { class: 'formrow' },
      el('label', {}, 'Si la descripción contiene',
        el('input', { name: 'pattern', required: true, placeholder: 'OXXO', maxlength: '100' })),
      el('label', {}, 'Cómo comparar',
        el('select', { name: 'match_type' },
          el('option', { value: 'contains' }, 'Contiene'),
          el('option', { value: 'starts_with' }, 'Empieza con'),
          el('option', { value: 'regex' }, 'Expresión regular'))),
      el('label', {}, 'Categoría',
        el('select', { name: 'category_id', required: true },
          [...state.categoryMap.values()].map((c) => el('option', { value: c.id }, c.name)))),
      el('label', {}, 'Sólo en la cuenta',
        el('select', { name: 'account_id' },
          el('option', { value: '' }, 'Todas'),
          [...state.accountMap.values()].map((a) => el('option', { value: a.id }, a.name)))),
      el('button', { class: 'btn btn--primary', type: 'submit' }, 'Crear'),
    ),
    el('p', { class: 'note', id: 'rule-preview' }),
  );

  const updatePreview = () => {
    const node = form.querySelector('#rule-preview');
    const pattern = form.pattern.value.trim();
    if (!pattern) return (node.textContent = '');
    const hits = previewRule(
      { pattern, match_type: form.match_type.value },
      state.transactions,
    );
    node.textContent = `Afectaría a ${hits.length} movimiento${hits.length === 1 ? '' : 's'} ` +
      `de los que ya tienes${hits.length ? `: ${hits.slice(0, 3).map((h) => h.description).join(', ')}${hits.length > 3 ? '...' : ''}` : ''}`;
  };
  form.pattern.addEventListener('input', updatePreview);
  form.match_type.addEventListener('change', updatePreview);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    await withBusy(btn, async () => {
      try {
        await store.createRule({
          pattern: form.pattern.value.trim(),
          match_type: form.match_type.value,
          category_id: form.category_id.value,
          account_id: form.account_id.value || null,
          priority: 50,
        });
        toast('Regla creada.', 'ok');
        form.reset();
        await actions.reload();
      } catch (err) {
        toast(err?.code === '23505'
          ? 'Ya existe una regla con esa palabra clave.'
          : store.dbErrorMessage(err), 'error');
      }
    });
  });

  return form;
}

// ---------------------------------------------------------------------------
function rulesTable(state, actions) {
  if (!state.rules.length) {
    return el('section', { class: 'card' }, el('p', { class: 'muted' }, 'Aún no hay reglas.'));
  }

  return el('section', { class: 'card' },
    el('div', { class: 'card__head' },
      el('h3', {}, 'Reglas'),
      el('span', { class: 'muted' }, `${state.rules.length}`),
    ),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Activa'), el('th', {}, 'Palabra clave'), el('th', {}, 'Comparación'),
          el('th', {}, 'Categoría'), el('th', {}, 'Cuenta'), el('th', {}, ''))),
        el('tbody', {}, state.rules.map((r) => el('tr', { class: r.enabled ? '' : 'is-off' },
          el('td', {}, el('input', {
            type: 'checkbox', checked: r.enabled,
            onchange: async (e) => {
              try { await store.updateRule(r.id, { enabled: e.target.checked }); await actions.reload(); }
              catch (err) { toast(store.dbErrorMessage(err), 'error'); }
            },
          })),
          el('td', {}, el('code', {}, r.pattern)),
          el('td', {}, { contains: 'contiene', starts_with: 'empieza con', regex: 'regex' }[r.match_type]),
          el('td', {},
            el('span', {
              class: 'chip',
              style: { borderColor: state.categoryMap.get(r.category_id)?.color },
            }, state.categoryMap.get(r.category_id)?.name || '—')),
          el('td', {}, r.account_id ? state.accountMap.get(r.account_id)?.name : 'Todas'),
          el('td', {}, el('button', {
            class: 'iconbtn', title: 'Eliminar regla',
            onclick: async () => {
              const ok = await confirmDialog('¿Eliminar la regla?',
                `"${r.pattern}" dejará de aplicarse en las próximas importaciones. ` +
                'Los movimientos ya categorizados no cambian.', { danger: true, okLabel: 'Eliminar' });
              if (!ok) return;
              try { await store.deleteRule(r.id); toast('Regla eliminada.', 'ok'); await actions.reload(); }
              catch (err) { toast(store.dbErrorMessage(err), 'error'); }
            },
          }, '✕')),
        ))),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
function categoriesCard(state, actions) {
  const form = el('form', { class: 'formrow formrow--tight' },
    el('input', { name: 'name', placeholder: 'Nueva categoría', required: true, maxlength: '40' }),
    el('select', { name: 'kind' },
      el('option', { value: 'expense' }, 'Gasto'),
      el('option', { value: 'income' }, 'Ingreso'),
      el('option', { value: 'both' }, 'Ambos')),
    el('input', { name: 'color', type: 'color', value: '#7c3aed', 'aria-label': 'Color' }),
    el('button', { class: 'btn btn--primary', type: 'submit' }, 'Agregar'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await store.createCategory({
        name: form.name.value.trim(),
        kind: form.kind.value,
        color: form.color.value,
      });
      toast('Categoría creada.', 'ok');
      form.reset();
      await actions.reload();
    } catch (err) {
      toast(err?.code === '23505' ? 'Ya tienes una categoría con ese nombre.'
        : store.dbErrorMessage(err), 'error');
    }
  });

  return el('section', { class: 'card' },
    el('h3', {}, 'Categorías'),
    el('div', { class: 'chips' },
      [...state.categoryMap.values()].map((c) => el('span', {
        class: 'chip', style: { borderColor: c.color },
      },
        el('i', { class: 'chip__dot', style: { background: c.color } }),
        c.name,
        el('small', { class: 'muted' }, ` ${countIn(state.transactions, c.id)}`),
      ))),
    form,
  );
}

const countIn = (txs, catId) => txs.filter((t) => t.category_id === catId).length;

// ---------------------------------------------------------------------------
function accountsCard(state, actions) {
  const form = el('form', { class: 'formrow formrow--tight' },
    el('input', { name: 'name', placeholder: 'Nueva cuenta', required: true, maxlength: '60' }),
    el('select', { name: 'kind' },
      el('option', { value: 'cash' }, 'Efectivo'),
      el('option', { value: 'debit' }, 'Débito'),
      el('option', { value: 'credit' }, 'Crédito')),
    el('select', { name: 'bank' },
      el('option', { value: '' }, 'Sin banco (no importa PDFs)'),
      el('option', { value: 'bbva' }, 'BBVA'),
      el('option', { value: 'nu' }, 'Nu')),
    el('button', { class: 'btn btn--primary', type: 'submit' }, 'Agregar'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await store.createAccount({
        name: form.name.value.trim(),
        kind: form.kind.value,
        bank: form.bank.value || null,
      });
      toast('Cuenta creada.', 'ok');
      form.reset();
      await actions.reload();
    } catch (err) {
      toast(err?.code === '23505' ? 'Ya tienes una cuenta con ese nombre.'
        : store.dbErrorMessage(err), 'error');
    }
  });

  return el('section', { class: 'card' },
    el('h3', {}, 'Cuentas'),
    el('ul', { class: 'accounts' },
      [...state.accountMap.values()].map((a) => el('li', {},
        el('strong', {}, a.name),
        el('span', { class: 'muted' },
          ` · ${{ cash: 'efectivo', debit: 'débito', credit: 'crédito' }[a.kind]}`),
        a.bank && el('span', { class: 'tag tag--pdf' }, `PDF ${a.bank.toUpperCase()}`),
        el('span', { class: 'muted' },
          ` · ${state.transactions.filter((t) => t.account_id === a.id).length} movs`),
      ))),
    form,
  );
}

// ---------------------------------------------------------------------------
function dangerZone(state) {
  return el('section', { class: 'card' },
    el('h3', {}, 'Tus datos'),
    el('p', { class: 'muted' },
      `${state.transactions.length} movimientos, ${state.rules.length} reglas, ` +
      `${state.categoryMap.size} categorías.`),
    el('button', {
      class: 'btn btn--ghost',
      onclick: () => exportJSON(state),
    }, 'Descargar respaldo (JSON)'),
  );
}

function exportJSON(state) {
  const payload = {
    exported_at: new Date().toISOString(),
    accounts: [...state.accountMap.values()],
    categories: [...state.categoryMap.values()],
    rules: state.rules,
    transactions: state.transactions,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `loothound-${fin.todayISO()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
