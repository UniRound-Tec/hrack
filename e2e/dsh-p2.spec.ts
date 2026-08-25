import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync } from 'fs'
import { resolve } from 'path'
import { launchApp } from './helpers'

async function waitHostReady(window: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const status = await window.dshApi.getStatus()
          if (status.state === 'failed') {
            throw new Error(status.error ?? 'DSH host failed without an error')
          }
          return status.state
        }),
      { timeout: 120_000, intervals: [500, 1000, 2000] }
    )
    .toBe('ready')
}

async function navigate(window: Page, page: string): Promise<void> {
  await window.evaluate((next) => {
    ;(
      window as unknown as { __hrackDebugShell: { navigate(page: string): void } }
    ).__hrackDebugShell.navigate(next)
  }, page)
}

interface DshBinding {
  slotId: string
  adapterSessionId?: string
}

async function homeDshBindings(window: Page): Promise<DshBinding[]> {
  return window.evaluate(() =>
    (
      window as unknown as {
        __hrackDebugShell: {
          agentSessions(): Array<{
            sessionId: string
            adapterSessionId?: string
            kind?: string
          }>
        }
      }
    ).__hrackDebugShell
      .agentSessions()
      .filter(
        (session) =>
          session.kind === 'dsh' && !session.sessionId.startsWith('official:')
      )
      .map((session) => ({
        slotId: session.sessionId,
        adapterSessionId: session.adapterSessionId
      }))
  )
}

async function activeHomeDshBindings(window: Page): Promise<DshBinding[]> {
  return window.evaluate(async () =>
    (await window.agentApi.listActive())
      .filter(
        (session) =>
          session.adapterId === 'dsh' && !session.sessionId.startsWith('official:')
      )
      .map((session) => ({
        slotId: session.sessionId,
        adapterSessionId: session.adapterSessionId
      }))
  )
}

async function dshRpc<T>(
  window: Page,
  method: string,
  payload: unknown
): Promise<T> {
  const envelope = await window.evaluate(
    async ({ method, payload }) => {
      const rpcId = crypto.randomUUID()
      const response = await window.dshWireApi.fetch({
        requestId: rpcId,
        method: 'POST',
        path: `/api/${method}`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method,
          payload
        })
      })
      return JSON.parse(response.body) as {
        result?: { ok?: boolean; value?: unknown; error?: { message?: string } }
      }
    },
    { method, payload }
  )
  if (!envelope.result?.ok) {
    throw new Error(envelope.result?.error?.message ?? `${method} failed`)
  }
  return envelope.result.value as T
}

interface SurfaceInspection {
  phase: string
  visible: boolean
  hideTransitionCount?: number
  sidebarCollapseInvocationCount?: number
  slotId?: string
  sessionId?: string
  bounds?: { x: number; y: number; width: number; height: number }
  zoomFactor?: number
  error?: string
  page?: {
    currentSession?: string
    linkedStyleSheets: string[]
    cssRuleCount: number
    viewportWidth: number
    bodyTextLength: number
    bodyFontSize: string
    darkTheme: boolean
    frameDisplay?: string
    frameColumns?: string
    sidebarClosed: boolean
    sidebarDefaultApplied?: boolean
    embedded: boolean
  }
}

async function inspectSurface(
  app: ElectronApplication
): Promise<SurfaceInspection | null> {
  return app.evaluate(() =>
    (globalThis as unknown as {
      __hrackMainDebug: {
        dshSurfaceInspect(): Promise<SurfaceInspection> | null
        dshSurfaceDismissOnboarding(): Promise<boolean> | false
      }
    }).__hrackMainDebug.dshSurfaceInspect()
  )
}

