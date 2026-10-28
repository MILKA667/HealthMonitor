import { useState } from 'react'
import { del, post, put } from '../../api.js'
import { useAuth } from '../../auth.jsx'
import { useApi } from '../../hooks.js'
import { fmtDateTime } from '../../format.js'
import { Card, Empty, ErrorBox, Field, Loadable, useAction } from '../../components/ui.jsx'
import { PageHeader } from '../../components/Layout.jsx'
import { ChatThread } from '../shared/ChatThread.jsx'

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

/** Medication and measurement reminders. */
export function RemindersPage() {
  const list = useApi('/reminders')
  const [form, setForm] = useState({ kind: 'medication', title: '', timeOfDay: '08:00', days: '1234567' })
  const { busy, error, run } = useAction()
  const toggleDay = (d) => setForm({ ...form, days: form.days.includes(d) ? form.days.replace(d, '') : [...form.days, d].sort().join('') })

  return (
    <>
      <PageHeader title="Напоминания" />
      <div className="grid-2">
        <Card title="Мои напоминания">
          <Loadable state={list}>
            {(items) => items.length ? (
              <ul className="list">
                {items.map((r) => (
                  <li key={r.id}>
                    <span className="clock" style={{ opacity: r.active ? 1 : 0.45 }}>{r.timeOfDay}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="title">{r.title}</div>
                      <div className="meta-line"><span>{r.kind === 'medication' ? 'Приём лекарства' : 'Измерение'}</span><span>{r.days.length === 7 ? 'ежедневно' : r.days.split('').map((d) => DAY_NAMES[d - 1]).join(', ')}</span></div>
                    </div>
                    <label className="check small"><input type="checkbox" checked={r.active} onChange={() => run(async () => { await put(`/reminders/${r.id}`, { active: !r.active }); list.reload() })} />активно</label>
                    <button type="button" className="ghost small" onClick={() => run(async () => { await del(`/reminders/${r.id}`); list.reload() })} aria-label={`Удалить ${r.title}`}>Удалить</button>
                  </li>
                ))}
              </ul>
            ) : <Empty>Напоминаний нет</Empty>}
          </Loadable>
        </Card>
        <Card title="Добавить">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/reminders', form); setForm({ ...form, title: '' }); list.reload() }) }}>
            <Field label="Тип">
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="medication">Приём лекарства</option><option value="measurement">Измерение</option></select>
            </Field>
            <Field label="Что напомнить" error={error?.details?.title}><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required placeholder="Метформин 500 мг" /></Field>
            <Field label="Время" error={error?.details?.timeOfDay}><input type="time" value={form.timeOfDay} onChange={(e) => setForm({ ...form, timeOfDay: e.target.value })} required /></Field>
            <div className="row" role="group" aria-label="Дни недели">
              {DAY_NAMES.map((n, i) => (
                <label key={n} className="check small"><input type="checkbox" checked={form.days.includes(String(i + 1))} onChange={() => toggleDay(String(i + 1))} />{n}</label>
              ))}
            </div>
            <ErrorBox error={error && !error.details ? error : null} />
            <button disabled={busy || !form.days}>Добавить</button>
          </form>
        </Card>
      </div>
    </>
  )
}

/** Binding glucometers and tonometers to the patient cabinet (KAN-36). */
export function DevicesPage() {
  const list = useApi('/devices')
  const adapters = useApi('/devices/adapters')
  const [form, setForm] = useState({ adapter: 'glucometer-v1', kind: 'glucometer', model: '', serial: '' })
  const [issued, setIssued] = useState(null)
  const { busy, error, run } = useAction()
  const adapter = adapters.data?.find((a) => a.id === form.adapter)

  return (
    <>
      <PageHeader title="Медицинские устройства" />
      <div className="grid-2">
        <Card title="Подключённые устройства">
          <Loadable state={list}>
            {(items) => items.filter((d) => d.active).length ? (
              <ul className="list">
                {items.filter((d) => d.active).map((d) => (
                  <li key={d.id}>
                    <div style={{ flex: 1 }}>
                      <div className="title">{d.kind === 'glucometer' ? 'Глюкометр' : 'Тонометр'} {d.model}</div>
                      <div className="meta-line"><span>{d.adapterTitle}</span><span>S/N {d.serial}</span></div>
                      <div className="small muted">Последняя синхронизация: {d.lastSyncAt ? fmtDateTime(d.lastSyncAt) : 'ещё не было'}</div>
                    </div>
                    <button type="button" className="ghost small" onClick={() => run(async () => { await del(`/devices/${d.id}`); list.reload() })}>Отвязать</button>
                  </li>
                ))}
              </ul>
            ) : <Empty>Устройства не подключены. Показатели можно вводить вручную.</Empty>}
          </Loadable>
        </Card>
        <Card title="Подключить устройство">
          {issued ? (
            <div className="stack">
              <div className="notice ok">Устройство привязано.</div>
              <p className="small">Ключ устройства показывается один раз. Укажите его в приложении-мосте производителя или в настройках webhook:</p>
              <code style={{ wordBreak: 'break-all', background: 'var(--surface-2)', padding: 10, borderRadius: 8 }}>{issued.apiKey}</code>
              <button type="button" className="secondary" onClick={() => setIssued(null)}>Готово</button>
            </div>
          ) : (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await post('/devices', { ...form, kind: adapter?.kind ?? form.kind }); setIssued(r); setForm({ ...form, serial: '' }); list.reload() }) }}>
              <Field label="Протокол / источник">
                <select value={form.adapter} onChange={(e) => { const a = adapters.data?.find((x) => x.id === e.target.value); setForm({ ...form, adapter: e.target.value, model: a?.models[0] ?? '' }) }}>
                  {(adapters.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                </select>
              </Field>
              {adapter && !adapter.kind && (
                <Field label="Тип данных">
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="glucometer">Глюкоза</option><option value="tonometer">Давление</option></select>
                </Field>
              )}
              <Field label="Модель">
                <input list="models" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} required />
                <datalist id="models">{adapter?.models.map((m) => <option key={m} value={m} />)}</datalist>
              </Field>
              <Field label="Серийный номер" error={error?.details?.serial}><input value={form.serial} onChange={(e) => setForm({ ...form, serial: e.target.value })} required /></Field>
              <ErrorBox error={error && !error.details ? error : null} />
              <button disabled={busy}>Привязать</button>
            </form>
          )}
        </Card>
      </div>
    </>
  )
}

