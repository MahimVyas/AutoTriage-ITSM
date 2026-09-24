import { useEffect, useState } from 'react'
import {
  Ticket,
  ShieldAlert,
  Brain,
  PiggyBank,
  TrendingUp,
  Activity,
} from 'lucide-react'
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import api from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import CountUp from '@/components/bits/CountUp'
import ShinyText from '@/components/bits/ShinyText'

const BAR_COLORS = ['#2563eb', '#0891b2', '#7c3aed', '#059669', '#e11d48', '#94a3b8']
const TIER_COLORS = { TIER1_LOCAL_SLM: '#059669', TIER2_CLOUD_LLM: '#2563eb', RULE_FALLBACK: '#94a3b8' }
const TIER_NAMES = { TIER1_LOCAL_SLM: 'Tier 1', TIER2_CLOUD_LLM: 'Tier 2', RULE_FALLBACK: 'Rule fallback' }

export default function AdminAnalytics() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      setLoading(true)
      setError(null)
      setData(await api.analytics())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
  }, [])

  const s = data?.summary

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            <ShinyText
              text="Operations analytics"
              color="hsl(var(--foreground))"
              shineColor="hsl(var(--primary))"
              speed={4}
            />
          </h2>
          <p className="text-xs text-muted-foreground">
            KPIs across triage quality, SLA health and AI cost efficiency.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} loading={loading}>
          {!loading && <Activity className="h-3.5 w-3.5" />} Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
          {error}
        </div>
      )}

      {/* ------------------------------------------------------ KPI cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          icon={Ticket}
          iconClass="bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300"
          label="Total tickets"
          value={s ? s.total_tickets : '—'}
          sub={s ? `${s.open_tickets} currently open` : ''}
        />
        <Kpi
          icon={ShieldAlert}
          iconClass="bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-300"
          label="SLA breach rate"
          value={s ? s.sla_breach_rate : '—'}
          suffix={s ? '%' : ''}
          sub={s ? `${s.sla_breach_count} breached of ${s.total_tickets}` : ''}
          tone={s && s.sla_breach_rate > 20 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}
        />
        <Kpi
          icon={Brain}
          iconClass="bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300"
          label="AI classification accuracy"
          value={s ? s.ai_accuracy_rate : '—'}
          suffix={s ? '%' : ''}
          sub={
            s
              ? `${s.hitl_override_count} HITL overrides · avg conf ${Math.round(
                  (s.avg_confidence || 0) * 100
                )}%`
              : ''
          }
        />
        <Kpi
          icon={PiggyBank}
          iconClass="bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-300"
          label="Cost saved via Tier-1"
          value={s ? s.cost_saved_usd : '—'}
          prefix={s ? '$' : ''}
          sub={
            s
              ? `${s.tier1_count} local vs ${s.tier2_count} cloud calls ($${s.estimated_ai_spend_usd.toFixed(2)} spend)`
              : ''
          }
        />
      </div>

      {/* --------------------------------------------------------- charts */}
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" /> Tickets by category
            </CardTitle>
            <CardDescription>Red segment inside each bar = SLA-breached tickets</CardDescription>
          </CardHeader>
          <CardContent className="h-[280px]">
            {data ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.by_category} margin={{ top: 5, right: 8, left: -18, bottom: 4 }}>
                  <XAxis
                    dataKey="category"
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    interval={0}
                    angle={-35}
                    height={60}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} allowDecimals={false} axisLine={false} tickLine={false} />
                  <Tooltip
                    cursor={{ fill: 'rgba(37,99,235,0.06)' }}
                    contentStyle={{ borderRadius: 8, fontSize: 12, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {data.by_category.map((_, i) => (
                      <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
                    ))}
                  </Bar>
                  <Bar dataKey="breached" stackId="a" fill="#dc2626" radius={[0, 0, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <Placeholder loading={loading} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>AI tier distribution</CardTitle>
            <CardDescription>Share of tickets routed by classification tier</CardDescription>
          </CardHeader>
          <CardContent className="h-[280px]">
            {data ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.by_tier.map((t) => ({ ...t, name: TIER_NAMES[t.tier] || t.tier }))}
                    dataKey="count"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={3}
                  >
                    {data.by_tier.map((t) => (
                      <Cell key={t.tier} fill={TIER_COLORS[t.tier] || '#94a3b8'} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ borderRadius: 8, fontSize: 12, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                  />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12, color: "hsl(var(--muted-foreground))" }} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <Placeholder loading={loading} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------------------------------------------------- secondary */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Tickets by severity</CardTitle>
            <CardDescription>Prioritisation mix across the queue</CardDescription>
          </CardHeader>
          <CardContent className="h-[240px]">
            {data ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.by_severity} margin={{ top: 5, right: 8, left: -18, bottom: 4 }}>
                  <XAxis dataKey="category" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} allowDecimals={false} axisLine={false} tickLine={false} />
                  <Tooltip
                    cursor={{ fill: 'rgba(37,99,235,0.06)' }}
                    contentStyle={{ borderRadius: 8, fontSize: 12, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                  />
                  <Bar dataKey="count" fill="#0891b2" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <Placeholder loading={loading} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>SLA & triage health</CardTitle>
            <CardDescription>Escalation engine activity over the last 7 days</CardDescription>
          </CardHeader>
          <CardContent>
            {s ? (
              <dl className="grid grid-cols-2 gap-3">
                <Fact label="SLA events (7d)" value={data.sla_events_last_7d} />
                <Fact label="HITL overrides" value={s.hitl_override_count} />
                <Fact label="Tier-1 routed" value={s.tier1_count} />
                <Fact label="Tier-2 routed" value={s.tier2_count} />
                <Fact label="Rule fallback" value={s.rule_fallback_count} />
                <Fact label="Avg confidence" value={`${Math.round((s.avg_confidence || 0) * 100)}%`} />
              </dl>
            ) : (
              <Placeholder loading={loading} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Kpi({ icon: Icon, iconClass, label, value, sub, prefix = '', suffix = '', tone = 'text-foreground' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          <span className={cn('flex h-8 w-8 items-center justify-center rounded-md', iconClass)}>
            <Icon className="h-4 w-4" />
          </span>
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
        </div>
        <p className={cn('mt-2 text-2xl font-bold tracking-tight tabular-nums', tone)}>
          {typeof value === 'number' ? (
            <>
              {prefix}
              <CountUp to={value} separator="," delay={0.05} duration={1.6} />
              {suffix}
            </>
          ) : (
            value
          )}
        </p>
        {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  )
}

function Fact({ label, value }) {
  return (
    <div className="rounded-lg border border-border bg-muted p-3">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-lg font-bold text-foreground tabular-nums">
        {typeof value === 'number' ? <CountUp to={value} separator="," duration={1.4} /> : value}
      </dd>
    </div>
  )
}

function Placeholder({ loading }) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      {loading ? 'Loading analytics…' : 'No data'}
    </div>
  )
}
