// ---------------------------------------------------------------------------
// Parser dedicado: estado de cuenta BBVA débito (LIBRETON / cuenta de cheques)
//
// Formato real:
//
//   FECHA                                                    SALDO
//   OPER  LIQ   DESCRIPCIÓN   REFERENCIA   CARGOS  ABONOS  OPERACIÓN  LIQUIDACIÓN
//   01/JUL 01/JUL SPEI RECIBIDOMercado Pago              13,648.36
//          0181791744 722 1513083MERCADO*PAGO
//          00722969020510490114
//          JUAN FERNANDO SALINAS CONTRERAS      ← contraparte, en renglón aparte
//   01/JUL 01/JUL PAGO TARJETA DE CREDITO   13,648.36
//          1901658880 CUENTA: BMOV
//   08/JUL 08/JUL RETIRO SIN TARJETA         2,000.00
//   14/JUL 14/JUL PAGO DE NOMINA                20,968.32  20,968.32  20,968.32
//   ...
//   TOTAL IMPORTE CARGOS 56,868.96
//   TOTAL IMPORTE ABONOS 56,868.96
//
// LO IMPORTANTE:
//
// 1. CARGOS y ABONOS son dos columnas distintas y en el texto plano se ven
//    IGUAL. Compara los dos primeros renglones de arriba: mismo monto, mismo
//    aspecto, pero uno es entrada y el otro salida. La única diferencia está en
//    la coordenada X. Por eso este parser trabaja con `line.items`, no con
//    `line.text`. Un parser basado en texto plano aquí se equivoca siempre.
//
// 2. La descripción sigue en los renglones de abajo, y ahí viene el nombre de
//    la contraparte. Es lo que permite saber que un SPEI recibido es dinero que
//    te mandaste tú (transferencia) y no un ingreso.
//
// 3. Sin el punto 2, este estado de cuenta reportaría $56,868.96 de ingresos en
//    julio, cuando lo que realmente entró como ingreso fueron $33,334.96 de
//    nómina. El resto son movimientos entre cuentas propias.
// ---------------------------------------------------------------------------

import { MESES, money, isoDate, stripAccents, tidyDescription } from './common.js';
import { classifyMovement } from './identity.js';
import { buildCheck } from './bbva.js';

const RE_ROW_START = /^(\d{2})\/([A-ZÁÉÍÓÚ]{3})\s+(\d{2})\/([A-ZÁÉÍÓÚ]{3})\s+(.*)$/i;

/**
 * Membrete de página: pie de una hoja y encabezado de la siguiente.
 *
 * Importa filtrarlo porque un movimiento puede empezar al final de una página
 * y su contraparte venir hasta la siguiente. El parser sigue pegando renglones
 * hasta encontrar la próxima fecha, así que sin este filtro se traga el
 * membrete completo — incluido tu número de cuenta — y arma descripciones de
 * cientos de caracteres que la base rechaza.
 */
const RE_PAGE_FURNITURE = new RegExp([
  '^BBVA MEXICO',
  '^Av\\. Paseo de la Reforma',
  '^Estado de Cuenta',
  '^LIBRETON',
  '^PAGINA\\s+\\d+\\s*/\\s*\\d+',
  '^No\\.\\s*de\\s*(Cuenta|Cliente)',
  '^FECHA\\b',
  '^SALDO\\b',
  '^OPER\\b',
  '^Detalle de Movimientos',
  '^Total de Movimientos',
  '^Estado de cuenta de Apartados',
  '^La GAT',
  '^R\\.F\\.C',
  '^www\\.bbva',
].join('|'), 'i');

/** Tope duro de la descripción; la columna de la base acepta 200. */
const MAX_DESC = 200;
const RE_AMOUNT = /^-?[\d,]+\.\d{2}$/;
const RE_PERIODO = /Periodo\s+DEL\s+(\d{2})\/(\d{2})\/(\d{4})\s+AL\s+(\d{2})\/(\d{2})\/(\d{4})/i;
const RE_TOTAL = /^TOTAL IMPORTE (CARGOS|ABONOS)\s+([\d,]+\.\d{2})/i;

