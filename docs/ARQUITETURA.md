# Arquitetura e decisões

## Princípios aplicados
1. **Cálculo determinístico primeiro.** Saldos, projeções, alertas e simulações são funções puras em `src/domain/finance`, sem IA, cobertas por testes.
2. **Um motor, três telas.** Fluxo de caixa, alertas de risco de caixa e simulador chamam o mesmo `projectCashflow` — os números sempre concordam (há teste para isso).
3. **Rastreabilidade.** Cada indicador devolve os ids dos lançamentos que o compõem; cada alerta carrega `transactionIds`, evidências, período e origem.
4. **Honestidade de dados.** Sem histórico suficiente → "dados insuficientes para comparação". Funções não disponíveis dizem isso; nada simula sucesso.
5. **Leveza.** Uma única dependência de runtime além de React/Router (a fonte Inter). Gráficos em SVG próprio; leitor XLSX sem biblioteca.

## Stack
| Camada | Escolha | Por quê |
|---|---|---|
| UI | React 19 + TypeScript 5.8 + Vite 6 | Pedido no projeto; build rápido e divisão por rota |
| Estilo | Tailwind CSS 4 (plugin Vite) | Tokens em `@theme`, CSS final de 8 KB gzip |
| Rotas | react-router 7 | Rotas aninhadas e `lazy()` por página |
| Gráficos | SVG próprio (`components/charts.tsx`) | ~2,7 KB gzip contra 50–100 KB de bibliotecas |
| Componentes | Próprios, sobre elementos nativos (`<dialog>`, `<select>`, radiogroup) | Acessibilidade do navegador sem dependência |
| Fonte | Inter Variable via @fontsource (self-hosted) | Sem requisição externa; só o subconjunto usado é baixado |
| Testes | Vitest + Testing Library + jsdom | Unitários de domínio + integração de telas |

Dependências de runtime: `react`, `react-dom`, `react-router`, `@fontsource-variable/inter`. Nada mais.

## Modelo de dados (cliente → futuro PostgreSQL)
- Dinheiro em **centavos inteiros** no cliente; `NUMERIC(14,2)` no banco.
- Datas de negócio como `AAAA-MM-DD` interpretadas no fuso da empresa (`America/Sao_Paulo`), nunca `new Date('AAAA-MM-DD')`.
- `amount` sempre positivo; o sentido vem de `kind` (`income`/`expense`/`transfer`).
- **Pendente** = conta a pagar/receber; **liquidado** exige `settledDate`, que não pode ser futura.
- **Transferências** entre contas próprias alteram o saldo de cada conta, nunca o consolidado, e nunca entram em receita, despesa ou resultado.
- **Recorrências** são materializadas como lançamentos individuais com o mesmo `recurrenceId` (a projeção só vê o que foi materializado; isso é premissa exibida). Lançamentos recorrentes não são marcados como duplicatas entre si.
- Três regimes, nunca misturados: **saldo de caixa** (liquidados), **resultado operacional estimado** (competência, simplificado) e **lucro contábil** (não calculado — a interface diz isso).

### Esquema planejado para a Fase 3 (Supabase)
`companies`, `company_members (company_id, user_id, role)`, `accounts`, `categories`, `transactions`, `imports`, `import_rows`, `alerts_state (company_id, fingerprint, state)`, `scenarios`, `audit_logs`, `plan_limits`.
- UUID em todas as chaves; `company_id NOT NULL` + FK em toda tabela de empresa.
- RLS em todas: `company_id in (select company_id from company_members where user_id = auth.uid())`; escrita restrita por papel (`owner`, `admin`, `member`, `viewer`).
- `CHECK (amount > 0)`, `CHECK (status <> 'settled' or settled_date is not null)`, `CHECK (kind <> 'transfer' or to_account_id is not null)`.
- Índices: `(company_id, due_date)`, `(company_id, settled_date)`, `(company_id, competence_date)`, `(company_id, source_ref)` único parcial para idempotência de importação, `(company_id, file_hash)` em `imports`.
- Agregações (saldo, evolução mensal) em views/funções SQL para não transferir milhares de linhas ao navegador.
- Testes de isolamento: usuário A tentando `select/update/delete` em dados da empresa B via chamada direta à API deve receber zero linhas/erro.

