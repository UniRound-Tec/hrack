import { expect, test } from '@playwright/test'
import { createStore } from 'zustand/vanilla'
import {
  NO_OBSERVER_CAPABILITIES,
  type AgentSessionProjection
} from '../shared/agent-events'
import {
  createSettingsState,
  defaultSettings,
  migrateSettings,
  type SettingsState
} from '../src/state/settingsStore'
import { getStrings } from '../src/app/i18n'
import { detectLocale } from '../src/app/i18n/locale'
import { createTerminalsStore } from '../src/state/terminalsStore'
import { createSessionsStore } from '../src/state/sessionsStore'
import {
  sessionStatuses,
  statusDot,
  statusLabel,
  statusTone
} from '../src/app/sessionStatus'

test.describe('settingsStore v10', () => {
  test('migrates v0/v1 terminal defaults before applying the v3 schema', () => {
    const fromV0 = migrateSettings(
      {
        themeId: 'light',
        fontFamily: 'Consolas, "Cascadia Code", "Courier New", monospace',
        fontSize: 13
      },
      0
    )
    expect(fromV0).toMatchObject({
      onboardingCompleted: true,
      uiThemeId: 'light',
      terminalThemeId: 'light',
      fontFamily: defaultSettings.fontFamily,
      fontSize: defaultSettings.fontSize,
      ligatures: true,
      navMode: 'sidebar',
      floatEnabled: false,
      defaultTerminal: 'powershell',
      language: defaultSettings.language,
      globalShortcutEnabled: true,
      dshScale: 0.9
    })

    const fromV1 = migrateSettings(
      {
        themeId: 'dark',
        fontFamily:
          '"Maple Mono NL", "Cascadia Mono", Consolas, "Courier New", monospace',
        fontSize: 15,
        ligatures: false
      },
      1
    )
    expect(fromV1.fontFamily).toBe(defaultSettings.fontFamily)
    expect(fromV1.fontSize).toBe(15)
    expect(fromV1.ligatures).toBe(true)
  })

  test('splits a v2 theme and preserves valid settings without reviving float mode', () => {
    const migrated = migrateSettings(
      {
        themeId: 'dark',
        fontFamily: 'Custom Mono',
        fontSize: 19,
        ligatures: false,
        navMode: 'tabs',
        floatEnabled: true,
        defaultTerminal: 'pwsh',
        language: 'ja'
      },
      2
    )

    expect(migrated).toEqual({
      onboardingCompleted: true,
      uiThemeId: 'dark',
      terminalThemeId: 'dark',
      fontFamily: 'Custom Mono',
      fontSize: 19,
      ligatures: false,
      terminalRounded: true,
      navMode: 'tabs',
      floatEnabled: false,
      defaultTerminal: 'pwsh',
      language: 'ja',
      globalShortcutEnabled: true,
      readerWidthRatio: 0.52,
      workspaceTreeWidth: 220,
      attentionPriorityEnabled: false,
      dshScale: 0.9
    })
    expect(migrated).not.toHaveProperty('themeId')
  })

  test('v4 lowers the abandoned default font size and adds the rounded flag', () => {
    // v3 及以前默认 16px：仍停留在旧默认值的用户跟随新默认 14px
    expect(migrateSettings({ fontSize: 16 }, 3).fontSize).toBe(14)
    // 主动改过字号的用户保留自己的选择
    expect(migrateSettings({ fontSize: 18 }, 3).fontSize).toBe(18)
    expect(migrateSettings({ fontSize: 16 }, 3).terminalRounded).toBe(true)
    expect(
      migrateSettings({ terminalRounded: false, fontSize: 12 }, 3)
    ).toMatchObject({ terminalRounded: false, fontSize: 12 })
  })

  test('v5 adds the global shortcut toggle and preserves v4 settings', () => {
    // v4 → v5：快捷键开关默认开；已持久化的选择保留。
    expect(
      migrateSettings(
        { fontFamily: 'Custom Mono', globalShortcutEnabled: false },
        4
      )
    ).toMatchObject({
      fontFamily: 'Custom Mono',
      globalShortcutEnabled: false,
      terminalRounded: true
    })
    expect(migrateSettings({ fontSize: 14 }, 4).globalShortcutEnabled).toBe(
      defaultSettings.globalShortcutEnabled
    )
  })

  test('updates and resets the full settings slice', () => {
    const store = createStore<SettingsState>()(createSettingsState)
    expect(store.getState().onboardingCompleted).toBe(false)
    store.getState().completeOnboarding()
    store.getState().setUiTheme(' user-light ')
    store.getState().setTerminalTheme('light')
    store.getState().setFont('  ', 99)
    store.getState().setLigatures(false)
    store.getState().setNavMode('rail')
    store.getState().setDefaultTerminal(' pwsh ')
    store.getState().setLanguage('zh-TW')
    store.getState().setReaderWidthRatio(0.6)
    store.getState().setWorkspaceTreeWidth(280)
    store.getState().setAttentionPriorityEnabled(true)
    store.getState().setDshScale(1.1)

    expect(store.getState()).toMatchObject({
      onboardingCompleted: true,
      uiThemeId: 'user-light',
      terminalThemeId: 'light',
      fontFamily: defaultSettings.fontFamily,
      fontSize: 32,
      ligatures: false,
      navMode: 'rail',
      defaultTerminal: 'pwsh',
      language: 'zh-TW',
      readerWidthRatio: 0.6,
      workspaceTreeWidth: 280,
      attentionPriorityEnabled: true,
      dshScale: 1.1
    })

    store.getState().reset()
    expect(store.getState()).toMatchObject(defaultSettings)
  })
})

