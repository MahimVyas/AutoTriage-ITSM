import { cn } from '@/lib/utils'
import { SEVERITY_STYLES, CATEGORY_STYLES, STATUS_STYLES, TIER_STYLES } from '@/lib/utils'

const base =
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset whitespace-nowrap'

export function Badge({ className, children, ...props }) {
  return (
    <span className={cn(base, 'bg-muted text-muted-foreground ring-border', className)} {...props}>
      {children}
    </span>
  )
}

export function SeverityBadge({ value, className }) {
  if (!value) return null
  return <span className={cn(base, SEVERITY_STYLES[value] || SEVERITY_STYLES.P4_LOW, className)}>{value}</span>
}

export function CategoryBadge({ value, className }) {
  if (!value) return null
  return (
    <span className={cn(base, CATEGORY_STYLES[value] || CATEGORY_STYLES.UNASSIGNED, className)}>
      {value}
    </span>
  )
}

export function StatusBadge({ value, className }) {
  if (!value) return null
  return (
    <span className={cn(base, STATUS_STYLES[value] || STATUS_STYLES.OPEN, className)}>{value}</span>
  )
}

export function TierBadge({ value, className }) {
  if (!value) return null
  return (
    <span className={cn(base, TIER_STYLES[value] || TIER_STYLES.RULE_FALLBACK, className)}>
      {value}
    </span>
  )
}

export default Badge
