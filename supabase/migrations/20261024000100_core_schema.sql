-- Nexo Finance — esquema central (Fase 3)
-- Toda tabela com dados de empresa tem company_id NOT NULL. Integridade entre tabelas da MESMA
-- empresa é garantida por chaves estrangeiras compostas (id, company_id): um lançamento nunca
-- pode apontar para conta ou categoria de outra empresa, mesmo manipulando a API.

create type public.member_role as enum ('owner', 'admin', 'member', 'viewer');
create type public.tx_kind as enum ('income', 'expense', 'transfer');
create type public.tx_status as enum ('pending', 'settled', 'cancelled');
create type public.alert_state as enum ('new', 'in_review', 'resolved', 'ignored');

-- ─── Planos (preparação comercial; valores = limites reais aplicados hoje) ───
create table public.plan_limits (
  plan text primary key,
  max_members int not null check (max_members > 0),
  max_import_rows int not null check (max_import_rows > 0),
  max_companies_per_user int not null check (max_companies_per_user > 0),
  ai_monthly_analyses int not null default 0 check (ai_monthly_analyses >= 0)
);
insert into public.plan_limits (plan, max_members, max_import_rows, max_companies_per_user, ai_monthly_analyses)
values ('trial', 3, 5000, 3, 0);

-- ─── Perfis (dados pessoais mínimos) ───
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 120),
  created_at timestamptz not null default now()
);

-- ─── Empresas e membros ───
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  timezone text not null default 'America/Sao_Paulo' check (char_length(timezone) <= 64),
  currency char(3) not null default 'BRL' check (currency = 'BRL'),
  plan text not null default 'trial' references public.plan_limits (plan),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_members (
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index company_members_user_idx on public.company_members (user_id);

-- ─── Contas e categorias ───
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  opening_balance numeric(14, 2) not null default 0,
  opening_date date not null,
  created_at timestamptz not null default now(),
  unique (id, company_id),
  unique (company_id, name)
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 60),
  kind public.tx_kind not null check (kind in ('income', 'expense')),
  fixed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, company_id)
);
create unique index categories_unique_name on public.categories (company_id, kind, lower(btrim(name)));

-- ─── Importações ───
create table public.imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  file_name text not null check (char_length(file_name) between 1 and 255),
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  actor uuid references auth.users (id) on delete set null default auth.uid(),
  total_rows int not null check (total_rows >= 0),
  imported int not null check (imported >= 0),
  skipped int not null check (skipped >= 0),
  errors int not null check (errors >= 0),
  warnings int not null check (warnings >= 0),
  created_at timestamptz not null default now(),
  unique (id, company_id)
);
create index imports_company_hash_idx on public.imports (company_id, file_hash);

-- ─── Lançamentos ───
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  kind public.tx_kind not null,
  status public.tx_status not null,
  description text not null check (char_length(btrim(description)) between 1 and 200),
  counterparty text check (counterparty is null or char_length(counterparty) <= 120),
  category_id uuid,
  account_id uuid not null,
  to_account_id uuid,
  amount numeric(14, 2) not null check (amount > 0),
  competence_date date not null,
  due_date date not null,
  settled_date date,
  recurrence_id uuid,
  notes text check (notes is null or char_length(notes) <= 500),
  source text not null default 'manual' check (source in ('manual', 'import')),
  import_id uuid,
  source_ref text check (source_ref is null or char_length(source_ref) <= 300),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Mesma empresa obrigatória para conta, conta de destino, categoria e importação.
  foreign key (account_id, company_id) references public.accounts (id, company_id),
  foreign key (to_account_id, company_id) references public.accounts (id, company_id),
  foreign key (category_id, company_id) references public.categories (id, company_id) on delete set null (category_id),
  foreign key (import_id, company_id) references public.imports (id, company_id) on delete set null (import_id),

  constraint settled_requires_date check (status <> 'settled' or settled_date is not null),
  constraint only_settled_has_date check (status = 'settled' or settled_date is null),
  constraint transfer_requires_destination check ((kind = 'transfer') = (to_account_id is not null)),
  constraint transfer_has_no_category check (kind <> 'transfer' or category_id is null),
  constraint transfer_distinct_accounts check (to_account_id is null or to_account_id <> account_id)
);
create index transactions_company_due_idx on public.transactions (company_id, due_date);
create index transactions_company_settled_idx on public.transactions (company_id, settled_date) where settled_date is not null;
create index transactions_company_competence_idx on public.transactions (company_id, competence_date);
create index transactions_company_status_idx on public.transactions (company_id, status, kind);
-- Idempotência de importação: a mesma linha de origem não entra duas vezes na mesma empresa.
create unique index transactions_source_ref_uniq on public.transactions (company_id, source_ref) where source_ref is not null;

-- ─── Estado dos alertas, configurações, cenários ───
create table public.alert_states (
  company_id uuid not null references public.companies (id) on delete cascade,
  fingerprint text not null check (char_length(fingerprint) between 1 and 2000),
  state public.alert_state not null,
  note text check (note is null or char_length(note) <= 500),
  updated_by uuid references auth.users (id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (company_id, fingerprint)
);

create table public.company_settings (
  company_id uuid primary key references public.companies (id) on delete cascade,
  alert_config jsonb not null default '{}'::jsonb check (jsonb_typeof(alert_config) = 'object' and pg_column_size(alert_config) < 4096),
  custom_scenario jsonb not null default '{}'::jsonb check (jsonb_typeof(custom_scenario) = 'object' and pg_column_size(custom_scenario) < 4096),
  updated_at timestamptz not null default now()
);

create table public.scenarios (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  horizon_days int not null check (horizon_days between 1 and 366),
  decisions jsonb not null check (jsonb_typeof(decisions) = 'array' and pg_column_size(decisions) < 32768),
  as_of date not null,
  result_summary jsonb not null check (jsonb_typeof(result_summary) = 'object'),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index scenarios_company_idx on public.scenarios (company_id, created_at desc);

-- ─── Registro de ações (escrito somente por gatilhos) ───
create table public.audit_logs (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  actor uuid references auth.users (id) on delete set null,
  action text not null check (action in ('create', 'update', 'delete', 'import', 'alert_state', 'settings')),
  entity text not null,
  entity_id text not null,
  summary text not null check (char_length(summary) <= 300),
  at timestamptz not null default now()
);
create index audit_logs_company_idx on public.audit_logs (company_id, at desc);
