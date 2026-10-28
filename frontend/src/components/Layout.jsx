import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { ROLE_LABELS } from '../format.js'
import { Logo } from './ui.jsx'
import { NotificationBell } from './Notifications.jsx'

const NAV = {
  patient: [
    ['/patient', 'Обзор'],
    ['/patient/history', 'История и динамика'],
    ['/patient/reminders', 'Напоминания'],
    ['/patient/devices', 'Устройства'],
    ['/patient/chat', 'Чат с врачом'],
    ['/patient/relatives', 'Родственники'],
    ['/patient/profile', 'Профиль и согласия'],
  ],
  doctor: [
    ['/doctor', 'Пациенты'],
    ['/doctor/alerts', 'Алерты'],
    ['/doctor/chat', 'Сообщения'],
    ['/doctor/requests', 'Заявки'],
    ['/doctor/settings', 'Безопасность'],
  ],
  relative: [
    ['/relative', 'Подопечные'],
    ['/relative/settings', 'Безопасность'],
  ],
  admin: [
    ['/admin', 'Метрики'],
    ['/admin/users', 'Пользователи'],
    ['/admin/requests', 'Модерация'],
    ['/admin/audit', 'Аудит'],
    ['/admin/access', 'Доступ к медданным'],
    ['/admin/consents', 'Согласия'],
    ['/admin/backups', 'Резервные копии'],
    ['/admin/settings', 'Безопасность'],
  ],
}

export function Layout() {
  const { user, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const [lastPath, setLastPath] = useState(location.pathname)
  if (lastPath !== location.pathname) {
    setLastPath(location.pathname)
    setOpen(false)
  }
  const items = NAV[user.role] ?? []
  return (
    <div className="app">
      <div className="mobile-bar">
        <button type="button" className="secondary small" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Меню">☰</button>
        <span className="brand" style={{ margin: 0 }}><Logo />HealthMonitor</span>
        <NotificationBell />
      </div>
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <NavLink to={items[0]?.[0] ?? '/'} className="brand"><Logo />HealthMonitor</NavLink>
        <nav className="nav" aria-label="Основное меню">
          {items.map(([to, label]) => (
            <NavLink key={to} to={to} end={to.split('/').length === 2}>{label}</NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="title" style={{ color: 'var(--text)' }}>{user.fullName}</div>
          <div>{ROLE_LABELS[user.role]}</div>
          <button type="button" className="ghost" style={{ paddingLeft: 0 }} onClick={signOut}>Выйти</button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}

export function PageHeader({ title, children }) {
  return (
    <div className="topbar">
      <h1>{title}</h1>
      <div className="row">
        {children}
        <span className="desktop-only"><NotificationBell /></span>
      </div>
    </div>
  )
}
