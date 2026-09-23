/**
 * In-browser demo backend for the static GitHub Pages build (VITE_DEMO=true).
 *
 * Mirrors backend/src/api/endpoints.py exactly — same routes, same payload
 * shapes, same pipeline behaviour — but entirely in memory so the deployed
 * SPA works without a server:
 *
 *   Pipeline 1  regex PII scrub  → [REDACTED_SENSITIVE_DATA]
 *   Pipeline 2  keyword "Tier-1" classify → Tier-2 escalation rule (< 0.85 or SECURITY)
 *   Pipeline 3  category runbook → 3 L1 steps + KB citations
 *   Pipeline 4  SLA windows (P1 15m … P4 24h) + breach/escalation events
 */

const TOKEN = '[REDACTED_SENSITIVE_DATA]'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const lat = (min = 140, span = 220) => sleep(min + Math.random() * span)
const uuid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      })
const round2 = (n) => Math.round(n * 100) / 100
const iso = (d) => new Date(d).toISOString()

// --------------------------------------------------------------------- #
// Pipeline 1 — PII scrubbing (same patterns/order as pii_scrubber.py)
// --------------------------------------------------------------------- #
const PII_PATTERNS = [
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/gi],
  ['credit_card', /\b(?:\d{4}[ -]?){3}\d{4}\b/gi],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi],
  ['ipv4', /\b(?:\d{1,3}\.){3}\d{1,3}\b/gi],
  ['password', /(?:password|passwd|pwd)\s*[=:]\s*[^\s,;]+/gi],
  ['api_key', /\b(?:api[_ -]?key|secret|access[_ -]?token|bearer)\s*[=:]\s*[^\s,;]+/gi],
  ['phone', /\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/gi],
  ['bank_account', /\b\d{9,17}\b/gi],
]

function scrub(text) {
  let current = text || ''
  const detected = {}
  for (const [name, re] of PII_PATTERNS) {
    const hits = (current.match(re) || []).length
    if (hits) {
      current = current.replace(re, TOKEN)
      detected[name] = (detected[name] || 0) + hits
    }
  }
  return { text: current, detected }
}

// --------------------------------------------------------------------- #
// Pipeline 2 — tiered classification
// --------------------------------------------------------------------- #
const KEYWORDS = {
  SECURITY: ['phish', 'malware', 'breach', 'suspicious', 'ransomware', 'compromised', 'virus', 'attack'],
  NETWORK: ['vpn', 'wifi', 'wi-fi', 'dns', 'connection', 'network', 'latency', 'internet', 'ping', 'ip ', 'gateway', 'resolve', 'offline'],
  IAM_ACCESS: ['password', 'login', 'log in', 'mfa', 'sso', 'lockout', 'locked', 'access denied', 'account', 'reset', 'shared drive', 'permission', 'sign in'],
  HARDWARE: ['laptop', 'printer', 'monitor', 'keyboard', 'mouse', 'battery', 'power', 'blue screen', 'dock', 'charger', 'flicker', 'led'],
  SOFTWARE: ['outlook', 'crash', 'install', 'update', 'application', 'app ', 'freeze', 'attachment', 'software', 'error'],
}

const SUBCATEGORY = {
  SECURITY: 'Incident response',
  NETWORK: 'Connectivity',
  IAM_ACCESS: 'Access management',
  HARDWARE: 'Device fault',
  SOFTWARE: 'Application fault',
  UNASSIGNED: '',
}

const P1_PHRASES = ['phish', 'malware', 'breach', 'ransomware', 'compromised', 'suspicious process']
const P2_PHRASES = ['cannot', "can't", 'unable', 'keeps dropping', 'not working', 'crash', 'blue screen', 'locked out', 'unusable', 'offline', 'denied']
const P4_PHRASES = ['request:', 'please install', 'install the', 'for the quarterly']

function tier1Classify(text) {
  const t = ` ${text.toLowerCase()} `
  const scored = Object.entries(KEYWORDS)
    .map(([cat, words]) => {
      const matched = words.filter((w) => t.includes(w))
      return [cat, matched.length, matched[0]]
    })
    .sort((a, b) => b[1] - a[1])
  const [top, hits, word] = scored[0]
  if (!hits) return null
  const margin = hits - scored[1][1]
  const confidence = Math.min(0.97, 0.55 + hits * 0.12 + Math.max(0, margin) * 0.05)

  let severity = 'P3_MEDIUM'
  if (P1_PHRASES.some((p) => t.includes(p))) severity = 'P1_CRITICAL'
  else if (P2_PHRASES.some((p) => t.includes(p))) severity = 'P2_HIGH'
  else if (P4_PHRASES.some((p) => t.includes(p))) severity = 'P4_LOW'

  return { category: top, severity, confidence: round2(confidence), keyword: word }
}

