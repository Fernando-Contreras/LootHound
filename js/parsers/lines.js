// ---------------------------------------------------------------------------
// De PDF a líneas de texto — 100% en el navegador.
//
// pdf.js entrega "items" sueltos con una matriz de transformación cada uno; no
// entrega renglones. Los estados de cuenta de Nu además ponen la fecha y la
// descripción del MISMO movimiento con 1–2 puntos de diferencia en Y, así que
// agrupar por Y exacta los partiría en dos. Por eso agrupamos con tolerancia.
// ---------------------------------------------------------------------------

/** Tolerancia vertical en puntos para considerar que dos items van en la misma línea. */
const Y_TOLERANCE = 3.0;

/** Separación horizontal mínima (en puntos) para insertar un espacio entre items. */
const X_GAP_SPACE = 0.8;

/**
 * Carga pdf.js desde /vendor (copia local, no CDN) sólo cuando se va a usar.
 * Al ser local, procesar un PDF no genera NI UNA petición de red: se puede
 * comprobar en la pestaña Network del navegador.
 */
let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../../vendor/pdf.min.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        '../../vendor/pdf.worker.min.mjs', import.meta.url,
      ).href;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/**
 * Extrae el texto de un PDF y lo devuelve como líneas reconstruidas.
 * El archivo NUNCA sale del navegador: se lee como ArrayBuffer y se procesa
 * en memoria.
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Array<{page:number, y:number, text:string}>>}
 */
export async function pdfToLines(buffer) {
  const pdfjs = await loadPdfJs();

  const doc = await pdfjs.getDocument({
    data: buffer,
    // Sin red: nada de fuentes ni mapas de caracteres remotos.
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const line of clusterIntoLines(content.items)) {
      out.push({ page: p, y: line.y, text: line.text, items: line.items });
    }
    page.cleanup();
  }
  doc.destroy();
  return out;
}

/**
 * Agrupa items de pdf.js en líneas.
 * item.transform = [a, b, c, d, e, f] → e = x, f = y (y crece hacia arriba).
 */
export function clusterIntoLines(items) {
  const usable = items
    .filter((it) => it.str && it.str.trim() !== '')
    .map((it) => ({
      x: it.transform[4],
      // invertimos Y para que "menor = más arriba", como se lee
      y: -it.transform[5],
      w: it.width || 0,
      str: it.str,
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const clusters = [];
  for (const it of usable) {
    let target = null;
    for (const c of clusters) {
      if (Math.abs(c.y - it.y) <= Y_TOLERANCE) { target = c; break; }
    }
    if (target) {
      target.items.push(it);
      target.y = Math.min(target.y, it.y);
    } else {
      clusters.push({ y: it.y, items: [it] });
    }
  }

  return clusters
    .sort((a, b) => a.y - b.y)
    .map((c) => {
      const items = c.items.slice().sort((a, b) => a.x - b.x);
      let text = '';
      let prevEnd = null;
      for (const it of items) {
        if (prevEnd !== null && it.x - prevEnd > X_GAP_SPACE) text += ' ';
        text += it.str;
        prevEnd = it.x + it.w;
      }
      // `items` se conserva porque algunos formatos (BBVA débito) sólo se
      // pueden leer con las coordenadas: sus columnas CARGOS y ABONOS son
      // indistinguibles en el texto plano, sólo cambia la X del monto.
      return {
        y: c.y,
        text: text.replace(/\s+/g, ' ').trim(),
        items: items.map((it) => ({ x0: it.x, x1: it.x + it.w, str: it.str })),
      };
    })
    .filter((l) => l.text !== '');
}
