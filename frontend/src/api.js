/** Thin client for the HealthMonitor API. The session token lives in sessionStorage (cleared with the tab). */
const TOKEN_KEY = 'hm_token'

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Ошибка ${status}`)
    this.status = status
    this.code = body?.error?.code
    this.details = body?.error?.details
  }
}

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // storage unavailable (private mode): the session lasts until reload
  }
}

let onUnauthorized = () => {}
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn
}

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const token = getToken()
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 && token) onUnauthorized()
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null))
    return res
  }
  if (res.status === 204) return null
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, data)
  return data
}

export const get = (path) => api(path)
export const post = (path, body = {}) => api(path, { method: 'POST', body })
export const put = (path, body) => api(path, { method: 'PUT', body })
export const patch = (path, body) => api(path, { method: 'PATCH', body })
export const del = (path) => api(path, { method: 'DELETE' })

/** Downloads a binary response (e.g. the PDF report) as a file. */
export async function download(path, filename) {
  const res = await api(path, { raw: true })
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
