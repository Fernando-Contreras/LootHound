// ===========================================================================
// Importar estado de cuenta en PDF.
//
// Flujo:  archivo → pdf.js (en el navegador) → parser del banco →
//         reglas de categoría → detección de duplicados → PREVIEW → confirmar
//
// El PDF nunca se sube a ningún lado. Se lee con arrayBuffer() y se procesa
// en memoria; pdf.js está servido desde /vendor, así que ni siquiera se pide
// la librería a un CDN. Se puede verificar en la pestaña Network.
// ===========================================================================

import { el, mount, toast, confirmDialog, withBusy, clear } from '../dom.js';
import { parseStatement, PARSERS } from '../parsers/index.js';
import { REASON_LABELS } from '../parsers/identity.js';
import { applyRules } from '../categorize.js';
import { assignFingerprints, flagSimilar, dedupeSummary } from '../dedupe.js';
import * as fin from '../finance.js';
import * as store from '../store.js';

let pending = null; // { bank, transactions, period, statement, check, file }

/** La columna `description` de la base acepta 200 caracteres. */
const MAX_DESC = 200;

export function clampDescription(text) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return 'Movimiento';           // la base tampoco acepta vacío
  return s.length <= MAX_DESC ? s : `${s.slice(0, MAX_DESC - 1).trim()}…`;
}

export function renderImport(root, state, actions) {
  mount(root,
    el('div', { class: 'view' },
      el('section', { class: 'card' },
        el('h3', {}, 'Importar estado de cuenta'),
        el('p', { class: 'muted' },
          'Sube el PDF que descargas de tu banco. Se procesa completo en tu ' +
          'navegador: el archivo no se manda a ningún servidor.'),

        dropzone(state, actions),

        el('details', { class: 'help' },
          el('summary', {}, '¿Qué bancos entiende?'),
          el('ul', {}, PARSERS.map((p) => el('li', {}, p.BANK_LABEL))),
          el('p', { class: 'muted' },
            'Tiene que ser el PDF original del banco. Si es una foto o un ' +
            'escaneo, no hay texto que extraer y el parser no puede leerlo.'),
        ),
      ),

      el('div', { id: 'preview-host' }),
      importHistory(state, actions),
    ),
  );

  if (pending) renderPreview(document.getElementById('preview-host'), state, actions);
}

// ---------------------------------------------------------------------------
function dropzone(state, actions) {
  const input = el('input', {
    type: 'file', accept: 'application/pdf,.pdf', id: 'pdf-input', class: 'visually-hidden',
    onchange: (e) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file, state, actions);
      e.target.value = '';
    },
  });

  const zone = el('label', {
    class: 'dropzone', for: 'pdf-input',
    ondragover: (e) => { e.preventDefault(); zone.classList.add('is-over'); },
    ondragleave: () => zone.classList.remove('is-over'),
    ondrop: (e) => {
      e.preventDefault();
      zone.classList.remove('is-over');
      const file = [...e.dataTransfer.files].find((f) => /\.pdf$/i.test(f.name));
      if (file) handleFile(file, state, actions);
      else toast('Arrastra un archivo PDF.', 'error');
    },
  },
    el('span', { class: 'dropzone__icon' }, '📄'),
    el('strong', {}, 'Arrastra tu PDF aquí'),
    el('span', { class: 'muted' }, 'o haz clic para escoger el archivo'),
    el('span', { class: 'dropzone__badge' }, '🔒 Se procesa en tu dispositivo'),
  );

  return el('div', {}, input, zone);
}

