// ===========================================================================
// Pruebas sin navegador:  node tests/run.mjs
//
// Cubren la lógica pura (parsers, cálculos, duplicados, reglas). No tocan
// Supabase ni el DOM. Los fixtures son sintéticos: este repo es público.
// ===========================================================================

import * as bbva from '../js/parsers/bbva.js';
import * as nu from '../js/parsers/nu.js';
import * as fin from '../js/finance.js';
import * as dedupe from '../js/dedupe.js';
import * as cat from '../js/categorize.js';

import * as fxBbva from './fixtures/bbva-sintetico.js';
import * as fxNu from './fixtures/nu-sintetico.js';

let pass = 0, fail = 0;
const groups = [];

function group(name, fn) { groups.push([name, fn]); }
function eq(label, got, want) {
  const ok = typeof want === 'number' && typeof got === 'number'
    ? Math.abs(got - want) < 0.005
    : JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`    ok    ${label}`); }
  else { fail++; console.log(`    FAIL  ${label}\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`); }
}
const totalOf = (txs, kind) =>
  Math.round(txs.filter(t => t.kind === kind).reduce((a, t) => a + t.amount, 0) * 100) / 100;

// ---------------------------------------------------------------- parser BBVA
group('parser BBVA', () => {
  const r = bbva.parse(fxBbva.lines);
  const e = fxBbva.expected;

  eq('detecta el banco', bbva.detect(fxBbva.lines), true);
  eq('número de movimientos', r.transactions.length, e.count);
  eq('periodo', r.period, e.period);
  eq('total cargos', totalOf(r.transactions, 'expense'), e.expense);
  eq('total abonos (devolución)', totalOf(r.transactions, 'income'), e.income);
  eq('pago de tarjeta = transfer', totalOf(r.transactions, 'transfer'), e.transfer);
  eq('cuadra contra los totales del PDF', r.check.ok, true);
  eq('sin advertencias', r.warnings, []);

  // la sección de meses sin intereses no debe colarse
  eq('no importa el renglón de MSI',
    r.transactions.some(t => t.raw_line.includes('$900.00')), false);

  // el tipo de cambio que quedó en la página siguiente
  const extranjero = r.transactions.find(t => t.description === 'OTRO EXTRANJERO');
  eq('tipo de cambio cruzando página', extranjero.fx_rate, 17.50);
  eq('monto original cruzando página', extranjero.original_amount, 20.00);

  // "; Tarjeta Digital ***0000" se separa de la descripción
  const digital = r.transactions.find(t => t.description === 'SERVICIO MENSUAL');
  eq('descripción sin el sufijo de tarjeta digital', digital.description, 'SERVICIO MENSUAL');
  eq('guarda los últimos 4 de la tarjeta', digital.card_last4, '0000');

  // dos fechas por renglón
  const tienda = r.transactions.find(t => t.description === 'TIENDA DE BARRIO 12');
  eq('fecha de operación', tienda.occurred_on, '2026-07-14');
  eq('fecha de cargo', tienda.posted_on, '2026-07-15');

  // el detalle "IVA :$ 0.00 ..." no es un movimiento
  eq('ignora el detalle del pago',
    r.transactions.some(t => t.raw_line.startsWith('IVA')), false);
});

// ------------------------------------------------------------------ parser Nu
group('parser Nu', () => {
  const r = nu.parse(fxNu.lines);
  const e = fxNu.expected;
  const reales = r.transactions.filter(t => !t.optional);

  eq('detecta el banco', nu.detect(fxNu.lines), true);
  eq('número de movimientos', reales.length, e.count);
  eq('periodo', r.period, e.period);
  eq('total gastos', totalOf(reales, 'expense'), e.expense);
  eq('total depósitos', totalOf(reales, 'income'), e.income);
  eq('cajitas y pagos marcados como transfer',
    reales.filter(t => t.kind === 'transfer').length, e.transfers);
  eq('cuadra contra los totales del PDF', r.check.ok, true);
  eq('saldo final reconstruido', r.check.balance.computed, e.saldoFinal);

  // El pago de tarjeta NO es gasto (si no, se contaría doble contra BBVA)
  // pero SÍ cuenta como salida contra el total que declara Nu.
  const pago = reales.find(t => /Pago de tarjeta/i.test(t.description));
  eq('el pago de tarjeta es transfer', pago?.kind, 'transfer');
  eq('el pago de tarjeta sí sale de la cuenta', pago?._leavesAccount, true);
  eq('la Cajita no sale de la cuenta',
    reales.find(t => /Cajita/i.test(t.description))?._leavesAccount, undefined);
  eq('el total de salidas incluye el pago', r.check.rows[0].computed, e.outflow);

  // la sección espejo de cajitas no debe importarse
  eq('ignora la sección de cajitas', reales.length, e.count);

  // limpia " Compra" y el "*" del final
  eq('limpia la descripción',
    reales.find(t => t.amount === 1000).description, 'COMERCIO EJEMPLO');

  // rendimientos como ingreso opcional
  const extra = r.transactions.filter(t => t.optional);
  eq('propone los rendimientos', extra.length, 1);
  eq('monto de rendimientos', extra[0]?.amount, 50);
  eq('rendimientos van al final del periodo', extra[0]?.occurred_on, '2026-07-31');
});

