-- ============================================================================
-- LootHound — schema + Row Level Security
-- Pegar COMPLETO en Supabase Studio → SQL Editor → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensiones
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;


-- ---------------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------------

-- 1.1 Cuentas: Efectivo, BBVA (crédito), Nu (débito)...
create table if not exists public.accounts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 60),
  kind        text not null check (kind in ('cash','debit','credit')),
  bank        text          check (bank in ('bbva','bbva_debito','nu','mercadopago')),
  -- Cuentas donde NUNCA te cae dinero de terceros: todo lo que entra lo mandas
  -- tú desde otra cuenta tuya. Sirve para no contar tus propios depósitos
  -- como ingresos (ej. Nu, Mercado Pago).
  deposits_are_transfers boolean not null default false,
  currency    char(3) not null default 'MXN',
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

-- 1.2 Categorías
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 40),
  kind        text not null default 'expense' check (kind in ('expense','income','both')),
  color       text not null default '#94a3b8' check (color ~ '^#[0-9a-fA-F]{6}$'),
  icon        text,
  sort_order  int  not null default 100,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

-- 1.3 Importaciones: un renglón por PDF procesado.
--     Permite deshacer una importación completa y guardar los totales que
--     venían impresos en el estado de cuenta para validar el parser.
create table if not exists public.imports (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id               uuid not null references public.accounts(id) on delete cascade,
  bank                     text not null check (bank in ('bbva','bbva_debito','nu','mercadopago')),
  file_name                text,
  period_start             date,
  period_end               date,
  -- totales que el propio PDF declara, para comparar contra lo que sumó el parser
  statement_total_expense  numeric(14,2),
  statement_total_income   numeric(14,2),
  parsed_count             int not null default 0,
  imported_count           int not null default 0,
  created_at               timestamptz not null default now()
);

-- 1.4 Movimientos
--     Convención: `amount` SIEMPRE positivo; el signo lo determina `kind`.
--     Así ninguna función de cálculo tiene que adivinar el signo.
create table if not exists public.transactions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id         uuid not null references public.accounts(id)   on delete restrict,
  category_id        uuid          references public.categories(id) on delete set null,
  import_id          uuid          references public.imports(id)    on delete set null,

  -- Si es una transferencia entre cuentas TUYAS, aquí va la cuenta del otro
  -- lado. Un solo renglón describe el movimiento completo: sale de
  -- `account_id` y entra a `counter_account_id`. No se guardan dos renglones
  -- para no tener que mantenerlos sincronizados.
  -- Es lo que permite saber cuánto efectivo sacaste: un retiro es una
  -- transferencia de la cuenta de débito hacia la cuenta "Efectivo".
  counter_account_id uuid          references public.accounts(id)   on delete set null,
  -- Por qué se marcó como transferencia: 'pago-tarjeta', 'retiro-efectivo',
  -- 'mismo-titular', 'cuenta-propia', 'cajita', 'deposito-propio'.
  transfer_reason    text,

  occurred_on        date not null,                 -- fecha de la operación
  posted_on          date,                          -- fecha de cargo (BBVA la separa)
  description        text not null check (length(trim(description)) between 1 and 200),
  amount             numeric(14,2) not null check (amount > 0),
  kind               text not null check (kind in ('expense','income','transfer')),
  note               text check (length(note) <= 500),

  source             text not null default 'manual' check (source in ('manual','pdf_import')),
  categorized_by     text not null default 'none'   check (categorized_by in ('user','rule','none')),

  -- moneda original cuando el cargo fue en el extranjero
  original_currency  char(3),
  original_amount    numeric(14,2),
  fx_rate            numeric(14,6),
  raw_line           text,                          -- línea cruda del PDF, para auditar

  -- huella determinista: bloquea reimportar el mismo movimiento dos veces
  fingerprint        text not null,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (user_id, fingerprint),
  -- una transferencia no puede tener como destino la misma cuenta de origen
  constraint counter_account_differs check (
    counter_account_id is null or counter_account_id <> account_id
  ),
  constraint fx_fields_together check (
    (original_currency is null and original_amount is null and fx_rate is null)
    or (original_currency is not null and original_amount is not null)
  )
);

-- 1.5 Reglas de categorización por palabra clave
create table if not exists public.category_rules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  pattern     text not null check (length(trim(pattern)) between 1 and 100),
  match_type  text not null default 'contains' check (match_type in ('contains','starts_with','regex')),
  category_id uuid not null references public.categories(id) on delete cascade,
  account_id  uuid          references public.accounts(id)  on delete cascade,  -- null = todas
  priority    int  not null default 100,   -- menor gana
  enabled     boolean not null default true,
  hits        int  not null default 0,     -- cuántas veces ha aplicado
  created_at  timestamptz not null default now()
);

