import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

const fieldBase =
  'flex w-full rounded-md border border-input bg-input-background px-3 py-2 text-sm shadow-sm transition-colors ' +
  'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'focus-visible:border-transparent disabled:cursor-not-allowed disabled:opacity-50'

export const Input = forwardRef(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(fieldBase, 'h-9', className)} {...props} />
})

export const Textarea = forwardRef(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(fieldBase, 'min-h-[120px] resize-y', className)} {...props} />
})

export const Select = forwardRef(function Select({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(fieldBase, 'h-9 cursor-pointer pr-8', className)} {...props}>
      {children}
    </select>
  )
})

export function Label({ className, children, ...props }) {
  return (
    <label className={cn('mb-1.5 block text-xs font-medium text-muted-foreground', className)} {...props}>
      {children}
    </label>
  )
}

export default Input
