import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../auth.jsx'
import { AppRoutes } from '../App.jsx'
import { LineChart } from '../components/LineChart.jsx'
import { MeasurementForm } from '../pages/shared/MeasurementForm.jsx'
import { fmtValue, typesFor } from '../format.js'

/** Minimal fake backend: routes are "METHOD /path" → handler(body) or static value. */
function mockApi(routes) {
  const calls = []
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET'
    const path = url.replace(/^\/api/, '').split('?')[0]
    const body = opts.body ? JSON.parse(opts.body) : undefined
    calls.push({ method, path, url, body, auth: opts.headers?.authorization })
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ')
      return m === method && new RegExp(`^${p.replace(/:\w+/g, '[^/]+')}$`).test(path)
    })
    if (!key) return new Response(JSON.stringify({ error: { message: `no mock for ${method} ${path}` } }), { status: 404 })
    const r = typeof routes[key] === 'function' ? routes[key](body, url) : routes[key]
    const status = r?.__status ?? 200
    return new Response(JSON.stringify(r?.__body ?? r), { status, headers: { 'content-type': 'application/json' } })
  })
  return calls
}

function renderApp(path = '/') {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  )
}

const DOCS = [
  { id: 1, type: 'health_data', version: '1.0', title: 'Согласие на обработку сведений о здоровье', body: 'текст' },
  { id: 2, type: 'personal_data', version: '1.0', title: 'Согласие на обработку ПДн', body: 'текст' },
  { id: 3, type: 'user_agreement', version: '1.0', title: 'Пользовательское соглашение', body: 'текст' },
]
const CONSENTS_OK = { personal_data: { active: true, latestAccepted: true }, health_data: { active: true, latestAccepted: true }, user_agreement: { active: true, latestAccepted: true } }
const PATIENT = { id: 7, role: 'patient', fullName: 'Иванов Иван Иванович', email: 'p@t.ru', phone: '+79990000000', twofaEnabled: false }
const DOCTOR = { id: 3, role: 'doctor', fullName: 'Петрова Анна', email: 'd@t.ru', phone: '+79990000001', twofaEnabled: true }

beforeEach(() => {
  sessionStorage.clear()
})

describe('format helpers', () => {
  it('formats values and picks measurement types by condition', () => {
    expect(fmtValue('glucose', { glucose: 5.6 })).toBe('5,6 ммоль/л')
    expect(fmtValue('blood_pressure', { systolic: 120, diastolic: 80, pulse: 70 })).toBe('120/80 мм рт. ст. · пульс 70')
    expect(typesFor(['asthma'])).toEqual(['peak_flow'])
    expect(typesFor([])).toEqual(['glucose', 'blood_pressure', 'peak_flow'])
  })
})

