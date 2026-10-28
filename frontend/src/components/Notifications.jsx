import { useEffect, useRef, useState } from 'react'
import { post } from '../api.js'
import { useApi } from '../hooks.js'
import { fmtDateTime } from '../format.js'

/** In-app push notifications (KAN-40): polled every 20 s, with an unread counter. */
export function NotificationBell() {
  const feed = useApi('/notifications?limit=30', { intervalMs: 20_000 })
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const unread = feed.data?.unread ?? 0
  async function readAll() {
    await post('/notifications/read-all')
    feed.reload()
  }

  return (
    <div className="bell" ref={ref}>
      <button type="button" className="secondary small" onClick={() => setOpen((o) => !o)} aria-label={`Уведомления, непрочитанных: ${unread}`} aria-expanded={open}>
        🔔{unread > 0 && <span className="dot">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Уведомления">
          <div className="card-head" style={{ margin: '8px 0' }}>
            <h3>Уведомления</h3>
            {unread > 0 && <button type="button" className="ghost small" onClick={readAll}>Прочитать все</button>}
          </div>
          {feed.data?.items.length ? (
            <ul className="list">
              {feed.data.items.map((n) => (
                <li key={n.id} style={{ opacity: n.readAt ? 0.65 : 1 }}>
                  <div>
                    <div className="title">{n.title}</div>
                    <div className="small">{n.body}</div>
                    <div className="small muted">{fmtDateTime(n.createdAt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty">Уведомлений нет</div>
          )}
        </div>
      )}
    </div>
  )
}
