-- Row Level Security: o isolamento entre empresas é garantido aqui, no banco.
-- Papéis: owner/admin administram; member lança; viewer só lê.
-- Nada é acessível ao papel anon.

alter table public.plan_limits enable row level security;
alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.accounts enable row level security;
alter table public.categories enable row level security;
alter table public.imports enable row level security;
alter table public.transactions enable row level security;
alter table public.alert_states enable row level security;
alter table public.company_settings enable row level security;
alter table public.scenarios enable row level security;
alter table public.audit_logs enable row level security;

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Planos: leitura para usuários autenticados (não há dado sensível).
create policy plan_limits_read on public.plan_limits for select to authenticated using (true);

-- Perfis: o próprio usuário, e colegas de empresa (somente nome).
create policy profiles_select on public.profiles for select to authenticated using (
  id = (select auth.uid())
  or exists (
    select 1 from public.company_members a
    join public.company_members b on a.company_id = b.company_id
    where a.user_id = (select auth.uid()) and b.user_id = profiles.id
  )
);
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Empresas: criação apenas pela função create_company; sem exclusão pelo cliente.
create policy companies_select on public.companies for select to authenticated using (public.is_member(id));
create policy companies_update on public.companies for update to authenticated
  using (public.is_admin(id)) with check (public.is_admin(id));

-- Membros: todos veem a equipe; só owner/admin gerenciam. Ninguém se adiciona a outra empresa.
create policy members_select on public.company_members for select to authenticated using (public.is_member(company_id));
create policy members_insert on public.company_members for insert to authenticated
  with check (public.is_admin(company_id) and role <> 'owner');
create policy members_update on public.company_members for update to authenticated
  using (public.is_admin(company_id) and role <> 'owner') with check (public.is_admin(company_id) and role <> 'owner');
create policy members_delete on public.company_members for delete to authenticated
  using (public.is_admin(company_id) and role <> 'owner');

-- Contas
create policy accounts_select on public.accounts for select to authenticated using (public.is_member(company_id));
create policy accounts_insert on public.accounts for insert to authenticated with check (public.is_admin(company_id));
create policy accounts_update on public.accounts for update to authenticated
  using (public.is_admin(company_id)) with check (public.is_admin(company_id));

-- Categorias
create policy categories_select on public.categories for select to authenticated using (public.is_member(company_id));
create policy categories_insert on public.categories for insert to authenticated with check (public.can_write(company_id));
create policy categories_update on public.categories for update to authenticated
  using (public.is_admin(company_id)) with check (public.is_admin(company_id));
create policy categories_delete on public.categories for delete to authenticated using (public.is_admin(company_id));

-- Importações: registro imutável.
create policy imports_select on public.imports for select to authenticated using (public.is_member(company_id));
create policy imports_insert on public.imports for insert to authenticated with check (public.can_write(company_id));

-- Lançamentos
create policy tx_select on public.transactions for select to authenticated using (public.is_member(company_id));
create policy tx_insert on public.transactions for insert to authenticated with check (public.can_write(company_id));
create policy tx_update on public.transactions for update to authenticated
  using (public.can_write(company_id)) with check (public.can_write(company_id));
create policy tx_delete on public.transactions for delete to authenticated using (public.can_write(company_id));

-- Estado dos alertas
create policy alerts_select on public.alert_states for select to authenticated using (public.is_member(company_id));
create policy alerts_insert on public.alert_states for insert to authenticated with check (public.can_write(company_id));
create policy alerts_update on public.alert_states for update to authenticated
  using (public.can_write(company_id)) with check (public.can_write(company_id));

-- Configurações (linha criada por create_company)
create policy settings_select on public.company_settings for select to authenticated using (public.is_member(company_id));
create policy settings_update on public.company_settings for update to authenticated
  using (public.is_admin(company_id)) with check (public.is_admin(company_id));

-- Cenários
create policy scenarios_select on public.scenarios for select to authenticated using (public.is_member(company_id));
create policy scenarios_insert on public.scenarios for insert to authenticated with check (public.can_write(company_id));
create policy scenarios_delete on public.scenarios for delete to authenticated using (public.can_write(company_id));

-- Registro de ações: só leitura; escrita exclusiva dos gatilhos.
create policy audit_select on public.audit_logs for select to authenticated using (public.is_member(company_id));

-- Defesa adicional: colunas que o cliente nunca grava diretamente.
revoke insert, update, delete on public.audit_logs from authenticated;
revoke insert, delete on public.companies from authenticated;
revoke insert, delete on public.company_settings from authenticated;
revoke update on public.imports from authenticated;
revoke delete on public.imports from authenticated;