function classify(scrubbedText, title) {
  const t1 = tier1Classify(`${title}\n${scrubbedText}`)
  if (!t1) {
    return {
      category: 'UNASSIGNED',
      subcategory: '',
      severity: 'P3_MEDIUM',
      confidence: 0.45,
      tier: 'RULE_FALLBACK',
      reasoning: 'No keyword/SLM signal cleared the scoring bar — deterministic rule fallback used.',
      summary: 'Unclassified request parked for human triage as UNASSIGNED (P3).',
      escalated: false,
    }
  }
  const escalated = t1.confidence < 0.85 || t1.category === 'SECURITY'
  const confidence = escalated ? Math.max(t1.confidence, 0.9) : t1.confidence
  return {
    category: t1.category,
    subcategory: SUBCATEGORY[t1.category],
    severity: t1.severity,
    confidence,
    tier: escalated ? 'TIER2_CLOUD_LLM' : 'TIER1_LOCAL_SLM',
    reasoning: escalated
      ? `Tier-1 scored ${t1.confidence.toFixed(2)}${t1.category === 'SECURITY' ? ' on a high-risk SECURITY category' : ' (< 0.85 threshold)'} → escalated to Tier-2 structured output, which returned ${confidence.toFixed(2)} confidence.`
      : `Tier-1 keyword/SLM signals cleared the 0.85 threshold locally (strongest: "${t1.keyword}") — no cloud call needed.`,
    summary: `Classified as ${t1.category} (${t1.severity}) with ${Math.round(confidence * 100)}% confidence via ${escalated ? 'Tier-2' : 'Tier-1 local'} routing.`,
    escalated,
    keyword: t1.keyword,
  }
}

// --------------------------------------------------------------------- #
// Pipeline 3 — hybrid RAG (extractive runbook steps)
// --------------------------------------------------------------------- #
const KB = [
  ['Laptop Won\'t Power On — Hardware Triage Runbook', 'HARDWARE'],
  ['VPN Connectivity Failure — Network Runbook', 'NETWORK'],
  ['Password Reset & Account Lockout — IAM Runbook', 'IAM_ACCESS'],
  ['Suspicious Phishing Report — Security Incident Runbook', 'SECURITY'],
  ['Slow Application & Crash — Software Runbook', 'SOFTWARE'],
  ['Printer Offline & Jam Recovery — Hardware Runbook', 'HARDWARE'],
  ['DNS Resolution Failures — Network Runbook', 'NETWORK'],
]

const STEPS = {
  HARDWARE: [
    "Confirm the reported symptom against the 'Laptop Won't Power On — Hardware Triage Runbook'.",
    'Collect asset tag, status-LED pattern and a photo of the indicator from the requester.',
    'Apply the runbook fix; escalate to Field Services with diagnostics if unresolved.',
  ],
  NETWORK: [
    "Work the 'VPN Connectivity Failure — Network Runbook': verify basic connectivity, then ping the gateway.",
    'Flush DNS, renew the DHCP lease and check the client log bundle for handshake errors.',
    'If the tunnel/convergence still fails, escalate to Network Ops with logs attached.',
  ],
  IAM_ACCESS: [
    "Follow the 'Password Reset & Account Lockout — IAM Runbook': verify identity before any reset.",
    'Check the IdP console for lockouts, then trigger self-service reset and confirm MFA delivery.',
    'If lockouts recur, review sign-in logs for impossible-travel or token-replay patterns.',
  ],
  SECURITY: [
    "Open the 'Suspicious Phishing Report — Security Incident Runbook' as a P1 incident.",
    'Isolate the mailbox, revoke sessions/refresh tokens and capture full message headers.',
    'Reset credentials for any clicking user, purge sibling messages, notify the on-call engineer.',
  ],
  SOFTWARE: [
    "Work the 'Slow Application & Crash — Software Runbook': collect event logs and crash dumps.",
    'Clear the cache directory and restart the service to rule out stale state.',
    'If reproducible, file a vendor ticket with the dump and escalate to the application owner.',
  ],
  UNASSIGNED: [
    'Confirm the reported symptom and gather environment details from the requester.',
    'Search the knowledge base for a matching runbook and apply the documented fix.',
    'Escalate with diagnostics attached if the issue remains unresolved.',
  ],
}

