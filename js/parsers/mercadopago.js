// ---------------------------------------------------------------------------
// Parser dedicado: Mercado Pago (ESTADO DE SALDOS Y MOVIMIENTOS)
//
// Formato real:
//
//   Entradas: $ 24,050.30
//   Saldo inicial: $ 7,117.59    Saldo final: $ 17,782.25
//   Salidas: $ -13,385.64
//
//   Fecha       Descripción              ID de la operación   Valor      Saldo
//   03-08-2026  Ganancia                 1747722125793        $ 9.70     $ 19,256.23
//   02-08-2026  Transferencia enviada JuanFer Nu  171781865146 $ -8,000.00 $ 19,246.53
//
//               Transferencia enviada Juan          ← la descripción se parte
//   11-08-2026                          173330789324 $ -1,500.00 $ 17,777.18
//               Fernando Salinas Contreras          ← en varios renglones
//
// LO IMPORTANTE:
//
// 1. La descripción se parte en hasta 3 renglones, arriba y abajo del renglón
//    que trae la fecha y el monto. Se agrupa cada fragmento con su movimiento
//    más cercano en Y (los movimientos van separados ~30 pt y los fragmentos
//    caen a ±13 pt, así que la asignación por cercanía no se equivoca).
//
// 2. Una descripción puede empezar al final de una página y terminar en la
//    siguiente. Lo que queda huérfano al pie se arrastra al primer movimiento
//    de la página que sigue.
//
// 3. "Transferencia recibida JUAN FERNANDO SALINAS CONTRERAS" es dinero que te
//    mandaste tú desde otro banco, NO un ingreso. Lo mismo al revés. Sólo
//    "Ganancia" (rendimientos y cashback) es ingreso de verdad aquí.
// ---------------------------------------------------------------------------

import { money, tidyDescription } from './common.js';
import { classifyMovement } from './identity.js';
import { buildCheck } from './bbva.js';

