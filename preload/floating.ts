import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  FloatingRendererApi,
  FloatingRendererSnapshot
} from '../shared/floating-window'

// Sandboxed preloads cannot require Rollup's relative shared chunks. Keep the
// runtime channel literals in this single-file entry; their types still come
// from the shared contract above.
const FloatingWindowInvokeChannel = {
  SetEnabled: 'floating-window:set-enabled',
  GetSnapshot: 'floating-renderer:get-snapshot',
  ResizeToContent: 'floating-renderer:resize-to-content',
  SetShape: 'floating-renderer:set-shape',
  FocusSession: 'floating-renderer:focus-session'
} as const
const FloatingWindowEventChannel = {
  SnapshotChanged: 'floating-renderer:snapshot-changed'
} as const

function isSnapshot(value: unknown): value is FloatingRendererSnapshot {
  if (!value || typeof value !== 'object') return false
  const raw = value as Partial<FloatingRendererSnapshot>
  return (
    raw.schemaVersion === 1 &&
    Array.isArray(raw.sessions) &&
    raw.sessions.length <= 1_000 &&
    Boolean(raw.appearance) &&
    typeof raw.appearance === 'object' &&
    typeof raw.attentionEffectEnabled === 'boolean'
  )
}

const api: FloatingRendererApi = {
  getSnapshot: async () => {
    const snapshot = await ipcRenderer.invoke(FloatingWindowInvokeChannel.GetSnapshot)
    if (!isSnapshot(snapshot)) throw new Error('invalid floating renderer snapshot')
    return snapshot
  },
  resizeToContent: (height) =>
    ipcRenderer.invoke(FloatingWindowInvokeChannel.ResizeToContent, height),
  setShape: (rects) =>
    ipcRenderer.invoke(FloatingWindowInvokeChannel.SetShape, rects),
  focusSession: (sessionId) =>
    ipcRenderer.invoke(FloatingWindowInvokeChannel.FocusSession, sessionId),
  disable: () =>
    ipcRenderer
      .invoke(FloatingWindowInvokeChannel.SetEnabled, false)
      .then(() => undefined),
  onSnapshot: (callback) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      if (isSnapshot(value)) callback(value)
    }
    ipcRenderer.on(FloatingWindowEventChannel.SnapshotChanged, handler)
    return () =>
      ipcRenderer.removeListener(FloatingWindowEventChannel.SnapshotChanged, handler)
  }
}

contextBridge.exposeInMainWorld('hrackFloating', api)
