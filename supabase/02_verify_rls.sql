-- ============================================================================
-- LootHound — verificación de RLS
-- Correr en Supabase Studio → SQL Editor DESPUÉS de 01_schema.sql.
-- Si alguna fila sale con estatus ✗, NO publiques la app todavía.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. ¿RLS activado en todas las tablas?
-- ---------------------------------------------------------------------------
select
  c.relname                                        as tabla,
  case when c.relrowsecurity then '✓ RLS activo'
       else                       '✗ RLS APAGADO' end as estatus
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by c.relname;


-- ---------------------------------------------------------------------------
-- B. ¿Cada tabla tiene las 4 políticas (select/insert/update/delete)?
-- ---------------------------------------------------------------------------
select
  tablename as tabla,
  count(*) filter (where cmd = 'SELECT') as sel,
  count(*) filter (where cmd = 'INSERT') as ins,
  count(*) filter (where cmd = 'UPDATE') as upd,
  count(*) filter (where cmd = 'DELETE') as del,
  case when count(*) filter (where cmd = 'SELECT') > 0
        and count(*) filter (where cmd = 'INSERT') > 0
        and count(*) filter (where cmd = 'UPDATE') > 0
        and count(*) filter (where cmd = 'DELETE') > 0
       then '✓ completo' else '✗ FALTAN POLÍTICAS' end as estatus
from pg_policies
where schemaname = 'public'
group by tablename
order by tablename;


-- ---------------------------------------------------------------------------
-- C. ¿Alguna política aplica al rol `anon`?  (debe salir VACÍO)
--    `anon` es el rol que usa la anon key ANTES de iniciar sesión.
--    Si aquí aparece algo, cualquiera con la anon key podría leer datos.
-- ---------------------------------------------------------------------------
select tablename, policyname, roles, cmd,
       '✗ ESTA POLÍTICA EXPONE DATOS A ANON' as alerta
from pg_policies
where schemaname = 'public'
  and (roles::text[] && array['anon','public']);


-- ---------------------------------------------------------------------------
-- D. ¿El rol `anon` tiene permisos de tabla? (debe salir VACÍO)
-- ---------------------------------------------------------------------------
select table_name, privilege_type,
       '✗ ANON TIENE ESTE PERMISO' as alerta
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon','PUBLIC')
order by table_name, privilege_type;


-- ---------------------------------------------------------------------------
-- E. ¿Alguna política se olvidó de filtrar por user_id? (debe salir VACÍO)
-- ---------------------------------------------------------------------------
select tablename, policyname, cmd,
       '✗ NO MENCIONA user_id' as alerta
from pg_policies
where schemaname = 'public'
  and coalesce(qual, '')      not like '%user_id%'
  and coalesce(with_check,'') not like '%user_id%';


-- ---------------------------------------------------------------------------
-- F. Funciones SECURITY DEFINER con search_path mutable (debe salir VACÍO)
--    Un search_path sin fijar en una función definer es un vector de escalada.
-- ---------------------------------------------------------------------------
select p.proname as funcion,
       '✗ search_path NO FIJADO' as alerta
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and not exists (
    select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
    where cfg like 'search_path=%'
  );


-- ---------------------------------------------------------------------------
-- G. Resumen legible
-- ---------------------------------------------------------------------------
select
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r')                      as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relrowsecurity) as con_rls,
  (select count(*) from pg_policies where schemaname='public')       as politicas,
  (select count(*) from pg_policies where schemaname='public'
     and (roles::text[] && array['anon','public']))                  as politicas_anon_debe_ser_0;