export const BANK_ID = 'bbva_debito';
export const BANK_LABEL = 'BBVA (cuenta de débito / LIBRETON)';

export function detect(lines) {
  const head = lines.slice(0, 60).map((l) => l.text).join(' ');
  return /LIBRETON|Detalle de Movimientos Realizados/i.test(head) &&
    /BBVA/i.test(head);
}

/**
 * Ubica las columnas a partir del encabezado de la tabla.
 * Se recalcula en cada página porque el encabezado se repite.
 */
function readColumns(line) {
  const cols = {};
  for (const it of line.items) {
    const key = stripAccents(it.str).toUpperCase();
    if (key === 'CARGOS') cols.cargos = (it.x0 + it.x1) / 2;
    else if (key === 'ABONOS') cols.abonos = (it.x0 + it.x1) / 2;
    else if (key === 'OPERACION') cols.saldoOper = (it.x0 + it.x1) / 2;
    else if (key === 'LIQUIDACION') cols.saldoLiq = (it.x0 + it.x1) / 2;
  }
  return cols.cargos && cols.abonos ? cols : null;
}

/** A qué columna pertenece un monto, por cercanía de su centro. */
function columnOf(item, cols) {
  const center = (item.x0 + item.x1) / 2;
  const candidates = [
    ['cargo', cols.cargos],
    ['abono', cols.abonos],
    ['saldo', cols.saldoOper],
    ['saldo', cols.saldoLiq],
  ].filter(([, x]) => typeof x === 'number');

  let best = null;
  for (const [name, x] of candidates) {
    const d = Math.abs(center - x);
    if (!best || d < best.d) best = { name, d };
  }
  return best?.name ?? null;
}