// ---------------------------------------------------------------------------
async function handleFile(file, state, actions) {
  const host = document.getElementById('preview-host');
  mount(host, el('div', { class: 'card' }, el('p', { class: 'muted' }, `Leyendo ${file.name}...`)));

  try {
    const buffer = await file.arrayBuffer();
    const result = await parseStatement(buffer, null, {
      // Tu nombre es lo que permite distinguir "me transferí dinero" de
      // "me pagaron". Sin esto, cada SPEI que te mandas cuenta como ingreso.
      holderNames: state.settings?.holder_names ?? [],
    });

    // La cuenta destino: la que coincida con el banco detectado.
    const account = [...state.accountMap.values()].find((a) => a.bank === result.bank);
    if (!account) {
      throw new Error(
        `Detecté un estado de cuenta de ${result.bank} pero no tienes una ` +
        'cuenta con ese banco. Créala primero en Reglas → Cuentas.');
    }

    // Enlaza automáticamente el otro lado de las transferencias internas:
    // un retiro alimenta la cuenta Efectivo, un pago de tarjeta va a la tarjeta.
    const cashAccount = [...state.accountMap.values()].find((a) => a.kind === 'cash');
    const cardAccount = [...state.accountMap.values()].find((a) => a.kind === 'credit');

    for (const tx of result.transactions) {
      tx.account_id = account.id;
      if (tx.transfer_reason === 'retiro-efectivo' && cashAccount) {
        tx.counter_account_id = cashAccount.id;
      } else if (tx.transfer_reason === 'pago-tarjeta' && cardAccount &&
                 cardAccount.id !== account.id) {
        tx.counter_account_id = cardAccount.id;
      }
    }

    applyRules(result.transactions, state.rules, {
      fallbackCategoryId: state.categoryByName.get('Sin categoría')?.id ?? null,
    });

    // Las transferencias se categorizan por el MOTIVO que detectó el parser,
    // no por palabra clave. Cada banco las escribe distinto ("PAGO TARJETA DE
    // CREDITO", "BMOVIL.PAGO TDC", "RETIRO SIN TARJETA"...), pero el motivo ya
    // viene normalizado, así que no hay que mantener una regla por variante.
    const catFor = (name) => state.categoryByName.get(name)?.id ?? null;
    const CATEGORIA_POR_MOTIVO = {
      'retiro-efectivo': catFor('Retiro de efectivo'),
      'pago-tarjeta': catFor('Transferencia'),
      'mismo-titular': catFor('Transferencia'),
      'cuenta-propia': catFor('Transferencia'),
      'deposito-propio': catFor('Transferencia'),
      'cajita': catFor('Transferencia'),
      'devolucion': catFor('Otros ingresos'),
    };
    for (const tx of result.transactions) {
      const auto = CATEGORIA_POR_MOTIVO[tx.transfer_reason];
      if (auto) {
        tx.category_id = auto;
        tx.categorized_by = 'rule';
      }
    }

    // Duplicados: exactos (huella) y parecidos (fuzzy)
    const existing = await store.fetchFingerprintIndex();
    assignFingerprints(result.transactions, existing);
    flagSimilar(result.transactions, existing);

    // Lo que ya está o se parece llega desmarcado; lo nuevo, marcado.
    for (const tx of result.transactions) {
      tx.selected = !tx.duplicateReason && !tx.optional;
    }

    pending = { ...result, file, account };
    renderPreview(host, state, actions);
  } catch (err) {
    console.error(err);
    mount(host, el('div', { class: 'card card--error' },
      el('h3', {}, 'No se pudo leer el PDF'),
      el('p', {}, String(err.message || err)),
    ));
  }
}

// ---------------------------------------------------------------------------
function renderPreview(host, state, actions) {
  const p = pending;
  if (!p) return clear(host);

  const selected = p.transactions.filter((t) => t.selected);
  const dup = dedupeSummary(p.transactions);
  const totals = fin.summarize(selected);

  mount(host,
    el('section', { class: 'card preview' },
      el('div', { class: 'card__head' },
        el('h3', {}, `Preview — ${p.account.name}`),
        el('button', {
          class: 'iconbtn', title: 'Cancelar', 'aria-label': 'Cancelar importación',
          onclick: () => { pending = null; clear(host); },
        }, '✕'),
      ),

      el('p', { class: 'muted' },
        `${p.file.name} · ${p.transactions.length} movimientos leídos` +
        (p.period ? ` · periodo ${fin.dateLabel(p.period.start)} → ${fin.dateLabel(p.period.end)}` : '')),

      checkPanel(p.check),

      p.warnings.length > 0 && el('div', { class: 'callout callout--warn' },
        el('strong', {}, 'Revisa esto:'),
        el('ul', {}, p.warnings.map((w) => el('li', {}, w))),
      ),

      (dup.exact > 0 || dup.similar > 0) && el('div', { class: 'callout callout--info' },
        dup.exact > 0 && el('p', {},
          el('strong', {}, `${dup.exact} ya estaban registrados`),
          ' — vienen desmarcados. Si los marcas, la base los rechazará de todas formas.'),
        dup.similar > 0 && el('p', {},
          el('strong', {}, `${dup.similar} se parecen a algo que ya tienes`),
          ' — mismo monto y fecha cercana. Revísalos antes de marcarlos.'),
      ),

      el('div', { class: 'preview__bar' },
        el('label', {},
          el('input', {
            type: 'checkbox',
            checked: selected.length === p.transactions.length,
            onchange: (e) => {
              for (const t of p.transactions) t.selected = e.target.checked;
              renderPreview(host, state, actions);
            },
          }), ' Marcar todo'),
        el('button', {
          class: 'btn btn--ghost',
          onclick: () => {
            for (const t of p.transactions) t.selected = !t.duplicateReason && !t.optional;
            renderPreview(host, state, actions);
          },
        }, 'Sólo lo nuevo'),
        el('span', { class: 'preview__totals' },
          `${selected.length} seleccionados · ${fin.formatMoney(totals.expense)} en gastos · ` +
          `${fin.formatMoney(totals.income)} en ingresos`),
      ),

      previewTable(p, state, () => renderPreview(host, state, actions)),

      el('div', { class: 'preview__actions' },
        el('button', {
          class: 'btn btn--ghost',
          onclick: () => { pending = null; clear(host); },
        }, 'Cancelar'),
        el('button', {
          class: 'btn btn--primary',
          disabled: selected.length === 0,
          onclick: (e) => doImport(e.target, host, state, actions),
        }, `Importar ${selected.length} movimiento${selected.length === 1 ? '' : 's'}`),
      ),
    ),
  );
}

