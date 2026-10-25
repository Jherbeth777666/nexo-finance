-- Fase 5 — análises de IA server-side.
-- O cliente NUNCA escreve em ai_analyses: apenas membros leem o histórico/cache. A vaga da cota é
-- reservada por ai_quota_reserve (linha "pending", na mesma transação da checagem) e a Edge Function
-- finaliza essa linha com service_role. Nenhuma RPC de gravação de resultado é exposta a authenticated.

create table public.ai_analyses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  agent text not null check (agent in ('cash', 'expenses', 'scenarios')),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) < 32768)),
  review jsonb check (review is null or (jsonb_typeof(review) = 'object' and pg_column_size(review) < 8192)),
  provider text not null check (provider in ('none', 'gemini', 'fake')),
  model text check (model is null or char_length(model) between 1 and 120),
  duration_ms int not null check (duration_ms between 0 and 300000),
  status text not null check (status in ('pending', 'ok', 'rejected', 'error')),
  created_at timestamptz not null default now()
);

create index ai_analyses_cache_idx on public.ai_analyses (company_id, agent, input_hash, created_at desc);
create index ai_analyses_quota_idx on public.ai_analyses (company_id, created_at desc);

alter table public.ai_analyses enable row level security;

create policy ai_analyses_select on public.ai_analyses for select to authenticated using (public.is_member(company_id));

-- Leitura apenas para membros; escrita exclusiva do service_role na Edge Function.
revoke all on public.ai_analyses from public, anon, authenticated;
grant select on public.ai_analyses to authenticated;
-- O service_role (só a Edge Function) tem os privilégios padrão do Supabase; por código, ele apenas
-- finaliza a linha reservada por ai_quota_reserve, nunca insere fora da cota.

-- ─── Limite de requisições do agente (por usuário, balde e janela fixos) ───
create or replace function public.rate_limit_ai()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.consume_rate_limit('ai_analysis', 10, 600);
end $$;

revoke all on function public.rate_limit_ai() from public, anon;
grant execute on function public.rate_limit_ai() to authenticated;

-- ─── Cota mensal do plano (reserva atômica) ───
-- Conta TODAS as chamadas ao provedor no mês corrente da empresa: pendentes, ok, reprovadas pelo
-- revisor e erros. Acertos de cache não chegam aqui (a Edge Function consulta o cache antes).
-- A checagem e a reserva acontecem na MESMA transação, com a empresa travada: duas análises
-- disparadas juntas não furam a cota (um FOR UPDATE seguido de insert em outra chamada furaria).
-- A Edge Function depois só atualiza a linha reservada (service_role).
create or replace function public.ai_quota_reserve(p_company uuid, p_agent text, p_input_hash text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_tz text;
  v_limit int;
  v_used int;
  v_start timestamptz;
  v_end timestamptz;
  v_id uuid;
begin
  if p_company is null then
    raise exception 'Empresa inválida' using errcode = '22023';
  end if;
  if p_agent is null or p_agent not in ('cash', 'expenses', 'scenarios') then
    raise exception 'Agente inválido' using errcode = '22023';
  end if;
  if p_input_hash is null or p_input_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Identificador de entrada inválido' using errcode = '22023';
  end if;
  if not public.is_member(p_company) then
    raise exception 'Sem permissão para esta empresa' using errcode = '42501';
  end if;

  select c.timezone, pl.ai_monthly_analyses into v_tz, v_limit
  from public.companies c
  join public.plan_limits pl on pl.plan = c.plan
  where c.id = p_company
  for update of c;

  if not found then
    raise exception 'Empresa não encontrada' using errcode = '42501';
  end if;
  if v_limit <= 0 then
    raise exception 'Cota mensal de análises de IA esgotada' using errcode = '54000';
  end if;

  v_start := date_trunc('month', now() at time zone v_tz) at time zone v_tz;
  v_end := (date_trunc('month', now() at time zone v_tz) + interval '1 month') at time zone v_tz;

  select count(*) into v_used
  from public.ai_analyses a
  where a.company_id = p_company
    and a.created_at >= v_start
    and a.created_at < v_end;

  if v_used >= v_limit then
    raise exception 'Cota mensal de análises de IA esgotada' using errcode = '54000';
  end if;

  insert into public.ai_analyses (company_id, agent, input_hash, provider, duration_ms, status)
  values (p_company, p_agent, p_input_hash, 'none', 0, 'pending')
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.ai_quota_reserve(uuid, text, text) from public, anon;
grant execute on function public.ai_quota_reserve(uuid, text, text) to authenticated;

-- ─── Totais por categoria para o agente de despesas ───
-- Security invoker: o RLS de categories/transactions continua valendo. Retorna só nome, tipo e
-- soma — nunca descrições, contrapartes ou notas.
create or replace function public.category_totals(p_company uuid, p_as_of date, p_days int default 90)
returns table (name text, kind public.tx_kind, total numeric(14, 2))
language sql stable security invoker set search_path = ''
as $$
  select c.name, c.kind, sum(t.amount)::numeric(14, 2) as total
  from public.categories c
  join public.transactions t on t.category_id = c.id and t.company_id = c.company_id
  where c.company_id = p_company
    and p_as_of is not null
    and p_days between 1 and 366
    and t.kind in ('income', 'expense')
    and t.status <> 'cancelled'
    and t.competence_date <= p_as_of
    and t.competence_date >= p_as_of - (p_days - 1)
    and exists (select 1 from public.companies co where co.id = p_company)
  group by c.id, c.name, c.kind
  order by sum(t.amount) desc, c.name;
$$;

revoke all on function public.category_totals(uuid, date, int) from public, anon;
grant execute on function public.category_totals(uuid, date, int) to authenticated;
