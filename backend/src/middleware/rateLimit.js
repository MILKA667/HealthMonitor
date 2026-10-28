/** Fixed-window in-memory rate limiter for authentication endpoints (brute-force protection). */
import { HttpError } from '../errors.js'

export function rateLimit({ windowMs, max, now = () => new Date() }) {
  const hits = new Map()
  return (req, _res, next) => {
    const t = now().getTime()
    const key = req.ip
    const entry = hits.get(key)
    if (!entry || t - entry.start >= windowMs) {
      hits.set(key, { start: t, count: 1 })
      if (hits.size > 10_000) hits.clear()
      return next()
    }
    entry.count++
    if (entry.count > max) return next(new HttpError(429, 'RATE_LIMITED', 'Слишком много запросов, попробуйте позже'))
    next()
  }
}
