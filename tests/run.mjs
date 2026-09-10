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
  const YO = ['Juan Fernando Salinas Contreras'];
  const c = (description, direction, extra = {}) =>
    id.classifyMovement({ description, direction, holderNames: YO, ...extra });

  // El caso que rompe todo si no se detecta: te mandas dinero a ti mismo y
  // aparece como ingreso en una cuenta y como gasto en la otra.
  eq('SPEI recibido de mí mismo no es ingreso',
    c('SPEI RECIBIDO Mercado Pago JUAN FERNANDO SALINAS CONTRERAS', 'in').kind, 'transfer');
  eq('SPEI enviado a mí mismo no es gasto',
    c('SPEI ENVIADO Mercado Pago Juan Fernando Salinas Contreras', 'out').kind, 'transfer');
  eq('razón: mismo titular',
    c('Transferencia recibida JUAN FERNANDO SALINAS CONTRERAS', 'in').reason, 'mismo-titular');

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
    id.mentionsHolder('FARMACIA SALINAS', YO), false);
  eq('nombre completo sí',
    id.mentionsHolder('JUAN FERNANDO SALINAS CONTRERAS', YO), true);
  eq('sin acentos y en minúsculas también',
    id.mentionsHolder('juan fernando salinas contreras', YO), true);
  eq('sin nombres configurados no detecta nada',
    id.mentionsHolder('JUAN FERNANDO SALINAS', []), false);
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
    { page: 2, text: 'JUAN FERNANDO SALINAS CONTRERAS', items: [] },
    { page: 2, text: 'TOTAL IMPORTE CARGOS 0.00', items: [] },
    { page: 2, text: 'TOTAL IMPORTE ABONOS 4,000.00', items: [] },
  ];

  const r = bbvaDebito.parse(lines, { holderNames: ['Juan Fernando Salinas Contreras'] });
  const tx = r.transactions[0];

  eq('lee el movimiento', r.transactions.length, 1);
  eq('cabe en la columna', tx.description.length <= 200, true);
  eq('no se traga el membrete', /BBVA MEXICO|LIBRETON|PAGINA|Paseo de la Reforma/.test(tx.description), false);
  eq('no filtra el número de cuenta', /0192649233|A8199334/.test(tx.description), false);
  eq('sí conserva la contraparte', /SALINAS CONTRERAS/.test(tx.description), true);
  eq('y por eso lo marca como transferencia', tx.kind, 'transfer');

  // Red de seguridad final: pase lo que pase, nunca sale algo que la base rechace.
  eq('recorta lo demasiado largo', imp.clampDescription('x'.repeat(500)).length, 200);
  eq('rellena lo vacío', imp.clampDescription('   '), 'Movimiento');
  eq('deja intacto lo normal', imp.clampDescription('  OXXO   COXUMEL  '), 'OXXO COXUMEL');
  eq('tolera null', imp.clampDescription(null), 'Movimiento');
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
    income: { median: 33334, monthsUsed: 3 },
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

// ------------------------------------------------ latido de Supabase
group('el latido decide bien si el proyecto está vivo', () => {
  const AUTH_OK = {
    status: 200,
    cuerpo: '{"external":{"apple":false},"disable_signup":false,"mailer_autoconfirm":false}',
  };

  // ping() existe y escribió: es lo ideal, no importa lo demás.
  let r = keepalive.concluir({
    ping: { status: 200, cuerpo: '"2026-09-10T07:14:00Z"' },
    auth: { status: 500 },
  });
  eq('ping ok → éxito', r.exito, true);
  eq('ping ok → vía ping', r.via, 'ping');
  eq('ping ok → sin aviso', r.aviso, null);

  // ping() no existe (falta el SQL) pero GoTrue responde de verdad.
  r = keepalive.concluir({
    ping: { status: 404, cuerpo: '{"code":"PGRST202","message":"Could not find the function"}' },
    auth: AUTH_OK,
  });
  eq('sin SQL pero auth vivo → éxito', r.exito, true);
  eq('vía auth', r.via, 'auth');
  eq('avisa que falta el SQL', /03_keepalive\.sql/.test(r.aviso || ''), true);

  // Proyecto pausado: nada responde.
  r = keepalive.concluir({
    ping: { status: 0, err: 'fetch failed' },
    auth: { status: 0, err: 'fetch failed' },
  });
  eq('todo caído → NO éxito', r.exito, false);
  eq('nombra que está pausado', /PAUSADO|Restore project/.test(r.mensaje), true);

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
