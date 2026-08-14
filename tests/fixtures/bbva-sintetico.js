// Líneas de un estado de cuenta BBVA con el MISMO formato que el real, pero
// con comercios y montos inventados. Nunca metas aquí un estado de cuenta de
// verdad: este repo es público.
//
// Cubre a propósito los casos difíciles:
//   - sección de meses sin intereses (no se debe importar)
//   - renglón de tipo de cambio que cae en la página siguiente
//   - abono de pago de tarjeta (transfer) con su detalle de IVA/capital
//   - "; Tarjeta Digital ***0000"
//   - dos renglones idénticos el mismo día (deben entrar los dos)

export const bank = 'bbva';

export const lines = [
  'BBVA MEXICO, S.A., INSTITUCION DE BANCA MULTIPLE',
  'Periodo: 13-jul-2026 al 12-ago-2026',
  'TARJETA ORO BBVA (ORO)',
  'PAGO PARA NO GENERAR INTERESES2 $4,321.00',
  'Número de cuenta: XXXXXX0000 Página 3 de 9',

  'COMPRAS Y CARGOS DIFERIDOS A MESES SIN INTERESES Tarjeta titular: XXXXXXXXXXXX0000',
  'Fecha de la Monto Saldo Pago Núm. de',
  // Este renglón NO debe importarse: es informativo y su mensualidad ya viene
  // desglosada abajo como "02 DE 03 TIENDA EJEMPLO".
  '29-jun-2026 TIENDA EJEMPLO $900.00 $300.00 $300.00 2 de 3 0.00%',

  'CARGOS,COMPRAS Y ABONOS REGULARES(NO A MESES) Tarjeta titular: XXXXXXXXXXXX0000',
  'Fecha de la Descripción del movimiento Monto',
  '13-jul-2026 13-jul-2026 CAFETERIA EJEMPLO + $100.00',
  '13-jul-2026 13-jul-2026 CAFETERIA EJEMPLO + $100.00',
  '14-jul-2026 15-jul-2026 TIENDA DE BARRIO 12 + $250.50',
  '16-jul-2026 17-jul-2026 COMERCIO EXTRANJERO + $200.00',
  'USD $11.42 TIPO DE CAMBIO $17.51',
  '20-jul-2026 20-jul-2026 SERVICIO MENSUAL ; Tarjeta Digital ***0000 + $199.00',
  '25-jul-2026 25-jul-2026 BMOVIL.PAGO TDC - $1,000.00',
  'IVA :$ 0.00 Interes: $ 0.00 Comisiones:$0.00 Capital:$1,000.00 Capital',
  'de promoción:$0.00 Pago excedente:$0.00',
  '28-jul-2026 28-jul-2026 DEVOLUCION COMERCIO - $150.00',
  // último renglón de la página: su tipo de cambio queda en la siguiente
  '30-jul-2026 31-jul-2026 OTRO EXTRANJERO + $350.00',

  'Notas: Ver notas en la sección “NOTAS ACLARATORIAS” en este estado de cuenta.',
  'Número de cuenta: XXXXXX0000 Página 4 de 9',
  'CARGOS,COMPRAS Y ABONOS REGULARES(NO A MESES) Tarjeta titular: XXXXXXXXXXXX0000',
  'USD $20.00 TIPO DE CAMBIO $17.50',
  '12-ago-2026 13-ago-2026 02 DE 03 TIENDA EJEMPLO ; Tarjeta Digital ***0000 + $300.00',

  'TOTAL CARGOS $1,499.50',
  'TOTAL ABONOS -$1,150.00',
  'NOTAS ACLARATORIAS',
  '1. Tienes como límite esta fecha para realizar tu pago',
].map((text, i) => ({ page: 1 + Math.floor(i / 22), text }));

export const expected = {
  count: 9,
  expense: 1499.50,   // 100+100+250.50+200+199+350+300
  income: 150.00,     // devolución
  transfer: 1000.00,  // pago de la tarjeta
  period: { start: '2026-07-13', end: '2026-08-12' },
};
