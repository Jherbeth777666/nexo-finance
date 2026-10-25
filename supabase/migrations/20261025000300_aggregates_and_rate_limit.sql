-- Fase 4 — agregações no banco e limite de requisições.
-- Os agregados espelham src/domain/finance/metrics.ts e projection.ts (BASE_SCENARIO); a paridade
-- centavo a centavo é coberta por supabase/tests/aggregates_and_rate_limit.test.ts.
-- A importação passa a consumir um limite por usuário ANTES de validar a empresa; o limite vive no
-- banco, então também protege chamadas diretas ao PostgREST.

-- ─── Limite de requisições (chave = auth.uid(), nunca recebida do cliente) ───
create table public.rate_limits (
  user_id uuid not null references auth.users (id) on delete cascade,
  bucket text not null check (char_length(btrim(bucket)) between 1 and 64),
  window_start timestamptz not null,
  hits int not null check (hits >= 0),
  primary key (user_id, bucket)
);

alter table public.rate_limits enable row level security;
-- Sem policies: nem anon nem authenticated leem/escrevem diretamente. Só a função security definer.
revoke all on public.rate_limits from public, anon, authenticated;

create or replace function public.consume_rate_limit(p_bucket text, p_max int, p_window_seconds int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_bucket text := btrim(coalesce(p_bucket, ''));
  v_now timestamptz := now();
  v_hits int;
begin
  if v_user is null then
    raise exception 'Autenticação necessária' using errcode = '42501';
  end if;
  if char_length(v_bucket) not between 1 and 64 then
    raise exception 'Identificador de limite inválido' using errcode = '22023';
  end if;
  if p_max is null or p_max < 1 or p_max > 10000 then
    raise exception 'Limite inválido' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'Janela de limite inválida' using errcode = '22023';
  end if;

  -- Janela fixa, atômica: a própria linha é travada pelo ON CONFLICT.
  insert into public.rate_limits as rl (user_id, bucket, window_start, hits)
  values (v_user, v_bucket, v_now, 1)
  on conflict (user_id, bucket) do update
    set hits = case
        when rl.window_start <= v_now - make_interval(secs => p_window_seconds) then 1
        else rl.hits + 1
      end,
      window_start = case
        when rl.window_start <= v_now - make_interval(secs => p_window_seconds) then v_now
        else rl.window_start
      end
  returning rl.hits into v_hits;

  if v_hits > p_max then
    raise exception 'Muitas solicitações. Tente novamente em alguns minutos.' using errcode = '54000';
  end if;
end $$;

-- Função genérica é INTERNA: se o cliente pudesse escolher p_window_seconds, bastaria chamá-la
-- com janela de 1 s para zerar o próprio contador e furar o limite. O cliente só chama os
-- invólucros abaixo, com balde e limites fixos.
revoke all on function public.consume_rate_limit(text, int, int) from public, anon, authenticated;

create or replace function public.rate_limit_import()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.consume_rate_limit('import_transactions', 10, 600);
end $$;

create or replace function public.rate_limit_import_validation()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.consume_rate_limit('import_validate', 30, 600);
end $$;

revoke all on function public.rate_limit_import(), public.rate_limit_import_validation() from public, anon;
grant execute on function public.rate_limit_import(), public.rate_limit_import_validation() to authenticated;

-- ─── Importação atômica (corpo original + limite por usuário) ───
create or replace function public.import_transactions(
  p_company uuid,
  p_file_name text,
  p_file_hash text,
  p_rows jsonb,
  p_stats jsonb
) returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  v_import uuid;
  v_max int;
  v_n int := jsonb_array_length(p_rows);
begin
  perform public.rate_limit_import();

  if not public.can_write(p_company) then
    raise exception 'Sem permissão para importar nesta empresa' using errcode = '42501';
  end if;
  select pl.max_import_rows into v_max from public.companies c join public.plan_limits pl on pl.plan = c.plan where c.id = p_company;
  if v_n = 0 or v_n > v_max then
    raise exception 'Importação deve ter entre 1 e % linhas', v_max using errcode = '54000';
  end if;

  insert into public.imports (company_id, file_name, file_hash, total_rows, imported, skipped, errors, warnings)
  values (p_company, p_file_name, p_file_hash,
    (p_stats ->> 'total_rows')::int, v_n, (p_stats ->> 'skipped')::int, (p_stats ->> 'errors')::int, (p_stats ->> 'warnings')::int)
  returning id into v_import;

  insert into public.transactions (
    company_id, kind, status, description, counterparty, category_id, account_id, amount,
    competence_date, due_date, settled_date, notes, source, import_id, source_ref)
  select p_company, r.kind, r.status, r.description, r.counterparty, r.category_id, r.account_id, r.amount,
    r.competence_date, r.due_date, r.settled_date, r.notes, 'import', v_import, r.source_ref
  from jsonb_to_recordset(p_rows) as r(
    kind public.tx_kind, status public.tx_status, description text, counterparty text, category_id uuid,
    account_id uuid, amount numeric, competence_date date, due_date date, settled_date date, notes text, source_ref text);

  return v_import;
end $$;

revoke all on function public.import_transactions(uuid, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.import_transactions(uuid, text, text, jsonb, jsonb) to authenticated;

-- ─── Saldo por conta (metrics.ts: accountBalances) ───
-- A abertura só entra se opening_date <= p_as_of. Cada conta aplica a própria opening_date ao
-- filtro de settled_date, inclusive nas duas pontas de uma transferência.
create or replace function public.company_balances(p_company uuid, p_as_of date)
returns table (
  account_id uuid,
  balance numeric(14, 2),
  settled_count int
)
language sql stable security invoker set search_path = ''
as $$
  select
    a.id,
    (
      case when a.opening_date <= p_as_of then a.opening_balance else 0::numeric(14, 2) end
      + coalesce(
          sum(
            case t.kind
              when 'income' then t.amount
              when 'expense' then -t.amount
              when 'transfer' then case when t.account_id = a.id then -t.amount else t.amount end
            end
          ),
          0::numeric(14, 2)
        )
    )::numeric(14, 2),
    count(t.id)::int
  from public.accounts a
  left join public.transactions t
    on t.company_id = a.company_id
   and t.status = 'settled'
   and t.settled_date is not null
   and t.settled_date >= a.opening_date
   and t.settled_date <= p_as_of
   and (t.account_id = a.id or t.to_account_id = a.id)
  where a.company_id = p_company
    and exists (select 1 from public.companies c where c.id = p_company)
  group by a.id, a.opening_date, a.opening_balance;
$$;

revoke all on function public.company_balances(uuid, date) from public, anon;
grant execute on function public.company_balances(uuid, date) to authenticated;

-- ─── Evolução mensal (metrics.ts: monthlyEvolution) ───
-- cashIn/cashOut NÃO filtram a opening_date da conta (regime de caixa por lançamento), enquanto o
-- endBalance usa company_balances em least(último dia do mês, p_as_of).
create or replace function public.monthly_evolution(p_company uuid, p_as_of date, p_months int default 6)
returns table (
  month text,
  cash_in numeric(14, 2),
  cash_out numeric(14, 2),
  net numeric(14, 2),
  end_balance numeric(14, 2)
)
language sql stable security invoker set search_path = ''
as $$
  with months as (
    select
      to_char(gs, 'YYYY-MM') as month,
      gs::date as month_start,
      (gs + interval '1 month - 1 day')::date as last_day
    from generate_series(
      date_trunc('month', p_as_of::timestamp) - make_interval(months => p_months - 1),
      date_trunc('month', p_as_of::timestamp),
      interval '1 month'
    ) as gs
    where p_as_of is not null
      and p_months between 1 and 120
      and exists (select 1 from public.companies c where c.id = p_company)
  )
  select
    m.month,
    coalesce(sum(t.amount) filter (where t.kind = 'income'), 0::numeric(14, 2))::numeric(14, 2),
    coalesce(sum(t.amount) filter (where t.kind = 'expense'), 0::numeric(14, 2))::numeric(14, 2),
    (
      coalesce(sum(t.amount) filter (where t.kind = 'income'), 0::numeric(14, 2))
      - coalesce(sum(t.amount) filter (where t.kind = 'expense'), 0::numeric(14, 2))
    )::numeric(14, 2),
    coalesce(
      (select sum(b.balance) from public.company_balances(p_company, least(m.last_day, p_as_of)) b),
      0::numeric(14, 2)
    )::numeric(14, 2)
  from months m
  left join public.transactions t
    on t.company_id = p_company
   and t.status = 'settled'
   and t.settled_date is not null
   and t.kind <> 'transfer'
   and t.settled_date <= p_as_of
   and t.settled_date >= m.month_start
   and t.settled_date <= m.last_day
  group by m.month, m.month_start, m.last_day
  order by m.month_start;
$$;

revoke all on function public.monthly_evolution(uuid, date, int) from public, anon;
grant execute on function public.monthly_evolution(uuid, date, int) to authenticated;

-- ─── Projeção-base (projection.ts: projectCashflow com BASE_SCENARIO) ───
-- Série diária + resumo. Fora do escopo: dateOverrides, extraEvents, atraso/haircut de
-- recebíveis, includeOverdueReceivables e receita semanal estimada. A lista detalhada de events
-- por dia também não é retornada (apenas os agregados).
create or replace function public.base_projection(p_company uuid, p_as_of date, p_days int)
returns table (
  day date,
  inflow numeric(14, 2),
  outflow numeric(14, 2),
  balance numeric(14, 2),
  pressure_rank int,
  start_balance numeric(14, 2),
  end_balance numeric(14, 2),
  total_in numeric(14, 2),
  total_out numeric(14, 2),
  min_balance numeric(14, 2),
  min_date date,
  first_negative_date date,
  negative_days int,
  last_inflow_date date,
  overdue_receivables_amount numeric(14, 2),
  overdue_receivables_count int,
  beyond_horizon_amount numeric(14, 2),
  beyond_horizon_count int
)
language sql stable security invoker set search_path = ''
as $$
  with visible as (
    select p_as_of as as_of, (p_as_of + (p_days - 1)) as end_date, p_days as days
    where p_as_of is not null
      and p_days between 1 and 366
      and exists (select 1 from public.companies c where c.id = p_company)
  ),
  start as (
    select coalesce((select sum(b.balance) from public.company_balances(p_company, v.as_of) b), 0::numeric(14, 2))::numeric(14, 2) as start_balance
    from visible v
  ),
  events as (
    select
      t.kind,
      t.amount,
      case when t.kind = 'income' then t.due_date else greatest(t.due_date, v.as_of) end as effective_date
    from public.transactions t
    cross join visible v
    where t.company_id = p_company
      and t.status = 'pending'
      and t.kind <> 'transfer'
      and not (t.kind = 'income' and t.due_date < v.as_of)
      and (case when t.kind = 'income' then t.due_date else greatest(t.due_date, v.as_of) end) <= v.end_date
  ),
  excluded_overdue as (
    select
      coalesce(sum(t.amount), 0::numeric(14, 2))::numeric(14, 2) as amount,
      count(*)::int as cnt
    from public.transactions t
    cross join visible v
    where t.company_id = p_company
      and t.status = 'pending'
      and t.kind = 'income'
      and t.due_date < v.as_of
  ),
  excluded_beyond as (
    select
      coalesce(sum(t.amount), 0::numeric(14, 2))::numeric(14, 2) as amount,
      count(*)::int as cnt
    from public.transactions t
    cross join visible v
    where t.company_id = p_company
      and t.status = 'pending'
      and t.kind <> 'transfer'
      and not (t.kind = 'income' and t.due_date < v.as_of)
      and (case when t.kind = 'income' then t.due_date else greatest(t.due_date, v.as_of) end) > v.end_date
  ),
  days as (
    select gs::date as day
    from visible v
    cross join generate_series(v.as_of::timestamp, v.end_date::timestamp, interval '1 day') as gs
  ),
  daily as (
    select
      d.day,
      coalesce(sum(case e.kind when 'income' then e.amount else 0 end), 0::numeric(14, 2))::numeric(14, 2) as inflow,
      coalesce(sum(case e.kind when 'expense' then e.amount else 0 end), 0::numeric(14, 2))::numeric(14, 2) as outflow
    from days d
    left join events e on e.effective_date = d.day
    group by d.day
  ),
  running as (
    select
      d.day,
      d.inflow,
      d.outflow,
      (s.start_balance + sum(d.inflow - d.outflow) over (order by d.day rows between unbounded preceding and current row))::numeric(14, 2) as balance,
      s.start_balance
    from daily d
    cross join start s
  ),
  summary as (
    select
      (select start_balance from start) as start_balance,
      (select balance from running order by day desc limit 1) as end_balance,
      coalesce((select sum(inflow) from running), 0::numeric(14, 2))::numeric(14, 2) as total_in,
      coalesce((select sum(outflow) from running), 0::numeric(14, 2))::numeric(14, 2) as total_out,
      (select balance from running order by balance asc, day asc limit 1) as min_balance,
      (select day from running order by balance asc, day asc limit 1) as min_date,
      (select day from running where balance < 0 order by day asc limit 1) as first_negative_date,
      (select count(*)::int from running where balance < 0) as negative_days,
      (select day from running where inflow > 0 order by day desc limit 1) as last_inflow_date,
      (select amount from excluded_overdue) as overdue_amount,
      (select cnt from excluded_overdue) as overdue_count,
      (select amount from excluded_beyond) as beyond_amount,
      (select cnt from excluded_beyond) as beyond_count
  ),
  pressures as (
    select
      day,
      row_number() over (order by (outflow - inflow) desc, day asc) as rank
    from running
    where outflow - inflow > 0
  )
  select
    r.day,
    r.inflow,
    r.outflow,
    r.balance,
    case when p.rank <= 3 then p.rank::int else null end as pressure_rank,
    s.start_balance,
    s.end_balance,
    s.total_in,
    s.total_out,
    s.min_balance,
    s.min_date,
    s.first_negative_date,
    s.negative_days,
    s.last_inflow_date,
    s.overdue_amount,
    s.overdue_count,
    s.beyond_amount,
    s.beyond_count
  from running r
  cross join summary s
  left join pressures p on p.day = r.day
  order by r.day;
$$;

revoke all on function public.base_projection(uuid, date, int) from public, anon;
grant execute on function public.base_projection(uuid, date, int) to authenticated;
