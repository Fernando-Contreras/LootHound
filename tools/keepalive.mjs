// ===========================================================================
// Latido: mantiene despierto el proyecto de Supabase.
//
//   node tools/keepalive.mjs
//
// Los proyectos gratuitos se pausan tras 7 días sin actividad de base de datos,
// y despausarlos es manual desde el dashboard. GitHub Actions corre esto cada
// 2 días.
//
// QUÉ CUENTA COMO ACTIVIDAD (aprendido a la mala, con datos reales):
//   * Una consulta REST que RLS rechaza con 401       → NO cuenta.
//   * Una llamada al servidor de auth (GoTrue)        → no se sabe con certeza.
//   * Una escritura real vía rpc/ping() por PostgREST → TAMPOCO PARECE BASTAR.
//
// El 14-sep se corrió 03_keepalive.sql y ping() escribió sin problema cuatro
// veces seguidas (15, 17, 19, 21-sep). El 23-sep el proyecto ya estaba pausado
// otra vez — 9 días después de la última vez que alguien entró al dashboard,
// pero sólo 2 días después del último ping() exitoso. Eso apunta a que
// Supabase mide "actividad" por conexiones reales a Postgres (o por uso del
// dashboard), no por llamadas a PostgREST, aunque esas llamadas sí escriban.
//
// Por eso este script ya NO es la defensa principal: sondea rpc/ping() y
// auth/v1/settings como monitor (para avisar si el proyecto se cayó), pero la
// única vía con evidencia de funcionar es el paso `psql` del workflow, que
// abre una conexión de verdad a Postgres — necesita el secreto
// SUPABASE_DB_URL (ver .github/workflows/keepalive.yml). Sin ese secreto, no
// hay garantía real de que esto evite la próxima pausa.
//
// No usa secretos obligatorios para el sondeo: la llave publicable ya está en
// el repo a propósito y sin sesión no da acceso a nada (lo verifica
// tools/check-rls.mjs).
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
// Nota fija: ni ping() ni auth/v1/settings tienen evidencia de prevenir la
// pausa (ver el comentario de arriba con la línea de tiempo real). Se avisa
// SIEMPRE que se tenga éxito por esta vía, no sólo la primera vez, porque el
// riesgo de que la próxima pausa agarre desprevenido sigue ahí hasta que
// exista una conexión directa a Postgres (SUPABASE_DB_URL).
const AVISO_SIN_GARANTIA =
  'Este sondeo (PostgREST/auth) NO tiene evidencia de prevenir la pausa de ' +
  'Supabase — ya pasó que funcionó varios días y aun así el proyecto se ' +
  'pausó. La única vía con evidencia real es una conexión directa a ' +
  'Postgres: define el secreto SUPABASE_DB_URL (ver el comentario en ' +
  '.github/workflows/keepalive.yml) para que el paso de psql se active.';

export function concluir({ ping, auth }) {
  // 1. ping() escribió en la tabla heartbeat: es la señal más fuerte posible
  //    por esta vía, pero "por esta vía" ya no es sinónimo de "garantizada".
  if (ping.status >= 200 && ping.status < 300) {
    return {
      exito: true, via: 'ping', aviso: AVISO_SIN_GARANTIA,
      mensaje: `ping() escribió en la base: ${String(ping.cuerpo).trim()}`,
    };
  }

  // 2. GoTrue devolvió su JSON de verdad → el proyecto está vivo y lo hicimos
  //    leer de Postgres. Es la señal de que el proyecto sigue en pie, aunque
  //    tampoco haya evidencia de que esto por sí solo evite la pausa.
  const authEsGoTrue = auth.status === 200 &&
    /"external"|"disable_signup"|"mailer_autoconfirm"/.test(auth.cuerpo || '');
  if (authEsGoTrue) {
    const faltaFuncion = ping.status === 404 ||
      /PGRST202|Could not find the function/i.test(ping.cuerpo || '');
    return {
      exito: true, via: 'auth',
      mensaje: 'El servidor de auth respondió; consultó la base para hacerlo.',
      aviso: faltaFuncion
        ? 'La función ping() todavía no existe (corre supabase/03_keepalive.sql). ' +
          AVISO_SIN_GARANTIA
        : AVISO_SIN_GARANTIA,
    };
  }

  // 3. Nada respondió como se espera → proyecto pausado, borrado o mal
  //    configurado.
  const detalle = `ping=${ping.status || ping.err || '?'}, auth=${auth.status || auth.err || '?'}`;
  return {
    exito: false, via: null, aviso: null,
    mensaje:
      `El proyecto no responde (${detalle}). Lo más probable es que esté ` +
      'PAUSADO. Entra a supabase.com/dashboard, ábrelo y dale "Restore project". ' +
      'Ya pasó antes con el sondeo por PostgREST funcionando varios días y aun ' +
      'así pausándose: si esto se repite, define SUPABASE_DB_URL para el paso ' +
      'de psql — es la única vía con evidencia real de prevenirlo.',
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
