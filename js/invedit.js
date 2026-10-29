// ===========================================================================
// Validación de lo que se captura en Inversiones: plataformas, aportaciones,
// retiros y valores. Espeja los CHECK de supabase/05_inversiones.sql, para que
// el error salga junto al campo y no como un "algo falló" genérico de la base.
// ===========================================================================

import { parseAmount, isValidISODate } from './txedit.js';
import { todayISO, dayDiff } from './finance.js';
import { stripAccents } from './parsers/common.js';

export const TYPES = ['ahorro', 'bolsa', 'cripto', 'otro'];
export const TYPE_HELP = {
  ahorro: 'Ahorro (rendimiento diario, liquidez)',
  bolsa: 'Bolsa (acciones, fondos, ETFs)',
  cripto: 'Cripto',
  otro: 'Otro',
};
export const FLOW_KINDS = { deposit: 'Aportación', withdrawal: 'Retiro' };

/** Plataformas que casi todos usan: un clic en vez de escribirlas. */
export const SUGGESTED_PLATFORMS = [
  { name: 'Nu', type: 'ahorro' },
  { name: 'Mercado Pago', type: 'ahorro' },
  { name: 'Didi', type: 'ahorro' },
  { name: 'Revolut', type: 'ahorro' },
  { name: 'eToro', type: 'bolsa' },
  { name: 'GBM', type: 'bolsa' },
  { name: 'Bitso', type: 'cripto' },
];

const MAX = 999_999_999_999.99;

function checkDate(s, errors, field, hoy) {
  if (!isValidISODate(s)) errors[field] = 'Escribe una fecha válida.';
  else if (s > hoy) errors[field] = 'No puede ser una fecha futura.';
}

/** Plataforma nueva o editada. `others` = los demás nombres (para no repetir). */
export function validateAccount(v, { others = [] } = {}) {
  const errors = {};
  const name = String(v.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) errors.name = 'Ponle un nombre a la plataforma.';
  else if (name.length > 60) errors.name = 'Máximo 60 caracteres.';
  else if (others.some((o) => String(o).trim().toLowerCase() === name.toLowerCase())) {
    errors.name = 'Ya tienes una plataforma con ese nombre.';
  }
  if (!TYPES.includes(v.type)) errors.type = 'Escoge un tipo.';
  if (Object.keys(errors).length) return { ok: false, errors, value: null };
  return { ok: true, errors: {}, value: { name, type: v.type } };
}

/** Una aportación o un retiro. */
export function validateFlow(v, { accountIds, today = todayISO() } = {}) {
  const errors = {};
  if (!v.investment_id || !accountIds?.has?.(v.investment_id)) errors.investment_id = 'Escoge la plataforma.';
  checkDate(v.occurred_on, errors, 'occurred_on', today);

  const n = parseAmount(v.amount);
  let amount = null;
  if (!(n > 0)) errors.amount = 'El monto debe ser mayor a cero.';
  else if (n > MAX) errors.amount = 'Ese monto es demasiado grande.';
  else amount = Math.round(n * 100) / 100;

  if (!Object.keys(FLOW_KINDS).includes(v.kind)) errors.kind = 'Escoge aportación o retiro.';
  const note = String(v.note ?? '').trim();
  if (note.length > 200) errors.note = 'Máximo 200 caracteres.';

  if (Object.keys(errors).length) return { ok: false, errors, value: null };
  return {
    ok: true, errors: {},
    value: { investment_id: v.investment_id, occurred_on: v.occurred_on, amount, kind: v.kind, note: note || null },
  };
}

/** Cuánto vale hoy una plataforma. Cero es válido (Revolut: $0). */
export function validateValue(v, { accountIds, today = todayISO() } = {}) {
  const errors = {};
  if (!v.investment_id || !accountIds?.has?.(v.investment_id)) errors.investment_id = 'Escoge la plataforma.';
  checkDate(v.as_of, errors, 'as_of', today);

  const raw = String(v.value ?? '').trim();
  const n = raw === '' ? NaN : parseAmount(raw);
  let value = null;
  if (Number.isNaN(n)) errors.value = 'Escribe cuánto hay hoy (puede ser 0).';
  else if (n < 0) errors.value = 'No puede ser negativo.';
  else if (n > MAX) errors.value = 'Ese monto es demasiado grande.';
  else value = Math.round(n * 100) / 100;

  if (Object.keys(errors).length) return { ok: false, errors, value: null };
  return { ok: true, errors: {}, value: { investment_id: v.investment_id, as_of: v.as_of, value } };
}