test.describe('terminalsStore', () => {
  test('keeps terminal metadata and the M3 activation/close invariants', () => {
    const store = createTerminalsStore()
    const first = store.getState().terminals[0]
    const second = store
      .getState()
      .addTerminal({ shellId: 'pwsh', cwd: ' C:\\workspace ' })

    expect(second).toMatchObject({
      name: 'Terminal 2',
      cwd: 'C:\\workspace',
      shellId: 'pwsh',
      exited: false
    })
    expect(store.getState().activeTerminalId).toBe(second.id)

    store.getState().setTitle(second.id, 'Build shell')
    store.getState().setTitle(second.id, '')
    expect(store.getState().terminals[1].name).toBe('Terminal 2')

    store.getState().markExited(second.id)
    expect(store.getState().terminals[1].exited).toBe(true)
    expect(store.getState().closeTerminal(second.id)).toBe(false)
    expect(store.getState().activeTerminalId).toBe(first.id)
    expect(store.getState().closeTerminal(first.id)).toBe(true)
    expect(store.getState().terminals).toHaveLength(0)
    expect(store.getState().activeTerminalId).toBeNull()
  })

  test('accepts a predetermined terminal id and display name', () => {
    const store = createTerminalsStore({ initialTerminal: false })
    const named = store.getState().addTerminal({
      id: 'fixed-id',
      name: 'OpenCode',
      shellId: 'opencode'
    })
    expect(named).toMatchObject({
      id: 'fixed-id',
      name: 'OpenCode',
      shellId: 'opencode'
    })
  })

  test('restores stable terminal identities without creating a replacement', () => {
    const store = createTerminalsStore({ initialTerminal: false })
    expect(store.getState().terminals).toHaveLength(0)

    const recovered = {
      ptyId: 'pty-7',
      terminalId: 'terminal-stable',
      kind: 'terminal' as const,
      name: 'PowerShell',
      shellId: 'pwsh',
      cwd: 'C:\\repo',
      exited: false,
      parentSessionId: 'session-parent'
    }
    store.getState().restoreTerminals([recovered])
    store.getState().restoreTerminals([recovered])

    expect(store.getState().terminals).toEqual([
      {
        id: 'terminal-stable',
        name: 'PowerShell',
        shellId: 'pwsh',
        cwd: 'C:\\repo',
        exited: false,
        parentSessionId: 'session-parent'
      }
    ])
    expect(store.getState().activeTerminalId).toBe('terminal-stable')
  })
})

