# Configurar o Supabase (Fase 3)

## 1. Projeto

1. Crie um projeto em supabase.com (região São Paulo — `sa-east-1` — reduz latência e mantém os dados no Brasil).
2. **Recomendado:** um projeto para desenvolvimento/testes e outro para produção. Os testes de isolamento criam e apagam usuários temporários; não rode em produção.

## 2. Autenticação (Dashboard → Authentication)

- **URL Configuration → Site URL:** `http://localhost:5173` (desenvolvimento) ou a URL do Netlify (produção).
- **Redirect URLs:** `http://localhost:5173/redefinir-senha`, `http://localhost:5173/login` e os equivalentes da URL publicada.
- **Providers → Email:** ativo. Senha mínima **10**, exigindo letras e dígitos (o mesmo que o formulário valida).
- **Confirm email:** recomendado ativo em produção. O app trata os dois casos (sem confirmação, a empresa é criada no cadastro; com confirmação, no primeiro acesso).
- O e-mail padrão do Supabase tem limite baixo de envios por hora; para produção, configure um SMTP próprio.

## 3. Aplicar as migrations (em ordem)

Pasta `supabase/migrations/`:

1. `20261024000100_core_schema.sql` — tabelas, tipos, FKs compostas por empresa, constraints, índices.
2. `20261024000200_rules_and_triggers.sql` — validação no servidor, auditoria por gatilho, `create_company`, `import_transactions`.
3. `20261024000300_rls.sql` — RLS em todas as tabelas e revogações.
4. `20261025000100_company_settings_edit.sql` — edição de nome e saldo de abertura com auditoria.
5. `20261025000200_member_invites.sql` — convites de membros.
6. `20261025000300_aggregates_and_rate_limit.sql` — `rate_limits` (função genérica interna + `rate_limit_import`/`rate_limit_import_validation`), importação com limite e funções de agregados (`company_balances`, `monthly_evolution`, `base_projection`).

**Opção A — SQL Editor:** cole e execute cada arquivo, na ordem.
**Opção B — CLI:**

```bash
npx --yes supabase@2.48.3 login
```

```bash
npx --yes supabase@2.48.3 link --project-ref SEU_PROJECT_REF
```

```bash
npm run db:push
```

## 4. Variáveis de ambiente

`.env.local` (app):

```
VITE_SUPABASE_URL=https://SEU_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=...chave anon/publishable...
```

`.env.test.local` (somente para `npm run test:db`, projeto de teste):

```
SUPABASE_TEST_URL=https://SEU_PROJECT_REF.supabase.co
SUPABASE_TEST_ANON_KEY=...
SUPABASE_TEST_SERVICE_ROLE_KEY=...service_role/secret...
```

A chave `service_role` ignora o RLS. Ela fica só nesse arquivo local (ignorado pelo git), nunca com prefixo `VITE_`, nunca no Netlify do frontend, nunca colada em chat.

## 5. Verificar

```bash
npm run test:db
```

Verificações de isolamento: um usuário não lê, altera, exclui, insere, importa nem se adiciona em outra empresa; o papel somente leitura não escreve; a chave anon sozinha não lê nada; e as regras de integridade (valor, datas, categoria × tipo, transferências, idempotência de importação, auditoria) são aplicadas pelo banco.
Em `supabase/tests/aggregates_and_rate_limit.test.ts`, a paridade centavo a centavo entre SQL e domínio (`company_balances`, `monthly_evolution`, `base_projection`) e o bloqueio `54000` após 10 importações por usuário também são verificados. Sem as chaves de teste, as duas suítes de banco são puladas.

Depois: `npm run dev`, crie uma conta em `/cadastro` e confira que a visão geral abre vazia, com a empresa real (sem a faixa de demonstração).

## 6. Edge Function de importação (Fase 4)

A importação de planilhas valida o lote no servidor e chama `import_transactions` com o JWT do usuário:

```bash
npx --yes supabase@2.48.3 functions deploy import-transactions
```

A função exige a variável `ALLOWED_ORIGIN` com a origem exata do app (sem `*`), por exemplo:

- produção: `ALLOWED_ORIGIN=https://SEU-SITE.netlify.app`
- desenvolvimento: `ALLOWED_ORIGIN=http://localhost:5173`

Configure no painel (Edge Functions → Secrets) ou via CLI (`supabase secrets set ALLOWED_ORIGIN=...`). Para rodar localmente: `supabase functions serve import-transactions --env-file .env.local`, com `ALLOWED_ORIGIN` e as variáveis do Supabase no arquivo local.

Limites aplicados no servidor: 30 validações por 10 minutos (`import_validate`, na Edge Function), 10 importações por 10 minutos (`import_transactions`, no banco) e o limite de linhas do plano. Como o limite da importação vive na RPC, chamadas diretas ao PostgREST também são bloqueadas.

**As telas continuam calculando saldos, evolução e projeção no navegador** com o mesmo domínio TypeScript. Os métodos `getAccountBalances`, `getMonthlyEvolution` e `getBaseProjection` já existem no contrato e usam as RPCs no Supabase, mas só devem substituir os cálculos locais depois que a paridade for comprovada no banco de testes.

## Backups e recuperação

- Retenção e restauração de backups dependem do plano contratado: confira em Dashboard → Database → Backups antes de colocar dados reais.
- Antes de cada migration em produção, gere cópias com a CLI (`db dump --linked -f esquema.sql` e `db dump --linked --data-only -f dados.sql`) e guarde fora do repositório.
- As migrations são versionadas e aplicadas uma única vez cada, em ordem; nenhuma apaga dados.