/** Compara lo que sumó el parser contra los totales impresos en el PDF. */
function checkPanel(check) {
  if (!check?.rows) return null;
  const rows = [...check.rows];
  if (check.balance) rows.push(check.balance);

  return el('div', { class: `callout ${check.ok ? 'callout--ok' : 'callout--warn'}` },
    el('strong', {}, check.ok
      ? '✓ Los totales cuadran con los que declara el PDF'
      : '⚠ Los totales NO cuadran con el PDF'),
    el('table', { class: 'table table--mini' },
      el('thead', {}, el('tr', {},
        el('th', {}, ''), el('th', { class: 'num' }, 'Según el PDF'),
        el('th', { class: 'num' }, 'Según el parser'))),
      el('tbody', {}, rows.map((r) => el('tr', {},
        el('td', {}, r.label),
        el('td', { class: 'num' }, r.declared === null ? '—' : fin.formatMoney(r.declared)),
        el('td', { class: `num ${r.ok === false ? 'is-bad' : ''}` }, fin.formatMoney(r.computed)),
      ))),
    ),
  );
}

function previewTable(p, state, rerender) {
  const cats = [...state.categoryMap.values()];

  return el('div', { class: 'table-wrap table-wrap--tall' },
    el('table', { class: 'table table--tx' },
      el('thead', {}, el('tr', {},
        el('th', {}, ''), el('th', {}, 'Fecha'), el('th', {}, 'Descripción'),
        el('th', {}, 'Categoría'), el('th', {}, 'Tipo'), el('th', { class: 'num' }, 'Monto'))),
      el('tbody', {}, p.transactions.map((tx) => el('tr', {
        class: [
          tx.duplicateReason === 'exacto' ? 'is-dup' : '',
          tx.duplicateReason === 'parecido' ? 'is-similar' : '',
          tx.optional ? 'is-optional' : '',
        ].filter(Boolean).join(' '),
      },
        el('td', {}, el('input', {
          type: 'checkbox', checked: tx.selected,
          onchange: (e) => { tx.selected = e.target.checked; rerender(); },
        })),
        el('td', {}, fin.dateLabel(tx.occurred_on)),
        el('td', {},
          el('span', { title: tx.raw_line }, tx.description),
          tx.original_currency && el('small', { class: 'txrow__fx' },
            ` ${tx.original_currency} ${tx.original_amount} @ ${tx.fx_rate}`),
          tx.duplicateReason === 'exacto' && el('span', { class: 'tag tag--dup' }, 'ya registrado'),
          tx.duplicateReason === 'parecido' && el('span', {
            class: 'tag tag--similar',
            title: `Se parece a "${tx.similarTo.description}" del ${tx.similarTo.occurred_on} (${tx.similarTo.score}%)`,
          }, `parecido ${tx.similarTo.score}%`),
          tx.optional && el('span', { class: 'tag tag--optional', title: 'No viene como movimiento; afecta el saldo' }, 'opcional'),
          tx.transfer_reason && REASON_LABELS[tx.transfer_reason] && el('span', {
            class: 'tag tag--transfer',
            title: 'No cuenta como gasto ni como ingreso',
          }, REASON_LABELS[tx.transfer_reason]),
          tx.needs_review && el('span', {
            class: 'tag tag--similar', title: 'No lo reconocí con seguridad',
          }, 'revisar'),
        ),
        el('td', {}, el('select', {
          class: 'select-inline',
          onchange: (e) => { tx.category_id = e.target.value || null; tx.categorized_by = 'user'; },
        },
          el('option', { value: '' }, '—'),
          cats.map((c) => el('option', { value: c.id, selected: c.id === tx.category_id }, c.name)))),
        el('td', {}, el('select', {
          class: 'select-inline',
          onchange: (e) => { tx.kind = e.target.value; rerender(); },
        },
          ['expense', 'income', 'transfer'].map((k) => el('option', {
            value: k, selected: k === tx.kind,
          }, { expense: 'Gasto', income: 'Ingreso', transfer: 'Transfer' }[k])))),
        el('td', { class: `num amount amount--${tx.kind}` }, fin.formatMoney(tx.amount)),
      ))),
    ),
  );
}

