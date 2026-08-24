-- ============================================================================
-- LootHound — latido para que Supabase no pause el proyecto
--
-- Los proyectos del plan gratuito se pausan tras 7 días sin actividad, y hay
-- que despausarlos a mano desde el dashboard. Este archivo crea el punto que
-- va a golpear el robot de GitHub Actions cada 2 días.
--
-- Correr en Supabase Studio → SQL Editor → Run, DESPUÉS de 01_schema.sql.
-- Es idempotente.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabla del latido
--
-- Una sola fila, siempre la misma. `single_row` lo garantiza: la llave
-- primaria es un boolean que sólo puede valer true.
-- ---------------------------------------------------------------------------
create table if not exists public.heartbeat (
  id          boolean primary key default true,
  last_ping   timestamptz not null default now(),
  ping_count  bigint not null default 0,
  constraint single_row check (id)
);

-- Nadie toca esta tabla directamente: ni anon, ni los usuarios. El único
-- camino es la función de abajo, que corre como dueña.
alter table public.heartbeat enable row level security;
revoke all on public.heartbeat from anon, authenticated, public;


-- ---------------------------------------------------------------------------
-- 2. La función que se llama desde fuera
--
-- Por qué una ESCRITURA y no una simple lectura: pegarle al REST sin sesión
-- devuelve 401 y no está documentado si eso cuenta como actividad. Un UPDATE
-- real no deja lugar a dudas — la base trabaja de verdad.
--
-- Por qué es segura de exponer a `anon`:
--   * no lee ni escribe NADA de los datos del usuario
--   * sólo devuelve la hora del servidor, que no es un dato sensible
--   * `search_path` fijo, así que no se le puede secuestrar con un esquema
--     falso puesto por delante
-- ---------------------------------------------------------------------------
create or replace function public.ping()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
begin
  insert into public.heartbeat as h (id, last_ping, ping_count)
  values (true, now(), 1)
  on conflict (id) do update
     set last_ping  = now(),
         ping_count = h.ping_count + 1
  returning last_ping into v_now;

  return v_now;
end;
$$;

-- `anon` es el rol del robot: no inicia sesión, sólo trae la llave publicable.
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. Consulta para revisar que el latido esté vivo
--     select * from public.heartbeat;
--
-- Si `last_ping` tiene más de 3 días, el robot dejó de correr: revisa la
-- pestaña Actions del repo en GitHub.
-- ---------------------------------------------------------------------------
