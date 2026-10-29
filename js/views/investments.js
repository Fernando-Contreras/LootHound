// ===========================================================================
// Inversiones — reemplaza la parte azul de la hoja de Excel.
//
//   "Mensual"          → columna "Este mes"
//   "Inversión actual" → columna "Valor actual"
//   "Le metí"          → columna "Le metí"
// y además: ganancia, % de rendimiento, rendimiento anual, peso de cada
// plataforma, avance contra tu meta mensual, historial y observaciones.
//
// Ningún número se calcula aquí: todo sale de finance.js.
// ===========================================================================

import { el, mount, toast, confirmDialog, withBusy, formDialog } from '../dom.js';
import * as fin from '../finance.js';
import * as store from '../store.js';
import { donut, legend, lineChart } from '../charts.js';
import {
  TYPES, TYPE_HELP, FLOW_KINDS, SUGGESTED_PLATFORMS,
  validateAccount, validateFlow, validateValue, validateGoal, planOnboarding,
  pendingInvestmentTransfers,
} from '../invedit.js';

const money = fin.formatMoney;
const PALETTE = ['#9b7dff', '#34d399', '#60a5fa', '#f59e0b', '#f472b6', '#2dd4bf', '#fb7185', '#a3e635'];
const TYPE_COLORS = { ahorro: '#34d399', bolsa: '#60a5fa', cripto: '#f59e0b', otro: '#94a3b8' };