/** Meta mensual: vacío = sin meta. */
export function validateGoal(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { ok: true, value: null };
  const n = parseAmount(s);
  if (Number.isNaN(n)) return { ok: false, error: 'Escribe un número.' };
  if (n < 0) return { ok: false, error: 'No puede ser negativa.' };
  if (n > MAX) return { ok: false, error: 'Ese monto es demasiado grande.' };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/**
 * Carga inicial (la tabla que replica el Excel): por cada plataforma, el valor
 * de hoy y cuánto has metido en total. Devuelve lo que hay que insertar.
 *
 * @param {Array<{name,type,value,contributed}>} filas  lo capturado
 * @param {{since:string, today:string}} fechas  `since` = desde cuándo empezaste
 */
export function planOnboarding(filas, { since, today = todayISO() } = {}) {
  const errors = [];
  const accounts = []; const flows = []; const values = [];
  if (!isValidISODate(since) || since > today) errors.push('Escribe una fecha de inicio válida (no futura).');

  const vistos = new Set();
  for (const f of filas) {
    const vacia = String(f.value ?? '').trim() === '' && String(f.contributed ?? '').trim() === '';
    if (vacia) continue;                       // plataforma sin datos: se omite
    const name = String(f.name ?? '').trim();
    const acc = validateAccount({ name, type: f.type }, { others: [...vistos] });
    if (!acc.ok) { errors.push(`${name || '(sin nombre)'}: ${Object.values(acc.errors)[0]}`); continue; }
    vistos.add(acc.value.name);

    const hasValue = String(f.value ?? '').trim() !== '';
    const hasContrib = String(f.contributed ?? '').trim() !== '';
    let value = null; let contributed = null;
    if (hasValue) {
      const r = validateValue({ investment_id: 'x', as_of: today, value: f.value }, { accountIds: new Set(['x']), today });
      if (!r.ok) { errors.push(`${name}: valor actual — ${r.errors.value || r.errors.as_of}`); continue; }
      value = r.value.value;
    }
    if (hasContrib) {
      const r = validateGoal(f.contributed);
      if (!r.ok || r.value === null) { errors.push(`${name}: "le metí" — ${r.error ?? 'escribe un número'}`); continue; }
      contributed = r.value;
    }
    accounts.push({ ...acc.value });
    if (contributed > 0) flows.push({ name: acc.value.name, occurred_on: since, amount: contributed, kind: 'deposit', note: 'Carga inicial' });
    if (value !== null) values.push({ name: acc.value.name, as_of: today, value });
  }
  if (!accounts.length && !errors.length) errors.push('No escribiste nada todavía.');
  return { ok: errors.length === 0, errors, accounts, flows, values };
}

// ---------------------------------------------------------------------------
// Envíos a inversión que salen en tus estados de cuenta
// ---------------------------------------------------------------------------
const slug = (s) => stripAccents(String(s ?? '')).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Movimientos que el importador reconoció como "mandé dinero a una plataforma
 * de inversión" (transfer_reason = inversion) y que todavía no tienen su
 * aportación en `investment_flows`. Es la forma de no capturar dos veces lo que
 * el banco ya te dijo.
 *
 * "Ya registrado" = hay una aportación/retiro del MISMO monto a ≤ 3 días. Es
 * uno a uno: cada flujo cubre un solo movimiento (dos envíos iguales siguen
 * siendo dos).
 *
 * @returns {Array<{tx:object, suggestedId:string|null}>} del más reciente al más viejo
 */
export function pendingInvestmentTransfers({ transactions = [], accounts = [], flows = [] } = {}) {
  const libres = flows.map((f) => ({ f, usado: false }));
  const nombres = accounts.filter((a) => !a.archived && slug(a.name).length >= 2)
    .map((a) => ({ id: a.id, key: slug(a.name) }));

  const candidatos = transactions
    .filter((t) => t.kind === 'transfer' && t.transfer_reason === 'inversion')
    .sort((a, b) => (a.occurred_on < b.occurred_on ? 1 : a.occurred_on > b.occurred_on ? -1 : 0));

  const out = [];
  for (const tx of candidatos) {
    const par = libres.find((x) => !x.usado
      && Math.abs(Number(x.f.amount) - Number(tx.amount)) < 0.005
      && Math.abs(dayDiff(x.f.occurred_on, tx.occurred_on)) <= 3);
    if (par) { par.usado = true; continue; }
    const hay = slug(tx.description);
    const m = nombres.find((n) => hay.includes(n.key));
    out.push({ tx, suggestedId: m ? m.id : null });
  }
  return out;
}
