import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { post } from '../../api.js'
import { useAuth } from '../../auth.jsx'
import { useApi } from '../../hooks.js'
import { CONDITIONS } from '../../format.js'
import { ErrorBox, Field, Segmented, Spinner, useAction } from '../../components/ui.jsx'
import { AuthShell } from './Login.jsx'

/** Registration of a patient, doctor or relative (KAN-21) with separate consent documents (152-FZ). */
export function Register() {
  const { signIn } = useAuth()
  const [params] = useSearchParams()
  const docs = useApi('/consents/documents')
  const [role, setRole] = useState(params.get('invite') ? 'relative' : 'patient')
  const [form, setForm] = useState({ fullName: '', email: '', phone: '+7', password: '', conditions: [], specialty: '', licenseNumber: '', inviteCode: params.get('invite') ?? '' })
  const [accepted, setAccepted] = useState({})
  const [pending, setPending] = useState(false)
  const { busy, error, run } = useAction()
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const fieldErr = (k) => error?.details?.[k]

  const required = (docs.data ?? []).filter((d) => role === 'patient' || d.type !== 'health_data')

  const submit = (e) => {
    e.preventDefault()
    run(async () => {
      const body = { role, fullName: form.fullName, email: form.email, phone: form.phone, password: form.password, consents: required.filter((d) => accepted[d.id]).map((d) => d.id) }
      if (role === 'patient') body.conditions = form.conditions
      if (role === 'doctor') Object.assign(body, { specialty: form.specialty, licenseNumber: form.licenseNumber })
      if (role === 'relative') body.inviteCode = form.inviteCode
      const res = await post('/auth/register', body)
      if (res.pendingModeration) setPending(true)
      else await signIn(res.token)
    })
  }

  if (pending) {
    return (
      <AuthShell title="Заявка отправлена">
        <p>Учётная запись врача будет активирована после проверки администратором. Мы сообщим о решении по SMS.</p>
        <Link to="/login" className="btn secondary">Ко входу</Link>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Регистрация" wide>
      <form className="stack" onSubmit={submit}>
        <Segmented label="Роль" value={role} onChange={setRole} options={[['patient', 'Пациент'], ['doctor', 'Врач'], ['relative', 'Родственник']]} />
        <div className="form-grid">
          <Field label="ФИО" error={fieldErr('fullName')}><input value={form.fullName} onChange={set('fullName')} required autoComplete="name" /></Field>
          <Field label="Телефон" error={fieldErr('phone')}><input type="tel" value={form.phone} onChange={set('phone')} required placeholder="+79991234567" autoComplete="tel" /></Field>
          <Field label="E-mail" error={fieldErr('email')}><input type="email" value={form.email} onChange={set('email')} required autoComplete="email" /></Field>
          <Field label="Пароль (от 8 символов)" error={fieldErr('password')}><input type="password" value={form.password} onChange={set('password')} required minLength={8} autoComplete="new-password" /></Field>
        </div>
        {role === 'patient' && (
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small muted" style={{ marginBottom: 6 }}>Заболевания для наблюдения</legend>
            {Object.entries(CONDITIONS).map(([k, label]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={form.conditions.includes(k)} onChange={(e) => setForm({ ...form, conditions: e.target.checked ? [...form.conditions, k] : form.conditions.filter((c) => c !== k) })} />
                {label}
              </label>
            ))}
          </fieldset>
        )}
        {role === 'doctor' && (
          <div className="form-grid">
            <Field label="Специальность"><input value={form.specialty} onChange={set('specialty')} /></Field>
            <Field label="Номер лицензии / сертификата" error={fieldErr('licenseNumber')}><input value={form.licenseNumber} onChange={set('licenseNumber')} required /></Field>
          </div>
        )}
        {role === 'relative' && (
          <Field label="Код приглашения от пациента" error={fieldErr('inviteCode')}><input value={form.inviteCode} onChange={set('inviteCode')} required /></Field>
        )}
        <div className="stack">
          <div className="small muted">Согласия оформляются отдельными документами. Отметьте каждое:</div>
          {docs.loading ? <Spinner /> : required.map((d) => (
            <div key={d.id} className="consent-doc">
              <label className="check">
                <input type="checkbox" checked={Boolean(accepted[d.id])} onChange={(e) => setAccepted({ ...accepted, [d.id]: e.target.checked })} />
                <span>{d.type === 'user_agreement' ? 'Принимаю' : 'Даю'} «{d.title}» (версия {d.version})</span>
              </label>
              <details><summary>Текст документа</summary><p>{d.body}</p></details>
            </div>
          ))}
        </div>
        <ErrorBox error={error} />
        <button disabled={busy || required.some((d) => !accepted[d.id])}>{busy ? 'Регистрация…' : 'Зарегистрироваться'}</button>
        <div className="small">Уже есть учётная запись? <Link to="/login">Войти</Link></div>
      </form>
    </AuthShell>
  )
}
