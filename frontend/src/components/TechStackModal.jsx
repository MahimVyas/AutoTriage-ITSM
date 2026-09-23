import { useState } from 'react'
import { Layers, Info, MousePointerClick } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/* =========================================================================
 * Flow diagram model
 * -------------------------------------------------------------------------
 * Coordinates live in a 1000×520 SVG viewBox so the diagram scales to any
 * width. Each node carries its own hover content; each edge carries a path,
 * a colour, an optional label and a packet animation offset.
 * ====================================================================== */

const MAIN = '#3b82f6'   // happy path
const AI = '#8b5cf6'     // cloud AI branch
const SLA = '#ef4444'    // escalation path
const DATA = '#0891b6'   // storage / retrieval

const NODES = [
  {
    id: 'submit', x: 25, y: 140, w: 150, h: 64, color: MAIN,
    title: ['Employee', 'Submission'],
    layer: 'Frontend · React + Vite',
    tech: 'React 18 · Vite · Tailwind CSS · Lucide icons · shadcn-style UI',
    details:
      'The employee describes the incident in plain language. The form posts to POST /api/tickets; a live pipeline indicator animates the four stages while the request is in flight.',
  },
  {
    id: 'pii', x: 215, y: 140, w: 150, h: 64, color: MAIN,
    title: ['PII Scrubber'],
    layer: 'Backend middleware · FastAPI',
    tech: 'Regex engine (SSN · credit card · email · IPv4 · password · API key · phone)',
    details:
      'Pipeline 1. Every description is sanitised BEFORE any LLM, embedding API or vector store sees it. Matches are replaced with [REDACTED_SENSITIVE_DATA] and the redaction report is returned to the UI.',
  },
  {
    id: 'tier1', x: 405, y: 140, w: 165, h: 64, color: MAIN,
    title: ['Tier-1 Classifier'],
    layer: 'AI · local (no network, ~0 ms)',
    tech: 'Keyword/heuristic "local SLM" rules → Pydantic TicketClassificationResponse',
    details:
      'Pipeline 2, tier 1. Instant, free classification returning category, subcategory, severity and a confidence score in [0,1]. High-confidence results short-circuit the cloud call.',
  },
  {
    id: 'tier2', x: 405, y: 25, w: 200, h: 64, color: AI,
    title: ['Tier-2 Cloud LLM'],
    layer: 'AI · cloud (conditional)',
    tech: 'OpenAI gpt-4o-mini or Gemini 1.5 Flash · structured JSON output',
    details:
      'Routed only when Tier-1 confidence < 0.85 OR the category is high-risk (SECURITY). The model must return strict JSON validated by Pydantic; a deterministic rule fallback keeps the app alive without API keys.',
  },
  {
    id: 'rag', x: 630, y: 140, w: 170, h: 64, color: DATA,
    title: ['Hybrid RAG Engine'],
    layer: 'AI retrieval · hybrid',
    tech: 'pgvector cosine distance + rank_bm25 lexical search, fused with Reciprocal Rank Fusion',
    details:
      'Pipeline 3. The scrubbed ticket is embedded (1536-d), searched by vector similarity and BM25, fused with RRF, then the top-k runbook chunks are prompted for exactly 3 concise L1 steps.',
  },
  {
    id: 'store', x: 845, y: 140, w: 130, h: 64, color: DATA,
    title: ['Ticket +', 'pgvector store'],
    layer: 'Data · PostgreSQL 16',
    tech: 'users · tickets · kb_documents (vector 1536) · ai_audit_logs · sla_events',
    details:
      'The ticket, its AI context, RAG citations (ticket_kb_documents) and the SLA deadline are persisted. pgvector powers the cosine index over the knowledge base.',
  },
  {
    id: 'sched', x: 640, y: 380, w: 175, h: 64, color: SLA,
    title: ['SLA Scheduler', '(Redis + Celery)'],
    layer: 'Async queue · Redis 7',
    tech: 'Celery apply_async(countdown) · beat sweeper every 30 s',
    details:
      'Pipeline 4. On creation a delayed task is queued with countdown = severity budget (P1 15m · P2 1h · P3 4h · P4 24h). Redis holds the message until the timer expires.',
  },
  {
    id: 'worker', x: 405, y: 380, w: 190, h: 64, color: SLA,
    title: ['Escalation Worker'],
    layer: 'Background worker',
    tech: 'Celery worker · sync SQLAlchemy session',
    details:
      'When the timer fires it reloads the ticket; if it is still OPEN it sets is_sla_breached, bumps severity to P1_CRITICAL, flips status to ESCALATED and writes an sla_events row.',
  },
  {
    id: 'agent', x: 200, y: 380, w: 165, h: 64, color: MAIN,
    title: ['Agent Dashboard', '(HITL override)'],
    layer: 'Frontend · support agent role',
    tech: 'Filterable queue · ticket modal · one-click override',
    details:
      'The L1 agent inspects AI confidence, tier, raw vs scrubbed text and the RAG steps — then can override category/severity in one click. Overrides reschedule the SLA window.',
  },
  {
    id: 'audit', x: 25, y: 380, w: 150, h: 64, color: AI,
    title: ['Audit Log +', 'Admin Analytics'],
    layer: 'Governance + reporting',
    tech: 'ai_audit_logs table · KPI cards · Recharts bar/pie charts',
    details:
      'Every human correction is stamped with agent id and timestamp. The admin dashboard reports breach rate, AI accuracy, Tier-1 vs Tier-2 distribution and cost saved via local routing.',
  },
]

