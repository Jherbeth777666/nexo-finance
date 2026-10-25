-- Produtos e vendas por item (Fase 5)
-- Quantidades em milésimos inteiros (NUMERIC(14,3) no banco) e dinheiro em centavos na API.
-- O histórico de vendas fica fora do snapshot: a tela carrega apenas a janela necessária.
-- A importação é atômica e idempotente por (company_id, source_ref).

create table public.products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  code text check (code is null or char_length(btrim(code)) between 1 and 40),
  unit text not null default 'un' check (char_length(btrim(unit)) between 1 and 10),
  cost_price numeric(14, 2) check (cost_price is null or cost_price >= 0),
  stock numeric(14, 3) check (stock is null or stock >= 0),
  stock_updated_at date,
  min_stock numeric(14, 3) check (min_stock is null or min_stock >= 0),
  lead_time_days int check (lead_time_days is null or lead_time_days between 0 and 365),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  constraint stock_date_matches check ((stock is null) = (stock_updated_at is null))
);
create unique index products_company_name_uniq on public.products (company_id, lower(btrim(name)));
create unique index products_company_code_uniq on public.products (company_id, lower(btrim(code))) where code is not null;
create index products_company_idx on public.products (company_id, name);

create table public.product_sales (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  product_id uuid not null,
  sale_date date not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  revenue numeric(14, 2) not null check (revenue >= 0),
  unit_cost numeric(14, 2) check (unit_cost is null or unit_cost >= 0),
  source_ref text check (source_ref is null or char_length(source_ref) between 1 and 300),
  import_id uuid,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (product_id, company_id) references public.products (id, company_id) on delete cascade,
  foreign key (import_id, company_id) references public.imports (id, company_id) on delete set null (import_id)
);
create index product_sales_company_date_idx on public.product_sales (company_id, sale_date);
create index product_sales_product_date_idx on public.product_sales (product_id, sale_date);
create unique index product_sales_source_ref_uniq on public.product_sales (company_id, source_ref) where source_ref is not null;

create table public.local_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  start_date date not null,
  end_date date,
  kind text not null default 'local' check (kind in ('regional', 'national', 'local')),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint local_event_dates check (end_date is null or end_date >= start_date)
);
create index local_events_company_date_idx on public.local_events (company_id, start_date);
create unique index local_events_company_name_date_uniq on public.local_events (company_id, lower(btrim(name)), start_date);

alter table public.products enable row level security;
alter table public.product_sales enable row level security;
alter table public.local_events enable row level security;
revoke all on public.products, public.product_sales, public.local_events from public, anon;

create policy products_select on public.products for select to authenticated using (public.is_member(company_id));
create policy products_insert on public.products for insert to authenticated with check (public.can_write(company_id));
create policy products_update on public.products for update to authenticated
  using (public.can_write(company_id)) with check (public.can_write(company_id));
create policy products_delete on public.products for delete to authenticated using (public.can_write(company_id));

create policy product_sales_select on public.product_sales for select to authenticated using (public.is_member(company_id));

create policy local_events_select on public.local_events for select to authenticated using (public.is_member(company_id));
create policy local_events_insert on public.local_events for insert to authenticated with check (public.can_write(company_id));
create policy local_events_update on public.local_events for update to authenticated
  using (public.can_write(company_id)) with check (public.can_write(company_id));
create policy local_events_delete on public.local_events for delete to authenticated using (public.can_write(company_id));

grant select, insert, delete on public.products to authenticated;
-- UPDATE só nas colunas editáveis: company_id, created_by e datas de controle não são do cliente.
grant update (name, code, unit, cost_price, stock, stock_updated_at, min_stock, lead_time_days) on public.products to authenticated;
grant select on public.product_sales to authenticated;
grant select, insert, update, delete on public.local_events to authenticated;

-- ─── updated_at, company_id e autoria ───
create trigger products_touch before update on public.products for each row execute function public.touch_updated_at();
create trigger products_company_lock before update on public.products for each row execute function public.prevent_company_change();
create trigger local_events_company_lock before update on public.local_events for each row execute function public.prevent_company_change();

create or replace function public.validate_product()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  if new.stock_updated_at is not null then
    declare
      v_today date;
    begin
      select (now() at time zone c.timezone)::date into v_today from public.companies c where c.id = new.company_id;
      if new.stock_updated_at > v_today then
        raise exception 'Data do estoque não pode estar no futuro' using errcode = '23514';
      end if;
    end;
  end if;
  return new;
