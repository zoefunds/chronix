import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import Logo from '../components/Logo'
import WalletButton from '../components/WalletButton'

const navItems = [
  { to: '/discover', label: 'Discover' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/evidence', label: 'Evidence Ledger' },
  { to: '/create', label: 'Create Market' },
  { to: '/docs', label: 'Docs' },
  { to: '/settings', label: 'Settings' },
]

export default function AppLayout() {
  const navigate = useNavigate()
  return (
    <div className="min-h-screen bg-surface text-on-surface flex flex-col">
      <header className="bg-surface sticky top-0 z-40 border-b border-outline-variant">
        <div className="flex items-center justify-between px-4 md:px-margin-desktop w-full max-w-container-max mx-auto h-14">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 font-headline text-headline-md font-bold text-primary tracking-tight"
          >
            <Logo size={22} />
            EchoMarkets
          </button>
          <nav className="hidden lg:flex items-center gap-6">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `font-label text-label-md uppercase tracking-widest transition-colors ${
                    isActive ? 'text-secondary' : 'text-on-surface-variant hover:text-primary'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <WalletButton />
        </div>
        <nav className="flex lg:hidden overflow-x-auto gap-4 px-4 pb-2 scrollbar-thin">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `font-label text-label-sm uppercase tracking-widest whitespace-nowrap ${
                  isActive ? 'text-secondary' : 'text-on-surface-variant'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1 w-full max-w-container-max mx-auto px-4 md:px-margin-desktop py-6">
        <Outlet />
      </main>
      <footer className="border-t border-outline-variant py-6 px-4 md:px-margin-desktop">
        <div className="max-w-container-max mx-auto flex flex-col md:flex-row justify-between items-center gap-2 text-body-sm text-on-surface-variant">
          <span className="font-label text-label-sm uppercase tracking-widest">
            EchoMarkets · adjudicated by GenLayer Intelligent Contracts
          </span>
          <span className="font-label text-label-sm text-on-surface-variant">© 2026 EchoMarkets</span>
        </div>
      </footer>
    </div>
  )
}
