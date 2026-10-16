// ===========================================================================
// Edición de movimientos: validación y armado del cambio.
//
// Aquí vive TODA la validación, para que el formulario de editar y el de
// captura rápida no puedan discrepar, y para poder probarla sin navegador.
// Las reglas espejan las restricciones CHECK de la base (01_schema.sql): si la
// app deja pasar algo que la base rechaza, el usuario ve un error genérico en
// vez de un mensaje claro junto al campo.
// ===========================================================================

export const KINDS = ['expense', 'income', 'transfer'];
export const KIND_LABELS = { expense: 'Gasto', income: 'Ingreso', transfer: 'Transferencia' };

const MAX_DESC = 200;
const MAX_NOTE = 500;
const MAX_AMOUNT = 999_999_999_999.99;   // numeric(14,2)

/** Categorías que tienen sentido para un tipo de movimiento. */
export function categoriesFor(kind, categoryMap) {
  const all = [...(categoryMap?.values?.() ?? categoryMap ?? [])];
  if (kind === 'transfer') return all.filter((c) => c.kind === 'both');
  return all.filter((c) => c.kind === kind || c.kind === 'both');
}

/**
 * Convierte lo que escribió el usuario en número. Acepta "1,234.50", "$1234",
 * y espacios. Rechaza lo demás (en lugar de adivinar).
 */
export function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  const s = String(raw ?? '').replace(/[\s$]/g, '').replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

/** ¿'YYYY-MM-DD' es una fecha real? (rechaza 2026-02-30). */
export function isValidISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Valida el formulario y arma el cambio para la base.
 *
 * @param {object} v   lo capturado: occurred_on, description, amount, kind,
 *                     category_id, account_id, counter_account_id, note
 * @param {object} ctx { accountMap: Map, categoryMap: Map, previous?: tx }
 * @returns {{ok:boolean, errors:Object<string,string>, patch:object|null}}
 */
export function validateTransaction(v, ctx) {
  const errors = {};
  const { accountMap, categoryMap, previous = null } = ctx;

  // --- fecha ---------------------------------------------------------------
  if (!isValidISODate(v.occurred_on)) errors.occurred_on = 'Escribe una fecha válida.';

  // --- nombre --------------------------------------------------------------
  const description = String(v.description ?? '').trim().replace(/\s+/g, ' ');
  if (!description) errors.description = 'Ponle un nombre al movimiento.';
  else if (description.length > MAX_DESC) {
    errors.description = `Máximo ${MAX_DESC} caracteres (llevas ${description.length}).`;
  }

  // --- monto ---------------------------------------------------------------
  const parsed = parseAmount(v.amount);
  let amount = null;
  if (!(parsed > 0)) errors.amount = 'El monto debe ser un número mayor a cero.';
  else if (parsed > MAX_AMOUNT) errors.amount = 'Ese monto es demasiado grande.';
  else amount = Math.round(parsed * 100) / 100;   // la base guarda 2 decimales

  // --- tipo ----------------------------------------------------------------
  if (!KINDS.includes(v.kind)) errors.kind = 'Escoge si es gasto, ingreso o transferencia.';

  // --- cuenta --------------------------------------------------------------
  if (!v.account_id || !accountMap.has(v.account_id)) errors.account_id = 'Escoge una cuenta.';

  // --- categoría: debe existir y ser compatible con el tipo -----------------
  const category_id = v.category_id || null;
  if (category_id) {
    const cat = categoryMap.get(category_id);
    if (!cat) errors.category_id = 'Esa categoría ya no existe.';
    else if (KINDS.includes(v.kind) && !categoriesFor(v.kind, categoryMap).some((c) => c.id === category_id)) {
      errors.category_id = `La categoría "${cat.name}" no sirve para un ${KIND_LABELS[v.kind].toLowerCase()}.`;
    }
  }

  // --- cuenta destino: sólo transferencias ----------------------------------
  let counter_account_id = null;
  if (v.kind === 'transfer' && v.counter_account_id) {
    if (!accountMap.has(v.counter_account_id)) errors.counter_account_id = 'Esa cuenta ya no existe.';
    else if (v.counter_account_id === v.account_id) {
      errors.counter_account_id = 'El destino no puede ser la misma cuenta de origen.';
    } else counter_account_id = v.counter_account_id;
  }

  // --- nota ----------------------------------------------------------------
  const note = String(v.note ?? '').trim();
  if (note.length > MAX_NOTE) errors.note = `Máximo ${MAX_NOTE} caracteres.`;

  if (Object.keys(errors).length) return { ok: false, errors, patch: null };

  const patch = {
    occurred_on: v.occurred_on,
    description,
    amount,
    kind: v.kind,
    account_id: v.account_id,
    category_id,
    counter_account_id,
    note: note || null,
    // Sólo cuenta como decisión del usuario si de verdad cambió la categoría.
    // Si editó otra cosa (la nota, la fecha), la categoría que puso una regla
    // se queda como "regla": marcarla "manual" la sacaría de las reglas que se
    // reaplican al historial.
    categorized_by: !category_id ? 'none'
      : (previous && previous.category_id === category_id
        ? (previous.categorized_by || 'user') : 'user'),
    // Si deja de ser transferencia, el motivo ("retiro-efectivo"...) ya no aplica.
    transfer_reason: v.kind === 'transfer' ? (previous?.transfer_reason ?? null) : null,
  };

  // Los movimientos capturados a mano llevan una huella aleatoria: son gastos
  // que SÍ pueden repetirse (dos cafés iguales). Una huella basada en el
  // contenido chocaría con la de otro movimiento o con la de uno que ya se
  // editó, y la base rechazaría el cambio con un error confuso.
  if (previous?.source === 'manual') patch.fingerprint = newManualFingerprint();
  // Los importados de un PDF conservan SU huella original a propósito: así,
  // aunque cambies su nombre o fecha, al volver a subir ese estado de cuenta se
  // sigue reconociendo como ya registrado.

  return { ok: true, errors: {}, patch };
}

/** Huella para un movimiento capturado a mano (única, sin depender del contenido). */
export function newManualFingerprint() {
  const id = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `manual|${id}`;
}

/** Sólo los campos que de verdad cambiaron: evita escrituras inútiles. */
export function changedFields(previous, patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    const before = previous?.[k] ?? null;
    const after = v ?? null;
    const same = k === 'amount' ? Number(before) === Number(after) : before === after;
    if (!same) out[k] = v;
  }
  return out;
}
