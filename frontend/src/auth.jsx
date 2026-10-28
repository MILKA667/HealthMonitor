import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { get, getToken, post, setToken, setUnauthorizedHandler } from './api.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: Boolean(getToken()), user: null, consents: null, profile: null })

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setState({ loading: false, user: null, consents: null, profile: null })
      return
    }
    try {
      const me = await get('/auth/me')
      setState({ loading: false, user: me.user, consents: me.consents, profile: me.profile ?? null })
    } catch {
      setToken(null)
      setState({ loading: false, user: null, consents: null, profile: null })
    }
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null)
      setState({ loading: false, user: null, consents: null, profile: null })
    })
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load the session once on mount
    refresh()
  }, [refresh])

  const value = useMemo(
    () => ({
      ...state,
      async signIn(token) {
        setToken(token)
        await refresh()
      },
      async signOut() {
        try {
          await post('/auth/logout')
        } catch {
          // token may already be invalid
        }
        setToken(null)
        setState({ loading: false, user: null, consents: null, profile: null })
      },
      refresh,
    }),
    [state, refresh],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext)
}