end $$;

create trigger products_validate before insert or update on public.products
for each row execute function public.validate_product();

create or replace function public.validate_local_event()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;

create trigger local_events_validate before insert or update on public.local_events
for each row execute function public.validate_local_event();

-- ─── Auditoria ───
create or replace function public.audit_product()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (new.company_id, auth.uid(), 'create', 'product', new.id::text, left('Cadastrou o produto "' || new.name || '"', 300));
    return new;
  elsif tg_op = 'UPDATE' then
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (new.company_id, auth.uid(), 'update', 'product', new.id::text, left('Atualizou o produto "' || new.name || '"', 300));
    return new;
  else
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (old.company_id, auth.uid(), 'delete', 'product', old.id::text, left('Excluiu o produto "' || old.name || '"', 300));
    return old;
  end if;
end $$;

create trigger products_audit after insert or update or delete on public.products
for each row execute function public.audit_product();

create or replace function public.audit_local_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
  values (new.company_id, auth.uid(), 'create', 'local_event', new.id::text, left('Cadastrou o evento "' || new.name || '"', 300));
  return new;
end $$;

create trigger local_events_audit after insert on public.local_events
for each row execute function public.audit_local_event();

-- ─── Limite de requisições da importação de vendas por item ───
create or replace function public.rate_limit_product_import()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.consume_rate_limit('import_products', 10, 600);
end $$;

revoke all on function public.rate_limit_product_import() from public, anon;
grant execute on function public.rate_limit_product_import() to authenticated;

