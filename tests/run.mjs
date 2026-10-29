// ===========================================================================
// Pruebas sin navegador:  node tests/run.mjs
//
// Cubren la lógica pura (parsers, cálculos, duplicados, reglas). No tocan
// Supabase ni el DOM. Los fixtures son sintéticos: este repo es público.
// ===========================================================================

import fs from 'node:fs';

import * as bbva from '../js/parsers/bbva.js';
import * as nu from '../js/parsers/nu.js';
import * as fin from '../js/finance.js';
import * as dedupe from '../js/dedupe.js';
import * as cat from '../js/categorize.js';
import * as id from '../js/parsers/identity.js';
import * as bbvaDebito from '../js/parsers/bbva-debito.js';
import * as imp from '../js/views/import.js';
import * as sup from '../js/supabase.js';
import * as keepalive from '../tools/keepalive.mjs';
import * as edit from '../js/txedit.js';
import * as inv from '../js/invedit.js';

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
  // A Nu no le cae dinero de terceros: todo lo que entra lo mandas tú desde
  // otra cuenta tuya, así que ningún depósito cuenta como ingreso.
  eq('los depósitos NO son ingreso', totalOf(reales, 'income'), 0);
  eq('pero sí cuentan para validar contra el PDF', r.check.rows[1].computed, e.income);
  eq('cajitas, pagos y depósitos marcados como transfer',
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

// ------------------------------------------- reglas hacia atrás
group('las reglas nuevas aplican a lo que ya tenías', () => {
  // El caso real: importas Mercado Pago, salen 30 "Ganancia" sin categoría,
  // creas la regla Ganancia → Rendimientos... y no pasa nada, porque las
  // reglas sólo corrían al importar.
  const guardados = [
    { id: 't1', description: 'Ganancia', category_id: null, categorized_by: 'none' },
    { id: 't2', description: 'Ganancia', category_id: null, categorized_by: 'none' },
    { id: 't3', description: 'Ganancia Beneficio de Mercado Pago', category_id: null, categorized_by: 'none' },
    { id: 't4', description: 'OXXO COXUMEL', category_id: 'super', categorized_by: 'rule' },
    // éste lo acomodaste tú a mano: no se debe tocar
    { id: 't5', description: 'Ganancia', category_id: 'otra-cosa', categorized_by: 'user' },
  ];
  const conRegla = [
    { id: 'r1', pattern: 'Ganancia', match_type: 'contains', category_id: 'rendimientos', priority: 50, enabled: true },
    { id: 'r2', pattern: 'OXXO', match_type: 'contains', category_id: 'super', priority: 100, enabled: true },
  ];

  const plan = cat.recategorizePlan(guardados, conRegla);
  eq('acomoda las que estaban sin categoría', plan.length, 3);
  eq('todas van a la categoría de la regla',
    [...new Set(plan.map(c => c.category_id))], ['rendimientos']);
  eq('no toca lo que ya estaba bien', plan.some(c => c.id === 't4'), false);
  eq('no pisa tu decisión manual', plan.some(c => c.id === 't5'), false);

  // ...salvo que lo pidas explícitamente
  const forzado = cat.recategorizePlan(guardados, conRegla, { includeUserSet: true });
  eq('con includeUserSet sí lo pisa', forzado.some(c => c.id === 't5'), true);

  // Correr dos veces seguidas no debe hacer nada la segunda vez
  const yaAplicado = guardados.map(t => {
    const c = plan.find(p => p.id === t.id);
    return c ? { ...t, category_id: c.category_id, categorized_by: 'rule' } : t;
  });
  eq('es idempotente', cat.recategorizePlan(yaAplicado, conRegla).length, 0);

  // Sin regla que aplique no se despoja de lo que ya tenía
  const sinReglas = cat.recategorizePlan(
    [{ id: 'x', description: 'RARO', category_id: 'algo', categorized_by: 'rule' }], []);
  eq('no borra categorías existentes', sinReglas.length, 0);
});

// ------------------------------------- nada se duplica al reimportar
group('subir un estado de cuenta dos veces no duplica nada', () => {
  const mk = (desc, amount, date) =>
    ({ account_id: 'bbva', occurred_on: date, amount, kind: 'expense', description: desc });

  // Simula lo que hace la app: parsea, calcula huellas contra lo guardado,
  // deja marcado sólo lo nuevo, y guarda eso.
  const importar = (archivo, baseDeDatos) => {
    const lote = archivo.map((t) => ({ ...t }));
    dedupe.assignFingerprints(lote, baseDeDatos);
    for (const t of lote) t.selected = !t.duplicateReason;

    // Al confirmar se recalcula sobre TODO el archivo, no sólo lo marcado.
    dedupe.assignFingerprints(lote, baseDeDatos);
    const nuevos = lote.filter((t) => t.selected);

    // La base rechaza cualquier huella repetida (UNIQUE user_id+fingerprint).
    const yaHay = new Set(baseDeDatos.map((t) => t.fingerprint));
    const aceptados = nuevos.filter((t) => !yaHay.has(t.fingerprint));
    return { base: [...baseDeDatos, ...aceptados], insertados: aceptados.length, lote };
  };

  const julio = [
    mk('OXXO COXUMEL', 98, '2026-07-14'),
    mk('SQ *HOMAGE COFFEE', 280.46, '2026-07-27'),
    mk('MAJESTIC BAY THEATRES', 165.55, '2026-07-21'),
  ];

  // --- caso 1: el MISMO archivo dos veces --------------------------------
  let db = [];
  ({ base: db } = importar(julio, db));
  eq('la primera vez entran todos', db.length, 3);

  const segunda = importar(julio, db);
  eq('la segunda vez no entra ninguno', segunda.insertados, 0);
  eq('el total sigue igual', segunda.base.length, 3);
  eq('los tres se marcan como ya registrados',
    segunda.lote.filter((t) => t.duplicateReason === 'exacto').length, 3);

  // --- caso 2: archivos que se TRASLAPAN ---------------------------------
  // Uno cubre jul; el otro, mitad de jul y mitad de ago. Los de la mitad
  // compartida ya están guardados y no deben repetirse.
  const julioAgosto = [
    mk('SQ *HOMAGE COFFEE', 280.46, '2026-07-27'),   // ya está
    mk('MAJESTIC BAY THEATRES', 165.55, '2026-07-21'), // ya está
    mk('STARBUCKS STORE 11662', 444.69, '2026-08-06'), // nuevo
    mk('QFC N5891', 773.64, '2026-08-11'),             // nuevo
  ];
  const traslape = importar(julioAgosto, db);
  eq('sólo entran los del periodo nuevo', traslape.insertados, 2);
  eq('el total es la unión, no la suma', traslape.base.length, 5);
  eq('los repetidos se reconocen',
    traslape.lote.filter((t) => t.duplicateReason === 'exacto').length, 2);

  const gastoTotal = traslape.base.reduce((a, t) => a + t.amount, 0);
  eq('el gasto no se infla', Math.round(gastoTotal * 100) / 100, 1762.34);

  // --- caso 3: compras idénticas de verdad el mismo día -------------------
  // Dos cafés iguales el mismo día SÍ son dos gastos. No se deben perder.
  const conGemelos = [
    mk('CAFE', 100, '2026-09-01'),
    mk('CAFE', 100, '2026-09-01'),
  ];
  let db2 = [];
  ({ base: db2 } = importar(conGemelos, db2));
  eq('los dos cafés idénticos entran', db2.length, 2);

  const otraVez = importar(conGemelos, db2);
  eq('al reimportar no se duplican', otraVez.insertados, 0);
  eq('siguen siendo dos', otraVez.base.length, 2);

  // --- caso 4: el que rompía antes ---------------------------------------
  // Un archivo traslapado donde el PRIMER gemelo ya está guardado pero el
  // segundo no. Antes se recalculaba la huella sólo sobre lo marcado, el
  // segundo café creía ser el primero, chocaba y se perdía en silencio.
  const dbParcial = [{ ...conGemelos[0], fingerprint: dedupe.fingerprint(conGemelos[0], 0) }];
  const rescate = importar(conGemelos, dbParcial);
  eq('el gemelo que faltaba sí entra', rescate.insertados, 1);
  eq('quedan los dos, sin perder ninguno', rescate.base.length, 2);
});

// ------------------------------------------------- transferencias propias
group('transferencias entre cuentas propias (identity.js)', () => {
  const YO = ['Mario Alberto Reyes Duarte'];
  const c = (description, direction, extra = {}) =>
    id.classifyMovement({ description, direction, holderNames: YO, ...extra });

  // El caso que rompe todo si no se detecta: te mandas dinero a ti mismo y
  // aparece como ingreso en una cuenta y como gasto en la otra.
  eq('SPEI recibido de mí mismo no es ingreso',
    c('SPEI RECIBIDO Mercado Pago MARIO ALBERTO REYES DUARTE', 'in').kind, 'transfer');
  eq('SPEI enviado a mí mismo no es gasto',
    c('SPEI ENVIADO Mercado Pago Mario Alberto Reyes Duarte', 'out').kind, 'transfer');
  eq('razón: mismo titular',
    c('Transferencia recibida MARIO ALBERTO REYES DUARTE', 'in').reason, 'mismo-titular');

  // Aunque el nombre no aparezca, si nombra otra cartera tuya también cuenta
  eq('transferencia a otra cartera propia',
    c('Transferencia enviada JuanFer Nu', 'out').kind, 'transfer');
  eq('razón: cuenta propia',
    c('Transferencia enviada JuanFer Nu', 'out').reason, 'cuenta-propia');

  // Conceptos internos por definición
  eq('pago de tarjeta', c('PAGO TARJETA DE CREDITO CUENTA: BMOV', 'out').reason, 'pago-tarjeta');
  eq('retiro de efectivo', c('RETIRO SIN TARJETA ******8534', 'out').reason, 'retiro-efectivo');
  eq('cajita', c('Depósito en Cajita: Cajita Turbo', 'out').reason, 'cajita');

  // Lo que SÍ es ingreso o gasto de verdad
  eq('la nómina sí es ingreso', c('PAGO DE NOMINA', 'in').kind, 'income');
  eq('los rendimientos sí son ingreso', c('Ganancia', 'in').kind, 'income');
  eq('una compra sí es gasto', c('OXXO COXUMEL 65', 'out').kind, 'expense');

  // Cuentas donde nunca te cae dinero ajeno
  eq('depósito propio en cuenta marcada',
    c('Deposito', 'in', { depositsAreTransfers: true }).kind, 'transfer');
  eq('sin la marca, sería ingreso',
    c('Deposito', 'in', { depositsAreTransfers: false }).kind, 'income');

  // No confundirse con un comercio que se llame parecido
  eq('un apellido suelto no basta',
    id.mentionsHolder('FARMACIA REYES', YO), false);
  eq('nombre completo sí',
    id.mentionsHolder('MARIO ALBERTO REYES DUARTE', YO), true);
  eq('sin acentos y en minúsculas también',
    id.mentionsHolder('mario alberto reyes duarte', YO), true);
  eq('sin nombres configurados no detecta nada',
    id.mentionsHolder('MARIO ALBERTO REYES', []), false);
});

// -------------------------------------------------------- efectivo
group('conciliación de efectivo (finance.js)', () => {
  const CASH = 'cash-1';
  const BANCO = 'bbva-1';
  const txs = [
    // retiro del cajero: sale del banco, entra a la cartera
    { kind: 'transfer', amount: 2000, account_id: BANCO, counter_account_id: CASH,
      occurred_on: '2026-07-08', transfer_reason: 'retiro-efectivo' },
    // gastos en efectivo capturados a mano
    { kind: 'expense', amount: 350, account_id: CASH, occurred_on: '2026-07-09' },
    { kind: 'expense', amount: 120, account_id: CASH, occurred_on: '2026-07-10' },
    // un gasto con tarjeta no debe afectar la cartera
    { kind: 'expense', amount: 900, account_id: BANCO, occurred_on: '2026-07-11' },
  ];

  const r = fin.cashReconciliation(txs, CASH);
  eq('efectivo retirado', r.withdrawn, 2000);
  eq('efectivo capturado', r.spent, 470);
  eq('debería quedar en la cartera', r.expectedOnHand, 1530);
  eq('sin cuenta de efectivo devuelve null', fin.cashReconciliation(txs, null), null);

  // si capturas todo, no queda nada pendiente
  const completo = [...txs, { kind: 'expense', amount: 1530, account_id: CASH, occurred_on: '2026-07-12' }];
  eq('capturando todo queda en cero', fin.cashReconciliation(completo, CASH).expectedOnHand, 0);

  // las transferencias de efectivo no inflan ingresos ni gastos
  const s = fin.summarize(txs);
  eq('el retiro no cuenta como gasto', s.expense, 1370);
  eq('el retiro no cuenta como ingreso', s.income, 0);
});

// ------------------------------------------------- limites de la base
group('lo que se manda a la base cumple las restricciones', () => {
  // Un movimiento puede empezar al final de una pagina y seguir en la
  // siguiente. El parser pega renglones hasta encontrar la proxima fecha, asi
  // que sin filtrar el membrete se traga el pie de pagina y el encabezado
  // completos -- incluido el numero de cuenta -- y la base rechaza TODA la
  // importacion por pasarse de 200 caracteres.
  const lines = [
    { page: 1, text: 'Periodo DEL 01/07/2026 AL 31/07/2026', items: [] },
    { page: 1, text: 'Detalle de Movimientos Realizados', items: [] },
    { page: 1, text: 'OPER LIQ DESCRIPCIÓN REFERENCIA CARGOS ABONOS OPERACIÓN LIQUIDACIÓN',
      items: [
        { x0: 82, x1: 139, str: 'DESCRIPCIÓN' }, { x0: 216, x1: 269, str: 'REFERENCIA' },
        { x0: 371, x1: 406, str: 'CARGOS' }, { x0: 428, x1: 463, str: 'ABONOS' },
        { x0: 477, x1: 526, str: 'OPERACIÓN' }, { x0: 545, x1: 598, str: 'LIQUIDACIÓN' },
      ] },
    // movimiento al pie de la pagina 1
    { page: 1, text: '09/JUL 09/JUL SPEI RECIBIDO Mercado Pago 4,000.00',
      items: [
        { x0: 21, x1: 50, str: '09/JUL' }, { x0: 56, x1: 85, str: '09/JUL' },
        { x0: 85, x1: 200, str: 'SPEI RECIBIDO Mercado Pago' },
        { x0: 433, x1: 463, str: '4,000.00' },
      ] },
    // ...y todo el membrete que NO debe acabar en la descripcion
    { page: 1, text: 'BBVA MEXICO, S.A., INSTITUCION DE BANCA MULTIPLE, GRUPO FINANCIERO BBVA MEXICO', items: [] },
    { page: 1, text: 'Av. Paseo de la Reforma 510, Col. Juárez, Alcaldía Cuauhtémoc, C.P. 06600, Ciudad de México', items: [] },
    { page: 2, text: 'Estado de Cuenta', items: [] },
    { page: 2, text: 'LIBRETON 2.0', items: [] },
    { page: 2, text: 'PAGINA 2 / 5', items: [] },
    { page: 2, text: 'No. de Cuenta 0192649233', items: [] },
    { page: 2, text: 'No. de Cliente A8199334', items: [] },
    { page: 2, text: 'FECHA SALDO', items: [] },
    // esta linea SI pertenece al movimiento: es la contraparte
    { page: 2, text: 'MARIO ALBERTO REYES DUARTE', items: [] },
    { page: 2, text: 'TOTAL IMPORTE CARGOS 0.00', items: [] },
    { page: 2, text: 'TOTAL IMPORTE ABONOS 4,000.00', items: [] },
  ];

  const r = bbvaDebito.parse(lines, { holderNames: ['Mario Alberto Reyes Duarte'] });
  const tx = r.transactions[0];

  eq('lee el movimiento', r.transactions.length, 1);
  eq('cabe en la columna', tx.description.length <= 200, true);
  eq('no se traga el membrete', /BBVA MEXICO|LIBRETON|PAGINA|Paseo de la Reforma/.test(tx.description), false);
  eq('no filtra el número de cuenta', /0192649233|A8199334/.test(tx.description), false);
  eq('sí conserva la contraparte', /REYES DUARTE/.test(tx.description), true);
  eq('y por eso lo marca como transferencia', tx.kind, 'transfer');

  // Red de seguridad final: pase lo que pase, nunca sale algo que la base rechace.
  eq('recorta lo demasiado largo', imp.clampDescription('x'.repeat(500)).length, 200);
  eq('rellena lo vacío', imp.clampDescription('   '), 'Movimiento');
  eq('deja intacto lo normal', imp.clampDescription('  OXXO   COXUMEL  '), 'OXXO COXUMEL');
  eq('tolera null', imp.clampDescription(null), 'Movimiento');

  // Errores de pdf.js traducidos a algo que se puede accionar
  eq('PDF con contraseña', /contraseña/.test(imp.explicarErrorDePdf({ name: 'PasswordException', message: 'No password given' })), true);
  eq('archivo que no es PDF', /no parece un PDF/.test(imp.explicarErrorDePdf({ name: 'InvalidPDFException', message: 'Invalid PDF structure.' })), true);
  eq('error desconocido se muestra tal cual', imp.explicarErrorDePdf(new Error('algo raro')), 'algo raro');
  eq('error sin mensaje no deja un texto vacío', imp.explicarErrorDePdf({}).length > 0, true);
});

// ------------------------------------------------ presupuesto
group('presupuesto calculado desde el historial', () => {
  const CATS = new Map([
    ['comida', { name: 'Comida', color: '#f97316' }],
    ['viajes', { name: 'Viajes', color: '#14b8a6' }],
  ]);
  const g = (mes, dia, monto, cat) => ({
    kind: 'expense', amount: monto, occurred_on: `${mes}-${String(dia).padStart(2, '0')}`,
    account_id: 'a', category_id: cat,
  });
  const ing = (mes, monto) => ({
    kind: 'income', amount: monto, occurred_on: `${mes}-05`, account_id: 'a', category_id: null,
  });

  // Tres meses de comida parecida, y UN viaje carísimo en uno solo.
  const txs = [
    g('2026-05', 10, 3000, 'comida'), ing('2026-05', 20000),
    g('2026-06', 10, 3200, 'comida'), ing('2026-06', 20000),
    g('2026-07', 10, 2800, 'comida'), ing('2026-07', 20000),
    g('2026-07', 15, 30000, 'viajes'),   // gasto extraordinario
  ];

  const b = fin.suggestBudget(txs, CATS, { upTo: '2026-08' });
  const comida = b.lines.find((l) => l.name === 'Comida');

  eq('usa los meses cerrados', b.monthsUsed, 3);
  eq('comida: mediana de 3000/3200/2800', comida.suggested, 3000);
  eq('comida se midió con los 3 meses', comida.months, 3);

  // Lo importante: un viaje de $30,000 que pasó UNA vez en tres meses no debe
  // convertirse en un gasto mensual presupuestado. Con el promedio quedarían
  // $10,000 al mes de viajes, que es falso.
  eq('el viaje no entra al presupuesto',
    b.lines.some((l) => l.name === 'Viajes'), false);
  eq('el presupuesto es sólo lo recurrente', b.total, 3000);

  eq('mediana vs promedio', fin.median([1, 2, 3, 100]), 2.5);
  eq('mediana de lista vacía', fin.median([]), 0);

  // El mes en curso no debe arrastrar la sugerencia hacia abajo
  const conMesActual = [...txs, g('2026-08', 1, 200, 'comida')];
  eq('ignora el mes a medias',
    fin.suggestBudget(conMesActual, CATS, { upTo: '2026-08' }).monthsUsed, 3);

  eq('ingreso típico', fin.typicalIncome(txs, { upTo: '2026-08' }).median, 20000);

  // --- avance contra el tope ---------------------------------------------
  const agosto = [g('2026-08', 3, 3500, 'comida')];
  const topes = new Map([['comida', 3000]]);
  const p = fin.budgetProgress(agosto, topes, CATS);
  const linea = p.lines.find((l) => l.name === 'Comida');
  eq('detecta que se pasó', linea.over, true);
  eq('cuánto se pasó', linea.remaining, -500);
  eq('cuenta las pasadas', p.overCount, 1);

  // --- tasa de ahorro -----------------------------------------------------
  const mes = [ing('2026-08', 20000), g('2026-08', 3, 5000, 'comida'),
    { kind: 'transfer', amount: 9000, occurred_on: '2026-08-04', account_id: 'a' }];
  const s = fin.savingsRate(mes);
  eq('ahorro en pesos', s.net, 15000);
  eq('ahorro en porcentaje', s.rate, 75);
  eq('la transferencia no lo altera', s.expense, 5000);
  eq('sin ingresos no hay porcentaje', fin.savingsRate([]).rate, null);

  // --- la proyección no debe alarmar con ruido ----------------------------
  // Una compra grande el día 1 proyectaba un mes catastrófico y la app
  // avisaba "vas a quedar corto" al mismo tiempo que "podrías apartar X".
  const mesCerrado = fin.spendingPace([g('2026-07', 10, 5000, 'comida')], '2026-07');
  eq('un mes cerrado siempre es confiable', mesCerrado.reliable, true);
  eq('no proyecta un mes cerrado', mesCerrado.isCurrentMonth, false);

  const insightsTempranos = fin.budgetInsights({
    monthTxs: [g(fin.currentMonth(), 1, 2400, 'comida')],
    prevTxs: [], categories: CATS,
    income: { median: 30000, monthsUsed: 3 },
    pace: { ...fin.spendingPace([], fin.currentMonth()), spent: 2400, daysElapsed: 2,
      isCurrentMonth: true, reliable: false, projected: 36000, perDay: 1200, daysLeft: 28 },
    budget: { lines: [], totalBudget: 8160, totalSpent: 2400 },
  });
  eq('con pocos días no anuncia que quedarás corto',
    insightsTempranos.some((o) => /quedar corto/i.test(o.title)), false);
  eq('en su lugar explica por qué espera',
    insightsTempranos.some((o) => /muy pronto para proyectar/i.test(o.detail)), true);
  eq('tampoco dice que una categoría es el 100%',
    insightsTempranos.some((o) => /se lleva 100%/.test(o.title)), false);
});

// ------------------------------------------------ mensajes de error
group('los errores dicen qué hacer', () => {
  // Un proyecto pausado se ve igual que una URL mal escrita: "Failed to
  // fetch". La app decía "¿la URL del proyecto es correcta?", que manda a
  // revisar justo lo único que NO estaba mal — costó una sesión entera.
  // authErrorMessage devuelve null en esos casos para que explicarError()
  // salga a sondear la red y dé el diagnóstico bueno.
  eq('un fallo de red pide diagnóstico',
    sup.authErrorMessage(new Error('TypeError: Failed to fetch')), null);
  eq('también en la variante de Safari',
    sup.authErrorMessage(new Error('Load failed')), null);
  eq('y en la de Node',
    sup.authErrorMessage(new Error('fetch failed')), null);

  // Los errores que el servidor sí explica no deben sondear nada.
  eq('credenciales malas se responden directo',
    sup.authErrorMessage(new Error('Invalid login credentials')),
    'Correo o contraseña incorrectos.');
  eq('correo sin confirmar',
    sup.authErrorMessage(new Error('Email not confirmed')),
    'Falta confirmar tu correo. Revisa tu bandeja.');
  eq('correo ya registrado',
    sup.authErrorMessage(new Error('User already registered')),
    'Ese correo ya está registrado. Inicia sesión.');
  eq('demasiados intentos',
    sup.authErrorMessage(new Error('rate limit exceeded')),
    'Demasiados intentos. Espera un momento.');
  eq('un error desconocido se muestra tal cual',
    sup.authErrorMessage(new Error('algo raro')), 'algo raro');
});

// ------------------------------------------------ duplicados: coincidencia 1 a 1
group('un movimiento ya guardado nunca se reimporta, aunque haya cambiado', () => {
  const guardado = (over = {}) => {
    const tx = { account_id: 'deb', occurred_on: '2026-09-13', amount: 17646.09, kind: 'transfer',
      description: '14/SEP SPEI ENVIADO Mercado Pago 722', ...over };
    tx.fingerprint = dedupe.fingerprint(tx, 0);
    return tx;
  };
  const nuevo = (over = {}) => ({ account_id: 'deb', occurred_on: '2026-09-13', amount: 17646.09,
    kind: 'transfer', description: 'SPEI ENVIADO Mercado Pago 722', ...over });

  // 1) El usuario corrigió el TIPO en el preview. La huella exacta ya no
  //    coincide, pero es el mismo movimiento.
  let lote = [nuevo({ kind: 'expense' })];
  dedupe.assignFingerprints(lote, [guardado()]);
  eq('cambiar el tipo no lo vuelve "nuevo"', lote[0].duplicateReason, 'exacto');

  // 2) El parser dejó de pegar "14/SEP" al inicio del texto.
  lote = [nuevo()];
  dedupe.assignFingerprints(lote, [guardado()]);
  eq('limpiar el texto no lo vuelve "nuevo"', lote[0].duplicate, true);

  // 3) Dos cafés idénticos: uno ya guardado, el otro no. Uno a uno.
  const cafe = (n) => ({ account_id: 'c', occurred_on: '2026-09-01', amount: 45, kind: 'expense', description: 'CAFE', n });
  const base = [{ ...cafe(), fingerprint: dedupe.fingerprint(cafe(), 0) }];
  lote = [cafe(), cafe()];
  dedupe.assignFingerprints(lote, base);
  eq('el primero ya estaba', lote[0].duplicate, true);
  eq('el segundo es nuevo (es otra compra)', lote[1].duplicate, false);

  // 4) Misma cuenta, fecha y monto pero otro comercio: son dos gastos distintos.
  lote = [nuevo({ description: 'FARMACIA DEL AHORRO' })];
  dedupe.assignFingerprints(lote, [guardado({ description: 'OXXO COZUMEL' })]);
  eq('otro comercio, mismo monto: no es duplicado', lote[0].duplicate, false);

  // 5) Otro monto o fecha: nunca.
  lote = [nuevo({ amount: 17646.1 })];
  dedupe.assignFingerprints(lote, [guardado()]);
  eq('otro monto no es duplicado', lote[0].duplicate, false);
  lote = [nuevo({ occurred_on: '2026-09-14' })];
  dedupe.assignFingerprints(lote, [guardado()]);
  eq('otra fecha no es duplicado', lote[0].duplicate, false);

  // 6) Otra cuenta con lo mismo: pagaste lo mismo con dos tarjetas, son dos.
  lote = [nuevo({ account_id: 'nu' })];
  dedupe.assignFingerprints(lote, [guardado()]);
  eq('misma cosa en otra cuenta no es duplicado', lote[0].duplicate, false);

  // 7) Idempotente: la app lo calcula dos veces (preview y al confirmar).
  lote = [nuevo({ kind: 'expense' })];
  dedupe.assignFingerprints(lote, [guardado()]);
  dedupe.assignFingerprints(lote, [guardado()]);
  eq('calcularlo dos veces da lo mismo', lote[0].duplicate, true);

  // 8) Un movimiento guardado cubre a UNO nuevo, no a varios.
  lote = [nuevo(), nuevo({ kind: 'expense' })];
  dedupe.assignFingerprints(lote, [guardado()]);
  eq('uno guardado, dos idénticos entrantes: uno es duplicado',
    lote.filter((t) => t.duplicate).length, 1);
});

group('traspasos "por revisar" se confirman con su pareja', () => {
  const por = (over = {}) => ({ account_id: 'deb', occurred_on: '2026-09-30', amount: 9093.56,
    kind: 'transfer', needs_review: true, ...over });
  const pareja = (over = {}) => ({ account_id: 'mp', occurred_on: '2026-09-30', amount: 9093.56,
    kind: 'transfer', description: 'Transferencia enviada Mario Alberto Reyes Duarte', ...over });

  let l = [por()];
  dedupe.confirmTransferPairs(l, [pareja()]);
  eq('con pareja en otra cuenta: queda confirmado', l[0].needs_review, false);
  eq('guarda con qué se confirmó', !!l[0].confirmedBy, true);

  l = [por()];
  dedupe.confirmTransferPairs(l, [pareja({ occurred_on: '2026-10-02' })]);
  eq('a 2 días todavía cuenta', l[0].needs_review, false);

  l = [por()];
  dedupe.confirmTransferPairs(l, [pareja({ occurred_on: '2026-10-20' })]);
  eq('a 20 días no es la misma operación', l[0].needs_review, true);

  l = [por()];
  dedupe.confirmTransferPairs(l, [pareja({ account_id: 'deb' })]);
  eq('en la MISMA cuenta no sirve de pareja', l[0].needs_review, true);

  l = [por()];
  dedupe.confirmTransferPairs(l, [pareja({ kind: 'expense' })]);
  eq('si la otra es un gasto, no es traspaso', l[0].needs_review, true);

  l = [por()];
  dedupe.confirmTransferPairs(l, [pareja({ amount: 9093.5 })]);
  eq('otro monto no confirma', l[0].needs_review, true);
});

// ------------------------------------------------ identidad más estricta
group('qué es "tuyo" y qué es otra persona', () => {
  const YO = ['Mario Alberto Reyes Duarte'];
  const c = (description, direction, extra = {}) =>
    id.classifyMovement({ description, direction, holderNames: YO, ...extra });

  // Un familiar que comparte apellidos NO eres tú.
  eq('hermano con tus apellidos no cuenta como tú',
    id.mentionsHolder('SPEI RECIBIDO CARLOS REYES DUARTE', YO), false);
  eq('primo que se llama casi igual tampoco',
    id.mentionsHolder('MARIO CARLOS REYES DUARTE', YO), false);
  eq('tu nombre completo sí', id.mentionsHolder('MARIO ALBERTO REYES DUARTE', YO), true);
  eq('con el último apellido cortado por el banco, sí',
    id.mentionsHolder('MARIO ALBERTO REYES DUAR', YO), true);
  eq('pero no una sola letra suelta de relleno',
    id.mentionsHolder('MARIO ALBERTO REYES D', YO), false);
  eq('no confunde un comercio parecido',
    id.mentionsHolder('FARMACIA REYES', YO), false);

  // Apodos
  eq('el apodo "JuanFer Nu" se puede registrar',
    id.mentionsHolder('Transferencia enviada JuanFer Nu', ['JuanFer Nu']), true);
  eq('un apodo demasiado corto se ignora (coincidiría con todo)',
    id.mentionsHolder('Pago a Nu Bank cliente', ['Nu']), false);

  // El nombre del BANCO no dice de quién es la cuenta.
  let r = c('SPEI RECIBIDO NUBANK Transferencia', 'in', { counterparty: 'ROBERTO PEREZ LOPEZ' });
  eq('SPEI de Nubank con el nombre de OTRA persona es ingreso', r.kind, 'income');
  r = c('SPEI RECIBIDO NUBANK Transferencia', 'in', { counterparty: 'MARIO ALBERTO REYES DUARTE' });
  eq('SPEI de Nubank con TU nombre es traspaso', r.kind, 'transfer');
  r = c('SPEI RECIBIDO Mercado Pago', 'in');
  eq('sin nombre y mencionando tu cartera: traspaso…', r.kind, 'transfer');
  eq('…pero marcado para revisar', r.review, true);
  r = c('Transferencia enviada Pedro Ramirez Soto', 'out');
  eq('transferencia a una persona cualquiera es gasto', r.kind, 'expense');

  // Envíos a plataformas de inversión: dinero tuyo que sólo cambió de lugar.
  eq('SPEI a GBM no es gasto', c('SPEI ENVIADO GBM Casa de Bolsa', 'out').kind, 'transfer');
  eq('…su motivo es inversión', c('SPEI ENVIADO GBM Casa de Bolsa', 'out').reason, 'inversion');
  eq('depósito a eToro tampoco', c('Transferencia enviada eToro', 'out').kind, 'transfer');
  eq('retiro de Bitso a tu cuenta tampoco es ingreso', c('SPEI RECIBIDO Bitso', 'in').kind, 'transfer');
  eq('una compra en una tienda no se confunde',
    c('COMPRA GBMSTORE ABARROTES', 'out').kind, 'expense');

  // Categorías por omisión de los ingresos
  const ing = (d) => ({ kind: 'income', description: d });
  eq('nómina → Sueldo', cat.builtinIncomeCategory(ing('PAGO DE NOMINA 1 PAGO DE NOMINA')), 'Sueldo');
  eq('ganancia → Rendimientos', cat.builtinIncomeCategory(ing('Ganancia Beneficio de Mercado Pago')), 'Rendimientos');
  eq('compensación → Otros ingresos', cat.builtinIncomeCategory(ing('Compensación de retraso SPEI')), 'Otros ingresos');
  eq('un ingreso desconocido no se adivina', cat.builtinIncomeCategory(ing('SPEI RECIBIDO NUBANK')), null);
  eq('un gasto nunca recibe categoría de ingreso',
    cat.builtinIncomeCategory({ kind: 'expense', description: 'NOMINA' }), null);

  // Compensaciones del banco
  eq('compensación por SPEI retrasado es ingreso, aunque sea cuenta de depósitos propios',
    c('Compensación de retraso SPEI', 'in', { depositsAreTransfers: true }).kind, 'income');
  eq('un depósito normal en cuenta propia sigue siendo traspaso',
    c('Depósito', 'in', { depositsAreTransfers: true }).kind, 'transfer');
});

// ------------------------------------------------ BBVA débito: fechas y nombres
group('BBVA débito: años, fechas pegadas y contraparte', () => {
  const COLS = [
    { x0: 82, x1: 139, str: 'DESCRIPCIÓN' }, { x0: 216, x1: 269, str: 'REFERENCIA' },
    { x0: 371, x1: 406, str: 'CARGOS' }, { x0: 428, x1: 463, str: 'ABONOS' },
    { x0: 477, x1: 526, str: 'OPERACIÓN' }, { x0: 545, x1: 598, str: 'LIQUIDACIÓN' },
  ];
  const fila = (op, liq, texto, monto, col) => ({
    page: 1, text: `${op} ${liq} ${texto} ${monto}`,
    items: [
      { x0: 21, x1: 50, str: op }, { x0: 56, x1: 85, str: liq },
      // pdf.js pega la fecha de liquidación al texto en el mismo bloque
      ...(texto ? [{ x0: 85, x1: 200, str: texto }] : []),
      { x0: col === 'cargo' ? 384 : 433, x1: col === 'cargo' ? 415 : 463, str: monto },
    ],
  });
  const cont = (texto) => ({ page: 1, text: texto, items: [] });
  const armar = (periodo, filas) => [
    { page: 1, text: `Periodo ${periodo}`, items: [] },
    { page: 1, text: 'Detalle de Movimientos Realizados', items: [] },
    { page: 1, text: 'OPER LIQ DESCRIPCIÓN REFERENCIA CARGOS ABONOS OPERACIÓN LIQUIDACIÓN', items: COLS },
    ...filas,
    { page: 2, text: 'TOTAL IMPORTE CARGOS 0.00', items: [] },
    { page: 2, text: 'TOTAL IMPORTE ABONOS 0.00', items: [] },
  ];

  // Periodo que cruza de diciembre a enero.
  const cruce = bbvaDebito.parse(armar('DEL 15/12/2025 AL 14/01/2026', [
    fila('20/DIC', '20/DIC', 'PAGO DE NOMINA', '1,000.00', 'abono'),
    fila('31/DIC', '02/ENE', 'SPEI ENVIADO Otro Banco', '500.00', 'cargo'),
    cont('Pedro Perez Lopez'),
    fila('10/ENE', '10/ENE', 'PAGO DE NOMINA', '2,000.00', 'abono'),
  ]), { holderNames: ['Mario Alberto Reyes Duarte'] });
  const f = (m) => cruce.transactions.find((t) => t.amount === m);
  eq('diciembre se queda en el año que empieza', f(1000).occurred_on, '2025-12-20');
  eq('enero es del año siguiente', f(2000).occurred_on, '2026-01-10');
  eq('31-dic con liquidación 02-ene: la operación es 2025', f(500).occurred_on, '2025-12-31');
  eq('…y la liquidación cae en 2026', f(500).posted_on, '2026-01-02');

  // El texto no debe arrastrar la fecha de liquidación pegada al inicio.
  const pegada = bbvaDebito.parse(armar('DEL 01/09/2026 AL 30/09/2026', [
    fila('13/SEP', '14/SEP', '14/SEP RETIRO SIN TARJETA', '2,000.00', 'cargo'),
  ]), {});
  eq('sin "14/SEP" al inicio del nombre', pegada.transactions[0].description, 'RETIRO SIN TARJETA');
  eq('y el retiro se reconoce', pegada.transactions[0].transfer_reason, 'retiro-efectivo');

  // Un SPEI de otra persona a través de tu mismo banco NO es traspaso propio.
  const tercero = bbvaDebito.parse(armar('DEL 01/09/2026 AL 30/09/2026', [
    fila('11/SEP', '11/SEP', 'SPEI RECIBIDO NUBANK', '2,380.00', 'abono'),
    cont('ROBERTO PEREZ LOPEZ'),
  ]), { holderNames: ['Mario Alberto Reyes Duarte'] });
  eq('SPEI de un tercero es ingreso', tercero.transactions[0].kind, 'income');

  // Sin nombre: se asume tuyo pero se marca.
  const anonimo = bbvaDebito.parse(armar('DEL 01/09/2026 AL 30/09/2026', [
    fila('30/SEP', '30/SEP', 'SPEI RECIBIDO Mercado Pago', '9,093.56', 'abono'),
  ]), { holderNames: ['Mario Alberto Reyes Duarte'] });
  eq('sin nombre: traspaso', anonimo.transactions[0].kind, 'transfer');
  eq('sin nombre: se marca para revisar', anonimo.transactions[0].needs_review, true);

  eq('nombre de contraparte: lo reconoce',
    bbvaDebito.counterpartyOf(['x', 'CUENTA: BMOV', 'ROBERTO PEREZ LOPEZ']), 'ROBERTO PEREZ LOPEZ');
  eq('una referencia numérica no es un nombre',
    bbvaDebito.counterpartyOf(['x', '0181791744 722 1513083MERCADO*PAGO']), null);
});

// ------------------------------------------------ editar un movimiento
group('editar un movimiento: validación y cambios', () => {
  const accounts = new Map([['a', { id: 'a', name: 'Efectivo' }], ['b', { id: 'b', name: 'BBVA' }]]);
  const cats = new Map([
    ['com', { id: 'com', name: 'Comida', kind: 'expense' }],
    ['sue', { id: 'sue', name: 'Sueldo', kind: 'income' }],
    ['tra', { id: 'tra', name: 'Transferencia', kind: 'both' }],
  ]);
  const ctx = { accountMap: accounts, categoryMap: cats };
  const ok = (over = {}) => ({ occurred_on: '2026-09-16', description: 'Tacos', amount: '120',
    kind: 'expense', account_id: 'a', category_id: 'com', ...over });
  const v = (over, c = ctx) => edit.validateTransaction(ok(over), c);

  eq('un movimiento correcto pasa', v({}).ok, true);

  // Fechas
  eq('rechaza 30 de febrero', v({ occurred_on: '2026-02-30' }).errors.occurred_on !== undefined, true);
  eq('rechaza fecha vacía', v({ occurred_on: '' }).ok, false);
  eq('rechaza 2026-13-01', v({ occurred_on: '2026-13-01' }).ok, false);
  eq('acepta 29 de febrero bisiesto', v({ occurred_on: '2028-02-29' }).ok, true);
  eq('rechaza 29 de febrero en año normal', v({ occurred_on: '2026-02-29' }).ok, false);

  // Montos
  eq('acepta "1,234.50"', v({ amount: '1,234.50' }).patch.amount, 1234.5);
  eq('acepta "$99"', v({ amount: '$99' }).patch.amount, 99);
  eq('redondea a 2 decimales', v({ amount: '10.005' }).patch.amount, 10.01);
  eq('rechaza cero', v({ amount: '0' }).ok, false);
  eq('rechaza negativos', v({ amount: '-5' }).ok, false);
  eq('rechaza texto', v({ amount: 'doscientos' }).ok, false);
  eq('rechaza vacío', v({ amount: '' }).ok, false);
  eq('rechaza montos que no caben en la base', v({ amount: '1e15' }).ok, false);
  eq('el monto numérico también sirve', v({ amount: 45.5 }).patch.amount, 45.5);

  // Nombre y nota
  eq('rechaza nombre vacío', v({ description: '   ' }).ok, false);
  eq('rechaza nombre de más de 200', v({ description: 'x'.repeat(201) }).ok, false);
  eq('acepta nombre de exactamente 200', v({ description: 'x'.repeat(200) }).ok, true);
  eq('colapsa espacios del nombre', v({ description: '  a   b  ' }).patch.description, 'a b');
  eq('rechaza nota de más de 500', v({ note: 'n'.repeat(501) }).ok, false);
  eq('nota vacía queda null', v({ note: '  ' }).patch.note, null);

  // Tipo, cuenta y categoría
  eq('rechaza un tipo inventado', v({ kind: 'prestamo' }).ok, false);
  eq('rechaza cuenta inexistente', v({ account_id: 'zzz' }).ok, false);
  eq('rechaza categoría inexistente', v({ category_id: 'zzz' }).ok, false);
  eq('un gasto no puede llevar categoría de ingreso', v({ category_id: 'sue' }).ok, false);
  eq('un ingreso sí lleva categoría de ingreso', v({ kind: 'income', category_id: 'sue' }).ok, true);
  eq('una transferencia lleva categoría "ambos"', v({ kind: 'transfer', category_id: 'tra' }).ok, true);
  eq('una transferencia no lleva categoría de gasto', v({ kind: 'transfer', category_id: 'com' }).ok, false);
  eq('sin categoría es válido', v({ category_id: '' }).patch.category_id, null);

  // Cuenta destino
  eq('destino distinto al origen', v({ kind: 'transfer', category_id: 'tra', counter_account_id: 'b' }).patch.counter_account_id, 'b');
  eq('destino igual al origen se rechaza', v({ kind: 'transfer', category_id: 'tra', counter_account_id: 'a' }).ok, false);
  eq('un gasto ignora el destino', v({ counter_account_id: 'b' }).patch.counter_account_id, null);

  // Qué se guarda
  const manual = { id: 1, source: 'manual', category_id: 'com', categorized_by: 'user', transfer_reason: null };
  const pdf = { id: 2, source: 'pdf_import', category_id: 'com', categorized_by: 'rule', transfer_reason: 'retiro-efectivo' };
  const pm = edit.validateTransaction(ok(), { ...ctx, previous: manual }).patch;
  const pp = edit.validateTransaction(ok(), { ...ctx, previous: pdf }).patch;
  eq('lo manual recibe huella aleatoria nueva', /^manual\|/.test(pm.fingerprint), true);
  eq('lo importado NO cambia su huella', 'fingerprint' in pp, false);
  eq('editar otra cosa no convierte la categoría de una regla en manual', pp.categorized_by, 'rule');
  const cambia = edit.validateTransaction(ok({ category_id: 'tra', kind: 'transfer' }), { ...ctx, previous: pdf }).patch;
  eq('cambiar la categoría sí la vuelve manual', cambia.categorized_by, 'user');
  eq('seguir siendo transferencia conserva el motivo', cambia.transfer_reason, 'retiro-efectivo');
  eq('dejar de ser transferencia borra el motivo', pp.transfer_reason, null);

  // Sólo lo que cambió
  const antes = { occurred_on: '2026-09-16', description: 'Tacos', amount: '120.00', note: null, kind: 'expense' };
  eq('sin cambios no hay nada que guardar',
    Object.keys(edit.changedFields(antes, { occurred_on: '2026-09-16', description: 'Tacos', amount: 120, note: null, kind: 'expense' })).length, 0);
  eq('detecta sólo el monto',
    Object.keys(edit.changedFields(antes, { occurred_on: '2026-09-16', description: 'Tacos', amount: 121, note: null, kind: 'expense' })), ['amount']);

  // El mismo gasto capturado dos veces debe poder existir (dos cafés iguales).
  eq('dos huellas manuales nunca chocan', edit.newManualFingerprint() !== edit.newManualFingerprint(), true);
});

// ------------------------------------------------ inversiones
group('inversiones: el modelo de la hoja de Excel', () => {
  // Portafolio INVENTADO con la misma forma que una hoja típica (el repo es
  // público: nada de cifras reales). Cuentas de ahorro con valor pero sin
  // "le metí", y tres plataformas de riesgo con las dos cosas:
  //   Nu 20,000 · MercadoPago 50,000 · Didi 10,000 · Revolut 0     (ahorro)
  //   eToro  valor 11,500  le metí 10,000   (+15%)
  //   GBM    valor 10,000  le metí  8,000   (+25%)
  //   Bitso  valor  7,000  le metí 12,000   (−41.67%)
  //   Total 108,500
  const acc = (id, name, type) => ({ id, name, type, archived: false, sort_order: 1 });
  const cuentas = [
    acc('nu', 'Nu', 'ahorro'), acc('mp', 'Mercado Pago', 'ahorro'), acc('didi', 'Didi', 'ahorro'),
    acc('rev', 'Revolut', 'ahorro'), acc('etoro', 'eToro', 'bolsa'), acc('gbm', 'GBM', 'bolsa'),
    acc('bitso', 'Bitso', 'cripto'),
  ];
  const dep = (investment_id, occurred_on, amount) => ({ investment_id, occurred_on, amount, kind: 'deposit' });
  const flujos = [
    dep('etoro', '2026-01-10', 5000), dep('etoro', '2026-05-10', 5000),
    dep('gbm', '2026-02-01', 5000), dep('gbm', '2026-06-01', 3000),
    dep('bitso', '2026-01-20', 7000), dep('bitso', '2026-04-01', 5000),
  ];
  const val = (investment_id, as_of, value) => ({ investment_id, as_of, value });
  const valores = [
    val('nu', '2026-10-10', 20000), val('mp', '2026-10-10', 50000), val('didi', '2026-10-10', 10000),
    val('rev', '2026-10-10', 0), val('etoro', '2026-10-10', 11500), val('gbm', '2026-10-10', 10000),
    val('bitso', '2026-10-10', 7000),
  ];
  const S = fin.investmentSummary({ accounts: cuentas, flows: flujos, values: valores,
    month: '2026-10', asOf: '2026-10-16', goal: 6000 });
  const fila = (id) => S.rows.find((r) => r.id === id);

  eq('valor total', S.totals.value, 108500);
  eq('lo que has metido (sólo plataformas con aportaciones)', S.totals.contributed, 30000);
  eq('"le metí" de eToro', fila('etoro').contributed, 10000);
  eq('ganancia de eToro', fila('etoro').gain, 1500);
  eq('% de eToro', fila('etoro').returnPct, 15);
  eq('ganancia de GBM', fila('gbm').gain, 2000);
  eq('% de GBM', fila('gbm').returnPct, 25);
  eq('Bitso va en pérdida', fila('bitso').gain, -5000);
  eq('% de Bitso', fila('bitso').returnPct, -41.67);

  // La ganancia total sólo cuenta lo que se puede medir.
  eq('valor medible', S.totals.trackedValue, 28500);
  eq('aportado medible', S.totals.trackedContributed, 30000);
  eq('ganancia total', S.totals.gain, -1500);
  eq('% total', S.totals.returnPct, -5);
  eq('lo que no se puede medir', S.totals.untrackedValue, 80000);
  eq('Nu no tiene ganancia inventada', fila('nu').gain, null);
  eq('Nu no tiene % inventado', fila('nu').returnPct, null);

  // Peso de cada plataforma y por tipo
  eq('Mercado Pago pesa 46%', Math.round(fila('mp').share * 100), 46);
  const ahorro = S.typeBreakdown.find((t) => t.type === 'ahorro');
  eq('ahorro suma 80,000', ahorro.value, 80000);
  eq('cripto pesa 6%', Math.round(S.typeBreakdown.find((t) => t.type === 'cripto').share * 100), 6);

  // Rendimiento anualizado: hay > 90 días de historia en las tres con aportaciones.
  eq('eToro tiene anualizado', fila('etoro').annualized !== null, true);
  eq('Bitso anualizado es negativo', fila('bitso').annualized < 0, true);
  eq('Nu no tiene anualizado', fila('nu').annualized, null);
  eq('el total tiene anualizado', S.totals.annualized !== null, true);
});

group('inversiones: este mes, la meta y el historial', () => {
  const cuentas = [{ id: 'a', name: 'A', type: 'bolsa', archived: false }, { id: 'b', name: 'B', type: 'ahorro', archived: false }];
  const f = (investment_id, occurred_on, amount, kind = 'deposit') => ({ investment_id, occurred_on, amount, kind });
  const flujos = [
    f('a', '2026-09-30', 9999), f('a', '2026-10-02', 3000), f('b', '2026-10-09', 1000),
    f('a', '2026-10-12', 500, 'withdrawal'), f('a', '2026-11-01', 7777),
  ];
  const vals = [{ investment_id: 'a', as_of: '2026-10-10', value: 100 }];
  const S = fin.investmentSummary({ accounts: cuentas, flows: flujos, values: vals,
    month: '2026-10', asOf: '2026-10-16', goal: 6000 });

  eq('lo metido este mes (neto)', S.totals.monthNet, 3500);
  eq('por plataforma: A', S.rows.find((r) => r.id === 'a').monthNet, 2500);
  eq('no cuenta septiembre', S.totals.monthNet < 9999, true);
  eq('no cuenta el futuro (noviembre)', S.rows.find((r) => r.id === 'a').deposited, 12999);
  eq('avance contra la meta', S.goalProgress.pct, 58);
  eq('lo que falta', S.goalProgress.remaining, 2500);
  eq('meta no cumplida', S.goalProgress.reached, false);
  eq('sin meta no hay avance',
    fin.investmentSummary({ accounts: cuentas, flows: flujos, values: vals, month: '2026-10', goal: null }).goalProgress, null);
  eq('meta 0 se trata como sin meta',
    fin.investmentSummary({ accounts: cuentas, flows: flujos, values: vals, month: '2026-10', goal: 0 }).goalProgress, null);

  // aportaciones por mes
  const meses = fin.monthlyContributions(flujos, '2026-10', 3);
  eq('siempre 3 meses, aunque estén vacíos', meses.map((m) => m.month), ['2026-08', '2026-09', '2026-10']);
  eq('mes vacío es 0', meses[0].net, 0);
  eq('septiembre', meses[1].net, 9999);
  eq('octubre (retiro resta)', meses[2].net, 3500);
  eq('cruza el año', fin.monthlyContributions([], '2026-01', 3).map((m) => m.month), ['2025-11', '2025-12', '2026-01']);

  // plataforma archivada: no cuenta
  const arch = fin.investmentSummary({ accounts: [{ ...cuentas[0], archived: true }, cuentas[1]],
    flows: flujos, values: vals, month: '2026-10', asOf: '2026-10-16' });
  eq('archivada no aparece', arch.rows.map((r) => r.id), ['b']);

  // historial: el valor de cada fecha usa el último conocido de cada plataforma
  const h = fin.valueHistory(cuentas, flujos, [
    { investment_id: 'a', as_of: '2026-10-01', value: 100 },
    { investment_id: 'b', as_of: '2026-10-05', value: 50 },
    { investment_id: 'a', as_of: '2026-10-10', value: 120 },
  ]);
  eq('una fila por fecha con foto', h.map((x) => x.date), ['2026-10-01', '2026-10-05', '2026-10-10']);
  eq('el 5 suma A (viejo) + B', h[1].value, 150);
  eq('el 10 usa el A nuevo', h[2].value, 170);
  eq('lo metido crece con el tiempo', h[0].contributed <= h[2].contributed, true);

  // sin valor registrado
  eq('sin foto de valor, no hay valor', S.rows.find((r) => r.id === 'b').value, null);
  eq('y no hay ganancia', S.rows.find((r) => r.id === 'b').gain, null);
});

group('inversiones: rendimiento anualizado (XIRR)', () => {
  const near = (got, want, tol = 1e-6) => Math.abs(got - want) < tol;
  eq('10% en un año', near(fin.xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }]), 0.1), true);
  eq('10% anual compuesto en dos años', near(fin.xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2027-01-01', amount: 1210 }]), 0.1), true);
  eq('pérdida de 50%', near(fin.xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 500 }]), -0.5), true);
  eq('0% si recuperas lo mismo', near(fin.xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1000 }]), 0), true);
  // $1,000 todo el año + $1,000 sólo medio año, y al final $2,200: la ganancia
  // SIMPLE es 10%, pero la mitad del dinero sólo trabajó medio año, así que
  // anualizado es más: 13.4627% (verificado con una bisección independiente).
  eq('con dos aportaciones pesa CUÁNDO metiste',
    near(fin.xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2025-07-02', amount: -1000 }, { date: '2026-01-01', amount: 2200 }]), 0.134627, 1e-5), true);
  eq('con un retiro a medias', fin.xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2025-07-01', amount: 300 }, { date: '2026-01-01', amount: 800 }]) > 0, true);
  eq('un solo flujo no se puede', fin.xirr([{ date: '2025-01-01', amount: -1000 }]), null);
  eq('todo negativo no se puede', fin.xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: -5 }]), null);
  eq('sin flujos', fin.xirr([]), null);
  eq('perderlo todo (valor 0) no se puede anualizar',
    fin.xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 0 }]), null);

  // Con poca historia, anualizar es ruido: no se muestra.
  const S = fin.investmentSummary({
    accounts: [{ id: 'a', name: 'A', type: 'bolsa', archived: false }],
    flows: [{ investment_id: 'a', occurred_on: '2026-09-20', amount: 1000, kind: 'deposit' }],
    values: [{ investment_id: 'a', as_of: '2026-10-10', value: 1020 }], month: '2026-10', asOf: '2026-10-16' });
  eq('+2% en 3 semanas NO se anualiza (sería ~40%)', S.rows[0].annualized, null);
  eq('pero el % simple sí', S.rows[0].returnPct, 2);
  eq('días desde la última foto', S.rows[0].daysSinceValue, 6);
  eq('una foto de hace 6 días no está vieja', S.rows[0].stale, false);
  eq('una de hace 45 días sí',
    fin.investmentSummary({ accounts: [{ id: 'a', name: 'A', type: 'bolsa', archived: false }], flows: [],
      values: [{ investment_id: 'a', as_of: '2026-09-01', value: 5 }], month: '2026-10', asOf: '2026-10-16' }).rows[0].stale, true);
});

