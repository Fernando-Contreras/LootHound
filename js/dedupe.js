// ===========================================================================
// Detección de duplicados.
//
// Dos capas, a propósito:
//
//  1) HUELLA EXACTA (`fingerprint`) — garantía dura.
//     Es determinista y va con UNIQUE(user_id, fingerprint) en la base. Si
//     vuelves a subir el mismo estado de cuenta, Postgres rechaza los repetidos
//     aunque la app tuviera un bug.
//
//     La huella incluye un ÍNDICE DE REPETICIÓN: si un mismo estado de cuenta
//     trae dos renglones idénticos (dos cafés iguales el mismo día — pasa), el
//     primero lleva #0 y el segundo #1, así que ambos entran. Al reimportar,
//     se vuelven a calcular #0 y #1 y ambos chocan. Sin ese índice tendríamos
//     que elegir entre perder movimientos reales o permitir reimportar.
//
//  2) PARECIDO (fuzzy) — aviso suave en el preview.
//     Mismo monto, fecha cercana y descripción parecida. Sirve cuando dos
//     estados de cuenta se traslapan y el banco escribió el comercio distinto
//     entre una versión y otra. No bloquea: sólo avisa.
// ===========================================================================

import { normalizeDescription } from './parsers/common.js';

/** Descripción recortada y normalizada, para que la huella sea estable. */
function fingerprintDesc(description) {
  return normalizeDescription(description).slice(0, 60);
}

/**
 * Huella determinista de un movimiento.
 * @param {{account_id:string, occurred_on:string, amount:number, kind:string, description:string}} tx
 * @param {number} occurrence  0 para el primero, 1 para un idéntico posterior...
 */
export function fingerprint(tx, occurrence = 0) {
  return [
    tx.account_id,
    tx.occurred_on,
    Number(tx.amount).toFixed(2),
    tx.kind,
    fingerprintDesc(tx.description),
    occurrence,
  ].join('|');
}

/** Clave sin el índice de repetición: identifica "movimientos idénticos". */
function identityKey(tx) {
  return [
    tx.account_id,
    tx.occurred_on,
    Number(tx.amount).toFixed(2),
    tx.kind,
    fingerprintDesc(tx.description),
  ].join('|');
}

/**
 * Asigna huellas a un lote recién parseado, contando repeticiones dentro del
 * lote Y considerando lo que ya existe en la base.
 *
 * @param {Array} incoming  movimientos del PDF, ya con account_id asignado
 * @param {Array} existing  movimientos que ya están guardados (los del usuario)
 * @returns {Array} el mismo arreglo, con `fingerprint` y `duplicate` puestos
 */
export function assignFingerprints(incoming, existing = []) {
  // cuántos idénticos ya hay guardados
  const existingCounts = new Map();
  const existingPrints = new Set();
  for (const tx of existing) {
    const k = identityKey(tx);
    existingCounts.set(k, (existingCounts.get(k) || 0) + 1);
    if (tx.fingerprint) existingPrints.add(tx.fingerprint);
  }

  const seenInBatch = new Map();
  for (const tx of incoming) {
    const k = identityKey(tx);
    const n = seenInBatch.get(k) || 0;
    seenInBatch.set(k, n + 1);

    tx.fingerprint = fingerprint(tx, n);
    // Es duplicado si esa huella exacta ya está guardada.
    tx.duplicate = existingPrints.has(tx.fingerprint);
    tx.duplicateReason = tx.duplicate ? 'exacto' : null;
  }
  return incoming;
}

// ---------------------------------------------------------------------------
// Parecido
// ---------------------------------------------------------------------------

/** Coeficiente de Dice sobre bigramas: 1 = idénticas, 0 = nada que ver. */
export function similarity(a, b) {
  const A = normalizeDescription(a);
  const B = normalizeDescription(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length < 2 || B.length < 2) return A === B ? 1 : 0;

  const bigrams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ma = bigrams(A);
  const mb = bigrams(B);
  let hits = 0;
  for (const [g, count] of ma) {
    const other = mb.get(g);
    if (other) hits += Math.min(count, other);
  }
  return (2 * hits) / ((A.length - 1) + (B.length - 1));
}

/**
 * Marca movimientos que se PARECEN a algo ya guardado, sin ser idénticos.
 * Criterio: mismo monto exacto, fecha dentro de ±`dayWindow`, y descripción
 * con parecido ≥ `threshold`.
 *
 * @returns {Array} el mismo arreglo, con `similarTo` puesto donde aplique
 */
export function flagSimilar(incoming, existing = [], { dayWindow = 3, threshold = 0.6 } = {}) {
  // index por monto para no comparar todo contra todo
  const byAmount = new Map();
  for (const tx of existing) {
    const k = Number(tx.amount).toFixed(2);
    if (!byAmount.has(k)) byAmount.set(k, []);
    byAmount.get(k).push(tx);
  }

  for (const tx of incoming) {
    if (tx.duplicate) continue; // ya está marcado como exacto
    const candidates = byAmount.get(Number(tx.amount).toFixed(2)) || [];
    let best = null;
    for (const other of candidates) {
      if (other.account_id !== tx.account_id) continue;
      if (Math.abs(daysApart(tx.occurred_on, other.occurred_on)) > dayWindow) continue;
      const score = similarity(tx.description, other.description);
      if (score >= threshold && (!best || score > best.score)) {
        best = { score, tx: other };
      }
    }
    if (best) {
      tx.similarTo = {
        description: best.tx.description,
        occurred_on: best.tx.occurred_on,
        score: Math.round(best.score * 100),
      };
      tx.duplicateReason = 'parecido';
    }
  }
  return incoming;
}

function daysApart(a, b) {
  const t1 = Date.parse(`${a}T00:00:00Z`);
  const t2 = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return Infinity;
  return (t1 - t2) / 86400000;
}

/** Resumen para el preview. */
export function dedupeSummary(incoming) {
  return {
    total: incoming.length,
    exact: incoming.filter((t) => t.duplicateReason === 'exacto').length,
    similar: incoming.filter((t) => t.duplicateReason === 'parecido').length,
    fresh: incoming.filter((t) => !t.duplicateReason).length,
  };
}
