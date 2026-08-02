import { expect, test } from '@playwright/test'
import { createStore } from 'zustand/vanilla'
import {
  createSettingsState,
  defaultSettings,
  migrateSettings,
  type SettingsState
} from '../src/state/settingsStore'
import { createTerminalsStore } from '../src/state/terminalsStore'
import { createSessionsStore } from '../src/state/sessionsStore'
import {
  createMockHistoryEvents,
  createMockSessions,
  isMockSessionsEnabled,
  mockAllTimeStats,
  startMockSessionsProvider
} from '../src/app/mockSessions'
import {
  sessionStatuses,
  statusDot,
  statusLabel,
  statusTone
} from '../src/app/sessionStatus'

test.describe('settingsStore v3', () => {
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
      uiThemeId: 'light',
      terminalThemeId: 'light',
      fontFamily: defaultSettings.fontFamily,
      fontSize: defaultSettings.fontSize,
      ligatures: true,
      navMode: 'sidebar',
      floatEnabled: false,
      defaultTerminal: 'powershell',
      language: 'zh-CN'
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
      uiThemeId: 'dark',
      terminalThemeId: 'dark',
      fontFamily: 'Custom Mono',
      fontSize: 19,
      ligatures: false,
      navMode: 'tabs',
      floatEnabled: false,
      defaultTerminal: 'pwsh',
      language: 'ja'
    })
    expect(migrated).not.toHaveProperty('themeId')
  })

  test('updates and resets the full settings slice', () => {
    const store = createStore<SettingsState>()(createSettingsState)
    store.getState().setUiTheme(' user-light ')
    store.getState().setTerminalTheme('light')
    store.getState().setFont('  ', 99)
    store.getState().setLigatures(false)
    store.getState().setNavMode('rail')
    store.getState().setDefaultTerminal(' pwsh ')
    store.getState().setLanguage('zh-TW')

    expect(store.getState()).toMatchObject({
      uiThemeId: 'user-light',
      terminalThemeId: 'light',
      fontFamily: defaultSettings.fontFamily,
      fontSize: 32,
      ligatures: false,
      navMode: 'rail',
      defaultTerminal: 'pwsh',
      language: 'zh-TW'
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
})

test.describe('sessionsStore and mock provider', () => {
  test('sorts by activity, updates exit state, and preserves real/mock coexistence', () => {
    const store = createSessionsStore()
    store.getState().addSession({
      sessionId: 'real:1',
      terminalId: 'terminal:1',
      adapterId: 'codex',
      name: 'Real session',
      status: 'working',
      lastActivityAt: 100
    })
    store.getState().upsertSessions(createMockSessions(10_000))

    expect(store.getState().sessions).toHaveLength(18)
    expect(store.getState().sessions[0].sessionId).toBe('mock:session:01')

    store.getState().markExited('real:1', 7, 20_000)
    expect(store.getState().sessions[0]).toMatchObject({
      sessionId: 'real:1',
      status: 'exited',
      detail: '已退出：exit code 7',
      lastActivityAt: 20_000
    })

    const mockIds = store
      .getState()
      .sessions.filter((session) => session.sessionId.startsWith('mock:'))
      .map((session) => session.sessionId)
    store.getState().removeSessions(mockIds)
    expect(store.getState().sessions.map((session) => session.sessionId)).toEqual([
      'real:1'
    ])
  })

  test('ships all six prototype states and only injects in dev/E2E', () => {
    expect(isMockSessionsEnabled({ dev: false, e2e: false })).toBe(false)
    expect(isMockSessionsEnabled({ dev: true, e2e: false })).toBe(true)
    expect(isMockSessionsEnabled({ dev: false, e2e: true })).toBe(true)

    const fixtures = createMockSessions(100_000)
    expect(fixtures).toHaveLength(17)
    expect(new Set(fixtures.map((session) => session.status))).toEqual(
      new Set(sessionStatuses)
    )

    const store = createSessionsStore()
    const stopDisabled = startMockSessionsProvider({
      enabled: false,
      store
    })
    expect(store.getState().sessions).toHaveLength(0)
    stopDisabled()

    const stopEnabled = startMockSessionsProvider({
      enabled: true,
      now: () => 100_000,
      store
    })
    expect(store.getState().sessions).toHaveLength(17)
    stopEnabled()
    expect(store.getState().sessions).toHaveLength(0)
  })

  test('provides home history/stats and tokenized status presentation', () => {
    expect(createMockHistoryEvents(100_000)).toHaveLength(8)
    expect(mockAllTimeStats).toEqual({
      sessions: 1_284,
      toolCalls: 9_632,
      blocked: 156,
      approvals: 412
    })

    for (const status of sessionStatuses) {
      expect(statusDot[status]).toContain('status-')
      expect(statusTone[status]).toContain('status-')
      expect(statusLabel[status].length).toBeGreaterThan(0)
    }
  })
})