const RE_DATE = /^(\d{2})-(\d{2})-(\d{4})$/;
// pdf.js entrega el monto con el signo de peso pegado: "$ 3,000.00", "$ -8,000.00".
const RE_AMOUNT = /^\$?\s*(-?[\d,]+\.\d{2})$/;
const isAmount = (s) => RE_AMOUNT.test(String(s).trim());
const amountValue = (s) => money(RE_AMOUNT.exec(String(s).trim())[1]);
const RE_PERIODO = /Periodo:\s*Del\s+(\d{1,2})\s+de\s+(\w+)\s+al\s+(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i;

const RESUMEN = {
  entradas: /^Entradas:\s*\$\s*([\d,]+\.\d{2})$/i,
  salidas: /^Salidas:\s*\$\s*-?([\d,]+\.\d{2})$/i,
  saldo_inicial: /Saldo inicial:\s*\$\s*([\d,]+\.\d{2})/i,
  saldo_final: /Saldo final:\s*\$\s*([\d,]+\.\d{2})/i,
};

// Columnas aproximadas (el formato es fijo, ancho de página 446 pt)
const X_DESC_MIN = 88;
const X_DESC_MAX = 210;

export const BANK_ID = 'mercadopago';
export const BANK_LABEL = 'Mercado Pago';

export function detect(lines) {
  const head = lines.slice(0, 40).map((l) => l.text).join(' ');
  return /ESTADO DE SALDOS Y MOVIMIENTOS/i.test(head) ||
    /MP Agregador|mercadopago\.com/i.test(lines.map((l) => l.text).join(' '));
}

export function parse(lines, options = {}) {
  const { holderNames = [] } = options;

  const summary = {};
  const warnings = [];
  let period = null;

  for (const line of lines) {
    for (const [key, rx] of Object.entries(RESUMEN)) {
      if (summary[key] === undefined) {
        const m = rx.exec(line.text);
        if (m) summary[key] = money(m[1]);
      }
    }
    if (!period) {
      const m = RE_PERIODO.exec(line.text);
      if (m) period = { start: null, end: null, raw: m[0] };
    }
  }

  // ---- agrupar por página: anclas (fecha + valor) y fragmentos sueltos ----
  const byPage = new Map();
  for (const line of lines) {
    if (!byPage.has(line.page)) byPage.set(line.page, []);
    byPage.get(line.page).push(line);
  }

  const rows = [];
  let carryOver = ''; // descripción huérfana al pie de una página

  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const pageLines = byPage.get(page);
    const anchors = [];
    const fragments = [];

    for (const line of pageLines) {
      const dateItem = line.items.find((it) => RE_DATE.test(it.str.trim()));
      const amounts = line.items.filter((it) => isAmount(it.str));

      if (dateItem && amounts.length >= 1) {
        const m = RE_DATE.exec(dateItem.str.trim());
        anchors.push({
          y: line.y,
          page,
          occurred_on: `${m[3]}-${m[2]}-${m[1]}`,
          // el primero de los montos es el Valor; el último es el Saldo
          value: amountValue(amounts[0].str),
          parts: line.items
            .filter((it) => it.x0 >= X_DESC_MIN && it.x0 <= X_DESC_MAX && !isAmount(it.str))
            .map((it) => it.str),
          raw: line.text,
        });
      } else {
        const desc = line.items
          .filter((it) => it.x0 >= X_DESC_MIN && it.x0 <= X_DESC_MAX)
          .map((it) => it.str)
          .join(' ')
          .trim();
        // se descartan los encabezados y los números de referencia sueltos
        if (desc && !/^(Descripción|ID de la|operación|Fecha|Valor|Saldo)$/i.test(desc) &&
            !/^\d+$/.test(desc)) {
          fragments.push({ y: line.y, text: desc });
        }
      }
    }

    anchors.sort((a, b) => a.y - b.y);

    // el sobrante de la página anterior pertenece al primer movimiento de ésta
    if (carryOver && anchors.length) {
      anchors[0].parts.unshift(carryOver);
      carryOver = '';
    }

    // cada fragmento se pega al ancla más cercana en Y
    const leftovers = [];
    for (const frag of fragments) {
      let best = null;
      for (const a of anchors) {
        const d = Math.abs(a.y - frag.y);
        if (!best || d < best.d) best = { a, d };
      }
      // 18 pt: más que la altura de un renglón partido, menos que la
      // separación entre movimientos (~30 pt)
      if (best && best.d <= 18) {
        if (frag.y < best.a.y) best.a.parts.unshift(frag.text);
        else best.a.parts.push(frag.text);
      } else {
        leftovers.push(frag);
      }
    }

    // lo que quedó al final de la página se arrastra a la siguiente
    const lastY = anchors.length ? anchors[anchors.length - 1].y : -Infinity;
    const tail = leftovers.filter((f) => f.y > lastY).map((f) => f.text).join(' ').trim();
    if (tail) carryOver = tail;

    rows.push(...anchors);
  }

  // ---- convertir a movimientos -------------------------------------------
  const transactions = [];
  for (const row of rows) {
    const description = tidyDescription(row.parts.join(' '));
    if (!description) continue;
    if (!Number.isFinite(row.value)) {
      warnings.push(`Movimiento sin monto legible: "${row.raw}"`);
      continue;
    }
    const direction = row.value < 0 ? 'out' : 'in';
    const { kind, reason, internal } = classifyMovement({
      description, direction, holderNames,
    });

    transactions.push({
      bank: BANK_ID,
      occurred_on: row.occurred_on,
      posted_on: null,
      description,
      amount: Math.abs(row.value),
      kind,
      direction,
      transfer_reason: reason,
      is_internal: internal,
      raw_line: row.raw,
      page: row.page,
    });
  }

  // ---- validación ---------------------------------------------------------
  const sumIn = round2(sum(transactions.filter((t) => t.direction === 'in')));
  const sumOut = round2(sum(transactions.filter((t) => t.direction === 'out')));

  const check = buildCheck(
    { label: 'Entradas', declared: summary.entradas ?? null, computed: sumIn },
    { label: 'Salidas', declared: summary.salidas ?? null, computed: sumOut },
    warnings,
  );

  if (summary.saldo_inicial !== undefined && summary.saldo_final !== undefined) {
    const reconstructed = round2(summary.saldo_inicial + sumIn - sumOut);
    check.balance = {
      label: 'Saldo final',
      declared: summary.saldo_final,
      computed: reconstructed,
      ok: Math.abs(reconstructed - summary.saldo_final) < 0.01,
    };
    if (!check.balance.ok) {
      check.ok = false;
      warnings.push(
        `El saldo final reconstruido ($${reconstructed.toFixed(2)}) no coincide con ` +
        `el declarado ($${summary.saldo_final.toFixed(2)}).`,
      );
    }
  }

  if (period && transactions.length) {
    const fechas = transactions.map((t) => t.occurred_on).sort();
    period.start = fechas[0];
    period.end = fechas[fechas.length - 1];
  }

  return {
    bank: BANK_ID,
    transactions,
    period,
    statement: { expense: summary.salidas ?? null, income: summary.entradas ?? null },
    summary,
    check,
    warnings,
  };
}

const sum = (arr) => arr.reduce((a, t) => a + t.amount, 0);
const round2 = (n) => Math.round(n * 100) / 100;
