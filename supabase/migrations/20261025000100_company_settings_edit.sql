-- Edição de dados da empresa: nome da empresa e saldo de abertura por conta.
-- Segurança: o cliente autenticado só pode alterar as colunas permitidas.

revoke update on public.companies from authenticated;
grant update (name) on public.companies to authenticated;

revoke update on public.accounts from authenticated;
grant update (name, opening_balance, opening_date) on public.accounts to authenticated;

-- Auditoria das alterações feitas por esses novos caminhos.
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
  elsif tg_table_name = 'companies' then
    if old.name is distinct from new.name then
      insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
      values (new.id, auth.uid(), 'update', 'company', new.id::text,
        left('Renomeou a empresa para "' || new.name || '"', 300));
    end if;
  elsif tg_table_name = 'accounts' then
    if old.opening_balance is distinct from new.opening_balance then
      insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
      values (new.company_id, auth.uid(), 'update', 'account', new.id::text,
        left('Alterou o saldo de abertura de "' || new.name || '"', 300));
    end if;
  end if;
  return new;
end $$;

create trigger companies_audit after update on public.companies
for each row execute function public.audit_generic();

create trigger accounts_audit after update on public.accounts
for each row execute function public.audit_generic();
