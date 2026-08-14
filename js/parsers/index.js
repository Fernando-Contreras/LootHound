// Registro de parsers por banco. Para agregar otro banco: escribe un módulo
// con {BANK_ID, BANK_LABEL, detect(lines), parse(lines)} y agrégalo aquí.

import { pdfToLines } from './lines.js';
import * as bbva from './bbva.js';
import * as nu from './nu.js';

export const PARSERS = [bbva, nu];

export function parserFor(bankId) {
  return PARSERS.find((p) => p.BANK_ID === bankId) || null;
}

/** Adivina el banco a partir del contenido. Devuelve null si no está seguro. */
export function detectBank(lines) {
  const hits = PARSERS.filter((p) => p.detect(lines));
  return hits.length === 1 ? hits[0].BANK_ID : null;
}

/**
 * Procesa un PDF completo en el navegador.
 * @param {ArrayBuffer} buffer  contenido del archivo (nunca sale del dispositivo)
 * @param {string|null} bankId  fuerza un banco; si es null se autodetecta
 */
export async function parseStatement(buffer, bankId = null) {
  const lines = await pdfToLines(buffer);
  if (!lines.length) {
    throw new Error(
      'No se pudo extraer texto del PDF. Si es un escaneo (imagen), este parser ' +
      'no puede leerlo: necesita el PDF original que descargas del banco.',
    );
  }

  const id = bankId || detectBank(lines);
  if (!id) {
    throw new Error('No reconocí el banco de este estado de cuenta. Selecciónalo a mano.');
  }
  const parser = parserFor(id);
  if (!parser) throw new Error(`No hay parser para "${id}".`);

  const result = parser.parse(lines);
  result.lineCount = lines.length;
  if (!result.transactions.length) {
    result.warnings.push(
      'No se encontró ningún movimiento. ¿Es el estado de cuenta correcto, o cambió el formato?',
    );
  }
  return result;
}
