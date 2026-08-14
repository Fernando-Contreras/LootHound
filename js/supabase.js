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

/** Traduce los errores de Supabase a algo legible en español. */
export function authErrorMessage(err) {
  const m = String(err?.message || err || '');
  if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
  if (/Email not confirmed/i.test(m)) return 'Falta confirmar tu correo. Revisa tu bandeja.';
  if (/User already registered/i.test(m)) return 'Ese correo ya está registrado. Inicia sesión.';
  if (/Password should be at least/i.test(m)) return 'La contraseña debe tener al menos 6 caracteres.';
  if (/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera un momento.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'No se pudo conectar. ¿La URL del proyecto es correcta?';
  return m || 'Algo salió mal.';
}
