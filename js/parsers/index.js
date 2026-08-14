// Registro de parsers por banco. Para agregar otro banco: escribe un módulo
// con {BANK_ID, BANK_LABEL, detect(lines), parse(lines)} y agrégalo aquí.

import { pdfToLines } from './lines.js';
import * as bbva from './bbva.js';
import * as bbvaDebito from './bbva-debito.js';
import * as nu from './nu.js';
import * as mercadopago from './mercadopago.js';

// El orden importa: bbva-debito se prueba antes que bbva porque ambos
// mencionan "BBVA" y el de crédito es el más genérico de los dos.
export const PARSERS = [bbvaDebito, bbva, nu, mercadopago];

export function parserFor(bankId) {
  return PARSERS.find((p) => p.BANK_ID === bankId) || null;
}

/**
 * Adivina el banco a partir del contenido.
 * Si más de uno dice reconocerlo, gana el primero de `PARSERS` (el más
 * específico), en vez de rendirse: los dos formatos de BBVA se parecen.
 */
export function detectBank(lines) {
  const hit = PARSERS.find((p) => p.detect(lines));
  return hit ? hit.BANK_ID : null;
}

/**
 * Procesa un PDF completo en el navegador.
 * @param {ArrayBuffer} buffer  contenido del archivo (nunca sale del dispositivo)
 * @param {string|null} bankId  fuerza un banco; si es null se autodetecta
 * @param {object} options      se pasa al parser (p. ej. holderNames)
 */
export async function parseStatement(buffer, bankId = null, options = {}) {
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

  const result = parser.parse(lines, options);
  result.lineCount = lines.length;
  if (!result.transactions.length) {
    result.warnings.push(
      'No se encontró ningún movimiento. ¿Es el estado de cuenta correcto, o cambió el formato?',
    );
  }
  return result;
}
