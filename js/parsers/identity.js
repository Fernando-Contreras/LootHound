// ===========================================================================
// Reconocer movimientos entre cuentas propias.
//
// El problema que resuelve:
//   BBVA débito:   "SPEI ENVIADO Mercado Pago ... Juan Fernando Salinas"  -4,000
//   Mercado Pago:  "Transferencia recibida JUAN FERNANDO SALINAS"         +4,000
//
// Es UN solo movimiento de dinero entre dos bolsillos del mismo dueño. Si se
// cuenta como egreso en un lado e ingreso en el otro, el mes reporta $4,000 de
// ingreso que nunca existieron y $4,000 de gasto que tampoco.
//
// Cómo se detecta, en orden de confianza:
//   1. La contraparte se llama igual que el titular  → es tuyo, seguro.
//   2. La descripción nombra a otro banco tuyo ("Mercado Pago", "Nu")  → tuyo.
//   3. Conceptos que por definición son internos: pago de tarjeta propia,
//      retiro de efectivo, movimientos de Cajita.
// ===========================================================================

import { normalizeDescription } from './common.js';

/**
 * ¿El texto menciona al titular de la cuenta?
 * Compara por apellidos + nombre en cualquier orden, sin acentos, porque cada
 * banco escribe el nombre distinto:
 *   "JUAN FERNANDO SALINAS CONTRERAS"  /  "Juan Fernando Salinas Contreras"
 *   "JuanFer Nu"  ← este NO se detecta por nombre; cae por la regla 2.
 *
 * @param {string} text
 * @param {string[]} holderNames  nombres del titular (y alias)
 */
export function mentionsHolder(text, holderNames = []) {
  if (!holderNames.length) return false;
  const hay = normalizeDescription(text);
  if (!hay) return false;

  for (const name of holderNames) {
    const parts = normalizeDescription(name).split(' ').filter((w) => w.length > 2);
    if (parts.length < 2) continue;
    // Pedimos al menos dos palabras del nombre para no confundirnos con un
    // comercio que por casualidad se llame igual que tu apellido.
    const hits = parts.filter((p) => hay.includes(p)).length;
    if (hits >= Math.min(2, parts.length)) return true;
  }
  return false;
}

/** Bancos/monederos propios que suelen aparecer citados en la descripción. */
const OWN_WALLET_HINTS = [
  /mercado\s*pago/i,
  /\bmercadopago\b/i,
  /\bnu\b/i,
  /\bnubank\b/i,
  /\bbbva\b/i,
];

export function mentionsOwnWallet(text, extraHints = []) {
  return [...OWN_WALLET_HINTS, ...extraHints].some((rx) => rx.test(text));
}

/** Conceptos que son internos por definición, sin importar la contraparte. */
export const INTERNAL_CONCEPTS = {
  // pagar tu propia tarjeta de crédito
  cardPayment: /pago\s+(de\s+)?tarjeta\s+de\s+cr[eé]dito|pago\s+tdc|bmovil\.pago\s+tdc/i,
  // sacar efectivo: el dinero no se gastó, cambió de bolsillo
  cashWithdrawal: /retiro\s+sin\s+tarjeta|retiro\s+en\s+cajero|disposici[oó]n\s+de\s+efectivo|retiro\s+de\s+efectivo|cajero\s+autom/i,
  // apartados / cajitas: el dinero ni siquiera sale de la cuenta
  pocket: /(dep[oó]sito\s+en|retiro\s+de)\s+cajita|apartado/i,
};

/**
 * Decide el tipo de un movimiento considerando si es interno.
 *
 * @param {object} args
 * @param {string} args.description   descripción completa (incluye contraparte)
 * @param {'in'|'out'} args.direction  entró o salió dinero de la cuenta
 * @param {string[]} args.holderNames
 * @param {boolean} args.depositsAreTransfers  para cuentas donde nunca cae
 *        dinero de terceros (ej. Nu: todo lo que entra lo mandas tú)
 * @returns {{kind:string, reason:string|null, internal:boolean}}
 */
export function classifyMovement({
  description,
  direction,
  holderNames = [],
  depositsAreTransfers = false,
}) {
  const text = String(description || '');

  if (INTERNAL_CONCEPTS.pocket.test(text)) {
    return { kind: 'transfer', reason: 'cajita', internal: true };
  }
  if (INTERNAL_CONCEPTS.cashWithdrawal.test(text)) {
    return { kind: 'transfer', reason: 'retiro-efectivo', internal: true };
  }
  if (INTERNAL_CONCEPTS.cardPayment.test(text)) {
    return { kind: 'transfer', reason: 'pago-tarjeta', internal: true };
  }
  if (mentionsHolder(text, holderNames)) {
    return { kind: 'transfer', reason: 'mismo-titular', internal: true };
  }
  if (/transferencia|spei|env[ií]o de dinero/i.test(text) && mentionsOwnWallet(text)) {
    return { kind: 'transfer', reason: 'cuenta-propia', internal: true };
  }
  if (direction === 'in' && depositsAreTransfers) {
    return { kind: 'transfer', reason: 'deposito-propio', internal: true };
  }

  return {
    kind: direction === 'in' ? 'income' : 'expense',
    reason: null,
    internal: false,
  };
}

/** Etiqueta legible para el preview. */
export const REASON_LABELS = {
  'cajita': 'Cajita (no sale de la cuenta)',
  'retiro-efectivo': 'Retiro de efectivo',
  'pago-tarjeta': 'Pago de tu tarjeta',
  'mismo-titular': 'Mismo titular',
  'cuenta-propia': 'Entre tus cuentas',
  'deposito-propio': 'Depósito hecho por ti',
};
