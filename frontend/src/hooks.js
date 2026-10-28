import { useCallback, useEffect, useRef, useState } from 'react'
import { get } from './api.js'

/** Loads `path` (null = skip) and optionally re-polls every `intervalMs`. */
export function useApi(path, { intervalMs = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(path) })
  const alive = useRef(true)

  const load = useCallback(async () => {
    if (!path) return
    try {
      const data = await get(path)
      if (alive.current) setState({ data, error: null, loading: false })
    } catch (error) {
      if (alive.current) setState((s) => ({ data: s.data, error, loading: false }))
    }
  }, [path])

  useEffect(() => {
    alive.current = true
    load()
    if (!intervalMs) return () => { alive.current = false }
    const id = setInterval(load, intervalMs)
    return () => {
      alive.current = false
      clearInterval(id)
    }
  }, [load, intervalMs])

  return { ...state, reload: load }
}
