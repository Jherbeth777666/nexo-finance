import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AlertState } from '@/domain/types'
import type { ValidTransaction } from '@/domain/transactions'
import { todayIn } from '@/lib/dates'
import { DemoRepository } from './demoRepository'
import type { CompanySnapshot, FinanceRepository } from './repository'

/**
 * Estado da empresa ativa. As mutações atualizam o estado localmente após a confirmação do
 * repositório — sem recarregar a página. Cálculos derivados ficam em hooks memoizados (useFinance).
 */
type Status = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: CompanySnapshot }

interface StoreValue {
  status: Status
  repo: FinanceRepository
  today: string
  persistent: boolean
  reload: () => void
  actions: {
    createTransaction: (v: ValidTransaction) => Promise<void>
    updateTransaction: (id: string, v: ValidTransaction) => Promise<void>
    deleteTransaction: (id: string) => Promise<void>
    importTransactions: FinanceRepository['importTransactions']
    setAlertState: (fp: string, s: AlertState) => Promise<void>
    saveAlertConfig: FinanceRepository['saveAlertConfig']
    saveCustomScenario: FinanceRepository['saveCustomScenario']
    addCategory: FinanceRepository['addCategory']
    updateCompanyName: FinanceRepository['updateCompanyName']
    updateAccountOpeningBalance: FinanceRepository['updateAccountOpeningBalance']
    saveScenario: FinanceRepository['saveScenario']
    deleteScenario: FinanceRepository['deleteScenario']
    reset: () => Promise<void>
  }
}

const Ctx = createContext<StoreValue | null>(null)

export function DataProvider({ children, repository }: { children: ReactNode; repository?: FinanceRepository }) {
  const repoRef = useRef<FinanceRepository>(repository ?? new DemoRepository())
  const repo = repoRef.current
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const today = useMemo(() => todayIn(), [])

  const reload = useCallback(() => {
    setStatus({ kind: 'loading' })
    repo
      .load()
      .then((data) => setStatus({ kind: 'ready', data }))
      .catch(() => setStatus({ kind: 'error', message: 'Não foi possível carregar os dados da empresa.' }))
  }, [repo])

  useEffect(reload, [reload])

  const refresh = useCallback(async () => {
    const data = await repo.load()
    setStatus({ kind: 'ready', data })
  }, [repo])

  const actions = useMemo<StoreValue['actions']>(
    () => ({
      createTransaction: async (v) => {
        await repo.createTransaction(v)
        await refresh()
      },
      updateTransaction: async (id, v) => {
        await repo.updateTransaction(id, v)
        await refresh()
      },
      deleteTransaction: async (id) => {
        await repo.deleteTransaction(id)
        await refresh()
      },
      importTransactions: async (rows, meta) => {
        const r = await repo.importTransactions(rows, meta)
        await refresh()
        return r
      },
      setAlertState: async (fp, s) => {
        await repo.setAlertState(fp, s)
        await refresh()
      },
      saveAlertConfig: async (c) => {
        await repo.saveAlertConfig(c)
        await refresh()
      },
      saveCustomScenario: async (c) => {
        await repo.saveCustomScenario(c)
        await refresh()
      },
      addCategory: async (c) => {
        const r = await repo.addCategory(c)
        await refresh()
        return r
      },
      updateCompanyName: async (name) => {
        const r = await repo.updateCompanyName(name)
        await refresh()
        return r
      },
      updateAccountOpeningBalance: async (id, cents) => {
        const r = await repo.updateAccountOpeningBalance(id, cents)
        await refresh()
        return r
      },
      saveScenario: async (s) => {
        const r = await repo.saveScenario(s)
        await refresh()
        return r
      },
      deleteScenario: async (id) => {
        await repo.deleteScenario(id)
        await refresh()
      },
      reset: async () => {
        const data = await repo.reset()
        setStatus({ kind: 'ready', data })
      },
    }),
    [repo, refresh],
  )

  const persistent = repo instanceof DemoRepository ? repo.persistent : true
  const value = useMemo(() => ({ status, repo, today, persistent, reload, actions }), [status, repo, today, persistent, reload, actions])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): StoreValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useStore fora do DataProvider')
  return v
}

/** Dados prontos. Só use dentro de páginas renderizadas sob <RequireData>. */
export function useData(): CompanySnapshot {
  const { status } = useStore()
  if (status.kind !== 'ready') throw new Error('Dados ainda não carregados')
  return status.data
}
