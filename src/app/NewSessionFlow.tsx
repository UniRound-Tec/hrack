import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { FolderOpen, Settings2, Terminal as TerminalIcon, X } from 'lucide-react'
import type { LaunchableCli, ShellOption } from '../../shared/ipc-contract'
import { getAdapterIcon } from './adapterIcons'
import {
  findDefaultShell,
  type CliLaunchDraft,
  type CliOption
} from './launchOptions'
import { useStrings } from './i18n'

const LAST_WORKSPACE_KEY = 'vibing.lastWorkspace'

interface NewSessionFlowProps {
  open: boolean
  shells: readonly ShellOption[]
  clis: readonly LaunchableCli[]
  defaultTerminal: string
  initialCli?: CliOption
  initialTerminalPicker?: boolean
  onClose: () => void
  onLaunchTerminal: (shell: ShellOption, remember: boolean) => void
  onLaunchCli: (draft: CliLaunchDraft) => Promise<string | null>
}

function readLastWorkspace(): string {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveLastWorkspace(workspace: string): void {
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY, workspace)
  } catch {
    // Private browsing or a locked-down renderer may reject localStorage.
  }
}

export default function NewSessionFlow({
  open,
  shells,
  clis,
  defaultTerminal,
  initialCli,
  initialTerminalPicker = false,
  onClose,
  onLaunchTerminal,
  onLaunchCli
}: NewSessionFlowProps) {
  const strings = useStrings()
  const [terminalPickerOpen, setTerminalPickerOpen] = useState(false)
  const [rememberDefault, setRememberDefault] = useState(false)
  const [draft, setDraft] = useState<CliLaunchDraft | null>(null)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [closeAfterDraftExit, setCloseAfterDraftExit] = useState(false)
  const defaultShell = findDefaultShell(shells, defaultTerminal)

  useEffect(() => {
    if (!open) {
      setTerminalPickerOpen(false)
      setRememberDefault(false)
      setDraft(null)
      setLaunching(false)
      setLaunchError(null)
      setCloseAfterDraftExit(false)
      return
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (draft && initialCli) {
        setCloseAfterDraftExit(true)
        setDraft(null)
      }
      else if (draft) setDraft(null)
      else if (terminalPickerOpen) setTerminalPickerOpen(false)
      else onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [draft, initialCli, onClose, open, terminalPickerOpen])

  useEffect(() => {
    if (!open) return
    if (initialTerminalPicker) setTerminalPickerOpen(true)
    if (initialCli) openCli(initialCli)
    // The intent is sampled when the flow opens; draft edits must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCli, initialTerminalPicker, open])

  const openCli = (option: CliOption): void => {
    const installation = option.installations[0]
    if (!installation) return
    setDraft({
      option,
      installationId: installation.id,
      name: option.definition.displayName,
      workspace: readLastWorkspace(),
      args: ''
    })
    setLaunchError(null)
  }

  const pickWorkspace = async (): Promise<void> => {
    const installation = draft?.option.installations.find(
      (candidate) => candidate.id === draft.installationId
    )
    if (!draft || !installation) return
    const workspace = await window.dialogApi.pickDirectory({
      defaultPath: draft.workspace || undefined,
      runtime: installation.runtime
    })
    if (!workspace) return
    saveLastWorkspace(workspace)
    setDraft((current) => current ? { ...current, workspace } : current)
  }

  const confirmCli = async (): Promise<void> => {
    if (!draft || launching) return
    if (draft.workspace.trim()) saveLastWorkspace(draft.workspace.trim())
    setLaunching(true)
    setLaunchError(null)
    const error = await onLaunchCli(draft)
    setLaunching(false)
    if (error) setLaunchError(error)
  }

  const closeCliDraft = (): void => {
    if (initialCli) setCloseAfterDraftExit(true)
    setDraft(null)
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          {!draft && !initialCli && (
            <motion.button
              key="new-session-backdrop"
              type="button"
              aria-label={strings.common.close}
              className="absolute inset-0 z-40 bg-backdrop backdrop-blur-[2px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
              onClick={onClose}
            />
          )}
          {!draft && !initialCli && (
            <motion.div
              key="new-session-sheet"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-50 flex justify-center px-4"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 420, damping: 36, mass: 0.85 }}
            >
              <div data-testid="new-session-overlay" role="dialog" aria-modal="true" className="pointer-events-auto flex w-full max-w-[420px] flex-col overflow-hidden rounded-t-2xl border border-border-default border-b-0 bg-surface shadow-2xl">
              <div className="flex justify-center pt-2.5 pb-1"><span className="h-1 w-9 rounded-full bg-button-secondary-hover" /></div>
              <div className="flex items-center justify-between px-4 pb-2">
                <div><h2 className="font-pingfang text-[14px] font-semibold text-text-primary">{strings.newSession.title}</h2><p className="mt-0.5 font-pingfang text-[11px] text-text-faint">{strings.newSession.chooseCli}</p></div>
                <button type="button" data-testid="new-session-close" onClick={onClose} className="flex size-7 items-center justify-center rounded-lg text-text-faint transition-colors hover:bg-surface-strong hover:text-text-secondary"><X className="size-3.5" strokeWidth={1.75} /></button>
              </div>
              <ul className="sidebar-scroll flex max-h-[calc(3rem*6+0.25rem*5)] flex-col gap-1 overflow-y-auto px-3 pb-4">
                <li className="shrink-0">
                  <div className="cursor-target group flex h-12 items-center gap-0.5 rounded-xl transition-colors hover:bg-surface-hover">
                    <button type="button" data-testid="new-session-terminal" disabled={!defaultShell} onClick={() => defaultShell && onLaunchTerminal(defaultShell, false)} className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 text-left font-pingfang disabled:opacity-50">
                      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-strong"><TerminalIcon className="size-4" strokeWidth={1.75} /></span>
                      <span className="min-w-0 flex-1"><span className="block text-[12px] font-semibold text-text-primary">{strings.newSession.terminal}</span><span className="block truncate text-[11px] text-text-faint">{strings.home.defaultTerminal(defaultShell?.name ?? strings.newSession.terminalFallback)}</span></span>
                    </button>
                    <button type="button" data-testid="new-session-terminal-options" aria-label={strings.home.terminalOptions} title={strings.home.terminalOptions} onClick={() => setTerminalPickerOpen(true)} className="mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-text-faint opacity-70 transition-all hover:bg-control hover:text-text-secondary group-hover:opacity-100"><Settings2 className="size-3.5" strokeWidth={1.75} /></button>
                  </div>
                </li>
                {clis.map((option) => {
                  const Icon = getAdapterIcon(option.definition.adapterId)
                  return <li key={option.definition.id} className="shrink-0"><button type="button" data-testid={`new-session-cli-${option.definition.id}`} onClick={() => openCli(option)} className="cursor-target flex h-12 w-full items-center gap-2.5 rounded-xl px-2.5 text-left font-pingfang transition-colors hover:bg-surface-hover"><span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-strong"><Icon size={16} className="size-4" /></span><span className="min-w-0 flex-1"><span className="block text-[12px] font-semibold text-text-primary">{option.definition.displayName}</span><span className="block truncate text-[11px] text-text-faint">{option.installations.map(installationLabel).join(' · ')}</span></span></button></li>
                })}
              </ul>
              </div>
            </motion.div>
          )}

          <AnimatePresence>
            {terminalPickerOpen && (
              <ModalShell testId="terminal-picker" width="380px" title={strings.newSession.chooseTerminal} hint={strings.newSession.chooseTerminalHint} onClose={() => setTerminalPickerOpen(false)}>
                <ul className="flex flex-col gap-1 px-3 py-1">
                  {shells.map((shell) => <li key={shell.id}><button type="button" data-testid={`terminal-option-${shell.id}`} onClick={() => onLaunchTerminal(shell, rememberDefault)} className="cursor-target flex h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left font-pingfang text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"><span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><span className="text-[12px] font-semibold">{shell.name}</span>{defaultTerminal === shell.id && <span className="rounded bg-control px-1 py-px text-[9px] font-medium tracking-wide text-text-muted">{strings.newSession.defaultBadge}</span>}</span><span className="block truncate text-[11px] text-text-faint">{shell.hint}</span></span></button></li>)}
                </ul>
                <label className="mx-3 mt-2 mb-3 flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 font-pingfang transition-colors hover:bg-surface-hover"><input type="checkbox" checked={rememberDefault} onChange={(event) => setRememberDefault(event.target.checked)} className="size-3.5 accent-button-primary" /><span className="text-[12px] text-text-muted">{strings.newSession.rememberDefault}</span></label>
              </ModalShell>
            )}
          </AnimatePresence>

          <AnimatePresence
            onExitComplete={() => {
              if (!closeAfterDraftExit) return
              setCloseAfterDraftExit(false)
              onClose()
            }}
          >
            {draft && (
              <ModalShell testId="cli-config" width="420px" iconAdapterId={draft.option.definition.adapterId} title={strings.newSession.newCli(draft.option.definition.displayName)} hint={strings.newSession.configureThenLaunch} onClose={closeCliDraft}>
                <div className="flex flex-col gap-3 px-4 pb-1">
                  <Field label={strings.newSession.sessionName}><input data-testid="cli-session-name" value={draft.name} placeholder={strings.newSession.sessionNamePlaceholder} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className={fieldClass} /></Field>
                  <Field label={strings.newSession.workspace}><div className="flex gap-1.5"><input data-testid="cli-workspace" value={draft.workspace} placeholder={strings.newSession.workspacePlaceholder} onChange={(event) => setDraft({ ...draft, workspace: event.target.value })} className={`${fieldClass} min-w-0 flex-1`} /><button type="button" data-testid="cli-pick-workspace" title={strings.newSession.chooseWorkspace} onClick={() => void pickWorkspace()} className="flex size-[34px] shrink-0 items-center justify-center rounded-lg border border-border-default bg-input text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary"><FolderOpen className="size-3.5" strokeWidth={1.75} /></button></div></Field>
                  <Field label={strings.newSession.arguments}><input data-testid="cli-arguments" value={draft.args} placeholder={strings.newSession.argumentsPlaceholder} spellCheck={false} onChange={(event) => setDraft({ ...draft, args: event.target.value })} className={`${fieldClass} font-maple text-[11px]`} /></Field>
                  <div className="flex flex-col gap-1.5"><span className="text-[11px] font-medium text-text-muted">{strings.newSession.installation}</span><div className="grid grid-cols-2 gap-1.5">{draft.option.installations.map((installation) => <InstallationButton key={installation.id} installation={installation} selected={draft.installationId === installation.id} onSelect={(installationId) => setDraft({ ...draft, installationId })} />)}</div></div>
                  {launchError && <p role="alert" data-testid="cli-launch-error" className="rounded-lg bg-status-error/10 px-2.5 py-2 font-pingfang text-[11px] text-status-error">{launchError}</p>}
                </div>
                <div className="mt-3 flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-3"><button type="button" onClick={closeCliDraft} className="rounded-lg px-3 py-1.5 font-pingfang text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-strong hover:text-text-secondary">{strings.common.cancel}</button><button type="button" data-testid="cli-launch" disabled={launching} onClick={() => void confirmCli()} className="rounded-lg bg-button-primary px-3 py-1.5 font-pingfang text-[12px] font-medium text-button-primary-fg transition-colors hover:bg-button-primary-hover disabled:opacity-50">{launching ? strings.newSession.launching : strings.newSession.launch}</button></div>
              </ModalShell>
            )}
          </AnimatePresence>
        </>
      )}
    </AnimatePresence>
  )
}

const fieldClass = 'w-full rounded-lg border border-border-default bg-input px-2.5 py-2 font-pingfang text-[12px] text-text-primary outline-none transition-colors placeholder:text-text-faint focus:border-input-focus focus:bg-input-hover'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-[11px] font-medium text-text-muted">{label}</span>{children}</label>
}

function installationLabel(installation: LaunchableCli['installations'][number]): string {
  return installation.runtime.kind === 'wsl'
    ? `WSL · ${installation.runtime.distro}`
    : installation.runtime.platform === 'windows'
      ? 'Windows'
      : installation.runtime.platform === 'macos'
        ? 'macOS'
        : 'Linux'
}

function InstallationButton({ installation, selected, onSelect }: { installation: LaunchableCli['installations'][number]; selected: boolean; onSelect: (id: string) => void }) {
  const runtimeId = installation.runtime.kind === 'wsl' ? `wsl-${installation.runtime.distro}` : installation.runtime.platform
  return <button type="button" data-testid={`cli-installation-${runtimeId}`} onClick={() => onSelect(installation.id)} className={`cursor-target rounded-xl px-3 py-2.5 text-left transition-colors ${selected ? 'bg-button-primary text-button-primary-fg' : 'bg-button-secondary text-button-secondary-fg hover:bg-button-secondary-hover'}`}><span className="block text-[12px] font-semibold">{installationLabel(installation)}</span><span className={`mt-0.5 block truncate text-[10px] ${selected ? 'text-text-inverse/60' : 'text-text-faint'}`}>{installation.version || installation.resolvedExecutable}</span></button>
}

function ModalShell({ testId, width, iconAdapterId, title, hint, onClose, children }: { testId: string; width: string; iconAdapterId?: string; title: string; hint: string; onClose: () => void; children: React.ReactNode }) {
  const strings = useStrings()
  const Icon = iconAdapterId ? getAdapterIcon(iconAdapterId) : null
  return <><motion.button type="button" data-testid={`${testId}-backdrop`} aria-label={strings.common.close} className="absolute inset-0 z-[60] bg-backdrop-strong backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }} onClick={onClose} /><motion.div className="pointer-events-none absolute inset-0 z-[70] flex items-center justify-center p-5" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}><motion.div data-testid={testId} role="dialog" aria-modal="true" className="pointer-events-auto w-full overflow-hidden rounded-2xl border border-border-default bg-surface shadow-2xl" style={{ maxWidth: width }} initial={{ opacity: 0, scale: 0.94, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 10 }} transition={{ type: 'spring', stiffness: 480, damping: 34, mass: 0.8 }}><div className="flex items-start justify-between px-4 pt-4 pb-3"><div className="flex items-center gap-2.5">{Icon && <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-strong"><Icon size={16} className="size-4" /></span>}<div><h2 className="font-pingfang text-[14px] font-semibold text-text-primary">{title}</h2><p className="mt-0.5 font-pingfang text-[11px] text-text-faint">{hint}</p></div></div><button type="button" onClick={onClose} className="flex size-7 items-center justify-center rounded-lg text-text-faint transition-colors hover:bg-surface-strong hover:text-text-secondary"><X className="size-3.5" strokeWidth={1.75} /></button></div>{children}</motion.div></motion.div></>
}
