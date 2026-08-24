// ===========================================================================
// Latido: mantiene despierto el proyecto de Supabase.
//
//   node tools/keepalive.mjs
//
// Los proyectos gratuitos se pausan tras 7 días sin actividad y hay que
// despausarlos a mano. Esto lo corre GitHub Actions cada 2 días.
//
// La URL y la llave salen de js/config.js: una sola fuente de verdad. Si algún
// día cambias de proyecto, sólo se toca ese archivo.
//
// No usa secretos porque no hay ninguno que usar: la llave publicable ya está
// en el repo a propósito, y sin sesión no da acceso a nada (lo comprueba
// tools/check-rls.mjs).
// ===========================================================================

import fs from 'node:fs';

const CONFIG = new URL('../js/config.js', import.meta.url);

function leerConfig() {
  const src = fs.readFileSync(CONFIG, 'utf8');
  const bloque = src.match(/const BAKED_IN = \{([\s\S]*?)\};/);
  if (!bloque) throw new Error('No encontré BAKED_IN en js/config.js');
  const url = bloque[1].match(/url:\s*'([^']*)'/)?.[1];
  const key = bloque[1].match(/anonKey:\s*'([^']*)'/)?.[1];
  if (!url || !key) {
    throw new Error('js/config.js no tiene URL o llave. ¿Está configurado el proyecto?');
  }
  return { url: url.replace(/\/+$/, ''), key };
}

async function conTiempo(promesa, ms, queEs) {
  const control = new AbortController();
  const alarma = setTimeout(() => control.abort(), ms);
  try {
    return await promesa(control.signal);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${queEs}: no respondió en ${ms / 1000}s`);
    throw err;
  } finally {
    clearTimeout(alarma);
  }
}

/**
 * Un error que no se va a arreglar solo: la función no existe, o la llave no
 * sirve. Reintentarlo sólo hace perder tiempo y ensucia el registro.
 */
function esPermanente(err) {
  return /PGRST202|Could not find the function|HTTP 40[0-4]/i.test(err.message);
}

/** Reintenta con espera creciente: un fallo de red no debe tumbar el latido. */
async function reintentando(fn, intentos = 3) {
  let ultimo;
  for (let i = 1; i <= intentos; i++) {
    try {
      return await fn();
    } catch (err) {
      ultimo = err;
      if (esPermanente(err)) break;
      if (i < intentos) {
        const espera = i * 5000;
        console.log(`  intento ${i} falló (${err.message}); reintento en ${espera / 1000}s`);
        await new Promise((r) => setTimeout(r, espera));
      }
    }
  }
  throw ultimo;
}

const { url, key } = leerConfig();
const headers = { apikey: key, 'Content-Type': 'application/json' };

console.log(`Latido hacia ${new URL(url).hostname}`);

// --- 1. La llamada que cuenta: escribe de verdad en la base ---------------
let ok = false;
try {
  const datos = await reintentando(() => conTiempo(
    async (signal) => {
      const res = await fetch(`${url}/rest/v1/rpc/ping`, {
        method: 'POST', headers, body: '{}', signal,
      });
      const texto = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${texto.slice(0, 200)}`);
      return texto;
    },
    20000, 'ping()',
  ));
  console.log(`  ping() respondió: ${datos.trim()}`);
  ok = true;
} catch (err) {
  console.log(`  ping() no funcionó: ${err.message}`);
  if (/PGRST202|404|Could not find the function/i.test(err.message)) {
    console.log('  → Falta correr supabase/03_keepalive.sql en el SQL Editor.');
  }
}

// --- 2. Respaldo: aunque falte la función, que el proyecto reciba tráfico --
// No sustituye al ping (no está documentado si un 401 cuenta como actividad),
// pero es mejor que no hacer nada si el SQL aún no se ha corrido.
try {
  const res = await conTiempo(
    (signal) => fetch(`${url}/rest/v1/`, { headers, signal }),
    15000, 'REST',
  );
  console.log(`  REST /rest/v1/ → HTTP ${res.status}`);
} catch (err) {
  console.log(`  REST no respondió: ${err.message}`);
}

if (!ok) {
  console.error('\nEl latido NO se registró. El proyecto puede pausarse a los 7 días.');
  process.exit(1);
}
console.log('\nLatido registrado.');
