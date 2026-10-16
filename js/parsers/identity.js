// ===========================================================================
// Reconocer movimientos entre cuentas propias.
//
// El problema que resuelve:
//   BBVA débito:   "SPEI ENVIADO Mercado Pago ... Mario Alberto Reyes"  -4,000
//   Mercado Pago:  "Transferencia recibida MARIO ALBERTO REYES"         +4,000
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

const STOPWORDS = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y', 'E']);

/**
 * ¿El texto menciona al titular de la cuenta?
 * Compara por apellidos + nombre en cualquier orden, sin acentos, porque cada
 * banco escribe el nombre distinto:
 *   "MARIO ALBERTO REYES DUARTE"  /  "Mario Alberto Reyes Duarte"
 *   "JuanFer Nu"  ← este NO se detecta por nombre; cae por la regla 2.
 *
 * @param {string} text
 * @param {string[]} holderNames  nombres del titular (y alias)
 */
export function mentionsHolder(text, holderNames = []) {
  if (!holderNames.length) return false;
  const hay = normalizeDescription(text);
  if (!hay) return false;
  const tokens = hay.split(' ');

  for (const name of holderNames) {
    // Palabras de relleno fuera ("de la"), pero se conservan las cortas con
    // sentido: el apodo "JuanFer Nu" tiene que poder registrarse.
    const parts = normalizeDescription(name).split(' ')
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
    // Un nombre demasiado corto ("Nu", "Ana") coincidiría con cualquier cosa.
    if (!parts.length || parts.join('').length < 6) continue;

    // Se exigen TODAS las palabras de tu nombre, enteras. Antes bastaban dos:
    // un hermano o primo con tus mismos apellidos ("CARLOS REYES DUARTE")
    // contaba como tú, y lo que te mandaba o le mandabas desaparecía de ingresos
    // y gastos como si fuera un traspaso entre tus cuentas.
    //
    // Excepción: el banco a veces corta el último renglón ("...REYES DUAR"),
    // así que la última palabra puede venir truncada (3 letras o más).
    const last = parts.length - 1;
    const todas = parts.every((p, i) =>
      tokens.includes(p) ||
      (i === last && tokens.some((t) => t.length >= 3 && t.length < p.length && p.startsWith(t))));
    if (todas) return true;
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
  // mandar dinero a (o recibirlo de) una plataforma de inversión: sigue siendo
  // tuyo, sólo cambió de lugar. Contarlo como gasto inflaría el mes por lo que
  // en realidad ahorraste.
  investment: /\b(gbm|etoro|bitso|binance|kuspit|cetesdirecto|flink|finsus|actinver|bursanet|interactive\s+brokers|tastytrade|robinhood|coinbase)\b/i,
};

/** Abonos que pone el propio banco: no los mandó ninguna de tus cuentas. */
const BANK_CREDIT = /compensaci[oó]n|bonificaci[oó]n|reembolso|devoluci[oó]n|cashback/i;

/**
 * Decide el tipo de un movimiento considerando si es interno.
 *
 * @param {object} args
 * @param {string} args.description   descripción completa (incluye contraparte)
 * @param {'in'|'out'} args.direction  entró o salió dinero de la cuenta
 * @param {string[]} args.holderNames
 * @param {boolean} args.depositsAreTransfers  para cuentas donde nunca cae
 *        dinero de terceros (ej. Nu: todo lo que entra lo mandas tú)
 * @param {string|null} args.counterparty  nombre de la contraparte, si el
 *        banco lo imprime aparte (BBVA débito lo pone en un renglón propio).
 *        Si viene y NO es tuyo, es una tercera persona: mencionar "Nubank" o
 *        "Mercado Pago" ya no basta para tratarlo como traspaso propio.
 * @returns {{kind:string, reason:string|null, internal:boolean, review?:boolean}}
 *        `review` = se decidió sólo por mencionar tu otra cartera, sin tu
 *        nombre: probablemente es tuyo, pero conviene confirmarlo.
 */
export function classifyMovement({
  description,
  direction,
  holderNames = [],
  depositsAreTransfers = false,
  counterparty = null,
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
  // Sólo si es un movimiento de dinero (SPEI/transferencia/depósito/pago), no
  // una compra con tarjeta en una tienda que se llame parecido.
  if (INTERNAL_CONCEPTS.investment.test(text) &&
      /transferencia|spei|dep[oó]sito|pago|env[ií]o/i.test(text)) {
    return { kind: 'transfer', reason: 'inversion', internal: true };
  }
  // Mencionar tu otra cartera ("Mercado Pago", "Nu") sin tu nombre: se trata
  // como traspaso propio pero marcado para revisar, porque el nombre del BANCO
  // no dice de quién es la cuenta (un amigo también puede mandarte desde Nu).
  // Si el banco imprimió el nombre de la contraparte y no es el tuyo, es una
  // tercera persona y esta regla no aplica.
  const contraparteAjena = counterparty && !mentionsHolder(counterparty, holderNames);
  if (!contraparteAjena &&
      /transferencia|spei|env[ií]o de dinero/i.test(text) && mentionsOwnWallet(text)) {
    return { kind: 'transfer', reason: 'cuenta-propia', internal: true, review: true };
  }
  // Dinero que te pone el propio banco (compensación por un SPEI retrasado,
  // bonificación, reembolso, cashback) es ingreso aunque la cuenta sea de las
  // que sólo reciben depósitos tuyos.
  if (direction === 'in' && BANK_CREDIT.test(text)) {
    return { kind: 'income', reason: null, internal: false };
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
  'inversion': 'A inversión',
};