-- ─── Importação atômica de vendas por item ───
-- O servidor resolve o produto por id, código ou nome (nesta ordem), cria quando necessário e
-- atualiza custo/estoque. Devoluções já vêm filtradas do cliente; aqui só entram linhas válidas.
create or replace function public.import_product_sales(
  p_company uuid,
  p_file_name text,
  p_file_hash text,
  p_rows jsonb,
  p_stats jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_import uuid;
  v_max int;
  v_n int := jsonb_array_length(p_rows);
  v_today date;
  v_row record;
  v_product uuid;
begin
  perform public.rate_limit_product_import();

  if not public.can_write(p_company) then
    raise exception 'Sem permissão para importar nesta empresa' using errcode = '42501';
  end if;
  if p_file_name is null or char_length(btrim(p_file_name)) not between 1 and 255 then
    raise exception 'Nome do arquivo inválido' using errcode = '22023';
  end if;
  if p_file_hash is null or p_file_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Identificador do arquivo inválido' using errcode = '22023';
  end if;
  select pl.max_import_rows, (now() at time zone c.timezone)::date
    into v_max, v_today
    from public.companies c join public.plan_limits pl on pl.plan = c.plan
   where c.id = p_company;
  if v_n = 0 or v_n > v_max then
    raise exception 'Importação deve ter entre 1 e % linhas', v_max using errcode = '54000';
  end if;

  insert into public.imports (company_id, file_name, file_hash, total_rows, imported, skipped, errors, warnings)
  values (
    p_company,
    btrim(p_file_name),
    p_file_hash,
    coalesce((p_stats ->> 'total_rows')::int, (p_stats ->> 'totalRows')::int, v_n),
    v_n,
    coalesce((p_stats ->> 'skipped')::int, 0),
    coalesce((p_stats ->> 'errors')::int, 0),
    coalesce((p_stats ->> 'warnings')::int, 0)
  ) returning id into v_import;

  for v_row in
    select * from jsonb_to_recordset(p_rows) as r(
      product_name text,
      product_code text,
      product_id uuid,
      sale_date date,
      quantity numeric,
      revenue numeric,
      unit_cost numeric,
      stock numeric,
      source_ref text
    )
  loop
    if v_row.product_name is null or char_length(btrim(v_row.product_name)) not between 2 and 120 then
      raise exception 'Nome do produto inválido na importação' using errcode = '22023';
    end if;
    if v_row.product_code is not null and char_length(btrim(v_row.product_code)) > 40 then
      raise exception 'Código do produto inválido na importação' using errcode = '22023';
    end if;
    if v_row.sale_date is null or v_row.sale_date > v_today then
      raise exception 'Data da venda inválida na importação' using errcode = '22023';
    end if;
    if v_row.quantity is null or round(v_row.quantity, 3) <= 0 then
      raise exception 'Quantidade inválida na importação' using errcode = '22023';
    end if;
    if v_row.revenue is null or round(v_row.revenue, 2) < 0 then
      raise exception 'Receita inválida na importação' using errcode = '22023';
    end if;
    if v_row.unit_cost is not null and round(v_row.unit_cost, 2) < 0 then
      raise exception 'Custo inválido na importação' using errcode = '22023';
    end if;
    if v_row.stock is not null and round(v_row.stock, 3) < 0 then
      raise exception 'Estoque inválido na importação' using errcode = '22023';
    end if;
    if v_row.source_ref is null or char_length(v_row.source_ref) not between 1 and 300 then
      raise exception 'Identificador de origem inválido na importação' using errcode = '22023';
    end if;

    v_product := null;
    if v_row.product_id is not null then
      select id into v_product from public.products where company_id = p_company and id = v_row.product_id;
    end if;
    if v_product is null and v_row.product_code is not null then
      select id into v_product from public.products
       where company_id = p_company and lower(btrim(code)) = lower(btrim(v_row.product_code));
    end if;
    if v_product is null then
      select id into v_product from public.products
       where company_id = p_company and lower(btrim(name)) = lower(btrim(v_row.product_name));
    end if;

    if v_product is null then
      insert into public.products (company_id, name, code, unit, cost_price, stock, stock_updated_at)
      values (
        p_company,
        btrim(v_row.product_name),
        nullif(btrim(v_row.product_code), ''),
        'un',
        case when v_row.unit_cost is null then null else round(v_row.unit_cost, 2) end,
        case when v_row.stock is null then null else round(v_row.stock, 3) end,
        case when v_row.stock is null then null else v_row.sale_date end
      ) returning id into v_product;
    else
      update public.products
         set cost_price = coalesce(round(v_row.unit_cost, 2), cost_price),
             stock = case
               when v_row.stock is not null and (stock_updated_at is null or v_row.sale_date >= stock_updated_at)
                 then round(v_row.stock, 3)
               else stock
             end,
             stock_updated_at = case
               when v_row.stock is not null and (stock_updated_at is null or v_row.sale_date >= stock_updated_at)
                 then v_row.sale_date
               else stock_updated_at
             end,
             updated_at = now()
       where company_id = p_company and id = v_product;
    end if;

    insert into public.product_sales (company_id, product_id, sale_date, quantity, revenue, unit_cost, source_ref, import_id)
    values (
      p_company,
      v_product,
      v_row.sale_date,
      round(v_row.quantity, 3),
      round(v_row.revenue, 2),
      case when v_row.unit_cost is null then null else round(v_row.unit_cost, 2) end,
      v_row.source_ref,
      v_import
    );
  end loop;

  return v_import;
end $$;

revoke all on function public.import_product_sales(uuid, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.import_product_sales(uuid, text, text, jsonb, jsonb) to authenticated;

-- ─── Resumo agregado por produto (paridade com analytics.ts) ───
-- Custo médio ponderado apenas das vendas que informaram custo; sem custo, a coluna é null.
create or replace function public.product_sales_summary(p_company uuid, p_from date, p_to date)
returns table (
  product_id uuid,
  quantity numeric(14, 3),
  revenue numeric(14, 2),
  sales_count int,
  last_sale_date date,
  avg_unit_cost numeric(14, 2)
)
language sql stable security invoker set search_path = ''
as $$
  select
    s.product_id,
    sum(s.quantity)::numeric(14, 3),
    sum(s.revenue)::numeric(14, 2),
    count(*)::int,
    max(s.sale_date),
    case
      when sum(s.quantity) filter (where s.unit_cost is not null) > 0
        then (sum(s.quantity * s.unit_cost) filter (where s.unit_cost is not null)
              / sum(s.quantity) filter (where s.unit_cost is not null))::numeric(14, 2)
      else null
    end
  from public.product_sales s
  where s.company_id = p_company
    and p_from is not null and p_to is not null and p_to >= p_from
    and p_to - p_from <= 366
    and s.sale_date between p_from and p_to
    and public.is_member(p_company)
  group by s.product_id;
$$;

revoke all on function public.product_sales_summary(uuid, date, date) from public, anon;
grant execute on function public.product_sales_summary(uuid, date, date) to authenticated;
