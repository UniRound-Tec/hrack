import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  Copy,
  Eye,
  FolderOpen,
  Settings2,
  Trash2
} from 'lucide-react'
import type {
  DshHomeMode,
  DshRetentionPolicy,
  DshRuntimeConfig
} from '../../shared/dsh-ipc'
import {
  copyDshAgentPreset,
  describeDshSettings,
  listDshAgentPresets,
  listDshModelGroups,
  listDshProviders,
  mutateDshSettings,
  openDshAgentPreset,
  openDshSettingsDocument,
  readDshAgentPreset,
  removeDshAgentPreset,
  setDefaultDshAgentPreset,
  type DshAgentPreset,
  type DshModelGroup,
  type DshProvider,
  type DshCredentialView,
  type DshSettingsDescribe
} from '../dsh/rpc'
import { useStrings, type AppStrings } from './i18n'
import Dropdown from './Dropdown'
import DshModelsSettings, { loadProviderCredentials } from './DshModelsSettings'
import DshPluginInventory from './DshPluginInventory'

const PRESET_LABELS: Record<string, { name: keyof AppStrings['dsh']; desc: keyof AppStrings['dsh'] }> = {
  standard: { name: 'presetStandard', desc: 'presetStandardHint' },
  code: { name: 'presetCode', desc: 'presetCodeHint' },
  minimal: { name: 'presetMinimal', desc: 'presetMinimalHint' },
  cordis: { name: 'presetCordis', desc: 'presetCordisHint' }
}

type SettingsTab = 'general' | 'models' | 'plugins' | 'presets'

interface DshSettingsPageProps {
  onBack: () => void
}

function presetLabel(preset: DshAgentPreset, strings: AppStrings): {
  name: string
  description: string
} {
  const keys = preset.trust === 'system' ? PRESET_LABELS[preset.id] : undefined
  if (keys) {
    return {
      name: strings.dsh[keys.name] as string,
      description: strings.dsh[keys.desc] as string
    }
  }
  return {
    name: preset.name ?? preset.id,
    description: preset.description ?? strings.dsh.noDescription
  }
}

function displayPresetName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function displayPermissionPreset(value: string, name = value): string {
  return value === 'danger-full-access' ? 'Full access' : displayPresetName(name)
}

function collectConstOptions(
  node: unknown,
  seen = new WeakSet<object>()
): Array<{ id: string; label: string }> {
  if (node === null || typeof node !== 'object' || seen.has(node)) return []
  seen.add(node)
  const record = node as Record<string, unknown>
  const found: Array<{ id: string; label: string }> = []
  if (record.type === 'const' && typeof record.value === 'string') {
    const meta = record.meta as { description?: unknown } | undefined
    const described =
      typeof meta?.description === 'string' ? meta.description : record.value
    found.push({
      id: record.value,
      label: displayPermissionPreset(record.value, described)
    })
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) found.push(...collectConstOptions(item, seen))
    } else if (child && typeof child === 'object') {
      found.push(...collectConstOptions(child, seen))
    }
  }
  return found
}

function permissionOptions(
  describe: DshSettingsDescribe | null
): { current: string; options: Array<{ id: string; label: string }>; revision: number } | null {
  const view = describe?.namespaces.find((item) => item.ns === 'permission')
  if (!view) return null
  const current =
    typeof view.value.defaultPreset === 'string' ? view.value.defaultPreset : ''
  try {
    const options = collectConstOptions(view.schema)
    const unique = new Map(options.map((option) => [option.id, option]))
    if (current && !unique.has(current)) {
      unique.set(current, {
        id: current,
        label: displayPermissionPreset(current)
      })
    }
    return {
      current,
      options: [...unique.values()],
      revision: view.revision
    }
  } catch {
    return {
      current,
      options: current
        ? [{ id: current, label: displayPermissionPreset(current) }]
        : [],
      revision: view.revision
    }
  }
}

