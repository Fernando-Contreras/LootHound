// Arranque, estado global y navegación.

import { el, mount, $, toast } from './dom.js';
import { getConfig } from './config.js';
import { currentSession, onAuthChange, signOut, getClient } from './supabase.js';
import * as store from './store.js';
import * as fin from './finance.js';
import { renderSetup, renderAuth } from './views/auth.js';
import { renderDashboard } from './views/dashboard.js';
import { renderTransactions } from './views/transactions.js';
import { renderImport } from './views/import.js';
import { renderRules } from './views/rules.js';

// ---------------------------------------------------------------------------
// Tema. Oscuro por defecto; el claro se guarda sólo si se pide.
const THEME_KEY = 'loothound.theme';

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  if (next === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* sin persistir */ }
  return next;
}

const state = {
  session: null,
  transactions: [],
  rules: [],
  imports: [],
  settings: null,
  accountMap: new Map(),
  categoryMap: new Map(),
  categoryByName: new Map(),
  month: fin.currentMonth(),
  filters: {},
  route: 'dashboard',
  loading: false,
};

const ROUTES = {
  dashboard: { label: 'Resumen', icon: '◎', render: renderDashboard },
  movimientos: { label: 'Movimientos', icon: '☰', render: renderTransactions },
  importar: { label: 'Importar PDF', icon: '↥', render: renderImport },
  reglas: { label: 'Reglas', icon: '⚙', render: renderRules },
};

const actions = {
  setMonth(m) { state.month = m; render(); },
  setFilters(f) { state.filters = f; render(); },
  go(route) {
    state.route = route;
    location.hash = route;
    render();
  },
  goToTransactions(filters) {
    state.filters = { ...filters, ...fin.monthRange(state.month) };
    actions.go('movimientos');
  },
  async reload() { await loadData(); render(); },
};

// ---------------------------------------------------------------------------
async function loadData() {
  state.loading = true;
  try {
    await store.ensureSeeded();
    const [accounts, categories, rules, transactions, imports, settings] = await Promise.all([
      store.fetchAccounts(),
      store.fetchCategories(),
      store.fetchRules(),
      store.fetchTransactions(),
      store.fetchImports(),
      store.fetchSettings(),
    ]);
    state.settings = settings;
    state.accountMap = new Map(accounts.map((a) => [a.id, a]));
    state.categoryMap = new Map(categories.map((c) => [c.id, c]));
    state.categoryByName = new Map(categories.map((c) => [c.name, c]));
    state.rules = rules;
    state.transactions = transactions;
    state.imports = imports;
  } catch (err) {
    console.error(err);
    toast(store.dbErrorMessage(err), 'error', 8000);
  } finally {
    state.loading = false;
  }
}

// ---------------------------------------------------------------------------
function render() {
  const root = $('#app');

  if (!getConfig()) return renderSetup(root, () => boot());
  if (!state.session) return renderAuth(root);

  const route = ROUTES[state.route] ? state.route : 'dashboard';

  mount(root,
    el('header', { class: 'topbar' },
      el('div', { class: 'brand' }, el('span', { class: 'brand__mark' }, '🐕'), 'LootHound'),
      el('nav', { class: 'nav' },
        Object.entries(ROUTES).map(([key, r]) => el('button', {
          class: `nav__item ${key === route ? 'is-active' : ''}`,
          onclick: () => actions.go(key),
        }, el('span', { class: 'nav__icon' }, r.icon), r.label)),
      ),
      el('div', { class: 'topbar__right' },
        el('span', { class: 'muted topbar__email' }, state.session.user.email),
        el('button', {
          class: 'iconbtn', title: 'Cambiar entre claro y oscuro',
          'aria-label': 'Cambiar tema',
          onclick: (e) => { e.target.textContent = toggleTheme() === 'light' ? '☾' : '☀'; },
        }, currentTheme() === 'light' ? '☾' : '☀'),
        el('button', {
          class: 'btn btn--ghost btn--sm',
          onclick: async () => { await signOut(); },
        }, 'Salir'),
      ),
    ),
    el('main', { id: 'main', class: 'main' }),
  );

  const main = $('#main');
  if (state.loading) {
    mount(main, el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Cargando...')));
    return;
  }
  ROUTES[route].render(main, state, actions);
}

// ---------------------------------------------------------------------------
async function boot() {
  if (!getConfig()) return render();

  const client = getClient();
  if (!client) return render();

  state.session = await currentSession();

  onAuthChange(async (session) => {
    const wasLoggedIn = Boolean(state.session);
    state.session = session;
    if (session && !wasLoggedIn) {
      await loadData();
    } else if (!session) {
      state.transactions = [];
      state.rules = [];
      state.imports = [];
      state.accountMap = new Map();
      state.categoryMap = new Map();
    }
    render();
  });

  if (state.session) await loadData();
  render();
}

window.addEventListener('hashchange', () => {
  const r = location.hash.slice(1);
  if (ROUTES[r] && r !== state.route) { state.route = r; render(); }
});

const initial = location.hash.slice(1);
if (ROUTES[initial]) state.route = initial;

boot();