O contrato `FinanceRepository` (`src/data/repository.ts`) é o ponto de troca: o `DemoRepository` atual será acompanhado de um `SupabaseRepository` sem mudar as telas.

## Importação
- Validação de extensão, tamanho (5 MB), linhas (5.000), conteúdo binário e XLSX disfarçado de CSV.
- Codificação: UTF-8 estrito, com fallback para Windows-1252.
- Separador detectado entre `;`, `,` e tab; valores `1.250,50`, `1250.50`, `(1.250,50)`, `R$ -10`; datas BR, ISO e seriais do Excel. `MM/DD` americano é rejeitado, nunca invertido.
- XLSX lido com `DecompressionStream` + `DOMParser`, sob demanda (chunk de 1,7 KB). Fórmulas: só o valor em cache. Proteção contra zip bomb (40 MB descompactados).
- Idempotência: hash SHA-256 do arquivo (aviso de reimportação) + `sourceRef` por linha (`ext:<documento>` ou `row:tipo|valor|data|descrição`) — linhas já importadas ficam desmarcadas.
- Mesmo tipo/valor/data de um lançamento existente é **só suspeita**: sinalizada, decisão do usuário.
- Nenhuma linha inválida é descartada em silêncio; cada uma mostra o erro.
- Fase 3: mover a validação para uma Edge Function e repetir as regras no banco.

## Alertas (regras determinísticas)
| Regra | Critério padrão (configurável) |
|---|---|
| Aumento de despesa | Categoria nos últimos 30 dias ≥ +25% e ≥ R$ 500 sobre a média de até 3 janelas anteriores (mín. 2 janelas de histórico) |
| Queda de recebimentos | Recebido em 30 dias ≤ −20% da média anterior |
| Contas vencidas | Agrupadas em um alerta para receber e outro para pagar |
| Concentração | Semana com ≥ 40% e ≥ R$ 3.000 dos pagamentos dos próximos 30 dias |
| Risco de caixa | Cenário-base negativo (crítico) → conservador negativo (atenção) → abaixo da margem (informativo) |
| Duplicatas suspeitas | Mesmo tipo, valor e descrição normalizada em até 3 dias, exceto mesma recorrência |
| Inconsistências | Sem categoria, liquidado sem data, liquidação futura, pendência vencida há > 120 dias |

Cada alerta tem `fingerprint` estável (regra + objeto), então o estado escolhido pelo usuário persiste e o alerta não "renasce" a cada carregamento.

## IA (Fase 5 — contratos já definidos)
- `src/domain/ai/analysis.ts` define o formato obrigatório (resumo, evidências ligadas a fatos, período, premissas, limitações, ações) e o **revisor**, que reprova análises com valores que não batem com os fatos calculados, evidências sem fato, ausência de limitações ou linguagem de certeza.
- Agentes previstos (caixa, despesas, cenários + revisor) serão funções server-side com um único provedor, chamadas só sob demanda, com dados agregados, cache por hash de (dados + premissas), timeout, limite por empresa e log de duração/custo sem dados sensíveis.
- Hoje: nenhum provedor configurado; a tela mostra um **exemplo demonstrativo montado por regras locais**, identificado como tal.

## Segurança
- Nenhum segredo no frontend; `.env.example` sem valores; `.env*` no `.gitignore`. Só `VITE_SUPABASE_URL` e a chave `anon` (protegida por RLS) poderão ir ao navegador.
- `netlify.toml` com CSP restritiva, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- React escapa todo texto; não há `dangerouslySetInnerHTML`. Exportação CSV neutraliza injeção de fórmulas (`=`, `+`, `-`, `@`).
- Arquivos importados nunca são executados.
- Validação de formulários no cliente; **a validação equivalente no servidor/banco é obrigatória na Fase 3**.
- Limitação conhecida: o modo de demonstração guarda dados em `localStorage`, adequado só para dados fictícios.

## Comercialização (preparação)
Sem cobrança nem bloqueios fictícios. Os limites reais que existirão por plano já têm ponto de aplicação: linhas por importação (`IMPORT_LIMITS`), análises de IA por empresa (Fase 5), usuários por empresa (`company_members`). A tabela `plan_limits` entra na Fase 3.