describe('authentication', () => {
  it('redirects anonymous users to login and signs in with 2FA', async () => {
    const calls = mockApi({
      'POST /auth/login': { twofaRequired: true, challenge: 'ch1' },
      'POST /auth/2fa/verify': (b) => (b.code === '123456' ? { token: 'tok', user: DOCTOR } : { __status: 401, __body: { error: { message: 'Неверный код' } } }),
      'GET /auth/me': { user: DOCTOR, consents: CONSENTS_OK },
      'GET /doctor/dashboard': { patients: [], totals: { patients: 0, critical: 0, warning: 0, stale: 0 }, reaction: { avgMinutes: null, slaMinutes: 15 } },
      'GET /alerts': { items: [] },
      'GET /notifications': { items: [], unread: 0 },
    })
    const user = userEvent.setup()
    renderApp('/doctor')
    expect(await screen.findByRole('heading', { name: 'Вход' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('E-mail'), 'd@t.ru')
    await user.type(screen.getByLabelText('Пароль'), 'secret123')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByRole('heading', { name: 'Подтверждение входа' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Код из SMS'), '000000')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный код')
    await user.clear(screen.getByLabelText('Код из SMS'))
    await user.type(screen.getByLabelText('Код из SMS'), '123456')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByRole('heading', { name: 'Мои пациенты' })).toBeInTheDocument()
    expect(sessionStorage.getItem('hm_token')).toBe('tok')
    expect(calls.find((c) => c.path === '/auth/me').auth).toBe('Bearer tok')
  })

  it('registration requires every consent document to be accepted separately', async () => {
    const calls = mockApi({
      'GET /consents/documents': DOCS,
      'POST /auth/register': { token: 'tok', user: PATIENT },
      'GET /auth/me': { user: PATIENT, consents: CONSENTS_OK, profile: { conditions: ['diabetes_t2'], doctorId: null } },
      'GET /patients/:id/measurements': { items: [], summary: {} },
      'GET /alerts': { items: [] },
      'GET /patients/:id/thresholds': { thresholds: {} },
      'GET /notifications': { items: [], unread: 0 },
    })
    const user = userEvent.setup()
    renderApp('/register')
    await screen.findByText(/Согласие на обработку сведений о здоровье/)
    await user.type(screen.getByLabelText('ФИО'), 'Иванов Иван Иванович')
    await user.clear(screen.getByLabelText('Телефон'))
    await user.type(screen.getByLabelText('Телефон'), '+79990000000')
    await user.type(screen.getByLabelText('E-mail'), 'p@t.ru')
    await user.type(screen.getByLabelText('Пароль (от 8 символов)'), 'password1')
    await user.click(screen.getByLabelText('Сахарный диабет 2 типа'))
    const submit = screen.getByRole('button', { name: 'Зарегистрироваться' })
    const boxes = screen.getAllByRole('checkbox').filter((c) => c.closest('.consent-doc'))
    expect(boxes).toHaveLength(3)
    await user.click(boxes[0])
    await user.click(boxes[1])
    expect(submit).toBeDisabled()
    await user.click(boxes[2])
    expect(submit).toBeEnabled()
    await user.click(submit)
    await screen.findByText(/Здравствуйте/)
    const reg = calls.find((c) => c.path === '/auth/register')
    expect(reg.body.consents.sort()).toEqual([1, 2, 3])
    expect(reg.body.conditions).toEqual(['diabetes_t2'])
  })

  it('relatives do not see the health-data consent; doctors go to moderation', async () => {
    mockApi({ 'GET /consents/documents': DOCS, 'POST /auth/register': { pendingModeration: true, user: { id: 9 } } })
    const user = userEvent.setup()
    renderApp('/register')
    await screen.findByText(/Согласие на обработку сведений о здоровье/)
    await user.click(screen.getByRole('button', { name: 'Родственник' }))
    expect(screen.queryByText(/Согласие на обработку сведений о здоровье/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Код приглашения от пациента')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Врач' }))
    await user.type(screen.getByLabelText('ФИО'), 'Доктор Тест')
    await user.type(screen.getByLabelText('E-mail'), 'doc@t.ru')
    await user.type(screen.getByLabelText('Пароль (от 8 символов)'), 'password1')
    await user.type(screen.getByLabelText('Номер лицензии / сертификата'), 'L-1')
    for (const c of screen.getAllByRole('checkbox')) await user.click(c)
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))
    expect(await screen.findByRole('heading', { name: 'Заявка отправлена' })).toBeInTheDocument()
  })
})

