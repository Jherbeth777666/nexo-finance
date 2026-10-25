-- Convite de membros para uma empresa.
-- Segurança:
--   * o token puro NUNCA é gravado: só o hash SHA-256;
--   * o cliente autenticado pode LER convites da própria empresa (owner/admin) e nada mais;
--   * criar, aceitar e revogar passam apenas pelas funções security definer abaixo;
--   * aceitar exige e-mail confirmado no Supabase Auth (evita entrar com e-mail de outra pessoa);
--   * o dono da empresa nunca pode ser convidado, rebaixado ou removido.

create table public.company_invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  role public.member_role not null check (role in ('admin', 'member', 'viewer')),
  token_hash bytea not null unique,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz
);

create index company_invites_company_idx on public.company_invites (company_id, created_at desc);
create unique index company_invites_pending_email on public.company_invites (company_id, email)
  where accepted_at is null and revoked_at is null;

alter table public.company_invites enable row level security;

-- Somente owner/admin enxergam os convites (member/viewer só veem a lista de membros).
create policy company_invites_select on public.company_invites for select to authenticated
  using (public.is_admin(company_id));

-- Sem escrita direta: tudo passa pelas RPCs security definer.
revoke all on public.company_invites from anon;
revoke insert, update, delete on public.company_invites from authenticated;
grant select on public.company_invites to authenticated;

-- ─── Limite de membros do plano (trial = 3) ───
-- Trava a empresa para que dois aceites simultâneos não ultrapassem o limite.
create or replace function public.enforce_max_members()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_plan text;
  v_limit int;
  v_count int;
begin
  -- Já é membro? O INSERT com ON CONFLICT DO NOTHING não altera nada; não bloqueie.
  if exists (
    select 1 from public.company_members m
    where m.company_id = new.company_id and m.user_id = new.user_id
  ) then
    return new;
  end if;

  select c.plan into v_plan from public.companies c where c.id = new.company_id for update;
  select pl.max_members into v_limit from public.plan_limits pl where pl.plan = v_plan;
  select count(*) into v_count from public.company_members m where m.company_id = new.company_id;

  if v_count >= v_limit then
    raise exception 'Limite de % membros do plano atingido', v_limit using errcode = '54000';
  end if;
  return new;
end $$;

create trigger company_members_limit before insert on public.company_members
for each row execute function public.enforce_max_members();

-- ─── Criar convite ───
create or replace function public.create_invite(p_company uuid, p_email text, p_role text default 'member')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_plan text;
  v_limit int;
  v_members int;
  v_active_invites int;
  v_id uuid;
  v_token text;
begin
  if v_user is null then
    raise exception 'Autenticação necessária' using errcode = '42501';
  end if;
  if not public.is_admin(p_company) then
    raise exception 'Somente proprietários e administradores podem convidar' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('admin', 'member', 'viewer') then
    raise exception 'Papel inválido para convite' using errcode = '22023';
  end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    raise exception 'Informe um e-mail válido' using errcode = '22023';
  end if;

  -- Trava a empresa antes das checagens: serializa convites e evita duplicidade/limite furado.
  select c.plan into v_plan from public.companies c where c.id = p_company for update;
  if v_plan is null then
    raise exception 'Empresa não encontrada' using errcode = '22023';
  end if;

  -- Já faz parte da equipe?
  if exists (
    select 1
    from public.company_members m
    join auth.users u on u.id = m.user_id
    where m.company_id = p_company and lower(btrim(coalesce(u.email, ''))) = v_email
  ) then
    raise exception 'Este e-mail já faz parte da equipe' using errcode = '22023';
  end if;

  -- Convite ativo para o mesmo e-mail: erro claro (não duplica).
  if exists (
    select 1 from public.company_invites i
    where i.company_id = p_company and i.email = v_email
      and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
  ) then
    raise exception 'Já existe um convite ativo para este e-mail' using errcode = '22023';
  end if;

  -- O limite considera membros atuais + convites ativos.
  select pl.max_members into v_limit from public.plan_limits pl where pl.plan = v_plan;
  select count(*) into v_members from public.company_members m where m.company_id = p_company;
  select count(*) into v_active_invites from public.company_invites i
    where i.company_id = p_company and i.accepted_at is null and i.revoked_at is null and i.expires_at > now();

  if v_members + v_active_invites >= v_limit then
    raise exception 'Limite de % membros do plano atingido', v_limit using errcode = '54000';
  end if;

  -- Convites antigos/expirados do mesmo e-mail deixam de ser pendentes.
  update public.company_invites i set revoked_at = now()
    where i.company_id = p_company and i.email = v_email
      and i.accepted_at is null and i.revoked_at is null;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  insert into public.company_invites (company_id, email, role, token_hash, created_by)
  values (p_company, v_email, p_role::public.member_role, sha256(convert_to(v_token, 'UTF8')), v_user)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'token', v_token);
end $$;

-- ─── Aceitar convite ───
create or replace function public.accept_invite(p_token text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_email text;
  v_confirmed timestamptz;
  v_invite_id uuid;
  v_company uuid;
  v_role public.member_role;
  v_invite_email text;
begin
  if v_user is null then
    raise exception 'Autenticação necessária' using errcode = '42501';
  end if;

  select lower(btrim(coalesce(email, ''))), email_confirmed_at
    into v_email, v_confirmed
    from auth.users where id = v_user;

  -- Mesma mensagem genérica em qualquer falha: não revela convite nem e-mail de terceiros.
  if v_email is null or v_email = '' or v_confirmed is null then
    raise exception 'Convite inválido, expirado ou destinado a outro e-mail' using errcode = '22023';
  end if;

  select i.id, i.company_id, i.role, i.email
    into v_invite_id, v_company, v_role, v_invite_email
    from public.company_invites i
    where i.token_hash = sha256(convert_to(coalesce(p_token, ''), 'UTF8'))
    for update;

  if v_invite_id is null then
    raise exception 'Convite inválido, expirado ou destinado a outro e-mail' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.company_invites i
    where i.id = v_invite_id and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
  ) or v_invite_email is distinct from v_email then
    raise exception 'Convite inválido, expirado ou destinado a outro e-mail' using errcode = '22023';
  end if;

  insert into public.company_members (company_id, user_id, role)
  values (v_company, v_user, v_role)
  on conflict (company_id, user_id) do nothing;

  update public.company_invites set accepted_at = now(), accepted_by = v_user where id = v_invite_id;

  return v_company;
