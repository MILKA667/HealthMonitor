import { useEffect, useRef, useState } from 'react'
import { post } from '../../api.js'
import { useApi } from '../../hooks.js'
import { fmtDateTime } from '../../format.js'
import { ErrorBox, Loadable, useAction } from '../../components/ui.jsx'

/** Text chat thread between a patient and the attending doctor. Polls every 5 s. */
export function ChatThread({ patientId }) {
  const thread = useApi(`/chat/${patientId}`, { intervalMs: 5000 })
  const [text, setText] = useState('')
  const { busy, error, run } = useAction()
  const logRef = useRef(null)
  const count = thread.data?.length ?? 0

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [count])

  const send = (e) => {
    e.preventDefault()
    if (!text.trim()) return
    run(async () => {
      await post(`/chat/${patientId}`, { body: text })
      setText('')
      await thread.reload()
    })
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef} aria-live="polite">
        <Loadable state={thread}>
          {(messages) =>
            messages.length ? messages.map((m) => (
              <div key={m.id} className={`bubble ${m.mine ? 'mine' : ''}`}>
                {!m.mine && <div className="meta" style={{ marginTop: 0, marginBottom: 2 }}>{m.senderName}</div>}
                {m.body}
                <div className="meta">{fmtDateTime(m.createdAt)}</div>
              </div>
            )) : <div className="empty">Сообщений пока нет</div>
          }
        </Loadable>
      </div>
      <ErrorBox error={error} />
      <form className="chat-form" onSubmit={send}>
        <input aria-label="Сообщение" value={text} onChange={(e) => setText(e.target.value)} placeholder="Сообщение…" maxLength={4000} />
        <button disabled={busy || !text.trim()}>Отправить</button>
      </form>
    </div>
  )
}
