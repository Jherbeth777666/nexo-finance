import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
// Somente o subconjunto latino da Inter variável (~48 KB, carregado com font-display: swap).
import '@fontsource-variable/inter/wght.css'
import './styles/index.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
