/**
 * 把官方 AppFrame 收成 vibing 壳层要用的两种面：
 * - session：侧栏轨道压成 0，只留 conversation / details
 * - settings：打开官方设置面板，并限制在 surface host 内
 */

import './primitivesFallback.css'
import './surfaceChrome.css'

export type DshSurfaceMode = 'hidden' | 'session' | 'settings'

const TRIGGER = '[class*="_settingsArea"] button[aria-haspopup="dialog"]'
const DIALOG = '[role="dialog"][aria-modal="true"]'
const PANEL = '[class*="_panel"]'
const CLOSE = '[role="dialog"][aria-modal="true"] button[class*="_close"], [class*="_panel"] button[class*="_close"]'
const FRAME = '[class*="_frame"]'
const MODE_WAIT_MS = 8_000

let chromeObserver: MutationObserver | null = null
let settingsWatcher: MutationObserver | null = null
let leaveSettings: (() => void) | null = null
let currentMode: DshSurfaceMode = 'hidden'

function pinSidebarTrack(host: HTMLElement): void {
  if (currentMode === 'settings') return
  const frame = host.querySelector<HTMLElement>(FRAME)
  if (!frame) return
  const cols = frame.style.gridTemplateColumns
  if (!cols) return
  const next = cols.replace(/^\S+/, '0px')
  if (frame.style.gridTemplateColumns !== next) {
    frame.style.setProperty('grid-template-columns', next, 'important')
  }
}

function isPainted(node: Element | null): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false
  return node.getClientRects().length > 0
}

function settingsOpen(host: HTMLElement): boolean {
  return isPainted(host.querySelector(DIALOG)) || isPainted(host.querySelector(PANEL))
}

function markSettingsOpen(host: HTMLElement): void {
  if (settingsOpen(host)) host.dataset.dshSettingsOpen = ''
  else delete host.dataset.dshSettingsOpen
}

function clickWhenReady(
  host: HTMLElement,
  selector: string,
  timeoutMs: number
): Promise<boolean> {
  const started = Date.now()
  return new Promise((resolve) => {
    const tick = (): void => {
      const node = host.querySelector<HTMLElement>(selector)
      if (node) {
        node.click()
        resolve(true)
        return
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false)
        return
      }
      window.setTimeout(tick, 50)
    }
    tick()
  })
}

async function openOfficialSettings(host: HTMLElement): Promise<void> {
  markSettingsOpen(host)
  if (settingsOpen(host)) return
  await clickWhenReady(host, TRIGGER, MODE_WAIT_MS)
  markSettingsOpen(host)
}

function closeOfficialSettings(host: HTMLElement): void {
  if (!settingsOpen(host)) return
  const close = host.querySelector<HTMLElement>(CLOSE)
  if (close) {
    close.click()
    return
  }
  const trigger = host.querySelector<HTMLElement>(TRIGGER)
  if (trigger?.getAttribute('aria-expanded') === 'true') trigger.click()
}

function watchSettingsClose(host: HTMLElement): void {
  let seenOpen = settingsOpen(host)
  settingsWatcher?.disconnect()
  settingsWatcher = new MutationObserver(() => {
    if (currentMode !== 'settings') return
    markSettingsOpen(host)
    if (settingsOpen(host)) {
      seenOpen = true
      return
    }
    if (!seenOpen) return
    const leave = leaveSettings
    if (leave) window.queueMicrotask(leave)
  })
  settingsWatcher.observe(host, { childList: true, subtree: true })
}

function watchFrame(host: HTMLElement): void {
  chromeObserver?.disconnect()
  chromeObserver = new MutationObserver(() => pinSidebarTrack(host))
  chromeObserver.observe(host, {
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'data-sidebar-collapsed']
  })
  pinSidebarTrack(host)
}

export function applyDshSurfaceMode(
  host: HTMLElement,
  mode: DshSurfaceMode,
  options?: { onLeaveSettings?: () => void }
): void {
  currentMode = mode
  leaveSettings = options?.onLeaveSettings ?? null
  host.dataset.dshMode = mode
  document.documentElement.dataset.dshSurface = mode
  document.body.toggleAttribute(
    'data-ds-dark-theme',
    document.documentElement.dataset.uiThemeType === 'dark'
  )
  watchFrame(host)
  if (mode === 'settings') {
    void openOfficialSettings(host).then(() => {
      if (currentMode !== 'settings') return
      watchSettingsClose(host)
    })
    return
  }
  settingsWatcher?.disconnect()
  settingsWatcher = null
  delete host.dataset.dshSettingsOpen
  closeOfficialSettings(host)
}
