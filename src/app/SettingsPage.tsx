import { Check, Copy, Minus, Plus, RefreshCw, Save } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  CliRuntimeError,
  ShellOption,
  UpdateSnapshot
} from '../../shared/ipc-contract'
import type {
  DshRuntimeConfig,
  DshRuntimePreference,
  DshRuntimeScanReport
} from '../../shared/dsh-ipc'
import type { FloatingWindowState } from '../../shared/floating-window'
import {
  CUSTOM_UI_THEME_ID,
  validateUiTheme
} from '../../shared/theme-schema'
import { appLocales, useStrings } from './i18n'
import { getUiThemeRegistry, useThemeRegistryVersion } from './themeRuntime'
import { terminalThemeIds, terminalThemes } from '../terminal/themes'
import { useSettingsStore, defaultSettings, type NavMode } from '../state/settingsStore'
import ClickSpark from './effects/ClickSpark'
import Dropdown, { type DropdownOption } from './Dropdown'
import floatingRendererSkill from '../../resources/skills/create-hrack-floating-renderer/SKILL.md?raw'
import themeSkill from '../../resources/skills/create-hrack-theme/SKILL.md?raw'

const defaultFontFamily = defaultSettings.fontFamily

const defaultCustomThemeSource = JSON.stringify({
  id: CUSTOM_UI_THEME_ID,
  name: 'HRack Custom',
  type: 'dark',
  colors: {},
  terminal: null
}, null, 2)

const colorKeys = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite'
] as const

function dshPreferenceValue(config: DshRuntimeConfig | null): string {
  const preference = config?.runtimePreference
  return preference?.kind === 'installation'
    ? preference.installationId
    : preference?.kind ?? 'auto'
}

interface SettingsPageProps {
  shells: readonly ShellOption[]
  cliCount: number
  cliScanning: boolean
  cliScanError: string | null
  cliRuntimeErrors: readonly CliRuntimeError[]
  onRefreshClis: () => void
  dshRuntimeReport: DshRuntimeScanReport | null
  dshRuntimeScanning: boolean
  dshRuntimeScanError: string | null
  onRefreshDshRuntimes: () => void
}