describe('patient cabinet', () => {
  it('manual measurement entry posts canonical payload and shows severity', async () => {
    const calls = mockApi({
      'POST /patients/:id/measurements': (b) => ({ id: 1, type: b.type, value: { systolic: 190, diastolic: 115 }, severity: 'critical', alerts: [{ id: 5 }] }),
    })
    const onSaved = vi.fn()
    const user = userEvent.setup()
    render(<MeasurementForm patientId={7} types={['glucose', 'blood_pressure']} onSaved={onSaved} />)
    await user.click(screen.getByRole('button', { name: 'Давление' }))
    await user.type(screen.getByLabelText('Систолическое (верхнее)'), '190')
    await user.type(screen.getByLabelText('Диастолическое (нижнее)'), '115')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('Критический')
    expect(status).toHaveTextContent('Лечащий врач получил уведомление')
    const post = calls.find((c) => c.method === 'POST')
    expect(post.path).toBe('/patients/7/measurements')
    expect(post.body.type).toBe('blood_pressure')
    expect(post.body.value).toEqual({ systolic: '190', diastolic: '115' })
    expect(new Date(post.body.measuredAt).toString()).not.toBe('Invalid Date')
    expect(onSaved).toHaveBeenCalled()
  })

  it('shows field validation errors from the API', async () => {
    mockApi({ 'POST /patients/:id/measurements': { __status: 400, __body: { error: { message: 'Показание не прошло валидацию', details: { glucose: 'вне допустимого диапазона 0.5–40 ммоль/л' } } } } })
    const user = userEvent.setup()
    render(<MeasurementForm patientId={7} types={['glucose']} />)
    await user.type(screen.getByLabelText('Глюкоза'), '99')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findAllByText(/вне допустимого диапазона/)).not.toHaveLength(0)
  })

  it('patient cannot open doctor pages', async () => {
    sessionStorage.setItem('hm_token', 'tok')
    mockApi({
      'GET /auth/me': { user: PATIENT, consents: CONSENTS_OK, profile: { conditions: ['asthma'], doctorId: 3, doctorName: 'Петрова Анна' } },
      'GET /patients/:id/measurements': { items: [], summary: {} },
      'GET /alerts': { items: [] },
      'GET /patients/:id/thresholds': { thresholds: {} },
      'GET /notifications': { items: [{ id: 1, title: 'Напоминание об измерении', body: 'Утреннее измерение', createdAt: new Date().toISOString() }], unread: 1 },
    })
    renderApp('/doctor')
    expect(await screen.findByText(/Здравствуйте, Иван Иванович/)).toBeInTheDocument()
    expect(screen.getByText('Петрова Анна')).toBeInTheDocument()
    expect(screen.getByLabelText('ПСВ, л/мин')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Тип показателя' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByLabelText('Уведомления, непрочитанных: 1').length).toBeGreaterThan(0))
  })
})