// ---------------------------------------------------------------------------
async function doImport(button, host, state, actions) {
  const p = pending;
  const rows = p.transactions.filter((t) => t.selected);
  if (!rows.length) return;

  await withBusy(button, async () => {
    let importRecord = null;
    try {
      importRecord = await store.createImport({
        account_id: p.account.id,
        bank: p.bank,
        file_name: p.file.name,
        period_start: p.period?.start ?? null,
        period_end: p.period?.end ?? null,
        statement_total_expense: p.statement?.expense ?? null,
        statement_total_income: p.statement?.income ?? null,
        parsed_count: p.transactions.length,
      });

      // Si el usuario cambió `kind` en el preview, la huella cambia: se recalcula.
      assignFingerprints(rows, []);

      const payload = rows.map((t) => ({
        account_id: p.account.id,
        counter_account_id: t.counter_account_id || null,
        transfer_reason: t.transfer_reason || null,
        category_id: t.category_id || null,
        import_id: importRecord.id,
        occurred_on: t.occurred_on,
        posted_on: t.posted_on || null,
        // Último filtro antes de la base: si un parser se pasa de largo,
        // preferimos recortar a que la base rechace TODA la importación con
        // un error que no dice qué renglón la causó.
        description: clampDescription(t.description),
        amount: t.amount,
        kind: t.kind,
        source: 'pdf_import',
        categorized_by: t.categorized_by || 'none',
        original_currency: t.original_currency || null,
        original_amount: t.original_amount ?? null,
        fx_rate: t.fx_rate ?? null,
        raw_line: t.raw_line || null,
        fingerprint: t.fingerprint,
      }));

      const { inserted, skipped } = await store.insertTransactions(payload);
      await store.updateImport(importRecord.id, { imported_count: inserted });

      pending = null;
      clear(host);
      toast(
        skipped.length
          ? `Importados ${inserted}. ${skipped.length} se omitieron por duplicado.`
          : `Importados ${inserted} movimientos.`,
        'ok', 6000,
      );
      await actions.reload();
    } catch (err) {
      console.error(err);
      // si algo falló a media importación, no dejamos el registro huérfano
      if (importRecord) { try { await store.undoImport(importRecord.id); } catch { /* ya no existe */ } }
      toast(store.dbErrorMessage(err), 'error', 8000);
    }
  });
}

// ---------------------------------------------------------------------------
function importHistory(state, actions) {
  if (!state.imports?.length) return null;

  return el('section', { class: 'card' },
    el('h3', {}, 'Importaciones anteriores'),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Archivo'), el('th', {}, 'Banco'), el('th', {}, 'Periodo'),
          el('th', { class: 'num' }, 'Movs'), el('th', {}, ''))),
        el('tbody', {}, state.imports.map((imp) => el('tr', {},
          el('td', {}, imp.file_name || '—'),
          el('td', {}, imp.bank.toUpperCase()),
          el('td', {}, imp.period_start
            ? `${fin.dateLabel(imp.period_start)} → ${fin.dateLabel(imp.period_end)}` : '—'),
          el('td', { class: 'num' }, String(imp.imported_count)),
          el('td', {}, el('button', {
            class: 'btn btn--ghost btn--sm',
            onclick: async () => {
              const ok = await confirmDialog('¿Deshacer esta importación?',
                `Se eliminarán los ${imp.imported_count} movimientos que entraron con ` +
                `${imp.file_name}. Lo que capturaste a mano no se toca.`,
                { danger: true, okLabel: 'Deshacer' });
              if (!ok) return;
              try {
                await store.undoImport(imp.id);
                toast('Importación deshecha.', 'ok');
                await actions.reload();
              } catch (err) { toast(store.dbErrorMessage(err), 'error'); }
            },
          }, 'Deshacer')),
        ))),
      ),
    ),
  );
}
