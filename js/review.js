// ===========================================================================
// Autocuidado de los datos: que la app detecte sola lo que huele mal, en vez de
// depender de que alguien lo note en una pantalla de importación.
//
// Dos cosas, las dos puras (sin red ni DOM, para poder probarlas):
//
//   healPlan     errores OBVIOS y sin riesgo que se corrigen en silencio:
//                un ingreso con categoría de traspaso o "Sin categoría".
//                Sólo toca la categoría, nunca el monto ni el tipo, y jamás
//                algo que el usuario categorizó a mano.
//
//   reviewItems  lo DUDOSO, que sólo el usuario puede decidir: dinero que entró
//                y que la app no sabe si es un ingreso de verdad o un movimiento
//                entre sus propias cuentas. Se muestra con dos botones. Lo que
//                decida queda guardado (`categorized_by = 'user'`) y no vuelve
//                a preguntar.
//
// Por qué existe: Mercado Pago llamó "Monto retirado Lap" a sacar dinero de un
// fondo propio, la app no lo conocía, y $25,000 salieron como ingreso. Ningún
// parser puede conocer todas las frases de todos los bancos; lo que sí se puede
// es no dejar pasar en silencio un ingreso grande que no se reconoce.
// ===========================================================================

import { builtinIncomeCategory } from './categorize.js';
import { dayDiff } from './finance.js';

/** Desde cuánto un ingreso "desconocido" merece que alguien lo confirme. */
export const BIG_INCOME = 1000;

/** Categorías de ingreso que se explican solas: no se pregunta por ellas. */
const TRUSTED = new Set(['Sueldo', 'Rendimientos']);

const cents = (n) => Math.round(Number(n) * 100);

/**
 * ¿Un ingreso así merece confirmación? Misma regla para la pantalla de
 * importar (donde sale como "revisar") y para el Resumen.
 * @returns {string|null} el motivo, o null si no hace falta preguntar
 */
export function unknownIncomeNote(tx) {
  if (tx.kind !== 'income' || Number(tx.amount) < BIG_INCOME) return null;
  if (TRUSTED.has(builtinIncomeCategory(tx))) return null;
  return 'Entró dinero que no reconozco como sueldo ni rendimientos. ' +
    'Si es dinero tuyo que sólo cambió de lugar, márcalo como traspaso.';
}

/**
 * Ingresos grandes que hay que confirmar. Ordenados del más reciente al más viejo.
 *
 * @returns {Array<{tx:object, reason:'pareja'|'desconocido', pair:object|null}>}
 *   `pair` = el movimiento de otra cuenta, del mismo monto, que parece ser la
 *   otra mitad (dinero que sólo cambió de cuenta).
 */
export function reviewItems({ transactions = [], categoryMap = new Map() } = {}) {
  // movimientos que NO son ingreso, indexados por monto: candidatos a "otra mitad"
  const salidas = new Map();
  for (const t of transactions) {
    if (t.kind === 'income') continue;
    const k = cents(t.amount);
    if (!salidas.has(k)) salidas.set(k, []);
    salidas.get(k).push(t);
  }

  const out = [];
  for (const tx of transactions) {
    if (tx.kind !== 'income' || Number(tx.amount) < BIG_INCOME) continue;
    if (tx.categorized_by === 'user') continue;                  // ya lo confirmó
    const nombre = categoryMap.get(tx.category_id)?.name;
    if (TRUSTED.has(nombre) || TRUSTED.has(builtinIncomeCategory(tx))) continue;

    const pair = (salidas.get(cents(tx.amount)) ?? []).find((o) =>
      o.account_id !== tx.account_id && Math.abs(dayDiff(o.occurred_on, tx.occurred_on)) <= 3) ?? null;
    out.push({ tx, reason: pair ? 'pareja' : 'desconocido', pair });
  }
  return out.sort((a, b) => (a.tx.occurred_on < b.tx.occurred_on ? 1 : a.tx.occurred_on > b.tx.occurred_on ? -1 : 0));
}

/**
 * Ingresos con una categoría que no puede ser la correcta. Devuelve lo que hay
 * que cambiar; no escribe nada.
 */
export function healPlan({ transactions = [], categoryMap = new Map(), categoryByName = new Map() } = {}) {
  const cambios = [];
  for (const t of transactions) {
    if (t.kind !== 'income' || t.categorized_by === 'user') continue;
    const cat = categoryMap.get(t.category_id);
    const mala = !cat || cat.name === 'Sin categoría' || cat.name === 'Transferencia' || cat.kind === 'expense';
    if (!mala) continue;
    const destino = categoryByName.get(builtinIncomeCategory(t) ?? 'Otros ingresos');
    if (!destino || destino.id === t.category_id) continue;
    cambios.push({ id: t.id, category_id: destino.id, from: cat?.name ?? null, to: destino.name });
  }
  return cambios;
}

/** Lo que se guarda cuando el usuario dice "sí, es un ingreso". */
export function confirmIncomePatch(tx, { categoryMap, categoryByName }) {
  const cat = categoryMap.get(tx.category_id);
  const sirve = cat && cat.kind !== 'expense' && cat.name !== 'Transferencia' && cat.name !== 'Sin categoría';
  const category_id = sirve ? tx.category_id : (categoryByName.get('Otros ingresos')?.id ?? tx.category_id);
  return { category_id, categorized_by: 'user' };
}

/** Lo que se guarda cuando dice "es mío, sólo cambió de cuenta". */
export function markTransferPatch({ categoryByName }) {
  return {
    kind: 'transfer',
    transfer_reason: 'cuenta-propia',
    category_id: categoryByName.get('Transferencia')?.id ?? null,
    categorized_by: 'user',
  };
}