describe('doctor cabinet', () => {
  it('dashboard lists patients in server priority order with badges', async () => {
    sessionStorage.setItem('hm_token', 'tok')
    const now = new Date().toISOString()
    mockApi({
      'GET /auth/me': { user: DOCTOR, consents: CONSENTS_OK },
      'GET /notifications': { items: [], unread: 0 },
      'GET /alerts': { items: [] },
      'GET /doctor/dashboard': {
        patients: [
          { id: 1, fullName: 'Критический Пациент', priority: 'critical', openCritical: 2, openWarning: 0, conditions: ['diabetes_t2'], consent: true, latest: [{ type: 'glucose', value: { glucose: 22 } }], lastMeasurementAt: now },
          { id: 2, fullName: 'Без Данных', priority: 'stale', openCritical: 0, openWarning: 0, conditions: ['hypertension'], consent: true, latest: [], lastMeasurementAt: null },
          { id: 3, fullName: 'Спокойный Пациент', priority: 'normal', openCritical: 0, openWarning: 0, conditions: ['asthma'], consent: true, latest: [{ type: 'peak_flow', value: { peak_flow: 420 } }], lastMeasurementAt: now },
        ],
        totals: { patients: 3, critical: 1, warning: 0, stale: 1 },
        reaction: { avgMinutes: 7.5, slaMinutes: 15 },
      },
    })
    const user = userEvent.setup()
    renderApp('/doctor')
    await screen.findByText('Критический Пациент')
    const links = screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/doctor/patients/'))
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/doctor/patients/1', '/doctor/patients/2', '/doctor/patients/3'])
    expect(within(links[0]).getByText('2 крит.')).toBeInTheDocument()
    expect(within(links[0]).getByText('22 ммоль/л')).toBeInTheDocument()
    expect(screen.getByText('7,5')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Нет данных' }))
    expect(screen.queryByText('Критический Пациент')).not.toBeInTheDocument()
    expect(screen.getByText('Без Данных')).toBeInTheDocument()
  })
  it('alarm queue shows open alerts by severity and acknowledges in one click', async () => {
    sessionStorage.setItem('hm_token', 'tok')
    const old = new Date(Date.now() - 20 * 60000).toISOString()
    let open = [
      { id: 11, patientId: 2, patientName: 'Пациент Отклонение', severity: 'warning', status: 'open', message: 'Глюкоза выше целевого диапазона', createdAt: old, escalationLevel: 0 },
      { id: 12, patientId: 1, patientName: 'Пациент Критический', severity: 'critical', status: 'open', message: 'Давление выше критического порога', createdAt: new Date().toISOString(), escalationLevel: 0 },
    ]
    const calls = mockApi({
      'GET /auth/me': { user: DOCTOR, consents: CONSENTS_OK },
      'GET /notifications': { items: [], unread: 0 },
      'GET /alerts': () => ({ items: open }),
      'POST /alerts/:id/ack': (b, url) => { open = open.filter((a) => !url.includes(`/alerts/${a.id}/`)); return { ok: true } },
      'GET /doctor/dashboard': { patients: [], totals: { patients: 0, critical: 1, warning: 1, stale: 0 }, reaction: { avgMinutes: null, slaMinutes: 15 } },
    })
    const user = userEvent.setup()
    renderApp('/doctor')
    const queue = await screen.findByRole('region', { name: /Ожидают реакции: 2/ })
    const names = within(queue).getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/doctor/patients/')).map((a) => a.textContent)
    expect(names).toEqual(['Пациент Критический', 'Пациент Отклонение'])
    expect(within(queue).getByText('ждёт 20 мин')).toHaveClass('over')
    await user.click(within(queue).getByRole('button', { name: 'Принять алерт: Пациент Критический' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/alerts/12/ack')).toBe(true))
    expect(await screen.findByRole('region', { name: /Ожидают реакции: 1/ })).toBeInTheDocument()
  })
})

describe('admin cabinet', () => {
  it('blocking a user asks for confirmation in an accessible dialog', async () => {
    sessionStorage.setItem('hm_token', 'tok')
    const ADMIN = { id: 1, role: 'admin', fullName: 'Админ Тестовый', email: 'a@t.ru', phone: '+79990000002', twofaEnabled: true }
    const calls = mockApi({
      'GET /auth/me': { user: ADMIN, consents: CONSENTS_OK },
      'GET /notifications': { items: [], unread: 0 },
      'GET /admin/users': { items: [{ id: 5, role: 'doctor', status: 'active', fullName: 'Синтетический Врач', email: 'doc@t.ru', loginCount: 0, lastLoginAt: null }] },
      'GET /admin/roles': { doctor: ['patients:assigned:read'] },
      'PATCH /admin/users/:id': { ok: true },
    })
    const user = userEvent.setup()
    renderApp('/admin/users')
    expect(await screen.findByText(/Медицинские данные пациентов администраторам недоступны/)).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Заблокировать' }))
    const dialog = screen.getByRole('dialog', { name: 'Заблокировать пользователя?' })
    expect(within(dialog).getByRole('button', { name: 'Заблокировать' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Заблокировать' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Заблокировать' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'blocked' }))
  })
})

describe('LineChart', () => {
  it('renders series, threshold corridor and critical limit', () => {
    const t = Date.now()
    const { container } = render(
      <LineChart
        unit="ммоль/л"
        thresholds={{ critLow: 3, warnLow: 3.9, warnHigh: 10, critHigh: 15 }}
        series={[{ key: 'glucose', label: 'Глюкоза', points: [{ t: t - 7200_000, v: 5 }, { t: t - 3600_000, v: 16, severity: 'critical' }, { t, v: 7 }] }]}
      />,
    )
    expect(container.querySelectorAll('circle')).toHaveLength(3)
    expect(container.querySelector('path').getAttribute('d')).toMatch(/^M[\d.]+,[\d.]+ L/)
    expect(container.querySelector('.band-warn')).not.toBeNull()
    expect(screen.getByText('крит. 15')).toBeInTheDocument()
    expect(screen.getByText('целевой диапазон')).toBeInTheDocument()
  })

  it('shows an empty state without data', () => {
    render(<LineChart series={[]} />)
    expect(screen.getByText('Нет измерений за период')).toBeInTheDocument()
  })
})
