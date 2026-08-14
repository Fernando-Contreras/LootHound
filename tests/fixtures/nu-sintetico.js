// Líneas de un estado de cuenta Nu con el MISMO formato que el real, pero con
// comercios y montos inventados.
//
// Cubre a propósito:
//   - movimientos de Cajita (deben quedar como `transfer`)
//   - la sección espejo "movimientos de tus cajitas" (NO se importa)
//   - renglón de tipo de cambio
//   - rendimientos, que no vienen como movimiento pero mueven el saldo

export const bank = 'nu';

export const lines = [
  'Juan Ejemplo',
  'Cuenta Nu: 00000000000',
  'Periodo: del 01 al 31 jul 2026',
  'Saldo inicial $10,000.00',
  'Depósitos +$2,000.00',
  'Gastos -$1,500.00',
  'Comisiones cobradas por Nu $0.00',
  'Dinero generado este mes $50.00',
  'Saldo al generar este estado de cuenta $10,550.00',
  'Nubank, S.A., Institución de Banca Múltiple',

  'Detalle de movimientos en tu cuenta',
  'FECHA DEL 01 AL 31 JUL 2026 (31 DÍAS) MONTO EN PESOS MEXICANOS',
  '30 JUL 2026 Depósito en Cajita: Cajita Turbo -$500.00',
  '30 JUL 2026 COMERCIO EJEMPLO * Compra -$1,000.00',
  'USD 1.00 = MXN 17.5000 USD 57.14',
  '30 JUL 2026 Retiro de Cajita: Cajita Turbo +$500.00',
  '15 JUL 2026 TRANSFERENCIA RECIBIDA +$2,000.00',
  '09 JUL 2026 FARMACIA EJEMPLO Compra -$500.00',
  'Con estos movimientos, tu saldo promedio del periodo fue de $10,200.00',

  // Sección espejo: si se importara, duplicaría las Cajitas
  'Detalle de movimientos de tus cajitas',
  'FECHA DEL 01 AL 31 JUL 2026 (31 DÍAS) MONTO EN PESOS MEXICANOS',
  '30 JUL 2026 Depósito en Cajita: Cajita Turbo +$500.00',
  '30 JUL 2026 Retiro de Cajita: Cajita Turbo -$500.00',
].map((text, i) => ({ page: 1 + Math.floor(i / 10), text }));

export const expected = {
  count: 5,            // sin contar los rendimientos opcionales
  expense: 1500.00,    // 1000 + 500
  income: 2000.00,
  transfers: 2,        // las dos Cajitas de la sección de la cuenta
  saldoFinal: 10550.00,
  period: { start: '2026-07-01', end: '2026-07-31' },
};
