import { Check, ChevronDown, FolderOpen } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useId, useRef, useState } from 'react'

interface WorkspacePickerProps {
  value: string
  history: readonly string[]
  placeholder: string
  recentLabel: string
  emptyLabel: string
  chooseLabel: string
  onChange: (workspace: string) => void
  onPick: () => void
}

/** Combobox: typed path + themed recent-workspace menu + folder picker. */
export default function WorkspacePicker({
  value,
  history,
  placeholder,
  recentLabel,
  emptyLabel,
  chooseLabel,
  onChange,
  onPick
}: WorkspacePickerProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open])

  return (
    <div ref={rootRef} className="flex gap-1.5">
      <div
        className="relative min-w-0 flex-1"
        onPointerEnter={() => {
          if (history.length > 0) setOpen(true)
        }}
        onPointerLeave={() => setOpen(false)}
      >
        <input
          data-testid="cli-workspace"
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={(event) => onChange(event.target.value)}
          className={`${fieldClass} min-w-0 pr-8`}
        />
        <button
          type="button"
          data-testid="cli-workspace-history"
          aria-label={recentLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => {
            if (history.length === 0) return
            setOpen(true)
          }}
          className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-text-faint transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          <ChevronDown
            className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
            strokeWidth={1.75}
          />
        </button>
        <AnimatePresence>
          {open && (
            <motion.div
              className="absolute top-full right-0 left-0 z-40 pt-1"
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.14, ease: [0.32, 0.72, 0, 1] }}
            >
              <ul
                id={listId}
                role="listbox"
                data-testid="cli-workspace-history-list"
                className="shell-popover overflow-hidden rounded-lg border border-border-default bg-surface p-1"
              >
              <li className="px-2 pt-1 pb-1 font-maple text-[9px] tracking-[0.18em] text-text-faint uppercase">
                {recentLabel}
              </li>
              {history.length === 0 ? (
                <li className="px-2 py-1.5 font-pingfang text-[12px] text-text-faint">
                  {emptyLabel}
                </li>
              ) : (
                history.map((workspace, index) => {
                  const selected = workspace === value
                  return (
                    <li key={workspace}>
                      <button
                        type="button"
                        role="option"
                        data-testid={`cli-workspace-history-option-${index}`}
                        aria-selected={selected}
                        title={workspace}
                        onClick={() => {
                          onChange(workspace)
                          setOpen(false)
                        }}
                        className={`cursor-target flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left font-pingfang text-[12px] transition-colors ${
                          selected
                            ? 'bg-surface-strong text-text-primary'
                            : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                        }`}
                      >
                        <span className="min-w-0 truncate">{workspace}</span>
                        {selected && <Check className="size-3.5 shrink-0" strokeWidth={1.75} />}
                      </button>
                    </li>
                  )
                })
              )}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <button
        type="button"
        data-testid="cli-pick-workspace"
        title={chooseLabel}
        aria-label={chooseLabel}
        onClick={onPick}
        className="flex size-[34px] shrink-0 items-center justify-center rounded-lg border border-border-default bg-input text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary"
      >
        <FolderOpen className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  )
}

const fieldClass =
  'w-full rounded-lg border border-border-default bg-input px-2.5 py-2 font-pingfang text-[12px] text-text-primary outline-none transition-colors placeholder:text-text-faint focus:border-input-focus focus:bg-input-hover'