group('inversiones: observaciones', () => {
  const acc = (id, name, type) => ({ id, name, type, archived: false });
  const cuentas = [acc('mp', 'Mercado Pago', 'ahorro'), acc('bitso', 'Bitso', 'cripto'), acc('etoro', 'eToro', 'bolsa')];
  const S = fin.investmentSummary({
    accounts: cuentas,
    flows: [
      { investment_id: 'bitso', occurred_on: '2026-01-20', amount: 12000, kind: 'deposit' },
      { investment_id: 'etoro', occurred_on: '2026-01-20', amount: 20000, kind: 'deposit' },
    ],
    values: [
      { investment_id: 'mp', as_of: '2026-10-10', value: 40000 },
      { investment_id: 'bitso', as_of: '2026-10-10', value: 7000 },
      { investment_id: 'etoro', as_of: '2026-08-01', value: 11500 },
    ],
    month: '2026-10', asOf: '2026-10-16', goal: 6000 });
  const obs = fin.investmentInsights(S, { monthIncome: 30000, isCurrentMonth: true, daysLeft: 15 });
  const hay = (re) => obs.some((o) => re.test(o.title) || re.test(o.detail || ''));

  eq('avisa de la plataforma que va en pérdida', hay(/Bitso va -41/), true);
  eq('avisa que eToro está desactualizado', hay(/Actualiza el valor de: eToro/), true);
  eq('la meta del mes aparece', hay(/Llevas \$0\.00 de \$6,000\.00/), true);
  eq('dice que hay dinero fuera del cálculo de ganancia', hay(/no entran al cálculo de ganancia/), true);
  eq('no da consejos de compra o venta', obs.some((o) => /compra|vende|vender|comprar/i.test(o.title)), false);

  // Concentración
  const c = fin.investmentSummary({ accounts: cuentas, flows: [],
    values: [{ investment_id: 'mp', as_of: '2026-10-10', value: 900 }, { investment_id: 'etoro', as_of: '2026-10-10', value: 100 }],
    month: '2026-10', asOf: '2026-10-16' });
  eq('avisa de concentración >= 50%',
    fin.investmentInsights(c).some((o) => /concentra el 90%/.test(o.title)), true);

  // Tasa de inversión del mes
  const m = fin.investmentSummary({ accounts: cuentas,
    flows: [{ investment_id: 'etoro', occurred_on: '2026-10-03', amount: 3000, kind: 'deposit' }],
    values: [], month: '2026-10', asOf: '2026-10-16' });
  eq('qué parte de lo que ganaste invertiste',
    fin.investmentInsights(m, { monthIncome: 30000 }).some((o) => /Invertiste el 10%/.test(o.title)), true);
  eq('sin cuentas no hay observaciones', fin.investmentInsights({ rows: [], totals: {}, typeBreakdown: [], goalProgress: null }), []);
});