-- una misma palabra clave no se puede repetir para el mismo ámbito
create unique index if not exists category_rules_unique_pattern
  on public.category_rules (
    user_id,
    upper(trim(pattern)),
    match_type,
    coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );


-- 1.6 Ajustes del usuario
--     `holder_names` son los nombres con los que apareces como contraparte en
--     los estados de cuenta. Es lo que permite distinguir una transferencia
--     tuya de un ingreso real: si el SPEI recibido dice tu propio nombre, es
--     dinero que te mandaste desde otra de tus cuentas.
create table if not exists public.settings (
  user_id       uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  holder_names  text[] not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- 2. Índices
-- ---------------------------------------------------------------------------
create index if not exists transactions_user_date_idx
  on public.transactions (user_id, occurred_on desc);
create index if not exists transactions_user_account_idx
  on public.transactions (user_id, account_id);
create index if not exists transactions_user_category_idx
  on public.transactions (user_id, category_id);
create index if not exists transactions_import_idx
  on public.transactions (import_id);
create index if not exists category_rules_user_idx
  on public.category_rules (user_id, priority);
create index if not exists accounts_user_idx   on public.accounts   (user_id);
create index if not exists categories_user_idx on public.categories (user_id);
create index if not exists imports_user_idx    on public.imports    (user_id, created_at desc);


-- ---------------------------------------------------------------------------
-- 3. updated_at automático
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists transactions_touch_updated_at on public.transactions;
create trigger transactions_touch_updated_at
  before update on public.transactions
  for each row execute function public.touch_updated_at();


-- ===========================================================================
-- 4. ROW LEVEL SECURITY  ← la parte que de verdad separa a los usuarios
-- ===========================================================================
-- Reglas del diseño:
--   * TODAS las tablas llevan RLS activado.
--   * TODAS las políticas son `to authenticated`: el rol `anon` (el que usa la
--     anon key antes de iniciar sesión) no tiene NINGUNA política, y sin
--     política aplicable RLS niega por defecto. Es decir: sin login, 0 filas.
--   * `(select auth.uid())` va envuelto en subquery a propósito: Postgres lo
--     evalúa una vez por statement en vez de una vez por fila.
--   * Los INSERT/UPDATE además verifican que account_id y category_id
--     pertenezcan al mismo usuario, para que nadie pueda colgar un movimiento
--     de la cuenta de otra persona.

alter table public.accounts       enable row level security;
alter table public.categories     enable row level security;
alter table public.imports        enable row level security;
alter table public.transactions   enable row level security;
alter table public.category_rules enable row level security;
alter table public.settings       enable row level security;

-- Nada de acceso para usuarios no autenticados ni para el rol público.
revoke all on public.accounts, public.categories, public.imports,
              public.transactions, public.category_rules, public.settings
  from anon, public;

grant select, insert, update, delete
  on public.accounts, public.categories, public.imports,
     public.transactions, public.category_rules, public.settings
  to authenticated;

-- ---------------------------------------------------------- settings
drop policy if exists settings_select on public.settings;
create policy settings_select on public.settings
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists settings_insert on public.settings;
create policy settings_insert on public.settings
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists settings_update on public.settings;
create policy settings_update on public.settings
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists settings_delete on public.settings;
create policy settings_delete on public.settings
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------- accounts
drop policy if exists accounts_select on public.accounts;
create policy accounts_select on public.accounts
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists accounts_insert on public.accounts;
create policy accounts_insert on public.accounts
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists accounts_update on public.accounts;
create policy accounts_update on public.accounts
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists accounts_delete on public.accounts;
create policy accounts_delete on public.accounts
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------- categories
drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists categories_insert on public.categories;
create policy categories_insert on public.categories
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists categories_update on public.categories;
create policy categories_update on public.categories
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists categories_delete on public.categories;
create policy categories_delete on public.categories
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------- imports
drop policy if exists imports_select on public.imports;
create policy imports_select on public.imports
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists imports_insert on public.imports;
create policy imports_insert on public.imports
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.accounts a
      where a.id = account_id and a.user_id = (select auth.uid())
    )
  );

