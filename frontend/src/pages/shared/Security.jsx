import { useState } from 'react'
import { post, setToken } from '../../api.js'
import { useAuth } from '../../auth.jsx'
import { Card, ErrorBox, Field, useAction } from '../../components/ui.jsx'
import { PageHeader } from '../../components/Layout.jsx'

/** Two-factor authentication (KAN-23) and password change. */
export function SecurityCard() {
  const { user, refresh } = useAuth()
  const twofa = useAction()
  const pwd = useAction()
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' })
  const [saved, setSaved] = useState(false)

  return (
    <Card title="Безопасность входа">
      <div className="stack">
        <div className="row">
          <div>
            <div className="title">Двухфакторная аутентификация</div>
            <div className="small muted">При входе на {user.phone || 'телефон'} придёт SMS-код.</div>
          </div>
          <span className="spacer" />
          <span className={`badge ${user.twofaEnabled ? 'ok' : ''}`}>{user.twofaEnabled ? 'Включена' : 'Выключена'}</span>
          <button type="button" className="secondary small" disabled={twofa.busy} onClick={() => twofa.run(async () => { await post('/auth/2fa', { enabled: !user.twofaEnabled }); await refresh() })}>
            {user.twofaEnabled ? 'Выключить' : 'Включить'}
          </button>
        </div>
        <ErrorBox error={twofa.error} />
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); pwd.run(async () => { const r = await post('/auth/password/change', form); setToken(r.token); setForm({ currentPassword: '', newPassword: '' }); setSaved(true) }) }}>
          <Field label="Текущий пароль"><input type="password" autoComplete="current-password" value={form.currentPassword} onChange={(e) => { setSaved(false); setForm({ ...form, currentPassword: e.target.value }) }} required /></Field>
          <Field label="Новый пароль" error={pwd.error?.details?.newPassword}><input type="password" autoComplete="new-password" minLength={8} value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} required /></Field>
          <button disabled={pwd.busy}>Сменить пароль</button>
        </form>
        <ErrorBox error={pwd.error && !pwd.error.details ? pwd.error : null} />
        {saved && <div className="notice ok" role="status">Пароль изменён, другие сеансы завершены.</div>}
      </div>
    </Card>
  )
}

export function SecurityPage() {
  return (
    <>
      <PageHeader title="Безопасность" />
      <SecurityCard />
    </>
  )
}