group('inversiones: validación de lo que se captura', () => {
  const ids = new Set(['a', 'b']);
  const hoy = '2026-10-16';
  const flow = (o = {}) => inv.validateFlow({ investment_id: 'a', occurred_on: '2026-10-10', amount: '1500', kind: 'deposit', ...o }, { accountIds: ids, today: hoy });
  const valor = (o = {}) => inv.validateValue({ investment_id: 'a', as_of: '2026-10-10', value: '11500', ...o }, { accountIds: ids, today: hoy });

  eq('aportación válida', flow().ok, true);
  eq('monto cero se rechaza', flow({ amount: '0' }).ok, false);
  eq('monto negativo se rechaza', flow({ amount: '-5' }).ok, false);
  eq('monto con coma de miles', flow({ amount: '1,500.50' }).value.amount, 1500.5);
  eq('fecha futura se rechaza', flow({ occurred_on: '2026-10-17' }).ok, false);
  eq('hoy sí', flow({ occurred_on: '2026-10-16' }).ok, true);
  eq('fecha imposible', flow({ occurred_on: '2026-02-30' }).ok, false);
  eq('plataforma que no existe', flow({ investment_id: 'zzz' }).ok, false);
  eq('tipo inventado', flow({ kind: 'regalo' }).ok, false);
  eq('retiro es válido', flow({ kind: 'withdrawal' }).ok, true);
  eq('nota larga se rechaza', flow({ note: 'x'.repeat(201) }).ok, false);

  eq('valor válido', valor().ok, true);
  eq('valor CERO es válido (Revolut)', valor({ value: '0' }).value.value, 0);
  eq('valor vacío se rechaza (cero ≠ vacío)', valor({ value: '' }).ok, false);
  eq('valor negativo se rechaza', valor({ value: '-1' }).ok, false);
  eq('valor con texto', valor({ value: 'mucho' }).ok, false);

  eq('meta vacía = sin meta', inv.validateGoal('').value, null);
  eq('meta 6000', inv.validateGoal('6000').value, 6000);
  eq('meta negativa', inv.validateGoal('-1').ok, false);
  eq('meta con letras', inv.validateGoal('abc').ok, false);

  eq('plataforma válida', inv.validateAccount({ name: ' eToro ', type: 'bolsa' }).value.name, 'eToro');
  eq('nombre repetido (sin importar mayúsculas)', inv.validateAccount({ name: 'ETORO', type: 'bolsa' }, { others: ['eToro'] }).ok, false);
  eq('nombre vacío', inv.validateAccount({ name: ' ', type: 'bolsa' }).ok, false);
  eq('tipo inválido', inv.validateAccount({ name: 'X', type: 'casino' }).ok, false);

  // Carga inicial: lo que se escribe a partir del Excel
  const plan = inv.planOnboarding([
    { name: 'Nu', type: 'ahorro', value: '25000', contributed: '' },
    { name: 'eToro', type: 'bolsa', value: '11500', contributed: '10000' },
    { name: 'Didi', type: 'ahorro', value: '', contributed: '' },        // vacía: se omite
    { name: 'Revolut', type: 'ahorro', value: '0', contributed: '' },    // cero explícito: cuenta
  ], { since: '2026-01-01', today: hoy });
  eq('la carga inicial es válida', plan.ok, true);
  eq('omite las vacías', plan.accounts.map((a) => a.name), ['Nu', 'eToro', 'Revolut']);
  eq('sólo eToro tiene aportación', plan.flows.map((f) => f.name), ['eToro']);
  eq('con la fecha de inicio', plan.flows[0].occurred_on, '2026-01-01');
  eq('3 valores, incluido el cero', plan.values.length, 3);
  eq('nombres repetidos se rechazan',
    inv.planOnboarding([{ name: 'A', type: 'otro', value: '1' }, { name: 'a', type: 'otro', value: '1' }], { since: '2026-01-01', today: hoy }).ok, false);
  eq('valor inválido se rechaza',
    inv.planOnboarding([{ name: 'A', type: 'otro', value: 'x' }], { since: '2026-01-01', today: hoy }).ok, false);
  eq('sin nada escrito, avisa',
    inv.planOnboarding([{ name: 'A', type: 'otro', value: '', contributed: '' }], { since: '2026-01-01', today: hoy }).ok, false);
  eq('fecha de inicio futura se rechaza',
    inv.planOnboarding([{ name: 'A', type: 'otro', value: '1' }], { since: '2027-01-01', today: hoy }).ok, false);
});