const EDGES = [
  { id: 'e1', d: 'M175,172 H207', color: MAIN, begin: 0 },
  { id: 'e2', d: 'M365,172 H397', color: MAIN, begin: 0.3 },
  {
    id: 'e3', d: 'M570,172 H622', color: MAIN, begin: 0.6,
    label: { text: 'conf ≥ 0.85 → accept', x: 596, y: 164 },
  },
  {
    id: 'e4', d: 'M487,140 V97', color: AI, begin: 0.9,
    label: { text: 'conf < 0.85 or SECURITY', x: 495, y: 124 },
  },
  {
    id: 'e5', d: 'M605,57 H678 Q715,57 715,94 V132', color: AI, begin: 1.2,
    label: { text: 'structured JSON', x: 612, y: 47 },
  },
  {
    id: 'e6', d: 'M800,172 H837', color: DATA, begin: 1.5,
    label: { text: 'embed + persist', x: 819, y: 164 },
  },
  {
    id: 'e7', d: 'M910,204 V300 H727 V372', color: SLA, begin: 1.8,
    label: { text: 'delayed task (countdown)', x: 772, y: 292 },
  },
  {
    id: 'e8', d: 'M640,412 H603', color: SLA, begin: 2.1,
    label: { text: 'timer fires', x: 621, y: 404 },
  },
  {
    id: 'e9', d: 'M405,412 H373', color: SLA, begin: 2.4,
    label: { text: 'breach → P1', x: 389, y: 404 },
  },
  {
    id: 'e10', d: 'M200,412 H183', color: MAIN, begin: 2.7,
    label: { text: 'override → ai_audit_logs', x: 130, y: 466 },
  },
]

