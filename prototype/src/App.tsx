import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  FolderOpen,
  Home,
  PanelLeftClose,
  Settings2,
  SquarePen,
  Terminal,
  X,
} from 'lucide-react'
import {
  ClaudeCode,
  Codex,
  Cursor,
  GeminiCLI,
  LobeHub,
  OpenCode,
} from '@lobehub/icons'
import ShinyText from '@/components/ShinyText'
import TargetCursor from '@/components/TargetCursor'
import ClickSpark from '@/components/ClickSpark'
import TextType from '@/components/TextType'
import CountUp from '@/components/CountUp'
import FloatWindow from '@/components/FloatWindow'
import IconRail from '@/components/IconRail'
import SettingsPage, { type NavMode } from '@/components/SettingsPage'
import TopTabBar from '@/components/TopTabBar'
import {
  statusDot,
  statusLabel,
  statusTone,
  type BrandIcon,
  type SessionItem,
  type SessionStatus,
} from '@/types'

const HOME_ACCENT = '#FF4500'

const homeGreetings = [
  { text: 'Hi! Ready to coding?', keywords: ['coding'] },
  { text: 'Welcome back, builder.', keywords: ['builder'] },
  { text: 'Let’s ship something today.', keywords: ['ship'] },
  { text: 'Your agents are standing by.', keywords: ['agents'] },
  { text: 'Coffee first, then commits.', keywords: ['commits'] },
  { text: 'One more session won’t hurt.', keywords: ['session'] },
  { text: 'Good timing. Let’s vibe.', keywords: ['vibe'] },
  { text: 'Pick a CLI and go.', keywords: ['CLI'] },
]

function pickHomeGreeting(exclude?: string) {
  const pool = exclude
    ? homeGreetings.filter((g) => g.text !== exclude)
    : homeGreetings
  return pool[Math.floor(Math.random() * pool.length)] ?? homeGreetings[0]
}

const DEFAULT_TERMINAL_KEY = 'vibing.defaultTerminal'

const terminalOptions = [
  { id: 'cmd', name: 'Command Prompt', hint: 'cmd.exe' },
  { id: 'powershell', name: 'Windows PowerShell', hint: 'powershell.exe' },
  { id: 'pwsh', name: 'PowerShell 7', hint: 'pwsh.exe' },
  { id: 'git-bash', name: 'Git Bash', hint: 'Git\\bin\\bash.exe' },
  { id: 'wsl', name: 'WSL', hint: 'Ubuntu / Linux shell' },
] as const

type TerminalId = (typeof terminalOptions)[number]['id']

function readDefaultTerminal(): TerminalId {
  try {
    const saved = localStorage.getItem(DEFAULT_TERMINAL_KEY)
    if (terminalOptions.some((t) => t.id === saved)) return saved as TerminalId
  } catch {
    /* ignore */
  }
  return 'powershell'
}

const navItems = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'new', label: 'New Session', icon: SquarePen },
] as const

/** 页面 id:settings 不在导航列表里,入口在侧栏底部 / 顶部 Tab 栏最右 */
type PageId = (typeof navItems)[number]['id'] | 'settings'

/** mock 会话:覆盖 §11.5 全部六态,按最近活动排序 */
const sessions: SessionItem[] = [
  {
    id: '1',
    cli: 'Codex',
    Icon: Codex,
    time: '刚刚',
    status: 'working',
    message: '运行 pnpm test --filter demo',
  },
  {
    id: '2',
    cli: 'Claude Code',
    Icon: ClaudeCode,
    time: '1 分钟前',
    status: 'working',
    message: '思考中：检索 ipc-contract 引用',
  },
  {
    id: '3',
    cli: 'Codex',
    Icon: Codex,
    time: '1 分钟前',
    status: 'needs-you',
    message: '等待批准：写入 src/main.ts',
  },
  {
    id: '4',
    cli: 'Aider',
    Icon: LobeHub,
    time: '3 分钟前',
    status: 'needs-you',
    message: '等待确认：提交 4 个文件的改动',
  },
  {
    id: '5',
    cli: 'Gemini CLI',
    Icon: GeminiCLI,
    time: '10 分钟前',
    status: 'done',
    message: '完成：生成 release notes',
  },
  {
    id: '6',
    cli: 'Codex',
    Icon: Codex,
    time: '18 分钟前',
    status: 'error',
    message: '出错：tests/ipc.test.ts 3 个用例失败',
  },
  {
    id: '7',
    cli: 'OpenCode',
    Icon: OpenCode,
    time: '42 分钟前',
    status: 'error',
    message: '出错：electron-vite build 退出码 1',
  },
  {
    id: '8',
    cli: 'Claude Code',
    Icon: ClaudeCode,
    time: '1 小时前',
    status: 'needs-you',
    message: '等待批准：删除旧的迁移脚本',
  },
  {
    id: '9',
    cli: 'Cursor Agent',
    Icon: Cursor,
    time: '1 小时前',
    status: 'needs-you',
    message: '等待确认：重构 sidebar 布局',
  },
  {
    id: '10',
    cli: 'Claude Code',
    Icon: ClaudeCode,
    time: '1 小时前',
    status: 'done',
    message: '完成：补齐 tabs e2e 断言',
  },
  {
    id: '11',
    cli: 'Gemini CLI',
    Icon: GeminiCLI,
    time: '2 小时前',
    status: 'error',
    message: '出错：API rate limit exceeded',
  },
  {
    id: '12',
    cli: 'Codex',
    Icon: Codex,
    time: '3 小时前',
    status: 'needs-you',
    message: '等待批准：更新 package.json 依赖',
  },
  {
    id: '13',
    cli: 'Aider',
    Icon: LobeHub,
    time: '昨天',
    status: 'idle',
    message: '空闲：等待下一个 prompt',
  },
  {
    id: '14',
    cli: 'OpenCode',
    Icon: OpenCode,
    time: '昨天',
    status: 'needs-you',
    message: '等待确认：迁移到 Tailwind v4',
  },
  {
    id: '15',
    cli: 'Claude Code',
    Icon: ClaudeCode,
    time: '2 天前',
    status: 'error',
    message: '出错：eslint 12 个问题未修复',
  },
  {
    id: '16',
    cli: 'Warp Agent',
    Icon: LobeHub,
    time: '2 天前',
    status: 'exited',
    message: '已退出：exit code 0',
  },
  {
    id: '17',
    cli: 'Continue',
    Icon: LobeHub,
    time: '上周',
    status: 'error',
    message: '出错：无法连接本地模型服务',
  },
]

