-- Produtos: a importação só altera o custo do cadastro quando o VALOR muda (custo igual não grava
-- só a data, o que gerava um registro de auditoria por venda). Para o estoque, uma recontagem em data
-- mais nova continua valendo mesmo com o mesmo número (zera a estimativa de vendas desde a contagem).
-- Recria import_product_sales da 000800 com essa única diferença.

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
  v_n int;
  v_today date;
  v_row record;
  v_product uuid;
begin
  perform public.rate_limit_product_import();

  if not public.can_write(p_company) then
    raise exception 'Sem permissão para importar nesta empresa' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Lote de vendas inválido na importação' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_rows);
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
    if v_row.quantity is null
       or v_row.quantity::text in ('NaN', 'Infinity', '-Infinity')
       or round(v_row.quantity, 3) <= 0 then
      raise exception 'Quantidade inválida na importação' using errcode = '22023';
    end if;
    if v_row.revenue is null
       or v_row.revenue::text in ('NaN', 'Infinity', '-Infinity')
       or round(v_row.revenue, 2) < 0 then
      raise exception 'Receita inválida na importação' using errcode = '22023';
    end if;
    if v_row.unit_cost is not null
       and (v_row.unit_cost::text in ('NaN', 'Infinity', '-Infinity') or round(v_row.unit_cost, 2) < 0) then
      raise exception 'Custo inválido na importação' using errcode = '22023';
    end if;
    if v_row.stock is not null
       and (v_row.stock::text in ('NaN', 'Infinity', '-Infinity') or round(v_row.stock, 3) < 0) then
      raise exception 'Estoque inválido na importação' using errcode = '22023';
    end if;
    if v_row.source_ref is null or char_length(v_row.source_ref) not between 1 and 300 then
      raise exception 'Identificador de origem inválido na importação' using errcode = '22023';
    end if;

    v_product := null;
    if v_row.product_id is not null then
      select id into v_product from public.products where company_id = p_company and id = v_row.product_id;
    end if;
    if v_product is null and v_row.product_code is not null and public.product_code_key(v_row.product_code) <> '' then
      select id into v_product from public.products
       where company_id = p_company and public.product_code_key(code) = public.product_code_key(v_row.product_code);
    end if;
    if v_product is null then
      select id into v_product from public.products
       where company_id = p_company and public.product_name_key(name) = public.product_name_key(v_row.product_name);
    end if;

    if v_product is null then
      insert into public.products (company_id, name, code, unit, cost_price, cost_updated_at, stock, stock_updated_at)
      values (
        p_company,
        btrim(v_row.product_name),
        nullif(btrim(v_row.product_code), ''),
        'un',
        case when v_row.unit_cost is null then null else round(v_row.unit_cost, 2) end,
        case when v_row.unit_cost is null then null else v_row.sale_date end,
        case when v_row.stock is null then null else round(v_row.stock, 3) end,
        case when v_row.stock is null then null else v_row.sale_date end
      ) returning id into v_product;
    else
      -- O custo só muda quando o cadastro está sem custo ou quando esta venda é a mais recente já
      -- vista (cost_updated_at). Planilha da venda mais nova para a mais antiga não regride o custo.
      update public.products
         set cost_price = case
               when v_row.unit_cost is not null
                and (cost_price is null or cost_updated_at is null or v_row.sale_date >= cost_updated_at)
                and round(v_row.unit_cost, 2) is distinct from cost_price
                 then round(v_row.unit_cost, 2)
               else cost_price
             end,
             cost_updated_at = case
               when v_row.unit_cost is not null
                and (cost_price is null or cost_updated_at is null or v_row.sale_date >= cost_updated_at)
                and round(v_row.unit_cost, 2) is distinct from cost_price
                 then v_row.sale_date
               else cost_updated_at
             end,
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
       where company_id = p_company and id = v_product
         and (
           (
             v_row.unit_cost is not null
             and (cost_price is null or cost_updated_at is null or v_row.sale_date >= cost_updated_at)
             and round(v_row.unit_cost, 2) is distinct from cost_price
           )
           or (
             v_row.stock is not null
             and (stock_updated_at is null or v_row.sale_date >= stock_updated_at)
             and (round(v_row.stock, 3) is distinct from stock or v_row.sale_date is distinct from stock_updated_at)
           )
         );
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