export function parse(lines, options = {}) {
  const { holderNames = [] } = options;

  const transactions = [];
  const warnings = [];
  const totals = {};
  let period = null;
  let year = null;
  let cols = null;
  let inTable = false;
  let current = null; // movimiento abierto, para pegarle los renglones de abajo

  const flush = () => {
    if (!current) return;
    let description = tidyDescription(current.parts.join(' '));
    if (description.length > MAX_DESC) {
      // Red de seguridad: mejor recortar que reventar la importación entera.
      description = description.slice(0, MAX_DESC - 1).trim() + '…';
    }
    const { kind, reason, internal } = classifyMovement({
      description,
      direction: current.direction,
      holderNames,
    });
    transactions.push({
      bank: BANK_ID,
      occurred_on: current.occurred_on,
      posted_on: current.posted_on,
      description,
      amount: current.amount,
      kind,
      // `direction` es lo que dice el banco (columna CARGOS o ABONOS) y es
      // independiente de cómo lo clasifiquemos. Se conserva porque los totales
      // impresos suman por dirección, no por tipo: un pago de tarjeta es
      // `transfer` para nosotros pero para BBVA es un CARGO.
      direction: current.direction,
      transfer_reason: reason,
      is_internal: internal,
      raw_line: current.raw,
      page: current.page,
    });
    current = null;
  };

  for (const line of lines) {
    const t = line.text;
    const up = stripAccents(t).toUpperCase();

    if (!period) {
      const m = RE_PERIODO.exec(t);
      if (m) {
        period = {
          start: `${m[3]}-${m[2]}-${m[1]}`,
          end: `${m[6]}-${m[5]}-${m[4]}`,
        };
        year = Number(m[3]);
      }
    }

    const mt = RE_TOTAL.exec(t);
    if (mt) { flush(); totals[mt[1].toUpperCase()] = money(mt[2]); inTable = false; continue; }

    // encabezado de la tabla: fija las columnas y abre la sección
    if (up.includes('CARGOS') && up.includes('ABONOS') && up.includes('DESCRIPCION')) {
      const found = readColumns(line);
      if (found) { cols = found; inTable = true; }
      continue;
    }
    if (up.includes('DETALLE DE MOVIMIENTOS REALIZADOS')) { inTable = true; continue; }
    if (up.includes('CUADRO RESUMEN') || up.includes('GLOSARIO DE ABREVIATURAS') ||
        up.includes('ESTADO DE CUENTA DE APARTADOS')) { flush(); inTable = false; continue; }

    if (!inTable || !cols) continue;

    const m = RE_ROW_START.exec(t);
    if (m) {
      // renglón nuevo: cierra el anterior
      flush();

      const [, dOp, monOp, dLiq, monLiq] = m;
      const mmOp = MESES[stripAccents(monOp).toLowerCase()];
      const mmLiq = MESES[stripAccents(monLiq).toLowerCase()];
      if (!mmOp || !year) continue;

      // monto: el que caiga en la columna CARGOS o ABONOS
      let amount = null;
      let direction = null;
      for (const it of line.items) {
        if (!RE_AMOUNT.test(it.str)) continue;
        const col = columnOf(it, cols);
        if (col === 'cargo') { amount = money(it.str); direction = 'out'; break; }
        if (col === 'abono') { amount = money(it.str); direction = 'in'; break; }
      }
      if (amount === null || !Number.isFinite(amount)) {
        warnings.push(`Renglón sin monto reconocible: "${t}"`);
        continue;
      }

      // texto de la descripción: lo que no es fecha ni monto
      const words = line.items
        .filter((it) => !RE_AMOUNT.test(it.str) && !/^\d{2}\/[A-ZÁÉÍÓÚ]{3}$/i.test(it.str))
        .map((it) => it.str);

      current = {
        occurred_on: isoDate(year, mmOp, Number(dOp)),
        posted_on: mmLiq ? isoDate(year, mmLiq, Number(dLiq)) : null,
        parts: [words.join(' ')],
        amount,
        direction,
        raw: t,
        page: line.page,
      };
      continue;
    }

    // renglón de continuación: sigue describiendo el movimiento abierto
    if (current) {
      if (RE_PAGE_FURNITURE.test(t)) continue;
      // se ignoran los códigos de referencia (puros dígitos) para no ensuciar
      const meaningful = t.replace(/\b\d{8,}\b/g, ' ').replace(/\s+/g, ' ').trim();
      if (meaningful && !/^\d+$/.test(meaningful)) current.parts.push(meaningful);
    }
  }
  flush();

  // --- validación contra los totales impresos ------------------------------
  // Se suma por DIRECCIÓN (lo que el banco llama cargo/abono), no por `kind`.
  // Si sumáramos sólo los `expense`, un pago de tarjeta —que clasificamos como
  // transferencia— faltaría y la validación fallaría todos los meses.
  const sumOut = round2(sum(transactions.filter((t) => t.direction === 'out')));
  const sumIn = round2(sum(transactions.filter((t) => t.direction === 'in')));

  const check = buildCheck(
    { label: 'Cargos (salidas)', declared: totals.CARGOS ?? null, computed: sumOut },
    { label: 'Abonos (entradas)', declared: totals.ABONOS ?? null, computed: sumIn },
    warnings,
  );

  // Cuánto efectivo saliste a sacar: alimenta la conciliación de la cartera.
  const cashOut = round2(sum(transactions.filter((t) => t.transfer_reason === 'retiro-efectivo')));

  return {
    bank: BANK_ID,
    transactions,
    period,
    statement: { expense: totals.CARGOS ?? null, income: totals.ABONOS ?? null },
    cashWithdrawn: cashOut,
    check,
    warnings,
  };
}

const sum = (arr) => arr.reduce((a, t) => a + t.amount, 0);
const round2 = (n) => Math.round(n * 100) / 100;
