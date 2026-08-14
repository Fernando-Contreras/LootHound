// ---------------------------------------------------------------------------
// Parser dedicado: estado de cuenta Nu (cuenta de débito)
//
// Estructura real del documento (verificada contra un estado de cuenta):
//
//   Saldo inicial                              $23,835.78     ← resumen p.1
//   Depósitos                                       +$0.00
//   Gastos                                      -$4,248.53
//   Dinero generado este mes                      $199.00
//   Saldo al generar este estado de cuenta     $19,786.25
//   ...
//   Detalle de movimientos en tu cuenta                        ← aquí sí
//   30 JUL 2026 FANDANGO * Compra                 -$897.03
//   USD 1.00 = MXN 17.5133 USD 51.22                           ← renglón hijo
//   30 JUL 2026 Retiro de Cajita: Cajita Turbo  +$1,500.00
//   ...
//   Detalle de movimientos de tus cajitas                      ← espejo, NO se importa
//
// Detalles que importan:
//  * Nu pone la fecha y la descripción del mismo movimiento con 1–2 pt de
//    diferencia en Y; lines.js las une con tolerancia. Sin eso, no parsea.
//  * "Depósito en Cajita" / "Retiro de Cajita" son movimientos INTERNOS de
//    ahorro. Nu mismo los excluye de su total de "Gastos". Se marcan como
//    `transfer` para que no ensucien el balance.
//  * La sección "Detalle de movimientos de tus cajitas" es el espejo exacto de
//    esos movimientos internos: importarla duplicaría todo.
//  * El interés ("Dinero generado este mes") NO aparece como movimiento; se
//    ofrece aparte como ingreso opcional, porque sí afecta el saldo final.
// ---------------------------------------------------------------------------

import { MESES, money, isoDate, stripAccents, tidyDescription } from './common.js';
import { buildCheck } from './bbva.js';

const RE_TX = /^(\d{2})\s+([A-Za-zÁÉÍÓÚáéíóú]{3})\s+(\d{4})\s+(.+?)\s+([+-])\$([\d,]+\.\d{2})$/;
const RE_FX = /^USD\s*1(?:\.00)?\s*=\s*MXN\s*([\d,]+\.\d+)\s+USD\s*([\d,]+(?:\.\d+)?)$/i;
const RE_CAJITA = /^(Dep[oó]sito en|Retiro de)\s+Cajita/i;

// Salidas de dinero que NO son gasto: pagar una tarjeta o mandarte dinero a ti
// mismo. Sin esto se contarían doble — el pago sale como gasto en Nu y las
// compras de esa tarjeta salen como gasto otra vez en el estado de BBVA.
//
// OJO: el estado de cuenta con el que se verificó el parser no traía ningún
// pago de tarjeta, así que estos patrones son una heurística, no algo
// confirmado contra el formato real. El preview permite corregir el tipo de
// cada renglón antes de importar; si ves que un pago tuyo no cae aquí, agrega
// su texto a esta lista.
const RE_TRANSFER_OUT = /pago (de |a )?(tu )?tarjeta|pago tdc|tarjeta de cr[eé]dito|spei|transferencia (enviada|a terceros|entre cuentas)|env[ií]o de dinero/i;
const RE_PERIODO = /Periodo:\s*del\s*(\d{2})\s*al\s*(\d{2})\s*([A-Za-zÁÉÍÓÚáéíóú]{3})\s*(\d{4})/i;

const RESUMEN = {
  saldo_inicial: /^Saldo inicial\s+\$([\d,]+\.\d{2})$/i,
  depositos: /^Dep[oó]sitos\s+\+\$([\d,]+\.\d{2})$/i,
  gastos: /^Gastos\s+-\$([\d,]+\.\d{2})$/i,
  comisiones: /^Comisiones cobradas por Nu\s+\$([\d,]+\.\d{2})$/i,
  rendimientos: /^Dinero generado este mes\s+\$([\d,]+\.\d{2})$/i,
  saldo_final: /^Saldo al generar este estado de cuenta\s+\$([\d,]+\.\d{2})$/i,
};

export const BANK_ID = 'nu';
export const BANK_LABEL = 'Nu (cuenta de débito)';

export function detect(lines) {
  const head = lines.slice(0, 60).map((l) => l.text).join(' ');
  return /Cuenta Nu:|Nubank, S\.A\./i.test(head);
}

