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
7. `20261025000400_ai_analyses.sql` — `ai_analyses` (leitura para membros, escrita só do `service_role`), `rate_limit_ai`, `ai_quota_reserve` e `category_totals`.

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
Em `supabase/tests/aggregates_and_rate_limit.test.ts`, a paridade centavo a centavo entre SQL e domínio (`company_balances`, `monthly_evolution`, `base_projection`) e o bloqueio `54000` após 10 importações por usuário também são verificados. Em `supabase/tests/ai.test.ts`, verificam-se a RLS de `ai_analyses` (membro lê, cliente não escreve), a cota mensal e os totais por categoria sem dados individuais. Sem as chaves de teste, as suítes de banco são puladas.

Depois: `npm run dev`, crie uma conta em `/cadastro` e confira que a visão geral abre vazia, com a empresa real (sem a faixa de demonstração).

## 6. Edge Function de importação (Fase 4)

A importação de planilhas valida o lote no servidor e chama `import_transactions` com o JWT do usuário.

**Publicar as duas funções** (importação e IA):

```bash
npm run functions:deploy
```

O código-fonte de cada função fica em `supabase/functions/<nome>/handler.ts`. O empacotador remoto do Supabase só envia arquivos de `supabase/functions/`, então `npm run functions:build` (esbuild, `scripts/build-functions.mjs`) gera um `index.ts` único com o código compartilhado de `src/`; esse arquivo é gerado e fica fora do git. O `functions:deploy` empacota e publica com `--use-api` (não precisa de Docker).

A função exige a variável `ALLOWED_ORIGIN` com a origem exata do app (sem `*`), por exemplo:

- produção: `ALLOWED_ORIGIN=https://SEU-SITE.netlify.app`
- desenvolvimento: `ALLOWED_ORIGIN=http://localhost:5173`

Configure no painel (Edge Functions → Secrets) ou via CLI (`supabase secrets set ALLOWED_ORIGIN=...`). Para rodar localmente, gere antes o pacote (`npm run functions:build`; o `index.ts` não vem no clone) e depois: `supabase functions serve import-transactions --env-file .env.local`, com `ALLOWED_ORIGIN` e as variáveis do Supabase no arquivo local.

Limites aplicados no servidor: 30 validações por 10 minutos (`import_validate`, na Edge Function), 10 importações por 10 minutos (`import_transactions`, no banco) e o limite de linhas do plano. Como o limite da importação vive na RPC, chamadas diretas ao PostgREST também são bloqueadas.

**As telas continuam calculando saldos, evolução e projeção no navegador** com o mesmo domínio TypeScript. Os métodos `getAccountBalances`, `getMonthlyEvolution` e `getBaseProjection` já existem no contrato e usam as RPCs no Supabase; a paridade com o domínio foi comprovada no banco de testes (`supabase/tests/aggregates_and_rate_limit.test.ts`). A troca nas telas fica para junto da paginação dos lançamentos, que é quando ela reduz de fato o volume baixado.

## 7. Edge Function de análise por IA (Fase 5)

As análises são geradas no servidor pela função `ai-analysis`, com dados agregados (saldo, evolução, projeção, totais por categoria e resumo dos cenários). Nenhum lançamento individual, descrição ou contraparte é enviado ao provedor. A resposta passa pelo revisor automático; só análises aprovadas entram no cache.

Deploy: junto com a importação, por `npm run functions:deploy` (seção 6).

Variáveis (Edge Functions → Secrets ou `supabase secrets set`):

| Variável         | Obrigatória  | Observação                                                                            |
| ---------------- | ------------ | ------------------------------------------------------------------------------------- |
| `ALLOWED_ORIGIN` | sim          | Origem exata do app, sem `*` (ex.: `https://SEU-SITE.netlify.app`).                   |
| `AI_PROVIDER`    | não          | `none` (padrão), `gemini` ou `fake`. Sem provedor válido a função responde 503.       |
| `AI_MODEL`       | com `gemini` | Modelo exato, sem valor padrão que gere custo (ex.: `gemini-2.0-flash`).              |
| `AI_API_KEY`     | com `gemini` | Segredo preenchido por você no painel; vai no header `x-goog-api-key` e nunca na URL. |

A cota mensal vem de `plan_limits.ai_monthly_analyses`. O plano **trial é 0**: mesmo com o provedor configurado, nenhuma análise é chamada até a cota ser aumentada conscientemente no banco. `ai_quota_reserve` reserva a vaga na mesma transação da checagem e conta todas as chamadas ao provedor no mês (pendentes, aprovadas, reprovadas pelo revisor e erros); acertos de cache não contam. O limite por usuário é de 10 chamadas a cada 10 minutos (`rate_limit_ai`).

A Edge Function usa a chave `service_role` **somente** no insert final em `ai_analyses`, depois de confirmar com o JWT do usuário que ele é membro da empresa. Ela nunca registra prompt, resposta, fatos, JWT ou chave — apenas `{ agent, provider, durationMs, status }` em caso de erro. O timeout do provedor é de 15 s e a resposta é validada por `src/domain/ai/parse.ts`.

## Backups e recuperação

- Retenção e restauração de backups dependem do plano contratado: confira em Dashboard → Database → Backups antes de colocar dados reais.
- Antes de cada migration em produção, gere cópias com a CLI (`db dump --linked -f esquema.sql` e `db dump --linked --data-only -f dados.sql`) e guarde fora do repositório.
- As migrations são versionadas e aplicadas uma única vez cada, em ordem; nenhuma apaga dados.
