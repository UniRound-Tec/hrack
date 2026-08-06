import { Ellipsis, Layers2, Pencil, Ungroup } from 'lucide-react'
import { useEffect, useState, type PointerEvent, type ReactNode } from 'react'
import { useStrings } from '../app/i18n'
import type { SessionGroup as SessionGroupModel } from './sessionNavigation'

interface SessionGroupProps {
  group: SessionGroupModel
  children: ReactNode
  onRename(groupId: string, name: string): void
  onDissolve(groupId: string): void
  onPointerDown(event: PointerEvent<HTMLElement>): void
}

export default function SessionGroup({
  group,
  children,
  onRename,
  onDissolve,
  onPointerDown
}: SessionGroupProps) {
  const strings = useStrings()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(group.name)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: globalThis.PointerEvent): void => {
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('[data-session-group-actions]')
      ) {
        return
      }
      setMenuOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menuOpen])

  const finishRename = (): void => {
    const normalized = name.trim()
    if (!normalized) {
      setError(true)
      return
    }
    onRename(group.id, normalized)
    setError(false)
    setRenaming(false)
  }

  return (
    <li
      data-testid="sidebar-session-group"
      data-group-id={group.id}
      data-navigation-group-id={group.id}
      data-navigation-root-id={group.id}
      className="relative rounded-xl border border-border-subtle bg-control/40 p-1"
    >
      <div
        data-testid="sidebar-session-group-header"
        onPointerDown={(event) => {
          const target = event.target
          if (
            target instanceof Element &&
            target.closest('[data-no-session-drag]')
          ) {
            return
          }
          onPointerDown(event)
        }}
        className="relative flex min-h-8 items-center gap-1.5 px-1.5 font-pingfang"
      >
        <Layers2 className="size-3.5 shrink-0 text-text-faint" strokeWidth={1.75} />
        {renaming ? (
          <form
            data-no-session-drag
            className="min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault()
              finishRename()
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) finishRename()
            }}
          >
            <input
              autoFocus
              data-testid="sidebar-session-group-rename-input"
              value={name}
              aria-invalid={error}
              aria-label={strings.navigation.renameGroup}
              onChange={(event) => {
                setName(event.target.value)
                if (event.target.value.trim()) setError(false)
              }}
              className={`h-6 w-full rounded-md border bg-content px-1.5 text-[11px] text-text-primary outline-none ${error ? 'border-status-error' : 'border-border-default focus:border-border-strong'}`}
            />
          </form>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-text-secondary">
              {group.name}
            </span>
            <span className="text-[10px] text-text-faint">{group.members.length}</span>
            <button
              type="button"
              data-no-session-drag
              data-session-group-actions
              data-testid="sidebar-session-group-menu"
              aria-label={strings.navigation.groupActions}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                setMenuOpen((open) => !open)
              }}
              className="flex size-6 items-center justify-center rounded-md text-text-faint hover:bg-control hover:text-text-secondary"
            >
              <Ellipsis className="size-3.5" strokeWidth={1.75} />
            </button>
          </>
        )}

        {menuOpen && (
          <div
            data-no-session-drag
            data-session-group-actions
            data-testid="sidebar-session-group-popover"
            onPointerDown={(event) => event.stopPropagation()}
            className="shell-popover absolute top-8 right-0 z-40 w-36 rounded-lg border border-border-default bg-surface p-1"
          >
            <button
              type="button"
              data-testid="sidebar-session-group-rename"
              onClick={() => {
                setName(group.name)
                setError(false)
                setMenuOpen(false)
                setRenaming(true)
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            >
              <Pencil className="size-3" strokeWidth={1.75} />
              {strings.navigation.renameGroup}
            </button>
            <button
              type="button"
              data-testid="sidebar-session-group-dissolve"
              onClick={() => onDissolve(group.id)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            >
              <Ungroup className="size-3" strokeWidth={1.75} />
              {strings.navigation.dissolveGroup}
            </button>
          </div>
        )}
      </div>
      <ul className="flex flex-col gap-1">{children}</ul>
      {error && (
        <p role="alert" className="px-2 pb-1 text-[10px] text-status-error">
          {strings.navigation.groupNameRequired}
        </p>
      )}
    </li>
  )
}
