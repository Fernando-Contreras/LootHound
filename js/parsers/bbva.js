// ---------------------------------------------------------------------------
// Parser dedicado: estado de cuenta BBVA (Tarjeta de crédito)
//
// Estructura real del documento (verificada contra un estado de cuenta):
//
//   ...
//   COMPRAS Y CARGOS DIFERIDOS A MESES SIN INTERESES     ← informativa, NO se importa
//   29-jun-2026 OMNIBUS DE MEXICO $1,845.00 $615.00 ...
//
//   CARGOS,COMPRAS Y ABONOS REGULARES(NO A MESES)        ← aquí sí
//   13-jul-2026 13-jul-2026 CLIP MX*REST ZONG SHEN     + $160.00
//   16-jul-2026 17-jul-2026 MCDONALD S F36212          + $206.67
//   USD $11.79 TIPO DE CAMBIO $17.53                     ← renglón hijo del anterior
//   30-jul-2026 30-jul-2026 BMOVIL.PAGO TDC            - $15,195.89
//   IVA :$ 0.00 Interes: $ 0.00 ...                      ← detalle de pago, se ignora
//   ...
//   TOTAL CARGOS  $38,734.94                             ← se usa para validar
//   TOTAL ABONOS -$16,252.28
//
// Detalles que importan:
//  * Dos fechas por renglón: operación y cargo. Usamos la de OPERACIÓN como
//    fecha del movimiento (es cuando realmente gastaste) y guardamos la de
//    cargo aparte.
//  * El signo va ANTES del monto: "+" = cargo (gasto), "-" = abono.
//  * La línea "USD ... TIPO DE CAMBIO ..." puede quedar en la página siguiente
//    a su movimiento, así que el estado se arrastra entre páginas.
//  * La sección de meses sin intereses repite un cargo que YA viene desglosado
//    en la sección regular ("02 DE 03 OMNIBUS DE MEXICO"); importar ambas
//    duplicaría el gasto.
// ---------------------------------------------------------------------------

import { money, parseSpanishDate, stripAccents, tidyDescription } from './common.js';

const RE_TX = /^(\d{2}-[a-zA-Z]{3}-\d{4})\s+(\d{2}-[a-zA-Z]{3}-\d{4})\s+(.+?)\s+([+-])\s*\$\s*([\d,]+\.\d{2})$/;
const RE_FX = /^USD\s*\$?\s*([\d,]+\.\d{2})\s+TIPO DE CAMBIO\s*\$?\s*([\d,]+\.\d+)$/i;
const RE_TOTAL = /^TOTAL (CARGOS|ABONOS)\s+-?\$([\d,]+\.\d{2})$/i;
const RE_PERIODO = /Periodo:\s*(\d{2}-[a-zA-Z]{3}-\d{4})\s*al\s*(\d{2}-[a-zA-Z]{3}-\d{4})/i;
const RE_TARJETA_DIGITAL = /;\s*Tarjeta Digital\s*\*+(\d+)/i;

/** Un abono ("-") que corresponde a un pago de la tarjeta, no a un reembolso. */
const RE_PAGO = /BMOVIL|PAGO TDC|SU PAGO|PAGO RECIBIDO|SPEI|TRANSFERENCIA|DEPOSITO/i;

export const BANK_ID = 'bbva';
export const BANK_LABEL = 'BBVA (tarjeta de crédito)';

/** Heurística para reconocer el banco a partir del texto del PDF. */
export function detect(lines) {
  const head = lines.slice(0, 80).map((l) => l.text).join(' ').toUpperCase();
  return head.includes('BBVA') &&
    (head.includes('PAGO PARA NO GENERAR INTERESES') || head.includes('TARJETA'));
}

/**
 * @param {Array<{page:number,text:string}>} lines
 * @returns {{bank:string, transactions:Array, period:{start:string,end:string}|null,
 *            statement:{expense:number|null,income:number|null},
 *            check:object, warnings:string[]}}
 */