function ragFor(category, title) {
  const docs = KB.filter(([, c]) => c === category)
  const steps = STEPS[category] || STEPS.UNASSIGNED
  return {
    steps,
    citations: docs.map(([t, c], i) => ({ id: uuid(), title: t, category: c, score: round2(0.74 - i * 0.07) })),
  }
}

// --------------------------------------------------------------------- #
// SLA windows (config.py)
// --------------------------------------------------------------------- #
const SLA_SECONDS = { P1_CRITICAL: 900, P2_HIGH: 3600, P3_MEDIUM: 14400, P4_LOW: 86400 }
const slaDeadline = (severity, from = Date.now()) => new Date(from + SLA_SECONDS[severity] * 1000)

// --------------------------------------------------------------------- #
// Reference data (mirrors seed.py)
// --------------------------------------------------------------------- #
const USERS = [
  ['Avery Chen', 'avery.chen@autotriage.dev', 'EMPLOYEE'],
  ['Priya Nair', 'priya.nair@autotriage.dev', 'EMPLOYEE'],
  ['Marcus Webb', 'marcus.webb@autotriage.dev', 'EMPLOYEE'],
  ['Dana Okafor', 'dana.okafor@autotriage.dev', 'AGENT'],
  ['Leo Martins', 'leo.martins@autotriage.dev', 'AGENT'],
  ['Sofia Reyes', 'sofia.reyes@autotriage.dev', 'AGENT'],
  ['Jordan Blake', 'jordan.blake@autotriage.dev', 'ADMIN'],
].map(([name, email, role]) => ({ id: uuid(), name, email, role }))

const userByEmail = (email) => USERS.find((u) => u.email === email)
const AGENTS = USERS.filter((u) => u.role === 'AGENT' || u.role === 'ADMIN')