test.describe('sessionsStore', () => {
  test('keeps authoritative projection insertion order without presentation sorting', () => {
    const store = createSessionsStore()
    store.getState().addSession({
      sessionId: 'real:1',
      terminalId: 'terminal:1',
      adapterId: 'codex',
      name: 'Real session',
      status: 'working',
      lastActivityAt: 100
    })
    store.getState().addSession({
      sessionId: 'real:2',
      terminalId: 'terminal:2',
      adapterId: 'claude-code',
      name: 'Second real session',
      status: 'working',
      lastActivityAt: 10_000
    })

    expect(store.getState().sessions).toHaveLength(2)
    expect(store.getState().sessions.map((session) => session.sessionId)).toEqual([
      'real:1',
      'real:2'
    ])
    store.getState().markExited('real:1', 7, 20_000)
    expect(store.getState().sessions[0]).toMatchObject({
      sessionId: 'real:1',
      status: 'exited',
      // 语言随运行环境（Node 的 navigator 取系统语言）；用同一 getStrings 推导期望值。
      detail: getStrings(detectLocale()).sessionStatus.exitedDetail(7),
      lastActivityAt: 20_000
    })
    expect(store.getState().sessions.map((session) => session.sessionId)).toEqual([
      'real:1',
      'real:2'
    ])

    store.getState().removeSession('real:2')
    expect(
      store.getState().sessions.map((session) => session.sessionId)
    ).toEqual(['real:1'])
  })

  test('provides tokenized status presentation', () => {
    for (const status of sessionStatuses) {
      expect(statusDot[status]).toContain('status-')
      expect(statusTone[status]).toContain('status-')
      expect(statusLabel(status).length).toBeGreaterThan(0)
    }
  })

  test('DSH projection keeps a stable local slot and its official binding', () => {
    const store = createSessionsStore()
    const sessionId = 'dsh-slot-1'
    const adapterSessionId = 'official-dsh-session-1'
    const projection: AgentSessionProjection = {
      sessionId,
      terminalId: `dsh:${sessionId}`,
      installationId: 'dsh',
      adapterId: 'dsh',
      adapterSessionId,
      name: 'Current DSH session',
      status: 'idle',
      statusConfidence: 'high',
      observerHealth: 'healthy',
      activeToolCount: 0,
      pendingAttentionCount: 0,
      lastActivityAt: 2,
      capabilities: NO_OBSERVER_CAPABILITIES,
      lastSeq: 1,
      correlation: {
        exited: false,
        activeTools: {},
        pendingApprovals: {},
        pendingInputs: {},
        lowConfidenceIdle: false,
        highConfidenceIdle: false,
        thinkingActive: false
      }
    }
    store.getState().applyProjection(projection)
    expect(store.getState().sessions).toMatchObject([
      { sessionId, adapterSessionId }
    ])

    store.getState().applyProjection({
      ...projection,
      adapterSessionId: 'official-dsh-session-2',
      lastSeq: 2
    })
    expect(store.getState().sessions).toMatchObject([
      {
        sessionId,
        adapterSessionId: 'official-dsh-session-2'
      }
    ])

    store.getState().unfollowSession(sessionId)
    expect(store.getState().sessions).toEqual([])
    expect(store.getState().closedSessionIds).toEqual([])

    store.getState().applyProjection({
      ...projection,
      status: 'exited',
      lastSeq: 3,
      correlation: { ...projection.correlation, exited: true }
    })
    expect(store.getState().sessions).toEqual([])
    expect(store.getState().closedSessionIds).toEqual([])
  })
})
