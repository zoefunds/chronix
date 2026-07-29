import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { WagmiProvider } from 'wagmi'
import AppLayout from './layout/AppLayout'
import { AuthProvider } from './lib/auth'
import { wagmiConfig } from './lib/wagmi'
import AdjudicationResultPage from './pages/AdjudicationResult'
import CreateMarket from './pages/CreateMarket'
import Discover from './pages/Discover'
import Docs from './pages/Docs'
import EvidenceLedger from './pages/EvidenceLedger'
import Landing from './pages/Landing'
import MarketDetail from './pages/MarketDetail'
import NotFound from './pages/NotFound'
import Portfolio from './pages/Portfolio'
import Settings from './pages/Settings'

const queryClient = new QueryClient()

function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path="/" element={<Landing />} />
                <Route path="/discover" element={<Discover />} />
                <Route path="/markets/:id" element={<MarketDetail />} />
                <Route path="/markets/:id/result" element={<AdjudicationResultPage />} />
                <Route path="/create" element={<CreateMarket />} />
                <Route path="/portfolio" element={<Portfolio />} />
                <Route path="/evidence" element={<EvidenceLedger />} />
                <Route path="/docs" element={<Docs />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

export default App
