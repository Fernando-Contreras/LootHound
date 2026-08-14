// ===========================================================================
// Motor de categorización por reglas.
// Reglas simples y editables: palabra clave → categoría.
// Se aplican al importar y también al capturar un gasto manual.
// ===========================================================================

import { normalizeDescription } from './parsers/common.js';

/**
 * Escoge la categoría para un movimiento.
 * Gana la regla de menor `priority`; a igual prioridad, gana el patrón más
 * largo (más específico): "UBER EATS" le gana a "UBER".
 *
 * @param {{description:string, account_id?:string}} tx
 * @param {Array} rules  reglas del usuario
 * @returns {{category_id:string, rule_id:string}|null}
 */
export function matchRule(tx, rules) {
  const haystack = normalizeDescription(tx.description);
  let best = null;

  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (rule.account_id && rule.account_id !== tx.account_id) continue;
    if (!testRule(rule, haystack, tx.description)) continue;

    const score = {
      priority: rule.priority ?? 100,
      length: String(rule.pattern).length,
      // una regla atada a una cuenta específica es más específica
      scoped: rule.account_id ? 1 : 0,
    };
    if (!best || better(score, best.score)) best = { rule, score };
  }

  return best ? { category_id: best.rule.category_id, rule_id: best.rule.id } : null;
}

function better(a, b) {
  if (a.priority !== b.priority) return a.priority < b.priority;
  if (a.scoped !== b.scoped) return a.scoped > b.scoped;
  return a.length > b.length;
}

function testRule(rule, normalizedHaystack, rawDescription) {
  const pattern = String(rule.pattern || '').trim();
  if (!pattern) return false;

  switch (rule.match_type) {
    case 'regex':
      try {
        return new RegExp(pattern, 'i').test(rawDescription);
      } catch {
        return false; // regex inválida escrita por el usuario: se ignora
      }
    case 'starts_with':
      return normalizedHaystack.startsWith(normalizeDescription(pattern));
    case 'contains':
    default:
      return normalizedHaystack.includes(normalizeDescription(pattern));
  }
}

/**
 * Aplica las reglas a un lote. Marca `categorized_by` para distinguir lo que
 * puso una regla de lo que escogió el usuario a mano.
 */
export function applyRules(txs, rules, { fallbackCategoryId = null } = {}) {
  for (const tx of txs) {
    if (tx.categorized_by === 'user') continue; // no pisar una decisión manual
    const hit = matchRule(tx, rules);
    if (hit) {
      tx.category_id = hit.category_id;
      tx.matched_rule_id = hit.rule_id;
      tx.categorized_by = 'rule';
    } else {
      tx.category_id = fallbackCategoryId;
      tx.categorized_by = 'none';
    }
  }
  return txs;
}

/**
 * Cuando el usuario corrige una categoría, propone una regla nueva.
 * Toma la parte estable del nombre del comercio: quita prefijos de agregador
 * ("SQ *", "TST*", "CLIP MX*", "MERPAGO*") y números de sucursal.
 *
 * @returns {{pattern:string, match_type:string}|null}
 */
export function suggestRule(description) {
  let s = normalizeDescription(description);

  // prefijos de procesador de pago que no dicen nada del comercio
  s = s.replace(/^(SQ|TST|CLIP MX|MERPAGO|MERCADOPAGO|SP|PAYPAL|DLO)\s+/, '');

  // números de sucursal al final: "OXXO COXUMEL 65", "MCDONALD S F36212"
  s = s.replace(/\s+[A-Z]?\d{2,}$/, '').trim();

  // nos quedamos con las primeras dos palabras significativas
  const words = s.split(' ').filter((w) => w.length > 1);
  if (!words.length) return null;
  const pattern = words.slice(0, 2).join(' ');
  if (pattern.length < 3) return null;

  return { pattern, match_type: 'contains' };
}

/** ¿Ya existe una regla equivalente? Evita proponer duplicados. */
export function ruleExists(rules, pattern, matchType = 'contains', accountId = null) {
  const p = normalizeDescription(pattern);
  return rules.some((r) =>
    normalizeDescription(r.pattern) === p &&
    r.match_type === matchType &&
    (r.account_id || null) === (accountId || null));
}

/** Cuántos movimientos afectaría una regla — para previsualizarla. */
export function previewRule(rule, txs) {
  return txs.filter((tx) => testRule(rule, normalizeDescription(tx.description), tx.description));
}

/**
 * Recalcula la categoría de movimientos YA GUARDADOS con el juego de reglas
 * actual, y devuelve sólo los que cambiarían.
 *
 * Una regla nueva no sirve de nada si sólo aplica a lo que importes después:
 * lo normal es darse cuenta de que falta una regla justo al ver el historial.
 *
 * Qué NO se toca:
 *   - lo que categorizaste a mano (`categorized_by === 'user'`): tu decisión
 *     gana siempre sobre una regla
 *   - lo que ya está en la categoría correcta
 *
 * @param {Array} txs      movimientos guardados
 * @param {Array} rules    reglas del usuario
 * @param {object} options
 * @param {boolean} options.includeUserSet  forzar también sobre lo manual
 * @param {string|null} options.fallbackCategoryId
 * @returns {Array<{id, category_id, description, from, to}>}
 */
export function recategorizePlan(txs, rules, {
  includeUserSet = false,
  fallbackCategoryId = null,
} = {}) {
  const cambios = [];
  for (const tx of txs) {
    if (!includeUserSet && tx.categorized_by === 'user') continue;

    const hit = matchRule(tx, rules);
    const nueva = hit ? hit.category_id : (tx.category_id ?? fallbackCategoryId);

    // Sin regla que aplique, no se despoja de la categoría que ya tenía:
    // borrar trabajo previo sería peor que no hacer nada.
    if (!hit) continue;
    if (nueva === tx.category_id) continue;

    cambios.push({
      id: tx.id,
      category_id: nueva,
      description: tx.description,
      from: tx.category_id ?? null,
      to: nueva,
    });
  }
  return cambios;
}
