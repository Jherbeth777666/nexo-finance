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
27 verificações: um usuário não lê, altera, exclui, insere, importa nem se adiciona em outra empresa; o papel somente leitura não escreve; a chave anon sozinha não lê nada; e as regras de integridade (valor, datas, categoria × tipo, transferências, idempotência de importação, auditoria) são aplicadas pelo banco.

Depois: `npm run dev`, crie uma conta em `/cadastro` e confira que a visão geral abre vazia, com a empresa real (sem a faixa de demonstração).

## Backups e recuperação
- Retenção e restauração de backups dependem do plano contratado: confira em Dashboard → Database → Backups antes de colocar dados reais.
- Antes de cada migration em produção, gere cópias com a CLI (`db dump --linked -f esquema.sql` e `db dump --linked --data-only -f dados.sql`) e guarde fora do repositório.
- As migrations são versionadas e aplicadas uma única vez cada, em ordem; nenhuma apaga dados.