/* ------------------------------ tech stack ------------------------------ */
const STACK = [
  {
    group: 'Frontend',
    items: [
      ['React 18 + Vite', 'Fast DX, HMR dev server, proxy of /api to FastAPI'],
      ['Tailwind CSS', 'Token-based theming with CSS variables for light & dark mode'],
      ['Lucide + shadcn-style UI', 'Hand-rolled button/badge/card/tabs/dialog primitives'],
      ['Recharts', 'Bar chart (category), pie (AI tier), bar (severity)'],
    ],
  },
  {
    group: 'Backend API',
    items: [
      ['FastAPI (Python 3.11+)', 'Async routes, OpenAPI docs at /docs, CORS for the SPA'],
      ['Pydantic v2', 'Strict structured outputs + request/response validation'],
      ['SQLAlchemy 2 async + Alembic', 'Async sessions, versioned migrations, UUID PKs'],
      ['Uvicorn', 'ASGI server running the API on :8000'],
    ],
  },
  {
    group: 'AI / ML',
    items: [
      ['Tiered classification', 'Tier-1 local rules → Tier-2 gpt-4o-mini / Gemini 1.5 Flash'],
      ['Structured JSON outputs', 'Model output validated by TicketClassificationResponse'],
      ['pgvector', '1536-d embeddings, cosine distance similarity search'],
      ['rank_bm25 + RRF', 'Lexical search fused with vector ranking for retrieval'],
      ['Deterministic fallbacks', 'Offline embedder + rule classifier so demos never break'],
    ],
  },
  {
    group: 'Data & Queue',
    items: [
      ['PostgreSQL 16 + pgvector', 'users · tickets · kb_documents · ai_audit_logs · sla_events'],
      ['Redis 7', 'Celery broker/result backend holding delayed SLA messages'],
      ['Celery worker + beat', 'SLA expiry tasks + 30 s safety-net sweeper'],
      ['Docker Compose', 'One-command stack with healthchecks and volume seeding'],
    ],
  },
]

/* ================================ view ================================== */

