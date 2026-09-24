import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { UserRound, Headset, BarChart3, Activity, Layers, Moon, Sun } from 'lucide-react'
import EmployeeView from '@/views/EmployeeView'
import AgentDashboard from '@/views/AgentDashboard'
import AdminAnalytics from '@/views/AdminAnalytics'
import TechStackModal from '@/components/TechStackModal'
import { Tabs, Tab } from '@/components/ui/tabs'
import Button from '@/components/ui/button'
import { cn } from '@/lib/utils'
import api from '@/lib/api'

const ROLES = [
  { key: 'employee', label: 'Employee', icon: UserRound, description: 'Submit & track requests' },
  { key: 'agent', label: 'Support Agent', icon: Headset, description: 'Triage queue + HITL overrides' },
  { key: 'admin', label: 'Admin Analytics', icon: BarChart3, description: 'KPIs, charts, cost savings' },
]

const THEME_KEY = 'autotriage-theme'

export default function App() {
  const [role, setRole] = useState('employee')
  const [health, setHealth] = useState(null)
  const [techOpen, setTechOpen] = useState(false)
  const [dark, setDark] = useState(() => {
    if (typeof window === 'undefined') return false
    const saved = window.localStorage.getItem(THEME_KEY)
    if (saved) return saved === 'dark'
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  })

  // Apply the theme class + persist the preference
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    window.localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
  }, [dark])

  // Flip the theme with an animated iris reveal that expands out of the
  // toggle button (View Transitions API), falling back to a soft radial
  // flash — or an instant switch when the user prefers reduced motion.
  const applyTheme = (next) => {
    document.documentElement.classList.toggle('dark', next)
    window.localStorage.setItem(THEME_KEY, next ? 'dark' : 'light')
    flushSync(() => setDark(next))
  }

  const toggleTheme = (e) => {
    const next = !dark
    const rect = e.currentTarget?.getBoundingClientRect?.()
    document.documentElement.style.setProperty(
      '--vt-x',
      `${rect ? rect.left + rect.width / 2 : window.innerWidth / 2}px`
    )
    document.documentElement.style.setProperty(
      '--vt-y',
      `${rect ? rect.top + rect.height / 2 : window.innerHeight / 2}px`
    )

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      applyTheme(next)
      return
    }
    if (typeof document.startViewTransition === 'function') {
      document.startViewTransition(() => applyTheme(next)).finished.catch(() => {})
    } else {
      applyTheme(next)
      const root = document.documentElement
      root.classList.remove('theme-flash')
      void root.offsetWidth // restart the fallback animation
      root.classList.add('theme-flash')
      window.setTimeout(() => root.classList.remove('theme-flash'), 500)
    }
  }

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth({ status: 'down' }))
  }, [])

  const online = health?.status === 'healthy' && !health?.demo
  const demo = health?.demo === true

  // Role switcher — rendered inline in the navbar from `md` up and as its
  // own centred row below `md` so labels always fit without overflowing.
  const roleTabs = (
    <Tabs>
      {ROLES.map(({ key, label, icon: Icon }) => (
        <Tab
          key={key}
          active={role === key}
          onClick={() => setRole(key)}
          aria-label={label}
          title={label}
        >
          <Icon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{label}</span>
        </Tab>
      ))}
    </Tabs>
  )

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ------------------------------------------------------------ Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-background backdrop-blur">
        <div className="mx-auto max-w-7xl px-4">
          <div className="flex items-center gap-2 py-2.5 sm:gap-4 sm:py-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-white shadow-sm">
                <Activity className="h-5 w-5" />
              </span>
              <div className="leading-tight">
                <h1 className="text-sm font-bold tracking-tight text-foreground">AutoTriage-ITSM</h1>
                <p className="hidden text-[11px] text-muted-foreground xl:block">
                  AI-augmented ticketing · SLA escalation · HITL
                </p>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2 sm:gap-3">
              <span
                className={cn(
                  'hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium lg:inline-flex',
                  online
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300'
                    : demo
                      ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300'
                      : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300'
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    online ? 'bg-emerald-500' : demo ? 'bg-amber-500' : 'bg-red-500 animate-pulse'
                  )}
                />
                {online
                  ? 'API connected'
                  : demo
                    ? 'Demo mode · in-memory'
                    : health
                      ? 'API degraded'
                      : 'API checking…'}
              </span>

              {/* ------------------------------------------- Tech Stack button */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTechOpen(true)}
                aria-label="Open tech stack and architecture"
              >
                <Layers className="h-3.5 w-3.5" />
                <span className="hidden lg:inline">Tech Stack</span>
              </Button>

              {/* ------------------------------------------------ Dark toggle */}
              <Button
                variant="outline"
                size="icon"
                onClick={toggleTheme}
                aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                title={dark ? 'Light mode' : 'Dark mode'}
              >
                {dark ? <Sun className="h-4 w-4 text-amber-400" /> : <Moon className="h-4 w-4" />}
              </Button>

              {/* Role tabs sit inline in the navbar from `md` up */}
              <div className="hidden md:block">{roleTabs}</div>
            </div>
          </div>

          {/* Role switcher gets its own centred row only below `md` */}
          <div className="flex justify-center pb-2.5 sm:pb-3 md:hidden">{roleTabs}</div>
        </div>
      </header>

      {/* -------------------------------------------------------------- Body */}
      <main className="mx-auto max-w-7xl px-4 py-6">
        <div className="mb-5">
          <h2 className="text-lg font-semibold text-foreground">
            {ROLES.find((r) => r.key === role)?.description}
          </h2>
          <p className="text-xs text-muted-foreground">
            {role === 'employee' &&
              'Describe your issue — PII is scrubbed, the AI classifies it, and SLA clocks start immediately.'}
            {role === 'agent' &&
              'Filter the queue, inspect AI decisions, and override classifications with one click.'}
            {role === 'admin' &&
              'Breach rates, classification accuracy and dollars saved by Tier-1 local routing.'}
          </p>
        </div>

        {role === 'employee' && <EmployeeView />}
        {role === 'agent' && <AgentDashboard />}
        {role === 'admin' && <AdminAnalytics />}
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-8 pt-2 text-center text-[11px] text-muted-foreground">
        AutoTriage-ITSM prototype · FastAPI + PostgreSQL/pgvector + Redis/Celery + React · Built by{' '}
        <span className="font-semibold text-foreground">Mahim Vyas</span>
      </footer>

      <TechStackModal open={techOpen} onClose={() => setTechOpen(false)} />
    </div>
  )
}
