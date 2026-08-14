// ===========================================================================
// Conexión a Supabase.
//
// La anon key es SEGURA de publicar en un repo público — pero SÓLO si las
// políticas RLS están bien puestas. No es una contraseña: es un identificador
// público del proyecto. Quien la tenga puede hablarle a tu API, y ahí es RLS
// quien decide qué filas ve. Sin RLS, esta llave sí expondría todo.
//
// Antes de publicar corre supabase/02_verify_rls.sql y confirma que:
//   - todas las tablas tienen RLS activo
//   - ninguna política aplica al rol `anon`
//
// NUNCA pongas aquí la `service_role` key: esa sí se salta RLS por completo.
// ===========================================================================

// Si clonas este repo, crea TU propio proyecto de Supabase y pon aquí sus
// datos — o déjalos vacíos y la app te los pedirá en la primera pantalla
// (se guardan en localStorage, sólo en tu navegador).
const BAKED_IN = {
  url: '',      // https://xxxxxxxxxxxx.supabase.co
  anonKey: '',
};

const STORAGE_KEY = 'loothound.supabase';

export function getConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved?.url && saved?.anonKey) return saved;
  } catch { /* localStorage bloqueado o JSON corrupto: usamos el de abajo */ }
  return BAKED_IN.url && BAKED_IN.anonKey ? BAKED_IN : null;
}

export function saveConfig({ url, anonKey }) {
  const clean = { url: String(url).trim().replace(/\/+$/, ''), anonKey: String(anonKey).trim() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function clearConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

/** Revisa que no hayan pegado por error la service_role key. */
export function looksLikeServiceKey(key) {
  try {
    const payload = JSON.parse(atob(String(key).split('.')[1]));
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}