const ATTENTION_COLLAPSED_ROWS = 8

type HistoryKind = 'tool_call' | 'completed' | 'approved' | 'message'

const historyEvents: {
  id: string
  kind: HistoryKind
  cli: string
  Icon: BrandIcon
  time: string
  title: string
  detail: string
}[] = [
  {
    id: 'h1',
    kind: 'tool_call',
    cli: 'Codex',
    Icon: Codex,
    time: '2 分钟前',
    title: 'tool_call · Write',
    detail: 'src/App.tsx · 写入 48 行',
  },
  {
    id: 'h2',
    kind: 'tool_call',
    cli: 'Claude Code',
    Icon: ClaudeCode,
    time: '8 分钟前',
    title: 'tool_call · Bash',
    detail: 'pnpm test --filter demo',
  },
  {
    id: 'h3',
    kind: 'approved',
    cli: 'Aider',
    Icon: LobeHub,
    time: '15 分钟前',
    title: '已批准',
    detail: '提交 4 个文件的改动',
  },
  {
    id: 'h4',
    kind: 'tool_call',
    cli: 'Cursor Agent',
    Icon: Cursor,
    time: '32 分钟前',
    title: 'tool_call · Read',
    detail: 'src/components/TrueFocus.jsx',
  },
  {
    id: 'h5',
    kind: 'completed',
    cli: 'Gemini CLI',
    Icon: GeminiCLI,
    time: '1 小时前',
    title: '会话完成',
    detail: '生成 release notes · 成功',
  },
  {
    id: 'h6',
    kind: 'tool_call',
    cli: 'OpenCode',
    Icon: OpenCode,
    time: '1 小时前',
    title: 'tool_call · Edit',
    detail: 'vite.config.ts · patch',
  },
  {
    id: 'h7',
    kind: 'message',
    cli: 'Codex',
    Icon: Codex,
    time: '2 小时前',
    title: 'assistant',
    detail: '已完成 sidebar 布局重构，请 review',
  },
  {
    id: 'h8',
    kind: 'tool_call',
    cli: 'Claude Code',
    Icon: ClaudeCode,
    time: '昨天',
    title: 'tool_call · Glob',
    detail: '**/*.{ts,tsx} · 126 files',
  },
]

const historyKindTone: Record<HistoryKind, string> = {
  tool_call: 'text-neutral-600',
  completed: 'text-emerald-700',
  approved: 'text-pending',
  message: 'text-neutral-500',
}

const historyKindDot: Record<HistoryKind, string> = {
  tool_call: 'bg-neutral-400',
  completed: 'bg-emerald-500',
  approved: 'bg-pending-dot',
  message: 'bg-neutral-300',
}

const homeStats = [
  {
    id: 'sessions',
    label: '历史启动',
    hint: 'sessions',
    value: 1284,
  },
  {
    id: 'tools',
    label: 'Tools 调用',
    hint: 'tool_call',
    value: 9632,
  },
  {
    id: 'alerts',
    label: '阻塞提醒',
    hint: 'blocked',
    value: 156,
  },
  {
    id: 'approvals',
    label: '已处理批准',
    hint: 'approved',
    value: 412,
  },
] as const

const terminals = [
  { id: 't1', name: 'zsh — demo', cwd: '~/Desktop/demo' },
  { id: 't2', name: 'pwsh — build', cwd: 'C:\\Users\\Jesse\\Desktop\\demo' },
  { id: 't3', name: 'node — vite', cwd: 'localhost:5174' },
  { id: 't4', name: 'bash — git', cwd: '~/Desktop/demo' },
  { id: 't5', name: 'pwsh — test', cwd: '.\\scripts' },
  { id: 't6', name: 'zsh — docker', cwd: '~/infra' },
  { id: 't7', name: 'node — storybook', cwd: 'localhost:6006' },
  { id: 't8', name: 'pwsh — ssh', cwd: 'root@192.168.1.20' },
  { id: 't9', name: 'zsh — logs', cwd: '~/logs/app' },
  { id: 't10', name: 'cmd — nuget', cwd: 'C:\\tools\\nuget' },
  { id: 't11', name: 'zsh — redis', cwd: '6379' },
  { id: 't12', name: 'pwsh — migrate', cwd: '.\\db' },
] as const

const cliOptions: {
  id: string
  name: string
  Icon: BrandIcon
  hint: string
  defaultArgs: string
}[] = [
  {
    id: 'terminal',
    name: '终端',
    Icon: Terminal,
    hint: '普通终端会话',
    defaultArgs: '',
  },
  {
    id: 'codex',
    name: 'Codex',
    Icon: Codex,
    hint: 'OpenAI coding agent',
    defaultArgs: '--full-auto',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    Icon: ClaudeCode,
    hint: 'Anthropic CLI',
    defaultArgs: '--dangerously-skip-permissions',
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    Icon: Cursor,
    hint: 'In-editor agent',
    defaultArgs: '',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    Icon: GeminiCLI,
    hint: 'Google AI CLI',
    defaultArgs: '--yolo',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    Icon: OpenCode,
    hint: 'Open-source agent',
    defaultArgs: '',
  },
  {
    id: 'aider',
    name: 'Aider',
    Icon: LobeHub,
    hint: 'Pair programming CLI',
    defaultArgs: '--yes',
  },
]

const cliRuntimeOptions = [
  { id: 'windows', name: 'Windows', hint: '本机 Windows 环境' },
  { id: 'wsl', name: 'WSL', hint: '通过 WSL 启动' },
] as const

type CliRuntime = (typeof cliRuntimeOptions)[number]['id']

type CliOption = (typeof cliOptions)[number]

