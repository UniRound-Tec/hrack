import { BrowserWindow, shell, WebContentsView } from 'electron'
import { join } from 'node:path'
import type {
  DshSurfaceAppearance,
  DshSurfaceBounds,
  DshSurfaceShowRequest,
  DshSurfaceSnapshot
} from '../../shared/dsh-ipc'
import { DSH_SURFACE_ACTIVE_SESSION_REPORT_CHANNEL } from '../../shared/dsh-ipc'
import { isCssColorLiteral } from '../../shared/theme-schema'
import type { DshHostManager } from '../dsh-host/DshHostManager'

const RUNTIME_READY_TIMEOUT_MS = 20_000
const SESSION_READY_TIMEOUT_MS = 20_000
const SIDEBAR_COLLAPSE_MAX_ATTEMPTS = 3
const MAX_SESSION_ID_LENGTH = 256
const MAX_TOKEN_COUNT = 64
const MAX_CSS_VALUE_LENGTH = 256
const TOKEN_NAME = /^--dsw-[a-z0-9-]+$/

const WAIT_FOR_RUNTIME_SCRIPT = `
(async () => {
  const deadline = Date.now() + ${RUNTIME_READY_TIMEOUT_MS};
  while (Date.now() < deadline) {
    const state = globalThis.__HRACK_DSH_EMBED__;
    const ctx = state?.ctx;
    if (ctx) {
      try {
        const sessions = ctx.get('sessions');
        const layout = ctx.get('layout');
        const theme = ctx.get('theme');
        if (sessions && layout && theme) {
          return {
            locale: ctx.get('locale')?.getLocale?.()?.active,
            sessionPhase: sessions.list?.getSnapshot?.()?.phase
          };
        }
      } catch {
        // Cordis services are still mounting; retry until the explicit deadline.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const state = globalThis.__HRACK_DSH_EMBED__;
  throw new Error(
    'official DSH runtime bridge was not captured' +
    (state?.captureError ? ': ' + state.captureError : '')
  );
})()`

const INSTALL_ACTIVE_SESSION_REPORTER_SCRIPT = `
(() => {
  const state = globalThis.__HRACK_DSH_EMBED__;
  const sessions = state?.ctx?.get?.('sessions');
  const bridge = globalThis.__HRACK_DSH_HOST_BRIDGE__;
  if (!state || !sessions?.list || typeof bridge?.reportActiveSession !== 'function') {
    throw new Error('official DSH active-session bridge is unavailable');
  }
  if (typeof state.reportActiveSession === 'function') {
    state.reportActiveSession();
    return true;
  }
  state.reportActiveSession = () => {
    const current = sessions.list.getSnapshot?.()?.current;
    const next = typeof current === 'string' ? current : null;
    if (state.activeSessionReported && state.lastReportedActiveSession === next) return;
    state.activeSessionReported = true;
    state.lastReportedActiveSession = next;
    bridge.reportActiveSession(next);
  };
  state.activeSessionDisposer = sessions.list.subscribe(state.reportActiveSession);
  state.reportActiveSession();
  return true;
})()`

