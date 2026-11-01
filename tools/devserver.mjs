// ===========================================================================
// Servidor local SIN caché, para desarrollar.
//
//   node tools/devserver.mjs [puerto]        (por defecto 8765)
//
// `python -m http.server` no manda Cache-Control, así que el navegador cachea
// los módulos ES por heurística (horas). Resultado: editas un archivo, recargas
// y sigues viendo el código viejo — y en una app de dinero eso hace perder un
// rato creyendo que un arreglo no funcionó. Aquí todo sale con `no-store`.
// ===========================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8765;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));

  // Nada fuera de la carpeta del proyecto.
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('403'); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Cache-Control': 'no-store' }).end('404'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}).listen(PORT, () => console.log(`LootHound en http://localhost:${PORT}  (sin caché)`));
