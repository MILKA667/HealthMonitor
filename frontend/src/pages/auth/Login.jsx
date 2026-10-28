import { useState } from 'react'
import { Link } from 'react-router-dom'
import { post } from '../../api.js'
import { useAuth } from '../../auth.jsx'
import { ErrorBox, Field, Logo, useAction } from '../../components/ui.jsx'

export function AuthShell({ title, wide, children }) {
  return (
    <div className="auth-page">
      <div className={`card auth-card ${wide ? 'wide' : ''}`}>
        <div className="brand"><Logo />HealthMonitor</div>
        <p className="tagline">Удалённое наблюдение при диабете, гипертонии и астме</p>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  )
}

export function Login() {
  const { signIn } = useAuth()
  const [form, setForm] = useState({ email: '', password: '' })
  const [challenge, setChallenge] = useState(null)
  const [code, setCode] = useState('')
  const { busy, error, run } = useAction()

  const submit = (e) => {
    e.preventDefault()
    run(async () => {
      const res = await post('/auth/login', form)
      if (res.twofaRequired) {
        setChallenge(res)
        if (res.devCode) setCode(res.devCode)
      } else await signIn(res.token)
    })
  }
  const verify = (e) => {
    e.preventDefault()
    run(async () => {
      const res = await post('/auth/2fa/verify', { challenge: challenge.challenge, code })
      await signIn(res.token)
    })
  }

  if (challenge) {
    return (
      <AuthShell title="Подтверждение входа">
        <form className="stack" onSubmit={verify}>
          <p className="muted">Мы отправили SMS с 6-значным кодом на номер, указанный в профиле.</p>
          {challenge.devCode && <div className="notice warn small">Тестовый режим: код подставлен автоматически.</div>}
          <Field label="Код из SMS">
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus />
          </Field>
          <ErrorBox error={error} />
          <button disabled={busy || code.length !== 6}>Войти</button>
          <button type="button" className="ghost" onClick={() => setChallenge(null)}>Назад</button>
        </form>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Вход">
      <form className="stack" onSubmit={submit}>
        <Field label="E-mail">
          <input type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required autoFocus />
        </Field>
        <Field label="Пароль">
          <input type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        </Field>
        <ErrorBox error={error} />
        <button disabled={busy}>{busy ? 'Вход…' : 'Войти'}</button>
        <div className="row small">
          <Link to="/forgot">Забыли пароль?</Link>
          <span className="spacer" />
          <Link to="/register">Регистрация</Link>
        </div>
      </form>
    </AuthShell>
  )
}
