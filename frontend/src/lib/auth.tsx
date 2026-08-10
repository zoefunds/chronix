import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useAccount, useDisconnect, useSignMessage } from 'wagmi'
import { SiweMessage } from 'siwe'
import { api } from './api'
import { genlayerStudio } from './wagmi'

interface AuthState {
  wallet: string | null
  token: string | null
  status: 'idle' | 'requesting-nonce' | 'awaiting-signature' | 'verifying' | 'authenticated' | 'error'
  error: string | null
}

interface AuthContextValue extends AuthState {
  signIn: () => Promise<void>
  signOut: () => void
  /**
   * Drops a stale session token (rejected by the backend as expired/invalid)
   * without disconnecting the wallet itself, so the user only has to
   * re-sign a SIWE message, not reconnect their wallet from scratch.
   */
  clearSession: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

const STORAGE_KEY = 'chronix.siwe.session'

export function AuthProvider({ children }: { children: ReactNode }) {
  const { address, chainId } = useAccount()
  const { disconnect } = useDisconnect()
  const { signMessageAsync } = useSignMessage()

  const [state, setState] = useState<AuthState>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { wallet: string; token: string }
        return { wallet: parsed.wallet, token: parsed.token, status: 'authenticated', error: null }
      }
    } catch {
      // ignore malformed storage
    }
    return { wallet: null, token: null, status: 'idle', error: null }
  })

  const signIn = useCallback(async () => {
    if (!address) {
      setState((s) => ({ ...s, status: 'error', error: 'Connect a wallet first.' }))
      return
    }
    try {
      setState((s) => ({ ...s, status: 'requesting-nonce', error: null }))
      const { nonce } = await api.getNonce(address)

      const siweMessage = new SiweMessage({
        domain: window.location.host,
        address,
        statement: 'Sign in to Chronix with your wallet. No email or password required.',
        uri: window.location.origin,
        version: '1',
        chainId: chainId ?? genlayerStudio.id,
        nonce,
      })
      const message = siweMessage.prepareMessage()

      setState((s) => ({ ...s, status: 'awaiting-signature' }))
      const signature = await signMessageAsync({ message })

      setState((s) => ({ ...s, status: 'verifying' }))
      const { token, wallet } = await api.verifySiwe({ message, signature })

      localStorage.setItem(STORAGE_KEY, JSON.stringify({ wallet, token }))
      setState({ wallet, token, status: 'authenticated', error: null })
    } catch (err) {
      setState((s) => ({
        ...s,
        status: 'error',
        error: err instanceof Error ? err.message : 'Sign-in failed. Backend may not be running yet.',
      }))
    }
  }, [address, chainId, signMessageAsync])

  const signOut = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setState({ wallet: null, token: null, status: 'idle', error: null })
    disconnect()
  }, [disconnect])

  const clearSession = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setState((s) => ({ ...s, token: null, status: 'idle', error: null }))
  }, [])

  const value = useMemo(
    () => ({ ...state, signIn, signOut, clearSession }),
    [state, signIn, signOut, clearSession]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
