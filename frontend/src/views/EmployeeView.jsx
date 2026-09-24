import { useState } from 'react'
import {
  ShieldCheck,
  Sparkles,
  Search,
  Timer,
  Send,
  CheckCircle2,
  AlertTriangle,
  FileText,
} from 'lucide-react'
import api from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label, Textarea } from '@/components/ui/input'
import { Badge, SeverityBadge, CategoryBadge } from '@/components/ui/badge'
import { cn, formatDT } from '@/lib/utils'
import DecryptedText from '@/components/bits/DecryptedText'
import ClickSpark from '@/components/bits/ClickSpark'

const STAGES = [
  { key: 'pii', label: 'PII scrubbing', hint: 'Regex redaction before any AI call', icon: ShieldCheck },
  { key: 'classify', label: 'Tiered AI classification', hint: 'Tier 1 → Tier 2 structured output', icon: Sparkles },
  { key: 'rag', label: 'Hybrid RAG retrieval', hint: 'pgvector cosine + BM25 fusion', icon: Search },
  { key: 'sla', label: 'SLA scheduling', hint: 'Delayed Redis/Celery escalation check', icon: Timer },
]

export default function EmployeeView() {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [email, setEmail] = useState('aarav.sharma@autotriage.dev')
  const [phase, setPhase] = useState('idle') // idle | running | done | error
  const [activeStage, setActiveStage] = useState(-1)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    setPhase('running')
    setError(null)
    setResult(null)
    setActiveStage(0)

    // Advance the visual pipeline while the API call runs
    const timers = [700, 1500, 2400, 3200].map((ms, i) => setTimeout(() => setActiveStage(i + 1), ms))

    try {
      const data = await api.createTicket({ title, raw_description: description, created_by_email: email })
      timers.forEach(clearTimeout)
      setActiveStage(STAGES.length)
      setResult(data)
      setPhase('done')
      setTitle('')
      setDescription('')
    } catch (err) {
      timers.forEach(clearTimeout)
      setError(err.message)
      setPhase('error')
    }
  }

  const running = phase === 'running'

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* ---------------------------------------------------------- Form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4 text-primary" />
            <DecryptedText
              text="Report an issue"
              animateOn="hover"
              speed={40}
              maxIterations={8}
              useOriginalCharsOnly
            />
          </CardTitle>
          <CardDescription>
            Describe the problem in plain language — sensitive data is redacted before AI processing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label htmlFor="email">Your email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
              />
            </div>

            <div>
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. VPN keeps dropping every few minutes"
                minLength={3}
                required
              />
            </div>

            <div>
              <Label htmlFor="description">Issue description</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={
                  'What happened? Tip: try pasting an SSN (123-45-6789), a card number, an IP or a password — watch them get scrubbed.'
                }
                minLength={10}
                required
              />
            </div>

            <ClickSpark className="w-full" sparkRadius={16}>
              <Button type="submit" loading={running} className="w-full" size="lg">
                {!running && <Send className="h-4 w-4" />}
                {running ? 'Ticking through the pipeline…' : 'Submit ticket'}
              </Button>
            </ClickSpark>

            {phase === 'error' && (
              <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      {/* ------------------------------------------- Pipeline indicator */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            <DecryptedText
              text="Triage pipeline"
              animateOn="hover"
              speed={40}
              maxIterations={8}
              useOriginalCharsOnly
            />
            <span
              className={cn(
                'ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                phase === 'done'
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                  : running
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 animate-pulse-soft'
                    : phase === 'error'
                      ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                      : 'bg-muted text-muted-foreground'
              )}
            >
              {phase === 'done' ? 'complete' : running ? 'running' : phase === 'error' ? 'failed' : 'idle'}
            </span>
          </CardTitle>
          <CardDescription>Real-time view of what happens between submit and classification.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2">
            {STAGES.map((stage, i) => {
              const started = running ? i <= activeStage : phase === 'done'
              const finished = phase === 'done' ? true : running ? i < activeStage : false
              const Icon = stage.icon
              return (
                <li
                  key={stage.key}
                  className={cn(
                    'flex items-start gap-3 rounded-lg border p-3 transition-all',
                    finished
                      ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/60'
                      : started
                        ? 'border-blue-200 bg-blue-50/60 dark:border-blue-900 dark:bg-blue-950/60'
                        : 'border-border bg-muted'
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                      finished
                        ? 'bg-emerald-600 text-white'
                        : started
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-200 dark:bg-gray-700 text-muted-foreground'
                    )}
                  >
                    {finished ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-foreground">{stage.label}</p>
                    <p className="text-[11px] text-muted-foreground">{stage.hint}</p>
                  </div>
                  {running && i === activeStage && (
                    <span className="ml-auto h-3 w-3 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                  )}
                </li>
              )
            })}
          </ol>

          {/* ------------------------------------------------ Result */}
          {phase === 'done' && result && (
            <div className="mt-4 space-y-3 rounded-lg border border-border bg-card p-4 animate-fade-in">
              <div className="flex flex-wrap items-center gap-2">
                <CategoryBadge value={result.pipeline.classification.category} />
                <SeverityBadge value={result.pipeline.classification.severity} />
                <Badge className="bg-emerald-100 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900">
                  {Math.round(result.pipeline.classification.confidence * 100)}% confidence
                </Badge>
                <Badge className="bg-blue-100 text-blue-700 ring-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-900">
                  {result.pipeline.classification.tier.replace(/_/g, ' ')}
                </Badge>
              </div>

              <p className="text-xs text-muted-foreground">{result.ticket.ai_summary}</p>

              <div className="rounded-md bg-muted p-3 text-[11px] text-muted-foreground">
                <p className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">
                  PII scrub report
                </p>
                {result.pipeline.pii.redaction_count > 0 ? (
                  <p>
                    🔒 {result.pipeline.pii.redaction_count} sensitive item
                    {result.pipeline.pii.redaction_count > 1 ? 's' : ''} replaced with{' '}
                    <code className="rounded bg-gray-200 dark:bg-gray-700 px-1">{result.pipeline.pii.token}</code>:{' '}
                    {Object.entries(result.pipeline.pii.redactions)
                      .map(([k, v]) => `${k}×${v}`)
                      .join(', ')}
                  </p>
                ) : (
                  <p>No PII patterns detected in the description.</p>
                )}
              </div>

              <div>
                <p className="mb-1.5 font-semibold uppercase tracking-wide text-muted-foreground text-[11px]">
                  AI troubleshooting steps for the L1 agent
                </p>
                <ol className="space-y-1.5">
                  {result.pipeline.rag.steps.map((step, i) => (
                    <li key={i} className="flex gap-2 text-xs text-foreground">
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-white">
                        {i + 1}
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-[11px] text-muted-foreground">
                <span>
                  Ticket <code className="font-mono">{result.ticket.id.slice(0, 8)}</code> created
                </span>
                <span>
                  SLA deadline: <strong>{formatDT(result.pipeline.sla.deadline)}</strong>
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
