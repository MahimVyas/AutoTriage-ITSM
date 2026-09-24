import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  RefreshCw,
  Search,
  Ticket as TicketIcon,
  Filter,
  Inbox,
} from 'lucide-react'
import api from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import {
  CategoryBadge,
  SeverityBadge,
  StatusBadge,
  TierBadge,
} from '@/components/ui/badge'
import { cn, CATEGORIES, SEVERITIES, STATUSES, timeLeft, formatDT } from '@/lib/utils'
import TicketDetailModal from '@/components/TicketDetailModal'

const SLA_OPTIONS = [
  { value: '', label: 'All SLA states' },
  { value: 'breached', label: 'Breached only' },
  { value: 'at_risk', label: 'At risk (<1h)' },
  { value: 'ok', label: 'Healthy' },
]

export default function AgentDashboard() {
  const [tickets, setTickets] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [error, setError] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const [filters, setFilters] = useState({
    q: '',
    category: '',
    severity: '',
    status: '',
    sla: '',
  })

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await api.listTickets(filters)
      setTickets(data.items)
      setTotal(data.total)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    api.users('AGENT').then(setAgents).catch(() => setAgents([]))
  }, [])

  useEffect(() => {
    if (!autoRefresh) return undefined
    const id = setInterval(load, 20000)
    return () => clearInterval(id)
  }, [autoRefresh, load])

  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }))

  const breachCount = useMemo(
    () => tickets.filter((t) => t.is_sla_breached).length,
    [tickets]
  )

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------- Toolbar */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-2 p-3 sm:flex sm:flex-wrap sm:items-center">
          <div className="relative col-span-2 sm:col-span-1 sm:min-w-[200px] sm:flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={filters.q}
              onChange={set('q')}
              placeholder="Search tickets…"
              className="pl-8"
            />
          </div>

          <Select value={filters.category} onChange={set('category')} aria-label="Category filter">
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>

          <Select value={filters.severity} onChange={set('severity')} aria-label="Severity filter">
            <option value="">All priorities</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>

          <Select value={filters.status} onChange={set('status')} aria-label="Status filter">
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>

          <Select value={filters.sla} onChange={set('sla')} aria-label="SLA filter">
            {SLA_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>

          <Button variant="outline" size="sm" className="self-center" onClick={load} loading={loading}>
            {!loading && <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </Button>

          <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="h-3.5 w-3.5 accent-blue-600"
            />
            auto
          </label>
        </CardContent>
      </Card>

      {/* --------------------------------------------------------- Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Tickets" value={total} icon={TicketIcon} />
        <Stat
          label="Breached in view"
          value={breachCount}
          icon={Inbox}
          tone={breachCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}
        />
        <Stat label="Active filters" value={Object.values(filters).filter(Boolean).length} icon={Filter} />
        <Stat label="L1 agents online" value={agents.length} icon={Filter} />
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
          Failed to load tickets: {error} — is the API running on :8000?
        </div>
      )}

      {/* --------------------------------------------------------- Table */}
      <Card>
        {loading && tickets.length === 0 ? (
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Loading tickets…
          </CardContent>
        ) : tickets.length === 0 ? (
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No tickets match these filters.
          </CardContent>
        ) : (
          <>
            {/* ------------------------------------- mobile: stacked cards */}
            <CardContent className="p-0 md:hidden">
              <ul className="divide-y divide-border">
                {tickets.map((t) => {
                  const sla = timeLeft(t.sla_deadline, t.is_sla_breached)
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(t.id)}
                        className={cn(
                          'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-blue-50/50 dark:hover:bg-blue-950/40',
                          t.is_sla_breached && 'bg-red-50/60 dark:bg-red-950/50'
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-foreground">{t.title}</p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {t.created_by?.name || 'Unknown'} · {t.id.slice(0, 8)}
                          </p>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            <SeverityBadge value={t.severity} />
                            <StatusBadge value={t.status} />
                            <CategoryBadge value={t.category} />
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <span
                            className={cn(
                              'text-xs font-semibold tabular-nums',
                              sla.tone === 'bad'
                                ? 'text-red-600 dark:text-red-400'
                                : sla.tone === 'warn'
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-muted-foreground'
                            )}
                          >
                            {sla.label}
                          </span>
                          <p className="text-[10px] text-muted-foreground">
                            {formatDT(t.sla_deadline)}
                          </p>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </CardContent>

            {/* ------------------------------------ md+: sortable table */}
            <CardContent className="hidden overflow-x-auto p-0 md:block">
              <table className="w-full text-left text-xs lg:min-w-[880px]">
                <thead>
                  <tr className="border-b border-border bg-muted text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-semibold">Ticket</th>
                    <th className="px-3 py-2.5 font-semibold">Category</th>
                    <th className="px-3 py-2.5 font-semibold">Priority</th>
                    <th className="px-3 py-2.5 font-semibold">Status</th>
                    <th className="hidden px-3 py-2.5 font-semibold lg:table-cell">AI tier</th>
                    <th className="hidden px-3 py-2.5 font-semibold lg:table-cell">Confidence</th>
                    <th className="px-3 py-2.5 font-semibold">SLA</th>
                    <th className="px-3 py-2.5 font-semibold">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((t) => {
                    const sla = timeLeft(t.sla_deadline, t.is_sla_breached)
                    return (
                      <tr
                        key={t.id}
                        onClick={() => setSelectedId(t.id)}
                        className={cn(
                          'cursor-pointer border-b border-border/70 transition-colors hover:bg-blue-50/50 dark:hover:bg-blue-950/40',
                          t.is_sla_breached && 'bg-red-50/60 dark:bg-red-950/50'
                        )}
                      >
                        <td className="max-w-[260px] px-4 py-2.5">
                          <p className="truncate font-medium text-foreground">{t.title}</p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {t.created_by?.name || 'Unknown'} · {t.id.slice(0, 8)}
                          </p>
                        </td>
                        <td className="px-3 py-2.5">
                          <CategoryBadge value={t.category} />
                          {t.subcategory && (
                            <p className="mt-0.5 text-[10px] text-muted-foreground">{t.subcategory}</p>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <SeverityBadge value={t.severity} />
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusBadge value={t.status} />
                        </td>
                        <td className="hidden px-3 py-2.5 lg:table-cell">
                          <TierBadge value={t.ai_tier_used} />
                        </td>
                        <td className="hidden px-3 py-2.5 lg:table-cell">
                          <div className="flex items-center gap-1.5">
                            <div className="h-1.5 w-14 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                              <div
                                className={cn(
                                  'h-full rounded-full',
                                  t.confidence_score >= 0.85
                                    ? 'bg-emerald-500'
                                    : t.confidence_score >= 0.6
                                      ? 'bg-amber-500'
                                      : 'bg-red-500'
                                )}
                                style={{ width: `${Math.round(t.confidence_score * 100)}%` }}
                              />
                            </div>
                            <span className="tabular-nums text-muted-foreground">
                              {Math.round(t.confidence_score * 100)}%
                            </span>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          <span
                            className={cn(
                              'font-semibold tabular-nums',
                              sla.tone === 'bad'
                                ? 'text-red-600 dark:text-red-400'
                                : sla.tone === 'warn'
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-muted-foreground'
                            )}
                          >
                            {sla.label}
                          </span>
                          <p className="text-[10px] text-muted-foreground">{formatDT(t.sla_deadline)}</p>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                          {formatDT(t.created_at)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </CardContent>
          </>
        )}
      </Card>

      <TicketDetailModal
        ticketId={selectedId}
        open={Boolean(selectedId)}
        onClose={() => setSelectedId(null)}
        onChanged={load}
        agents={agents}
      />
    </div>
  )
}

function Stat({ label, value, icon: Icon, tone = 'text-foreground' }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-2.5 p-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <p className={cn('text-lg font-bold leading-tight tabular-nums', tone)}>{value}</p>
          <p className="text-[11px] text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}