group('envíos a inversión detectados', () => {
  const cuentas = [
    { id: 'a-etoro', name: 'eToro', archived: false },
    { id: 'a-gbm', name: 'GBM', archived: false },
    { id: 'a-viejo', name: 'Kuspit', archived: true },
  ];
  const tx = (id, fecha, monto, desc, extra = {}) =>
    ({ id, occurred_on: fecha, amount: monto, description: desc, kind: 'transfer', transfer_reason: 'inversion', ...extra });
  const txs = [
    tx('t1', '2026-09-10', 1500, 'SPEI ENVIADO ETORO'),
    tx('t2', '2026-09-20', 2000, 'Transferencia a GBM Homebroker'),
    tx('t3', '2026-09-25', 800, 'SPEI a Kuspit'),                         // plataforma archivada
    tx('t4', '2026-09-26', 300, 'Pago de tarjeta', { transfer_reason: 'pago-tarjeta' }),
    tx('t5', '2026-09-27', 500, 'Compra GBM', { kind: 'expense', transfer_reason: null }),
  ];

  let r = inv.pendingInvestmentTransfers({ transactions: txs, accounts: cuentas, flows: [] });
  eq('sólo los transfer con razón inversión', r.map((x) => x.tx.id), ['t3', 't2', 't1']);
  eq('del más reciente al más viejo y con plataforma sugerida por el nombre',
    r.map((x) => x.suggestedId), [null, 'a-gbm', 'a-etoro']);

  // Ya registrado: mismo monto a ≤ 3 días (el banco a veces fecha distinto)
  r = inv.pendingInvestmentTransfers({
    transactions: txs, accounts: cuentas,
    flows: [{ amount: 1500, occurred_on: '2026-09-12', investment_id: 'a-etoro', kind: 'deposit' }],
  });
  eq('lo ya registrado deja de salir', r.map((x) => x.tx.id), ['t3', 't2']);

  r = inv.pendingInvestmentTransfers({
    transactions: txs, accounts: cuentas,
    flows: [{ amount: 1500, occurred_on: '2026-09-14', investment_id: 'a-etoro', kind: 'deposit' }],
  });
  eq('a 4 días ya no cuenta como el mismo', r.some((x) => x.tx.id === 't1'), true);

  // Uno a uno: dos envíos iguales, una sola aportación registrada
  const dobles = [tx('d1', '2026-09-10', 1000, 'SPEI ETORO'), tx('d2', '2026-09-11', 1000, 'SPEI ETORO')];
  r = inv.pendingInvestmentTransfers({
    transactions: dobles, accounts: cuentas,
    flows: [{ amount: 1000, occurred_on: '2026-09-10', investment_id: 'a-etoro', kind: 'deposit' }],
  });
  eq('un flujo cubre un solo envío', r.length, 1);
  eq('sin datos no truena', inv.pendingInvestmentTransfers().length, 0);
});