test('the collapsed HRack rail has no separate DSH Home launcher', async () => {
  const { app, window } = await launchApp({
    createDefaultTerminal: false,
    localDsh: true
  })
  try {
    await expect(window.getByTestId('home-page')).toBeVisible({ timeout: 20_000 })
    await window.evaluate(() => {
      ;(
        window as unknown as {
          __hrackDebugShell: { setNavMode(mode: 'rail'): void }
        }
      ).__hrackDebugShell.setNavMode('rail')
    })
    await expect(window.getByTestId('icon-rail')).toBeVisible()
    await expect(window.getByTestId('rail-dsh')).toHaveCount(0)
    await navigate(window, 'home')
    await expect(window.getByTestId('home-dsh-brand-icon')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('the official DSH sidebar retries a transient first collapse failure without a reload', async () => {
  test.setTimeout(150_000)
  const { app, window } = await launchApp({
    createDefaultTerminal: false,
    localDsh: true,
    env: { HRACK_E2E_DSH_COLLAPSE_FAIL_ONCE: '1' }
  })
  try {
    await expect(window.getByTestId('home-page')).toBeVisible({ timeout: 20_000 })
    await app.evaluate(({ BrowserWindow }) => {
      const owner = BrowserWindow.getAllWindows()[0]
      owner?.setSize(1600, 1000)
      owner?.center()
    })
    await expect.poll(() => window.evaluate(() => window.innerWidth)).toBeGreaterThan(1500)
    await window.getByTestId('home-quick-dsh').click()
    await expect(window.getByTestId('dsh-page')).toBeVisible({ timeout: 20_000 })
    await waitHostReady(window)
    await expect
      .poll(
        async () => {
          const inspection = await inspectSurface(app)
          return `${inspection?.phase}:${inspection?.visible}:${inspection?.error ?? ''}`
        },
        { timeout: 20_000, intervals: [25, 50, 100] }
      )
      .toBe('ready:true:')

    const firstReadyPage = await inspectSurface(app)
    expect(firstReadyPage?.page?.viewportWidth).toBeGreaterThan(1024)
    expect(firstReadyPage?.sidebarCollapseInvocationCount).toBe(2)
    expect(firstReadyPage?.page?.sidebarDefaultApplied).toBe(true)
    expect(firstReadyPage?.page?.sidebarClosed).toBe(true)
  } finally {
    await app.close()
  }
})

test('Home-created DSH slots independently follow the session selected inside each slot', async () => {
  test.setTimeout(240_000)
  const { app, window, userDataDir } = await launchApp({
    createDefaultTerminal: false,
    localDsh: true
  })
  try {
    await expect(window.getByTestId('home-page')).toBeVisible({ timeout: 20_000 })
    // Scale is a HRack-owned host concern, so it lives in general settings;
    // all DSH business settings stay in the complete official page.
    await navigate(window, 'settings')
    await expect(window.getByTestId('settings-page')).toBeVisible()
    await window.getByTestId('dsh-surface-scale').click()
    await window.getByTestId('dsh-surface-scale-option-0.8').click()
    await expect(window.getByTestId('dsh-surface-scale')).toHaveAttribute(
      'data-value',
      '0.8'
    )

    await navigate(window, 'home')
    await window.getByTestId('home-quick-dsh').click()
    const surfaceHost = window.getByTestId('dsh-page')
    await expect(surfaceHost).toBeVisible({ timeout: 20_000 })
    await expect(surfaceHost).toHaveAttribute('data-dsh-mode', 'slot')
    await expect
      .poll(() => surfaceHost.getAttribute('data-dsh-slot'))
      .not.toBe('')
    const slot1 = await surfaceHost.getAttribute('data-dsh-slot')
    expect(slot1).toBeTruthy()
    await waitHostReady(window)
    await expect
      .poll(
        async () => {
          const inspection = await inspectSurface(app)
          return `${inspection?.phase}:${inspection?.visible}:${inspection?.error ?? ''}`
        },
        { timeout: 90_000, intervals: [250, 500, 1000] }
      )
      .toBe('ready:true:')

    const defaultSurface = await inspectSurface(app)
    expect(defaultSurface).not.toBeNull()
    expect(defaultSurface?.slotId).toBe(slot1)
    expect(defaultSurface?.sessionId).toBeUndefined()
    expect(defaultSurface?.zoomFactor).toBeCloseTo(0.8, 2)
    expect(defaultSurface?.page?.linkedStyleSheets.length).toBeGreaterThanOrEqual(2)
    expect(defaultSurface?.page?.cssRuleCount).toBeGreaterThan(100)
    expect(defaultSurface?.page?.bodyTextLength).toBeGreaterThan(0)
    expect(defaultSurface?.page?.embedded).toBe(true)

    await app.evaluate(() =>
      (globalThis as unknown as {
        __hrackMainDebug: {
          dshSurfaceDismissOnboarding(): Promise<boolean> | false
        }
      }).__hrackMainDebug.dshSurfaceDismissOnboarding()
    )
    await expect
      .poll(async () => (await inspectSurface(app))?.page?.sidebarClosed, {
        timeout: 10_000
      })
      .toBe(true)
    await expect
      .poll(async () => {
        const columns = (await inspectSurface(app))?.page?.frameColumns
        return Number.parseFloat(columns?.split(' ')[0] ?? 'Infinity')
      })
      .toBeCloseTo(56, 0)
    const officialDefault = await inspectSurface(app)
    expect(officialDefault?.page?.frameDisplay).toBe('grid')
    expect(officialDefault?.page?.sidebarDefaultApplied).toBe(true)

    const placeholder = await surfaceHost.boundingBox()
    expect(placeholder).not.toBeNull()
    expect(Math.abs((officialDefault?.bounds?.x ?? 0) - placeholder!.x)).toBeLessThan(2)
    expect(Math.abs((officialDefault?.bounds?.y ?? 0) - placeholder!.y)).toBeLessThan(2)
    expect(
      Math.abs((officialDefault?.bounds?.width ?? 0) - placeholder!.width)
    ).toBeLessThan(2)
    expect(
      Math.abs((officialDefault?.bounds?.height ?? 0) - placeholder!.height)
    ).toBeLessThan(2)

    const workspaceDir = resolve(userDataDir, 'e2e-workspace')
    mkdirSync(workspaceDir, { recursive: true })
    const workspace = await dshRpc<{ workspace?: { workspaceId?: string } }>(
      window,
      'workspace.create',
      { path: workspaceDir }
    )
    const workspaceId = workspace.workspace?.workspaceId
    expect(workspaceId).toBeTruthy()
    const sessionA = await dshRpc<{ sessionId: string }>(window, 'session.create', {
      workspaceId
    })
    const sessionB = await dshRpc<{ sessionId: string }>(window, 'session.create', {
      workspaceId
    })
    const sessionC = await dshRpc<{ sessionId: string }>(window, 'session.create', {
      workspaceId
    })
    const sessionD = await dshRpc<{ sessionId: string }>(window, 'session.create', {
      workspaceId
    })

    await app.evaluate(
      (_electron, { sessionId }) =>
        (globalThis as unknown as {
          __hrackMainDebug: {
            dshSurfaceSelectSession(sessionId: string): Promise<boolean> | false
          }
        }).__hrackMainDebug.dshSurfaceSelectSession(sessionId),
      { sessionId: sessionA.sessionId }
    )
    await expect
      .poll(
        async () => {
          const inspection = await inspectSurface(app)
          return `${inspection?.phase}:${inspection?.visible}:${inspection?.error ?? ''}`
        },
        { timeout: 90_000, intervals: [250, 500, 1000] }
      )
      .toBe('ready:true:')

    const inspection = await inspectSurface(app)
    expect(inspection).not.toBeNull()
    expect(inspection?.slotId).toBe(slot1)
    expect(inspection?.sessionId).toBe(sessionA.sessionId)
    expect(inspection?.zoomFactor).toBeCloseTo(0.8, 2)
    expect(inspection?.page?.currentSession).toBe(sessionA.sessionId)
    expect(inspection?.page?.sidebarClosed).toBe(true)
    await expect
      .poll(() => homeDshBindings(window))
      .toEqual([{ slotId: slot1!, adapterSessionId: sessionA.sessionId }])
    await expect
      .poll(() => activeHomeDshBindings(window))
      .toEqual([{ slotId: slot1!, adapterSessionId: sessionA.sessionId }])

    const hideCountBeforeOfficialSwitch =
      (await inspectSurface(app))?.hideTransitionCount ?? 0
    await app.evaluate(
      (_electron, { sessionId }) =>
        (globalThis as unknown as {
          __hrackMainDebug: {
            dshSurfaceSelectSession(sessionId: string): Promise<boolean> | false
          }
        }).__hrackMainDebug.dshSurfaceSelectSession(sessionId),
      { sessionId: sessionB.sessionId }
    )
    await expect
      .poll(() => homeDshBindings(window))
      .toEqual([{ slotId: slot1!, adapterSessionId: sessionB.sessionId }])
    await expect
      .poll(() => activeHomeDshBindings(window))
      .toEqual([{ slotId: slot1!, adapterSessionId: sessionB.sessionId }])
    expect((await inspectSurface(app))?.hideTransitionCount).toBe(
      hideCountBeforeOfficialSwitch
    )

    // Only Home creates a second explicit HRack tracking slot. Official sessions
    // created through RPC may also be auto-adopted under `official:` slots.
    await navigate(window, 'home')
    await window.getByTestId('home-quick-dsh').click()
    await expect
      .poll(() => surfaceHost.getAttribute('data-dsh-slot'))
      .not.toBe(slot1)
    const slot2 = await surfaceHost.getAttribute('data-dsh-slot')
    expect(slot2).toBeTruthy()
    expect(slot2).not.toBe(slot1)
    await expect
      .poll(async () => {
        const state = await inspectSurface(app)
        return `${state?.slotId}:${state?.phase}`
      })
      .toBe(`${slot2}:ready`)
    expect((await inspectSurface(app))?.page?.currentSession).toBeUndefined()
    await expect
      .poll(() => homeDshBindings(window))
      .toEqual([{ slotId: slot1!, adapterSessionId: sessionB.sessionId }])

    await app.evaluate(
      (_electron, { sessionId }) =>
        (globalThis as unknown as {
          __hrackMainDebug: {
            dshSurfaceSelectSession(sessionId: string): Promise<boolean> | false
          }
        }).__hrackMainDebug.dshSurfaceSelectSession(sessionId),
      { sessionId: sessionC.sessionId }
    )
    await expect
      .poll(async () =>
        (await homeDshBindings(window)).sort((left, right) =>
          left.slotId.localeCompare(right.slotId)
        )
      )
      .toEqual(
        [
          { slotId: slot1!, adapterSessionId: sessionB.sessionId },
          { slotId: slot2!, adapterSessionId: sessionC.sessionId }
        ].sort((left, right) => left.slotId.localeCompare(right.slotId))
      )

    // Reopening slot 1 restores B, then an official switch replaces only slot 1.
    await navigate(window, `dsh:${slot1}`)
    await expect
      .poll(async () => (await inspectSurface(app))?.page?.currentSession)
      .toBe(sessionB.sessionId)
    await app.evaluate(
      (_electron, { sessionId }) =>
        (globalThis as unknown as {
          __hrackMainDebug: {
            dshSurfaceSelectSession(sessionId: string): Promise<boolean> | false
          }
        }).__hrackMainDebug.dshSurfaceSelectSession(sessionId),
      { sessionId: sessionD.sessionId }
    )
    await expect
      .poll(async () =>
        (await homeDshBindings(window)).sort((left, right) =>
          left.slotId.localeCompare(right.slotId)
        )
      )
      .toEqual(
        [
          { slotId: slot1!, adapterSessionId: sessionD.sessionId },
          { slotId: slot2!, adapterSessionId: sessionC.sessionId }
        ].sort((left, right) => left.slotId.localeCompare(right.slotId))
      )

    const activeRow = window.locator(
      `[data-testid="sidebar-session-item"][data-session-id="${slot1}"]`
    )
    await activeRow.hover()
    await activeRow.locator('..').getByTestId('sidebar-session-close').click()
    await expect(window.getByTestId('close-session-confirm-dialog')).toBeVisible()
    await window.getByTestId('close-session-confirm-submit').click()
    await expect.poll(() => homeDshBindings(window)).toEqual([
      { slotId: slot2!, adapterSessionId: sessionC.sessionId }
    ])
    await expect
      .poll(() => activeHomeDshBindings(window))
      .toEqual([{ slotId: slot2!, adapterSessionId: sessionC.sessionId }])

    const listedAfterUnfollow = await dshRpc<{
      items?: Array<{ sessionId?: string }>
    }>(window, 'session.list', {})
    const workspacesAfterUnfollow = await dshRpc<{
      archivedSessionIds?: string[]
    }>(window, 'workspace.list', {})
    expect(
      listedAfterUnfollow.items?.some(
        (session) => session.sessionId === sessionD.sessionId
      )
    ).toBe(true)
    expect(workspacesAfterUnfollow.archivedSessionIds ?? []).not.toContain(
      sessionD.sessionId
    )

    await navigate(window, `dsh:${slot2}`)
    await expect
      .poll(async () => (await inspectSurface(app))?.page?.currentSession)
      .toBe(sessionC.sessionId)

    // Renderer portals must not sit underneath the native child view.
    await app.evaluate(() => {
      ;(globalThis as unknown as {
        __hrackMainDebug: { openNewSession(): void }
      }).__hrackMainDebug.openNewSession()
    })
    await expect(window.getByTestId('new-session-overlay')).toBeVisible()
    await expect
      .poll(async () => (await inspectSurface(app))?.visible)
      .toBe(false)
    await window.getByTestId('new-session-close').click()
    await expect
      .poll(async () => (await inspectSurface(app))?.visible, {
        timeout: 30_000
      })
      .toBe(true)

  } finally {
    await app.close()
  }
})
