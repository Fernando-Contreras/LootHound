# Configurar Supabase — paso a paso

Tiempo estimado: 10 minutos. Todo se hace en la web de Supabase; no necesitas
instalar nada.

---

## 1. Crear el proyecto

1. Entra a **https://supabase.com** y crea una cuenta (el plan gratuito alcanza
   de sobra: 500 MB de base y usuarios ilimitados).
2. Clic en **New project**.
3. Llena:
   - **Name**: `loothound`
   - **Database Password**: genera una y **guárdala en tu gestor de
     contraseñas**. No la vas a usar en la app, pero es la única forma de
     recuperar acceso directo a la base.
   - **Region**: la más cercana — para México, `East US (North Virginia)` suele
     dar la menor latencia.
4. **Create new project** y espera ~2 minutos a que termine de aprovisionar.

---

## 2. Correr el schema

1. En el menú lateral: **SQL Editor** → **New query**.
2. Abre [`supabase/01_schema.sql`](../supabase/01_schema.sql), copia **todo** el
   archivo y pégalo.
3. **Run** (o `Ctrl+Enter`).
4. Debe terminar con `Success. No rows returned`.

Este script crea 5 tablas, sus índices, activa RLS con 20 políticas, y deja un
trigger que siembra cuentas, categorías y ~70 reglas de categorización cada vez
que se registra un usuario nuevo.

Es idempotente: si lo vuelves a correr no rompe nada.

---

## 3. Verificar el RLS  ⚠️ no te saltes este paso

Esto es lo que impide que un usuario vea los datos de otro. **Hazlo antes de
publicar el repo.**

1. **SQL Editor** → **New query**.
2. Pega [`supabase/02_verify_rls.sql`](../supabase/02_verify_rls.sql) y córrelo.
3. Revisa los resultados de cada bloque:

| Bloque | Qué revisa | Qué debe salir |
|---|---|---|
| **A** | RLS activado por tabla | las 5 tablas con `✓ RLS activo` |
| **B** | Políticas por tabla | las 5 con `✓ completo` |
| **C** | Políticas que apliquen al rol `anon` | **vacío** |
| **D** | Permisos de tabla para `anon` | **vacío** |
| **E** | Políticas que no filtren por `user_id` | **vacío** |
| **F** | Funciones `SECURITY DEFINER` sin `search_path` fijo | **vacío** |
| **G** | Resumen | `con_rls = 5`, `politicas_anon_debe_ser_0 = 0` |

Si C, D, E o F devuelven aunque sea una fila, **no publiques todavía**.

### Prueba de fuego (opcional pero recomendada)

La forma real de comprobarlo es con dos cuentas:

1. Regístrate con un correo A, captura un gasto.
2. Cierra sesión, regístrate con un correo B.
3. B no debe ver ni un solo movimiento de A.

---

## 4. Ajustes de autenticación

**Authentication** → **Providers** → **Email**: déjalo activado (viene así por
defecto). No hace falta configurar nada más.

**Authentication** → **URL Configuration**:
- **Site URL**: `https://TU-USUARIO.github.io/LootHound/`
- **Redirect URLs**: agrega también `http://localhost:8765` si vas a probar en
  local.

### Sobre la confirmación por correo

Por defecto Supabase pide confirmar el correo antes del primer login. Para una
app personal puedes apagarlo en **Authentication** → **Sign In / Up** →
**Confirm email** (off), y así entras de inmediato al registrarte.

Si lo dejas encendido, ten en cuenta que el servidor de correo gratuito de
Supabase tiene un límite bajo (unos pocos correos por hora).

---

## 5. Copiar las llaves a la app

Supabase cambió el dashboard y el formato de llaves, así que hay dos casos:

**Project Settings → Data API**
- **Project URL** → `https://abcdefgh.supabase.co`

  Si no la encuentras, mírala en la barra de direcciones: cuando estás en el
  dashboard la URL es `.../dashboard/project/abcdefgh`, y ese pedazo final +
  `.supabase.co` es tu Project URL.

**Project Settings → API Keys**
- La llave **publishable** → empieza con `sb_publishable_...`
- En proyectos viejos se llama **anon / public** y es un JWT que empieza con
  `eyJ...`. Las dos funcionan.

Pégalas en la primera pantalla de la app (se guardan en el `localStorage` de
ese navegador), o mejor: déjalas fijas en [`js/config.js`](../js/config.js) en
`BAKED_IN`, y así la app funciona en cualquier dispositivo sin recapturarlas.

> **La llave publicable es segura de publicar** — es un identificador público
> del proyecto, no una contraseña. Quien la tenga puede hablarle a tu API, y
> ahí RLS decide qué devuelve: sin sesión, nada.
>
> **Las llaves `sb_secret_...` y `service_role` NO.** Ésas se saltan RLS por
> completo. Nunca en el frontend ni en el repo. La app y el verificador
> rechazan ambas si las pegas por error.

Hay otra sección llamada **JWT Keys** con un ID en formato UUID. Ése no se usa
para nada aquí; es el identificador de la llave con la que Supabase firma las
sesiones.

### Comprobar que RLS de verdad funciona

El SQL del paso 3 revisa que las políticas *existan*. Esto comprueba que además
*funcionan*, pegándole a tu API sin sesión — justo lo que puede hacer cualquiera
que clone el repo:

```bash
node tools/check-rls.mjs https://TUPROYECTO.supabase.co sb_publishable_TULLAVE
```

Debe responder que ninguna tabla devuelve filas y que las escrituras se
rechazan. Si alguna tabla contesta con datos, **no publiques el repo**.

---

## 6. Publicar en GitHub Pages

```bash
git remote add origin https://github.com/TU-USUARIO/LootHound.git
```

```bash
git push -u origin main
```

Luego en GitHub: **Settings** → **Pages** → **Source: Deploy from a branch** →
rama `main`, carpeta `/ (root)` → **Save**.

En 1–2 minutos queda en `https://TU-USUARIO.github.io/LootHound/`.

Antes de publicar, confirma que no se cuelen estados de cuenta:

```bash
git ls-files | Select-String -Pattern "\.pdf$"
```

No debe devolver nada. El [`.gitignore`](../.gitignore) ya bloquea `*.pdf`, la
carpeta `_devdata/` y los respaldos `loothound-*.json`.

---

## Problemas comunes

**"No se pudo conectar. ¿La URL del proyecto es correcta?"**
Revisa que la URL no lleve diagonal al final ni la ruta `/rest/v1`.

**Me registré pero la app no muestra cuentas**
Pasa si te registraste *antes* de correr `01_schema.sql`, así que el trigger no
existía. La app llama sola a `seed_me()` cuando no encuentra cuentas; si aún
así no aparecen, recarga la página.

**"La base rechazó la operación (RLS)"**
Casi siempre es la sesión expirada: cierra sesión y vuelve a entrar. Si
persiste, vuelve a correr el bloque de verificación del paso 3.

**No me llega el correo de confirmación**
Apaga *Confirm email* como se describe en el paso 4, o revisa spam. El SMTP
gratuito de Supabase es muy limitado.
