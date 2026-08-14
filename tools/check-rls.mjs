// ===========================================================================
// Prueba real de RLS, sin navegador.
//
//   node tools/check-rls.mjs https://TUPROYECTO.supabase.co sb_publishable_XXXX
//
// Le pega a tu API con la llave pública y SIN sesión, que es exactamente lo
// que puede hacer cualquiera que clone el repo. Si RLS está bien, toda tabla
// debe responder con cero filas.
//
// Correr esto ANTES de publicar el repo. El SQL de verificación revisa que
// las políticas existan; esto comprueba que además funcionan.
// ===========================================================================

const [, , rawUrl, key] = process.argv;

if (!rawUrl || !key) {
  console.error('Uso: node tools/check-rls.mjs <project-url> <publishable-key>');
  process.exit(2);
}
if (/^sb_secret_/i.test(key)) {
  console.error('\n  ALTO: ésa es una llave SECRETA. Se salta RLS y no debe salir de tu máquina.\n');
  process.exit(2);
}

const url = rawUrl.trim().replace(/\/+$/, '');
const TABLES = ['transactions', 'accounts', 'categories', 'category_rules', 'imports', 'settings'];

const headers = { apikey: key, Authorization: `Bearer ${key}` };
let failures = 0;

console.log(`\nProbando ${url} sin sesión iniciada...\n`);

for (const table of TABLES) {
  const endpoint = `${url}/rest/v1/${table}?select=*&limit=5`;
  try {
    const res = await fetch(endpoint, { headers });
    const body = await res.text();

    if (res.status === 200) {
      let rows;
      try { rows = JSON.parse(body); } catch { rows = null; }
      if (Array.isArray(rows) && rows.length === 0) {
        console.log(`  OK    ${table.padEnd(16)} 0 filas sin sesión`);
      } else {
        failures++;
        console.log(`  FALLA ${table.padEnd(16)} devolvió ${rows?.length ?? '?'} filas SIN SESIÓN`);
        console.log(`        ${body.slice(0, 200)}`);
      }
    } else if (res.status === 401 || res.status === 403) {
      console.log(`  OK    ${table.padEnd(16)} acceso denegado (${res.status})`);
    } else if (res.status === 404) {
      failures++;
      console.log(`  FALLA ${table.padEnd(16)} no existe — ¿corriste 01_schema.sql?`);
    } else {
      failures++;
      console.log(`  ?     ${table.padEnd(16)} HTTP ${res.status}: ${body.slice(0, 160)}`);
    }
  } catch (err) {
    failures++;
    console.log(`  ERROR ${table.padEnd(16)} ${err.message}`);
  }
}

// Escribir tampoco debe funcionar sin sesión.
try {
  const res = await fetch(`${url}/rest/v1/transactions`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      occurred_on: '2000-01-01', description: 'prueba rls', amount: 1,
      kind: 'expense', fingerprint: 'prueba-rls', account_id: null,
    }),
  });
  if (res.status >= 400) {
    console.log(`  OK    ${'escritura'.padEnd(16)} rechazada (${res.status})`);
  } else {
    failures++;
    console.log(`  FALLA ${'escritura'.padEnd(16)} SE PUDO ESCRIBIR SIN SESIÓN`);
  }
} catch (err) {
  console.log(`  ?     escritura        ${err.message}`);
}

console.log(failures
  ? `\n  ${failures} problema(s). NO publiques el repo todavía.\n`
  : '\n  Todo bien: sin sesión no se ve ni se escribe nada. Seguro para publicar.\n');

process.exit(failures ? 1 : 0);
