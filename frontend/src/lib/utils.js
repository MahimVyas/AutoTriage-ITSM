import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

export function formatDT(value) {
  if (!value) return '—'
  const d = new Date(value.endsWith('Z') || value.includes('+') ? value : value + 'Z')
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function timeLeft(deadline, breached) {
  if (breached) return { label: 'BREACHED', tone: 'bad' }
  if (!deadline) return { label: 'No SLA', tone: 'muted' }
  const d = new Date(deadline.endsWith('Z') || deadline.includes('+') ? deadline : deadline + 'Z')
  const ms = d.getTime() - Date.now()
  if (Number.isNaN(ms)) return { label: '—', tone: 'muted' }
  if (ms <= 0) return { label: 'DUE NOW', tone: 'bad' }
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return { label: `${mins}m left`, tone: mins < 15 ? 'warn' : 'ok' }
  const hours = Math.floor(mins / 60)
  if (hours < 48) return { label: `${hours}h ${mins % 60}m left`, tone: hours < 1 ? 'warn' : 'ok' }
  return { label: `${Math.floor(hours / 24)}d left`, tone: 'ok' }
}

export const CATEGORIES = ['HARDWARE', 'NETWORK', 'IAM_ACCESS', 'SOFTWARE', 'SECURITY', 'UNASSIGNED']
export const SEVERITIES = ['P1_CRITICAL', 'P2_HIGH', 'P3_MEDIUM', 'P4_LOW']
export const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ESCALATED']
export const TIERS = ['TIER1_LOCAL_SLM', 'TIER2_CLOUD_LLM', 'RULE_FALLBACK']

export const SEVERITY_STYLES = {
  P1_CRITICAL: 'bg-red-100 text-red-700 ring-red-200',
  P2_HIGH: 'bg-orange-100 text-orange-700 ring-orange-200',
  P3_MEDIUM: 'bg-amber-100 text-amber-700 ring-amber-200',
  P4_LOW: 'bg-slate-100 text-slate-600 ring-slate-200',
}

export const CATEGORY_STYLES = {
  HARDWARE: 'bg-violet-100 text-violet-700 ring-violet-200',
  NETWORK: 'bg-sky-100 text-sky-700 ring-sky-200',
  IAM_ACCESS: 'bg-indigo-100 text-indigo-700 ring-indigo-200',
  SOFTWARE: 'bg-teal-100 text-teal-700 ring-teal-200',
  SECURITY: 'bg-rose-100 text-rose-700 ring-rose-200',
  UNASSIGNED: 'bg-slate-100 text-slate-600 ring-slate-200',
}

export const STATUS_STYLES = {
  OPEN: 'bg-blue-100 text-blue-700 ring-blue-200',
  IN_PROGRESS: 'bg-cyan-100 text-cyan-700 ring-cyan-200',
  RESOLVED: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
  CLOSED: 'bg-slate-100 text-slate-500 ring-slate-200',
  ESCALATED: 'bg-red-600 text-white ring-red-700',
}

export const TIER_STYLES = {
  TIER1_LOCAL_SLM: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
  TIER2_CLOUD_LLM: 'bg-blue-100 text-blue-700 ring-blue-200',
  RULE_FALLBACK: 'bg-slate-100 text-slate-600 ring-slate-200',
}

export const TIER_LABELS = {
  TIER1_LOCAL_SLM: 'Tier 1 · Local SLM',
  TIER2_CLOUD_LLM: 'Tier 2 · Cloud LLM',
  RULE_FALLBACK: 'Rule fallback',
}
