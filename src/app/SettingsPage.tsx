import { Minus, Plus, RefreshCw } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import type { CliRuntimeError, ShellOption } from '../../shared/ipc-contract'
import { appLocales, useStrings } from './i18n'
import { getUiThemeRegistry, useThemeRegistryVersion } from './themeRuntime'
import { terminalThemeIds, terminalThemes } from '../terminal/themes'
import { useSettingsStore, defaultSettings, type NavMode } from '../state/settingsStore'
import ClickSpark from './effects/ClickSpark'
import Dropdown, { type DropdownOption } from './Dropdown'

const defaultFontFamily = defaultSettings.fontFamily

const colorKeys = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite'
] as const

interface SettingsPageProps {
  shells: readonly ShellOption[]
  cliCount: number
  cliScanning: boolean
  cliScanError: string | null
  cliRuntimeErrors: readonly CliRuntimeError[]
  onRefreshClis: () => void
}

export default function SettingsPage({
  shells,
  cliCount,
  cliScanning,
  cliScanError,
  cliRuntimeErrors,
  onRefreshClis
}: SettingsPageProps) {
  const settings = useSettingsStore()
  const strings = useStrings()
  // 主题热重载后注册表版本自增，订阅以重新读取当前注册表。
  useThemeRegistryVersion((state) => state.version)
  const registry = getUiThemeRegistry()
  const terminalTheme = terminalThemes[settings.terminalThemeId].terminal
  const themeGroups = {
    light: { id: 'light', label: strings.settings.light },
    dark: { id: 'dark', label: strings.settings.dark }
  } as const
  const byThemeType = (left: DropdownOption, right: DropdownOption): number =>
    (left.group?.id === 'light' ? 0 : 1) - (right.group?.id === 'light' ? 0 : 1)
  const uiThemeOptions = registry.themes.map((theme) => ({
    value: theme.id,
    label:
      theme.id === 'light'
        ? strings.settings.light
        : theme.id === 'dark'
          ? strings.settings.dark
          : theme.name,
    group: themeGroups[theme.type]
  })).sort(byThemeType)
  const terminalThemeOptions = terminalThemeIds.map((themeId) => terminalThemes[themeId]).map((theme) => ({
    value: theme.id,
    label:
      theme.id === 'light'
        ? strings.settings.light
        : theme.id === 'dark'
          ? strings.settings.dark
          : theme.name,
    group: themeGroups[theme.type]
  })).sort(byThemeType)

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.floatingWindowApi.onStateChanged((state) => {
      settings.setFloatEnabled(state.enabled)
    })
    void window.floatingWindowApi.getState().then((state) => {
      if (!cancelled) settings.setFloatEnabled(state.enabled)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [settings.setFloatEnabled])

  const changeLanguage = (value: string): void => {
    const locale = value as (typeof settings.language)
    settings.setLanguage(locale)
    // 托盘菜单是原生 UI：语言变更立即上报主进程同步文案。
    void window.appApi.setMainPrefs({ language: locale })
  }

  const changeGlobalShortcut = (enabled: boolean): void => {
    settings.setGlobalShortcutEnabled(enabled)
    void window.appApi.setMainPrefs({ globalShortcutEnabled: enabled })
  }

  const changeFloatingWindow = (enabled: boolean): void => {
    void window.floatingWindowApi.setEnabled(enabled).then((state) => {
      settings.setFloatEnabled(state.enabled)
    })
  }

  return (
    <ClickSpark sparkColor="var(--vib-accent-spark)" sparkSize={8} sparkRadius={18} sparkCount={10} duration={450}>
      <section data-testid="settings-page" className="sidebar-scroll h-full overflow-y-auto">
        <header className="px-8 pt-10 pb-6">
          <p className="mb-3 font-maple text-[10px] tracking-[0.28em] text-text-faint uppercase">{strings.settings.preferences}</p>
          <h1 className="font-pingfang text-[32px] font-semibold leading-tight tracking-wide text-text-primary">{strings.settings.title}</h1>
          <p className="mt-2 font-pingfang text-[12px] text-text-faint">{strings.settings.description}</p>
        </header>
        <div className="flex max-w-[560px] flex-col gap-7 px-8 pb-10">
          <Section label="appearance" title={strings.settings.sections.appearance}>
            <Row label={strings.settings.uiTheme} hint={strings.settings.uiThemeHint}>
              <Dropdown testId="settings-ui-theme" value={settings.uiThemeId} options={uiThemeOptions} onChange={settings.setUiTheme} />
            </Row>
            {registry.errors.length > 0 && <div data-testid="theme-load-errors" className="border-b border-border-faint py-3 text-[11px] text-status-error"><p className="font-semibold">{strings.settings.themeErrors}</p>{registry.errors.map((error) => <p key={error.filename} className="mt-1 font-maple">{error.filename}: {error.message}</p>)}</div>}
            <Row label={strings.settings.language} hint={strings.settings.languageHint}>
              <Dropdown testId="settings-language" value={settings.language} options={appLocales.map((locale) => ({ value: locale, label: strings.settings.languages[locale] }))} onChange={changeLanguage} />
            </Row>
          </Section>

          <Section label="layout" title={strings.settings.sections.layout}>
            <Row label={strings.settings.navigationMode} hint={strings.settings.navigationModeHint}>
              <div className="flex items-center gap-0.5 rounded-lg bg-control p-0.5">
                {([
                  ['sidebar', strings.settings.sidebar],
                  ['rail', strings.settings.rail],
                  ['tabs', strings.settings.tabs]
                ] as const).map(([mode, label]) => <SegmentButton key={mode} testId={`settings-nav-${mode}`} selected={settings.navMode === mode} onClick={() => settings.setNavMode(mode)}>{label}</SegmentButton>)}
              </div>
            </Row>
            <Row label={strings.settings.globalShortcut} hint={strings.settings.globalShortcutHint}><Toggle testId="settings-global-shortcut" checked={settings.globalShortcutEnabled} onChange={changeGlobalShortcut} /></Row>
            <Row label={strings.settings.floatingWindow} hint={strings.settings.floatingWindowHint}><Toggle testId="settings-floating-window" checked={settings.floatEnabled} onChange={changeFloatingWindow} /></Row>
          </Section>

          <Section label="terminal" title={strings.settings.sections.terminal}>
            <div className="border-b border-border-faint py-3.5">
              <div className="flex items-center justify-between gap-6"><div className="min-w-0"><p className="font-pingfang text-[12px] font-medium text-text-secondary">{strings.settings.terminalTheme}</p><p className="mt-0.5 font-pingfang text-[11px] text-text-faint">{strings.settings.terminalThemeHint}</p></div><Dropdown testId="settings-terminal-theme" value={settings.terminalThemeId} options={terminalThemeOptions} onChange={(value) => settings.setTerminalTheme(value as typeof settings.terminalThemeId)} /></div>
              <div data-testid="terminal-theme-preview" className="mt-2.5 flex gap-[3px] overflow-hidden rounded-md">{colorKeys.map((key) => <span key={key} title={terminalTheme[key]} className="h-3.5 min-w-0 flex-1" style={{ background: terminalTheme[key] }} />)}</div>
            </div>
            <Row label={strings.settings.font} hint={strings.settings.fontHint}>
              <div className="flex shrink-0 items-center gap-1.5">
                <input
                  data-testid="settings-font-input"
                  type="text"
                  value={settings.fontFamily}
                  placeholder={strings.settings.fontPlaceholder}
                  spellCheck={false}
                  onChange={(event) => settings.setFont(event.target.value, settings.fontSize)}
                  className="w-[220px] rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px] text-text-secondary outline-none transition-colors placeholder:text-text-faint focus:border-input-focus focus:bg-input-hover"
                />
                <button
                  type="button"
                  data-testid="settings-font-reset"
                  title={strings.settings.restoreDefaultFont}
                  onClick={() => settings.setFont(defaultFontFamily, settings.fontSize)}
                  className="cursor-target rounded-lg border border-border-default bg-input px-2 py-1.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary"
                >
                  {strings.settings.restoreDefaultFont}
                </button>
              </div>
            </Row>
            <Row label={strings.settings.fontSize}><div className="flex items-center gap-0.5 rounded-lg bg-control p-0.5"><button type="button" data-testid="settings-font-decrease" aria-label={strings.settings.decreaseFontSize} onClick={() => settings.setFont(settings.fontFamily, Math.max(10, settings.fontSize - 1))} className="cursor-target flex size-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-control-active hover:text-text-primary"><Minus className="size-3" strokeWidth={1.75} /></button><span data-testid="settings-font-size" className="w-10 text-center font-maple text-[12px] text-text-secondary">{strings.settings.pixels(settings.fontSize)}</span><button type="button" data-testid="settings-font-increase" aria-label={strings.settings.increaseFontSize} onClick={() => settings.setFont(settings.fontFamily, Math.min(24, settings.fontSize + 1))} className="cursor-target flex size-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-control-active hover:text-text-primary"><Plus className="size-3" strokeWidth={1.75} /></button></div></Row>
            <Row label={strings.settings.ligatures} hint={strings.settings.ligaturesHint}><Toggle testId="settings-ligatures" checked={settings.ligatures} onChange={settings.setLigatures} /></Row>
            <Row label={strings.settings.terminalRounded} hint={strings.settings.terminalRoundedHint}><Toggle testId="settings-terminal-rounded" checked={settings.terminalRounded} onChange={settings.setTerminalRounded} /></Row>
          </Section>

          <Section label="session" title={strings.settings.sections.session}>
            <Row label={strings.settings.attentionPriority} hint={strings.settings.attentionPriorityHint}><Toggle testId="settings-attention-priority" checked={settings.attentionPriorityEnabled} onChange={settings.setAttentionPriorityEnabled} /></Row>
            <Row label={strings.settings.defaultTerminal} hint={strings.settings.defaultTerminalHint}><Dropdown testId="settings-default-terminal" direction="up" value={shells.some((shell) => shell.id === settings.defaultTerminal) ? settings.defaultTerminal : shells[0]?.id ?? ''} disabled={shells.length === 0} options={shells.map((shell) => ({ value: shell.id, label: shell.name }))} onChange={(value) => settings.setDefaultTerminal(value)} /></Row>
            <Row
              label={strings.settings.cliDiscovery}
              hint={cliScanning
                ? strings.newSession.scanningClis
                : cliScanError ?? (cliCount === 0
                  ? strings.newSession.noClisFound
                  : strings.newSession.clisFound(cliCount))}
            >
              <button
                type="button"
                data-testid="settings-cli-refresh"
                disabled={cliScanning}
                aria-busy={cliScanning}
                onClick={onRefreshClis}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary disabled:cursor-wait disabled:opacity-70"
              >
                <RefreshCw className={`size-3 ${cliScanning ? 'animate-spin' : ''}`} strokeWidth={1.75} />
                {strings.newSession.refreshClis}
              </button>
            </Row>
            {!cliScanning && cliRuntimeErrors.length > 0 && (
              <details className="border-b border-border-faint py-3 font-pingfang text-[11px]">
                <summary className="cursor-pointer text-status-error">
                  {strings.newSession.partialScanErrors(cliRuntimeErrors.length)}
                </summary>
                <ul className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border-default bg-surface-strong p-2 text-text-muted">
                  {cliRuntimeErrors.map((item, index) => (
                    <li key={`${item.detail}-${index}`} className="break-words py-1">
                      {item.detail}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Section>
        </div>
      </section>
    </ClickSpark>
  )
}

function Section({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return <section><div className="border-b border-border-subtle pb-2"><p className="font-maple text-[10px] tracking-[0.22em] text-text-faint uppercase">{label}</p><h2 className="mt-0.5 font-pingfang text-[13px] font-semibold text-text-secondary">{title}</h2></div>{children}</section>
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="flex items-center justify-between gap-6 border-b border-border-faint py-3.5 last:border-b-0"><div className="min-w-0"><p className="font-pingfang text-[12px] font-medium text-text-secondary">{label}</p>{hint && <p className="mt-0.5 font-pingfang text-[11px] text-text-faint">{hint}</p>}</div><div className="shrink-0">{children}</div></div>
}

function SegmentButton({ selected, disabled, title, testId, onClick, children }: { selected: boolean; disabled?: boolean; title?: string; testId?: string; onClick?: () => void; children: ReactNode }) {
  return <button type="button" data-testid={testId} aria-pressed={selected} disabled={disabled} title={title} onClick={onClick} className={`rounded-md px-2.5 py-1 font-pingfang text-[11px] font-medium transition-colors ${disabled ? 'cursor-not-allowed text-text-disabled' : selected ? 'cursor-target bg-control-active text-text-primary shadow-sm' : 'cursor-target text-text-muted hover:text-text-secondary'}`}>{children}</button>
}

function Toggle({ checked, disabled, testId, onChange }: { checked: boolean; disabled?: boolean; testId?: string; onChange?: (value: boolean) => void }) {
  return <button type="button" data-testid={testId} role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange?.(!checked)} className={`relative h-[18px] w-8 rounded-full transition-colors ${checked ? 'bg-button-primary' : 'bg-border-control'} ${disabled ? 'cursor-not-allowed opacity-55' : 'cursor-target'}`}><span className={`absolute top-[2px] left-0 size-3.5 rounded-full bg-surface shadow-sm transition-transform ${checked ? 'translate-x-[16px]' : 'translate-x-[2px]'}`} /></button>
}
