// Empacota cada Edge Function (supabase/functions/<nome>/handler.ts) num index.ts único.
// O empacotador remoto do Supabase só envia arquivos de supabase/functions/, então o código
// compartilhado de src/ (validação, domínio de IA) precisa entrar no pacote aqui.
// Só @supabase/supabase-js fica externo: o Deno resolve pelo import map (supabase/functions/deno.json).
import { build } from 'esbuild'
import { readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const functionsDir = join(root, 'supabase', 'functions')
const names = readdirSync(functionsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(functionsDir, d.name, 'handler.ts')))
  .map((d) => d.name)

for (const name of names) {
  await build({
    entryPoints: [join(functionsDir, name, 'handler.ts')],
    outfile: join(functionsDir, name, 'index.ts'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    alias: { '@': join(root, 'src') },
    external: ['@supabase/supabase-js'],
    banner: { js: '// GERADO por scripts/build-functions.mjs a partir de handler.ts. Não edite.' },
    logLevel: 'warning',
  })
  console.log(`empacotada: ${name}`)
}
