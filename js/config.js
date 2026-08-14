// ===========================================================================
// Conexión a Supabase.
//
// Estos datos son SEGUROS de publicar en un repo público — pero SÓLO si las
// políticas RLS están bien puestas. La llave publicable no es una contraseña:
// es un identificador público del proyecto. Quien la tenga puede hablarle a tu
// API, y ahí es RLS quien decide qué filas ve. Sin sesión: ninguna.
//
// Antes de publicar corre supabase/02_verify_rls.sql y confirma que:
//   - todas las tablas tienen RLS activo
//   - ninguna política aplica al rol `anon`
//
// NUNCA pongas aquí una llave secreta (`sb_secret_...` o la `service_role`):
// esas se saltan RLS por completo.
// ===========================================================================

// Datos del proyecto. Al quedar aquí, la app funciona en cualquier navegador
// y en cualquier dispositivo sin volver a capturarlos — no depende de que el
// navegador conserve el localStorage.
//
// Si clonas este repo, crea TU propio proyecto de Supabase y reemplaza esto,
// o déjalo vacío y la app te lo pedirá en la primera pantalla.
const BAKED_IN = {
  url: 'https://ekkaexssmeudoykqupxq.supabase.co',
  anonKey: 'sb_publishable_gBPOiP8HCUBB_IB0lb7djQ_jYzV0Sv8',
};

const STORAGE_KEY = 'loothound.supabase';

export function getConfig() {
  // Lo que esté fijo en el código gana: es lo que hace que la app funcione
  // igual en cualquier dispositivo. El localStorage sólo sirve como respaldo
  // para quien clone el repo y aún no haya puesto lo suyo.
  if (BAKED_IN.url && BAKED_IN.anonKey) return BAKED_IN;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved?.url && saved?.anonKey) return saved;
  } catch { /* localStorage bloqueado o JSON corrupto */ }
  return null;
}

/** ¿La configuración viene del código o de este navegador? */
export function configIsBakedIn() {
  return Boolean(BAKED_IN.url && BAKED_IN.anonKey);
}

export function saveConfig({ url, anonKey }) {
  const clean = {
    url: String(url).trim().replace(/\/+$/, ''),
    anonKey: String(anonKey).trim(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function clearConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Rechaza llaves que se saltan RLS. Supabase tiene dos generaciones de llaves
 * y hay que cubrir ambas:
 *   nuevas:  sb_publishable_...  (pública)   /  sb_secret_...    (SECRETA)
 *   viejas:  JWT con role=anon   (pública)   /  role=service_role (SECRETA)
 */
export function looksLikeSecretKey(key) {
  const k = String(key || '').trim();
  if (/^sb_secret_/i.test(k)) return true;
  try {
    const payload = JSON.parse(atob(k.split('.')[1]));
    return payload.role === 'service_role';
  } catch {
    return false; // no es un JWT: ya lo cubrió la prueba de arriba
  }
}

/** ¿Tiene pinta de llave publicable válida? */
export function looksLikePublishableKey(key) {
  const k = String(key || '').trim();
  if (/^sb_publishable_/i.test(k)) return true;
  try {
    const payload = JSON.parse(atob(k.split('.')[1]));
    return payload.role === 'anon';
  } catch {
    return false;
  }
}
