-- Regras de negócio no servidor: a validação do frontend é conveniência; esta é a garantia.

-- ─── Funções auxiliares de acesso (security definer para não recursar nas políticas) ───
create or replace function public.is_member(p_company uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company_members m
    where m.company_id = p_company and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.can_write(p_company uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company_members m
    where m.company_id = p_company and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin', 'member')
  );
$$;

create or replace function public.is_admin(p_company uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company_members m
    where m.company_id = p_company and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_member(uuid), public.can_write(uuid), public.is_admin(uuid) from public, anon;
grant execute on function public.is_member(uuid), public.can_write(uuid), public.is_admin(uuid) to authenticated;

-- ─── updated_at ───
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger companies_touch before update on public.companies for each row execute function public.touch_updated_at();
create trigger transactions_touch before update on public.transactions for each row execute function public.touch_updated_at();
create trigger settings_touch before update on public.company_settings for each row execute function public.touch_updated_at();

-- ─── company_id e autoria são imutáveis ───
create or replace function public.prevent_company_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.company_id is distinct from old.company_id then
    raise exception 'company_id não pode ser alterado' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger transactions_company_lock before update on public.transactions for each row execute function public.prevent_company_change();
create trigger accounts_company_lock before update on public.accounts for each row execute function public.prevent_company_change();
create trigger categories_company_lock before update on public.categories for each row execute function public.prevent_company_change();
create trigger alert_states_company_lock before update on public.alert_states for each row execute function public.prevent_company_change();
create trigger members_company_lock before update on public.company_members for each row execute function public.prevent_company_change();

-- ─── Validação de lançamentos que depende de outras linhas ou da data da empresa ───
create or replace function public.validate_transaction()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_cat_kind public.tx_kind;
  v_today date;
begin
  if new.category_id is not null then
    select kind into v_cat_kind from public.categories where id = new.category_id;
    if v_cat_kind is distinct from new.kind then
      raise exception 'Categoria não corresponde ao tipo do lançamento' using errcode = '23514';
    end if;
  end if;

  if new.settled_date is not null then
    select (now() at time zone c.timezone)::date into v_today from public.companies c where c.id = new.company_id;
    if new.settled_date > v_today then
      raise exception 'Data de liquidação não pode estar no futuro' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    -- autoria e origem não são editáveis pelo cliente
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.source := old.source;
    new.import_id := old.import_id;
    new.source_ref := old.source_ref;
  end if;
  return new;
end $$;

create trigger transactions_validate before insert or update on public.transactions
for each row execute function public.validate_transaction();

-- ─── Perfil criado junto com o usuário ───
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- ─── Registro de ações (gatilhos; o cliente não escreve em audit_logs) ───
create or replace function public.audit_transaction()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_changes text[] := '{}';
begin
  if tg_op = 'INSERT' then
    -- importações são registradas em bloco pelo gatilho de imports
    if new.source = 'import' then return new; end if;
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (new.company_id, auth.uid(), 'create', 'transaction', new.id::text, left('Criou "' || new.description || '"', 300));
    return new;
  elsif tg_op = 'UPDATE' then
    if new.amount is distinct from old.amount then v_changes := v_changes || 'valor'; end if;
    if new.status is distinct from old.status then v_changes := v_changes || 'situação'; end if;
    if new.due_date is distinct from old.due_date then v_changes := v_changes || 'vencimento'; end if;
    if new.settled_date is distinct from old.settled_date then v_changes := v_changes || 'liquidação'; end if;
    if new.category_id is distinct from old.category_id then v_changes := v_changes || 'categoria'; end if;
    if new.description is distinct from old.description then v_changes := v_changes || 'descrição'; end if;
    if new.competence_date is distinct from old.competence_date then v_changes := v_changes || 'competência'; end if;
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (new.company_id, auth.uid(), 'update', 'transaction', new.id::text,
      left(case when cardinality(v_changes) = 0 then 'Salvou "' || new.description || '" sem alterações'
           else 'Alterou ' || array_to_string(v_changes, ', ') || ' de "' || new.description || '"' end, 300));
    return new;
  else
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (old.company_id, auth.uid(), 'delete', 'transaction', old.id::text, left('Excluiu "' || old.description || '"', 300));
    return old;
  end if;
end $$;

create trigger transactions_audit after insert or update or delete on public.transactions
for each row execute function public.audit_transaction();

create or replace function public.audit_generic()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'imports' then
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (new.company_id, auth.uid(), 'import', 'import', new.id::text,
      left('Importou ' || new.imported || ' lançamento(s) de "' || new.file_name || '"', 300));
  elsif tg_table_name = 'alert_states' then
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (new.company_id, auth.uid(), 'alert_state', 'alert', left(new.fingerprint, 200), 'Alerta marcado como "' || new.state || '"');
  elsif tg_table_name = 'categories' then
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (new.company_id, auth.uid(), 'create', 'category', new.id::text, left('Criou a categoria "' || new.name || '"', 300));
  elsif tg_table_name = 'company_settings' then
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (new.company_id, auth.uid(), 'settings', 'settings', new.company_id::text, 'Alterou configurações da empresa');
  end if;
  return new;
end $$;

create trigger imports_audit after insert on public.imports for each row execute function public.audit_generic();
create trigger alert_states_audit after insert or update on public.alert_states for each row execute function public.audit_generic();
create trigger categories_audit after insert on public.categories for each row execute function public.audit_generic();
create trigger settings_audit after update on public.company_settings for each row execute function public.audit_generic();

-- ─── Criação de empresa (única porta de entrada; cria o dono e os dados iniciais) ───
create or replace function public.create_company(p_name text, p_opening_balance numeric default 0)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_count int;
  v_limit int;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if v_user is null then
    raise exception 'Autenticação necessária' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 2 and 120 then
    raise exception 'Nome da empresa deve ter de 2 a 120 caracteres' using errcode = '22023';
  end if;
  if p_opening_balance is null or abs(p_opening_balance) > 999999999999 then
    raise exception 'Saldo inicial inválido' using errcode = '22023';
  end if;

  select count(*) into v_count from public.company_members where user_id = v_user and role = 'owner';
  select max_companies_per_user into v_limit from public.plan_limits where plan = 'trial';
  if v_count >= v_limit then
    raise exception 'Limite de % empresas por usuário atingido', v_limit using errcode = '54000';
  end if;

  insert into public.companies (name, created_by) values (btrim(p_name), v_user) returning id into v_company;
  insert into public.company_members (company_id, user_id, role) values (v_company, v_user, 'owner');
  insert into public.company_settings (company_id) values (v_company);
  insert into public.accounts (company_id, name, opening_balance, opening_date)
  values (v_company, 'Conta principal', round(p_opening_balance, 2), v_today);
  insert into public.categories (company_id, name, kind, fixed) values
    (v_company, 'Vendas', 'income', false),
    (v_company, 'Serviços prestados', 'income', false),
    (v_company, 'Outras receitas', 'income', false),
    (v_company, 'Fornecedores', 'expense', false),
    (v_company, 'Folha de pagamento', 'expense', true),
    (v_company, 'Aluguel', 'expense', true),
    (v_company, 'Energia, água e internet', 'expense', true),
    (v_company, 'Impostos', 'expense', false),
    (v_company, 'Serviços e assinaturas', 'expense', true),
    (v_company, 'Taxas bancárias', 'expense', false),
    (v_company, 'Outras despesas', 'expense', false);
  return v_company;
end $$;

revoke all on function public.create_company(text, numeric) from public, anon;
grant execute on function public.create_company(text, numeric) to authenticated;

-- ─── Importação atômica (security invoker: RLS se aplica normalmente) ───
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