export function parse(lines) {
  const transactions = [];
  const warnings = [];
  const summary = {};
  let period = null;
  let section = null;
  let last = null;

  for (const line of lines) {
    const t = line.text;
    const low = stripAccents(t).toLowerCase();

    for (const [key, rx] of Object.entries(RESUMEN)) {
      if (summary[key] === undefined) {
        const m = rx.exec(t);
        if (m) summary[key] = money(m[1]);
      }
    }

    if (!period) {
      const m = RE_PERIODO.exec(t);
      if (m) {
        const mm = MESES[stripAccents(m[3]).toLowerCase()];
        if (mm) {
          period = {
            start: isoDate(m[4], mm, parseInt(m[1], 10)),
            end: isoDate(m[4], mm, parseInt(m[2], 10)),
          };
        }
      }
    }

    // --- secciones -------------------------------------------------------
    if (low.includes('detalle de movimientos en tu cuenta')) { section = 'cuenta'; continue; }
    if (low.includes('detalle de movimientos de tus cajitas')) { section = 'cajitas'; continue; }

    // --- tipo de cambio: pertenece al movimiento anterior -----------------
    const mfx = RE_FX.exec(t);
    if (mfx && last) {
      last.original_currency = 'USD';
      last.fx_rate = money(mfx[1]);
      last.original_amount = money(mfx[2]);
      continue;
    }

    if (section !== 'cuenta') continue;

    const m = RE_TX.exec(t);
    if (!m) continue;

    const [, dd, mon, yyyy, rawDesc, sign, amt] = m;
    const mm = MESES[stripAccents(mon).toLowerCase()];
    if (!mm) continue;

    const description = rawDesc.trim();

    // Dos clases de transferencia, y la diferencia importa para validar:
    //   - Cajita: el dinero NO sale de la cuenta, sólo se aparta. Nu lo excluye
    //     de su total de "Gastos".
    //   - pago de tarjeta / SPEI: el dinero SÍ sale de la cuenta, así que Nu
    //     SÍ lo cuenta en "Gastos" (si no, su saldo no cerraría).
    // Ambas son `transfer` para el balance de la app, pero sólo la segunda
    // debe sumarse al comparar contra el total impreso.
    const isCajita = RE_CAJITA.test(description);
    const isExternalTransfer = !isCajita && RE_TRANSFER_OUT.test(description) && sign === '-';

    let kind;
    if (isCajita || isExternalTransfer) kind = 'transfer';
    else kind = sign === '-' ? 'expense' : 'income';

    const tx = {
      bank: BANK_ID,
      occurred_on: isoDate(yyyy, mm, parseInt(dd, 10)),
      posted_on: null,
      // Nu le pega " Compra" al nombre del comercio
      description: tidyDescription(description.replace(/\s+Compra$/i, '')),
      amount: money(amt),
      kind,
      raw_line: t,
      page: line.page,
    };
    // marca interna: no se guarda en la base, sólo sirve para la validación
    if (isExternalTransfer) tx._leavesAccount = true;

    if (!Number.isFinite(tx.amount)) {
      warnings.push(`No se pudo leer bien este renglón: "${t}"`);
      continue;
    }
    transactions.push(tx);
    last = tx;
  }

  // --- ingreso opcional por rendimientos -----------------------------------
  // No viene como movimiento pero sí mueve el saldo. Se marca `optional` para
  // que el preview lo muestre desmarcado y el usuario decida.
  const extras = [];
  if (summary.rendimientos > 0 && period) {
    extras.push({
      bank: BANK_ID,
      occurred_on: period.end,
      posted_on: null,
      description: 'Rendimientos Nu',
      amount: summary.rendimientos,
      kind: 'income',
      raw_line: `Dinero generado este mes $${summary.rendimientos.toFixed(2)}`,
      optional: true,
      page: 1,
    });
  }

  // Todo lo que sale de la cuenta: gastos + transferencias externas (pagos de
  // tarjeta, SPEI). Es lo que Nu mete en su renglón de "Gastos".
  // Las Cajitas quedan fuera, igual que las deja Nu.
  const outflow = round2(sum(transactions.filter(
    (t) => t.kind === 'expense' || t._leavesAccount)));
  const sumIncome = round2(sum(transactions.filter((t) => t.kind === 'income')));

  const check = buildCheck(
    { label: 'Salidas', declared: summary.gastos ?? null, computed: outflow },
    { label: 'Depósitos', declared: summary.depositos ?? null, computed: sumIncome },
    warnings,
  );

  // Comprobación extra: saldo inicial + depósitos + rendimientos - salidas = saldo final
  if (['saldo_inicial', 'saldo_final', 'rendimientos'].every((k) => summary[k] !== undefined)) {
    const reconstructed = round2(
      summary.saldo_inicial + (summary.depositos ?? 0) + summary.rendimientos - outflow,
    );
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

  return {
    bank: BANK_ID,
    transactions: transactions.concat(extras),
    period,
    statement: { expense: summary.gastos ?? null, income: summary.depositos ?? null },
    summary,
    check,
    warnings,
  };
}

const sum = (arr) => arr.reduce((a, t) => a + t.amount, 0);
const round2 = (n) => Math.round(n * 100) / 100;
