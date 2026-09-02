// Cliente de Supabase + autenticación.
//
// supabase-js viene de /vendor, no de un CDN: la app no carga código de
// terceros en tiempo de ejecución. La única salida a internet es hacia tu
// propio proyecto de Supabase.

import { getConfig } from './config.js';

let client = null;

export function getClient() {
  if (client) return client;
  const cfg = getConfig();
  if (!cfg) return null;
  const lib = window.supabase;
  if (!lib?.createClient) {
    throw new Error('No se cargó vendor/supabase.umd.js');
  }
  client = lib.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export function resetClient() { client = null; }

// ---------------------------------------------------------------- auth
export async function signUp(email, password) {
  const { data, error } = await getClient().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.href.split('#')[0] },
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await getClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await getClient().auth.signOut();
  if (error) throw error;
}

export async function resetPassword(email) {
  const { error } = await getClient().auth.resetPasswordForEmail(email, {
    redirectTo: window.location.href.split('#')[0],
  });
  if (error) throw error;
}

export async function currentSession() {
  const sb = getClient();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session ?? null;
}

export function onAuthChange(cb) {
  const sb = getClient();
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}

/** ¿Es un fallo de red, en vez de un rechazo del servidor? */
function esFalloDeRed(err) {
  return /Failed to fetch|NetworkError|fetch failed|Load failed/i.test(
    String(err?.message || err || ''),
  );
}

/**
 * Averigua POR QUÉ no se pudo conectar.
 *
 * El navegador reporta igual un DNS que no resuelve, un CORS bloqueado y estar
 * sin internet: todos son "Failed to fetch". Distinguirlos importa porque la
 * causa más común aquí tiene una solución concreta y nada obvia.
 *
 * Los proyectos gratuitos de Supabase se PAUSAN tras 7 días sin actividad, y al
 * pausarse su subdominio deja de existir. La app antes decía "¿la URL es
 * correcta?", que manda a revisar justo lo único que no estaba mal.
 *
 * @returns {Promise<string>} explicación lista para mostrar
 */
export async function diagnosticarConexion() {
  const cfg = getConfig();

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'Parece que no tienes internet. Revisa tu conexión.';
  }

  // ¿Hay internet pero el proyecto no responde? Se compara contra un destino
  // que sabemos que funciona: el propio sitio desde donde corre la app.
  let hayInternet = false;
  try {
    await fetch(`${location.origin}/index.html?ping=${Date.now()}`, { cache: 'no-store' });
    hayInternet = true;
  } catch { /* ni el propio sitio responde */ }

  if (!hayInternet) {
    return 'No hay conexión a internet. Revisa tu red e inténtalo de nuevo.';
  }

  const host = cfg ? new URL(cfg.url).hostname : 'tu proyecto';
  return (
    `Tu proyecto de Supabase (${host}) no responde. ` +
    'Lo más probable es que esté PAUSADO: los proyectos gratuitos se pausan ' +
    'tras 7 días sin usarse. Entra a supabase.com/dashboard, ábrelo y dale ' +
    '"Restore project". Tarda un par de minutos y no pierdes nada.'
  );
}

/**
 * Traduce los errores de Supabase a algo legible en español.
 * Para fallos de red devuelve una promesa, porque hay que sondear para saber
 * la causa; el resto sale de inmediato.
 */
export function authErrorMessage(err) {
  const m = String(err?.message || err || '');
  if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
  if (/Email not confirmed/i.test(m)) return 'Falta confirmar tu correo. Revisa tu bandeja.';
  if (/User already registered/i.test(m)) return 'Ese correo ya está registrado. Inicia sesión.';
  if (/Password should be at least/i.test(m)) return 'La contraseña debe tener al menos 6 caracteres.';
  if (/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera un momento.';
  if (esFalloDeRed(err)) return null;   // null = hay que diagnosticar
  return m || 'Algo salió mal.';
}

/** Igual que la anterior, pero resolviendo también los fallos de red. */
export async function explicarError(err) {
  return authErrorMessage(err) ?? await diagnosticarConexion();
}
