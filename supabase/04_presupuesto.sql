-- ============================================================================
-- LootHound — presupuesto mensual
--
-- El presupuesto se CALCULA solo a partir de tu historial: no hay que
-- capturarlo cada mes. Esta tabla sólo guarda los ajustes que decidas hacer a
-- mano sobre esa sugerencia, para que no se pierdan.
--
-- Correr en Supabase Studio → SQL Editor → Run, DESPUÉS de 01_schema.sql.
-- Es idempotente.
-- ============================================================================

create table if not exists public.budgets (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  category_id  uuid not null references public.categories(id) on delete cascade,
  -- Monto mensual tope. Si es null, la categoría usa la sugerencia calculada.
  amount       numeric(14,2) check (amount is null or amount >= 0),
  -- 'YYYY-MM' para un mes suelto, o null para "aplica a todos los meses".
  -- Así puedes fijar un tope permanente y ajustar sólo diciembre.
  month        text check (month is null or month ~ '^\d{4}-\d{2}$'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Una sola regla por categoría y mes. El índice va sobre una expresión porque
-- UNIQUE normal deja pasar varios null en `month`.
create unique index if not exists budgets_unique_scope
  on public.budgets (user_id, category_id, coalesce(month, 'siempre'));

create index if not exists budgets_user_idx on public.budgets (user_id);

drop trigger if exists budgets_touch_updated_at on public.budgets;
create trigger budgets_touch_updated_at
  before update on public.budgets
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- RLS: mismas reglas que el resto. Sin sesión, cero filas.
-- ---------------------------------------------------------------------------
alter table public.budgets enable row level security;

revoke all on public.budgets from anon, public;
grant select, insert, update, delete on public.budgets to authenticated;

drop policy if exists budgets_select on public.budgets;
create policy budgets_select on public.budgets
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists budgets_insert on public.budgets;
create policy budgets_insert on public.budgets
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.categories c
      where c.id = category_id and c.user_id = (select auth.uid())
    )
  );

drop policy if exists budgets_update on public.budgets;
create policy budgets_update on public.budgets
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.categories c
      where c.id = category_id and c.user_id = (select auth.uid())
    )
  );

drop policy if exists budgets_delete on public.budgets;
create policy budgets_delete on public.budgets
  for delete to authenticated
  using ((select auth.uid()) = user_id);