function App() {
  const [active, setActive] = useState<PageId>('home')
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [terminalModalOpen, setTerminalModalOpen] = useState(false)
  const [rememberDefault, setRememberDefault] = useState(false)
  const [defaultTerminal, setDefaultTerminal] = useState<TerminalId>('powershell')

  const [cliModalOpen, setCliModalOpen] = useState(false)
  const [cliDraft, setCliDraft] = useState<{
    option: CliOption
    name: string
    workspace: string
    args: string
    runtime: CliRuntime
  } | null>(null)
  const [homeGreeting, setHomeGreeting] = useState(() => pickHomeGreeting())
  const [homeTitleKey, setHomeTitleKey] = useState(0)
  const [attentionFilter, setAttentionFilter] = useState<'all' | SessionStatus>(
    'all',
  )
  const [attentionExpanded, setAttentionExpanded] = useState(false)
  const [navMode, setNavMode] = useState<NavMode>('sidebar')
  const [floatEnabled, setFloatEnabled] = useState(true)
  /** 原型专用:模拟"从未开过会话/终端"的空状态,用左下角 mock 开关切换 */
  const [demoEmpty, setDemoEmpty] = useState(false)
  const prevActiveRef = useRef<PageId | null>(null)

  const activeSessions = demoEmpty ? [] : sessions
  const activeTerminals = demoEmpty ? [] : terminals
  /** 无任何会话与终端 → Home 重排为欢迎页 */
  const isFreshHome = activeSessions.length === 0 && activeTerminals.length === 0

  /** 注意力优先:阻塞事件(按时间从新到旧,sessions 已排序) */
  const attentionEvents = activeSessions.filter(
    (s) => s.status === 'needs-you' || s.status === 'error',
  )
  const needsYouCount = attentionEvents.filter(
    (s) => s.status === 'needs-you',
  ).length
  const errorCount = attentionEvents.length - needsYouCount
  const liveCount = activeSessions.filter((s) => s.status !== 'exited').length

  const attentionFilters = [
    { id: 'all', label: '全部', count: attentionEvents.length },
    { id: 'needs-you', label: '待处理', count: needsYouCount },
    { id: 'error', label: '出错', count: errorCount },
  ] as const

  useEffect(() => {
    setDefaultTerminal(readDefaultTerminal())
  }, [])

  useEffect(() => {
    const prev = prevActiveRef.current
    prevActiveRef.current = active
    if (active !== 'home') return
    // 首次进入 / 从其他页回到 Home 时刷新文案
    if (prev !== null && prev !== 'home') {
      setHomeGreeting((current) => pickHomeGreeting(current.text))
      setHomeTitleKey((k) => k + 1)
    }
  }, [active])

  const closeNewSession = () => {
    setNewSessionOpen(false)
    setTerminalModalOpen(false)
    setCliModalOpen(false)
    setCliDraft(null)
    setActive('home')
  }

  const launchDefaultTerminal = () => {
    setNewSessionOpen(false)
    setActive('home')
  }

  const openTerminalEntry = () => {
    setRememberDefault(false)
    setTerminalModalOpen(true)
  }

  const openCliModal = (option: CliOption) => {
    setCliDraft({
      option,
      name: option.name,
      workspace: 'C:\\Users\\Jesse\\Desktop\\demo',
      args: option.defaultArgs,
      runtime: 'windows',
    })
    setCliModalOpen(true)
  }

  const pickTerminal = (id: TerminalId) => {
    if (rememberDefault) {
      try {
        localStorage.setItem(DEFAULT_TERMINAL_KEY, id)
      } catch {
        /* ignore */
      }
      setDefaultTerminal(id)
    }
    setTerminalModalOpen(false)
    setNewSessionOpen(false)
    setActive('home')
  }

  const confirmCli = () => {
    setCliModalOpen(false)
    setCliDraft(null)
    setNewSessionOpen(false)
    setActive('home')
  }

  const defaultTerminalName =
    terminalOptions.find((t) => t.id === defaultTerminal)?.name ?? 'PowerShell'

  const pickAttentionFilter = (id: 'all' | SessionStatus) => {
    setAttentionFilter(id)
    setAttentionExpanded(false)
  }

  const filteredAttention =
    attentionFilter === 'all'
      ? attentionEvents
      : attentionEvents.filter((event) => event.status === attentionFilter)
  const visibleAttention = attentionExpanded
    ? filteredAttention
    : filteredAttention.slice(0, ATTENTION_COLLAPSED_ROWS)

  const fieldClass =
    'w-full rounded-lg border border-black/8 bg-neutral-50 px-2.5 py-2 font-pingfang text-[12px] text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-300 focus:bg-white'

  return (
    <ClickSpark
      sparkColor="#1a1a1a"
      sparkSize={8}
      sparkRadius={18}
      sparkCount={10}
      duration={450}
    >
      <div className="flex h-svh items-center justify-center bg-neutral-200 p-3">
        <TargetCursor
          showCursor={false}
          hideDefaultCursor={false}
          spinDuration={2}
          parallaxOn
          hoverDuration={0.2}
          cursorColor="#B497CF"
          cursorColorOnTarget="#B497CF"
        />

        {/* 桌面程序外框 */}
        <div className="relative flex h-full w-full max-w-[1440px] flex-col overflow-hidden rounded-xl border border-black/8 bg-white shadow-2xl shadow-black/10">
        {/* 标题栏 */}
        <header className="flex h-10 shrink-0 items-center justify-between px-3 select-none">
          <div className="flex items-center gap-3 text-[13px] text-neutral-500">
            <span className="flex gap-1.5">
              <span className="inline-block size-3 rounded-full bg-neutral-300" />
              <span className="inline-block size-3 rounded-full bg-neutral-300" />
              <span className="inline-block size-3 rounded-full bg-neutral-300" />
            </span>
            {/* 占位菜单替换为实际功能入口:新建 / 设置 */}
            <nav className="flex items-center gap-1 font-pingfang">
              <button
                type="button"
                onClick={() => {
                  setActive('new')
                  setNewSessionOpen(true)
                }}
                className="cursor-target flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
              >
                <SquarePen className="size-3.5" strokeWidth={1.75} />
                新建
              </button>
              <button
                type="button"
                onClick={() => setActive('settings')}
                className={[
                  'cursor-target flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors',
                  active === 'settings'
                    ? 'bg-neutral-100 text-neutral-900'
                    : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800',
                ].join(' ')}
              >
                <Settings2 className="size-3.5" strokeWidth={1.75} />
                设置
              </button>
            </nav>
          </div>
          <div className="flex items-center gap-4 text-neutral-400">
            <span className="block h-px w-3 bg-current" />
            <span className="block size-2.5 border border-current" />
            <span className="relative block size-2.5">
              <span className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 rotate-45 bg-current" />
              <span className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 -rotate-45 bg-current" />
            </span>
          </div>
        </header>

        {/* 主体 */}
        <div className="relative flex min-h-0 flex-1">
          {navMode === 'rail' && (
            <IconRail
              active={active}
              onSelect={(id) => {
                setActive(id)
                if (id === 'new') setNewSessionOpen(true)
              }}
              onExpand={() => setNavMode('sidebar')}
              sessions={activeSessions}
              terminals={activeTerminals}
            />
          )}
          {navMode === 'sidebar' && (
          <aside className="flex w-[280px] shrink-0 flex-col bg-white px-3 pt-3">
            <div className="flex justify-center">
              <ShinyText
                text="vibing"
                color="#7a7a7a"
                shineColor="#1a1a1a"
                speed={3.2}
                spread={100}
                className="font-ammonite text-[26px] leading-none tracking-[0.08em]"
              />
            </div>

            <nav className="mt-4 flex flex-col gap-0.5">
              {navItems.map(({ id, label, icon: Icon }) => {
                const isActive = active === id
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setActive(id)
                      if (id === 'new') setNewSessionOpen(true)
                    }}
                    className={[
                      'cursor-target flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left font-pingfang transition-colors',
                      isActive
                        ? 'bg-neutral-100 text-neutral-900'
                        : 'text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800',
                    ].join(' ')}
                  >
                    <Icon
                      className="size-3.5 shrink-0 opacity-80"
                      strokeWidth={1.75}
                    />
                    <span className="text-[12px] font-medium tracking-wide">
                      {label}
                    </span>
                  </button>
                )
              })}
            </nav>

            <div className="sidebar-scroll mt-4 min-h-0 flex-1 overflow-y-auto pb-3">
              <p className="mb-1.5 px-1 text-[11px] font-medium tracking-wide text-neutral-400 font-pingfang">
                Session
              </p>
              {activeSessions.length === 0 && (
                <p className="px-1 py-0.5 font-pingfang text-[11px] text-neutral-300">
                  暂无会话
                </p>
              )}
              <ul className="flex flex-col gap-1.5">
                {activeSessions.map(({ id, cli, Icon, time, status, message }) => (
                  <li key={id}>
                    <button
                      type="button"
                      className="cursor-target w-full rounded-lg border border-black/6 bg-white px-2.5 py-1.5 text-left font-pingfang transition-colors hover:bg-neutral-50"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
                          <Icon size={14} className="size-3.5" />
                        </span>
                        <span className="text-[12px] font-semibold text-neutral-900">
                          {cli}
                        </span>
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${statusDot[status]}`}
                        />
                        <span className="ml-auto text-[11px] text-neutral-400">
                          {time}
                        </span>
                      </div>
                      <p
                        className={`mt-0.5 truncate text-[11px] leading-snug font-medium ${statusTone[status]}`}
                      >
                        {message}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>

              <p className="mt-4 mb-1.5 px-1 text-[11px] font-medium tracking-wide text-neutral-400 font-pingfang">
                Terminal
              </p>
              {activeTerminals.length === 0 && (
                <p className="px-1 py-0.5 font-pingfang text-[11px] text-neutral-300">
                  暂无终端
                </p>
              )}
              <ul className="flex flex-col gap-1">
                {activeTerminals.map((term) => (
                  <li key={term.id}>
                    <button
                      type="button"
                      className="cursor-target flex w-full items-center gap-2 rounded-lg border border-black/6 bg-white px-2.5 py-1.5 text-left font-pingfang transition-colors hover:bg-neutral-50"
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-neutral-800">
                        {term.name}
                      </span>
                      <span className="max-w-[40%] shrink-0 truncate text-[10px] text-neutral-400">
                        {term.cwd}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {/* 底部常驻:快速收起 */}
            <div className="flex items-center justify-end border-t border-black/5 py-2">
              <button
                type="button"
                title="收起侧栏"
                onClick={() => setNavMode('rail')}
                className="cursor-target flex size-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-50 hover:text-neutral-800"
              >
                <PanelLeftClose className="size-4" strokeWidth={1.75} />
              </button>
            </div>
          </aside>
          )}
          <main className="sidebar-scroll relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto rounded-tl-[20px] bg-[#f7f7f6]">
            {navMode === 'tabs' && (
              <TopTabBar
                sessions={activeSessions}
                terminals={activeTerminals}
                active={active}
                onSelect={(id) => {
                  setActive(id)
                  if (id === 'new') setNewSessionOpen(true)
                }}
              />
            )}
            {active === 'settings' ? (
              <SettingsPage
                navMode={navMode}
                onNavModeChange={setNavMode}
                floatEnabled={floatEnabled}
                onFloatEnabledChange={setFloatEnabled}
                defaultTerminal={defaultTerminal}
                onDefaultTerminalChange={(id) => {
                  try {
                    localStorage.setItem(DEFAULT_TERMINAL_KEY, id)
                  } catch {
                    /* ignore */
                  }
                  setDefaultTerminal(id as TerminalId)
                }}
                terminalOptions={terminalOptions}
              />
            ) : isFreshHome ? (
              /* 空状态:无会话/终端时 Home 重排为欢迎页,仅保留启动入口 */
              <div className="flex flex-1 flex-col items-center justify-center px-8 py-14">
                <p className="font-maple text-[10px] tracking-[0.28em] text-neutral-400 uppercase">
                  home · getting started
                </p>
                <div className="mt-5">
                  <ShinyText
                    text="vibing"
                    color="#7a7a7a"
                    shineColor="#1a1a1a"
                    speed={3.2}
                    spread={100}
                    className="font-ammonite text-[54px] leading-none tracking-[0.08em]"
                  />
                </div>
                <TextType
                  key={`welcome-${homeTitleKey}`}
                  as="h1"
                  text="Welcome. Pick a CLI and go."
                  keywords={['CLI']}
                  keywordColor={HOME_ACCENT}
                  typingSpeed={42}
                  initialDelay={160}
                  loop={false}
                  showCursor
                  cursorCharacter="|"
                  cursorClassName="text-neutral-400"
                  className="mt-6 text-center font-pingfang text-[24px] font-semibold leading-tight tracking-wide text-neutral-900"
                />
                <p className="mt-3 text-center font-pingfang text-[13px] text-neutral-500">
                  还没有会话。选一个入口开始，AI CLI 的状态与提醒会汇聚到这里。
                </p>

                <div className="mt-9 flex w-full max-w-[620px] flex-wrap justify-center gap-2">
                  {cliOptions.map((option, index) => {
                    const { id, name, Icon, hint } = option
                    const isTerminal = id === 'terminal'
                    return (
                      <motion.div
                        key={id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          delay: 0.3 + index * 0.05,
                          type: 'spring',
                          stiffness: 380,
                          damping: 30,
                        }}
                        className="cursor-target group relative w-[142px]"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (isTerminal) launchDefaultTerminal()
                            else openCliModal(option)
                          }}
                          className="flex w-full flex-col items-start gap-2.5 rounded-xl border border-black/8 bg-white p-3 text-left font-pingfang transition-colors hover:border-black/15 hover:bg-neutral-50"
                        >
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100">
                            <Icon size={16} className="size-4" />
                          </span>
                          <span className="w-full min-w-0">
                            <span className="block text-[12px] font-semibold text-neutral-900">
                              {name}
                            </span>
                            <span className="block truncate text-[10px] text-neutral-400">
                              {isTerminal ? `默认：${defaultTerminalName}` : hint}
                            </span>
                          </span>
                        </button>
                        {isTerminal && (
                          <button
                            type="button"
                            aria-label="终端选项"
                            title="终端选项"
                            onClick={openTerminalEntry}
                            className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-md text-neutral-400 opacity-0 transition-all hover:bg-neutral-200/70 hover:text-neutral-700 group-hover:opacity-100"
                          >
                            <Settings2 className="size-3" strokeWidth={1.75} />
                          </button>
                        )}
                      </motion.div>
                    )
                  })}
                </div>

                <p className="mt-11 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 font-maple text-[10px] text-neutral-400">
                  <span>启动后这里会汇聚</span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-pending-dot" />
                    待处理
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-error" />
                    出错
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-sky-500" />
                    运行中
                  </span>
                  <span>· 历史事件与 all-time 统计</span>
                </p>
              </div>
            ) : (
              <>
            {/* 头部:问候 + prompt 状态行;新建入口在标题栏/侧栏/快速启动,不再放主按钮 */}
            <header className="px-8 pt-10 pb-8">
              <div className="min-w-0">
                <p className="mb-3 font-maple text-[10px] tracking-[0.28em] text-neutral-400 uppercase">
                  home · session desk
                </p>
                <TextType
                  key={homeTitleKey}
                  as="h1"
                  text={homeGreeting.text}
                  keywords={homeGreeting.keywords}
                  keywordColor={HOME_ACCENT}
                  typingSpeed={42}
                  initialDelay={120}
                  loop={false}
                  showCursor
                  cursorCharacter="|"
                  cursorClassName="text-neutral-400"
                  className="font-pingfang text-[32px] font-semibold leading-tight tracking-wide text-neutral-900"
                />
                <p className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 font-maple text-[12px] leading-none">
                  <span aria-hidden className="select-none text-neutral-300">
                    $
                  </span>
                  <button
                    type="button"
                    onClick={() => pickAttentionFilter('needs-you')}
                    className="cursor-target text-pending decoration-dotted underline-offset-4 hover:underline"
                  >
                    {needsYouCount} waiting approval
                  </button>
                  <span className="select-none text-neutral-300">·</span>
                  <button
                    type="button"
                    onClick={() => pickAttentionFilter('error')}
                    className="cursor-target text-error decoration-dotted underline-offset-4 hover:underline"
                  >
                    {errorCount} errors
                  </button>
                  <span className="select-none text-neutral-300">·</span>
                  <button
                    type="button"
                    onClick={() => pickAttentionFilter('all')}
                    className="cursor-target text-emerald-700 decoration-dotted underline-offset-4 hover:underline"
                  >
                    {liveCount} live
                  </button>
                </p>
              </div>
            </header>

            {/* 快速启动:自动换行芯片 */}
            <section className="px-8 pb-8">
              <p className="mb-2.5 font-maple text-[10px] tracking-[0.22em] text-neutral-400 uppercase">
                quick launch
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {cliOptions.map((option) => {
                  const { id, name, Icon } = option
                  const isTerminal = id === 'terminal'
                  return (
                    <div
                      key={id}
                      className="cursor-target group flex shrink-0 items-center rounded-full border border-black/8 bg-white transition-colors hover:border-black/15 hover:bg-neutral-50"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (isTerminal) launchDefaultTerminal()
                          else openCliModal(option)
                        }}
                        className={[
                          'flex items-center gap-2 py-1.5 pl-1.5 font-pingfang',
                          isTerminal ? 'pr-1' : 'pr-3',
                        ].join(' ')}
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-neutral-100">
                          <Icon size={13} className="size-[13px]" />
                        </span>
                        <span className="text-[12px] font-medium whitespace-nowrap text-neutral-800">
                          {name}
                        </span>
                        {isTerminal && (
                          <span className="font-maple text-[10px] whitespace-nowrap text-neutral-400">
                            {defaultTerminalName}
                          </span>
                        )}
                      </button>
                      {isTerminal && (
                        <button
                          type="button"
                          aria-label="终端选项"
                          title="终端选项"
                          onClick={openTerminalEntry}
                          className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-neutral-400 opacity-70 transition-all hover:bg-neutral-200/70 hover:text-neutral-700 group-hover:opacity-100"
                        >
                          <Settings2 className="size-3" strokeWidth={1.75} />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>

            {/* 注意力优先:全宽任务队列 */}
            <section className="px-8 pb-8">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/6 pb-2.5">
                <div>
                  <p className="font-maple text-[10px] tracking-[0.22em] text-neutral-400 uppercase">
                    attn
                  </p>
                  <h2 className="mt-0.5 font-pingfang text-[13px] font-semibold text-neutral-800">
                    注意力优先
                  </h2>
                </div>
                <div className="flex items-center gap-0.5 rounded-lg bg-neutral-200/50 p-0.5">
                  {attentionFilters.map(({ id, label, count }) => {
                    const selected = attentionFilter === id
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => pickAttentionFilter(id)}
                        className={[
                          'cursor-target flex items-baseline gap-1.5 rounded-md px-2.5 py-1 font-pingfang text-[11px] font-medium transition-colors',
                          selected
                            ? 'bg-white text-neutral-900 shadow-sm shadow-black/5'
                            : 'text-neutral-500 hover:text-neutral-800',
                        ].join(' ')}
                      >
                        {label}
                        <span
                          className={`font-maple text-[10px] ${selected ? 'text-neutral-500' : 'text-neutral-400'}`}
                        >
                          {count}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
              <ul className="flex flex-col">
                {visibleAttention.map(
                  ({ id, cli, Icon, time, status, message }) => (
                    <li
                      key={id}
                      className="group relative border-b border-black/5 last:border-b-0"
                    >
                      <button
                        type="button"
                        className="cursor-target flex w-full items-center gap-3 py-3 text-left font-pingfang transition-colors hover:bg-neutral-200/30"
                      >
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${statusDot[status]}`}
                        />
                        <span className="inline-flex size-6 shrink-0 items-center justify-center">
                          <Icon size={15} className="size-[15px]" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800">
                          {message}
                        </span>
                        <span className="ml-auto hidden shrink-0 items-baseline gap-2 font-maple text-[10px] text-neutral-400 transition-opacity group-hover:opacity-0 sm:flex">
                          <span className="text-neutral-500">{cli}</span>
                          <span className={statusTone[status]}>
                            {statusLabel[status]}
                          </span>
                          <span>{time}</span>
                        </span>
                      </button>
                      {/* v1 只看不操作:hover 仅提供"查看"跳转到对应终端 */}
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
                        <button
                          type="button"
                          className="cursor-target rounded-md border border-black/8 bg-white px-2.5 py-1 font-pingfang text-[11px] font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
                        >
                          查看
                        </button>
                      </div>
                    </li>
                  ),
                )}
              </ul>
              {filteredAttention.length > ATTENTION_COLLAPSED_ROWS && (
                <button
                  type="button"
                  onClick={() => setAttentionExpanded((v) => !v)}
                  className="cursor-target mt-2.5 font-maple text-[11px] tracking-wide text-neutral-500 transition-colors hover:text-neutral-900"
                >
                  {attentionExpanded
                    ? '收起 ↑'
                    : `展开全部 ${filteredAttention.length} 条 ↓`}
                </button>
              )}
            </section>

            {/* 收尾:历史事件 + all-time 概览 */}
            <section className="grid grid-cols-1 gap-x-10 gap-y-8 px-8 pb-10 lg:grid-cols-5">
              <div className="min-w-0 lg:col-span-3">
                <div className="flex items-end justify-between gap-3 border-b border-black/6 pb-2.5">
                  <div>
                    <p className="font-maple text-[10px] tracking-[0.22em] text-neutral-400 uppercase">
                      log
                    </p>
                    <h2 className="mt-0.5 font-pingfang text-[13px] font-semibold text-neutral-800">
                      历史事件
                    </h2>
                  </div>
                  <span className="font-maple text-[10px] tracking-wide text-neutral-400">
                    tools · sessions
                  </span>
                </div>
                <ul className="flex flex-col">
                  {historyEvents.map(
                    ({ id, kind, cli, Icon, time, title, detail }) => (
                      <li
                        key={id}
                        className="border-b border-black/5 last:border-b-0"
                      >
                        <button
                          type="button"
                          className="cursor-target flex w-full items-start gap-3 py-2.5 text-left font-pingfang transition-colors hover:bg-neutral-200/30"
                        >
                          <span
                            className={`mt-1.5 size-1.5 shrink-0 rounded-full ${historyKindDot[kind]}`}
                          />
                          <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center opacity-80">
                            <Icon size={14} className="size-3.5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-2">
                              <span className="text-[12px] font-semibold text-neutral-900">
                                {cli}
                              </span>
                              <span
                                className={`truncate font-maple text-[10px] ${historyKindTone[kind]}`}
                              >
                                {title}
                              </span>
                              <span className="ml-auto shrink-0 font-maple text-[10px] text-neutral-400">
                                {time}
                              </span>
                            </span>
                            <span className="mt-0.5 block truncate font-maple text-[11px] leading-snug text-neutral-500">
                              {detail}
                            </span>
                          </span>
                        </button>
                      </li>
                    ),
                  )}
                </ul>
              </div>

              <div className="min-w-0 lg:col-span-2">
                <div className="flex items-end justify-between gap-3 border-b border-black/6 pb-2.5">
                  <div>
                    <p className="font-maple text-[10px] tracking-[0.22em] text-neutral-400 uppercase">
                      metrics
                    </p>
                    <h2 className="mt-0.5 font-pingfang text-[13px] font-semibold text-neutral-800">
                      概览
                    </h2>
                  </div>
                  <span className="font-maple text-[10px] tracking-wide text-neutral-400">
                    all time
                  </span>
                </div>
                <ul className="flex flex-col">
                  {homeStats.map(({ id, label, hint, value }, index) => (
                    <li
                      key={id}
                      className="flex items-baseline justify-between gap-3 border-b border-black/5 py-3 last:border-b-0"
                    >
                      <p className="flex items-baseline gap-2">
                        <span className="font-pingfang text-[12px] text-neutral-600">
                          {label}
                        </span>
                        <span className="font-maple text-[10px] tracking-wide text-neutral-400 uppercase">
                          {hint}
                        </span>
                      </p>
                      <p className="font-maple text-[20px] font-medium leading-none tracking-tight text-neutral-900">
                        <CountUp
                          to={value}
                          from={0}
                          duration={1.2}
                          delay={0.06 * index}
                          separator=","
                        />
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
              </>
            )}
          </main>
        </div>

        {/* 原型专用:左下角 mock 开关,切换"空状态/有会话"演示 */}
        <button
          type="button"
          onClick={() => setDemoEmpty((v) => !v)}
          className="cursor-target absolute bottom-3 left-3 z-30 rounded-full border border-dashed border-neutral-300 bg-white/85 px-2.5 py-1 font-maple text-[10px] text-neutral-400 backdrop-blur transition-colors hover:border-neutral-400 hover:text-neutral-700"
        >
          mock · {demoEmpty ? '空状态' : '有会话'}
        </button>

        {/* New Session bottom sheet — 覆盖整个窗口含标题栏 */}
        <AnimatePresence>
          {newSessionOpen && (
            <>
              <motion.button
                key="new-session-backdrop"
                type="button"
                aria-label="关闭"
                className="absolute inset-0 z-40 bg-black/25 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
                onClick={closeNewSession}
              />
              <motion.div
                key="new-session-sheet"
                className="pointer-events-none absolute inset-x-0 bottom-0 z-50 flex justify-center px-4"
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{
                  type: 'spring',
                  stiffness: 420,
                  damping: 36,
                  mass: 0.85,
                }}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="new-session-title"
                  className="pointer-events-auto flex w-full max-w-[420px] flex-col overflow-hidden rounded-t-2xl border border-black/8 border-b-0 bg-white shadow-2xl shadow-black/20"
                >
                  <div className="flex justify-center pt-2.5 pb-1">
                    <span className="h-1 w-9 rounded-full bg-neutral-200" />
                  </div>

                  <div className="flex items-center justify-between px-4 pb-2">
                    <div>
                      <h2
                        id="new-session-title"
                        className="font-pingfang text-[14px] font-semibold text-neutral-900"
                      >
                        New Session
                      </h2>
                      <p className="mt-0.5 font-pingfang text-[11px] text-neutral-400">
                        选择一个 AI CLI 开始
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={closeNewSession}
                      className="flex size-7 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                    >
                      <X className="size-3.5" strokeWidth={1.75} />
                    </button>
                  </div>

                  <ul className="sidebar-scroll flex max-h-[calc(3rem*6+0.25rem*5)] flex-col gap-1 overflow-y-auto px-3 pb-4">
                    {cliOptions.map((option) => {
                      const { id, name, Icon, hint } = option
                      return (
                      <li key={id} className="shrink-0">
                        <div className="cursor-target group flex h-12 items-center gap-0.5 rounded-xl transition-colors hover:bg-neutral-50">
                          <button
                            type="button"
                            onClick={() => {
                              if (id === 'terminal') launchDefaultTerminal()
                              else openCliModal(option)
                            }}
                            className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 text-left font-pingfang"
                          >
                            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100">
                              <Icon size={16} className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[12px] font-semibold text-neutral-900">
                                {name}
                              </span>
                              <span className="block truncate text-[11px] text-neutral-400">
                                {id === 'terminal'
                                  ? `默认：${defaultTerminalName}`
                                  : hint}
                              </span>
                            </span>
                          </button>
                          {id === 'terminal' && (
                            <button
                              type="button"
                              aria-label="终端选项"
                              title="终端选项"
                              onClick={(e) => {
                                e.stopPropagation()
                                openTerminalEntry()
                              }}
                              className="mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-neutral-400 opacity-70 transition-all hover:bg-neutral-200/70 hover:text-neutral-700 group-hover:opacity-100"
                            >
                              <Settings2 className="size-3.5" strokeWidth={1.75} />
                            </button>
                          )}
                        </div>
                      </li>
                      )
                    })}
                  </ul>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* 终端类型选择 Modal */}
        <AnimatePresence>
          {terminalModalOpen && (
            <>
              <motion.button
                key="terminal-modal-backdrop"
                type="button"
                aria-label="关闭"
                className="absolute inset-0 z-[60] bg-black/30 backdrop-blur-[3px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
                onClick={() => setTerminalModalOpen(false)}
              />
              <motion.div
                key="terminal-modal"
                className="pointer-events-none absolute inset-0 z-[70] flex items-center justify-center p-5"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                <motion.div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="terminal-modal-title"
                  className="pointer-events-auto w-full max-w-[380px] overflow-hidden rounded-2xl border border-black/8 bg-white shadow-2xl shadow-black/25"
                  initial={{ opacity: 0, scale: 0.94, y: 16 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: 10 }}
                  transition={{
                    type: 'spring',
                    stiffness: 480,
                    damping: 34,
                    mass: 0.8,
                  }}
                >
                <div className="flex items-start justify-between px-4 pt-4 pb-2">
                  <div>
                    <h2
                      id="terminal-modal-title"
                      className="font-pingfang text-[14px] font-semibold text-neutral-900"
                    >
                      选择终端
                    </h2>
                    <p className="mt-0.5 font-pingfang text-[11px] text-neutral-400">
                      点击一项即可启动
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTerminalModalOpen(false)}
                    className="flex size-7 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                  >
                    <X className="size-3.5" strokeWidth={1.75} />
                  </button>
                </div>

                <ul className="flex flex-col gap-1 px-3 py-1">
                  {terminalOptions.map(({ id, name, hint }) => {
                    const isDefault = defaultTerminal === id
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() => pickTerminal(id)}
                          className="cursor-target flex h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left font-pingfang text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="text-[12px] font-semibold">
                                {name}
                              </span>
                              {isDefault && (
                                <span className="rounded bg-neutral-200/80 px-1 py-px text-[9px] font-medium tracking-wide text-neutral-500">
                                  默认
                                </span>
                              )}
                            </span>
                            <span className="block truncate text-[11px] text-neutral-400">
                              {hint}
                            </span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>

                <label className="mx-3 mt-2 mb-3 flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 font-pingfang transition-colors hover:bg-neutral-50">
                  <input
                    type="checkbox"
                    checked={rememberDefault}
                    onChange={(e) => setRememberDefault(e.target.checked)}
                    className="size-3.5 rounded border-neutral-300 accent-neutral-900"
                  />
                  <span className="text-[12px] text-neutral-600">
                    下次默认以该方式启动
                  </span>
                </label>
                </motion.div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* CLI 配置 Modal */}
        <AnimatePresence>
          {cliModalOpen && cliDraft && (
            <>
              <motion.button
                key="cli-modal-backdrop"
                type="button"
                aria-label="关闭"
                className="absolute inset-0 z-[60] bg-black/30 backdrop-blur-[3px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
                onClick={() => {
                  setCliModalOpen(false)
                  setCliDraft(null)
                }}
              />
              <motion.div
                key="cli-modal"
                className="pointer-events-none absolute inset-0 z-[70] flex items-center justify-center p-5"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                <motion.div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="cli-modal-title"
                  className="pointer-events-auto w-full max-w-[420px] overflow-hidden rounded-2xl border border-black/8 bg-white shadow-2xl shadow-black/25"
                  initial={{ opacity: 0, scale: 0.94, y: 16 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: 10 }}
                  transition={{
                    type: 'spring',
                    stiffness: 480,
                    damping: 34,
                    mass: 0.8,
                  }}
                >
                  <div className="flex items-start justify-between px-4 pt-4 pb-3">
                    <div className="flex items-center gap-2.5">
                      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100">
                        {(() => {
                          const Icon = cliDraft.option.Icon
                          return <Icon size={16} className="size-4" />
                        })()}
                      </span>
                      <div>
                        <h2
                          id="cli-modal-title"
                          className="font-pingfang text-[14px] font-semibold text-neutral-900"
                        >
                          新建 {cliDraft.option.name}
                        </h2>
                        <p className="mt-0.5 font-pingfang text-[11px] text-neutral-400">
                          配置会话后启动
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setCliModalOpen(false)
                        setCliDraft(null)
                      }}
                      className="flex size-7 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                    >
                      <X className="size-3.5" strokeWidth={1.75} />
                    </button>
                  </div>

                  <div className="flex flex-col gap-3 px-4 pb-1">
                    <label className="flex flex-col gap-1 font-pingfang">
                      <span className="text-[11px] font-medium text-neutral-500">
                        名称
                      </span>
                      <input
                        type="text"
                        value={cliDraft.name}
                        onChange={(e) =>
                          setCliDraft((d) =>
                            d ? { ...d, name: e.target.value } : d,
                          )
                        }
                        placeholder="会话名称"
                        className={fieldClass}
                      />
                    </label>

                    <label className="flex flex-col gap-1 font-pingfang">
                      <span className="text-[11px] font-medium text-neutral-500">
                        工作区
                      </span>
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={cliDraft.workspace}
                          onChange={(e) =>
                            setCliDraft((d) =>
                              d ? { ...d, workspace: e.target.value } : d,
                            )
                          }
                          placeholder="C:\\path\\to\\project"
                          className={`${fieldClass} min-w-0 flex-1`}
                        />
                        <button
                          type="button"
                          title="选择文件夹"
                          onClick={() =>
                            setCliDraft((d) =>
                              d
                                ? {
                                    ...d,
                                    workspace: 'C:\\Users\\Jesse\\Desktop\\demo',
                                  }
                                : d,
                            )
                          }
                          className="flex size-[34px] shrink-0 items-center justify-center rounded-lg border border-black/8 bg-neutral-50 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
                        >
                          <FolderOpen className="size-3.5" strokeWidth={1.75} />
                        </button>
                      </div>
                    </label>

                    <label className="flex flex-col gap-1 font-pingfang">
                      <span className="text-[11px] font-medium text-neutral-500">
                        启动参数
                      </span>
                      <input
                        type="text"
                        value={cliDraft.args}
                        onChange={(e) =>
                          setCliDraft((d) =>
                            d ? { ...d, args: e.target.value } : d,
                          )
                        }
                        placeholder="--flag value"
                        spellCheck={false}
                        className={`${fieldClass} font-mono text-[11px]`}
                      />
                    </label>

                    <div className="flex flex-col gap-1.5 font-pingfang">
                      <span className="text-[11px] font-medium text-neutral-500">
                        版本
                      </span>
                      <div className="grid grid-cols-2 gap-1.5">
                        {cliRuntimeOptions.map(({ id, name, hint }) => {
                          const selected = cliDraft.runtime === id
                          return (
                            <button
                              key={id}
                              type="button"
                              onClick={() =>
                                setCliDraft((d) =>
                                  d ? { ...d, runtime: id } : d,
                                )
                              }
                              className={[
                                'cursor-target rounded-xl px-3 py-2.5 text-left transition-colors',
                                selected
                                  ? 'bg-neutral-900 text-white'
                                  : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200/80',
                              ].join(' ')}
                            >
                              <span className="block text-[12px] font-semibold">
                                {name}
                              </span>
                              <span
                                className={[
                                  'mt-0.5 block text-[10px]',
                                  selected
                                    ? 'text-white/60'
                                    : 'text-neutral-400',
                                ].join(' ')}
                              >
                                {hint}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-end gap-2 border-t border-black/6 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => {
                        setCliModalOpen(false)
                        setCliDraft(null)
                      }}
                      className="rounded-lg px-3 py-1.5 font-pingfang text-[12px] font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={confirmCli}
                      className="rounded-lg bg-neutral-900 px-3 py-1.5 font-pingfang text-[12px] font-medium text-white transition-colors hover:bg-neutral-800"
                    >
                      启动
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

        {/* 悬浮窗:独立置顶小窗(always-on-top)的应用内 mock */}
        <AnimatePresence>
          {floatEnabled && (
            <FloatWindow
              sessions={activeSessions}
              onClose={() => setFloatEnabled(false)}
            />
          )}
        </AnimatePresence>
      </div>
    </ClickSpark>
  )
}

export default App
