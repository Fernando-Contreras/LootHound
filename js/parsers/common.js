// Utilidades compartidas por los parsers de banco.

export const MESES = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12,
};

// \p{Mn} = "Nonspacing Mark": las marcas diacríticas que deja NFD al separar
// la letra de su acento. Se usa la clase Unicode en vez de un rango literal
// para que el archivo no dependa de la codificación con que se guarde.
const COMBINING_MARKS = /\p{Mn}/gu;

/** Quita acentos: "DÍAS" → "DIAS". Nu escribe los meses en mayúsculas con acento. */
export function stripAccents(s) {
  return String(s).normalize('NFD').replace(COMBINING_MARKS, '');
}

/** "$1,234.56" → 1234.56 */
export function money(s) {
  return parseFloat(String(s).replace(/[$,\s]/g, ''));
}

/** Arma una fecha ISO sin pasar por `new Date()` (evita corrimientos de zona horaria). */
export function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "13-jul-2026" → "2026-07-13" */
export function parseSpanishDate(s) {
  const [d, m, y] = String(s).split('-');
  const mm = MESES[stripAccents(m).toLowerCase()];
  if (!mm) return null;
  return isoDate(y, mm, parseInt(d, 10));
}

/**
 * Normaliza una descripción para comparar/deduplicar:
 * sin acentos, mayúsculas, sólo alfanuméricos y espacios simples.
 */
export function normalizeDescription(s) {
  return stripAccents(s)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Limpia basura al final de la descripción que dejan los bancos ("FANDANGO *"). */
export function tidyDescription(s) {
  return String(s).replace(/[\s*.·-]+$/, '').replace(/\s+/g, ' ').trim();
}
