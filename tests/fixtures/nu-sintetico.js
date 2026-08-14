// Líneas de un estado de cuenta Nu con el MISMO formato que el real, pero con
// comercios y montos inventados.
//
// Cubre a propósito:
//   - movimientos de Cajita (deben quedar como `transfer`)
//   - la sección espejo "movimientos de tus cajitas" (NO se importa)
//   - renglón de tipo de cambio
//   - rendimientos, que no vienen como movimiento pero mueven el saldo
//   - pago de tarjeta: es `transfer` (si no, se contaría doble contra el
//     estado de cuenta de BBVA) pero SÍ cuenta en el total de salidas, porque
//     el dinero sale de la cuenta y Nu lo mete en su renglón de "Gastos"

export const bank = 'nu';

export const lines = [
  'Juan Ejemplo',
  'Cuenta Nu: 00000000000',
  'Periodo: del 01 al 31 jul 2026',
  'Saldo inicial $10,000.00',
  'Depósitos +$2,000.00',
  'Gastos -$2,300.00',
  'Comisiones cobradas por Nu $0.00',
  'Dinero generado este mes $50.00',
  'Saldo al generar este estado de cuenta $9,750.00',
  'Nubank, S.A., Institución de Banca Múltiple',

  'Detalle de movimientos en tu cuenta',
  'FECHA DEL 01 AL 31 JUL 2026 (31 DÍAS) MONTO EN PESOS MEXICANOS',
  '30 JUL 2026 Depósito en Cajita: Cajita Turbo -$500.00',
  '30 JUL 2026 COMERCIO EJEMPLO * Compra -$1,000.00',
  'USD 1.00 = MXN 17.5000 USD 57.14',
  '30 JUL 2026 Retiro de Cajita: Cajita Turbo +$500.00',
  '15 JUL 2026 TRANSFERENCIA RECIBIDA +$2,000.00',
  '12 JUL 2026 Pago de tarjeta de crédito -$800.00',
  '09 JUL 2026 FARMACIA EJEMPLO Compra -$500.00',
  'Con estos movimientos, tu saldo promedio del periodo fue de $10,200.00',

  // Sección espejo: si se importara, duplicaría las Cajitas
  'Detalle de movimientos de tus cajitas',
  'FECHA DEL 01 AL 31 JUL 2026 (31 DÍAS) MONTO EN PESOS MEXICANOS',
  '30 JUL 2026 Depósito en Cajita: Cajita Turbo +$500.00',
  '30 JUL 2026 Retiro de Cajita: Cajita Turbo -$500.00',
].map((text, i) => ({ page: 1 + Math.floor(i / 10), text }));

export const expected = {
  count: 6,            // sin contar los rendimientos opcionales
  expense: 1500.00,    // 1000 + 500 — el pago de tarjeta NO es gasto
  outflow: 2300.00,    // 1500 + 800 — esto es lo que Nu declara como "Gastos"
  income: 2000.00,     // lo que Nu declara como "Depósitos" (para validar)
  transfers: 4,        // dos Cajitas + pago de tarjeta + el depósito propio
  saldoFinal: 9750.00,
  period: { start: '2026-07-01', end: '2026-07-31' },
};