end $$;

-- ─── Revogar convite ───
create or replace function public.revoke_invite(p_invite uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_accepted timestamptz;
  v_revoked timestamptz;
begin
  if v_user is null then
    raise exception 'Autenticação necessária' using errcode = '42501';
  end if;

  select i.company_id, i.accepted_at, i.revoked_at
    into v_company, v_accepted, v_revoked
    from public.company_invites i where i.id = p_invite
    for update;

  if v_company is null then
    raise exception 'Convite não encontrado' using errcode = '22023';
  end if;
  if not public.is_admin(v_company) then
    raise exception 'Somente proprietários e administradores podem revogar convites' using errcode = '42501';
  end if;
  if v_accepted is not null then
    raise exception 'Este convite já foi aceito' using errcode = '22023';
  end if;
  if v_revoked is null then
    update public.company_invites set revoked_at = now() where id = p_invite;
  end if;
end $$;

revoke all on function public.create_invite(uuid, text, text) from public, anon;
revoke all on function public.accept_invite(text) from public, anon;
revoke all on function public.revoke_invite(uuid) from public, anon;
grant execute on function public.create_invite(uuid, text, text) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.revoke_invite(uuid) to authenticated;

-- ─── Auditoria de convites e membros (nunca registra o token) ───
create or replace function public.audit_generic()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'imports' then
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (new.company_id, auth.uid(), 'import', 'import', new.id::text,
      left('Importou ' || new.imported || ' lançamento(s) de "' || new.file_name || '"', 300));
    return new;
  elsif tg_table_name = 'alert_states' then
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (new.company_id, auth.uid(), 'alert_state', 'alert', left(new.fingerprint, 200), 'Alerta marcado como "' || new.state || '"');
    return new;
  elsif tg_table_name = 'categories' then
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (new.company_id, auth.uid(), 'create', 'category', new.id::text, left('Criou a categoria "' || new.name || '"', 300));
    return new;
  elsif tg_table_name = 'company_settings' then
    insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
    values (new.company_id, auth.uid(), 'settings', 'settings', new.company_id::text, 'Alterou configurações da empresa');
    return new;
  elsif tg_table_name = 'companies' then
    if old.name is distinct from new.name then
      insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
      values (new.id, auth.uid(), 'update', 'company', new.id::text,
        left('Renomeou a empresa para "' || new.name || '"', 300));
    end if;
    return new;
  elsif tg_table_name = 'accounts' then
    if old.opening_balance is distinct from new.opening_balance then
      insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
      values (new.company_id, auth.uid(), 'update', 'account', new.id::text,
        left('Alterou o saldo de abertura de "' || new.name || '"', 300));
    end if;
    return new;
  elsif tg_table_name = 'company_invites' then
    if tg_op = 'INSERT' then
      insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
      values (new.company_id, auth.uid(), 'create', 'invite', new.id::text,
        left('Convidou ' || new.email || ' como ' || new.role, 300));
      return new;
    elsif tg_op = 'UPDATE' then
      if new.accepted_at is not null and old.accepted_at is null then
        insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
        values (new.company_id, auth.uid(), 'update', 'invite', new.id::text,
          left('Convite de ' || new.email || ' aceito', 300));
      elsif new.revoked_at is not null and old.revoked_at is null then
        insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
        values (new.company_id, auth.uid(), 'update', 'invite', new.id::text,
          left('Revogou o convite de ' || new.email, 300));
      end if;
      return new;
    else
      -- Não tente auditar convite de uma empresa que está sendo excluída.
      if exists (select 1 from public.companies c where c.id = old.company_id) then
        insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
        values (old.company_id, auth.uid(), 'delete', 'invite', old.id::text,
          left('Removeu o convite de ' || old.email, 300));
      end if;
      return old;
    end if;
  elsif tg_table_name = 'company_members' then
    if tg_op = 'INSERT' then
      insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
      values (new.company_id, auth.uid(), 'create', 'member', new.user_id::text,
        left('Adicionou um membro como ' || new.role, 300));
      return new;
    elsif tg_op = 'UPDATE' then
      if new.role is distinct from old.role then
        insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
        values (new.company_id, auth.uid(), 'update', 'member', new.user_id::text,
          left('Alterou o papel do membro de ' || old.role || ' para ' || new.role, 300));
      end if;
      return new;
    else
      if exists (select 1 from public.companies c where c.id = old.company_id) then
        insert into public.audit_logs (company_id, actor, action, entity, entity_id, summary)
        values (old.company_id, auth.uid(), 'delete', 'member', old.user_id::text,
          left('Removeu um membro da equipe (papel ' || old.role || ')', 300));
      end if;
      return old;
    end if;
  end if;
  return new;
end $$;

create trigger company_invites_audit after insert or update or delete on public.company_invites
for each row execute function public.audit_generic();

create trigger company_members_audit after insert or update or delete on public.company_members
for each row execute function public.audit_generic();
