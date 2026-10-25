import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'

/**
 * Testes de integração contra um projeto Supabase real (isolamento entre empresas, RLS e regras
 * do banco). Lê credenciais de .env.test.local — nunca commitado. Rode com `npm run test:db`.
 */
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['supabase/tests/**/*.test.ts'],
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: loadEnv(mode === 'test' ? 'test' : mode, process.cwd(), ''),
  },
}))