const SEED_TICKETS = [
  {
    title: 'Laptop will not power on',
    raw: 'My ThinkPad stopped turning on this morning. The charging LED blinks amber and holding the power button does nothing.',
    category: 'HARDWARE', subcategory: 'Power fault', severity: 'P2_HIGH',
    tier: 'TIER1_LOCAL_SLM', confidence: 0.93, status: 'CLOSED', ageHours: 26,
    reasoning: 'Tier-1 hardware signals ("power", "LED", "blinking amber") cleared the 0.85 threshold locally.',
    summary: 'Device power fault classified as HARDWARE (P2) with 93% confidence via Tier-1 local routing.',
  },
  {
    title: 'VPN keeps dropping every few minutes',
    raw: 'Remote VPN connection drops after 2-3 minutes. Flushing dns did not help. IP 10.4.19.22 keeps timing out.',
    category: 'NETWORK', subcategory: 'VPN tunnel', severity: 'P2_HIGH',
    tier: 'TIER2_CLOUD_LLM', confidence: 0.91, status: 'RESOLVED', ageHours: 30,
    reasoning: 'Tier-1 scored the disconnect symptom as SOFTWARE at 0.78 (< 0.85) → escalated to Tier-2; a human agent later corrected the category to NETWORK.',
    summary: 'Intermittent remote-access failure triaged as NETWORK (P2), HITL-corrected after initial misroute.',
    override: {
      categoryFrom: 'SOFTWARE', note: 'Category corrected — actual root cause was network-side, not software.',
      agent: 'dana.okafor@autotriage.dev', agoHours: 29,
    },
  },
  {
    title: 'Password reset for payroll portal',
    raw: 'User priya.nair@autotriage.dev needs a password reset, she is locked out after too many attempts. Her SSN on file is 123-45-6789 for HR verification.',
    category: 'IAM_ACCESS', subcategory: 'Account lockout', severity: 'P3_MEDIUM',
    tier: 'TIER1_LOCAL_SLM', confidence: 0.95, status: 'CLOSED', ageHours: 20,
    reasoning: 'Tier-1 IAM signals ("password", "locked out", "reset") cleared the threshold locally; PII was redacted before scoring.',
    summary: 'Credential reset with lockout recovery handled as IAM_ACCESS (P3) — 2 PII items redacted pre-AI.',
  },
  {
    title: 'Suspicious phishing email received',
    raw: 'Finance received an invoice email asking us to log in at a fake portal. Two users clicked the link. Credit card 4111 1111 1111 1111 was in the attached form.',
    category: 'SECURITY', subcategory: 'Incident response', severity: 'P1_CRITICAL',
    tier: 'TIER2_CLOUD_LLM', confidence: 0.97, status: 'IN_PROGRESS', ageHours: 4,
    reasoning: 'SECURITY is a high-risk category — always routed to Tier-2 structured output regardless of Tier-1 confidence.',
    summary: 'Active phishing incident with credential exposure triaged as SECURITY (P1) via Tier-2.',
  },
  {
    title: 'Outlook crashes when opening attachments',
    raw: 'Outlook closes instantly when I open any PDF attachment. Happens every time since the last update.',
    category: 'SOFTWARE', subcategory: 'Application crash', severity: 'P2_HIGH',
    tier: 'TIER1_LOCAL_SLM', confidence: 0.88, status: 'RESOLVED', ageHours: 50,
    reasoning: 'Tier-1 software signals ("Outlook", "crash", "attachment") cleared the threshold locally.',
    summary: 'Client application crash on attachments classified as SOFTWARE; severity raised after user-impact review.',
    override: {
      severityFrom: 'P4_LOW', note: 'Severity raised: multiple users affected, not a single-user issue.',
      agent: 'leo.martins@autotriage.dev', agoHours: 49,
    },
  },
  {
    title: 'Shared printer shows offline',
    raw: 'The 3rd floor HP printer is showing offline for everyone. There is a paper jam warning on the display.',
    category: 'HARDWARE', subcategory: 'Printer fault', severity: 'P4_LOW',
    tier: 'TIER1_LOCAL_SLM', confidence: 0.9, status: 'CLOSED', ageHours: 54,
    reasoning: 'Tier-1 hardware signals ("printer", "paper jam", "offline") cleared the threshold locally.',
    summary: 'Shared peripheral outage classified as HARDWARE (P4) with 90% confidence via Tier-1.',
  },
  {
    title: 'Wi-Fi extremely slow in building B',
    raw: 'Wifi in building B is unusable, speedtest shows 1 Mbps down and latency over 300 ms.',
    category: 'NETWORK', subcategory: 'Wireless degradation', severity: 'P1_CRITICAL',
    tier: 'TIER2_CLOUD_LLM', confidence: 0.9, status: 'ESCALATED', ageHours: 8, forceBreach: true,
    reasoning: 'Tier-1 scored 0.79 (< 0.85) → Tier-2 confirmed the wireless outage; SLA breached and severity raised to P1 on human review.',
    summary: 'Building-wide wireless outage escalated to P1 after breaching its SLA window.',
    override: {
      severityFrom: 'P2_HIGH', note: 'Severity raised: multiple users affected, not a single-user issue.',
      agent: 'leo.martins@autotriage.dev', agoHours: 7,
    },
  },
  {
    title: 'Cannot access shared drive',
    raw: 'Access denied when mapping the finance shared drive. I am in the correct AD group as far as I know.',
    category: 'IAM_ACCESS', subcategory: 'Authorization', severity: 'P3_MEDIUM',
    tier: 'TIER1_LOCAL_SLM', confidence: 0.86, status: 'OPEN', ageHours: 6,
    reasoning: 'Tier-1 IAM signals ("access denied", "shared drive", "AD group") cleared the threshold locally.',
    summary: 'Authorization failure on a shared resource classified as IAM_ACCESS (P3).',
  },
  {
    title: 'MFA push not arriving',
    raw: 'The MFA push notification never arrives on my phone so I cannot log in to SSO at all.',
    category: 'IAM_ACCESS', subcategory: 'MFA delivery', severity: 'P3_MEDIUM',
    tier: 'TIER2_CLOUD_LLM', confidence: 0.92, status: 'OPEN', ageHours: 2,
    reasoning: 'Tier-1 mapped the phone-delivery failure to HARDWARE at 0.81 (< 0.85) → Tier-2 escalated; a human agent corrected it to IAM_ACCESS.',
    summary: 'SSO blocker triaged as IAM_ACCESS (P3) after a HITL correction from an initial hardware misread.',
    override: {
      categoryFrom: 'HARDWARE', note: 'Misclassified as hardware; this is an IAM access request.',
      agent: 'sofia.reyes@autotriage.dev', agoHours: 1.5,
    },
  },
  {
    title: 'Suspected malware on workstation',
    raw: 'Windows Defender keeps flagging a suspicious process named updsvc.exe restarting after reboot. Possible breach?',
    category: 'SECURITY', subcategory: 'Endpoint compromise', severity: 'P1_CRITICAL',
    tier: 'TIER2_CLOUD_LLM', confidence: 0.96, status: 'ESCALATED', ageHours: 1, forceBreach: true,
    reasoning: 'SECURITY is a high-risk category — routed to Tier-2, which confirmed a probable endpoint compromise.',
    summary: 'Potential endpoint compromise triaged as SECURITY (P1) and escalated pending containment.',
  },
  {
    title: 'Monitor flickers intermittently',
    raw: 'The external monitor flickers every few minutes on the USB-C dock.',
    category: 'HARDWARE', subcategory: 'Display fault', severity: 'P4_LOW',
    tier: 'RULE_FALLBACK', confidence: 0.55, status: 'CLOSED', ageHours: 72,
    reasoning: 'Weak signal spread across categories — deterministic rule fallback parked it as a low-priority device fault.',
    summary: 'Ambiguous display symptom classified by rule fallback as HARDWARE (P4).',
  },
  {
    title: 'Request: install statistical software',
    raw: 'Please install the approved statistics package on my workstation for the quarterly analysis work.',
    category: 'SOFTWARE', subcategory: 'Software request', severity: 'P4_LOW',
    tier: 'TIER1_LOCAL_SLM', confidence: 0.91, status: 'CLOSED', ageHours: 96,
    reasoning: 'Tier-1 software signals ("install", "package", "workstation") cleared the threshold locally.',
    summary: 'Standard software fulfilment request classified as SOFTWARE (P4).',
  },
  {
    title: 'DNS not resolving internal sites',
    raw: 'Internal sites fail to resolve but external ones work. nslookup times out against 10.0.0.53.',
    category: 'NETWORK', subcategory: 'DNS', severity: 'P3_MEDIUM',
    tier: 'TIER1_LOCAL_SLM', confidence: 0.89, status: 'OPEN', ageHours: 3,
    reasoning: 'Tier-1 network signals ("DNS", "resolve", "nslookup") cleared the threshold locally.',
    summary: 'Internal resolver failure classified as NETWORK (P3) — currently at risk against its SLA.',
  },
  {
    title: 'Blue screen after driver update',
    raw: 'Laptop shows a blue screen on boot after yesterday\'s driver update, stop code CRITICAL_PROCESS_DIED.',
    category: 'HARDWARE', subcategory: 'Boot failure', severity: 'P2_HIGH',
    tier: 'TIER2_CLOUD_LLM', confidence: 0.9, status: 'IN_PROGRESS', ageHours: 5,
    reasoning: 'Tier-1 scored 0.83 (< 0.85) → Tier-2 confirmed a boot-blocking fault; SLA window has since elapsed.',
    summary: 'Boot-blocking BSOD classified as HARDWARE (P2) via Tier-2 after its SLA window elapsed.',
  },
]

