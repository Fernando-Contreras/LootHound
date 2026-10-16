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
//  1b) COINCIDENCIA FLOJA 1 a 1 — también cuenta como "ya registrado".
//     La huella exacta incluye el TIPO (gasto/transferencia) y el texto de la
//     descripción, y ambos pueden cambiar entre una importación y otra:
//       - corriges el tipo en el preview ("esto sí fue gasto"), o
//       - se mejora el parser y limpia un pedazo de texto.
//     Sin esta capa, el mismo movimiento reimportado tendría otra huella y
//     entraría duplicado si alguien usa "Marcar todo". Así que además se busca,
//     entre lo ya guardado, un movimiento de la MISMA cuenta, MISMA fecha y
//     MISMO monto con descripción casi idéntica. Es 1 a 1: cada movimiento
//     guardado sólo puede "cubrir" a uno nuevo, así que dos cafés idénticos
//     siguen siendo dos.
//
//  2) PARECIDO (fuzzy) — aviso suave en el preview.
//     Mismo monto, fecha cercana y descripción parecida. Sirve cuando dos
//     estados de cuenta se traslapan y el banco escribió el comercio distinto
//     entre una versión y otra. No bloquea: sólo avisa.
// ===========================================================================

import { normalizeDescription } from './parsers/common.js';

/**
 * BBVA débito dejaba pegada al inicio de la descripción la fecha de
 * liquidación ("14/SEP SPEI ENVIADO..."). Ya no se guarda así, pero los
 * movimientos importados antes sí la traen: para compararlos se quita siempre.
 */
const LEADING_DATE = /^\s*\d{1,2}\/[A-Za-zÁÉÍÓÚáéíóú]{3}\b\s*/;

/** Descripción lista para COMPARAR (no para mostrar). */
export function cleanDesc(description) {
  return String(description ?? '').replace(LEADING_DATE, '');
}

/** Descripción recortada y normalizada, para que la huella sea estable. */
function fingerprintDesc(description) {
  return normalizeDescription(cleanDesc(description)).slice(0, 60);
}

/** Umbral para dar por "la misma" una descripción en la coincidencia floja. */
const SAME_DESC = 0.9;

const looseKey = (tx) =>
  `${tx.account_id}|${tx.occurred_on}|${Number(tx.amount).toFixed(2)}`;

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
  const existingPrints = new Set();
  for (const tx of existing) {
    if (tx.fingerprint) existingPrints.add(tx.fingerprint);
  }

  // El índice de repetición se cuenta SOBRE EL ARCHIVO, no sobre lo que ya
  // está guardado. Es lo que hace que funcionen los traslapes:
  //
  //   estado de cuenta A (jul):  CAFE#0, CAFE#1        → se guardan los dos
  //   estado de cuenta B (jul-ago, traslapado): mismos CAFE#0 y CAFE#1
  //     → las huellas coinciden con las guardadas → se marcan duplicados
  //
  // Si el índice dependiera de lo guardado, en B serían CAFE#2 y CAFE#3 y
  // entrarían otra vez, duplicando el gasto.
  // Lo guardado, agrupado por cuenta+fecha+monto, para la coincidencia 1 a 1.
  const pool = new Map();
  for (const e of existing) {
    const k = looseKey(e);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push({ tx: e, used: false });
  }

  const seenInBatch = new Map();
  for (const tx of incoming) {
    const k = identityKey(tx);
    const n = seenInBatch.get(k) || 0;
    seenInBatch.set(k, n + 1);

    tx.fingerprint = fingerprint(tx, n);
    tx.duplicate = false;
    tx.duplicateReason = null;

    // (1) huella exacta ya guardada. Se "gasta" también la entrada del pool
    // para que otro movimiento nuevo no la use por segunda vez.
    if (existingPrints.has(tx.fingerprint)) {
      tx.duplicate = true;
      tx.duplicateReason = 'exacto';
      const slot = (pool.get(looseKey(tx)) || [])
        .find((s) => !s.used && s.tx.fingerprint === tx.fingerprint);
      if (slot) slot.used = true;
      continue;
    }

    // (1b) coincidencia floja 1 a 1: misma cuenta/fecha/monto y descripción
    // casi idéntica, sin importar el tipo ni la huella guardada.
    const candidates = (pool.get(looseKey(tx)) || []).filter((s) => !s.used);
    let best = null;
    for (const slot of candidates) {
      const score = similarity(tx.description, slot.tx.description);
      if (score >= SAME_DESC && (!best || score > best.score)) best = { slot, score };
    }
    if (best) {
      best.slot.used = true;
      tx.duplicate = true;
      tx.duplicateReason = 'exacto';
    }
  }
  return incoming;
}

// ---------------------------------------------------------------------------
// Parecido
// ---------------------------------------------------------------------------

/** Coeficiente de Dice sobre bigramas: 1 = idénticas, 0 = nada que ver. */
export function similarity(a, b) {
  const A = normalizeDescription(cleanDesc(a));
  const B = normalizeDescription(cleanDesc(b));
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

/**
 * Confirma traspasos "por revisar" buscando su pareja en OTRA de tus cuentas.
 *
 * Un traspaso entre tus cuentas aparece dos veces: sale de una y entra a otra,
 * con el mismo monto y casi la misma fecha. Si lo que se marcó para revisar
 * (porque el banco no imprimió tu nombre) tiene su pareja ya registrada como
 * transferencia en otra cuenta, deja de ser una duda.
 *
 * @returns {Array} el mismo arreglo; a los confirmados se les quita
 *          `needs_review` y se les pone `confirmedBy` con la pareja encontrada.
 */
export function confirmTransferPairs(incoming, existing = [], { dayWindow = 3 } = {}) {
  for (const tx of incoming) {
    if (!tx.needs_review || tx.kind !== 'transfer') continue;
    const pareja = existing.find((e) =>
      e.account_id !== tx.account_id &&
      e.kind === 'transfer' &&
      Number(e.amount).toFixed(2) === Number(tx.amount).toFixed(2) &&
      Math.abs(daysApart(tx.occurred_on, e.occurred_on)) <= dayWindow);
    if (pareja) {
      tx.needs_review = false;
      tx.confirmedBy = { description: pareja.description, occurred_on: pareja.occurred_on };
    }
  }
  return incoming;
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
