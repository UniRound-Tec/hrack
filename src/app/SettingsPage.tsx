import { Minus, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ShellOption } from '../../shared/ipc-contract'
import { appLocales, strings } from './strings'
import { getUiThemeRegistry } from './themeRuntime'
import { terminalThemes, type ThemeId } from '../terminal/themes'
import { useSettingsStore, type NavMode } from '../state/settingsStore'
import ClickSpark from './effects/ClickSpark'

const colorKeys = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite'
] as const

export default function SettingsPage({ shells }: { shells: readonly ShellOption[] }) {
  const settings = useSettingsStore()
  const registry = getUiThemeRegistry()
  const terminalTheme = terminalThemes[settings.terminalThemeId].terminal

  return (
    <ClickSpark sparkColor="var(--vib-accent-flame)" sparkSize={6} sparkRadius={16}>
      <section data-testid="settings-page" className="sidebar-scroll h-full overflow-y-auto">
        <header className="px-8 pt-10 pb-6">
          <p className="mb-3 font-maple text-[10px] tracking-[0.28em] text-text-faint uppercase">{strings.settings.preferences}</p>
          <h1 className="font-pingfang text-[32px] font-semibold text-text-primary">{strings.settings.title}</h1>
          <p className="mt-2 font-pingfang text-[12px] text-text-faint">{strings.settings.description}</p>
        </header>
        <div className="flex max-w-[560px] flex-col gap-7 px-8 pb-10">
          <Section label="appearance" title={strings.settings.sections.appearance}>
            <Row label={strings.settings.uiTheme} hint={strings.settings.uiThemeHint}>
              <div className="flex items-center gap-0.5 rounded-lg bg-control p-0.5">
                {registry.themes.map((theme) => <SegmentButton key={theme.id} selected={settings.uiThemeId === theme.id} onClick={() => settings.setUiTheme(theme.id)}>{theme.name}</SegmentButton>)}
                <SegmentButton selected={false} disabled title={strings.settings.darkDisabledHint}>{strings.settings.dark}</SegmentButton>
              </div>
            </Row>
            {registry.errors.length > 0 && <div data-testid="theme-load-errors" className="border-b border-border-faint py-3 text-[11px] text-status-error"><p className="font-semibold">{strings.settings.themeErrors}</p>{registry.errors.map((error) => <p key={error.filename} className="mt-1 font-maple">{error.filename}: {error.message}</p>)}</div>}
            <Row label={strings.settings.language} hint={strings.settings.languageHint}>
              <select data-testid="settings-language" value={settings.language} onChange={(event) => settings.setLanguage(event.target.value as typeof settings.language)} className={selectClass}>{appLocales.map((locale) => <option key={locale} value={locale}>{strings.settings.languages[locale]}</option>)}</select>
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
            <Row label={strings.settings.floatingWindow} hint={strings.settings.floatingWindowHint}><Toggle checked={false} disabled /></Row>
          </Section>

          <Section label="terminal" title={strings.settings.sections.terminal}>
            <div className="border-b border-border-faint py-3.5">
              <div className="flex items-center justify-between gap-6"><div><p className="text-[12px] font-medium text-text-secondary">{strings.settings.terminalTheme}</p><p className="mt-0.5 text-[11px] text-text-faint">{strings.settings.terminalThemeHint}</p></div><div className="flex rounded-lg bg-control p-0.5">{(['dark', 'light'] as ThemeId[]).map((themeId) => <SegmentButton key={themeId} testId={`settings-terminal-theme-${themeId}`} selected={settings.terminalThemeId === themeId} onClick={() => settings.setTerminalTheme(themeId)}>{themeId === 'dark' ? strings.settings.dark : strings.settings.light}</SegmentButton>)}</div></div>
              <div data-testid="terminal-theme-preview" className="mt-2.5 flex gap-[3px] overflow-hidden rounded-md">{colorKeys.map((key) => <span key={key} title={terminalTheme[key]} className="h-3.5 min-w-0 flex-1" style={{ background: terminalTheme[key] }} />)}</div>
            </div>
            <Row label={strings.settings.font} hint={strings.settings.fontHint}><span className="font-maple text-[12px] text-text-secondary">{strings.settings.mapleMono}</span></Row>
            <Row label={strings.settings.fontSize}><div className="flex items-center gap-0.5 rounded-lg bg-control p-0.5"><button type="button" data-testid="settings-font-decrease" aria-label={strings.settings.decreaseFontSize} onClick={() => settings.setFont(settings.fontFamily, Math.max(10, settings.fontSize - 1))} className="flex size-6 items-center justify-center rounded-md text-text-muted hover:bg-control-active"><Minus className="size-3" strokeWidth={1.75} /></button><span data-testid="settings-font-size" className="w-10 text-center font-maple text-[12px] text-text-secondary">{strings.settings.pixels(settings.fontSize)}</span><button type="button" data-testid="settings-font-increase" aria-label={strings.settings.increaseFontSize} onClick={() => settings.setFont(settings.fontFamily, Math.min(24, settings.fontSize + 1))} className="flex size-6 items-center justify-center rounded-md text-text-muted hover:bg-control-active"><Plus className="size-3" strokeWidth={1.75} /></button></div></Row>
            <Row label={strings.settings.ligatures} hint={strings.settings.ligaturesHint}><Toggle testId="settings-ligatures" checked={settings.ligatures} onChange={settings.setLigatures} /></Row>
          </Section>

          <Section label="session" title={strings.settings.sections.session}>
            <Row label={strings.settings.defaultTerminal} hint={strings.settings.defaultTerminalHint}><select data-testid="settings-default-terminal" value={shells.some((shell) => shell.id === settings.defaultTerminal) ? settings.defaultTerminal : shells[0]?.id ?? ''} disabled={shells.length === 0} onChange={(event) => settings.setDefaultTerminal(event.target.value)} className={selectClass}>{shells.map((shell) => <option key={shell.id} value={shell.id}>{shell.name}</option>)}</select></Row>
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
  return <button type="button" data-testid={testId} aria-pressed={selected} disabled={disabled} title={title} onClick={onClick} className={`rounded-md px-2.5 py-1 font-pingfang text-[11px] font-medium ${disabled ? 'cursor-not-allowed text-text-disabled' : selected ? 'bg-control-active text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}>{children}</button>
}

function Toggle({ checked, disabled, testId, onChange }: { checked: boolean; disabled?: boolean; testId?: string; onChange?: (value: boolean) => void }) {
  return <button type="button" data-testid={testId} role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange?.(!checked)} className={`relative h-[18px] w-8 rounded-full ${checked ? 'bg-button-primary' : 'bg-control'} ${disabled ? 'cursor-not-allowed opacity-55' : ''}`}><span className={`absolute top-[2px] left-0 size-3.5 rounded-full bg-surface shadow-sm transition-transform ${checked ? 'translate-x-[16px]' : 'translate-x-[2px]'}`} /></button>
}

const selectClass = 'rounded-lg border border-border-default bg-input px-2 py-1.5 font-pingfang text-[12px] text-text-secondary outline-none hover:bg-input-hover focus:border-input-focus disabled:opacity-50'
