import {
  Home,
  PanelLeftOpen,
  SquarePen,
  Terminal as TerminalIcon,
} from 'lucide-react'
import { statusDot, type SessionItem, type TerminalItem } from '@/types'

const railNav = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'new', label: 'New Session', icon: SquarePen },
] as const

export type RailNavId = 'home' | 'new'

const railButtonClass = (active: boolean) =>
  [
    'cursor-target flex size-9 items-center justify-center rounded-lg transition-colors',
    active
      ? 'bg-neutral-100 text-neutral-900'
      : 'text-neutral-400 hover:bg-neutral-50 hover:text-neutral-800',
  ].join(' ')

/** 侧栏收起态:图标条,保留状态点,详情靠 title 提示;底部常驻快速展开 */
export default function IconRail({
  active,
  onSelect,
  onExpand,
  sessions,
  terminals,
}: {
  active: string
  onSelect: (id: RailNavId) => void
  onExpand: () => void
  sessions: readonly SessionItem[]
  terminals: readonly TerminalItem[]
}) {
  const visibleSessions = sessions.slice(0, 6)
  const moreSessions = sessions.length - visibleSessions.length
  const visibleTerminals = terminals.slice(0, 3)
  const moreTerminals = terminals.length - visibleTerminals.length

  return (
    <aside className="flex w-12 shrink-0 flex-col items-center bg-white pt-3 pb-2">
      <span className="font-ammonite text-[20px] leading-none text-neutral-700 select-none">
        h
      </span>

      <nav className="mt-3 flex flex-col gap-0.5">
        {railNav.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            title={label}
            onClick={() => onSelect(id)}
            className={railButtonClass(active === id)}
          >
            <Icon className="size-4" strokeWidth={1.75} />
          </button>
        ))}
      </nav>

      <span className="my-2.5 h-px w-6 shrink-0 bg-black/6" />

      <div className="sidebar-scroll flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {visibleSessions.map(({ id, cli, Icon, status, message }) => (
          <button
            key={id}
            type="button"
            title={`${cli} · ${message}`}
            className="cursor-target relative flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-neutral-50"
          >
            <Icon size={15} className="size-[15px]" />
            <span
              className={`absolute top-1 right-1 size-1.5 rounded-full ring-2 ring-white ${statusDot[status]}`}
            />
          </button>
        ))}
        {moreSessions > 0 && (
          <span className="shrink-0 font-maple text-[10px] text-neutral-400">
            +{moreSessions}
          </span>
        )}

        <span className="my-1.5 h-px w-6 shrink-0 bg-black/6" />

        {visibleTerminals.map(({ id, name, cwd }) => (
          <button
            key={id}
            type="button"
            title={`${name} · ${cwd}`}
            className="cursor-target flex size-9 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-800"
          >
            <TerminalIcon className="size-[15px]" strokeWidth={1.75} />
          </button>
        ))}
        {moreTerminals > 0 && (
          <span className="shrink-0 font-maple text-[10px] text-neutral-400">
            +{moreTerminals}
          </span>
        )}
      </div>

      {/* 底部常驻:快速展开 */}
      <div className="mt-1 flex flex-col items-center border-t border-black/5 pt-1.5">
        <button
          type="button"
          title="展开侧栏"
          onClick={onExpand}
          className={railButtonClass(false)}
        >
          <PanelLeftOpen className="size-4" strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  )
}
