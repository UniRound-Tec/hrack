import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, RefreshCw } from 'lucide-react'
import type { CliScanReport } from '../../shared/ipc-contract'
import { useSettingsStore } from '../state/settingsStore'
import ShinyText from './effects/ShinyText'
import TargetCursor from './effects/TargetCursor'
import Dropdown, { type DropdownOption } from './Dropdown'
import SidebarTint from './SidebarTint'
import TitleBar from './TitleBar'
import { appLocales, useStrings } from './i18n'
import { getUiThemeRegistry, useThemeRegistryVersion } from './themeRuntime'

interface FirstRunOnboardingProps {
  onComplete: () => void
}

export default function FirstRunOnboarding({
  onComplete
}: FirstRunOnboardingProps) {
  const strings = useStrings()
  const settings = useSettingsStore()
  useThemeRegistryVersion((state) => state.version)
  const themes = getUiThemeRegistry().themes
  const themeGroups = {
    light: { id: 'light', label: strings.settings.light },
    dark: { id: 'dark', label: strings.settings.dark }
  } as const
  const themeOptions: DropdownOption[] = themes
    .map((theme) => ({
      value: theme.id,
      label:
        theme.id === 'light'
          ? strings.settings.light
          : theme.id === 'dark'
            ? strings.settings.dark
            : theme.name,
      group: themeGroups[theme.type]
    }))
    .sort(
      (left, right) =>
        (left.group.id === 'light' ? 0 : 1) -
        (right.group.id === 'light' ? 0 : 1)
    )
  const languageOptions: DropdownOption[] = appLocales.map((locale) => ({
    value: locale,
    label: strings.settings.languages[locale]
  }))
  const [cliReport, setCliReport] = useState<CliScanReport | null>(null)
  const [cliScanning, setCliScanning] = useState(true)
  const [cliScanError, setCliScanError] = useState<string | null>(null)
  const [floatingUpdating, setFloatingUpdating] = useState(false)

  const scanClis = useCallback(async (): Promise<void> => {
    setCliScanning(true)
    setCliScanError(null)
    try {
      setCliReport(await window.cliApi.scan(false))
    } catch (error) {
      setCliScanError(error instanceof Error ? error.message : String(error))
    } finally {
      setCliScanning(false)
    }
  }, [])

  useEffect(() => {
    void scanClis()
  }, [scanClis])

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

  const changeFloatingWindow = (): void => {
    setFloatingUpdating(true)
    void window.floatingWindowApi
      .setEnabled(!settings.floatEnabled)
      .then((state) => settings.setFloatEnabled(state.enabled))
      .finally(() => setFloatingUpdating(false))
  }

  const changeLanguage = (value: string): void => {
    const locale = value as typeof settings.language
    settings.setLanguage(locale)
    void window.appApi.setMainPrefs({ language: locale })
  }

  const installationCount = useMemo(
    () =>
      cliReport?.launchable.reduce(
        (total, cli) => total + cli.installations.length,
        0
      ) ?? 0,
    [cliReport]
  )
  const canComplete =
    cliReport !== null &&
    !cliScanning &&
    !cliScanError &&
    !floatingUpdating

  return (
    <div className="app-shell isolate relative flex h-full w-full select-none flex-col overflow-hidden">
      <SidebarTint />
      <TitleBar onNew={() => {}} showPrimaryActions={false} />

      <main className="relative flex min-h-0 flex-1 items-center justify-center px-6 py-8">
        <section
          data-testid="first-run-onboarding"
          className="w-full max-w-[560px]"
        >
          <header className="text-center">
            <ShinyText
              text="hrack"
              color="var(--hrack-brand-logo)"
              shineColor="var(--hrack-brand-logoShine)"
              speed={3.2}
              spread={100}
              className="font-brand text-[52px] leading-none tracking-[0.08em]"
            />
          </header>

          <div className="mt-12 flex items-end justify-center gap-3">
            <div>
              <p className="mb-2 px-1 font-pingfang text-[10px] font-medium text-text-faint">
                {strings.onboarding.themeTitle}
              </p>
              <Dropdown
                testId="onboarding-theme"
                value={settings.uiThemeId}
                options={themeOptions}
                rootClassName="w-[180px]"
                buttonClassName="h-10 w-full rounded-xl px-4 text-[11px]"
                onChange={settings.setUiTheme}
              />
            </div>
            <div>
              <p className="mb-2 px-1 font-pingfang text-[10px] font-medium text-text-faint">
                {strings.settings.language}
              </p>
              <Dropdown
                testId="onboarding-language"
                value={settings.language}
                options={languageOptions}
                rootClassName="w-[180px]"
                buttonClassName="h-10 w-full rounded-xl px-4 text-[11px]"
                onChange={changeLanguage}
              />
            </div>
          </div>
          <div className="mt-3 flex items-end justify-center gap-3">
            <div>
              <p className="mb-2 px-1 font-pingfang text-[10px] font-medium text-text-faint">
                {strings.onboarding.floatingTitle}
              </p>
              <button
                type="button"
                role="switch"
                data-testid="onboarding-floating-window"
                aria-checked={settings.floatEnabled}
                aria-label={strings.onboarding.floatingTitle}
                disabled={floatingUpdating}
                onClick={changeFloatingWindow}
                className={`cursor-target h-10 w-[180px] rounded-xl border px-4 font-pingfang text-[11px] font-medium transition-colors ${
                  settings.floatEnabled
                    ? 'border-button-primary bg-button-primary text-button-primary-fg'
                    : 'border-border-default bg-input text-text-muted hover:bg-input-hover'
                } disabled:opacity-60`}
              >
                {settings.floatEnabled
                  ? strings.onboarding.enabled
                  : strings.onboarding.disabled}
              </button>
            </div>
            <div>
              <p className="mb-2 px-1 font-pingfang text-[10px] font-medium text-text-faint">
                {strings.onboarding.targetCursorTitle}
              </p>
              <button
                type="button"
                role="switch"
                data-testid="onboarding-target-cursor"
                aria-checked={settings.targetCursorEnabled}
                aria-label={strings.onboarding.targetCursorTitle}
                onClick={() =>
                  settings.setTargetCursorEnabled(!settings.targetCursorEnabled)
                }
                className={`cursor-target h-10 w-[180px] rounded-xl border px-4 font-pingfang text-[11px] font-medium transition-colors ${
                  settings.targetCursorEnabled
                    ? 'border-button-primary bg-button-primary text-button-primary-fg'
                    : 'border-border-default bg-input text-text-muted hover:bg-input-hover'
                }`}
              >
                {settings.targetCursorEnabled
                  ? strings.onboarding.targetCursorOn
                  : strings.onboarding.targetCursorOff}
              </button>
            </div>
          </div>

          <div className="mt-8 flex min-h-5 items-center justify-center gap-2 font-pingfang text-[10px] text-text-muted" aria-live="polite">
            {cliScanning ? (
              <>
                <RefreshCw className="size-3 animate-spin" strokeWidth={1.8} />
                {strings.newSession.scanningClis}
              </>
            ) : cliScanError ? (
              <span className="text-status-error">{strings.onboarding.scanFailed}</span>
            ) : (
              <>
                <Check className="size-3 text-status-done" strokeWidth={2} />
                {strings.onboarding.scanFound(
                  cliReport?.launchable.length ?? 0,
                  installationCount
                )}
              </>
            )}
          </div>

          <button
            type="button"
            data-testid="onboarding-complete"
            disabled={!canComplete}
            onClick={() => {
              if (canComplete) onComplete()
            }}
            className="cursor-target mx-auto mt-5 flex w-[280px] items-center justify-center gap-2 rounded-xl bg-button-primary px-5 py-3 font-pingfang text-[12px] font-medium text-button-primary-fg transition-colors hover:bg-button-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {strings.onboarding.continue}
            <ArrowRight className="size-3.5" strokeWidth={1.8} />
          </button>
        </section>
      </main>

      {settings.targetCursorEnabled && (
        <TargetCursor
          showCursor={false}
          hideDefaultCursor={false}
          spinDuration={2}
          parallaxOn
          hoverDuration={0.2}
          cursorColor="var(--hrack-accent-cursor)"
          cursorColorOnTarget="var(--hrack-accent-target)"
        />
      )}
    </div>
  )
}
