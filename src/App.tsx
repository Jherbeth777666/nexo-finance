import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { ToastProvider } from '@/components/overlay'
import { PageFallback } from '@/app/PageFallback'
import { AuthProvider } from '@/features/auth/session'

// Cada rota é um chunk separado: a landing não baixa o código da aplicação e vice-versa.
const Landing = lazy(() => import('@/features/landing/LandingPage'))
const AuthPage = lazy(() => import('@/features/auth/AuthPage'))
const ResetPassword = lazy(() => import('@/features/auth/ResetPasswordPage'))
const AppShell = lazy(() => import('@/app/AppShell'))
const Overview = lazy(() => import('@/features/overview/OverviewPage'))
const Transactions = lazy(() => import('@/features/transactions/TransactionsPage'))
const Cashflow = lazy(() => import('@/features/cashflow/CashflowPage'))
const Intelligence = lazy(() => import('@/features/intelligence/IntelligencePage'))
const Simulator = lazy(() => import('@/features/simulator/SimulatorPage'))
const Reports = lazy(() => import('@/features/reports/ReportsPage'))
const Imports = lazy(() => import('@/features/imports/ImportsPage'))
const Settings = lazy(() => import('@/features/settings/SettingsPage'))
const NotFound = lazy(() => import('@/app/NotFound'))

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Suspense fallback={<PageFallback full />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<AuthPage mode="login" />} />
            <Route path="/cadastro" element={<AuthPage mode="signup" />} />
            <Route path="/redefinir-senha" element={<ResetPassword />} />
            <Route path="/app" element={<AppShell />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<Overview />} />
              <Route path="movimentacoes" element={<Transactions />} />
              <Route path="fluxo-de-caixa" element={<Cashflow />} />
              <Route path="inteligencia" element={<Intelligence />} />
              <Route path="simulador" element={<Simulator />} />
              <Route path="relatorios" element={<Reports />} />
              <Route path="importacoes" element={<Imports />} />
              <Route path="configuracoes" element={<Settings />} />
              <Route path="*" element={<NotFound inApp />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </AuthProvider>
  )
}
