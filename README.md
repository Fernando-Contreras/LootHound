# 🐕 LootHound

Tracker personal de gastos e ingresos. Subes el PDF del estado de cuenta y la
app extrae los movimientos **sin que el archivo salga de tu dispositivo**.

Vanilla JS + Supabase. Sin build, sin frameworks, sin backend propio.

---

## Por qué existe

Registrar gastos a mano se olvida y se acumulan quincenas sin capturar. BBVA y
Nu no exportan CSV — sólo dan el estado de cuenta en PDF. Conectar credenciales
bancarias a un tercero (Belvo, Fintoc) no era una opción.

La ruta: subir el PDF que ya te da el banco, parsearlo en el navegador, y dejar
manual sólo lo que de verdad no deja rastro digital (el efectivo).

---

## Qué hace

- **Importa PDF de BBVA y Nu** — parser dedicado por banco, con preview antes de
  guardar. El PDF se procesa con `pdf.js` en el navegador; no se sube a ningún
  servidor.
- **Valida contra el propio estado de cuenta** — compara lo que sumó el parser
  contra los totales impresos en el PDF. Si no cuadran, avisa.
- **Detecta duplicados** — huella exacta con garantía en la base de datos, más
  aviso de "parecidos" para estados de cuenta que se traslapan.
- **Categoriza sola** — reglas por palabra clave editables. Al corregir una
  categoría a mano, ofrece convertir la corrección en regla.
- **Captura rápida de efectivo** — monto, categoría, listo.
- **Dashboard** — balance del mes, gasto por categoría, tendencia de 6 meses,
  dónde más gastaste.
- **Multi-usuario** — cada quien ve sólo sus datos, garantizado con Row Level
  Security en Postgres.

---

## Instalación

Necesitas tu propio proyecto de Supabase (plan gratuito).

👉 **[Guía paso a paso](docs/SETUP.md)**

Resumen:

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. Corre [`supabase/01_schema.sql`](supabase/01_schema.sql) en el SQL Editor.
3. Corre [`supabase/02_verify_rls.sql`](supabase/02_verify_rls.sql) y confirma
   que todo sale ✓.
4. Abre la app y pega la **URL del proyecto** y la llave **anon / public**.

### Correr en local

```bash
python -m http.server 8765
```

Y abre `http://localhost:8765`. Tiene que ser por HTTP: la app usa módulos ES y
`file://` los bloquea.

---

## Privacidad

**El PDF nunca se sube a ningún lado.** Se lee con `arrayBuffer()` y se procesa
en memoria.

`pdf.js` y `supabase-js` están **vendorizados en `/vendor`**, no cargados desde
un CDN. En tiempo de ejecución la app no pide código a terceros: la única salida
a internet es hacia tu propio proyecto de Supabase, y sólo con los movimientos
ya extraídos.

Se puede comprobar: abre la pestaña **Network** del navegador e importa un PDF.
Ninguna petición sale de tu origen.

**Nunca se guardan credenciales bancarias.** La app no se conecta a tu banco: tú
descargas el PDF y se lo das.

---

## Seguridad multi-usuario

El repo es público y la llave `anon` está a la vista. Eso es seguro **porque el
aislamiento no depende del frontend**:

- Las 5 tablas tienen RLS activado.
- Todas las políticas son `to authenticated`. El rol `anon` no tiene ninguna
  política y, sin política aplicable, Postgres niega por defecto: sin sesión, 0
  filas.
- `INSERT`/`UPDATE` además verifican que la cuenta y la categoría referenciadas
  sean del mismo usuario, para que nadie pueda colgar un movimiento de la cuenta
  de otro.
- Ninguna consulta del frontend filtra por `user_id` a mano — a propósito. Si
  alguien quitara un filtro del cliente, la base seguiría devolviendo sólo sus
  propias filas.

[`supabase/02_verify_rls.sql`](supabase/02_verify_rls.sql) comprueba todo esto y
falla ruidosamente si algo quedó mal.

---

## Arquitectura

```
index.html
js/
  app.js            arranque, estado global, navegación
  config.js         URL + anon key (localStorage o fijas en el repo)
  supabase.js       cliente y autenticación
  store.js          TODAS las consultas a la base
  finance.js        ← fuente única de verdad de los cálculos
  categorize.js     motor de reglas
  dedupe.js         huellas y detección de parecidos
  charts.js         SVG a mano, sin librerías
  dom.js            helpers
  parsers/
    lines.js        pdf.js → líneas de texto
    bbva.js         parser dedicado BBVA
    nu.js           parser dedicado Nu
  views/            dashboard, movimientos, importar, reglas
supabase/           schema y verificación de RLS
tests/              pruebas sin navegador (fixtures sintéticos)
tools/parser-lab.html   depurador de parsers
vendor/             pdf.js y supabase-js
```

### Una sola fuente de verdad

Toda suma, resta, promedio y porcentaje vive en
[`js/finance.js`](js/finance.js). Las vistas sólo consumen esas funciones.

La convención de signos existe en **un solo lugar**, `signedAmount()`:

```js
expense  → negativo
income   → positivo
transfer → 0
```

`amount` en la base es siempre positivo; el signo lo determina `kind`. Así
ninguna consulta tiene que adivinar.

Las **transferencias valen 0** en los totales a propósito: pagar la tarjeta
desde el débito, o mover dinero a una Cajita de Nu, no es ni gasto ni ingreso.
Contarlas inflaría ambos lados del balance.

---

## Pruebas

```bash
node tests/run.mjs
```

70 aserciones sobre parsers, cálculos, duplicados y reglas. Sin navegador y sin
red. Los fixtures son sintéticos — nunca metas un estado de cuenta real, el repo
es público.

---

## Bancos soportados

| Banco | Tipo | Estado |
|---|---|---|
| BBVA | Tarjeta de crédito | ✅ verificado contra un estado de cuenta real |
| BBVA | Débito / LIBRETON | ✅ verificado contra un estado de cuenta real |
| Nu | Cuenta de débito | ✅ verificado contra un estado de cuenta real |
| Mercado Pago | Monedero | ✅ verificado contra un estado de cuenta real |

### Transferencias entre cuentas propias

El problema más grande de juntar varias cuentas no son los parsers, es el doble
conteo. Cuando te mandas dinero de BBVA a Mercado Pago, aparece como salida en
un estado de cuenta y como entrada en el otro. Contarlo sería inventar ingresos
que nunca existieron.

Con cuatro estados de cuenta de un mismo mes:

| | Sin detección | Con detección |
|---|---|---|
| "Ingresos" | ~$114,000 | **$33,416.94** (nómina + rendimientos) |
| Transferencias | contadas | $139,840.67 ignoradas |

Se detecta por el nombre del titular en la descripción (`Reglas` → *Tus nombres
en los estados de cuenta*), por menciones a otras carteras tuyas, y por
conceptos que son internos por definición: pago de tarjeta propia, retiro de
efectivo y movimientos de Cajita.

Para agregar otro, ver [docs/PARSERS.md](docs/PARSERS.md).

---

## Limitaciones

- Sólo lee el **PDF original del banco**. Si es un escaneo o una foto no hay
  texto que extraer y no funciona (haría falta OCR).
- Los parsers están atados al formato actual. Si un banco lo cambia, la
  validación contra los totales lo detecta y avisa en vez de importar mal.
- Los montos se guardan en MXN. En cargos en el extranjero se guarda además la
  moneda original y el tipo de cambio, pero los cálculos usan el monto en pesos.

---

## Licencia

MIT