// ------------------------------------------------ latido de Supabase
group('el latido decide bien si el proyecto está vivo', () => {
  // Datos reales que cambiaron el diseño: el 14-sep se corrió el SQL y
  // ping() escribió sin problema el 15/17/19/21-sep. El 23-sep el proyecto
  // ya estaba pausado otra vez. O sea: ping() responder 200 NO es garantía
  // de que la pausa no vaya a llegar de todos modos — sólo prueba que el
  // proyecto estaba vivo EN ESE MOMENTO. Por eso ahora siempre avisa.
  const AUTH_OK = {
    status: 200,
    cuerpo: '{"external":{"apple":false},"disable_signup":false,"mailer_autoconfirm":false}',
  };

  // ping() existe y escribió: la señal más fuerte disponible, pero se sigue
  // avisando que no es garantía (ver arriba).
  let r = keepalive.concluir({
    ping: { status: 200, cuerpo: '"2026-09-10T07:14:00Z"' },
    auth: { status: 500 },
  });
  eq('ping ok → éxito', r.exito, true);
  eq('ping ok → vía ping', r.via, 'ping');
  eq('aun con ping ok, avisa que no hay garantía',
    /SUPABASE_DB_URL/.test(r.aviso || ''), true);

  // ping() no existe (falta el SQL) pero GoTrue responde de verdad.
  r = keepalive.concluir({
    ping: { status: 404, cuerpo: '{"code":"PGRST202","message":"Could not find the function"}' },
    auth: AUTH_OK,
  });
  eq('sin SQL pero auth vivo → éxito', r.exito, true);
  eq('vía auth', r.via, 'auth');
  eq('avisa que falta el SQL', /03_keepalive\.sql/.test(r.aviso || ''), true);
  eq('y también que no hay garantía', /SUPABASE_DB_URL/.test(r.aviso || ''), true);

  // Proyecto pausado: nada responde.
  r = keepalive.concluir({
    ping: { status: 0, err: 'fetch failed' },
    auth: { status: 0, err: 'fetch failed' },
  });
  eq('todo caído → NO éxito', r.exito, false);
  eq('nombra que está pausado', /PAUSADO|Restore project/.test(r.mensaje), true);
  eq('y recomienda la conexión directa', /SUPABASE_DB_URL/.test(r.mensaje), true);

  // El dominio resuelve pero devuelve una página de error (5xx), no la API.
  r = keepalive.concluir({
    ping: { status: 503, cuerpo: '<html>service unavailable</html>' },
    auth: { status: 503, cuerpo: '<html>service unavailable</html>' },
  });
  eq('5xx en todo → NO éxito', r.exito, false);

  // auth responde 200 pero con un placeholder que no es GoTrue.
  r = keepalive.concluir({
    ping: { status: 404, cuerpo: 'not found' },
    auth: { status: 200, cuerpo: '<html>project paused</html>' },
  });
  eq('un 200 que no es GoTrue no cuenta', r.exito, false);

  // Timeout en ping, auth bien: sigue contando.
  r = keepalive.concluir({
    ping: { status: 0, err: 'timeout' },
    auth: AUTH_OK,
  });
  eq('timeout en ping pero auth vivo → éxito', r.exito, true);
});

