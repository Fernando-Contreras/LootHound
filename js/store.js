// ===========================================================================
// Capa de datos: TODAS las consultas a Supabase viven aquí.
// El resto de la app no habla con la base directamente.
//
// Nota sobre seguridad: ninguna consulta filtra por user_id a mano. No hace
// falta y no debe hacerse — RLS ya lo impone del lado del servidor, y
// `user_id` tiene DEFAULT auth.uid(). Si alguien quitara un filtro del
// frontend, la base seguiría devolviendo sólo sus propias filas.
// ===========================================================================

import { getClient } from './supabase.js';

const sb = () => {
  const c = getClient();
  if (!c) throw new Error('Supabase no está configurado.');
  return c;
};

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------- catálogos
export async function fetchAccounts() {
  return unwrap(await sb().from('accounts').select('*')
    .order('kind').order('name'));
}

export async function fetchCategories() {
  return unwrap(await sb().from('categories').select('*')
    .order('sort_order').order('name'));
}

export async function fetchRules() {
  return unwrap(await sb().from('category_rules').select('*')
    .order('priority').order('pattern'));
}

export async function createCategory(cat) {
  return unwrap(await sb().from('categories').insert(cat).select().single());
}

export async function createAccount(acc) {
  return unwrap(await sb().from('accounts').insert(acc).select().single());
}

// ---------------------------------------------------------------- reglas
export async function createRule(rule) {
  return unwrap(await sb().from('category_rules').insert(rule).select().single());
}

export async function updateRule(id, patch) {
  return unwrap(await sb().from('category_rules').update(patch).eq('id', id).select().single());
}

