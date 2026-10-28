import { useState } from 'react'
import { Link } from 'react-router-dom'
import { post } from '../../api.js'
import { ErrorBox, Field, useAction } from '../../components/ui.jsx'
import { AuthShell } from './Login.jsx'

/** Password recovery by SMS code (KAN-22). */
export function Forgot() {
  const [email, setEmail] = useState('')
  const [step, setStep] = useState(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [done, setDone] = useState(false)
  const { busy, error, run } = useAction()

  if (done) {
    return (
      <AuthShell title="Пароль изменён">
        <p>Все прежние сеансы завершены. Войдите с новым паролем.</p>
        <Link className="btn" to="/login">Войти</Link>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Восстановление пароля">
      {!step ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await post('/auth/password/forgot', { email }); setStep(r); if (r.devCode) setCode(r.devCode) }) }}>
          <Field label="E-mail"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
          <ErrorBox error={error} />
          <button disabled={busy}>Получить код по SMS</button>
          <Link to="/login" className="small">Ко входу</Link>
        </form>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/auth/password/reset', { challenge: step.challenge, code, newPassword: password }); setDone(true) }) }}>
          <p className="muted">{step.message}</p>
          {step.devCode && <div className="notice warn small">Тестовый режим: код подставлен автоматически.</div>}
          <Field label="Код из SMS"><input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required /></Field>
          <Field label="Новый пароль (от 8 символов)" error={error?.details?.newPassword}><input type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" /></Field>
          <ErrorBox error={error} />
          <button disabled={busy || code.length !== 6}>Сменить пароль</button>
        </form>
      )}
    </AuthShell>
  )
}