// --------------------------------------------------------------------- #
// In-memory store
// --------------------------------------------------------------------- */
let tickets = []
let auditLogs = []
let slaEvents = []
let initialised = false

function detailOf(t) {
  return { ...t }
}

function buildStore() {
  if (initialised) return
  initialised = true

  SEED_TICKETS.forEach((s, idx) => {
    const created = new Date(Date.now() - s.ageHours * 3600_000)
    const createdBy = USERS[idx % 3]
    const rag = ragFor(s.category, s.title)
    const originalSeverity = s.override?.severityFrom || s.severity
    const originalCategory = s.override?.categoryFrom || s.category

    let status = s.status
    if (s.forceBreach) status = 'ESCALATED'

    const t = {
      id: uuid(),
      title: s.title,
      raw_description: s.raw,
      scrubbed_description: scrub(s.raw).text,
      category: s.category,
      subcategory: s.subcategory,
      severity: s.severity,
      status,
      confidence_score: s.confidence,
      ai_tier_used: s.tier,
      ai_summary: s.summary,
      ai_reasoning: s.reasoning,
      troubleshooting_steps: rag.steps,
      assigned_agent_id: status === 'OPEN' ? null : AGENTS[idx % AGENTS.length].id,
      created_by_id: createdBy.id,
      created_at: created.toISOString(),
      sla_deadline: slaDeadline(originalSeverity, created.getTime()).toISOString(),
      is_sla_breached: false,
      assigned_agent: status === 'OPEN' ? null : AGENTS[idx % AGENTS.length],
      created_by: createdBy,
      kb_citations: rag.citations,
      audit_logs: [],
      sla_events: [],
    }

    // HITL override history (reschedules the SLA window when severity changes)
    if (s.override) {
      const at = new Date(Date.now() - s.override.agoHours * 3600_000)
      if (s.override.severityFrom) {
        t.sla_deadline = slaDeadline(s.severity, at.getTime()).toISOString()
      }
      const log = {
        id: uuid(),
        ticket_id: t.id,
        original_category: originalCategory,
        corrected_category: s.override.categoryFrom ? s.category : null,
        original_severity: originalSeverity,
        corrected_severity: s.override.severityFrom ? s.severity : null,
        corrected_by_agent_id: userByEmail(s.override.agent).id,
        note: s.override.note,
        timestamp: at.toISOString(),
      }
      t.audit_logs.push(log)
      auditLogs.push(log)
    }

    // SLA state + events
    const deadline = new Date(t.sla_deadline).getTime()
    const active = t.status === 'OPEN' || t.status === 'IN_PROGRESS'
    t.is_sla_breached = Boolean(s.forceBreach) || (active && deadline < Date.now())

    if (t.is_sla_breached) {
      const ev = {
        id: uuid(),
        ticket_id: t.id,
        event_type: 'BREACH',
        message: `SLA breached for '${t.title}' — escalated to P1_CRITICAL`,
        timestamp: iso(deadline + 1000),
      }
      t.sla_events.push(ev)
      slaEvents.push(ev)
    } else if (active) {
      const ev = {
        id: uuid(),
        ticket_id: t.id,
        event_type: 'SCHEDULED',
        message: `SLA check queued for ${t.sla_deadline} (${SLA_SECONDS[originalSeverity]}s ${originalSeverity} window)`,
        timestamp: t.created_at,
      }
      t.sla_events.push(ev)
      slaEvents.push(ev)
    }

    tickets.push(t)
  })
}