export async function deleteRule(id) {
  const { error } = await sb().from('category_rules').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------- movimientos
const TX_COLUMNS =
  'id,account_id,counter_account_id,category_id,import_id,occurred_on,posted_on,' +
  'description,amount,kind,transfer_reason,note,source,categorized_by,' +
  'original_currency,original_amount,fx_rate,fingerprint';

/**
 * Trae movimientos. Supabase corta en 1000 filas por default, así que
 * paginamos hasta traer todo.
 */
export async function fetchTransactions({ from = null, to = null } = {}) {
  const PAGE = 1000;
  const all = [];
  for (let page = 0; ; page++) {
    let q = sb().from('transactions').select(TX_COLUMNS)
      .order('occurred_on', { ascending: false })
      .order('created_at', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (from) q = q.gte('occurred_on', from);
    if (to) q = q.lte('occurred_on', to);

    const rows = unwrap(await q);
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/** Sólo las huellas: se usa para detectar duplicados sin bajar todo. */
export async function fetchFingerprintIndex() {
  const PAGE = 1000;
  const all = [];
  for (let page = 0; ; page++) {
    const rows = unwrap(await sb().from('transactions')
      .select('id,account_id,occurred_on,amount,kind,description,fingerprint')
      .range(page * PAGE, page * PAGE + PAGE - 1));
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

export async function createTransaction(tx) {
  return unwrap(await sb().from('transactions').insert(tx).select().single());
}

export async function updateTransaction(id, patch) {
  return unwrap(await sb().from('transactions').update(patch).eq('id', id).select().single());
}

export async function deleteTransaction(id) {
  const { error } = await sb().from('transactions').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Inserta un lote. Va en tandas para no mandar un request gigante.
 * `onConflict: fingerprint` + ignoreDuplicates hace que reimportar el mismo
 * estado de cuenta simplemente no haga nada, en vez de reventar.
 */
export async function insertTransactions(rows, { batchSize = 200, onProgress } = {}) {
  let inserted = 0;
  const skipped = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const data = unwrap(await sb().from('transactions')
      .upsert(chunk, { onConflict: 'user_id,fingerprint', ignoreDuplicates: true })
      .select('id,fingerprint'));
    inserted += data.length;
    const got = new Set(data.map((r) => r.fingerprint));
    for (const r of chunk) if (!got.has(r.fingerprint)) skipped.push(r);
    onProgress?.(Math.min(i + batchSize, rows.length), rows.length);
  }
  return { inserted, skipped };
}

/**
 * Recategoriza movimientos ya guardados.
 *
 * Se agrupan por categoría destino para mandar UNA petición por categoría en
 * vez de una por movimiento: recategorizar 500 renglones son ~8 requests, no
 * 500.
 *
 * @param {Array<{id:string, category_id:string|null}>} updates
 */
export async function recategorize(updates) {
  const porCategoria = new Map();
  for (const u of updates) {
    const key = u.category_id ?? '__null__';
    if (!porCategoria.has(key)) porCategoria.set(key, []);
    porCategoria.get(key).push(u.id);
  }

  let changed = 0;
  for (const [key, ids] of porCategoria) {
    const category_id = key === '__null__' ? null : key;
    // `in` acepta listas grandes, pero se parte para no armar URLs enormes
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const data = unwrap(await sb().from('transactions')
        .update({ category_id, categorized_by: category_id ? 'rule' : 'none' })
        .in('id', chunk)
        .select('id'));
      changed += data.length;
    }
  }
  return changed;
}

// ---------------------------------------------------------------- importaciones
export async function createImport(imp) {
  return unwrap(await sb().from('imports').insert(imp).select().single());
}

export async function updateImport(id, patch) {
  return unwrap(await sb().from('imports').update(patch).eq('id', id).select().single());
}

export async function fetchImports() {
  return unwrap(await sb().from('imports').select('*')
    .order('created_at', { ascending: false }).limit(50));
}

/** Deshace una importación completa: borra sus movimientos y el registro. */
export async function undoImport(importId) {
  const { error: e1 } = await sb().from('transactions').delete().eq('import_id', importId);
  if (e1) throw e1;
  const { error: e2 } = await sb().from('imports').delete().eq('id', importId);
  if (e2) throw e2;
}

// ---------------------------------------------------------------- ajustes
export async function fetchSettings() {
  const rows = unwrap(await sb().from('settings').select('*').limit(1));
  return rows[0] ?? null;
}

export async function saveSettings(patch) {
  const current = await fetchSettings();
  if (current) {
    return unwrap(await sb().from('settings').update(patch)
      .eq('user_id', current.user_id).select().single());
  }
  return unwrap(await sb().from('settings').insert(patch).select().single());
}

export async function updateAccount(id, patch) {
  return unwrap(await sb().from('accounts').update(patch).eq('id', id).select().single());
}

// ---------------------------------------------------------------- semilla
/** Crea cuentas/categorías/reglas base si el usuario aún no las tiene. */
export async function ensureSeeded() {
  const accounts = await fetchAccounts();
  if (accounts.length) return accounts;
  const { error } = await sb().rpc('seed_me');
  if (error) throw error;
  return fetchAccounts();
}

/** Mensajes de error de Postgres traducidos. */
export function dbErrorMessage(err) {
  const m = String(err?.message || err || '');
  const code = err?.code;
  if (code === '23505') return 'Ese movimiento ya estaba registrado.';
  if (code === '23503') return 'La cuenta o categoría ya no existe.';
  if (code === '23514') {
    // Postgres dice cuál restricción falló; traducirla ahorra adivinar.
    const c = String(err?.details || err?.message || '');
    if (/description/i.test(c)) return 'Una descripción quedó vacía o demasiado larga (máx. 200 caracteres).';
    if (/amount/i.test(c)) return 'Hay un movimiento con monto en cero o negativo.';
    if (/counter_account/i.test(c)) return 'Una transferencia apunta a la misma cuenta de origen.';
    if (/fx_fields/i.test(c)) return 'A un movimiento en moneda extranjera le falta el monto original.';
    if (/kind|categorized_by|source/i.test(c)) return 'Un movimiento tiene un tipo no válido.';
    return `Un dato no cumple las reglas de la base: ${c.slice(0, 160)}`;
  }
  if (code === '42501' || /row-level security/i.test(m)) {
    return 'La base rechazó la operación (RLS). ¿Sigue activa tu sesión?';
  }
  if (/Failed to fetch/i.test(m)) return 'Sin conexión con Supabase.';
  return m || 'Error en la base de datos.';
}