export function parse(lines) {
  const transactions = [];
  const warnings = [];
  const totals = {};
  let period = null;
  let section = null;
  let last = null; // último movimiento, para colgarle la línea de tipo de cambio

  for (const line of lines) {
    const t = line.text;
    const up = stripAccents(t).toUpperCase();

    if (!period) {
      const m = RE_PERIODO.exec(t);
      if (m) period = { start: parseSpanishDate(m[1]), end: parseSpanishDate(m[2]) };
    }

    const mt = RE_TOTAL.exec(t);
    if (mt) { totals[mt[1].toUpperCase()] = money(mt[2]); continue; }

    // --- secciones -------------------------------------------------------
    if (up.includes('CARGOS,COMPRAS Y ABONOS REGULARES')) { section = 'regular'; continue; }
    if (up.includes('COMPRAS Y CARGOS DIFERIDOS A MESES')) { section = 'msi'; continue; }
    if (up.includes('DETALLE DE TRANSACCIONES DE BENEFICIOS') ||
        up.includes('NOTAS ACLARATORIAS')) { section = 'otra'; continue; }

    // --- tipo de cambio: pertenece al movimiento anterior -----------------
    const mfx = RE_FX.exec(t);
    if (mfx && last) {
      last.original_currency = 'USD';
      last.original_amount = money(mfx[1]);
      last.fx_rate = money(mfx[2]);
      continue;
    }

    if (section !== 'regular') continue;

    const m = RE_TX.exec(t);
    if (!m) continue;

    const [, fOp, fCargo, rawDesc, sign, amt] = m;
    let description = rawDesc.trim();

    // "ANTHROPIC* CLAUDE SUB ; Tarjeta Digital ***6202"
    let cardLast4 = null;
    const mc = RE_TARJETA_DIGITAL.exec(description);
    if (mc) {
      cardLast4 = mc[1];
      description = description.slice(0, mc.index).trim();
    }

    const kind = sign === '+'
      ? 'expense'
      : (RE_PAGO.test(description) ? 'transfer' : 'income');

    const tx = {
      bank: BANK_ID,
      occurred_on: parseSpanishDate(fOp),
      posted_on: parseSpanishDate(fCargo),
      description: tidyDescription(description),
      amount: money(amt),
      kind,
      raw_line: t,
      page: line.page,
    };
    if (cardLast4) tx.card_last4 = cardLast4;

    if (!tx.occurred_on || !Number.isFinite(tx.amount)) {
      warnings.push(`No se pudo leer bien este renglón: "${t}"`);
      continue;
    }
    transactions.push(tx);
    last = tx;
  }

  // --- validación contra los totales impresos en el propio PDF -------------
  const sumExpense = round2(sum(transactions.filter((t) => t.kind === 'expense')));
  const sumIncome = round2(sum(transactions.filter((t) => t.kind !== 'expense')));

  const check = buildCheck(
    { label: 'Cargos', declared: totals.CARGOS ?? null, computed: sumExpense },
    { label: 'Abonos', declared: totals.ABONOS ?? null, computed: sumIncome },
    warnings,
  );

  return {
    bank: BANK_ID,
    transactions,
    period,
    statement: { expense: totals.CARGOS ?? null, income: totals.ABONOS ?? null },
    check,
    warnings,
  };
}

// --------------------------------------------------------------------------
const sum = (arr) => arr.reduce((a, t) => a + t.amount, 0);
const round2 = (n) => Math.round(n * 100) / 100;

export function buildCheck(a, b, warnings) {
  const rows = [a, b].map((r) => ({
    ...r,
    ok: r.declared === null ? null : Math.abs(r.declared - r.computed) < 0.01,
    diff: r.declared === null ? null : round2(r.computed - r.declared),
  }));
  for (const r of rows) {
    if (r.ok === false) {
      warnings.push(
        `${r.label}: el PDF declara $${r.declared.toFixed(2)} pero se sumaron ` +
        `$${r.computed.toFixed(2)} (diferencia $${r.diff.toFixed(2)}). ` +
        `Revisa el preview antes de importar.`,
      );
    }
  }
  return { rows, ok: rows.every((r) => r.ok !== false) };
}
