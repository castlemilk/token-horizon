import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './app'
import './styles/app.css'

const queryClient = new QueryClient()

createRoot(document.getElementById('app')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
)
