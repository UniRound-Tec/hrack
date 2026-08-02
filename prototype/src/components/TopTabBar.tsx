import { Home, Plus, Terminal as TerminalIcon, X } from 'lucide-react'
import {
  statusDot,
  statusLabel,
  statusTone,
  type SessionItem,
  type TerminalItem,
} from '@/types'

const tabButtonClass = (active: boolean) =>
  [
    'cursor-target flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-pingfang text-[12px] transition-colors',
    active
      ? 'bg-white text-neutral-900 shadow-sm shadow-black/5'
      : 'text-neutral-500 hover:bg-neutral-200/40 hover:text-neutral-800',
  ].join(' ')

const iconButtonClass = (active: boolean) =>
  [
    'cursor-target flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors',
    active
      ? 'bg-white text-neutral-900 shadow-sm shadow-black/5'
      : 'text-neutral-400 hover:bg-neutral-200/50 hover:text-neutral-700',
  ].join(' ')

const hoverCardClass =
  'pointer-events-none absolute top-full left-0 z-40 mt-1.5 w-60 rounded-xl border border-black/8 bg-white p-3 opacity-0 shadow-xl shadow-black/10 transition-opacity delay-150 group-hover:opacity-100'

/**
 * 顶部 Tab 栏模式:无侧栏,三态导航之一。
 * Home 常驻最左,新建常驻 session/terminal tabs 右侧,设置入口在标题栏;
 * tab 只承载精简信息(状态点 + 名称),详情 hover 弹出。
 */
export default function TopTabBar({
  sessions,
  terminals,
  active,
  onSelect,
}: {
  sessions: readonly SessionItem[]
  terminals: readonly TerminalItem[]
  active: string
  onSelect: (id: 'home' | 'new') => void
}) {
  const sessionTabs = sessions.slice(0, 3)
  const terminalTabs = terminals.slice(0, 2)
  const activeTabId = sessionTabs[0]?.id

  return (
    <div className="sticky top-0 z-30 flex items-center gap-1 border-b border-black/6 bg-[#f7f7f6]/95 px-3 py-1.5 backdrop-blur">
      {/* Home 常驻最左 */}
      <button
        type="button"
        title="Home"
        onClick={() => onSelect('home')}
        className={iconButtonClass(active === 'home')}
      >
        <Home className="size-3.5" strokeWidth={1.75} />
      </button>

      <span className="mx-1 h-4 w-px shrink-0 bg-black/8" />

      {sessionTabs.map(({ id, cli, Icon, time, status, message }) => (
        <div key={id} className="group relative">
          <button type="button" className={tabButtonClass(id === activeTabId)}>
            <span
              className={`size-1.5 shrink-0 rounded-full ${statusDot[status]}`}
            />
            <Icon size={13} className="size-[13px] shrink-0" />
            <span className="max-w-[96px] truncate">{cli}</span>
            <X
              className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-50"
              strokeWidth={1.75}
            />
          </button>
          <div className={hoverCardClass}>
            <div className="flex items-center gap-1.5">
              <Icon size={13} className="size-[13px]" />
              <span className="font-pingfang text-[12px] font-semibold text-neutral-900">
                {cli}
              </span>
              <span
                className={`ml-auto font-maple text-[10px] ${statusTone[status]}`}
              >
                {statusLabel[status]}
              </span>
            </div>
            <p className="mt-1.5 font-pingfang text-[11px] leading-snug text-neutral-600">
              {message}
            </p>
            <p className="mt-1 font-maple text-[10px] text-neutral-400">
              {time}
            </p>
          </div>
        </div>
      ))}

      <span className="mx-1 h-4 w-px shrink-0 bg-black/8" />

      {terminalTabs.map(({ id, name, cwd }) => (
        <div key={id} className="group relative">
          <button type="button" className={tabButtonClass(false)}>
            <TerminalIcon
              className="size-3 shrink-0 text-neutral-500"
              strokeWidth={1.75}
            />
            <span className="max-w-[110px] truncate">{name}</span>
            <X
              className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-50"
              strokeWidth={1.75}
            />
          </button>
          <div className={hoverCardClass}>
            <p className="font-pingfang text-[12px] font-semibold text-neutral-900">
              {name}
            </p>
            <p className="mt-1 truncate font-maple text-[10px] text-neutral-400">
              {cwd}
            </p>
          </div>
        </div>
      ))}

      {/* 新建常驻 tabs 右侧 */}
      <button
        type="button"
        aria-label="新建会话"
        title="新建会话 (Ctrl+Shift+T)"
        onClick={() => onSelect('new')}
        className={iconButtonClass(false)}
      >
        <Plus className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  )
}