function numberFrom(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function stringFrom(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export default function DshSettingsPage({ onBack }: DshSettingsPageProps) {
  const strings = useStrings()
  const [tab, setTab] = useState<SettingsTab>('general')
  const [pluginTab, setPluginTab] = useState<'config' | 'list'>('config')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [config, setConfig] = useState<DshRuntimeConfig | null>(null)
  const [presets, setPresets] = useState<DshAgentPreset[]>([])
  const [authorable, setAuthorable] = useState(false)
  const [hasPresetDocument, setHasPresetDocument] = useState(false)
  const [models, setModels] = useState<DshModelGroup[]>([])
  const [providers, setProviders] = useState<DshProvider[]>([])
  const [hostSettings, setHostSettings] = useState<DshSettingsDescribe | null>(null)
  const [providerCredentials, setProviderCredentials] = useState<
    Record<string, DshCredentialView>
  >({})
  const [busy, setBusy] = useState(false)
  const [copyFrom, setCopyFrom] = useState<string | null>(null)
  const [copyId, setCopyId] = useState('')
  const [copyName, setCopyName] = useState('')
  const [viewContent, setViewContent] = useState<{ title: string; content: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [revealedPath, setRevealedPath] = useState<Record<string, string>>({})
  const [pluginDraft, setPluginDraft] = useState<Record<string, string>>({})

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const status = await window.dshApi.ensureStarted()
      if (status.state !== 'ready') {
        throw new Error(status.error ?? 'dsh host is not ready')
      }
      const [nextConfig, roster, nextModels, nextProviders, nextHost] =
        await Promise.all([
          window.dshApi.getConfig(),
          listDshAgentPresets().catch(() => ({
            presets: [],
            authorable: false,
            hasDocument: false
          })),
          listDshModelGroups().catch(() => []),
          listDshProviders(),
          describeDshSettings()
        ])
      const nextCredentials = await loadProviderCredentials(
        nextProviders,
        nextHost
      ).catch(() => ({}))
      setConfig(nextConfig)
      setPresets(roster.presets)
      setAuthorable(roster.authorable)
      setHasPresetDocument(roster.hasDocument)
      setModels(nextModels)
      setProviders(nextProviders)
      setHostSettings(nextHost)
      setProviderCredentials(nextCredentials)
      const shell = nextHost?.namespaces.find((item) => item.ns === 'shell')?.value ?? {}
      const loop = nextHost?.namespaces.find((item) => item.ns === 'agent-loop')?.value ?? {}
      const search =
        nextHost?.namespaces.find((item) => item.ns === 'web-search-deepseek')?.value ?? {}
      setPluginDraft({
        timeoutMs: numberFrom(shell.timeoutMs),
        maxOutputBytes: numberFrom(shell.maxOutputBytes),
        maxParallelToolCalls: numberFrom(loop.maxParallelToolCalls),
        baseUrl: stringFrom(search.baseUrl),
        maxUses: numberFrom(search.maxUses)
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const permissions = useMemo(() => permissionOptions(hostSettings), [hostSettings])
  const busyEnter =
    typeof hostSettings?.namespaces.find((item) => item.ns === 'ui-conversation')?.value
      .busyEnter === 'string'
      ? String(
          hostSettings.namespaces.find((item) => item.ns === 'ui-conversation')?.value
            .busyEnter
        )
      : 'queue'

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await task()
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const changeHome = async (mode: DshHomeMode): Promise<void> => {
    if (!config || mode === config.homeMode || config.envOverride) return
    if (!window.confirm(strings.dsh.homeSwitchConfirm)) return
    setBusy(true)
    try {
      await window.dshApi.setHomeMode(mode)
      window.location.reload()
    } catch (cause) {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const changeRetention = async (policy: DshRetentionPolicy): Promise<void> => {
    await run(async () => {
      setConfig(await window.dshApi.setRetention(policy))
    })
  }

  const savePlugin = async (
    ns: string,
    fields: Array<{ key: string; kind: 'number' | 'string' }>
  ): Promise<void> => {
    await run(async () => {
      const ops: Array<
        | { op: 'set'; path: string[]; value: unknown }
        | { op: 'unset'; path: string[] }
      > = []
      for (const field of fields) {
        const raw = pluginDraft[field.key]?.trim() ?? ''
        if (raw === '') {
          ops.push({ op: 'unset', path: [field.key] })
          continue
        }
        const value = field.kind === 'number' ? Number(raw) : raw
        if (field.kind === 'number' && !Number.isFinite(value)) {
          throw new Error(strings.dsh.invalidNumber)
        }
        ops.push({ op: 'set', path: [field.key], value })
      }
      await mutateDshSettings({ ns, ops })
    })
  }

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'general', label: strings.dsh.navGeneral },
    { id: 'models', label: strings.dsh.navModels },
    { id: 'plugins', label: strings.dsh.navPlugins },
    { id: 'presets', label: strings.dsh.navPresets }
  ]

  return (
    <section
      data-testid="dsh-settings"
      className="absolute inset-0 flex h-full min-h-0 overflow-hidden bg-content"
    >
      <nav className="flex w-[188px] shrink-0 flex-col gap-4 border-r border-border-subtle px-3 py-6">
        <button
          type="button"
          data-testid="dsh-settings-back"
          onClick={onBack}
          className="inline-flex items-center gap-1 px-2 py-1 font-pingfang text-[12px] text-text-faint hover:text-text-secondary"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
          {strings.dsh.backToLobby}
        </button>
        <p className="px-2 font-pingfang text-[16px] font-medium text-text-primary">
          {strings.dsh.settings}
        </p>
        <div className="flex flex-col gap-1">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`dsh-settings-tab-${item.id}`}
              onClick={() => setTab(item.id)}
              className={`flex items-center gap-2 rounded-xl px-3 py-2 text-left font-pingfang text-[14px] ${
                tab === item.id
                  ? 'bg-surface-strong text-text-primary'
                  : 'text-text-secondary hover:bg-surface'
              }`}
            >
              <Settings2 className="size-4" strokeWidth={1.75} />
              {item.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="sidebar-scroll min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mb-4 flex items-center justify-end">
          <button
            type="button"
            data-testid="dsh-open-document"
            disabled={!hostSettings?.hasDocument || busy}
            onClick={() =>
              void openDshSettingsDocument().catch((cause) => {
                setError(cause instanceof Error ? cause.message : String(cause))
              })
            }
            className="rounded-lg border border-border-default px-3 py-1.5 font-pingfang text-[12px] text-text-muted hover:bg-surface-strong hover:text-text-secondary disabled:opacity-50"
          >
            {strings.dsh.openDocument}
          </button>
        </div>

        {error && (
          <p
            data-testid="dsh-settings-error"
            className="mb-4 rounded-lg bg-surface-strong px-3 py-2 font-pingfang text-[12px] text-status-error"
          >
            {error}
          </p>
        )}
        {loading ? (
          <p className="font-pingfang text-[12px] text-text-faint">{strings.dsh.loading}</p>
        ) : (
          <>
            {tab === 'general' && config && (
              <div data-testid="dsh-host-settings" className="flex max-w-[720px] flex-col">
                <h2 className="font-pingfang text-[16px] font-medium text-text-primary">
                  {strings.dsh.navGeneral}
                </h2>
                <Row
                  label={strings.dsh.presetTitle}
                  hint={strings.dsh.presetHint}
                >
                  <Dropdown
                    testId="dsh-default-preset"
                    disabled={busy || presets.length === 0}
                    value={presets.find((item) => item.isDefault)?.id ?? ''}
                    options={presets.map((preset) => ({
                      value: preset.id,
                      label: presetLabel(preset, strings).name
                    }))}
                    buttonClassName="min-w-[180px] rounded-full"
                    onChange={(value) =>
                      void run(() => setDefaultDshAgentPreset(value))
                    }
                  />
                </Row>
                {permissions && (
                  <Row label={strings.dsh.permissionTitle} hint={strings.dsh.permissionHint}>
                    <Dropdown
                      testId="dsh-default-permission"
                      disabled={busy || permissions.options.length === 0}
                      value={permissions.current}
                      options={permissions.options.map((option) => ({
                        value: option.id,
                        label: option.label
                      }))}
                      buttonClassName="min-w-[180px] rounded-full"
                      onChange={(next) => {
                        if (
                          next === 'danger-full-access' &&
                          !window.confirm(strings.dsh.fullAccessConfirm)
                        ) {
                          return
                        }
                        void run(() =>
                          mutateDshSettings({
                            ns: 'permission',
                            expectedRevision: permissions.revision,
                            ops: [
                              {
                                op: 'set',
                                path: ['defaultPreset'],
                                value: next
                              }
                            ]
                          })
                        )
                      }}
                    />
                  </Row>
                )}
                <Row label={strings.dsh.enterTitle} hint={strings.dsh.enterHint}>
                  <Dropdown
                    testId="dsh-busy-enter"
                    disabled={busy}
                    value={busyEnter}
                    options={[
                      { value: 'queue', label: strings.dsh.enterQueue },
                      { value: 'steer', label: strings.dsh.enterSteer }
                    ]}
                    buttonClassName="min-w-[180px] rounded-full"
                    onChange={(value) =>
                      void run(() =>
                        mutateDshSettings({
                          ns: 'ui-conversation',
                          ops: [
                            { op: 'set', path: ['busyEnter'], value }
                          ]
                        })
                      )
                    }
                  />
                </Row>
                <Row
                  label={strings.dsh.homeLabel}
                  hint={config.envOverride ? strings.dsh.homeEnvOverride : strings.dsh.homeHint}
                >
                  <div className="flex rounded-lg bg-control p-0.5">
                    {(['isolated', 'shared'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        data-testid={`dsh-home-${mode}`}
                        disabled={busy || config.envOverride}
                        onClick={() => void changeHome(mode)}
                        className={`rounded-md px-2.5 py-1 font-pingfang text-[11px] ${
                          config.homeMode === mode
                            ? 'bg-control-active text-text-primary'
                            : 'text-text-muted'
                        }`}
                      >
                        {mode === 'isolated'
                          ? strings.dsh.homeIsolated
                          : strings.dsh.homeShared}
                      </button>
                    ))}
                  </div>
                </Row>
                <p
                  data-testid="dsh-home-path"
                  className="border-b border-border-faint pb-3 font-maple text-[11px] text-text-faint"
                >
                  {config.activeHome}
                </p>
                <Row label={strings.dsh.retentionLabel} hint={strings.dsh.retentionHint}>
                  <div className="flex items-center gap-2">
                    <Dropdown
                      testId="dsh-retention-kind"
                      disabled={busy}
                      value={config.retention.kind}
                      options={[
                        { value: 'all', label: strings.dsh.retentionAll },
                        { value: 'days', label: strings.dsh.retentionDays },
                        { value: 'count', label: strings.dsh.retentionCount }
                      ]}
                      onChange={(kind) => {
                        if (kind === 'all') void changeRetention({ kind: 'all' })
                        if (kind === 'days') {
                          void changeRetention({ kind: 'days', days: 30 })
                        }
                        if (kind === 'count') {
                          void changeRetention({ kind: 'count', count: 50 })
                        }
                      }}
                    />
                    {config.retention.kind === 'days' && (
                      <input
                        data-testid="dsh-retention-days"
                        type="number"
                        min={1}
                        value={config.retention.days}
                        onChange={(event) =>
                          void changeRetention({
                            kind: 'days',
                            days: Number(event.target.value)
                          })
                        }
                        className="w-20 rounded-lg border border-border-default bg-input px-2 py-1.5 font-maple text-[12px]"
                      />
                    )}
                    {config.retention.kind === 'count' && (
                      <input
                        data-testid="dsh-retention-count"
                        type="number"
                        min={1}
                        value={config.retention.count}
                        onChange={(event) =>
                          void changeRetention({
                            kind: 'count',
                            count: Number(event.target.value)
                          })
                        }
                        className="w-20 rounded-lg border border-border-default bg-input px-2 py-1.5 font-maple text-[12px]"
                      />
                    )}
                  </div>
                </Row>
              </div>
            )}

            {tab === 'models' && (
              <DshModelsSettings
                providers={providers}
                models={models}
                hostSettings={hostSettings}
                credentials={providerCredentials}
                busy={busy}
                onReload={reload}
                onError={setError}
              />
            )}

            {tab === 'plugins' && (
              <div className="flex max-w-[720px] flex-col gap-4">
                <div>
                  <h2 className="font-pingfang text-[16px] font-medium text-text-primary">
                    {strings.dsh.navPlugins}
                  </h2>
                  <p className="mt-1 font-pingfang text-[13px] text-text-muted">
                    {strings.dsh.pluginsIntro}
                  </p>
                </div>
                <div className="flex gap-4 border-b border-border-faint">
                  <button
                    type="button"
                    data-testid="dsh-plugin-tab-config"
                    onClick={() => setPluginTab('config')}
                    className={`pb-2 font-pingfang text-[13px] ${
                      pluginTab === 'config'
                        ? 'border-b-2 border-text-primary text-text-primary'
                        : 'text-text-faint'
                    }`}
                  >
                    {strings.dsh.pluginConfigTab}
                  </button>
                  <button
                    type="button"
                    data-testid="dsh-plugin-tab-list"
                    onClick={() => setPluginTab('list')}
                    className={`pb-2 font-pingfang text-[13px] ${
                      pluginTab === 'list'
                        ? 'border-b-2 border-text-primary text-text-primary'
                        : 'text-text-faint'
                    }`}
                  >
                    {strings.dsh.pluginListTab}
                  </button>
                </div>
                {pluginTab === 'list' && <DshPluginInventory />}
                {pluginTab === 'config' && (
                  <>
                <PluginCard
                  title={strings.dsh.pluginShell}
                  hint={strings.dsh.pluginShellHint}
                  saveLabel={strings.dsh.save}
                  onSave={() =>
                    void savePlugin('shell', [
                      { key: 'timeoutMs', kind: 'number' },
                      { key: 'maxOutputBytes', kind: 'number' }
                    ])
                  }
                >
                  <Field
                    label={strings.dsh.pluginTimeout}
                    value={pluginDraft.timeoutMs ?? ''}
                    onChange={(value) =>
                      setPluginDraft((current) => ({ ...current, timeoutMs: value }))
                    }
                  />
                  <Field
                    label={strings.dsh.pluginOutput}
                    value={pluginDraft.maxOutputBytes ?? ''}
                    onChange={(value) =>
                      setPluginDraft((current) => ({ ...current, maxOutputBytes: value }))
                    }
                  />
                </PluginCard>
                <PluginCard
                  title={strings.dsh.pluginLoop}
                  hint={strings.dsh.pluginLoopHint}
                  saveLabel={strings.dsh.save}
                  onSave={() =>
                    void savePlugin('agent-loop', [
                      { key: 'maxParallelToolCalls', kind: 'number' }
                    ])
                  }
                >
                  <Field
                    label={strings.dsh.pluginParallel}
                    value={pluginDraft.maxParallelToolCalls ?? ''}
                    onChange={(value) =>
                      setPluginDraft((current) => ({
                        ...current,
                        maxParallelToolCalls: value
                      }))
                    }
                  />
                </PluginCard>
                <PluginCard
                  title={strings.dsh.pluginSearch}
                  hint={strings.dsh.pluginSearchHint}
                  saveLabel={strings.dsh.save}
                  onSave={() =>
                    void savePlugin('web-search-deepseek', [
                      { key: 'baseUrl', kind: 'string' },
                      { key: 'maxUses', kind: 'number' }
                    ])
                  }
                >
                  <Field
                    label={strings.dsh.pluginEndpoint}
                    value={pluginDraft.baseUrl ?? ''}
                    onChange={(value) =>
                      setPluginDraft((current) => ({ ...current, baseUrl: value }))
                    }
                  />
                  <Field
                    label={strings.dsh.pluginMaxUses}
                    value={pluginDraft.maxUses ?? ''}
                    onChange={(value) =>
                      setPluginDraft((current) => ({ ...current, maxUses: value }))
                    }
                  />
                </PluginCard>
                  </>
                )}
              </div>
            )}

            {tab === 'presets' && (
              <div className="flex max-w-[760px] flex-col gap-5">
                <div>
                  <h2 className="font-pingfang text-[16px] font-medium text-text-primary">
                    {strings.dsh.navPresets}
                  </h2>
                  <p className="mt-1 font-pingfang text-[13px] text-text-muted">
                    {strings.dsh.presetsIntro}
                  </p>
                </div>
                {(['system', 'user'] as const).map((trust) => {
                  const rows = presets.filter((item) => item.trust === trust)
                  if (rows.length === 0 && trust === 'system') return null
                  return (
                    <section key={trust}>
                      <h3 className="mb-2 font-pingfang text-[13px] font-medium text-text-secondary">
                        {trust === 'system'
                          ? strings.dsh.builtInGroup
                          : strings.dsh.customGroup}
                      </h3>
                      <ul className="grid gap-3 md:grid-cols-2">
                        {rows.map((preset) => {
                          const text = presetLabel(preset, strings)
                          return (
                            <li
                              key={preset.id}
                              className={`rounded-2xl border px-4 py-3 ${
                                preset.isDefault
                                  ? 'border-border-strong bg-surface-strong'
                                  : 'border-border-subtle'
                              }`}
                            >
                              <button
                                type="button"
                                disabled={preset.isDefault || Boolean(preset.broken) || busy}
                                onClick={() =>
                                  void run(() => setDefaultDshAgentPreset(preset.id))
                                }
                                className="w-full text-left"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="font-pingfang text-[14px] font-medium text-text-primary">
                                    {text.name}
                                  </span>
                                  {preset.isDefault && (
                                    <span className="rounded-full bg-control px-2 py-0.5 font-pingfang text-[11px] text-text-muted">
                                      {strings.dsh.inUse}
                                    </span>
                                  )}
                                </div>
                                <p className="mt-1 line-clamp-2 font-pingfang text-[12px] text-text-faint">
                                  {text.description}
                                </p>
                              </button>
                              <div className="mt-3 flex items-center gap-1">
                                {preset.trust === 'system' && !preset.broken && (
                                  <IconAction
                                    label={strings.dsh.view}
                                    onClick={() =>
                                      void readDshAgentPreset(preset.id).then((value) =>
                                        setViewContent({
                                          title: text.name,
                                          content: value.content
                                        })
                                      )
                                    }
                                  >
                                    <Eye className="size-3.5" />
                                  </IconAction>
                                )}
                                {preset.trust === 'user' && (
                                  <IconAction
                                    label={
                                      hasPresetDocument
                                        ? strings.dsh.openFolder
                                        : strings.dsh.showPath
                                    }
                                    onClick={() =>
                                      void openDshAgentPreset(preset.id).then((path) => {
                                        if (path) {
                                          setRevealedPath((current) => ({
                                            ...current,
                                            [preset.id]: path
                                          }))
                                        }
                                      })
                                    }
                                  >
                                    <FolderOpen className="size-3.5" />
                                  </IconAction>
                                )}
                                <IconAction
                                  label={strings.dsh.duplicate}
                                  disabled={!authorable || Boolean(preset.broken)}
                                  onClick={() => {
                                    setCopyFrom(preset.id)
                                    setCopyId(`${preset.id}-copy`)
                                    setCopyName('')
                                  }}
                                >
                                  <Copy className="size-3.5" />
                                </IconAction>
                                {preset.trust === 'user' && (
                                  <IconAction
                                    label={strings.dsh.delete}
                                    onClick={() => setPendingDelete(preset.id)}
                                  >
                                    <Trash2 className="size-3.5" />
                                  </IconAction>
                                )}
                              </div>
                              {revealedPath[preset.id] && (
                                <p className="mt-2 break-all font-maple text-[11px] text-text-faint">
                                  {revealedPath[preset.id]}
                                </p>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    </section>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      {copyFrom && (
        <Dialog
          title={strings.dsh.copyTitle}
          onClose={() => setCopyFrom(null)}
          actions={
            <>
              <button
                type="button"
                onClick={() => setCopyFrom(null)}
                className="rounded-lg px-3 py-1.5 font-pingfang text-[12px]"
              >
                {strings.dsh.cancel}
              </button>
              <button
                type="button"
                disabled={busy || copyId.trim().length === 0}
                onClick={() =>
                  void run(async () => {
                    await copyDshAgentPreset({
                      from: copyFrom,
                      id: copyId.trim(),
                      name: copyName.trim() || undefined
                    })
                    setCopyFrom(null)
                  })
                }
                className="rounded-lg bg-button-primary px-3 py-1.5 font-pingfang text-[12px] text-button-primary-fg"
              >
                {strings.dsh.create}
              </button>
            </>
          }
        >
          <p className="mb-3 font-pingfang text-[12px] text-text-muted">
            {strings.dsh.copyIntro}
          </p>
          <label className="mb-2 block font-pingfang text-[12px]">
            {strings.dsh.presetId}
            <input
              value={copyId}
              onChange={(event) => setCopyId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px]"
            />
          </label>
          <label className="block font-pingfang text-[12px]">
            {strings.dsh.displayName}
            <input
              value={copyName}
              onChange={(event) => setCopyName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px]"
            />
          </label>
        </Dialog>
      )}

      {viewContent && (
        <Dialog
          title={viewContent.title}
          onClose={() => setViewContent(null)}
          actions={
            <button
              type="button"
              onClick={() => setViewContent(null)}
              className="rounded-lg px-3 py-1.5 font-pingfang text-[12px]"
            >
              {strings.dsh.cancel}
            </button>
          }
        >
          <pre className="max-h-[50vh] overflow-auto rounded-lg bg-surface-strong p-3 font-maple text-[11px] text-text-secondary">
            {viewContent.content}
          </pre>
        </Dialog>
      )}

      {pendingDelete && (
        <Dialog
          title={strings.dsh.deleteTitle}
          onClose={() => setPendingDelete(null)}
          actions={
            <>
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded-lg px-3 py-1.5 font-pingfang text-[12px]"
              >
                {strings.dsh.cancel}
              </button>
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    await removeDshAgentPreset(pendingDelete)
                    setPendingDelete(null)
                  })
                }
                className="rounded-lg bg-status-error px-3 py-1.5 font-pingfang text-[12px] text-text-inverse"
              >
                {strings.dsh.delete}
              </button>
            </>
          }
        >
          <p className="font-pingfang text-[13px] text-text-muted">
            {strings.dsh.deleteHint}
          </p>
        </Dialog>
      )}
    </section>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border-faint py-4">
      <div className="min-w-0">
        <p className="font-pingfang text-[14px] text-text-primary">{label}</p>
        {hint && (
          <p className="mt-1 font-pingfang text-[12px] text-text-faint">{hint}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="mb-3 block font-pingfang text-[12px] text-text-secondary">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px] text-text-primary"
      />
    </label>
  )
}

function PluginCard({
  title,
  hint,
  saveLabel,
  onSave,
  children
}: {
  title: string
  hint: string
  saveLabel: string
  onSave: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <article className="rounded-2xl border border-border-subtle">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
      >
        <span>
          <span className="block font-pingfang text-[14px] text-text-primary">{title}</span>
          <span className="mt-1 block font-pingfang text-[12px] text-text-faint">{hint}</span>
        </span>
      </button>
      {open && (
        <div className="border-t border-border-faint px-4 py-3">
          {children}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onSave}
              className="rounded-lg bg-button-primary px-3 py-1.5 font-pingfang text-[12px] text-button-primary-fg"
            >
              {saveLabel}
            </button>
          </div>
        </div>
      )}
    </article>
  )
}

function IconAction({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1.5 text-text-faint hover:bg-surface-strong hover:text-text-secondary disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function Dialog({
  title,
  onClose,
  actions,
  children
}: {
  title: string
  onClose: () => void
  actions: ReactNode
  children: ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button
        type="button"
        aria-label="close"
        className="absolute inset-0 bg-backdrop"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-lg rounded-2xl bg-surface p-5 shadow-window">
        <h3 className="mb-3 font-pingfang text-[16px] font-medium text-text-primary">
          {title}
        </h3>
        {children}
        <div className="mt-4 flex justify-end gap-2">{actions}</div>
      </div>
    </div>
  )
}
