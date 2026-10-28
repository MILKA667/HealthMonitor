import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { ROLE_LABELS } from '../format.js'
import { Icon, Logo } from './ui.jsx'
import { NotificationBell } from './Notifications.jsx'

const ROLE_CABINET = { patient: 'Кабинет пациента', doctor: 'Кабинет врача', relative: 'Кабинет родственника', admin: 'Администрирование' }

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
  const menuButton = useRef(null)
  if (lastPath !== location.pathname) {
    setLastPath(location.pathname)
    setOpen(false)
  }
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        menuButton.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    document.querySelector('.sidebar a')?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  const items = NAV[user.role] ?? []
  return (
    <div className="app">
      <a className="skip-link" href="#main">Перейти к содержанию</a>
      <div className="mobile-bar">
        <button ref={menuButton} type="button" className="secondary icon" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="sidebar" aria-label="Меню"><Icon name="menu" /></button>
        <span className="brand"><Logo />HealthMonitor</span>
        <NotificationBell />
      </div>
      <button type="button" className={`backdrop ${open ? 'open' : ''}`} aria-hidden="true" tabIndex={-1} onClick={() => setOpen(false)} />
      <aside id="sidebar" className={`sidebar ${open ? 'open' : ''}`}>
        <NavLink to={items[0]?.[0] ?? '/'} className="brand"><Logo />HealthMonitor</NavLink>
        <span className="role-tag">{ROLE_CABINET[user.role]}</span>
        <nav className="nav" aria-label="Основное меню">
          {items.map(([to, label]) => (
            <NavLink key={to} to={to} end={to.split('/').length === 2}>{label}</NavLink>
          ))}
        </nav>
        {user.role === 'admin' && (
          <p className="sidebar-note"><Icon name="lock" size={15} />Медицинские данные пациентов администраторам недоступны.</p>
        )}
        {user.role === 'relative' && (
          <p className="sidebar-note"><Icon name="eye" size={15} />Режим просмотра: изменить данные подопечного нельзя.</p>
        )}
        <div className="sidebar-foot">
          <div className="who">{user.fullName}</div>
          <div>{ROLE_LABELS[user.role]}</div>
          <button type="button" className="ghost small" style={{ marginLeft: -10, marginTop: 4 }} onClick={signOut}>Выйти</button>
        </div>
      </aside>
      <main className="main" id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  )
}

export function PageHeader({ title, sub, children }) {
  return (
    <div className="topbar">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      <div className="topbar-actions">
        {children}
        <span className="desktop-only"><NotificationBell /></span>
      </div>
    </div>
  )
}
