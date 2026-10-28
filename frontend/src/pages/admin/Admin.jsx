import { useState } from 'react'
import { patch, post } from '../../api.js'
import { useApi } from '../../hooks.js'
import { ROLE_LABELS, STATUS_LABELS, fmtDateTime, fmtNum } from '../../format.js'
import { Card, Empty, ErrorBox, Field, Loadable, Segmented, Stat, useAction, useDialog } from '../../components/ui.jsx'
import { PageHeader } from '../../components/Layout.jsx'

/** Platform metrics against the charter success criteria. */
export function AdminMetrics() {
  const state = useApi('/admin/metrics', { intervalMs: 60_000 })
  return (
    <>
      <PageHeader title="Метрики платформы" sub="Агрегированные показатели без доступа к медицинским записям" />
      <Loadable state={state}>
        {(m) => (
          <div className="stack">
            <div className="census" role="group" aria-label="Участники пилота">
              <Stat label="Пациенты (входили)" value={`${m.users.patients} (${m.users.patientsLoggedIn})`} hint="цель: 20 вошедших" />
              <Stat label="Врачи (входили)" value={`${m.users.doctors} (${m.users.doctorsLoggedIn})`} hint="цель: 5 вошедших" />
              <Stat label="Регулярный ввод" value={m.adherence.pct ?? '—'} unit="%" hint={`${m.adherence.regularPatients} из ${m.adherence.activePatients} активных, цель от ${m.adherence.targetPct}%`} />
            </div>
            <div className="census" role="group" aria-label="Алерты и устройства">
              <Stat label="Реакция на крит. алерт" value={m.alerts.reactionAllTime.avgMinutes === null ? '—' : fmtNum(m.alerts.reactionAllTime.avgMinutes)} unit="мин" hint={`цель до ${m.alerts.reactionAllTime.slaMinutes} мин, в SLA ${m.alerts.reactionAllTime.withinSlaPct ?? '—'}%`} />
              <Stat label="Открытые алерты" value={m.alerts.open} hint={`критических: ${m.alerts.openCritical}`} tone={m.alerts.openCritical ? 'critical' : undefined} />
              <Stat label="Показания с устройств" value={(m.devices.readings.glucometer ?? 0) + (m.devices.readings.tonometer ?? 0)} hint={`глюкометры ${m.devices.readings.glucometer ?? 0}, тонометры ${m.devices.readings.tonometer ?? 0}`} />
            </div>
            <Card title="Критерии успеха (устав, раздел 2)">
              <ul className="list">
                {m.successCriteria.map((c) => (
                  <li key={c.id}><span className={`badge ${c.met ? 'ok' : 'warning'}`}>{c.met ? 'выполнен' : 'не выполнен'}</span><span>{c.title}</span></li>
                ))}
              </ul>
              <p className="small muted">Критерии «бюджет/срок ±10%» и «0 замечаний по 152-ФЗ» проверяются организационно (руководитель проекта, юридический отдел/DPO).</p>
            </Card>
          </div>
        )}
      </Loadable>
    </>
  )
}

