import type {
  AgentSessionStatus,
  AgentStatusConfidence,
  AgentObserverHealth
} from './agent-events'
import type { UiColorToken, UiThemeType } from './theme-schema'

export const BUILTIN_FLOATING_RENDERER_ID = 'builtin/default'
export const BUILTIN_LIVE2D_FLOATING_RENDERER_ID = 'builtin/live2d-mao'
export const FLOATING_WINDOW_SCALE_MIN = 0.6
export const FLOATING_WINDOW_SCALE_MAX = 1.6
export const FLOATING_RENDERER_SCHEMA_VERSION = 1

export interface FloatingRendererManifest {
  schemaVersion: 1
  id: string
  name: string
  version?: string
  entry: string
  width?: number
  minHeight?: number
  maxHeight?: number
}

export interface FloatingRendererInfo {
  id: string
  name: string
  version: string | null
  source: 'builtin' | 'user'
}

export interface FloatingRendererLoadError {
  rendererId: string | null
  filename: string
  message: string
}

export interface FloatingWindowState {
  enabled: boolean
  selectedRendererId: string
  activeRendererId: string | null
  renderers: FloatingRendererInfo[]
  rendererErrors: FloatingRendererLoadError[]
  activeError: string | null
  attentionEffectEnabled: boolean
  /** Uniform renderer zoom persisted by the host. 1 is the manifest size. */
  scale: number
}

export interface FloatingAppearance {
  themeId: string
  themeType: UiThemeType
  colors: Partial<Record<UiColorToken, string>>
  locale: string
}

export interface FloatingSession {
  sessionId: string
  adapterId: string
  name?: string
  status: AgentSessionStatus
  statusConfidence: AgentStatusConfidence
  observerHealth: AgentObserverHealth
  detail?: string
  pendingAttentionCount: number
  lastActivityAt: number
  lastSeq: number
  /** Real turn metadata projected by the active CLI observer. */
  activeTurnId?: string
  activeToolCount: number
  lastTurnOutcome?: 'completed' | 'cancelled' | 'failed'
}

export type FloatingAttentionKind = 'needs-you' | 'done' | 'error'

export interface FloatingAttentionSignal {
  sequence: number
  sessionId: string
  kind: FloatingAttentionKind
  occurredAt: number
}

export interface FloatingRendererSnapshot {
  schemaVersion: 1
  sessions: FloatingSession[]
  attention: FloatingAttentionSignal | null
  appearance: FloatingAppearance
  attentionEffectEnabled: boolean
}

export interface FloatingShapeRect {
  x: number
  y: number
  width: number
  height: number
}

export const FloatingWindowInvokeChannel = {
  GetState: 'floating-window:get-state',
  SetEnabled: 'floating-window:set-enabled',
  SetRenderer: 'floating-window:set-renderer',
  SetAttentionEffect: 'floating-window:set-attention-effect',
  SetScale: 'floating-window:set-scale',
  OpenRenderersDirectory: 'floating-window:open-renderers-directory',
  RefreshRenderers: 'floating-window:refresh-renderers',
  GetSnapshot: 'floating-renderer:get-snapshot',
  ResizeToContent: 'floating-renderer:resize-to-content',
  SetShape: 'floating-renderer:set-shape',
  FocusSession: 'floating-renderer:focus-session'
} as const

export const FloatingWindowEventChannel = {
  StateChanged: 'floating-window:state-changed',
  SnapshotChanged: 'floating-renderer:snapshot-changed'
} as const

export interface FloatingWindowApi {
  getState: () => Promise<FloatingWindowState>
  setEnabled: (enabled: boolean) => Promise<FloatingWindowState>
  setRenderer: (rendererId: string) => Promise<FloatingWindowState>
  setAttentionEffectEnabled: (enabled: boolean) => Promise<FloatingWindowState>
  setScale: (scale: number) => Promise<FloatingWindowState>
  openRenderersDirectory: () => Promise<void>
  refreshRenderers: () => Promise<FloatingWindowState>
  onStateChanged: (cb: (state: FloatingWindowState) => void) => () => void
}

/** The only bridge exposed to built-in and user-authored floating renderers. */
export interface FloatingRendererApi {
  getSnapshot: () => Promise<FloatingRendererSnapshot>
  resizeToContent: (height: number) => Promise<void>
  /** Apply a native hit-test/drawing shape on Windows/Linux. */
  setShape: (rects: FloatingShapeRect[]) => Promise<void>
  focusSession: (sessionId: string) => Promise<boolean>
  disable: () => Promise<void>
  onSnapshot: (cb: (snapshot: FloatingRendererSnapshot) => void) => () => void
}