// --------------------------------------------------------------------- #
// Analytics (mirrors analytics_overview)
// --------------------------------------------------------------------- #
function overview() {
  const total = tickets.length
  const open = tickets.filter((t) => ['OPEN', 'IN_PROGRESS', 'ESCALATED'].includes(t.status)).length
  const breached = tickets.filter((t) => t.is_sla_breached).length
  const overrides = auditLogs.length
  const avgConf = total ? tickets.reduce((s, t) => s + t.confidence_score, 0) / total : 0

  const tierCount = (k) => tickets.filter((t) => t.ai_tier_used === k).length
  const t1 = tierCount('TIER1_LOCAL_SLM')
  const t2 = tierCount('TIER2_CLOUD_LLM')
  const fb = tierCount('RULE_FALLBACK')

  const bucket = (key) =>
    [...new Set(tickets.map((t) => t[key]))].map((v) => ({
      category: v,
      count: tickets.filter((t) => t[key] === v).length,
      breached: tickets.filter((t) => t[key] === v && t.is_sla_breached).length,
    }))

  const weekAgo = Date.now() - 7 * 24 * 3600_000
  const recentEvents = slaEvents.filter(
    (e) => e.event_type !== 'SCHEDULED' && new Date(e.timestamp).getTime() >= weekAgo
  ).length

  return {
    summary: {
      total_tickets: total,
      open_tickets: open,
      sla_breach_count: breached,
      sla_breach_rate: total ? round2((breached / total) * 1000) / 10 : 0,
      ai_accuracy_rate: total ? round2((1 - overrides / total) * 1000) / 10 : 100,
      avg_confidence: Math.round(avgConf * 1000) / 1000,
      tier1_count: t1,
      tier2_count: t2,
      rule_fallback_count: fb,
      hitl_override_count: overrides,
      cost_saved_usd: Math.round(t1 * 0.0038 * 10000) / 10000,
      estimated_ai_spend_usd: Math.round((t1 * 0.0002 + t2 * 0.004) * 10000) / 10000,
    },
    by_category: bucket('category'),
    by_tier: ['TIER1_LOCAL_SLM', 'TIER2_CLOUD_LLM', 'RULE_FALLBACK']
      .map((k) => ({ tier: k, count: tierCount(k) }))
      .filter((b) => b.count > 0),
    by_severity: bucket('severity'),
    sla_events_last_7d: recentEvents,
  }
}

