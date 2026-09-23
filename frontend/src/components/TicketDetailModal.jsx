import { useCallback, useEffect, useState } from 'react'
import {
  Bot,
  BrainCircuit,
  ShieldAlert,
  RefreshCw,
  Save,
  History,
  BookOpen,
  Zap,
  UserCheck,
  AlertOctagon,
} from 'lucide-react'
import api from '@/lib/api'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, Label, Textarea } from '@/components/ui/input'
import { Tabs, Tab } from '@/components/ui/tabs'
import {
  CategoryBadge,
  SeverityBadge,
  StatusBadge,
  TierBadge,
} from '@/components/ui/badge'
import { cn, CATEGORIES, SEVERITIES, TIER_LABELS, formatDT, timeLeft } from '@/lib/utils'

export default function TicketDetailModal({ ticketId, open, onClose, onChanged, agents = [] }) {
  const [ticket, setTicket] = useState(null)
  const [tab, setTab] = useState('overview')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  // HITL override state
  const [agentId, setAgentId] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [newSeverity, setNewSeverity] = useState('')
  const [note, setNote] = useState('')
  const [overrideMsg, setOverrideMsg] = useState(null)

  const load = useCallback(async () => {
    if (!ticketId) return
    try {
      setLoading(true)
      setError(null)
      const data = await api.getTicket(ticketId)
      setTicket(data)
      setNewCategory(data.category)
      setNewSeverity(data.severity)
      if (!agentId && agents.length) setAgentId(agents[0].id)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [ticketId, agentId, agents])

  useEffect(() => {
    if (open) {
      setTab('overview')
      setOverrideMsg(null)
      load()
    }
  }, [open, load])

  if (!open) return null

  const run = async (fn, successMsg) => {
    try {
      setBusy(true)
      setError(null)
      await fn()
      await load()
      onChanged?.()
      if (successMsg) setOverrideMsg({ ok: true, text: successMsg })
      return true
    } catch (err) {
      setError(err.message)
      setOverrideMsg({ ok: false, text: err.message })
      return false
    } finally {
      setBusy(false)
    }
  }

  const applyOverride = () => {
    if (!agentId) {
      setOverrideMsg({ ok: false, text: 'Select the correcting agent first.' })
      return
    }
    run(
      () =>
        api.overrideTicket(ticketId, {
          agent_id: agentId,
          category: newCategory !== ticket.category ? newCategory : null,
          severity: newSeverity !== ticket.severity ? newSeverity : null,
          note: note || null,
        }),
      'Override saved — correction written to ai_audit_logs.'
    ).then((ok) => {
      if (ok) setNote('')
    })
  }

  const sla = ticket ? timeLeft(ticket.sla_deadline, ticket.is_sla_breached) : null

  return (
    <Dialog open={open} onClose={onClose}>
      {loading && !ticket ? (
        <div className="p-10 text-center text-sm text-muted-foreground">Loading ticket…</div>
      ) : !ticket ? (
        <div className="p-10 text-center text-sm text-red-500">{error || 'Ticket unavailable'}</div>
      ) : (
        <div className="max-h-[85vh] overflow-y-auto">
          {/* Header */}
          <div className="border-b border-border bg-muted px-5 py-4 pr-12">
            <div className="flex flex-wrap items-center gap-2">
              <CategoryBadge value={ticket.category} />
              <SeverityBadge value={ticket.severity} />
              <StatusBadge value={ticket.status} />
              {ticket.is_sla_breached && (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-bold text-white">
                  <ShieldAlert className="h-3 w-3" /> SLA BREACHED
                </span>
              )}
            </div>
            <h2 className="mt-1.5 text-base font-semibold text-foreground">{ticket.title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {ticket.id} · raised by {ticket.created_by?.name || 'unknown'} ·{' '}
              {formatDT(ticket.created_at)} · SLA {formatDT(ticket.sla_deadline)} (
              <span
                className={cn(
                  'font-semibold',
                  sla?.tone === 'bad' ? 'text-red-600' : sla?.tone === 'warn' ? 'text-amber-600' : 'text-muted-foreground'
                )}
              >
                {sla?.label}
              </span>
              )
            </p>
          </div>

          {error && (
            <div className="mx-5 mt-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
              {error}
            </div>
          )}

          {/* Tabs */}
          <div className="px-5 pt-4">
            <Tabs>
              <Tab active={tab === 'overview'} onClick={() => setTab('overview')}>
                <Bot className="h-3.5 w-3.5" /> AI triage
              </Tab>
              <Tab active={tab === 'text'} onClick={() => setTab('text')}>
                Raw vs scrubbed
              </Tab>
              <Tab active={tab === 'steps'} onClick={() => setTab('steps')}>
                <BookOpen className="h-3.5 w-3.5" /> Troubleshooting
              </Tab>
              <Tab active={tab === 'override'} onClick={() => setTab('override')}>
                <Zap className="h-3.5 w-3.5" /> HITL override
              </Tab>
              <Tab active={tab === 'audit'} onClick={() => setTab('audit')}>
                <History className="h-3.5 w-3.5" /> Audit
              </Tab>
            </Tabs>
          </div>

          <div className="px-5 py-4">
            {/* ------------------------------------------------- AI triage */}
            {tab === 'overview' && (
              <div className="space-y-4 animate-fade-in">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Panel label="Confidence score">
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            ticket.confidence_score >= 0.85
                              ? 'bg-emerald-500'
                              : ticket.confidence_score >= 0.6
                                ? 'bg-amber-500'
                                : 'bg-red-500'
                          )}
                          style={{ width: `${Math.round(ticket.confidence_score * 100)}%` }}
                        />
                      </div>
                      <span className="text-sm font-bold tabular-nums">
                        {(ticket.confidence_score * 100).toFixed(0)}%
                      </span>
                    </div>
                  </Panel>
                  <Panel label="AI tier used">
                    <TierBadge value={ticket.ai_tier_used} />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {TIER_LABELS[ticket.ai_tier_used]}
                    </p>
                  </Panel>
                  <Panel label="Subcategory">
                    <span className="text-xs font-semibold text-foreground">
                      {ticket.subcategory || '—'}
                    </span>
                  </Panel>
                </div>

                <Panel label="AI reasoning">
                  <p className="text-xs text-muted-foreground">{ticket.ai_reasoning || '—'}</p>
                </Panel>
                <Panel label="Executive summary">
                  <p className="text-xs text-muted-foreground">{ticket.ai_summary || '—'}</p>
                </Panel>

                <Panel label="Knowledge base citations (hybrid RAG)">
                  {ticket.kb_citations.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No KB documents matched.</p>
                  ) : (
                    <ul className="space-y-1">
                      {ticket.kb_citations.map((kb) => (
                        <li key={kb.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                          <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
                          {kb.title}
                          <span className="text-[10px] uppercase text-muted-foreground">{kb.category}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </div>
            )}

            {/* --------------------------------------------- raw/scrubbed */}
            {tab === 'text' && (
              <div className="grid gap-3 sm:grid-cols-2 animate-fade-in">
                <Panel label="Raw description (as submitted)">
                  <pre className="whitespace-pre-wrap break-words font-sans text-xs text-foreground">
                    {ticket.raw_description}
                  </pre>
                </Panel>
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/50 p-3">
                  <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-emerald-700">
                    <ShieldAlert className="h-3.5 w-3.5" /> Scrubbed (sent to AI)
                  </p>
                  <pre className="whitespace-pre-wrap break-words font-sans text-xs text-foreground">
                    {ticket.scrubbed_description || '—'}
                  </pre>
                </div>
              </div>
            )}

            {/* -------------------------------------------------- steps */}
            {tab === 'steps' && (
              <div className="space-y-3 animate-fade-in">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    AI-generated steps for the L1 agent
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    loading={busy}
                    onClick={() => run(() => api.regenerateSteps(ticketId), 'Steps regenerated.')}
                  >
                    {!busy && <RefreshCw className="h-3.5 w-3.5" />} Re-run RAG
                  </Button>
                </div>
                <ol className="space-y-2">
                  {(ticket.troubleshooting_steps || []).map((step, i) => (
                    <li
                      key={i}
                      className="flex gap-3 rounded-lg border border-border bg-muted p-3"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white">
                        {i + 1}
                      </span>
                      <span className="text-xs text-foreground">{step}</span>
                    </li>
                  ))}
                  {!ticket.troubleshooting_steps?.length && (
                    <li className="text-xs text-muted-foreground">No steps generated yet.</li>
                  )}
                </ol>
              </div>
            )}

            {/* ------------------------------------------------- override */}
            {tab === 'override' && (
              <div className="space-y-3 animate-fade-in">
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
                  <BrainCircuit className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Human-in-the-loop: any change here overrides the AI decision and is written to{' '}
                    <code className="rounded bg-amber-100 px-1">ai_audit_logs</code> with your agent
                    id and timestamp.
                  </span>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>Correcting agent</Label>
                    <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                      <option value="">Select agent…</option>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label>Note (optional)</Label>
                    <Textarea
                      className="min-h-[60px]"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Why is the AI classification wrong?"
                    />
                  </div>
                  <div>
                    <Label>Category (AI said: {ticket.category})</Label>
                    <Select value={newCategory} onChange={(e) => setNewCategory(e.target.value)}>
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label>Severity (AI said: {ticket.severity})</Label>
                    <Select value={newSeverity} onChange={(e) => setNewSeverity(e.target.value)}>
                      {SEVERITIES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button onClick={applyOverride} loading={busy}>
                    {!busy && <Save className="h-4 w-4" />} Apply HITL override
                  </Button>
                  <Button
                    variant="outline"
                    loading={busy}
                    onClick={() => run(() => api.escalateTicket(ticketId), 'Escalation queued.')}
                  >
                    {!busy && <AlertOctagon className="h-4 w-4" />} Escalate now
                  </Button>
                </div>

                {overrideMsg && (
                  <p
                    className={cn(
                      'rounded-md p-2.5 text-xs',
                      overrideMsg.ok
                        ? 'border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300'
                        : 'border border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300'
                    )}
                  >
                    {overrideMsg.text}
                  </p>
                )}

                {/* Status / assignment controls */}
                <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
                  <div>
                    <Label>Status</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {['IN_PROGRESS', 'RESOLVED', 'CLOSED'].map((s) => (
                        <Button
                          key={s}
                          size="sm"
                          variant={ticket.status === s ? 'primary' : 'outline'}
                          loading={busy}
                          onClick={() => run(() => api.updateTicket(ticketId, { status: s }))}
                        >
                          {s.replace('_', ' ')}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Label>Assign to L1 agent</Label>
                    <Select
                      value={ticket.assigned_agent_id || ''}
                      onChange={(e) =>
                        run(() =>
                          api.updateTicket(ticketId, { assigned_agent_id: e.target.value || null })
                        )
                      }
                    >
                      <option value="">Unassigned</option>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                    {ticket.assigned_agent && (
                      <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                        <UserCheck className="h-3 w-3" /> {ticket.assigned_agent.name}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* --------------------------------------------------- audit */}
            {tab === 'audit' && (
              <div className="space-y-4 animate-fade-in">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    HITL corrections
                  </p>
                  {ticket.audit_logs?.length ? (
                    <ul className="space-y-2">
                      {ticket.audit_logs.map((log) => (
                        <li key={log.id} className="rounded-lg border border-border p-3 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <CategoryBadge value={log.original_category} />
                            <span className="text-muted-foreground">→</span>
                            {log.corrected_category && <CategoryBadge value={log.corrected_category} />}
                            <SeverityBadge value={log.original_severity} />
                            {log.corrected_severity && (
                              <>
                                <span className="text-muted-foreground">→</span>
                                <SeverityBadge value={log.corrected_severity} />
                              </>
                            )}
                            <span className="ml-auto text-[11px] text-muted-foreground">
                              {formatDT(log.timestamp)}
                            </span>
                          </div>
                          {log.note && <p className="mt-1.5 italic text-muted-foreground">“{log.note}”</p>}
                          <p className="mt-1 text-[10px] text-muted-foreground">
                            agent {String(log.corrected_by_agent_id).slice(0, 8)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No corrections — the AI classification stands as issued.
                    </p>
                  )}
                </div>

                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    SLA events
                  </p>
                  {ticket.sla_events?.length ? (
                    <ul className="space-y-1.5">
                      {ticket.sla_events.map((ev) => (
                        <li
                          key={ev.id}
                          className={cn(
                            'flex items-start gap-2 rounded-md border p-2 text-xs',
                            ev.event_type === 'BREACH'
                              ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300'
                              : 'border-border bg-muted text-muted-foreground'
                          )}
                        >
                          <span className="font-bold">{ev.event_type}</span>
                          <span className="flex-1">{ev.message}</span>
                          <span className="text-[10px] opacity-70">{formatDT(ev.timestamp)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">No SLA events recorded.</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-border bg-muted px-5 py-3">
            <p className="text-[11px] text-muted-foreground">
              Assigned: {ticket.assigned_agent?.name || 'unassigned'}
            </p>
            <Button size="sm" variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

function Panel({ label, children, className }) {
  return (
    <div className={cn('rounded-lg border border-border bg-card p-3', className)}>
      <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}