function collapseOfficialSidebarScript(forceTransientFailure = false): string {
  return `
(async () => {
  const state = globalThis.__HRACK_DSH_EMBED__;
  const ctx = state?.ctx;
  if (!ctx) throw new Error('official DSH runtime is unavailable');
  document.documentElement.dataset.hrackEmbedded = 'true';

  const frameDeadline = Date.now() + 5000;
  let frame;
  while (Date.now() < frameDeadline) {
    frame = document.querySelector('[data-details-collapsed]');
    if (frame) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!frame) throw new Error('official DSH layout frame is unavailable');

  // AppFrame derives its breakpoint from a ResizeObserver. Give that observer
  // and React two paints to absorb the WebContents zoom set by HRack before
  // deciding whether the current frame is actually expanded.
  await new Promise((resolve) => {
    let frames = 0;
    const fallback = setTimeout(resolve, 500);
    const next = () => {
      frames += 1;
      if (frames >= 3) {
        clearTimeout(fallback);
        resolve();
      }
      else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  });

  // toggleSidebar is intentionally a toggle-only API. Inspect the official
  // layout marker first so an already-collapsed surface is never expanded.
  if (!frame.hasAttribute('data-sidebar-collapsed')) {
    if (${forceTransientFailure ? 'true' : 'false'}) {
      throw new Error('official DSH sidebar did not collapse');
    }
    ctx.get('layout').toggleSidebar();
    const collapseDeadline = Date.now() + 3000;
    while (Date.now() < collapseDeadline) {
      if (frame.hasAttribute('data-sidebar-collapsed')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!frame.hasAttribute('data-sidebar-collapsed')) {
      throw new Error('official DSH sidebar did not collapse');
    }
  }
  state.sidebarDefaultApplied = true;
  return { sidebarCollapsed: true, width: window.innerWidth };
})()`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid DSH surface ${label}`)
  }
  return value
}

export function sanitizeDshSurfaceBounds(value: unknown): DshSurfaceBounds {
  if (!isRecord(value)) throw new Error('invalid DSH surface bounds')
  const x = finiteNumber(value['x'], 'x')
  const y = finiteNumber(value['y'], 'y')
  const width = finiteNumber(value['width'], 'width')
  const height = finiteNumber(value['height'], 'height')
  const cornerRadius = finiteNumber(value['cornerRadius'] ?? 0, 'cornerRadius')
  if (
    x < 0 ||
    y < 0 ||
    width < 1 ||
    height < 1 ||
    cornerRadius < 0 ||
    cornerRadius > 32 ||
    x > 100_000 ||
    y > 100_000 ||
    width > 100_000 ||
    height > 100_000
  ) {
    throw new Error('invalid DSH surface bounds range')
  }
  return { x, y, width, height, cornerRadius }
}

function sanitizeAppearance(value: unknown): DshSurfaceAppearance {
  if (!isRecord(value)) throw new Error('invalid DSH surface appearance')
  const colorScheme = value['colorScheme']
  const locale = value['locale']
  const scale = finiteNumber(value['scale'], 'scale')
  const backgroundColor = value['backgroundColor']
  const rawTokens = value['tokens']
  if (colorScheme !== 'light' && colorScheme !== 'dark') {
    throw new Error('invalid DSH surface color scheme')
  }
  if (locale !== 'zh' && locale !== 'en') {
    throw new Error('invalid DSH surface locale')
  }
  if (scale < 0.75 || scale > 1.25) {
    throw new Error('invalid DSH surface scale')
  }
  if (!isCssColorLiteral(backgroundColor)) {
    throw new Error('invalid DSH surface background')
  }
  if (!isRecord(rawTokens)) {
    throw new Error('invalid DSH surface tokens')
  }
  const entries = Object.entries(rawTokens)
  if (entries.length > MAX_TOKEN_COUNT) {
    throw new Error('too many DSH surface tokens')
  }
  const tokens: Record<string, string> = {}
  for (const [name, tokenValue] of entries) {
    if (
      !TOKEN_NAME.test(name) ||
      !isCssColorLiteral(tokenValue) ||
      tokenValue.length > MAX_CSS_VALUE_LENGTH
    ) {
      throw new Error(`invalid DSH surface token: ${name}`)
    }
    tokens[name] = tokenValue.trim()
  }
  return {
    colorScheme,
    locale,
    scale,
    backgroundColor: backgroundColor.trim(),
    tokens
  }
}

function sanitizeSessionId(value: unknown, optional: boolean): string | undefined {
  if (optional && (value === undefined || value === null)) return undefined
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SESSION_ID_LENGTH ||
    value.includes('\0')
  ) {
    throw new Error('invalid DSH surface session id')
  }
  return value
}

export function sanitizeDshSurfaceShowRequest(
  value: unknown
): DshSurfaceShowRequest {
  if (!isRecord(value)) throw new Error('invalid DSH surface request')
  const slotId = sanitizeSessionId(value['slotId'], false)!
  const intent = value['intent']
  if (intent !== 'new' && intent !== 'resume') {
    throw new Error('invalid DSH surface intent')
  }
  const sessionId = sanitizeSessionId(value['sessionId'], true)
  if (
    (intent === 'new' && sessionId !== undefined) ||
    (intent === 'resume' && sessionId === undefined)
  ) {
    throw new Error('invalid DSH surface intent/session combination')
  }
  return {
    slotId,
    intent,
    ...(sessionId ? { sessionId } : {}),
    bounds: sanitizeDshSurfaceBounds(value['bounds']),
    appearance: sanitizeAppearance(value['appearance'])
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTransientSidebarCollapseError(error: unknown): boolean {
  return errorMessage(error).includes('official DSH sidebar did not collapse')
}

/**
 * Owns the isolated official DSH page. The HRack renderer sees only the
 * semantic show / bounds / hide seam; official DOM, CSS, portals and Cordis
 * runtime never enter HRack's document.
 */
export class DshWebSurfaceController {
  private view: WebContentsView | null = null
  private loadedBaseUrl: string | null = null
  private loadedLocale: 'zh' | 'en' | null = null
  private phase: DshSurfaceSnapshot['phase'] = 'hidden'
  private visible = false
  private slotId: string | undefined
  private sessionId: string | undefined
  private bounds: DshSurfaceBounds | undefined
  private error: string | undefined
  private generation = 0
  private operation: Promise<void> = Promise.resolve()
  private sidebarDefaultApplied = false
  private sidebarDefaultOperation: Promise<void> | null = null
  private sidebarCollapseInvocationCount = 0
  private activeSessionId: string | undefined
  private activeSessionReported = false
  private nativeViewVisible = false
  private hideTransitionCount = 0
  private lastRequest: DshSurfaceShowRequest | null = null

  constructor(
    private readonly owner: BrowserWindow,
    private readonly host: DshHostManager,
    private readonly projection: {
      activateSlot(slotId: string, sessionId?: string): void
      setActiveSession(sessionId: string | undefined): void
      unfollow(slotId: string): void
    }
  ) {}

  owns(window: BrowserWindow | null): boolean {
    return window === this.owner && !this.owner.isDestroyed()
  }

  show(value: unknown): Promise<DshSurfaceSnapshot> {
    const request = sanitizeDshSurfaceShowRequest(value)
    const generation = ++this.generation
    const keepCurrentViewVisible =
      request.intent === 'resume' &&
      this.nativeViewVisible &&
      Boolean(this.view && !this.view.webContents.isDestroyed())
    this.phase = 'loading'
    this.visible = keepCurrentViewVisible
    this.lastRequest = request
    this.slotId = request.slotId
    this.sessionId = request.sessionId
    this.projection.activateSlot(request.slotId, request.sessionId)
    this.bounds = this.clampBounds(request.bounds)
    this.error = undefined
    this.applyBounds()
    if (!keepCurrentViewVisible) this.setViewVisible(false)

    const result = this.operation
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.showNow(request, generation)
        } catch (error) {
          if (generation === this.generation) {
            this.phase = 'failed'
            this.visible = false
            this.error = errorMessage(error)
            this.setViewVisible(false)
          }
        }
      })
      .then(() => this.snapshot())
    this.operation = result.then(() => undefined)
    return result
  }

  setBounds(value: unknown): void {
    const bounds = sanitizeDshSurfaceBounds(value)
    this.bounds = this.clampBounds(bounds)
    this.applyBounds()
    void this.ensureOfficialSidebarDefaultCollapsed().catch(() => undefined)
  }

  hide(): void {
    ++this.generation
    this.phase = 'hidden'
    this.visible = false
    this.error = undefined
    this.setViewVisible(false)
  }

  unfollow(value: unknown): void {
    this.projection.unfollow(sanitizeSessionId(value, false)!)
  }

  hostStopped(): void {
    ++this.generation
    this.destroyView()
    this.projection.setActiveSession(undefined)
    this.phase = 'hidden'
    this.visible = false
    this.error = undefined
    this.slotId = undefined
    this.sessionId = undefined
    this.activeSessionId = undefined
    this.activeSessionReported = false
  }

  /**
   * Kill the dsh OS process, spawn a new host, and reload the official page.
   * Returns only after the surface is ready again (or failed).
   */
  async restartHost(): Promise<DshSurfaceSnapshot> {
    const request = this.lastRequest
    const reload = Boolean(request) && this.phase !== 'hidden'
    const generation = ++this.generation
    this.operation = Promise.resolve()
    this.destroyView()
    this.phase = reload ? 'loading' : 'hidden'
    this.visible = false
    this.error = undefined
    this.activeSessionId = undefined
    this.activeSessionReported = false

    const status = await this.host.restart()
    if (generation !== this.generation) return this.snapshot()
    if (status.state !== 'ready' || !status.baseUrl) {
      this.phase = 'failed'
      this.error = status.error ?? 'DSH host is not ready'
      return this.snapshot()
    }
    if (!reload || !request) return this.snapshot()
    try {
      await this.showNow(request, generation)
    } catch (error) {
      if (generation === this.generation) {
        this.phase = 'failed'
        this.error = errorMessage(error)
        this.setViewVisible(false)
      }
    }
    return this.snapshot()
  }

  dispose(): void {
    this.hostStopped()
  }

  snapshot(): DshSurfaceSnapshot {
    return {
      phase: this.phase,
      visible: this.visible,
      slotId: this.slotId,
      sessionId: this.sessionId,
      bounds: this.bounds,
      url: this.loadedBaseUrl ?? undefined,
      error: this.error
    }
  }

  async inspect(): Promise<Record<string, unknown>> {
    const base = this.snapshot()
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return { ...base }
    try {
      const page = await view.webContents.executeJavaScript(
        `(() => {
          const state = globalThis.__HRACK_DSH_EMBED__;
          const sessions = state?.ctx?.get?.('sessions');
          const frame = document.querySelector('[data-details-collapsed]');
          const frameStyle = frame ? getComputedStyle(frame) : null;
          const cssRuleCount = [...document.styleSheets].reduce((total, sheet) => {
            try {
              return total + sheet.cssRules.length;
            } catch {
              return total;
            }
          }, 0);
          return {
            href: location.href,
            title: document.title,
            currentSession: sessions?.list?.getSnapshot?.()?.current,
            linkedStyleSheets: [...document.querySelectorAll('link[rel="stylesheet"]')]
              .map((link) => link.href),
            styleElementCount: document.querySelectorAll('style').length,
            cssRuleCount,
            viewportWidth: window.innerWidth,
            bodyTextLength: document.body?.innerText?.trim().length ?? 0,
            bodyFontSize: getComputedStyle(document.body).fontSize,
            darkTheme: document.body.hasAttribute('data-ds-dark-theme'),
            frameDisplay: frameStyle?.display,
            frameColumns: frameStyle?.gridTemplateColumns,
            sidebarClosed: frame?.hasAttribute('data-sidebar-collapsed') === true,
            sidebarDefaultApplied: state?.sidebarDefaultApplied === true,
            embedded: document.documentElement.dataset.hrackEmbedded === 'true'
          };
        })()`,
        true
      )
      return {
        ...base,
        hideTransitionCount: this.hideTransitionCount,
        sidebarCollapseInvocationCount: this.sidebarCollapseInvocationCount,
        zoomFactor: view.webContents.getZoomFactor(),
        page
      }
    } catch (error) {
      return { ...base, inspectError: errorMessage(error) }
    }
  }

  /** E2E-only helper: move a fresh official profile past its own onboarding. */
  async dismissOnboardingForTest(): Promise<boolean> {
    const view = this.requireView()
    return view.webContents.executeJavaScript(
      `(async () => {
        const labels = ['继续', '稍后配置', 'Continue', 'Set up later'];
        let clicked = false;
        for (const label of labels) {
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            const button = [...document.querySelectorAll('button')].find(
              (candidate) => candidate.textContent?.trim() === label
            );
            if (button) {
              button.click();
              clicked = true;
              await new Promise((resolve) => setTimeout(resolve, 100));
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        return clicked;
      })()`,
      true
    )
  }

  /** E2E-only helper: reproduce a selection made inside the official page. */
  async selectSessionForTest(value: unknown): Promise<boolean> {
    await this.openSession(sanitizeSessionId(value, false)!)
    return true
  }

  private async showNow(
    request: DshSurfaceShowRequest,
    generation: number
  ): Promise<void> {
    const status = await this.host.ensureStarted()
    if (generation !== this.generation) return
    if (status.state !== 'ready' || !status.baseUrl) {
      throw new Error(status.error ?? 'DSH host is not ready')
    }
    await this.ensureView(
      status.baseUrl,
      request.appearance.locale,
      request.appearance.scale
    )
    if (generation !== this.generation) return

    const view = this.requireView()
    this.applyBounds()
    this.applyViewBackground(request.appearance)
    // Chromium resets page zoom during a top-level navigation. Set it once
    // before loading for the initial viewport and confirm it again afterward.
    view.webContents.setZoomFactor(request.appearance.scale)
    await this.applyAppearance(request.appearance)
    if (generation !== this.generation) return
    if (request.intent === 'new') {
      await this.clearSession()
    } else if (
      request.sessionId &&
      request.sessionId !== this.activeSessionId
    ) {
      await this.openSession(request.sessionId)
    }
    if (generation !== this.generation) return
    // A hidden WebContentsView does not reliably advance animation frames.
    // Reveal only after the requested session is ready, then let the official
    // layout absorb zoom and apply the one-time default collapse.
    this.setViewVisible(true)
    await this.ensureOfficialSidebarDefaultCollapsed()
    if (generation !== this.generation) return

    this.phase = 'ready'
    this.visible = true
    this.error = undefined
    this.setViewVisible(true)
  }

  private async ensureView(
    baseUrl: string,
    locale: 'zh' | 'en',
    scale: number
  ): Promise<void> {
    if (
      this.view &&
      !this.view.webContents.isDestroyed() &&
      this.loadedBaseUrl === baseUrl &&
      this.loadedLocale === locale
    ) {
      this.view.webContents.setZoomFactor(scale)
      return
    }
    this.destroyView()
    if (this.owner.isDestroyed()) throw new Error('main window is unavailable')

    const origin = new URL(baseUrl).origin
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/dsh-surface.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        partition: 'persist:hrack-dsh-surface',
        additionalArguments: [`--hrack-dsh-locale=${locale}`]
      }
    })
    this.view = view
    this.nativeViewVisible = false
    this.loadedBaseUrl = baseUrl
    this.loadedLocale = locale
    view.webContents.setZoomFactor(scale)
    view.setVisible(false)
    this.applyBounds()
    this.owner.contentView.addChildView(view)
    view.webContents.on('ipc-message', (_event, channel, value) => {
      if (
        this.view !== view ||
        channel !== DSH_SURFACE_ACTIVE_SESSION_REPORT_CHANNEL
      ) {
        return
      }
      try {
        this.handleActiveSessionChanged(sanitizeSessionId(value, true))
      } catch (error) {
        console.warn('[dsh-surface] dropped invalid active session', error)
      }
    })

    const allowSameOrigin = (candidate: string): boolean => {
      try {
        return new URL(candidate).origin === origin
      } catch {
        return false
      }
    }
    const guardNavigation = (
      event: Electron.Event,
      targetUrl: string
    ): void => {
      if (!allowSameOrigin(targetUrl)) event.preventDefault()
    }
    view.webContents.on('will-navigate', guardNavigation)
    view.webContents.on('will-redirect', guardNavigation)
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (!allowSameOrigin(url)) {
        try {
          const protocol = new URL(url).protocol
          if (protocol === 'http:' || protocol === 'https:') {
            void shell.openExternal(url)
          }
        } catch {
          // Invalid and non-web URLs are denied without side effects.
        }
      }
      return { action: 'deny' }
    })
    view.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false)
    )

    try {
      await view.webContents.loadURL(baseUrl)
      await view.webContents.executeJavaScript(WAIT_FOR_RUNTIME_SCRIPT, true)
      await view.webContents.executeJavaScript(
        INSTALL_ACTIVE_SESSION_REPORTER_SCRIPT,
        true
      )
    } catch (error) {
      if (this.view === view) this.destroyView()
      throw error
    }
  }

  private async applyAppearance(
    appearance: DshSurfaceAppearance
  ): Promise<void> {
    const payload = JSON.stringify(appearance)
    await this.requireView().webContents.executeJavaScript(
      `(() => {
        const appearance = ${payload};
        const state = globalThis.__HRACK_DSH_EMBED__;
        const ctx = state?.ctx;
        if (!ctx) throw new Error('official DSH runtime is unavailable');
        const tokenModes = Object.fromEntries(
          Object.entries(appearance.tokens).map(([name, value]) => [
            name,
            { light: value, dark: value }
          ])
        );
        state.themeDisposer = ctx.get('theme').overrideTokens(
          'hrack-web-surface',
          tokenModes
        );
        state.colorScheme = appearance.colorScheme;
        const syncScheme = () => {
          document.documentElement.style.colorScheme = state.colorScheme;
          document.body?.toggleAttribute(
            'data-ds-dark-theme',
            state.colorScheme === 'dark'
          );
        };
        syncScheme();
        if (!state.themeObserver && document.body) {
          state.themeObserver = new MutationObserver(syncScheme);
          state.themeObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['data-ds-dark-theme']
          });
        }
        return true;
      })()`,
      true
    )
  }

  private async openSession(sessionId: string): Promise<void> {
    const encoded = JSON.stringify(sessionId)
    await this.requireView().webContents.executeJavaScript(
      `(async () => {
        const target = ${encoded};
        const state = globalThis.__HRACK_DSH_EMBED__;
        const sessions = state?.ctx?.get?.('sessions');
        if (!sessions) throw new Error('official DSH sessions service is unavailable');
        const deadline = Date.now() + ${SESSION_READY_TIMEOUT_MS};
        while (Date.now() < deadline) {
          const snapshot = sessions.list.getSnapshot();
          if (snapshot.byId?.[target]) {
            sessions.open(target);
            if (sessions.list.getSnapshot().current === target) return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const snapshot = sessions.list.getSnapshot();
        throw new Error(
          'DSH session is unavailable: ' + target +
          ' (phase=' + String(snapshot.phase) + ')'
        );
      })()`,
      true
    )
  }

  private async clearSession(): Promise<void> {
    await this.requireView().webContents.executeJavaScript(
      `(async () => {
        const state = globalThis.__HRACK_DSH_EMBED__;
        const sessions = state?.ctx?.get?.('sessions');
        if (!sessions || typeof sessions.clear !== 'function') {
          throw new Error('official DSH sessions.clear is unavailable');
        }
        sessions.clear();
        const deadline = Date.now() + ${SESSION_READY_TIMEOUT_MS};
        while (Date.now() < deadline) {
          if (sessions.list.getSnapshot().current === undefined) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('official DSH session selection did not clear');
      })()`,
      true
    )
  }

  private handleActiveSessionChanged(sessionId: string | undefined): void {
    if (this.activeSessionReported && this.activeSessionId === sessionId) return
    this.activeSessionReported = true
    this.activeSessionId = sessionId
    this.sessionId = sessionId
    this.projection.setActiveSession(sessionId)
  }

  private requireView(): WebContentsView {
    if (!this.view || this.view.webContents.isDestroyed()) {
      throw new Error('official DSH Web surface is unavailable')
    }
    return this.view
  }

  private clampBounds(bounds: DshSurfaceBounds): DshSurfaceBounds {
    if (this.owner.isDestroyed()) return bounds
    const [contentWidth, contentHeight] = this.owner.getContentSize()
    const maxWidth = Math.max(1, contentWidth)
    const maxHeight = Math.max(1, contentHeight)
    const x = Math.min(maxWidth - 1, Math.max(0, Math.floor(bounds.x)))
    const y = Math.min(maxHeight - 1, Math.max(0, Math.floor(bounds.y)))
    const right = Math.min(maxWidth, Math.ceil(bounds.x + bounds.width))
    const bottom = Math.min(maxHeight, Math.ceil(bounds.y + bounds.height))
    return {
      x,
      y,
      width: Math.max(1, right - x),
      height: Math.max(1, bottom - y),
      cornerRadius: bounds.cornerRadius
    }
  }

  private applyBounds(): void {
    if (!this.bounds || !this.view || this.view.webContents.isDestroyed()) return
    const { x, y, width, height, cornerRadius } = this.bounds
    this.view.setBounds({ x, y, width, height })
    try {
      this.view.setBorderRadius(cornerRadius)
    } catch {
      // 平台不支持原生圆角时退回直角，避免影响 DSH 展示。
    }
  }

  private applyViewBackground(appearance: DshSurfaceAppearance): void {
    const view = this.requireView()
    try {
      view.setBackgroundColor(appearance.backgroundColor)
    } catch {
      view.setBackgroundColor(
        appearance.colorScheme === 'dark' ? '#1e1e1e' : '#ffffff'
      )
    }
  }

  private ensureOfficialSidebarDefaultCollapsed(): Promise<void> {
    const view = this.view
    if (
      this.sidebarDefaultApplied ||
      !view ||
      view.webContents.isDestroyed()
    ) {
      return Promise.resolve()
    }
    if (this.sidebarDefaultOperation) return this.sidebarDefaultOperation
    const collapse = async (): Promise<void> => {
      for (let attempt = 1; attempt <= SIDEBAR_COLLAPSE_MAX_ATTEMPTS; attempt++) {
        const invocation = ++this.sidebarCollapseInvocationCount
        const forceTransientFailure =
          process.env['HRACK_E2E'] === '1' &&
          process.env['HRACK_E2E_DSH_COLLAPSE_FAIL_ONCE'] === '1' &&
          invocation === 1
        try {
          await view.webContents.executeJavaScript(
            collapseOfficialSidebarScript(forceTransientFailure),
            true
          )
          return
        } catch (error) {
          if (
            attempt === SIDEBAR_COLLAPSE_MAX_ATTEMPTS ||
            !isTransientSidebarCollapseError(error)
          ) {
            throw error
          }
        }
      }
    }
    const operation = collapse()
      .then(() => {
        if (this.view === view) this.sidebarDefaultApplied = true
      })
      .finally(() => {
        if (this.sidebarDefaultOperation === operation) {
          this.sidebarDefaultOperation = null
        }
      })
    this.sidebarDefaultOperation = operation
    return operation
  }

  private setViewVisible(visible: boolean): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    if (this.nativeViewVisible && !visible) this.hideTransitionCount++
    this.nativeViewVisible = visible
    this.view.setVisible(visible)
  }

  private destroyView(): void {
    this.operation = Promise.resolve()
    const view = this.view
    this.view = null
    this.nativeViewVisible = false
    this.loadedBaseUrl = null
    this.loadedLocale = null
    this.sidebarDefaultApplied = false
    this.sidebarDefaultOperation = null
    this.sidebarCollapseInvocationCount = 0
    if (!view) return
    try {
      view.setVisible(false)
      if (!this.owner.isDestroyed()) {
        this.owner.contentView.removeChildView(view)
      }
    } catch {
      // Window teardown may already have detached native children.
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
}