/** Relatives' contacts for emergency notifications and invitations to the relative cabinet (KAN-27). */
export function RelativesPage() {
  const list = useApi('/patients/me/relatives')
  const [form, setForm] = useState({ name: '', phone: '+7', relation: '', notifyEmergency: true })
  const [invite, setInvite] = useState(null)
  const { busy, error, run } = useAction()
  return (
    <>
      <PageHeader title="Родственники" />
      <div className="grid-2">
        <Card title="Контакты для экстренных уведомлений">
          <Loadable state={list}>
            {(items) => items.length ? (
              <ul className="list">
                {items.map((r) => (
                  <li key={r.id}>
                    <div style={{ flex: 1 }}>
                      <div className="title">{r.name} {r.relation && <span className="muted small">({r.relation})</span>}</div>
                      <div className="meta-line"><span>{r.phone}</span><span>{r.linkedAccount ? 'есть доступ к кабинету' : r.invitePending ? 'приглашение отправлено' : 'без доступа к кабинету'}</span></div>
                      {invite?.id === r.id && <div className="notice ok small" style={{ marginTop: 6 }}>Код приглашения: <b>{invite.code}</b> (также отправлен по SMS)</div>}
                    </div>
                    <div className="stack" style={{ gap: 4, alignItems: 'flex-end' }}>
                      <label className="check small"><input type="checkbox" checked={r.notifyEmergency} onChange={() => run(async () => { await put(`/patients/me/relatives/${r.id}`, { notifyEmergency: !r.notifyEmergency }); list.reload() })} />SMS при критических</label>
                      <div className="row">
                        {!r.linkedAccount && <button type="button" className="ghost small" onClick={() => run(async () => { const x = await post(`/patients/me/relatives/${r.id}/invite`); setInvite({ id: r.id, code: x.inviteCode }); list.reload() })}>Пригласить</button>}
                        <button type="button" className="ghost small" onClick={() => run(async () => { await del(`/patients/me/relatives/${r.id}`); list.reload() })}>Удалить</button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <Empty>Контактов нет</Empty>}
          </Loadable>
        </Card>
        <Card title="Добавить контакт">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/patients/me/relatives', form); setForm({ name: '', phone: '+7', relation: '', notifyEmergency: true }); list.reload() }) }}>
            <Field label="Имя" error={error?.details?.name}><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
            <Field label="Телефон" error={error?.details?.phone}><input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required /></Field>
            <Field label="Кем приходится"><input value={form.relation} onChange={(e) => setForm({ ...form, relation: e.target.value })} placeholder="дочь" /></Field>
            <label className="check"><input type="checkbox" checked={form.notifyEmergency} onChange={(e) => setForm({ ...form, notifyEmergency: e.target.checked })} />Отправлять SMS при критических показателях</label>
            <ErrorBox error={error && !error.details ? error : null} />
            <button disabled={busy}>Добавить</button>
          </form>
        </Card>
      </div>
    </>
  )
}

export function PatientChatPage() {
  const { user, profile } = useAuth()
  return (
    <>
      <PageHeader title="Чат с врачом" />
      <Card title={profile?.doctorName ?? 'Лечащий врач'}>
        {profile?.doctorId ? <ChatThread patientId={user.id} /> : <Empty>Чат станет доступен после назначения лечащего врача</Empty>}
      </Card>
    </>
  )
}
