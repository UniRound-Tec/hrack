import { useState, type ReactNode } from 'react'
import { Minus, Plus } from 'lucide-react'

export type NavMode = 'sidebar' | 'rail' | 'tabs'

interface TerminalOption {
  id: string
  name: string
  hint: string
}

function Section({
  label,
  title,
  children,
}: {
  label: string
  title: string
  children: ReactNode
}) {
  return (
    <section>
      <div className="border-b border-black/6 pb-2">
        <p className="font-maple text-[10px] tracking-[0.22em] text-neutral-400 uppercase">
          {label}
        </p>
        <h2 className="mt-0.5 font-pingfang text-[13px] font-semibold text-neutral-800">
          {title}
        </h2>
      </div>
      <div>{children}</div>
    </section>
  )
}

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-black/5 py-3.5 last:border-b-0">
      <div className="min-w-0">
        <p className="font-pingfang text-[12px] font-medium text-neutral-800">
          {label}
        </p>
        {hint && (
          <p className="mt-0.5 font-pingfang text-[11px] text-neutral-400">
            {hint}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={[
        'cursor-target relative h-[18px] w-8 rounded-full transition-colors',
        checked ? 'bg-neutral-900' : 'bg-neutral-300',
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-[2px] left-0 size-3.5 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-[16px]' : 'translate-x-[2px]',
        ].join(' ')}
      />
    </button>
  )
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (next: T) => void
  options: readonly {
    id: T
    label: string
    disabled?: boolean
    title?: string
  }[]
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-neutral-200/50 p-0.5">
      {options.map(({ id, label, disabled, title }) => {
        const selected = value === id
        return (
          <button
            key={id}
            type="button"
            disabled={disabled}
            title={title}
            onClick={() => onChange(id)}
            className={[
              'rounded-md px-2.5 py-1 font-pingfang text-[11px] font-medium transition-colors',
              disabled
                ? 'cursor-not-allowed text-neutral-400/70'
                : 'cursor-target',
              selected
                ? 'bg-white text-neutral-900 shadow-sm shadow-black/5'
                : disabled
                  ? ''
                  : 'text-neutral-500 hover:text-neutral-800',
            ].join(' ')}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

const selectClass =
  'cursor-target rounded-lg border border-black/8 bg-neutral-50 px-2 py-1.5 font-pingfang text-[12px] text-neutral-800 outline-none transition-colors hover:bg-white focus:border-neutral-300'

const languageOptions = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'zh-TW', label: '繁體中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
] as const

/** 终端 16 色配色方案(mock):独立于界面主题,对应 themes.ts 的 xterm ITheme */
const terminalThemes = [
  {
    id: 'dark',
    label: 'Dark',
    colors: [
      '#3b3b3b', '#ff6b6b', '#69d26e', '#f2c14e',
      '#6f9dff', '#c792ea', '#66d9e8', '#d6d6d6',
      '#6b6b6b', '#ff9191', '#8fe694', '#ffd97a',
      '#9ab8ff', '#ddb3f5', '#8ce8f4', '#ffffff',
    ],
  },
  {
    id: 'light',
    label: 'Light',
    colors: [
      '#3c3c3c', '#c94f4f', '#3f9e57', '#b8860b',
      '#3d6fc4', '#9a5bbf', '#3a9ea8', '#e8e8e8',
      '#8a8a8a', '#e07a73', '#67c283', '#d4a017',
      '#7aa0e0', '#bd8fdd', '#79c6d1', '#ffffff',
    ],
  },
] as const

type TerminalThemeId = (typeof terminalThemes)[number]['id']

/**
 * 设置页原型:布局与控件形态供评审;
 * M5.b 实现时各项直读写 settingsStore,此处仅本地 state。
 */
export default function SettingsPage({
  navMode,
  onNavModeChange,
  floatEnabled,
  onFloatEnabledChange,
  defaultTerminal,
  onDefaultTerminalChange,
  terminalOptions,
}: {
  navMode: NavMode
  onNavModeChange: (mode: NavMode) => void
  floatEnabled: boolean
  onFloatEnabledChange: (enabled: boolean) => void
  defaultTerminal: string
  onDefaultTerminalChange: (id: string) => void
  terminalOptions: readonly TerminalOption[]
}) {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [language, setLanguage] = useState<string>('zh-CN')
  const [fontSize, setFontSize] = useState(16)
  const [ligatures, setLigatures] = useState(true)
  const [terminalTheme, setTerminalTheme] = useState<TerminalThemeId>('dark')

  const activeTerminalTheme =
    terminalThemes.find((t) => t.id === terminalTheme) ?? terminalThemes[0]

  return (
    <>
      <header className="px-8 pt-10 pb-6">
        <p className="mb-3 font-maple text-[10px] tracking-[0.28em] text-neutral-400 uppercase">
          settings · preferences
        </p>
        <h1 className="font-pingfang text-[32px] font-semibold leading-tight tracking-wide text-neutral-900">
          设置
        </h1>
        <p className="mt-2 font-pingfang text-[12px] text-neutral-400">
          原型演示布局与控件形态;M5.b 实现时各项直读写 settingsStore。
        </p>
      </header>

      <div className="flex max-w-[560px] flex-col gap-7 px-8 pb-10">
        <Section label="appearance" title="外观">
          <Row label="界面主题" hint="外层 GUI 配色,与终端配色相互独立">
            <Segmented
              value={theme}
              onChange={setTheme}
              options={[
                { id: 'light', label: '浅色' },
                {
                  id: 'dark',
                  label: '深色',
                  disabled: true,
                  title: '原型未覆盖深色,视觉沿用 M4 内置深色主题',
                },
              ]}
            />
          </Row>
          <Row label="界面语言" hint="五语言 i18n 归 M5.c">
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className={selectClass}
            >
              {languageOptions.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </Row>
        </Section>

        <Section label="layout" title="布局">
          <Row label="导航模式" hint="三态互斥;顶部 Tab 模式无侧栏">
            <Segmented
              value={navMode}
              onChange={onNavModeChange}
              options={[
                { id: 'sidebar', label: '侧栏展开' },
                { id: 'rail', label: '侧栏收起' },
                { id: 'tabs', label: '顶部 Tab 栏' },
              ]}
            />
          </Row>
          <Row label="悬浮窗" hint="独立置顶小窗,聚合等待你的会话">
            <Toggle checked={floatEnabled} onChange={onFloatEnabledChange} />
          </Row>
        </Section>

        <Section label="terminal" title="终端">
          {/* 终端配色独立于界面主题,带 16 色预览 */}
          <div className="border-b border-black/5 py-3.5">
            <div className="flex items-center justify-between gap-6">
              <div className="min-w-0">
                <p className="font-pingfang text-[12px] font-medium text-neutral-800">
                  终端配色
                </p>
                <p className="mt-0.5 font-pingfang text-[11px] text-neutral-400">
                  16 色方案,独立于界面主题
                </p>
              </div>
              <div className="shrink-0">
                <Segmented
                  value={terminalTheme}
                  onChange={setTerminalTheme}
                  options={terminalThemes.map(({ id, label }) => ({
                    id,
                    label,
                  }))}
                />
              </div>
            </div>
            <div className="mt-2.5 flex gap-[3px] overflow-hidden rounded-md">
              {activeTerminalTheme.colors.map((color, index) => (
                <span
                  key={index}
                  title={color}
                  className="h-3.5 min-w-0 flex-1"
                  style={{ background: color }}
                />
              ))}
            </div>
          </div>
          <Row label="字体" hint="内嵌 Maple Mono v7.9,中文回退栈随平台">
            <span className="font-maple text-[12px] text-neutral-700">
              Maple Mono
            </span>
          </Row>
          <Row label="字号">
            <div className="flex items-center gap-0.5 rounded-lg bg-neutral-200/50 p-0.5">
              <button
                type="button"
                aria-label="减小字号"
                onClick={() => setFontSize((v) => Math.max(10, v - 1))}
                className="cursor-target flex size-6 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white hover:text-neutral-900"
              >
                <Minus className="size-3" strokeWidth={1.75} />
              </button>
              <span className="w-10 text-center font-maple text-[12px] text-neutral-800">
                {fontSize}px
              </span>
              <button
                type="button"
                aria-label="增大字号"
                onClick={() => setFontSize((v) => Math.min(24, v + 1))}
                className="cursor-target flex size-6 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white hover:text-neutral-900"
              >
                <Plus className="size-3" strokeWidth={1.75} />
              </button>
            </div>
          </Row>
          <Row label="连字" hint="=&gt; !== 等操作符合并渲染">
            <Toggle checked={ligatures} onChange={setLigatures} />
          </Row>
        </Section>

        <Section label="session" title="会话">
          <Row label="默认终端" hint="quick launch 的「终端」芯片按此启动">
            <select
              value={defaultTerminal}
              onChange={(e) => onDefaultTerminalChange(e.target.value)}
              className={selectClass}
            >
              {terminalOptions.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Row>
        </Section>
      </div>
    </>
  )
}
