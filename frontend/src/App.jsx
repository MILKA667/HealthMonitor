import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth.jsx'
import { Layout } from './components/Layout.jsx'
import { Spinner } from './components/ui.jsx'
import { Login } from './pages/auth/Login.jsx'
import { Register } from './pages/auth/Register.jsx'
import { Forgot } from './pages/auth/Forgot.jsx'
import { PatientHistoryPage, PatientOverview } from './pages/patient/Overview.jsx'
import { DevicesPage, PatientChatPage, RelativesPage, RemindersPage } from './pages/patient/Care.jsx'
import { ProfilePage } from './pages/patient/Profile.jsx'
import { AlertsPage, DoctorChatList, DoctorDashboard, DoctorRequests } from './pages/doctor/Doctor.jsx'
import { PatientCard } from './pages/shared/PatientCard.jsx'
import { SecurityPage } from './pages/shared/Security.jsx'
import { RelativeHome } from './pages/relative/Relative.jsx'
import { AdminAccessLog, AdminAudit, AdminBackups, AdminConsents, AdminMetrics, AdminRequests, AdminUsers } from './pages/admin/Admin.jsx'

const HOME = { patient: '/patient', doctor: '/doctor', relative: '/relative', admin: '/admin' }

function RequireRole({ role, children }) {
  const { user } = useAuth()
  if (user.role !== role) return <Navigate to={HOME[user.role]} replace />
  return children
}

export function AppRoutes() {
  const { loading, user } = useAuth()
  if (loading) return <Spinner />
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot" element={<Forgot />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/patient" element={<RequireRole role="patient"><PatientOverview /></RequireRole>} />
        <Route path="/patient/history" element={<RequireRole role="patient"><PatientHistoryPage /></RequireRole>} />
        <Route path="/patient/reminders" element={<RequireRole role="patient"><RemindersPage /></RequireRole>} />
        <Route path="/patient/devices" element={<RequireRole role="patient"><DevicesPage /></RequireRole>} />
        <Route path="/patient/chat" element={<RequireRole role="patient"><PatientChatPage /></RequireRole>} />
        <Route path="/patient/relatives" element={<RequireRole role="patient"><RelativesPage /></RequireRole>} />
        <Route path="/patient/profile" element={<RequireRole role="patient"><ProfilePage /></RequireRole>} />

        <Route path="/doctor" element={<RequireRole role="doctor"><DoctorDashboard /></RequireRole>} />
        <Route path="/doctor/alerts" element={<RequireRole role="doctor"><AlertsPage /></RequireRole>} />
        <Route path="/doctor/patients/:id" element={<RequireRole role="doctor"><PatientCard mode="doctor" /></RequireRole>} />
        <Route path="/doctor/chat" element={<RequireRole role="doctor"><DoctorChatList /></RequireRole>} />
        <Route path="/doctor/requests" element={<RequireRole role="doctor"><DoctorRequests /></RequireRole>} />
        <Route path="/doctor/settings" element={<RequireRole role="doctor"><SecurityPage /></RequireRole>} />

        <Route path="/relative" element={<RequireRole role="relative"><RelativeHome /></RequireRole>} />
        <Route path="/relative/patients/:id" element={<RequireRole role="relative"><PatientCard mode="relative" /></RequireRole>} />
        <Route path="/relative/settings" element={<RequireRole role="relative"><SecurityPage /></RequireRole>} />

        <Route path="/admin" element={<RequireRole role="admin"><AdminMetrics /></RequireRole>} />
        <Route path="/admin/users" element={<RequireRole role="admin"><AdminUsers /></RequireRole>} />
        <Route path="/admin/requests" element={<RequireRole role="admin"><AdminRequests /></RequireRole>} />
        <Route path="/admin/audit" element={<RequireRole role="admin"><AdminAudit /></RequireRole>} />
        <Route path="/admin/access" element={<RequireRole role="admin"><AdminAccessLog /></RequireRole>} />
        <Route path="/admin/consents" element={<RequireRole role="admin"><AdminConsents /></RequireRole>} />
        <Route path="/admin/backups" element={<RequireRole role="admin"><AdminBackups /></RequireRole>} />
        <Route path="/admin/settings" element={<RequireRole role="admin"><SecurityPage /></RequireRole>} />
      </Route>
      <Route path="*" element={<Navigate to={HOME[user.role]} replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  )
}