drop policy if exists imports_update on public.imports;
create policy imports_update on public.imports
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists imports_delete on public.imports;
create policy imports_delete on public.imports
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------- transactions
drop policy if exists transactions_select on public.transactions;
create policy transactions_select on public.transactions
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists transactions_insert on public.transactions;
create policy transactions_insert on public.transactions
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.accounts a
      where a.id = account_id and a.user_id = (select auth.uid())
    )
    and (
      category_id is null
      or exists (
        select 1 from public.categories c
        where c.id = category_id and c.user_id = (select auth.uid())
      )
    )
    and (
      counter_account_id is null
      or exists (
        select 1 from public.accounts a2
        where a2.id = counter_account_id and a2.user_id = (select auth.uid())
      )
    )
    and (
      import_id is null
      or exists (
        select 1 from public.imports i
        where i.id = import_id and i.user_id = (select auth.uid())
      )
    )
  );

drop policy if exists transactions_update on public.transactions;
create policy transactions_update on public.transactions
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.accounts a
      where a.id = account_id and a.user_id = (select auth.uid())
    )
    and (
      category_id is null
      or exists (
        select 1 from public.categories c
        where c.id = category_id and c.user_id = (select auth.uid())
      )
    )
    and (
      counter_account_id is null
      or exists (
        select 1 from public.accounts a2
        where a2.id = counter_account_id and a2.user_id = (select auth.uid())
      )
    )
  );

drop policy if exists transactions_delete on public.transactions;
create policy transactions_delete on public.transactions
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------- category_rules
drop policy if exists category_rules_select on public.category_rules;
create policy category_rules_select on public.category_rules
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists category_rules_insert on public.category_rules;
create policy category_rules_insert on public.category_rules
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.categories c
      where c.id = category_id and c.user_id = (select auth.uid())
    )
    and (
      account_id is null
      or exists (
        select 1 from public.accounts a
        where a.id = account_id and a.user_id = (select auth.uid())
      )
    )
  );

drop policy if exists category_rules_update on public.category_rules;
create policy category_rules_update on public.category_rules
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.categories c
      where c.id = category_id and c.user_id = (select auth.uid())
    )
  );

drop policy if exists category_rules_delete on public.category_rules;
create policy category_rules_delete on public.category_rules
  for delete to authenticated
  using ((select auth.uid()) = user_id);


