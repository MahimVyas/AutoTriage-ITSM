import { cn } from '@/lib/utils'

export function Tabs({ className, children, ...props }) {
  return (
    <div
      className={cn('inline-flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1', className)}
      {...props}
    >
      {children}
    </div>
  )
}

export function Tab({ active, onClick, children, className, ...props }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-all',
        active
          ? 'bg-card text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}

export default Tabs