/** User management (KAN-43) with roles and access (KAN-44). */
export function AdminUsers() {
  const [role, setRole] = useState('')
  const [q, setQ] = useState('')
  const list = useApi(`/admin/users?limit=200${role ? `&role=${role}` : ''}`)
  const doctors = useApi('/admin/users?role=doctor&status=active&limit=200')
  const roles = useApi('/admin/roles')
  const { busy, error, run } = useAction()
  const [creating, setCreating] = useState(false)
  const [dialog, ask] = useDialog()
  const update = (id, body) => run(async () => { await patch(`/admin/users/${id}`, body); list.reload() })
  const items = (list.data?.items ?? []).filter((u) => !q || `${u.fullName} ${u.email}`.toLowerCase().includes(q.toLowerCase()))

  return (
    <>
      <PageHeader title="Пользователи">
        <button type="button" onClick={() => setCreating((c) => !c)}>{creating ? 'Скрыть' : 'Добавить врача / администратора'}</button>
      </PageHeader>
      {dialog}
      {creating && <CreateUser onCreated={() => { setCreating(false); list.reload() }} />}
      <Card actions={<><input aria-label="Поиск" placeholder="Поиск по имени/e-mail" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} /><Segmented label="Роль" value={role} onChange={setRole} options={[['', 'Все'], ['patient', 'Пациенты'], ['doctor', 'Врачи'], ['relative', 'Родственники'], ['admin', 'Админы']]} /></>}>
        <ErrorBox error={error} />
        <Loadable state={list}>
          {() => (
            <div className="table-wrap">
              <table className="responsive">
                <thead><tr><th>Пользователь</th><th>Роль</th><th>Статус</th><th>Входов</th><th>Последний вход</th><th>Действия</th></tr></thead>
                <tbody>
                  {items.map((u) => (
                    <tr key={u.id}>
                      <td data-label=""><div className="title">{u.fullName}</div><div className="meta-line"><span>{u.email}</span>{u.phone && <span>{u.phone}</span>}</div></td>
                      <td data-label="Роль">
                        <select aria-label={`Роль ${u.fullName}`} value={u.role} disabled={busy} onChange={async (e) => { const role = e.target.value; if (await ask({ title: 'Сменить роль?', body: `${u.fullName}: «${ROLE_LABELS[u.role]}» → «${ROLE_LABELS[role]}». Права доступа изменятся сразу.`, confirmLabel: 'Сменить роль' })) update(u.id, { role }) }}>
                          {Object.entries(ROLE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                        {u.role === 'patient' && (
                          <AssignDoctor user={u} doctors={doctors.data?.items ?? []} onAssign={(doctorId) => update(u.id, { doctorId })} />
                        )}
                      </td>
                      <td data-label="Статус"><span className={`badge ${u.status === 'active' ? 'ok' : u.status === 'blocked' ? 'critical' : ''}`}>{STATUS_LABELS[u.status]}</span></td>
                      <td data-label="Входов" className="num">{u.loginCount}</td>
                      <td data-label="Последний вход" className="nowrap small">{fmtDateTime(u.lastLoginAt)}</td>
                      <td data-label="">
                        {u.status === 'active' && <button type="button" className="secondary small" disabled={busy} onClick={async () => { if (await ask({ title: 'Заблокировать пользователя?', body: `${u.fullName} не сможет войти в систему. Разблокировать можно на этой же странице.`, confirmLabel: 'Заблокировать', danger: true })) update(u.id, { status: 'blocked' }) }}>Заблокировать</button>}
                        {u.status === 'blocked' && <button type="button" className="small" disabled={busy} onClick={() => update(u.id, { status: 'active' })}>Разблокировать</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!items.length && <Empty>Никого не найдено</Empty>}
            </div>
          )}
        </Loadable>
      </Card>
      <Card title="Матрица прав доступа (RBAC)">
        <Loadable state={roles}>
          {(matrix) => (
            <div className="grid">
              {Object.entries(matrix).map(([r, perms]) => (
                <div key={r}><div className="title">{ROLE_LABELS[r]}</div><ul className="small muted" style={{ paddingLeft: 18, margin: '6px 0 0' }}>{perms.map((p) => <li key={p}><code>{p}</code></li>)}</ul></div>
              ))}
            </div>
          )}
        </Loadable>
      </Card>
    </>
  )
}

function AssignDoctor({ user, doctors, onAssign }) {
  return (
    <select aria-label={`Врач для ${user.fullName}`} className="small" style={{ marginTop: 4 }} value={user.doctorId ?? 0} onChange={(e) => onAssign(Number(e.target.value))}>
      <option value="0">— врач не назначен —</option>
      {doctors.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
    </select>
  )
}

function CreateUser({ onCreated }) {
  const [form, setForm] = useState({ role: 'doctor', fullName: '', email: '', phone: '+7', password: '', specialty: '' })
  const { busy, error, run } = useAction()
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  return (
    <Card title="Новый пользователь">
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/admin/users', { ...form, phone: form.phone === '+7' ? undefined : form.phone }); onCreated() }) }}>
        <Field label="Роль"><select value={form.role} onChange={set('role')}><option value="doctor">Врач</option><option value="admin">Администратор</option></select></Field>
        <Field label="ФИО" error={error?.details?.fullName}><input value={form.fullName} onChange={set('fullName')} required /></Field>
        <Field label="E-mail" error={error?.details?.email}><input type="email" value={form.email} onChange={set('email')} required /></Field>
        <Field label="Телефон" error={error?.details?.phone}><input value={form.phone} onChange={set('phone')} /></Field>
        <Field label="Временный пароль" error={error?.details?.password}><input type="password" value={form.password} onChange={set('password')} required minLength={8} autoComplete="new-password" /></Field>
        {form.role === 'doctor' && <Field label="Специальность"><input value={form.specialty} onChange={set('specialty')} /></Field>}
        <button disabled={busy}>Создать</button>
      </form>
      <ErrorBox error={error && !error.details ? error : null} />
    </Card>
  )
}

/** Moderation of doctor registrations and doctor assignment requests (KAN-45). */
export function AdminRequests() {
  const [status, setStatus] = useState('pending')
  const list = useApi(`/admin/requests?status=${status}`)
  const { busy, error, run } = useAction()
  const [dialog, ask] = useDialog()
  const decide = async (id, decision) => {
    let comment
    if (decision === 'reject') {
      const answer = await ask({ title: 'Отклонить заявку?', input: 'Причина отклонения (необязательно)', confirmLabel: 'Отклонить', danger: true })
      if (answer === false) return
      comment = answer || undefined
    }
    run(async () => { await post(`/admin/requests/${id}/${decision}`, comment ? { comment } : {}); list.reload() })
  }
  return (
    <>
      <PageHeader title="Модерация заявок">
        <Segmented label="Статус" value={status} onChange={setStatus} options={[['pending', 'Ожидают'], ['approved', 'Одобрены'], ['rejected', 'Отклонены']]} />
      </PageHeader>
      {dialog}
      <Card>
        <ErrorBox error={error} />
        <Loadable state={list}>
          {(items) => items.length ? (
            <ul className="list">
              {items.map((r) => (
                <li key={r.id}>
                  <div style={{ flex: 1 }}>
                    <div className="row"><span className="badge primary">{r.type === 'doctor_registration' ? 'Регистрация врача' : 'Прикрепление к врачу'}</span><span className="small muted">{fmtDateTime(r.createdAt)}</span></div>
                    <div className="title">{r.user.fullName} <span className="small muted">{r.user.email}</span></div>
                    {r.type === 'doctor_registration' ? <div className="meta-line"><span>Специальность: {r.specialty || '—'}</span><span>Лицензия: {r.licenseNumber || '—'}</span></div> : <div className="small">Врач: {r.targetName}</div>}
                    {r.comment && <div className="small muted">Комментарий: {r.comment}</div>}
                  </div>
                  {r.status === 'pending' && (
                    <div className="row">
                      <button type="button" className="small" disabled={busy} onClick={() => decide(r.id, 'approve')}>Одобрить</button>
                      <button type="button" className="secondary small" disabled={busy} onClick={() => decide(r.id, 'reject')}>Отклонить</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : <Empty>Заявок нет</Empty>}
        </Loadable>
      </Card>
    </>
  )
}

/** Audit of user actions (KAN-46). */
export function AdminAudit() {
  const [action, setAction] = useState('')
  const [offset, setOffset] = useState(0)
  const list = useApi(`/admin/audit?limit=50&offset=${offset}${action ? `&action=${encodeURIComponent(action)}` : ''}`)
  return (
    <>
      <PageHeader title="Аудит действий" />
      <Card actions={<input aria-label="Фильтр действия" placeholder="Действие, напр. auth." value={action} onChange={(e) => { setOffset(0); setAction(e.target.value) }} style={{ width: 220 }} />}>
        <Loadable state={list}>
          {(data) => (
            <>
              <div className="table-wrap">
                <table className="responsive">
                  <thead><tr><th>Время</th><th>Пользователь</th><th>Действие</th><th>Объект</th><th>IP</th></tr></thead>
                  <tbody>
                    {data.items.map((a) => (
                      <tr key={a.id}>
                        <td data-label="Время" className="nowrap small">{fmtDateTime(a.at)}</td>
                        <td data-label="Пользователь">{a.userName ?? '—'}<div className="small muted">{ROLE_LABELS[a.role] ?? a.role ?? ''}</div></td>
                        <td data-label="Действие"><code>{a.action}</code>{a.details && <div className="small muted" style={{ maxWidth: 320, overflowWrap: 'anywhere' }}>{JSON.stringify(a.details)}</div>}</td>
                        <td data-label="Объект" className="small">{a.entity ? `${a.entity} #${a.entityId ?? ''}` : '—'}</td>
                        <td data-label="IP" className="small">{a.ip}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager offset={offset} total={data.total} limit={50} onChange={setOffset} />
            </>
          )}
        </Loadable>
      </Card>
    </>
  )
}

/** Journal of access to medical data (KAN-48). */
export function AdminAccessLog() {
  const [offset, setOffset] = useState(0)
  const list = useApi(`/admin/access-log?limit=50&offset=${offset}`)
  return (
    <>
      <PageHeader title="Журнал доступа к медицинским данным" sub="Кто и когда открывал данные пациентов. Содержимое записей здесь не показывается." />
      <Card>
        <Loadable state={list}>
          {(data) => (
            <>
              <div className="table-wrap">
                <table className="responsive">
                  <thead><tr><th>Время</th><th>Кто</th><th>Пациент</th><th>Ресурс</th><th>IP</th></tr></thead>
                  <tbody>
                    {data.items.map((a) => (
                      <tr key={a.id}>
                        <td data-label="Время" className="nowrap small">{fmtDateTime(a.at)}</td>
                        <td data-label="Кто">{a.userName}<div className="small muted">{ROLE_LABELS[a.role]}</div></td>
                        <td data-label="Пациент">{a.patientName}</td>
                        <td data-label="Ресурс"><code>{a.resource}</code></td>
                        <td data-label="IP" className="small">{a.ip}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager offset={offset} total={data.total} limit={50} onChange={setOffset} />
            </>
          )}
        </Loadable>
      </Card>
    </>
  )
}

function Pager({ offset, total, limit, onChange }) {
  if (total <= limit) return null
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <button type="button" className="secondary small" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Назад</button>
      <span className="small muted">{offset + 1}–{Math.min(total, offset + limit)} из {total}</span>
      <button type="button" className="secondary small" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Вперёд</button>
    </div>
  )
}

/** Consent document versions (KAN-49). */
export function AdminConsents() {
  const docs = useApi('/consents/documents')
  const [form, setForm] = useState({ type: 'user_agreement', version: '', title: '', body: '' })
  const { busy, error, run } = useAction()
  const [done, setDone] = useState(false)
  return (
    <>
      <PageHeader title="Документы согласий" />
      <div className="grid-2">
        <Card title="Действующие редакции">
          <Loadable state={docs}>
            {(items) => <ul className="list">{items.map((d) => <li key={d.id}><div><div className="title">{d.title}</div><div className="small muted">Версия {d.version}, опубликована {fmtDateTime(d.publishedAt)}</div></div></li>)}</ul>}
          </Loadable>
        </Card>
        <Card title="Опубликовать новую редакцию">
          <p className="small muted">Публикация и изменение согласий и пользовательского соглашения требуют согласования с юридическим отделом / DPO (устав, раздел 9). Пользователи увидят требование принять новую редакцию.</p>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/admin/consent-documents', form); setDone(true); docs.reload() }) }}>
            <Field label="Документ">
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, title: (docs.data ?? []).find((d) => d.type === e.target.value)?.title ?? '' })}>
                <option value="personal_data">Согласие на обработку ПДн</option>
                <option value="health_data">Согласие на обработку сведений о здоровье</option>
                <option value="user_agreement">Пользовательское соглашение</option>
              </select>
            </Field>
            <Field label="Версия (напр. 1.1)" error={error?.details?.version}><input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} required /></Field>
            <Field label="Заголовок"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></Field>
            <Field label="Текст"><textarea rows={8} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required /></Field>
            <ErrorBox error={error && !error.details ? error : null} />
            {done && <div className="notice ok small">Опубликовано</div>}
            <button disabled={busy}>Опубликовать</button>
          </form>
        </Card>
      </div>
    </>
  )
}

/** Encrypted backups (KAN-50). Restore is done from the CLI with the API stopped. */
export function AdminBackups() {
  const list = useApi('/admin/backups')
  const { busy, error, run } = useAction()
  const [last, setLast] = useState(null)
  return (
    <>
      <PageHeader title="Резервные копии">
        <button type="button" disabled={busy} onClick={() => run(async () => { setLast(await post('/admin/backups')); list.reload() })}>{busy ? 'Создание…' : 'Создать резервную копию'}</button>
      </PageHeader>
      <ErrorBox error={error} />
      {last && <div className="notice ok" style={{ marginBottom: 16 }}>Копия {last.file} создана и проверена: целостность {last.verification.ok ? 'OK' : 'ОШИБКА'}, пользователей {last.verification.counts.users}, измерений {last.verification.counts.measurements}.</div>}
      <Card>
        <Loadable state={list}>
          {(items) => items.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Файл</th><th>Создана</th><th className="num">Размер</th><th>SHA-256</th><th>Файл на диске</th></tr></thead>
                <tbody>
                  {items.map((b) => (
                    <tr key={b.id}><td className="small">{b.file}</td><td className="nowrap small">{fmtDateTime(b.createdAt)}</td><td className="num">{Math.round(b.size / 1024)} КБ</td><td className="small"><code>{b.sha256.slice(0, 16)}…</code></td><td>{b.exists ? <span className="badge ok">есть</span> : <span className="badge critical">нет</span>}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty>Резервных копий пока нет</Empty>}
        </Loadable>
        <p className="small muted" style={{ marginTop: 12 }}>Копии шифруются AES-256-GCM и должны храниться только на серверах в РФ. Восстановление: остановить API и выполнить <code>npm run restore -- &lt;файл&gt; --yes</code> (текущая БД сохраняется рядом).</p>
      </Card>
    </>
  )
}