-- ===========================================================================
-- 5. Semilla automática al crear un usuario
--    Cada quien que clone la app y se registre arranca con sus cuentas,
--    categorías y reglas básicas ya creadas.
-- ===========================================================================
-- Toda la lógica vive aquí; el trigger y seed_me() sólo la invocan.
create or replace function public.seed_user(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cat record;
  rul record;
  v_cat uuid;
begin
  -- Ajustes -----------------------------------------------------------------
  insert into public.settings (user_id) values (p_user)
  on conflict (user_id) do nothing;

  -- Cuentas -----------------------------------------------------------------
  -- `deposits_are_transfers` va en true donde nunca te cae dinero de terceros:
  -- a Nu y a Mercado Pago sólo llega lo que tú mismo les mandas.
  insert into public.accounts (user_id, name, kind, bank, deposits_are_transfers) values
    (p_user, 'Efectivo',      'cash',   null,          false),
    (p_user, 'BBVA Débito',   'debit',  'bbva_debito', false),
    (p_user, 'BBVA Crédito',  'credit', 'bbva',        false),
    (p_user, 'Nu',            'debit',  'nu',          true),
    (p_user, 'Mercado Pago',  'debit',  'mercadopago', true)
  on conflict (user_id, name) do nothing;

  -- Categorías --------------------------------------------------------------
  for cat in
    select * from (values
      ('Comida',            'expense', '#f97316',  10),
      ('Súper',             'expense', '#84cc16',  20),
      ('Transporte',        'expense', '#0ea5e9',  30),
      ('Vivienda',          'expense', '#8b5cf6',  40),
      ('Servicios',         'expense', '#06b6d4',  50),
      ('Salud',             'expense', '#ef4444',  60),
      ('Entretenimiento',   'expense', '#ec4899',  70),
      ('Compras',           'expense', '#eab308',  80),
      ('Viajes',            'expense', '#14b8a6',  90),
      ('Suscripciones',     'expense', '#a855f7', 100),
      ('Educación',         'expense', '#6366f1', 110),
      ('Sin categoría',     'both',    '#94a3b8', 999),
      ('Sueldo',            'income',  '#22c55e',  10),
      ('Rendimientos',      'income',  '#10b981',  20),
      ('Otros ingresos',    'income',  '#4ade80',  30),
      ('Transferencia',     'both',    '#64748b', 998),
      ('Retiro de efectivo','both',    '#78716c', 997)
    ) as t(name, kind, color, sort_order)
  loop
    insert into public.categories (user_id, name, kind, color, sort_order)
    values (p_user, cat.name, cat.kind, cat.color, cat.sort_order)
    on conflict (user_id, name) do nothing;
  end loop;

  -- Reglas de arranque ------------------------------------------------------
  for rul in
    select * from (values
      ('OXXO',             'Súper'),
      ('7 ELEVEN',         'Súper'),
      ('WALMART',          'Súper'),
      ('SORIANA',          'Súper'),
      ('CHEDRAUI',         'Súper'),
      ('LA COMER',         'Súper'),
      ('COSTCO',           'Súper'),
      ('UBER EATS',        'Comida'),
      ('RAPPI',            'Comida'),
      ('DIDI FOOD',        'Comida'),
      ('STARBUCKS',        'Comida'),
      ('MCDONALD',         'Comida'),
      ('BURGER KING',      'Comida'),
      ('DOMINOS',          'Comida'),
      ('REST',             'Comida'),
      ('CAFE',             'Comida'),
      ('COFFEE',           'Comida'),
      ('TST*',             'Comida'),
      ('SQ *',             'Comida'),
      ('CLIP MX',          'Comida'),
      ('UBER',             'Transporte'),
      ('DIDI',             'Transporte'),
      ('CABIFY',           'Transporte'),
      ('METRO',            'Transporte'),
      ('GASOLIN',          'Transporte'),
      ('PEMEX',            'Transporte'),
      ('OMNIBUS DE MEXICO','Transporte'),
      ('NETFLIX',          'Entretenimiento'),
      ('SPOTIFY',          'Entretenimiento'),
      ('CINEPOLIS',        'Entretenimiento'),
      ('CINEMEX',          'Entretenimiento'),
      ('CINEMARK',         'Entretenimiento'),
      ('THEATRES',         'Entretenimiento'),
      ('FANDANGO',         'Entretenimiento'),
      ('STEAM',            'Entretenimiento'),
      ('CFE',              'Servicios'),
      ('TELMEX',           'Servicios'),
      ('AT T',             'Servicios'),
      ('TELCEL',           'Servicios'),
      ('IZZI',             'Servicios'),
      ('TOTALPLAY',        'Servicios'),
      ('AGUA',             'Servicios'),
      ('ANTHROPIC',        'Suscripciones'),
      ('OPENAI',           'Suscripciones'),
      ('GOOGLE',           'Suscripciones'),
      ('APPLE.COM',        'Suscripciones'),
      ('ICLOUD',           'Suscripciones'),
      ('AMAZON PRIME',     'Suscripciones'),
      ('MICROSOFT',        'Suscripciones'),
      ('FARMACIA',         'Salud'),
      ('SIMILARES',        'Salud'),
      ('COSTAMED',         'Salud'),
      ('HOSPITAL',         'Salud'),
      ('DOCTOR',           'Salud'),
      ('UNITED',           'Viajes'),
      ('AEROMEXICO',       'Viajes'),
      ('VOLARIS',          'Viajes'),
      ('VIVA AEROBUS',     'Viajes'),
      ('AIRBNB',           'Viajes'),
      ('BOOKING',          'Viajes'),
      ('HOTEL',            'Viajes'),
      ('MERPAGO',          'Compras'),
      ('MERCADOPAGO',      'Compras'),
      ('AMAZON',           'Compras'),
      ('MERCADOLIBRE',     'Compras'),
      ('LIVERPOOL',        'Compras'),
      ('BMOVIL.PAGO TDC',  'Transferencia'),
      ('PAGO TDC',         'Transferencia'),
      ('Cajita',           'Transferencia'),
      ('SPEI',             'Transferencia')
    ) as t(pattern, category_name)
  loop
    select id into v_cat
      from public.categories
     where user_id = p_user and name = rul.category_name
     limit 1;

    if v_cat is not null then
      insert into public.category_rules (user_id, pattern, match_type, category_id)
      values (p_user, rul.pattern, 'contains', v_cat)
      on conflict do nothing;
    end if;
  end loop;
end;
$$;

-- Trigger: al registrarse un usuario nuevo.
create or replace function public.on_auth_user_created_fn()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.seed_user(new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.on_auth_user_created_fn();


-- ===========================================================================
-- 6. Utilidad: sembrar al usuario que YA existe
--    Si te registraste ANTES de correr este script, entra a la app y luego
--    corre `select public.seed_me();` desde el SQL Editor no funciona
--    (ahí no hay sesión). Llámala desde la app:  supabase.rpc('seed_me')
--    La app ya lo hace sola en el primer login si no encuentra cuentas.
-- ===========================================================================
create or replace function public.seed_me()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return 'sin-sesion';
  end if;
  perform public.seed_user(v_uid);
  return 'ok';
end;
$$;

revoke execute on function public.seed_user(uuid) from anon, authenticated, public;
revoke execute on function public.seed_me() from anon, public;
grant  execute on function public.seed_me() to authenticated;
