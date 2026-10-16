-- ============================================================================
-- LootHound — inversiones
--
-- Reemplaza la parte azul de la hoja de Excel:
--   "Mensual"           = cuánto metiste ESTE mes a cada plataforma
--   "Inversión actual"  = cuánto hay hoy en cada plataforma
--   "Le metí"           = cuánto has metido en total desde el inicio
--
-- Se guarda así, en tres tablas, y lo demás (ganancia, %, rendimiento anual,
-- peso de cada plataforma...) se CALCULA en la app a partir de esto:
--
--   investment_accounts  las plataformas (Nu, eToro, GBM, Bitso...)
--   investment_flows     cada vez que metes o sacas dinero (con fecha)
--   investment_values    "fotos" del valor actual de cada plataforma (con fecha)
--
-- Correr en Supabase Studio → SQL Editor → Run, DESPUÉS de 01_schema.sql.
-- Es idempotente: se puede volver a correr sin romper nada.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------------
create table if not exists public.investment_accounts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 60),
  -- ahorro = rendimiento diario y liquidez (Nu, Mercado Pago...)
  -- bolsa  = acciones / fondos / ETFs   (eToro, GBM...)
  -- cripto = criptomonedas              (Bitso...)
  type        text not null default 'otro' check (type in ('ahorro','bolsa','cripto','otro')),
  sort_order  int  not null default 100,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

-- Un movimiento de dinero HACIA o DESDE una plataforma. `amount` siempre
-- positivo; el signo lo da `kind` (misma convención que `transactions`).
create table if not exists public.investment_flows (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  investment_id  uuid not null references public.investment_accounts(id) on delete cascade,
  occurred_on    date not null,
  amount         numeric(14,2) not null check (amount > 0),
  kind           text not null check (kind in ('deposit','withdrawal')),
  note           text check (length(note) <= 200),
  created_at     timestamptz not null default now()
);

-- Cuánto valía una plataforma en cierta fecha. Una por plataforma y día: si
-- la actualizas dos veces el mismo día, la segunda reemplaza a la primera.
create table if not exists public.investment_values (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  investment_id  uuid not null references public.investment_accounts(id) on delete cascade,
  as_of          date not null,
  value          numeric(14,2) not null check (value >= 0),
  created_at     timestamptz not null default now(),
  unique (investment_id, as_of)
);

-- Meta mensual de inversión (la celda "Metas → Inversión" del Excel).
alter table public.settings
  add column if not exists monthly_investment_goal numeric(14,2)
  check (monthly_investment_goal is null or monthly_investment_goal >= 0);


-- ---------------------------------------------------------------------------
-- 2. Índices
-- ---------------------------------------------------------------------------
create index if not exists investment_accounts_user_idx on public.investment_accounts (user_id);
create index if not exists investment_flows_user_date_idx on public.investment_flows (user_id, occurred_on desc);
create index if not exists investment_flows_inv_idx on public.investment_flows (investment_id);
create index if not exists investment_values_inv_date_idx on public.investment_values (investment_id, as_of desc);
create index if not exists investment_values_user_idx on public.investment_values (user_id);


-- ===========================================================================
-- 3. ROW LEVEL SECURITY — mismas reglas que el resto de la app
--    * RLS activo en las tres tablas
--    * todo `to authenticated`; el rol `anon` no tiene permisos ni políticas
--    * insertar/actualizar exige que la plataforma referenciada sea TUYA, para
--      que nadie pueda colgar una aportación de la plataforma de otra persona
-- ===========================================================================
alter table public.investment_accounts enable row level security;
alter table public.investment_flows    enable row level security;
alter table public.investment_values   enable row level security;

revoke all on public.investment_accounts, public.investment_flows, public.investment_values
  from anon, public;
grant select, insert, update, delete
  on public.investment_accounts, public.investment_flows, public.investment_values
  to authenticated;

-- ---------------------------------------------------------- investment_accounts
drop policy if exists investment_accounts_select on public.investment_accounts;
create policy investment_accounts_select on public.investment_accounts
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists investment_accounts_insert on public.investment_accounts;
create policy investment_accounts_insert on public.investment_accounts
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists investment_accounts_update on public.investment_accounts;
create policy investment_accounts_update on public.investment_accounts
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists investment_accounts_delete on public.investment_accounts;
create policy investment_accounts_delete on public.investment_accounts
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ------------------------------------------------------------ investment_flows
drop policy if exists investment_flows_select on public.investment_flows;
create policy investment_flows_select on public.investment_flows
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists investment_flows_insert on public.investment_flows;
create policy investment_flows_insert on public.investment_flows
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.investment_accounts a
      where a.id = investment_id and a.user_id = (select auth.uid())
    )
  );

drop policy if exists investment_flows_update on public.investment_flows;
create policy investment_flows_update on public.investment_flows
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.investment_accounts a
      where a.id = investment_id and a.user_id = (select auth.uid())
    )
  );

drop policy if exists investment_flows_delete on public.investment_flows;
create policy investment_flows_delete on public.investment_flows
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ----------------------------------------------------------- investment_values
drop policy if exists investment_values_select on public.investment_values;
create policy investment_values_select on public.investment_values
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists investment_values_insert on public.investment_values;
create policy investment_values_insert on public.investment_values
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.investment_accounts a
      where a.id = investment_id and a.user_id = (select auth.uid())
    )
  );

drop policy if exists investment_values_update on public.investment_values;
create policy investment_values_update on public.investment_values
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.investment_accounts a
      where a.id = investment_id and a.user_id = (select auth.uid())
    )
  );

drop policy if exists investment_values_delete on public.investment_values;
create policy investment_values_delete on public.investment_values
  for delete to authenticated
  using ((select auth.uid()) = user_id);