group('leerConfig saca url y llave de config.js', () => {
  const { url, key } = keepalive.leerConfig(
    "const BAKED_IN = {\n  url: 'https://abc.supabase.co/',\n  anonKey: 'sb_publishable_XYZ',\n};",
  );
  eq('quita la diagonal final', url, 'https://abc.supabase.co');
  eq('lee la llave', key, 'sb_publishable_XYZ');

  let tiró = false;
  try { keepalive.leerConfig('const OTRA_COSA = {};'); } catch { tiró = true; }
  eq('falla si no encuentra BAKED_IN', tiró, true);
});

// ------------------------------------------------ rompe-caché de módulos
group('el import map cubre todos los módulos', () => {
  // Un módulo que falte aquí se queda cacheado mientras los demás se
  // actualizan, y la app corre mitad vieja y mitad nueva. Eso ya costó una
  // sesión de depuración: el arreglo estaba publicado, pero el navegador
  // seguía ejecutando el store.js anterior.
  const raiz = new URL('../', import.meta.url);
  const html = fs.readFileSync(new URL('index.html', raiz), 'utf8');

  const mapa = JSON.parse(
    html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/)[1],
  ).imports;

  const listar = (dir, prefijo) => fs.readdirSync(new URL(dir, raiz), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory()
      ? listar(`${dir}${e.name}/`, `${prefijo}${e.name}/`)
      : (e.name.endsWith('.js') ? [`${prefijo}${e.name}`] : [])));

  const modulos = listar('js/', './js/').sort();

  eq('no falta ningún módulo en el import map',
    modulos.filter((m) => !mapa[m]), []);
  eq('no sobra ninguna entrada',
    Object.keys(mapa).filter((k) => !modulos.includes(k)), []);

  // Todas deben apuntar a la MISMA versión: si una se queda atrás, vuelve el
  // problema para ese archivo en concreto.
  const versiones = [...new Set(Object.values(mapa).map((v) => v.split('?v=')[1]))];
  eq('todas apuntan a una sola versión', versiones.length, 1);

  const vEntrada = html.match(/src="\.\/js\/app\.js\?v=(\d+)"/)?.[1];
  const vCss = html.match(/href="\.\/css\/styles\.css\?v=(\d+)"/)?.[1];
  eq('el script de entrada usa esa versión', vEntrada, versiones[0]);
  eq('el CSS usa esa versión', vCss, versiones[0]);
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
