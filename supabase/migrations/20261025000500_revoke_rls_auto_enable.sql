-- O Supabase cria public.rls_auto_enable() quando "Enable automatic RLS" é ligado no painel.
-- Ela é SECURITY DEFINER e não deve ser executável pelos papéis da API (alerta do Security Advisor).
-- Projetos sem essa opção não têm a função: a migration não faz nada neles.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
