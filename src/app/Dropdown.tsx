import { Check, ChevronDown } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Fragment, useEffect, useRef, useState } from 'react'

export interface DropdownOption {
  value: string
  label: string
  group?: {
    id: string
    label: string
  }
}

interface DropdownProps {
  testId?: string
  value: string
  options: readonly DropdownOption[]
  disabled?: boolean
  direction?: 'down' | 'up'
  rootClassName?: string
  buttonClassName?: string
  onChange: (value: string) => void
}

/** 自绘下拉框：原生 <select> 的弹出层无法使用 Vibing 主题 token。 */
export default function Dropdown({
  testId,
  value,
  options,
  disabled,
  direction = 'down',
  rootClassName = '',
  buttonClassName = '',
  onChange
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const active = options.find((option) => option.value === value)

  return (
    <div ref={rootRef} className={`relative ${rootClassName}`}>
      <button
        type="button"
        data-testid={testId}
        data-value={value}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className={`cursor-target flex min-w-[128px] items-center justify-between gap-2 rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[12px] text-text-secondary outline-none transition-colors hover:bg-input-hover focus:border-input-focus disabled:opacity-50 ${buttonClassName}`}
      >
        <span className="truncate">{active?.label ?? value}</span>
        <ChevronDown className={`size-3.5 shrink-0 text-text-faint transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={1.75} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            role="listbox"
            data-testid={testId ? `${testId}-list` : undefined}
            initial={{ opacity: 0, y: direction === 'down' ? -4 : 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: direction === 'down' ? -4 : 4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: [0.32, 0.72, 0, 1] }}
            className={`shell-popover absolute right-0 z-30 min-w-full overflow-hidden rounded-lg border border-border-default bg-surface p-1 ${direction === 'down' ? 'top-full mt-1' : 'bottom-full mb-1'}`}
          >
            {options.map((option, index) => {
              const startsGroup = option.group && option.group.id !== options[index - 1]?.group?.id
              return (
                <Fragment key={option.value}>
                  {startsGroup && (
                    <li
                      data-testid={testId ? `${testId}-group-${option.group!.id}` : undefined}
                      className={`${index === 0 ? 'pt-1' : 'mt-1 border-t border-border-faint pt-2'} px-2 pb-1 font-maple text-[9px] tracking-[0.18em] text-text-faint uppercase`}
                    >
                      {option.group!.label}
                    </li>
                  )}
                  <li>
                    <button
                      type="button"
                      role="option"
                      data-testid={testId ? `${testId}-option-${option.value}` : undefined}
                      aria-selected={option.value === value}
                      onClick={() => {
                        onChange(option.value)
                        setOpen(false)
                      }}
                      className={`cursor-target flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left font-pingfang text-[12px] whitespace-nowrap transition-colors ${option.value === value ? 'bg-surface-strong text-text-primary' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}
                    >
                      <span className="truncate">{option.label}</span>
                      {option.value === value && <Check className="size-3.5 shrink-0" strokeWidth={1.75} />}
                    </button>
                  </li>
                </Fragment>
              )
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}
