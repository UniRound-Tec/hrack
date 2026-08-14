import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import {
  describeDshCredentials,
  mutateDshSettings,
  setDshCredential,
  type DshCredentialView,
  type DshModelGroup,
  type DshProvider,
  type DshSettingsDescribe
} from '../dsh/rpc'
import {
  deriveKeyRef,
  joinProviderRows,
  type JoinedProvider
} from '../dsh/modelsSettings'
import { useStrings } from './i18n'
import Dropdown from './Dropdown'

interface DshModelsSettingsProps {
  providers: DshProvider[]
  models: DshModelGroup[]
  hostSettings: DshSettingsDescribe | null
  credentials: Record<string, DshCredentialView>
  busy: boolean
  onReload: () => Promise<void>
  onError: (message: string) => void
}

export default function DshModelsSettings({
  providers,
  models,
  hostSettings,
  credentials,
  busy,
  onReload,
  onError
}: DshModelsSettingsProps) {
  const strings = useStrings()
  const rows = useMemo(
    () => joinProviderRows(providers, hostSettings, credentials),
    [credentials, hostSettings, providers]
  )
  const configured = rows.filter((row) => row.configured)
  const addable = rows.filter(
    (row) => !row.configured && row.entry.settingsNs !== ''
  )
  const writable = hostSettings?.writable !== false
  const customRevision =
    hostSettings?.namespaces.find((item) => item.ns === 'llm-pi-ai')?.revision ?? 0

  const [addMode, setAddMode] = useState<'catalog' | 'custom' | null>(null)
  const [addProviderId, setAddProviderId] = useState('')
  const [addKey, setAddKey] = useState('')
  const [addBaseUrl, setAddBaseUrl] = useState('')
  const [customRoute, setCustomRoute] = useState('')
  const [customName, setCustomName] = useState('')
  const [customProtocol, setCustomProtocol] = useState('openai-completions')
  const [customModel, setCustomModel] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const locked = busy || saving || !writable

  const apply = async (task: () => Promise<void>): Promise<void> => {
    setSaving(true)
    try {
      await task()
      await onReload()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const adopt = async (row: JoinedProvider): Promise<void> => {
    const keyRef = deriveKeyRef(row.entry.provider)
    const key = addKey.trim()
    if (row.entry.settingsPath.length > 0) {
      await mutateDshSettings({
        ns: row.entry.settingsNs,
        ops: [
          {
            op: 'set',
            path: row.entry.settingsPath,
            value: key ? { apiKeyEnv: keyRef } : {}
          }
        ]
      })
    }
    if (key) await setDshCredential(keyRef, key)
  }

  return (
    <div className="flex max-w-[720px] flex-col gap-5">
      <div>
        <h2 className="font-pingfang text-[16px] font-medium text-text-primary">
          {strings.dsh.navModels}
        </h2>
        <p className="mt-1 font-pingfang text-[13px] text-text-muted">
          {strings.dsh.modelsIntro}
        </p>
      </div>

      <ul data-testid="dsh-model-list" className="divide-y divide-border-faint">
        {configured.map((row) => {
          const group = models.find((item) => item.id === row.entry.provider)
          const open = editing === row.entry.provider
          return (
            <li key={row.entry.provider} className="py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="font-pingfang text-[14px] text-text-primary">
                    {row.entry.displayName}
                  </p>
                  {row.entry.declared === true && (
                    <span className="rounded-full bg-control px-2 py-0.5 font-pingfang text-[11px] text-text-muted">
                      {strings.dsh.customGroup}
                    </span>
                  )}
                  <span
                    className={`size-2 rounded-full ${
                      row.credential?.configured || !row.apiKeyEnv
                        ? 'bg-status-done-dot'
                        : 'bg-status-idle-dot'
                    }`}
                    title={
                      row.credential?.configured
                        ? strings.dsh.apiKeyConfigured
                        : strings.dsh.providerIdle
                    }
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="font-pingfang text-[12px] text-text-muted hover:text-text-secondary"
                    onClick={() => setEditing(open ? null : row.entry.provider)}
                  >
                    {strings.dsh.edit}
                  </button>
                  {row.removable && (
                    <button
                      type="button"
                      disabled={locked}
                      className="font-pingfang text-[12px] text-status-error disabled:opacity-40"
                      onClick={() => {
                        if (!window.confirm(strings.dsh.deleteProviderConfirm)) {
                          return
                        }
                        void apply(() =>
                          mutateDshSettings({
                            ns: row.entry.settingsNs,
                            ops: [{ op: 'unset', path: row.entry.settingsPath }]
                          })
                        )
                      }}
                    >
                      {strings.dsh.delete}
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1 font-pingfang text-[12px] text-text-faint">
                {group?.models.map((model) => model.name).join(' · ') ||
                  strings.dsh.emptyModels}
              </p>
              {open && (
                <div className="mt-3 flex items-center gap-1.5">
                  <input
                    type="password"
                    value={addKey}
                    placeholder={strings.dsh.apiKeyPlaceholder}
                    onChange={(event) => setAddKey(event.target.value)}
                    className="w-[220px] rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px]"
                  />
                  <button
                    type="button"
                    disabled={locked || addKey.trim().length === 0}
                    onClick={() =>
                      void apply(async () => {
                        await setDshCredential(
                          row.apiKeyEnv ?? deriveKeyRef(row.entry.provider),
                          addKey.trim()
                        )
                        setAddKey('')
                        setEditing(null)
                      })
                    }
                    className="rounded-lg border border-border-default px-2.5 py-1.5 font-pingfang text-[12px]"
                  >
                    {strings.dsh.save}
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {addMode === 'catalog' && addable[0] && (
        <div className="rounded-2xl border border-border-subtle p-4">
          <p className="mb-3 font-pingfang text-[13px] text-text-secondary">
            {strings.dsh.addProvider}
          </p>
          <Dropdown
            testId="dsh-add-provider"
            value={addProviderId || addable[0].entry.provider}
            options={addable.map((row) => ({
              value: row.entry.provider,
              label: row.entry.displayName
            }))}
            onChange={setAddProviderId}
          />
          <input
            type="password"
            value={addKey}
            placeholder={strings.dsh.apiKeyPlaceholder}
            onChange={(event) => setAddKey(event.target.value)}
            className="mt-3 w-full rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px]"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAddMode(null)}
              className="rounded-lg px-3 py-1.5 font-pingfang text-[12px]"
            >
              {strings.dsh.cancel}
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                const id = addProviderId || addable[0].entry.provider
                const target = addable.find((row) => row.entry.provider === id)
                if (!target) return
                void apply(async () => {
                  await adopt(target)
                  setAddMode(null)
                  setAddKey('')
                })
              }}
              className="rounded-lg bg-button-primary px-3 py-1.5 font-pingfang text-[12px] text-button-primary-fg"
            >
              {strings.dsh.apply}
            </button>
          </div>
        </div>
      )}

      {addMode === 'custom' && (
        <div className="rounded-2xl border border-border-subtle p-4">
          <p className="mb-3 font-pingfang text-[13px] text-text-secondary">
            {strings.dsh.addCustom}
          </p>
          <label className="mb-3 block font-pingfang text-[12px] text-text-secondary">
            {strings.dsh.customRoute}
            <input
              value={customRoute}
              onChange={(event) => setCustomRoute(event.target.value)}
              placeholder="acme-gateway"
              className="mt-1 w-full rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px] text-text-primary"
            />
          </label>
          <label className="mb-3 block font-pingfang text-[12px] text-text-secondary">
            {strings.dsh.displayName}
            <input
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px] text-text-primary"
            />
          </label>
          <label className="mb-3 block font-pingfang text-[12px] text-text-secondary">
            {strings.dsh.baseUrl}
            <input
              value={addBaseUrl}
              onChange={(event) => setAddBaseUrl(event.target.value)}
              placeholder="https://gateway.example/v1"
              className="mt-1 w-full rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px] text-text-primary"
            />
          </label>
          <label className="mb-3 block font-pingfang text-[12px] text-text-secondary">
            {strings.dsh.modelId}
            <input
              value={customModel}
              onChange={(event) => setCustomModel(event.target.value)}
              className="mt-1 w-full rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px] text-text-primary"
            />
          </label>
          <Dropdown
            value={customProtocol}
            options={[
              'openai-completions',
              'openai-responses',
              'anthropic-messages'
            ].map((value) => ({ value, label: value }))}
            onChange={setCustomProtocol}
          />
          <input
            type="password"
            value={addKey}
            placeholder={strings.dsh.apiKeyPlaceholder}
            onChange={(event) => setAddKey(event.target.value)}
            className="mt-3 w-full rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px]"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAddMode(null)}
              className="rounded-lg px-3 py-1.5 font-pingfang text-[12px]"
            >
              {strings.dsh.cancel}
            </button>
            <button
              type="button"
              disabled={
                locked ||
                customRoute.trim().length === 0 ||
                addBaseUrl.trim().length === 0 ||
                customModel.trim().length === 0
              }
              onClick={() =>
                void apply(async () => {
                  const route = customRoute.trim()
                  const keyRef = deriveKeyRef(route)
                  const keyValue = addKey.trim()
                  await mutateDshSettings({
                    ns: 'llm-pi-ai',
                    expectedRevision: customRevision,
                    ops: [
                      {
                        op: 'set',
                        path: ['providers', route],
                        value: {
                          ...(customName.trim()
                            ? { displayName: customName.trim() }
                            : {}),
                          ...(keyValue ? { apiKeyEnv: keyRef } : {}),
                          api: customProtocol,
                          baseURL: addBaseUrl.trim(),
                          models: [{ id: customModel.trim() }]
                        }
                      }
                    ]
                  })
                  if (keyValue) await setDshCredential(keyRef, keyValue)
                  setAddMode(null)
                  setCustomRoute('')
                  setCustomName('')
                  setCustomModel('')
                  setAddBaseUrl('')
                  setAddKey('')
                })
              }
              className="rounded-lg bg-button-primary px-3 py-1.5 font-pingfang text-[12px] text-button-primary-fg"
            >
              {strings.dsh.create}
            </button>
          </div>
        </div>
      )}

      {addMode === null && (
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="dsh-add-provider-btn"
            disabled={addable.length === 0 || locked}
            title={
              addable.length === 0
                ? strings.dsh.emptyModels
                : strings.dsh.addProvider
            }
            onClick={() => {
              setAddProviderId(addable[0]?.entry.provider ?? '')
              setAddKey('')
              setAddMode('catalog')
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-border-default px-3 py-1.5 font-pingfang text-[12px] text-text-secondary disabled:opacity-40"
          >
            <Plus className="size-3.5" />
            {strings.dsh.addProvider}
          </button>
          <button
            type="button"
            data-testid="dsh-add-custom-btn"
            disabled={locked}
            onClick={() => {
              setAddKey('')
              setAddMode('custom')
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-border-default px-3 py-1.5 font-pingfang text-[12px] text-text-secondary"
          >
            <Plus className="size-3.5" />
            {strings.dsh.addCustom}
          </button>
        </div>
      )}
    </div>
  )
}

export async function loadProviderCredentials(
  providers: DshProvider[],
  describe: DshSettingsDescribe | null
): Promise<Record<string, DshCredentialView>> {
  const refs = collectRefs(joinProviderRows(providers, describe, {}))
  return describeDshCredentials(refs)
}

function collectRefs(rows: JoinedProvider[]): string[] {
  return [
    ...new Set(
      rows.flatMap((row) => {
        const named = row.apiKeyEnv
        const derived = deriveKeyRef(row.entry.provider)
        return named ? [named, derived] : [derived]
      })
    )
  ]
}