export default function SettingsPage({
  shells,
  cliCount,
  cliScanning,
  cliScanError,
  cliRuntimeErrors,
  onRefreshClis,
  dshRuntimeReport,
  dshRuntimeScanning,
  dshRuntimeScanError,
  onRefreshDshRuntimes
}: SettingsPageProps) {
  const settings = useSettingsStore()
  const strings = useStrings()
  const [dshConfig, setDshConfig] = useState<DshRuntimeConfig | null>(null)
  const [dshRuntimeChanging, setDshRuntimeChanging] = useState(false)
  const [dshRuntimeActionError, setDshRuntimeActionError] =
    useState<string | null>(null)
  const [updateSnapshot, setUpdateSnapshot] =
    useState<UpdateSnapshot | null>(null)
  const [floatingState, setFloatingState] =
    useState<FloatingWindowState | null>(null)
  const [floatingActionError, setFloatingActionError] =
    useState<string | null>(null)
  const [floatingSkillCopied, setFloatingSkillCopied] = useState(false)
  const [themeJson, setThemeJson] = useState('')
  const themeJsonRef = useRef('')
  const [themeJsonDirty, setThemeJsonDirty] = useState(false)
  const themeJsonDirtyRef = useRef(false)
  const [themeJsonSaving, setThemeJsonSaving] = useState(false)
  const [themeJsonSaved, setThemeJsonSaved] = useState(false)
  const [themeJsonError, setThemeJsonError] = useState<string | null>(null)
  const [themeSkillCopied, setThemeSkillCopied] = useState(false)
  const dshRuntimeBusy = dshRuntimeScanning || dshRuntimeChanging
  const dshRuntimeError = dshRuntimeActionError ?? dshRuntimeScanError
  const themeRegistryVersion = useThemeRegistryVersion((state) => state.version)
  const registry = getUiThemeRegistry()
  const customUiTheme = registry.get(CUSTOM_UI_THEME_ID)
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
  const dshRuntimeOptions: DropdownOption[] = [
    { value: 'auto', label: strings.dsh.runtimeAuto },
    ...(dshRuntimeReport?.candidates.map((candidate) => {
      if (candidate.kind === 'bundled') {
        return {
          value: candidate.id,
          label: strings.dsh.runtimeBundled(candidate.version)
        }
      }
      const location = candidate.runtime.kind === 'wsl'
        ? `WSL · ${candidate.runtime.distro}`
        : candidate.runtime.platform === 'windows'
          ? 'Windows'
          : candidate.runtime.platform === 'macos'
            ? 'macOS'
            : 'Linux'
      return {
        value: candidate.id,
        label: strings.dsh.runtimeLocal(location, candidate.version)
      }
    }) ?? [])
  ]
  const selectedDshRuntime = dshPreferenceValue(dshConfig)
  if (
    dshConfig?.runtimePreference.kind === 'installation' &&
    !dshRuntimeOptions.some((option) => option.value === selectedDshRuntime)
  ) {
    dshRuntimeOptions.push({
      value: selectedDshRuntime,
      label: strings.dsh.runtimeMissing
    })
  }

  useEffect(() => {
    const source = customUiTheme
      ? JSON.stringify(customUiTheme, null, 2)
      : defaultCustomThemeSource
    themeJsonRef.current = source
    setThemeJson(source)
    themeJsonDirtyRef.current = false
    setThemeJsonDirty(false)
    setThemeJsonSaved(false)
    setThemeJsonError(null)
  }, [themeRegistryVersion])

  useEffect(() => {
    let cancelled = false
    void window.dshApi.getConfig()
      .then((config) => {
        if (!cancelled) setDshConfig(config)
      })
      .catch((error) => {
        if (!cancelled) {
          setDshRuntimeActionError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.floatingWindowApi.onStateChanged((state) => {
      setFloatingState(state)
      settings.setFloatEnabled(state.enabled)
    })
    void window.floatingWindowApi.getState().then((state) => {
      if (!cancelled) {
        setFloatingState(state)
        settings.setFloatEnabled(state.enabled)
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [settings.setFloatEnabled])

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.updateApi.onStateChanged(setUpdateSnapshot)
    void window.updateApi.getState().then((snapshot) => {
      if (!cancelled) setUpdateSnapshot(snapshot)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const changeUiTheme = (themeId: string): void => {
    setThemeJsonError(null)
    settings.setUiTheme(themeId)
  }

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
    setFloatingActionError(null)
    void window.floatingWindowApi
      .setEnabled(enabled)
      .then((state) => {
        setFloatingState(state)
        settings.setFloatEnabled(state.enabled)
      })
      .catch((error) => {
        setFloatingActionError(
          error instanceof Error ? error.message : String(error)
        )
      })
  }

  const changeFloatingRenderer = (rendererId: string): void => {
    setFloatingActionError(null)
    void window.floatingWindowApi
      .setRenderer(rendererId)
      .then(setFloatingState)
      .catch((error) => {
        setFloatingActionError(
          error instanceof Error ? error.message : String(error)
        )
      })
  }

  const changeFloatingAttentionEffect = (enabled: boolean): void => {
    setFloatingActionError(null)
    void window.floatingWindowApi
      .setAttentionEffectEnabled(enabled)
      .then(setFloatingState)
      .catch((error) => {
        setFloatingActionError(
          error instanceof Error ? error.message : String(error)
        )
      })
  }

  const changeFloatingScale = (value: string): void => {
    setFloatingActionError(null)
    void window.floatingWindowApi
      .setScale(Number(value))
      .then(setFloatingState)
      .catch((error) => {
        setFloatingActionError(
          error instanceof Error ? error.message : String(error)
        )
      })
  }

  const refreshFloatingRenderers = (): void => {
    setFloatingActionError(null)
    void window.floatingWindowApi
      .refreshRenderers()
      .then(setFloatingState)
      .catch((error) => {
        setFloatingActionError(
          error instanceof Error ? error.message : String(error)
        )
      })
  }

  const copyFloatingRendererSkill = (): void => {
    setFloatingActionError(null)
    void window.clipboardApi
      .writeText(floatingRendererSkill.trim())
      .then(() => setFloatingSkillCopied(true))
      .catch((error) => {
        setFloatingSkillCopied(false)
        setFloatingActionError(
          error instanceof Error ? error.message : String(error)
        )
      })
  }

  const resetThemeJson = (): void => {
    const source = customUiTheme
      ? JSON.stringify(customUiTheme, null, 2)
      : defaultCustomThemeSource
    themeJsonRef.current = source
    setThemeJson(source)
    themeJsonDirtyRef.current = false
    setThemeJsonDirty(false)
    setThemeJsonSaved(false)
    setThemeJsonError(null)
  }

  const copyThemeSkill = (): void => {
    setThemeJsonError(null)
    void window.clipboardApi
      .writeText(themeSkill.trim())
      .then(() => setThemeSkillCopied(true))
      .catch((error) => {
        setThemeSkillCopied(false)
        setThemeJsonError(error instanceof Error ? error.message : String(error))
      })
  }

  const saveThemeJson = (): void => {
    setThemeJsonSaving(true)
    setThemeJsonSaved(false)
    setThemeJsonError(null)
    let parsed: unknown
    try {
      parsed = JSON.parse(themeJsonRef.current)
    } catch {
      setThemeJsonSaving(false)
      setThemeJsonError(strings.settings.themeJsonInvalid)
      return
    }
    const validation = validateUiTheme(parsed)
    if (!validation.ok) {
      setThemeJsonSaving(false)
      setThemeJsonError(validation.errors.join('; '))
      return
    }
    if (validation.theme.id !== CUSTOM_UI_THEME_ID) {
      setThemeJsonSaving(false)
      setThemeJsonError(strings.settings.themeJsonCustomId)
      return
    }
    const source = JSON.stringify(validation.theme, null, 2)
    void window.themeApi
      .saveCustom(source)
      .then(() => {
        themeJsonRef.current = source
        setThemeJson(source)
        themeJsonDirtyRef.current = false
        setThemeJsonDirty(false)
        setThemeJsonSaved(true)
      })
      .catch((error) => {
        setThemeJsonError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setThemeJsonSaving(false))
  }

  const changeDshRuntime = (value: string): void => {
    const preference: DshRuntimePreference = value === 'auto'
      ? { kind: 'auto' }
      : value === 'bundled'
        ? { kind: 'bundled' }
        : { kind: 'installation', installationId: value }
    setDshRuntimeChanging(true)
    setDshRuntimeActionError(null)
    void window.dshApi.setRuntime(preference)
      .then((status) => {
        if (status.state === 'failed') {
          throw new Error(status.error ?? strings.dsh.runtimeScanFailed)
        }
        return window.dshApi.getConfig()
      })
      .then(setDshConfig)
      .catch((error) => {
        setDshRuntimeActionError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setDshRuntimeChanging(false))
  }

  const updateStatus = (() => {
    if (!updateSnapshot) return strings.settings.updateLoading
    switch (updateSnapshot.phase) {
      case 'disabled':
        return strings.settings.updateDisabled
      case 'idle':
        return strings.settings.updateIdle
      case 'checking':
        return strings.settings.updateChecking
      case 'available':
        return strings.settings.updateAvailable(updateSnapshot.availableVersion ?? '')
      case 'downloading':
        return strings.settings.updateDownloading(
          updateSnapshot.availableVersion ?? '',
          Math.round(updateSnapshot.progress?.percent ?? 0)
        )
      case 'downloaded':
        return strings.settings.updateDownloaded(updateSnapshot.availableVersion ?? '')
      case 'up-to-date':
        return strings.settings.updateUpToDate
      case 'error':
        return strings.settings.updateError(updateSnapshot.error ?? '')
    }
  })()
  const updateBusy =
    !updateSnapshot ||
    updateSnapshot.phase === 'disabled' ||
    updateSnapshot.phase === 'checking' ||
    updateSnapshot.phase === 'downloading'
  const updateActionLabel = updateSnapshot?.phase === 'downloaded'
    ? strings.settings.updateRestart
    : updateSnapshot?.phase === 'available' ||
        (updateSnapshot?.phase === 'error' && updateSnapshot.availableVersion)
      ? strings.settings.updateDownload
      : strings.settings.updateCheck
  const runUpdateAction = (): void => {
    if (!updateSnapshot || updateBusy) return
    const action = updateSnapshot.phase === 'downloaded'
      ? window.updateApi.install()
      : updateSnapshot.phase === 'available' ||
          (updateSnapshot.phase === 'error' && updateSnapshot.availableVersion)
        ? window.updateApi.download()
        : window.updateApi.check()
    void action.catch(() => {})
  }

  return (
    <ClickSpark sparkColor="var(--hrack-accent-spark)" sparkSize={8} sparkRadius={18} sparkCount={10} duration={450}>
      <section data-testid="settings-page" className="sidebar-scroll h-full overflow-y-auto">
        <header className="px-8 pt-10 pb-6">
          <p className="mb-3 font-maple text-[10px] tracking-[0.28em] text-text-faint uppercase">{strings.settings.preferences}</p>
          <h1 className="font-pingfang text-[32px] font-semibold leading-tight tracking-wide text-text-primary">{strings.settings.title}</h1>
          <p className="mt-2 font-pingfang text-[12px] text-text-faint">{strings.settings.description}</p>
        </header>
        <div className="flex max-w-[560px] flex-col gap-7 px-8 pb-10">
          <Section label="appearance" title={strings.settings.sections.appearance}>
            <Row label={strings.settings.uiTheme} hint={strings.settings.uiThemeHint}>
              <Dropdown testId="settings-ui-theme" value={settings.uiThemeId} options={uiThemeOptions} onChange={changeUiTheme} />
            </Row>
            {registry.errors.length > 0 && <div data-testid="theme-load-errors" className="border-b border-border-faint py-3 text-[11px] text-status-error"><p className="font-semibold">{strings.settings.themeErrors}</p>{registry.errors.map((error) => <p key={error.filename} className="mt-1 font-maple">{error.filename}: {error.message}</p>)}</div>}
            <div data-testid="settings-theme-json" className="border-b border-border-faint py-3.5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-pingfang text-[12px] font-medium text-text-secondary">{strings.settings.themeJson}</p>
                  <p className="mt-0.5 font-pingfang text-[11px] text-text-faint">{strings.settings.themeJsonHint}</p>
                </div>                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="settings-theme-json-reset"
                    title={strings.settings.themeJsonReset}
                    aria-label={strings.settings.themeJsonReset}
                    disabled={!themeJsonDirty || themeJsonSaving}
                    onClick={resetThemeJson}
                    className="inline-flex size-[30px] items-center justify-center rounded-lg border border-border-default bg-input text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw className="size-3" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    data-testid="settings-theme-copy-skill"
                    title={strings.settings.themeSkillCopy}
                    aria-label={strings.settings.themeSkillCopy}
                    onClick={copyThemeSkill}
                    className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-border-default bg-input px-2.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary"
                  >
                    {themeSkillCopied
                      ? <Check className="size-3 text-status-done" strokeWidth={1.75} />
                      : <Copy className="size-3" strokeWidth={1.75} />}
                    {themeSkillCopied
                      ? strings.settings.themeSkillCopied
                      : strings.settings.themeSkillCopy}
                  </button>
                  <button
                    type="button"
                    data-testid="settings-theme-json-save"
                    disabled={themeJsonSaving}
                    aria-busy={themeJsonSaving}
                    onClick={saveThemeJson}
                    className="inline-flex h-[30px] items-center gap-1.5 rounded-lg bg-button-primary px-2.5 font-pingfang text-[11px] font-medium text-button-primary-fg transition-colors hover:bg-button-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Save className="size-3" strokeWidth={1.75} />
                    {themeJsonSaving
                      ? strings.settings.themeJsonSaving
                      : strings.settings.themeJsonSave}
                  </button>
                </div>
              </div>
              <textarea
                data-testid="settings-theme-json-input"
                value={themeJson}
                spellCheck={false}
                aria-invalid={themeJsonError ? 'true' : 'false'}
                onChange={(event) => {
                  themeJsonRef.current = event.target.value
                  setThemeJson(event.target.value)
                  themeJsonDirtyRef.current = true
                  setThemeJsonDirty(true)
                  setThemeJsonSaved(false)
                  setThemeJsonError(null)
                }}
                className="mt-3 h-56 w-full resize-y rounded-lg border border-border-default bg-input px-3 py-2 font-maple text-[11px] leading-5 text-text-secondary outline-none transition-colors focus:border-input-focus focus:bg-input-hover"
              />
              {(themeJsonError || themeJsonSaved) && (
                <p
                  data-testid="settings-theme-json-status"
                  className={`mt-2 break-words font-pingfang text-[11px] ${themeJsonError ? 'text-status-error' : 'text-status-done'}`}
                >
                  {themeJsonError ?? strings.settings.themeJsonSaved}
                </p>
              )}
            </div>
            <Row label={strings.settings.language} hint={strings.settings.languageHint}>
              <Dropdown testId="settings-language" value={settings.language} options={appLocales.map((locale) => ({ value: locale, label: strings.settings.languages[locale] }))} onChange={changeLanguage} />
            </Row>
            <Row label={strings.dsh.surfaceScale} hint={strings.dsh.surfaceScaleHint}>
              <Dropdown
                testId="dsh-surface-scale"
                value={String(settings.dshScale)}
                options={[
                  { value: '0.8', label: '80%' },
                  { value: '0.9', label: '90%' },
                  { value: '1', label: '100%' },
                  { value: '1.1', label: '110%' }
                ]}
                buttonClassName="min-w-[100px]"
                onChange={(value) => settings.setDshScale(Number(value))}
              />
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
            <Row
              label={strings.settings.floatingRenderer}
              hint={floatingActionError ?? floatingState?.activeError ?? strings.settings.floatingRendererHint}
            >
              <div className="flex max-w-[390px] flex-wrap items-center justify-end gap-1.5">
                <Dropdown
                  testId="settings-floating-renderer"
                  value={floatingState?.selectedRendererId ?? ''}
                  options={floatingState?.renderers.map((renderer) => ({
                    value: renderer.id,
                    label: renderer.name
                  })) ?? []}
                  disabled={!floatingState || floatingState.renderers.length === 0}
                  buttonClassName="max-w-[190px]"
                  onChange={changeFloatingRenderer}
                />
                <button
                  type="button"
                  data-testid="settings-floating-renderer-refresh"
                  title={strings.settings.floatingRendererRefresh}
                  aria-label={strings.settings.floatingRendererRefresh}
                  onClick={refreshFloatingRenderers}
                  className="inline-flex size-[30px] items-center justify-center rounded-lg border border-border-default bg-input text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary"
                >
                  <RefreshCw className="size-3" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  data-testid="settings-floating-renderer-folder"
                  onClick={() => {
                    setFloatingActionError(null)
                    void window.floatingWindowApi.openRenderersDirectory().catch((error) => {
                      setFloatingActionError(
                        error instanceof Error ? error.message : String(error)
                      )
                    })
                  }}
                  className="inline-flex h-[30px] items-center rounded-lg border border-border-default bg-input px-2.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary"
                >
                  {strings.settings.floatingRendererFolder}
                </button>
                <button
                  type="button"
                  data-testid="settings-floating-renderer-copy-skill"
                  title={strings.settings.floatingRendererSkillCopy}
                  aria-label={strings.settings.floatingRendererSkillCopy}
                  onClick={copyFloatingRendererSkill}
                  className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-border-default bg-input px-2.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary"
                >
                  {floatingSkillCopied
                    ? <Check className="size-3 text-status-done" strokeWidth={1.75} />
                    : <Copy className="size-3" strokeWidth={1.75} />}
                  {floatingSkillCopied
                    ? strings.settings.floatingRendererSkillCopied
                    : strings.settings.floatingRendererSkillCopy}
                </button>
              </div>
            </Row>
            <Row
              label={strings.settings.floatingScale}
              hint={strings.settings.floatingScaleHint}
            >
              <Dropdown
                testId="settings-floating-scale"
                value={String(floatingState?.scale ?? 1)}
                options={[
                  { value: '0.6', label: '60%' },
                  { value: '0.75', label: '75%' },
                  { value: '0.9', label: '90%' },
                  { value: '1', label: '100%' },
                  { value: '1.2', label: '120%' },
                  { value: '1.4', label: '140%' },
                  { value: '1.6', label: '160%' }
                ]}
                buttonClassName="min-w-[100px]"
                onChange={changeFloatingScale}
              />
            </Row>
            <Row
              label={strings.settings.floatingAttentionEffect}
              hint={strings.settings.floatingAttentionEffectHint}
            >
              <Toggle
                testId="settings-floating-attention-effect"
                checked={floatingState?.attentionEffectEnabled ?? true}
                onChange={changeFloatingAttentionEffect}
              />
            </Row>
            {(floatingState?.rendererErrors.length ?? 0) > 0 && (
              <details data-testid="floating-renderer-errors" className="border-b border-border-faint py-3 font-pingfang text-[11px]">
                <summary className="cursor-pointer text-status-error">
                  {strings.settings.floatingRendererErrors}
                </summary>
                <ul className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border-default bg-surface-strong p-2 text-text-muted">
                  {floatingState?.rendererErrors.map((error, index) => (
                    <li key={`${error.filename}-${index}`} className="break-words py-1">
                      {error.filename}: {error.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
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
              label={strings.dsh.runtimeLabel}
              hint={dshRuntimeError ?? (dshRuntimeBusy
                ? strings.dsh.runtimeScanning
                : strings.dsh.runtimeHint)}
            >
              <div className="flex items-center gap-1.5">
                <Dropdown
                  testId="dsh-runtime-select"
                  direction="up"
                  value={selectedDshRuntime}
                  options={dshRuntimeOptions}
                  disabled={dshRuntimeBusy || dshRuntimeOptions.length === 1}
                  buttonClassName="max-w-[230px]"
                  onChange={changeDshRuntime}
                />
                <button
                  type="button"
                  data-testid="dsh-runtime-refresh"
                  disabled={dshRuntimeBusy}
                  title={strings.dsh.runtimeRefresh}
                  aria-label={strings.dsh.runtimeRefresh}
                  onClick={() => {
                    setDshRuntimeActionError(null)
                    onRefreshDshRuntimes()
                  }}
                  className="inline-flex size-[30px] items-center justify-center rounded-lg border border-border-default bg-input text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary disabled:cursor-wait disabled:opacity-70"
                >
                  <RefreshCw className={`size-3 ${dshRuntimeBusy ? 'animate-spin' : ''}`} strokeWidth={1.75} />
                </button>
              </div>
            </Row>
            {!dshRuntimeBusy && (dshRuntimeReport?.runtimeErrors.length ?? 0) > 0 && (
              <details data-testid="dsh-runtime-errors" className="border-b border-border-faint py-3 font-pingfang text-[11px]">
                <summary className="cursor-pointer text-status-error">
                  {strings.dsh.runtimeScanFailed}
                </summary>
                <ul className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border-default bg-surface-strong p-2 text-text-muted">
                  {dshRuntimeReport?.runtimeErrors.map((item, index) => (
                    <li key={`${item.detail}-${index}`} className="break-words py-1">
                      {item.detail}
                    </li>
                  ))}
                </ul>
              </details>
            )}
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

          <Section label="update" title={strings.settings.sections.update}>
            <div data-testid="settings-update" className="border-b border-border-faint py-3.5 last:border-b-0">
              <div className="flex items-center justify-between gap-6">
                <div className="min-w-0">
                  <p data-testid="settings-update-version" className="font-pingfang text-[12px] font-medium text-text-secondary">
                    {strings.settings.updateCurrentVersion(updateSnapshot?.currentVersion ?? '—')}
                  </p>
                  <p data-testid="settings-update-status" className={`mt-0.5 break-words font-pingfang text-[11px] ${updateSnapshot?.phase === 'error' ? 'text-status-error' : 'text-text-faint'}`}>
                    {updateStatus}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="settings-update-action"
                  disabled={updateBusy}
                  aria-busy={updateSnapshot?.phase === 'checking' || updateSnapshot?.phase === 'downloading'}
                  onClick={runUpdateAction}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {(updateSnapshot?.phase === 'checking' || updateSnapshot?.phase === 'downloading') && (
                    <RefreshCw className="size-3 animate-spin" strokeWidth={1.75} />
                  )}
                  {updateActionLabel}
                </button>
              </div>
              {updateSnapshot?.phase === 'downloading' && (
                <div data-testid="settings-update-progress" className="mt-2.5 h-1 overflow-hidden rounded-full bg-control">
                  <div
                    className="h-full rounded-full bg-button-primary transition-[width] duration-200"
                    style={{ width: `${Math.min(100, Math.max(0, updateSnapshot.progress?.percent ?? 0))}%` }}
                  />
                </div>
              )}
            </div>
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
