// ===========================================================================
// Latido: mantiene despierto el proyecto de Supabase.
//
//   node tools/keepalive.mjs
//
// Los proyectos gratuitos se pausan tras 7 días sin actividad de base de datos,
// y despausarlos es manual desde el dashboard. GitHub Actions corre esto cada
// 2 días.
//
// QUÉ CUENTA COMO ACTIVIDAD (aprendido a la mala):
//   * Una consulta REST que RLS rechaza con 401  → NO cuenta.
//   * Una llamada al servidor de auth (GoTrue), que sí lee de Postgres para
//     responder → SÍ cuenta.
//   * Una escritura real vía la función ping()   → cuenta, y es la más segura.
//
// Por eso este script sondea DOS cosas y le basta con que una funcione:
//   1. rpc/ping  — escribe en la tabla heartbeat. Necesita 03_keepalive.sql.
//   2. auth/v1/settings — GoTrue lee la config del proyecto desde la base.
//
// El paso `psql` del workflow (opcional, si defines el secreto SUPABASE_DB_URL)
// es todavía más contundente: abre una conexión directa a Postgres.
//
// No usa secretos obligatorios: la llave publicable ya está en el repo a
// propósito y sin sesión no da acceso a nada (lo verifica tools/check-rls.mjs).
// ===========================================================================

import fs from 'node:fs';

const CONFIG = new URL('../js/config.js', import.meta.url);
const TIMEOUT_MS = 20000;

/** Saca url + llave de js/config.js, la única fuente de verdad. */
export function leerConfig(src) {
  src ??= fs.readFileSync(CONFIG, 'utf8');
  const bloque = src.match(/const BAKED_IN = \{([\s\S]*?)\};/)?.[1];
  if (!bloque) throw new Error('No encontré BAKED_IN en js/config.js');
  const url = bloque.match(/url:\s*'([^']*)'/)?.[1];
  const key = bloque.match(/anonKey:\s*'([^']*)'/)?.[1];
  if (!url || !key) throw new Error('js/config.js no tiene url o anonKey.');
  return { url: url.replace(/\/+$/, ''), key };
}

async function sondear(url, opts = {}) {
  const ctrl = new AbortController();
  const alarma = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return { status: res.status, cuerpo: (await res.text()).slice(0, 300) };
  } catch (err) {
    return { status: 0, err: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(alarma);
  }
}

/**
 * Decide el resultado del latido a partir de los dos sondeos.
 * Función pura para poder probarla: se le pasan respuestas, devuelve la
 * conclusión.
 *
 * @param {{ping:{status,cuerpo,err}, auth:{status,cuerpo,err}}} sondeos
 * @returns {{exito:boolean, via:string|null, mensaje:string, aviso:string|null}}
 */
export function concluir({ ping, auth }) {
  // 1. ping() escribió en la tabla heartbeat: lo ideal.
  if (ping.status >= 200 && ping.status < 300) {
    return {
      exito: true, via: 'ping', aviso: null,
      mensaje: `ping() escribió en la base: ${String(ping.cuerpo).trim()}`,
    };
  }

  // 2. GoTrue devolvió su JSON de verdad → el proyecto está vivo y lo hicimos
  //    leer de Postgres. Basta como actividad.
  const authEsGoTrue = auth.status === 200 &&
    /"external"|"disable_signup"|"mailer_autoconfirm"/.test(auth.cuerpo || '');
  if (authEsGoTrue) {
    const faltaFuncion = ping.status === 404 ||
      /PGRST202|Could not find the function/i.test(ping.cuerpo || '');
    return {
      exito: true, via: 'auth',
      mensaje: 'El servidor de auth respondió; consultó la base para hacerlo.',
      aviso: faltaFuncion
        ? 'La función ping() todavía no existe. El latido funciona vía auth, ' +
          'pero para dejarlo 100% a prueba de fallos corre ' +
          'supabase/03_keepalive.sql en el SQL Editor.'
        : null,
    };
  }

  // 3. Nada respondió como se espera → proyecto pausado, borrado o mal
  //    configurado.
  const detalle = `ping=${ping.status || ping.err || '?'}, auth=${auth.status || auth.err || '?'}`;
  return {
    exito: false, via: null, aviso: null,
    mensaje:
      `El proyecto no responde (${detalle}). Lo más probable es que esté ` +
      'PAUSADO. Entra a supabase.com/dashboard, ábrelo y dale "Restore project".',
  };
}

// --- ejecución directa (no cuando lo importa un test) ---------------------
if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/keepalive.mjs')) {
  const { url, key } = leerConfig();
  console.log(`Latido hacia ${new URL(url).hostname}  (${new Date().toISOString()})`);

  const [ping, auth] = await Promise.all([
    sondear(`${url}/rest/v1/rpc/ping`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: '{}',
    }),
    sondear(`${url}/auth/v1/settings`, { headers: { apikey: key } }),
  ]);
  console.log(`  ping()             → ${ping.status || ping.err}`);
  console.log(`  auth/v1/settings   → ${auth.status || auth.err}`);

  const r = concluir({ ping, auth });
  console.log(`\n${r.mensaje}`);
  if (r.aviso) console.log(`\nAVISO: ${r.aviso}`);

  if (!r.exito) {
    // El exit 1 hace que GitHub mande correo. Es intencional: hay que actuar.
    console.error('\nEl latido NO se registró.');
    process.exit(1);
  }
  console.log(`\nLatido registrado (vía ${r.via}).`);
}