/** +12.3% / −4.0% / — */
const pct = (n, digits = 1) =>
  (n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${Number(n).toFixed(digits)}%`);
const tone = (n) => (n === null || n === undefined || n === 0 ? '' : n > 0 ? 'is-good' : 'is-bad');

export function renderInvestments(root, state, actions) {
  const inv = state.investments;

  if (inv === null || inv === undefined) {
    return mount(root, el('div', { class: 'view' }, faltanTablas()));
  }
  if (inv.error) {
    return mount(root, el('div', { class: 'view' }, falloAlCargar(inv.error, actions)));
  }
  if (!inv.accounts.length) {
    return mount(root, el('div', { class: 'view' }, bienvenida(state, actions)));
  }

  const month = state.month;
  const goal = Number(state.settings?.monthly_investment_goal) || null;
  const summary = fin.investmentSummary({
    accounts: inv.accounts, flows: inv.flows, values: inv.values, month, goal,
  });

  // Ingreso del mes, para saber qué parte de lo que ganaste se fue a invertir.
  const { from, to } = fin.monthRange(month);
  const monthTxs = fin.filterTransactions(state.transactions, { from, to });
  const pace = fin.spendingPace(monthTxs, month);
  const insights = fin.investmentInsights(summary, {
    monthIncome: fin.summarize(monthTxs).income,
    isCurrentMonth: pace.isCurrentMonth, daysLeft: pace.daysLeft,
  });
  const history = fin.valueHistory(inv.accounts, inv.flows, inv.values);

  mount(root,
    el('div', { class: 'view' },
      monthBar(month, actions),
      statsRow(summary),
      insights.length > 0 && insightsCard(insights),
      platformsTable(summary, inv, state, actions),
      detectedCard(pendingInvestmentTransfers({
        transactions: state.transactions, accounts: inv.accounts, flows: inv.flows,
      }), inv, actions),
      el('div', { class: 'grid grid--2' },
        updateValuesCard(summary, inv, actions),
        addFlowCard(inv, actions),
      ),
      chartsRow(summary, inv, history, month),
      goalCard(goal, actions),
      historyCard(inv, state, actions),
      addPlatformCard(inv, actions),
    ),
  );
}

// ---------------------------------------------------------------------------
// Avisos
// ---------------------------------------------------------------------------
const faltanTablas = () => el('section', { class: 'card' },
  el('h3', {}, 'Falta un paso para activar Inversiones'),
  el('p', { class: 'muted' },
    'Esta sección guarda sus datos en tablas nuevas. Una sola vez: en Supabase → ' +
    'SQL Editor → New query, pega el contenido de '),
  el('p', {}, el('code', {}, 'supabase/05_inversiones.sql'), ' y dale Run.'),
  el('p', { class: 'muted' }, 'Después recarga esta página. No toca ninguno de tus datos actuales.'),
);

const falloAlCargar = (msg, actions) => el('section', { class: 'card card--error' },
  el('h3', {}, 'No pude cargar tus inversiones'),
  el('p', {}, String(msg)),
  el('button', { class: 'btn btn--ghost', onclick: () => actions.reload() }, 'Reintentar'),
);

function monthBar(month, actions) {
  const next = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  };
  return el('div', { class: 'monthbar' },
    el('button', { class: 'btn btn--ghost', 'aria-label': 'Mes anterior',
      onclick: () => actions.setMonth(fin.previousMonth(month)) }, '‹'),
    el('h2', { class: 'monthbar__label' }, fin.monthLabel(month)),
    el('button', { class: 'btn btn--ghost', 'aria-label': 'Mes siguiente',
      disabled: month >= fin.currentMonth(), onclick: () => actions.setMonth(next(month)) }, '›'),
  );
}

// ---------------------------------------------------------------------------
// Números grandes
// ---------------------------------------------------------------------------
function statsRow(s) {
  const t = s.totals;
  const g = s.goalProgress;
  return el('div', { class: 'stats' },
    stat('Valor actual', money(t.value), 'neutral', `${s.count} plataforma${s.count === 1 ? '' : 's'}`),
    stat('Le metí (total)', money(t.contributed), 'neutral', 'aportado menos retiros'),
    stat('Ganancia', t.returnPct === null ? '—' : money(t.gain),
      t.returnPct === null ? 'neutral' : (t.gain >= 0 ? 'in' : 'out'),
      t.returnPct === null
        ? 'registra cuánto has metido para medirla'
        : `${pct(t.returnPct)} sobre ${money(t.trackedContributed)}`),
    stat('Rendimiento anual', t.annualized === null ? '—' : pct(t.annualized * 100),
      t.annualized === null ? 'neutral' : (t.annualized >= 0 ? 'in' : 'out'),
      t.annualized === null ? `necesita ${fin.MIN_DAYS_FOR_ANNUALIZED}+ días de historia` : 'cuenta cuándo metiste cada peso'),
    stat('Este mes', money(t.monthNet), t.monthNet > 0 ? 'in' : 'neutral',
      g ? `meta ${money(g.goal)} · ${Math.max(0, g.pct)}%` : 'sin meta definida'),
  );
}

function stat(label, value, toneName, hint) {
  return el('div', { class: `stat stat--${toneName}` },
    el('span', { class: 'stat__label' }, label),
    el('strong', { class: 'stat__value' }, value),
    hint && el('span', { class: 'stat__delta' }, hint),
  );
}

function insightsCard(list) {
  return el('section', { class: 'card' },
    el('h3', {}, 'Qué dicen tus números'),
    el('ul', { class: 'insights' },
      list.map((o) => el('li', { class: `insight insight--${o.tone}` },
        el('strong', {}, o.title),
        o.detail && el('span', { class: 'muted' }, o.detail)))),
    el('p', { class: 'note' },
      'Son cuentas sobre tus propios datos, no recomendaciones de compra o venta.'),
  );
}

// ---------------------------------------------------------------------------
// La tabla principal: el espejo del Excel
// ---------------------------------------------------------------------------
function platformsTable(summary, inv, state, actions) {
  const t = summary.totals;
  return el('section', { class: 'card' },
    el('div', { class: 'card__head' },
      el('h3', {}, 'Plataformas'),
      el('span', { class: 'muted' }, 'Valor = foto más reciente · Le metí = aportaciones − retiros')),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'table invtable' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Plataforma'),
          el('th', { class: 'num' }, 'Este mes'),
          el('th', { class: 'num' }, 'Valor actual'),
          el('th', { class: 'num' }, 'Le metí'),
          el('th', { class: 'num' }, 'Ganancia'),
          el('th', { class: 'num' }, '%'),
          el('th', { class: 'num', title: 'Rendimiento anualizado (necesita 90+ días)' }, 'Anual'),
          el('th', {}, 'Peso'),
          el('th', { 'aria-label': 'Acciones' }))),
        el('tbody', {}, summary.rows.map((r) => platformRow(r, inv, actions))),
        el('tfoot', {}, el('tr', {},
          el('td', {}, 'Total'),
          el('td', { class: 'num' }, money(t.monthNet)),
          el('td', { class: 'num' }, money(t.value)),
          el('td', { class: 'num' }, money(t.contributed)),
          el('td', { class: `num ${tone(t.gain)}` }, t.returnPct === null ? '—' : money(t.gain)),
          el('td', { class: `num ${tone(t.returnPct)}` }, pct(t.returnPct)),
          el('td', { class: `num ${tone(t.annualized)}` }, t.annualized === null ? '—' : pct(t.annualized * 100)),
          el('td', {}), el('td', {}))),
      )),
    t.untrackedValue > 0 && el('p', { class: 'note' },
      `${money(t.untrackedValue)} están en plataformas sin aportaciones registradas: cuentan en el valor ` +
      'total pero no en la ganancia (no se sabe con cuánto empezaste).'),
  );
}

function platformRow(r, inv, actions) {
  const color = PALETTE[Math.abs(hash(r.id)) % PALETTE.length];
  return el('tr', { class: r.hasValue ? '' : 'is-off' },
    el('td', {},
      el('span', { class: 'chip__dot', style: { background: TYPE_COLORS[r.type] || color } }), ' ',
      el('strong', {}, r.name), ' ',
      el('span', { class: 'tag' }, fin.TYPE_LABELS[r.type] ?? r.type)),
    el('td', { class: `num ${tone(r.monthNet)}` }, r.monthNet === 0 ? '—' : money(r.monthNet)),
    el('td', { class: 'num' },
      r.hasValue ? money(r.value) : el('span', { class: 'muted' }, 'sin valor'),
      r.hasValue && el('small', {
        class: `invtable__date ${r.stale ? 'is-stale' : ''}`,
        title: r.stale ? 'Este valor ya está viejo: actualízalo' : 'Fecha de la última actualización',
      }, r.stale ? `⚠ hace ${r.daysSinceValue} d` : r.valueDate)),
    el('td', { class: 'num' }, r.contributed === 0 && r.deposited === 0 ? '—' : money(r.contributed)),
    el('td', { class: `num ${tone(r.gain)}` }, r.gain === null ? '—' : money(r.gain)),
    el('td', { class: `num ${tone(r.returnPct)}` }, pct(r.returnPct)),
    el('td', { class: `num ${tone(r.annualized)}` }, r.annualized === null ? '—' : pct(r.annualized * 100)),
    el('td', {}, el('span', { class: 'rank__track', title: `${Math.round(r.share * 100)}% del total` },
      el('span', { class: 'rank__fill', style: { width: `${Math.round(r.share * 100)}%`, background: TYPE_COLORS[r.type] || color } }))),
    el('td', { class: 'txrow__actions' },
      el('button', { class: 'iconbtn iconbtn--edit', title: 'Editar plataforma', 'aria-label': `Editar ${r.name}`,
        onclick: () => editPlatform(r, inv, actions) }, '✎'),
      el('button', { class: 'iconbtn', title: 'Eliminar plataforma', 'aria-label': `Eliminar ${r.name}`,
        onclick: () => deletePlatform(r, inv, actions) }, '✕')),
  );
}

const hash = (s) => [...String(s)].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);

// ---------------------------------------------------------------------------
// Actualizar valores (la rutina semanal): un campo por plataforma
// ---------------------------------------------------------------------------
function updateValuesCard(summary, inv, actions) {
  const form = el('form', { class: 'card' },
    el('h3', {}, 'Actualizar valores'),
    el('p', { class: 'muted' },
      'Escribe cuánto hay HOY en cada plataforma. Deja en blanco las que no cambiaron.'),
    el('label', { class: 'editform__field' }, el('span', {}, 'Fecha'),
      el('input', { name: 'as_of', type: 'date', value: fin.todayISO(), max: fin.todayISO() })),
    el('div', { class: 'valgrid' },
      summary.rows.map((r) => el('label', { class: 'editform__field' },
        el('span', {}, r.name, r.hasValue && el('small', { class: 'muted' }, ` · ${money(r.value)}`)),
        el('input', {
          name: `v_${r.id}`, type: 'number', step: '0.01', min: '0', inputmode: 'decimal',
          placeholder: r.hasValue ? String(r.value) : '0.00',
        })))),
    el('button', { class: 'btn btn--primary', type: 'submit' }, 'Guardar valores'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = new Set(inv.accounts.map((a) => a.id));
    const as_of = form.as_of.value;
    const rows = [];
    for (const r of summary.rows) {
      const raw = form.elements[`v_${r.id}`].value;
      if (String(raw).trim() === '') continue;
      const res = validateValue({ investment_id: r.id, as_of, value: raw }, { accountIds: ids });
      if (!res.ok) return toast(`${r.name}: ${Object.values(res.errors)[0]}`, 'error', 6000);
      rows.push(res.value);
    }
    if (!rows.length) return toast('No escribiste ningún valor.', 'error');

    await withBusy(form.querySelector('button[type=submit]'), async () => {
      try {
        await store.upsertValues(rows);
        toast(`Listo: ${rows.length} valor${rows.length === 1 ? '' : 'es'} actualizado${rows.length === 1 ? '' : 's'}.`, 'ok');
        await actions.reload();
      } catch (err) { toast(store.dbErrorMessage(err), 'error', 8000); }
    });
  });
  return form;
}

// ---------------------------------------------------------------------------
// Aportación / retiro
// ---------------------------------------------------------------------------
function addFlowCard(inv, actions) {
  const form = el('form', { class: 'card' },
    el('h3', {}, 'Registrar aportación o retiro'),
    el('p', { class: 'muted' }, 'Cada vez que metes o sacas dinero de una plataforma.'),
    el('div', { class: 'editform__grid' },
      el('label', { class: 'editform__field' }, el('span', {}, 'Plataforma'),
        el('select', { name: 'investment_id' },
          inv.accounts.filter((a) => !a.archived).map((a) => el('option', { value: a.id }, a.name)))),
      el('label', { class: 'editform__field' }, el('span', {}, 'Tipo'),
        el('select', { name: 'kind' },
          Object.entries(FLOW_KINDS).map(([k, l]) => el('option', { value: k }, l)))),
      el('label', { class: 'editform__field' }, el('span', {}, 'Monto'),
        el('input', { name: 'amount', type: 'number', step: '0.01', min: '0.01', inputmode: 'decimal', placeholder: '0.00' })),
      el('label', { class: 'editform__field' }, el('span', {}, 'Fecha'),
        el('input', { name: 'occurred_on', type: 'date', value: fin.todayISO(), max: fin.todayISO() })),
      el('label', { class: 'editform__field editform__field--wide' }, el('span', {}, 'Nota (opcional)'),
        el('input', { name: 'note', type: 'text', maxlength: '200', placeholder: 'Ej. quincena de octubre' })),
    ),
    el('button', { class: 'btn btn--primary', type: 'submit' }, 'Registrar'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = validateFlow(Object.fromEntries(new FormData(form).entries()),
      { accountIds: new Set(inv.accounts.map((a) => a.id)) });
    if (!res.ok) return toast(Object.values(res.errors)[0], 'error', 6000);
    await withBusy(form.querySelector('button[type=submit]'), async () => {
      try {
        await store.createFlows([res.value]);
        toast(res.value.kind === 'deposit' ? 'Aportación registrada.' : 'Retiro registrado.', 'ok');
        await actions.reload();
      } catch (err) { toast(store.dbErrorMessage(err), 'error', 8000); }
    });
  });
  return form;
}

// ---------------------------------------------------------------------------
// Envíos a inversión detectados en tus estados de cuenta
// ---------------------------------------------------------------------------
function detectedCard(pending, inv, actions) {
  if (!pending.length) return null;
  const activas = inv.accounts.filter((a) => !a.archived);

  const fila = ({ tx, suggestedId }) => {
    const plat = el('select', { 'aria-label': 'Plataforma' },
      !suggestedId && el('option', { value: '' }, 'Elige plataforma…'),
      activas.map((a) => el('option', { value: a.id, selected: a.id === suggestedId }, a.name)));
    const kind = el('select', { 'aria-label': 'Tipo' },
      Object.entries(FLOW_KINDS).map(([k, l]) => el('option', { value: k }, l)));
    const registrar = el('button', { class: 'btn btn--primary', type: 'button' }, 'Registrar');
    registrar.addEventListener('click', async () => {
      const res = validateFlow({
        investment_id: plat.value, kind: kind.value, amount: String(tx.amount),
        occurred_on: tx.occurred_on, note: 'Detectado en tus movimientos',
      }, { accountIds: new Set(inv.accounts.map((a) => a.id)) });
      if (!res.ok) return toast(Object.values(res.errors)[0], 'error', 6000);
      await withBusy(registrar, async () => {
        try {
          await store.createFlows([res.value]);
          toast('Registrado.', 'ok');
          await actions.reload();
        } catch (err) { toast(store.dbErrorMessage(err), 'error', 8000); }
      });
    });
    const noEs = el('button', { class: 'iconbtn', type: 'button', title: 'No es una inversión',
      'aria-label': 'No es una inversión' }, '✕');
    noEs.addEventListener('click', async () => {
      const ok = await confirmDialog('¿No es una inversión?',
        'Lo dejo como traspaso entre tus cuentas y deja de aparecer aquí. No cambia tus totales.',
        { okLabel: 'Sí, quitarlo' });
      if (!ok) return;
      try {
        await store.updateTransaction(tx.id, { transfer_reason: 'cuenta-propia' });
        await actions.reload();
      } catch (err) { toast(store.dbErrorMessage(err), 'error', 8000); }
    });
    return el('tr', {},
      el('td', { class: 'txrow__date' }, fin.dateLabel(tx.occurred_on)),
      el('td', {}, tx.description),
      el('td', { class: 'num' }, money(tx.amount)),
      el('td', {}, plat), el('td', {}, kind),
      el('td', { class: 'txrow__actions' }, registrar, noEs));
  };

  return el('section', { class: 'card' },
    el('h3', {}, `Detecté ${pending.length} ${pending.length === 1 ? 'envío' : 'envíos'} a inversión en tus movimientos`),
    el('p', { class: 'muted' },
      'Salieron de tus cuentas hacia una plataforma de inversión y todavía no están como aportación. ' +
      'Regístralos con un clic para no capturarlos dos veces (si fue un retiro, cambia el tipo).'),
    el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Fecha'), el('th', {}, 'Movimiento'),
        el('th', { class: 'num' }, 'Monto'), el('th', {}, 'Plataforma'), el('th', {}, 'Tipo'), el('th', {}))),
      el('tbody', {}, pending.map(fila)))),
  );
}

// ---------------------------------------------------------------------------
// Gráficas
// ---------------------------------------------------------------------------
function chartsRow(summary, inv, history, month) {
  const rows = summary.rows.filter((r) => r.value > 0);
  const total = summary.totals.value;
  const porPlataforma = rows.map((r, i) => ({
    id: r.id, name: r.name, amount: r.value, share: r.share,
    color: TYPE_COLORS[r.type] ?? PALETTE[i % PALETTE.length],
  }));
  const porTipo = summary.typeBreakdown.map((t) => ({
    id: t.type, name: fin.TYPE_LABELS[t.type] ?? t.type, amount: t.value, share: t.share,
    color: TYPE_COLORS[t.type] ?? '#94a3b8',
  }));
  const meses = fin.monthlyContributions(inv.flows, month, 12);
  const maxMes = Math.max(1, ...meses.map((m) => Math.abs(m.net)));

  return el('div', { class: 'grid grid--2' },
    el('section', { class: 'card' },
      el('h3', {}, 'Dónde está tu dinero'),
      rows.length
        ? el('div', { class: 'donut-wrap' },
            donut(porPlataforma, { centerValue: money(total), centerLabel: 'invertido' }),
            legend(porPlataforma))
        : el('p', { class: 'muted empty' }, 'Escribe el valor de tus plataformas para verlo.')),
    el('section', { class: 'card' },
      el('h3', {}, 'Por tipo'),
      porTipo.length
        ? el('div', { class: 'donut-wrap' }, donut(porTipo, { centerValue: `${porTipo.length}`, centerLabel: 'tipos' }), legend(porTipo))
        : el('p', { class: 'muted empty' }, 'Sin datos todavía.')),
    el('section', { class: 'card' },
      el('h3', {}, 'Lo que has metido, mes a mes'),
      el('div', { class: 'bars' },
        meses.map((m) => el('div', { class: 'bars__col', title: `${m.month}: ${money(m.net)}` },
          el('div', { class: 'bars__pair', style: { height: '140px' } },
            el('div', {
              class: `bars__bar ${m.net >= 0 ? 'bars__bar--in' : 'bars__bar--out'}`,
              style: { height: `${(Math.abs(m.net) / maxMes) * 100}%`, width: '18px' },
            })),
          el('span', { class: 'bars__label' }, m.month.slice(5))))),
      el('p', { class: 'note' }, 'Verde = metiste más de lo que sacaste; rojo = sacaste más.')),
    el('section', { class: 'card card--full' },
      el('h3', {}, 'Cuánto vale vs. cuánto metiste'),
      lineChart([
        { label: 'Valor', color: '#9b7dff', points: history.map((h) => ({ date: h.date, y: h.value })) },
        { label: 'Metido', color: '#9aa3b2', dashed: true, points: history.map((h) => ({ date: h.date, y: h.contributed })) },
      ]),
      el('p', { class: 'note' },
        'La distancia entre las dos líneas es tu ganancia. Cada punto es una vez que actualizaste valores.')),
  );
}

// ---------------------------------------------------------------------------
// Meta mensual
// ---------------------------------------------------------------------------
function goalCard(goal, actions) {
  const form = el('form', { class: 'card' },
    el('h3', {}, 'Meta mensual de inversión'),
    el('p', { class: 'muted' }, 'Cuánto quieres meter cada mes. Aparece arriba contra lo que llevas.'),
    el('div', { class: 'formrow formrow--tight' },
      el('input', { name: 'goal', type: 'number', step: '50', min: '0', inputmode: 'decimal',
        value: goal ?? '', placeholder: 'Ej. 5500' }),
      el('button', { class: 'btn btn--primary', type: 'submit' }, 'Guardar meta')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = validateGoal(form.goal.value);
    if (!res.ok) return toast(res.error, 'error');
    await withBusy(form.querySelector('button[type=submit]'), async () => {
      try {
        await store.saveSettings({ monthly_investment_goal: res.value });
        toast(res.value === null ? 'Meta quitada.' : `Meta: ${money(res.value)} al mes.`, 'ok');
        await actions.reload();
      } catch (err) { toast(store.dbErrorMessage(err), 'error', 8000); }
    });
  });
  return form;
}

// ---------------------------------------------------------------------------
// Historial (editable)
// ---------------------------------------------------------------------------
function historyCard(inv, state, actions) {
  const nombre = (id) => inv.accounts.find((a) => a.id === id)?.name ?? '—';
  const flows = [...inv.flows].sort((a, b) =>
    b.occurred_on.localeCompare(a.occurred_on) || String(b.created_at).localeCompare(String(a.created_at))).slice(0, 100);
  const values = [...inv.values].sort((a, b) => b.as_of.localeCompare(a.as_of)).slice(0, 100);

  return el('section', { class: 'card' },
    el('h3', {}, 'Historial'),
    flows.length
      ? el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Fecha'), el('th', {}, 'Plataforma'), el('th', {}, 'Tipo'),
            el('th', { class: 'num' }, 'Monto'), el('th', {}, 'Nota'), el('th', {}))),
          el('tbody', {}, flows.map((f) => el('tr', {},
            el('td', { class: 'txrow__date' }, fin.dateLabel(f.occurred_on)),
            el('td', {}, nombre(f.investment_id)),
            el('td', {}, FLOW_KINDS[f.kind]),
            el('td', { class: `num amount ${f.kind === 'deposit' ? 'amount--income' : 'amount--expense'}` },
              `${f.kind === 'deposit' ? '+' : '−'} ${money(f.amount)}`),
            el('td', { class: 'muted' }, f.note || ''),
            el('td', { class: 'txrow__actions' },
              el('button', { class: 'iconbtn iconbtn--edit', title: 'Editar', 'aria-label': 'Editar aportación',
                onclick: () => editFlow(f, inv, actions) }, '✎'),
              el('button', { class: 'iconbtn', title: 'Eliminar', 'aria-label': 'Eliminar aportación',
                onclick: () => removeRow(`${FLOW_KINDS[f.kind]} de ${money(f.amount)}`, () => store.deleteFlow(f.id), actions) }, '✕')))))))
      : el('p', { class: 'muted empty' }, 'Aún no hay aportaciones ni retiros registrados.'),
    values.length > 0 && el('details', { class: 'help' },
      el('summary', {}, `Historial de valores (${inv.values.length})`),
      el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Fecha'), el('th', {}, 'Plataforma'),
          el('th', { class: 'num' }, 'Valor'), el('th', {}))),
        el('tbody', {}, values.map((v) => el('tr', {},
          el('td', { class: 'txrow__date' }, fin.dateLabel(v.as_of)),
          el('td', {}, nombre(v.investment_id)),
          el('td', { class: 'num' }, money(v.value)),
          el('td', { class: 'txrow__actions' },
            el('button', { class: 'iconbtn iconbtn--edit', title: 'Editar', 'aria-label': 'Editar valor',
              onclick: () => editValue(v, inv, actions) }, '✎'),
            el('button', { class: 'iconbtn', title: 'Eliminar', 'aria-label': 'Eliminar valor',
              onclick: () => removeRow(`el valor de ${nombre(v.investment_id)} del ${v.as_of}`, () => store.deleteValue(v.id), actions) }, '✕')))))))),
  );
}

async function removeRow(que, borrar, actions) {
  const ok = await confirmDialog('¿Eliminar?', `Se borrará ${que}.`, { danger: true, okLabel: 'Eliminar' });
  if (!ok) return;
  try { await borrar(); toast('Eliminado.', 'ok'); await actions.reload(); }
  catch (err) { toast(store.dbErrorMessage(err), 'error'); }
}

function editFlow(f, inv, actions) {
  const ids = new Set(inv.accounts.map((a) => a.id));
  formDialog({
    title: 'Editar aportación / retiro',
    fields: [
      { name: 'investment_id', label: 'Plataforma', value: f.investment_id, options: inv.accounts.map((a) => [a.id, a.name]) },
      { name: 'kind', label: 'Tipo', value: f.kind, options: Object.entries(FLOW_KINDS) },
      { name: 'amount', label: 'Monto', type: 'number', step: '0.01', value: String(f.amount), inputmode: 'decimal' },
      { name: 'occurred_on', label: 'Fecha', type: 'date', value: f.occurred_on },
      { name: 'note', label: 'Nota', value: f.note ?? '', maxlength: 200, wide: true },
    ],
    validate: (v) => validateFlow(v, { accountIds: ids }),
    save: async (value) => { await store.updateFlow(f.id, value); toast('Actualizado.', 'ok'); await actions.reload(); },
  });
}

function editValue(v, inv, actions) {
  const ids = new Set(inv.accounts.map((a) => a.id));
  formDialog({
    title: 'Editar valor',
    fields: [
      { name: 'investment_id', label: 'Plataforma', value: v.investment_id, options: inv.accounts.map((a) => [a.id, a.name]) },
      { name: 'value', label: 'Valor', type: 'number', step: '0.01', value: String(v.value), inputmode: 'decimal' },
      { name: 'as_of', label: 'Fecha', type: 'date', value: v.as_of },
    ],
    validate: (x) => validateValue(x, { accountIds: ids }),
    save: async (value) => {
      try { await store.updateValue(v.id, value); }
      catch (err) {
        throw new Error(err?.code === '23505'
          ? 'Ya hay un valor de esa plataforma en esa fecha: edita ese o bórralo.' : store.dbErrorMessage(err));
      }
      toast('Actualizado.', 'ok'); await actions.reload();
    },
  });
}

// ---------------------------------------------------------------------------
// Plataformas: agregar, editar, eliminar
// ---------------------------------------------------------------------------
function addPlatformCard(inv, actions) {
  const nombres = inv.accounts.map((a) => a.name);
  const faltan = SUGGESTED_PLATFORMS.filter((s) => !nombres.some((n) => n.toLowerCase() === s.name.toLowerCase()));

  const crear = async (value, btn) => {
    await withBusy(btn, async () => {
      try {
        await store.createInvestmentAccounts([{ ...value, sort_order: 100 + inv.accounts.length }]);
        toast(`${value.name} agregada.`, 'ok');
        await actions.reload();
      } catch (err) {
        toast(err?.code === '23505' ? 'Ya tienes una plataforma con ese nombre.' : store.dbErrorMessage(err), 'error', 8000);
      }
    });
  };

  const form = el('form', { class: 'formrow formrow--tight' },
    el('input', { name: 'name', placeholder: 'Nueva plataforma', maxlength: '60', required: true }),
    el('select', { name: 'type' }, TYPES.map((t) => el('option', { value: t }, TYPE_HELP[t]))),
    el('button', { class: 'btn btn--primary', type: 'submit' }, 'Agregar'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = validateAccount({ name: form.name.value, type: form.type.value }, { others: nombres });
    if (!res.ok) return toast(Object.values(res.errors)[0], 'error');
    await crear(res.value, form.querySelector('button[type=submit]'));
  });

  return el('section', { class: 'card' },
    el('h3', {}, 'Agregar plataforma'),
    faltan.length > 0 && el('div', { class: 'chips' }, faltan.map((s) => el('button', {
      class: 'chip chip--btn', type: 'button', title: TYPE_HELP[s.type],
      onclick: (e) => crear(s, e.currentTarget),
    }, `+ ${s.name}`))),
    form);
}

function editPlatform(r, inv, actions) {
  const otros = inv.accounts.filter((a) => a.id !== r.id).map((a) => a.name);
  const actual = inv.accounts.find((a) => a.id === r.id);
  formDialog({
    title: `Editar ${r.name}`,
    fields: [
      { name: 'name', label: 'Nombre', value: r.name, maxlength: 60 },
      { name: 'type', label: 'Tipo', value: r.type, options: TYPES.map((t) => [t, TYPE_HELP[t]]) },
      { name: 'archived', label: 'Estado', value: actual?.archived ? 'si' : 'no',
        options: [['no', 'Activa'], ['si', 'Archivada (ya no cuenta en el total)']] },
    ],
    validate: (v) => {
      const res = validateAccount(v, { others: otros });
      return res.ok ? { ...res, value: { ...res.value, archived: v.archived === 'si' } } : res;
    },
    save: async (value) => {
      try { await store.updateInvestmentAccount(r.id, value); }
      catch (err) { throw new Error(err?.code === '23505' ? 'Ya tienes una plataforma con ese nombre.' : store.dbErrorMessage(err)); }
      toast('Actualizada.', 'ok'); await actions.reload();
    },
  });
}

async function deletePlatform(r, inv, actions) {
  const nFlows = inv.flows.filter((f) => f.investment_id === r.id).length;
  const nVals = inv.values.filter((v) => v.investment_id === r.id).length;
  const ok = await confirmDialog(`¿Eliminar ${r.name}?`,
    `Se borrarán también sus ${nFlows} aportaci${nFlows === 1 ? 'ón' : 'ones'} y ${nVals} valor${nVals === 1 ? '' : 'es'} ` +
    'guardados. No se puede deshacer. (Si sólo ya no la usas, mejor archívala con ✎.)',
    { danger: true, okLabel: 'Eliminar todo' });
  if (!ok) return;
  try { await store.deleteInvestmentAccount(r.id); toast(`${r.name} eliminada.`, 'ok'); await actions.reload(); }
  catch (err) { toast(store.dbErrorMessage(err), 'error'); }
}

// ---------------------------------------------------------------------------
// Primera vez: pasar el Excel
// ---------------------------------------------------------------------------
function bienvenida(state, actions) {
  const year = new Date().getFullYear();
  const filas = SUGGESTED_PLATFORMS.map((s) => ({ ...s }));

  const body = el('tbody', {});
  const pintar = () => {
    body.replaceChildren(...filas.map((f, i) => el('tr', {},
      el('td', {}, el('input', { name: `n${i}`, value: f.name, 'aria-label': 'Plataforma', maxlength: '60',
        oninput: (e) => { f.name = e.target.value; } })),
      el('td', {}, el('select', { name: `t${i}`, onchange: (e) => { f.type = e.target.value; } },
        TYPES.map((t) => el('option', { value: t, selected: t === f.type }, fin.TYPE_LABELS[t])))),
      // `value` se conserva al agregar filas: reconstruir la tabla no debe
      // borrar lo que ya escribiste.
      el('td', {}, el('input', { name: `v${i}`, type: 'number', step: '0.01', min: '0', inputmode: 'decimal',
        value: f.value ?? '', placeholder: 'hoy hay…', 'aria-label': `Valor actual de ${f.name}`,
        oninput: (e) => { f.value = e.target.value; } })),
      el('td', {}, el('input', { name: `c${i}`, type: 'number', step: '0.01', min: '0', inputmode: 'decimal',
        value: f.contributed ?? '', placeholder: 'en total he metido…', 'aria-label': `Le metí a ${f.name}`,
        oninput: (e) => { f.contributed = e.target.value; } })))));
  };
  pintar();

  const since = el('input', { type: 'date', value: `${year}-01-01`, max: fin.todayISO() });
  const btn = el('button', { class: 'btn btn--primary', type: 'button' }, 'Guardar mis inversiones');

  btn.addEventListener('click', async () => {
    const plan = planOnboarding(filas, { since: since.value });
    if (!plan.ok) return toast(plan.errors[0], 'error', 8000);

    await withBusy(btn, async () => {
      let creadas = [];
      try {
        creadas = await store.createInvestmentAccounts(plan.accounts.map((a, i) => ({ ...a, sort_order: 10 + i })));
        const id = new Map(creadas.map((a) => [a.name, a.id]));
        if (plan.flows.length) {
          await store.createFlows(plan.flows.map(({ name, ...f }) => ({ ...f, investment_id: id.get(name) })));
        }
        if (plan.values.length) {
          await store.upsertValues(plan.values.map(({ name, ...v }) => ({ ...v, investment_id: id.get(name) })));
        }
        toast('Listo, tus inversiones ya están en LootHound.', 'ok', 6000);
        await actions.reload();
      } catch (err) {
        // Si algo falla a medias, se deshace: dejar plataformas sin datos obligaría
        // a empezar de cero con nombres ya ocupados.
        for (const a of creadas) { try { await store.deleteInvestmentAccount(a.id); } catch { /* ya no existe */ } }
        toast(`No se guardó nada: ${store.dbErrorMessage(err)}`, 'error', 9000);
      }
    });
  });

  return el('section', { class: 'card' },
    el('h3', {}, 'Pasa tu hoja de Excel a LootHound'),
    el('p', { class: 'muted' },
      'Una sola vez. Escribe, por cada plataforma, cuánto hay hoy y cuánto has metido en total ' +
      '(las columnas "Inversión actual" y "Le metí" de tu Excel). Deja en blanco las que no uses.'),
    el('label', { class: 'editform__field' }, el('span', {}, '¿Desde cuándo empezaste a meter dinero?'), since),
    el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Plataforma'), el('th', {}, 'Tipo'),
        el('th', {}, 'Valor actual'), el('th', {}, 'Le metí (total)'))),
      body)),
    el('p', { class: 'note' },
      'Si no sabes cuánto metiste en una cuenta de ahorro (Nu, Mercado Pago...), deja "Le metí" vacío: ' +
      'cuenta en el valor total, pero no en la ganancia. Si prefieres medirla, escribe con cuánto empezaste.'),
    el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => {
      filas.push({ name: '', type: 'otro' }); pintar();
    } }, '+ Otra plataforma'),
    ' ', btn);
}