// -------------------------------------------------------------------- finance
group('cálculos (finance.js)', () => {
  const txs = [
    { kind: 'expense', amount: 100, occurred_on: '2026-07-01', account_id: 'a', category_id: 'c1' },
    { kind: 'expense', amount: 50, occurred_on: '2026-07-15', account_id: 'a', category_id: 'c2' },
    { kind: 'income', amount: 500, occurred_on: '2026-07-10', account_id: 'b', category_id: 'c3' },
    { kind: 'transfer', amount: 900, occurred_on: '2026-07-20', account_id: 'a', category_id: null },
  ];

  eq('gasto negativo', fin.signedAmount(txs[0]), -100);
  eq('ingreso positivo', fin.signedAmount(txs[2]), 500);
  eq('transfer no suma', fin.signedAmount(txs[3]), 0);

  const s = fin.summarize(txs);
  eq('total ingresos', s.income, 500);
  eq('total gastos', s.expense, 150);
  eq('balance', s.net, 350);
  eq('las transferencias no inflan el balance', s.net, 350);

  const cats = new Map([
    ['c1', { name: 'Comida', color: '#f97316' }],
    ['c2', { name: 'Transporte', color: '#0ea5e9' }],
  ]);
  const porCat = fin.byCategory(txs, 'expense', cats);
  eq('categorías ordenadas de mayor a menor', porCat.map(c => c.name), ['Comida', 'Transporte']);
  eq('participación de la mayor', Math.round(porCat[0].share * 100), 67);

  eq('rango de febrero (año normal)', fin.monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  eq('rango de febrero (bisiesto)', fin.monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  eq('rango de mes de 31', fin.monthRange('2026-07'), { from: '2026-07-01', to: '2026-07-31' });
  eq('rango de diciembre', fin.monthRange('2026-12'), { from: '2026-12-01', to: '2026-12-31' });
  eq('mes anterior a enero', fin.previousMonth('2026-01'), '2025-12');
  eq('días en julio', fin.daysBetween('2026-07-01', '2026-07-31'), 31);

  const soloJulio = fin.filterTransactions(txs, { from: '2026-07-01', to: '2026-07-14' });
  eq('filtro por fecha', soloJulio.length, 2);
  eq('filtro que excluye transferencias',
    fin.filterTransactions(txs, { includeTransfers: false }).length, 3);
  eq('filtro por cuenta',
    fin.filterTransactions(txs, { accountIds: ['b'] }).length, 1);

  const meses = fin.byMonth([...txs, { kind: 'expense', amount: 10, occurred_on: '2026-06-05', account_id: 'a' }]);
  eq('serie mensual ordenada', meses.map(m => m.month), ['2026-06', '2026-07']);

  const comp = fin.comparePeriods([txs[0]], [txs[1]]);
  eq('variación de gasto %', comp.expenseChangePct, 100);
  eq('sin base de comparación devuelve null',
    fin.comparePeriods([txs[0]], []).expenseChangePct, null);
});

// --------------------------------------------------------------------- dedupe
group('duplicados (dedupe.js)', () => {
  const mk = (desc, amount, date = '2026-07-01') =>
    ({ account_id: 'a', occurred_on: date, amount, kind: 'expense', description: desc });

  // dos idénticos en el mismo estado de cuenta → deben entrar los dos
  const lote = [mk('CAFE', 100), mk('CAFE', 100)];
  dedupe.assignFingerprints(lote, []);
  eq('idénticos reciben huellas distintas', lote[0].fingerprint !== lote[1].fingerprint, true);
  eq('ninguno se marca duplicado', lote.filter(t => t.duplicate).length, 0);

  // reimportar el mismo estado de cuenta → los dos se bloquean
  const guardados = lote.map(t => ({ ...t }));
  const otraVez = [mk('CAFE', 100), mk('CAFE', 100)];
  dedupe.assignFingerprints(otraVez, guardados);
  eq('reimportar marca ambos como duplicado', otraVez.filter(t => t.duplicate).length, 2);

  // un tercer café real ese mismo día sí entra
  const tres = [mk('CAFE', 100), mk('CAFE', 100), mk('CAFE', 100)];
  dedupe.assignFingerprints(tres, guardados);
  eq('el tercero sí pasa', tres.filter(t => !t.duplicate).length, 1);

  // parecido, no idéntico
  const parecido = [mk('OXXO COXUMEL 65', 98)];
  dedupe.assignFingerprints(parecido, []);
  dedupe.flagSimilar(parecido, [{ ...mk('OXXO COXUMEL', 98, '2026-07-02') }]);
  eq('detecta descripción parecida', parecido[0].duplicateReason, 'parecido');

  const distinto = [mk('FARMACIA', 98)];
  dedupe.assignFingerprints(distinto, []);
  dedupe.flagSimilar(distinto, [{ ...mk('OXXO COXUMEL', 98, '2026-07-02') }]);
  eq('no marca cosas distintas', distinto[0].duplicateReason, null);

  eq('similitud idéntica', dedupe.similarity('OXXO', 'OXXO'), 1);
  eq('similitud nula', dedupe.similarity('OXXO', 'NETFLIX') < 0.2, true);
});

// ----------------------------------------------------------------- categorize
group('reglas (categorize.js)', () => {
  const reglas = [
    { id: 'r1', pattern: 'UBER', match_type: 'contains', category_id: 'transporte', priority: 100 },
    { id: 'r2', pattern: 'UBER EATS', match_type: 'contains', category_id: 'comida', priority: 100 },
    { id: 'r3', pattern: 'OXXO', match_type: 'contains', category_id: 'super', priority: 100 },
    { id: 'r4', pattern: 'NETFLIX', match_type: 'contains', category_id: 'entret', priority: 50 },
    { id: 'r5', pattern: 'apagada', match_type: 'contains', category_id: 'x', priority: 1, enabled: false },
  ];

  eq('la regla más específica gana',
    cat.matchRule({ description: 'UBER EATS MEXICO' }, reglas)?.category_id, 'comida');
  eq('la genérica sigue aplicando',
    cat.matchRule({ description: 'UBER TRIP 123' }, reglas)?.category_id, 'transporte');
  eq('ignora acentos y mayúsculas',
    cat.matchRule({ description: 'oxxo cozumel' }, reglas)?.category_id, 'super');
  eq('sin coincidencia devuelve null',
    cat.matchRule({ description: 'COMERCIO RARO' }, reglas), null);
  eq('respeta reglas deshabilitadas',
    cat.matchRule({ description: 'apagada' }, reglas), null);

  const txs = [
    { description: 'OXXO COXUMEL 65' },
    { description: 'COMERCIO RARO' },
    { description: 'NETFLIX.COM', category_id: 'manual', categorized_by: 'user' },
  ];
  cat.applyRules(txs, reglas, { fallbackCategoryId: 'sin' });
  eq('aplica la regla', txs[0].category_id, 'super');
  eq('marca el origen', txs[0].categorized_by, 'rule');
  eq('usa el respaldo', txs[1].category_id, 'sin');
  eq('no pisa lo que puso el usuario', txs[2].category_id, 'manual');

  eq('sugiere quitando el prefijo del procesador',
    cat.suggestRule('SQ *MOLLY MOON S CAPITOL')?.pattern, 'MOLLY MOON');
  eq('sugiere quitando el número de sucursal',
    cat.suggestRule('OXXO COXUMEL 65')?.pattern, 'OXXO COXUMEL');
  eq('detecta reglas ya existentes',
    cat.ruleExists(reglas, 'oxxo'), true);
});

// ---------------------------------------------------------------------- run
console.log('\nLootHound — pruebas\n');
for (const [name, fn] of groups) {
  console.log(`  ${name}`);
  fn();
  console.log('');
}
console.log(`  ${pass} ok, ${fail} fallas\n`);
process.exit(fail ? 1 : 0);