// --------------------------------------------------------------------- #
// Route handlers (same names/signatures as lib/api.js real routes)
// --------------------------------------------------------------------- #
export const demoApi = {
  async health() {
    await lat()
    return {
      status: 'healthy',
      app: 'AutoTriage-ITSM',
      demo: true,
      timestamp: new Date().toISOString(),
      database: 'in-memory (demo)',
      redis: 'simulated',
      tier2_available: false,
    }
  },

  async users(role) {
    buildStore()
    await lat()
    return USERS.filter((u) => !role || u.role === role)
  },

  async kb() {
    buildStore()
    await lat()
    return KB.map(([title, category]) => ({ id: uuid(), title, category, score: 0 }))
  },

  async listTickets(filters = {}) {
    buildStore()
    await lat()
    const now = Date.now()
    let items = [...tickets].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

    if (filters.q) {
      const q = filters.q.toLowerCase()
      items = items.filter(
        (t) => t.title.toLowerCase().includes(q) || t.raw_description.toLowerCase().includes(q)
      )
    }
    if (filters.category) items = items.filter((t) => t.category === filters.category)
    if (filters.severity) items = items.filter((t) => t.severity === filters.severity)
    if (filters.status) items = items.filter((t) => t.status === filters.status)
    if (filters.sla === 'breached') items = items.filter((t) => t.is_sla_breached)
    if (filters.sla === 'ok')
      items = items.filter(
        (t) => !t.is_sla_breached && (!t.sla_deadline || new Date(t.sla_deadline).getTime() > now + 3600_000)
      )
    if (filters.sla === 'at_risk')
      items = items.filter((t) => {
        const d = t.sla_deadline ? new Date(t.sla_deadline).getTime() : null
        return !t.is_sla_breached && d && d <= now + 3600_000 && d > now
      })

    return { total: items.length, items }
  },

  async getTicket(id) {
    buildStore()
    await lat()
    const t = tickets.find((x) => x.id === id)
    if (!t) throw new Error('404: Ticket not found')
    return detailOf(t)
  },

  async createTicket(payload) {
    buildStore()
    // Stage timing is driven by the UI; ~3.3s keeps the pipeline animation visible.
    await sleep(3300)

    const titleScrub = scrub(payload.title)
    const descScrub = scrub(payload.raw_description)
    const redactions = { ...titleScrub.detected, ...descScrub.detected }
    const classification = classify(descScrub.text, titleScrub.text)
    const rag = ragFor(classification.category, payload.title)
    const created = new Date()

    const creator =
      USERS.find((u) => u.email === payload.created_by_email) ||
      (() => {
        const u = { id: uuid(), name: String(payload.created_by_email || 'Guest').split('@')[0], email: payload.created_by_email, role: 'EMPLOYEE' }
        USERS.push(u)
        return u
      })()

    const t = {
      id: uuid(),
      title: payload.title,
      raw_description: payload.raw_description,
      scrubbed_description: descScrub.text,
      category: classification.category,
      subcategory: classification.subcategory || null,
      severity: classification.severity,
      status: 'OPEN',
      confidence_score: classification.confidence,
      ai_tier_used: classification.tier,
      ai_summary: classification.summary,
      ai_reasoning: classification.reasoning,
      troubleshooting_steps: rag.steps,
      assigned_agent_id: null,
      created_by_id: creator.id,
      created_at: created.toISOString(),
      sla_deadline: slaDeadline(classification.severity).toISOString(),
      is_sla_breached: false,
      assigned_agent: null,
      created_by: creator,
      kb_citations: rag.citations,
      audit_logs: [],
      sla_events: [],
    }
    const ev = {
      id: uuid(),
      ticket_id: t.id,
      event_type: 'SCHEDULED',
      message: `SLA check queued for ${t.sla_deadline} (${SLA_SECONDS[classification.severity]}s ${classification.severity} window)`,
      timestamp: t.created_at,
    }
    t.sla_events.push(ev)
    slaEvents.push(ev)
    tickets.unshift(t)

    return {
      ticket: detailOf(t),
      pipeline: {
        pii: {
          scrubbed: true,
          redactions,
          redaction_count: Object.values(redactions).reduce((a, b) => a + b, 0),
          token: TOKEN,
        },
        classification: {
          tier: classification.tier,
          confidence: classification.confidence,
          reasoning: classification.reasoning,
          category: classification.category,
          severity: classification.severity,
          escalated_to_tier2: classification.escalated,
        },
        rag: {
          documents_retrieved: rag.citations.length,
          used_llm: false,
          steps: rag.steps,
          citations: rag.citations,
        },
        sla: {
          deadline: t.sla_deadline,
          window_seconds: SLA_SECONDS[classification.severity],
          task_id: `demo-${t.id}`,
        },
      },
    }
  },

  async updateTicket(id, payload) {
    buildStore()
    await lat()
    const t = tickets.find((x) => x.id === id)
    if (!t) throw new Error('404: Ticket not found')

    if (payload.status) t.status = payload.status
    if ('assigned_agent_id' in payload && payload.assigned_agent_id) {
      const agent = USERS.find((u) => u.id === payload.assigned_agent_id)
      if (!agent || !['AGENT', 'ADMIN'].includes(agent.role))
        throw new Error('400: assignee must be an AGENT or ADMIN')
      t.assigned_agent = agent
      t.assigned_agent_id = agent.id
      if (t.status === 'OPEN') t.status = 'IN_PROGRESS'
    } else if ('assigned_agent_id' in payload && !payload.assigned_agent_id) {
      t.assigned_agent = null
      t.assigned_agent_id = null
    }
    return detailOf(t)
  },

  async overrideTicket(id, payload) {
    buildStore()
    await lat()
    const t = tickets.find((x) => x.id === id)
    if (!t) throw new Error('404: Ticket not found')
    const agent = USERS.find((u) => u.id === payload.agent_id)
    if (!agent || !['AGENT', 'ADMIN'].includes(agent.role))
      throw new Error('403: Only AGENT/ADMIN roles can override AI')
    if (!payload.category && !payload.severity)
      throw new Error('422: Provide at least a category or a severity to override')

    const log = {
      id: uuid(),
      ticket_id: t.id,
      original_category: t.category,
      corrected_category: payload.category && payload.category !== t.category ? payload.category : null,
      original_severity: t.severity,
      corrected_severity: payload.severity && payload.severity !== t.severity ? payload.severity : null,
      corrected_by_agent_id: agent.id,
      note: payload.note || null,
      timestamp: new Date().toISOString(),
    }
    if (payload.category && payload.category !== t.category) t.category = payload.category
    if (payload.severity && payload.severity !== t.severity) {
      t.severity = payload.severity
      t.sla_deadline = slaDeadline(payload.severity).toISOString() // rescheduled window
    }
    t.audit_logs.unshift(log)
    auditLogs.unshift(log)
    return detailOf(t)
  },

  async escalateTicket(id) {
    buildStore()
    await lat(300, 300)
    const t = tickets.find((x) => x.id === id)
    if (!t) throw new Error('404: Ticket not found')
    t.is_sla_breached = true
    t.severity = 'P1_CRITICAL'
    t.status = 'ESCALATED'
    const ev = {
      id: uuid(),
      ticket_id: t.id,
      event_type: 'MANUAL',
      message: 'Manual escalation applied inline (queue unavailable)',
      timestamp: new Date().toISOString(),
    }
    t.sla_events.push(ev)
    slaEvents.push(ev)
    return { ticket_id: id, queued: false, result: 'escalated_inline' }
  },

  async regenerateSteps(id) {
    buildStore()
    await lat()
    const t = tickets.find((x) => x.id === id)
    if (!t) throw new Error('404: Ticket not found')
    const rag = ragFor(t.category, t.title)
    t.troubleshooting_steps = rag.steps
    t.kb_citations = rag.citations
    return {
      steps: rag.steps,
      used_llm: false,
      citations: rag.citations.map(({ id: cid, title, score }) => ({ id: cid, title, score })),
    }
  },

  async getAudit(id) {
    buildStore()
    await lat()
    const t = tickets.find((x) => x.id === id)
    if (!t) throw new Error('404: Ticket not found')
    return [...t.audit_logs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
  },

  async analytics() {
    buildStore()
    await lat()
    return overview()
  },
}

export default demoApi