function FlowDiagram({ activeId, onHover }) {
  return (
    <svg
      viewBox="0 0 1000 500"
      className="w-full"
      role="img"
      aria-label="AutoTriage-ITSM request flow diagram"
    >
      <defs>
        {['main', 'ai', 'sla', 'data'].map((k) => (
          <marker
            key={k}
            id={`arrow-${k}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path
              d="M0,0 L10,5 L0,10 z"
              fill={{ main: MAIN, ai: AI, sla: SLA, data: DATA }[k]}
            />
          </marker>
        ))}
      </defs>

      {/* stage labels */}
      <text x="25" y="16" className="fill-muted-foreground" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>
        INGESTION &amp; AI TRIAGE
      </text>
      <text x="25" y="372" className="fill-muted-foreground" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>
        SLA, ESCALATION &amp; HUMAN OVERSIGHT
      </text>

      {/* edges: glow + dashes + travelling packet */}
      {EDGES.map((e) => (
        <g key={e.id}>
          <path d={e.d} fill="none" stroke={e.color} strokeOpacity="0.18" strokeWidth="7" strokeLinecap="round" />
          <path
            id={e.id}
            d={e.d}
            fill="none"
            stroke={e.color}
            strokeWidth="2.2"
            strokeLinecap="round"
            markerEnd={`url(#arrow-${e.color === MAIN ? 'main' : e.color === AI ? 'ai' : e.color === SLA ? 'sla' : 'data'})`}
            className="flow-edge"
          />
          <circle r="4" fill={e.color} className="flow-packet">
            <animateMotion dur="2.2s" repeatCount="indefinite" begin={`${e.begin}s`} path={e.d} rotate="auto" />
          </circle>
        </g>
      ))}

      {/* nodes */}
      {NODES.map((n) => {
        const active = activeId === n.id
        return (
          <g
            key={n.id}
            transform={`translate(${n.x}, ${n.y})`}
            onMouseEnter={() => onHover(n.id)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(n.id)}
            onBlur={() => onHover(null)}
            tabIndex={0}
            style={{ cursor: 'pointer', outline: 'none' }}
            className="transition-all"
          >
            {active && (
              <rect x={-4} y={-4} width={n.w + 8} height={n.h + 8} rx="14" fill={n.color} opacity="0.18" />
            )}
            <rect
              width={n.w}
              height={n.h}
              rx="10"
              className="fill-card"
              stroke={n.color}
              strokeWidth={active ? 2.6 : 1.6}
              style={{ filter: active ? `drop-shadow(0 3px 8px ${n.color}55)` : 'none' }}
            />
            <rect width="6" height={n.h} rx="3" fill={n.color} />
            {n.title.map((line, i) => (
              <text
                key={line}
                x={n.w / 2 + 3}
                y={n.h / 2 + (i === 0 ? (n.title.length > 1 ? -4 : 4) : 14)}
                textAnchor="middle"
                style={{ fontSize: 12, fontWeight: 650 }}
                className="fill-foreground"
              >
                {line}
              </text>
            ))}
          </g>
        )
      })}

      {/* edge labels — drawn last with a card-coloured halo so they stay
          readable where they cross node borders */}
      {EDGES.filter((e) => e.label).map((e) => (
        <text
          key={`label-${e.id}`}
          x={e.label.x}
          y={e.label.y}
          textAnchor="middle"
          style={{ fontSize: 10.5, fontWeight: 600, paintOrder: 'stroke' }}
          className="fill-muted-foreground"
          stroke="hsl(var(--card))"
          strokeWidth="3.5"
        >
          {e.label.text}
        </text>
      ))}
    </svg>
  )
}

export default function TechStackModal({ open, onClose }) {
  const [activeId, setActiveId] = useState(null)
  const active = NODES.find((n) => n.id === activeId)

  return (
    <Dialog open={open} onClose={onClose} className="max-w-5xl">
      <div className="max-h-[88vh] overflow-y-auto">
        {/* header */}
        <div className="border-b border-border bg-muted/60 px-5 py-4 pr-12">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Layers className="h-4 w-4 text-primary" /> AutoTriage-ITSM — Architecture &amp; Tech Stack
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Request flow from submission to escalation, with the technology behind every block.
          </p>
        </div>

        {/* ---------------------------------------------------- flow diagram */}
        <div className="px-5 pt-4">
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                Live request flow
              </p>
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <MousePointerClick className="h-3.5 w-3.5" /> hover a block for details
              </p>
            </div>

            <FlowDiagram activeId={activeId} onHover={setActiveId} />

            {/* legend */}
            <div className="mt-1 flex flex-wrap gap-3 text-[10.5px] font-medium text-muted-foreground">
              {[
                ['Main flow', MAIN],
                ['AI branch', AI],
                ['SLA / escalation', SLA],
                ['Data & retrieval', DATA],
              ].map(([label, color]) => (
                <span key={label} className="flex items-center gap-1.5">
                  <span className="h-2 w-4 rounded-full" style={{ background: color }} />
                  {label}
                </span>
              ))}
            </div>
          </div>

          {/* ------------------------------------------------ hover details */}
          <div className="mt-3 min-h-[92px] rounded-lg border border-border bg-muted/50 p-3">
            {active ? (
              <div className="animate-fade-in" key={active.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: active.color }}
                  />
                  <p className="text-sm font-semibold text-foreground">
                    {active.title.join(' ')}
                  </p>
                  <span className="rounded-full bg-card px-2 py-0.5 text-[10px] font-semibold text-muted-foreground ring-1 ring-border">
                    {active.layer}
                  </span>
                </div>
                <p className="mt-1 text-xs font-medium text-foreground/90">{active.tech}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{active.details}</p>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Info className="h-4 w-4" />
                Hover any block in the diagram to see what it does, the technology behind it, and how
                data moves to the next stage.
              </p>
            )}
          </div>
        </div>

        {/* ------------------------------------------------------ tech stack */}
        <div className="px-5 py-4">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
            Tech stack detail
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {STACK.map((section) => (
              <div key={section.group} className="rounded-lg border border-border bg-card p-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  {section.group}
                </p>
                <ul className="space-y-2">
                  {section.items.map(([name, desc]) => (
                    <li key={name}>
                      <p className="text-xs font-semibold text-foreground">{name}</p>
                      <p className="text-[11px] leading-snug text-muted-foreground">{desc}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* footer */}
        <div className="flex items-center justify-between border-t border-border bg-muted/60 px-5 py-3">
          <p className="text-[11px] text-muted-foreground">
            PII → Tiered AI → Hybrid RAG → Redis SLA → HITL audit
          </p>
          <Button size="sm" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
