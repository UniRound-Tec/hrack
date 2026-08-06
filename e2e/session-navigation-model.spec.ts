import { expect, test } from '@playwright/test'
import {
  applySessionNavigationIntent,
  createEmptySessionNavigation,
  normalizeSessionNavigationSnapshot,
  reconcileSessionNavigation
} from '../src/session-navigation/sessionNavigation'
import { createSessionNavigationStore } from '../src/session-navigation/sessionNavigationStore'

test('recovery preserves manual order and only appends newly discovered sessions', () => {
  const persisted = {
    ...createEmptySessionNavigation(),
    root: [
      { kind: 'session' as const, terminalId: 'terminal:b' },
      { kind: 'session' as const, terminalId: 'terminal:a' }
    ]
  }

  expect(
    reconcileSessionNavigation(persisted, [], { recoveryComplete: false }).root
  ).toEqual(persisted.root)

  expect(
    reconcileSessionNavigation(
      persisted,
      ['terminal:a', 'terminal:b', 'terminal:c'],
      { recoveryComplete: true }
    ).root
  ).toEqual([
    { kind: 'session', terminalId: 'terminal:b' },
    { kind: 'session', terminalId: 'terminal:a' },
    { kind: 'session', terminalId: 'terminal:c' }
  ])
})

test('grouping a pair is idempotent and never duplicates members at the root', () => {
  const initial = reconcileSessionNavigation(
    createEmptySessionNavigation(),
    ['terminal:a', 'terminal:b', 'terminal:c'],
    { recoveryComplete: true }
  )
  const intent = {
    kind: 'group-pair' as const,
    groupId: 'group:ab',
    sourceTerminalId: 'terminal:b',
    targetTerminalId: 'terminal:a',
    defaultName: 'Claude + Codex'
  }

  const grouped = applySessionNavigationIntent(initial, intent, {
    attentionPriorityEnabled: false
  })
  const repeated = applySessionNavigationIntent(grouped, intent, {
    attentionPriorityEnabled: false
  })

  expect(repeated).toEqual({
    schemaVersion: 1,
    root: [
      { kind: 'group', groupId: 'group:ab' },
      { kind: 'session', terminalId: 'terminal:c' }
    ],
    groups: {
      'group:ab': {
        id: 'group:ab',
        name: 'Claude + Codex',
        members: ['terminal:a', 'terminal:b']
      }
    }
  })
})

test('attention promotes a whole group without changing its member order', () => {
  const initial = reconcileSessionNavigation(
    createEmptySessionNavigation(),
    ['terminal:a', 'terminal:b', 'terminal:c'],
    { recoveryComplete: true }
  )
  const grouped = applySessionNavigationIntent(
    initial,
    {
      kind: 'group-pair',
      groupId: 'group:bc',
      sourceTerminalId: 'terminal:c',
      targetTerminalId: 'terminal:b',
      defaultName: 'Codex + Pi'
    },
    { attentionPriorityEnabled: false }
  )

  expect(
    applySessionNavigationIntent(
      grouped,
      { kind: 'activity', terminalId: 'terminal:c' },
      { attentionPriorityEnabled: false }
    )
  ).toBe(grouped)

  const promoted = applySessionNavigationIntent(
    grouped,
    { kind: 'activity', terminalId: 'terminal:c' },
    { attentionPriorityEnabled: true }
  )
  expect(promoted.root).toEqual([
    { kind: 'group', groupId: 'group:bc' },
    { kind: 'session', terminalId: 'terminal:a' }
  ])
  expect(promoted.groups['group:bc'].members).toEqual([
    'terminal:b',
    'terminal:c'
  ])
})

test('navigation store defers attention promotion until a drag interaction ends', () => {
  const store = createSessionNavigationStore({ persist: false })
  store
    .getState()
    .reconcile(['terminal:a', 'terminal:b', 'terminal:c'], true)
  store.getState().dispatch(
    {
      kind: 'group-pair',
      groupId: 'group:bc',
      sourceTerminalId: 'terminal:c',
      targetTerminalId: 'terminal:b',
      defaultName: 'Codex + Pi'
    },
    false
  )

  store.getState().beginInteraction()
  store
    .getState()
    .dispatch({ kind: 'activity', terminalId: 'terminal:c' }, true)
  expect(store.getState().snapshot.root[0]).toEqual({
    kind: 'session',
    terminalId: 'terminal:a'
  })

  store.getState().endInteraction(true)
  expect(store.getState().snapshot.root[0]).toEqual({
    kind: 'group',
    groupId: 'group:bc'
  })
})

test('cross-group moves keep singleton groups and recovery removes only empty groups', () => {
  let snapshot = reconcileSessionNavigation(
    createEmptySessionNavigation(),
    ['terminal:a', 'terminal:b', 'terminal:c', 'terminal:d'],
    { recoveryComplete: true }
  )
  snapshot = applySessionNavigationIntent(
    snapshot,
    {
      kind: 'group-pair',
      groupId: 'group:ab',
      sourceTerminalId: 'terminal:b',
      targetTerminalId: 'terminal:a',
      defaultName: 'A + B'
    },
    { attentionPriorityEnabled: false }
  )
  snapshot = applySessionNavigationIntent(
    snapshot,
    {
      kind: 'group-pair',
      groupId: 'group:cd',
      sourceTerminalId: 'terminal:d',
      targetTerminalId: 'terminal:c',
      defaultName: 'C + D'
    },
    { attentionPriorityEnabled: false }
  )
  snapshot = applySessionNavigationIntent(
    snapshot,
    {
      kind: 'move-into-group',
      terminalId: 'terminal:b',
      groupId: 'group:cd',
      beforeTerminalId: null
    },
    { attentionPriorityEnabled: false }
  )

  expect(snapshot.groups['group:ab'].members).toEqual(['terminal:a'])
  expect(snapshot.groups['group:cd'].members).toEqual([
    'terminal:c',
    'terminal:d',
    'terminal:b'
  ])

  const recovered = reconcileSessionNavigation(
    snapshot,
    ['terminal:b', 'terminal:c', 'terminal:d'],
    { recoveryComplete: true }
  )
  expect(recovered.groups).not.toHaveProperty('group:ab')
  expect(recovered.groups['group:cd'].members).toEqual([
    'terminal:c',
    'terminal:d',
    'terminal:b'
  ])
})

test('normalizes malformed persistence without duplicating a session', () => {
  expect(
    normalizeSessionNavigationSnapshot({
      schemaVersion: 1,
      root: [
        { kind: 'group', groupId: 'group:one' },
        { kind: 'session', terminalId: 'terminal:a' },
        { kind: 'session', terminalId: 'terminal:b' },
        { kind: 'group', groupId: 'missing' }
      ],
      groups: {
        'group:one': {
          id: 'wrong-id',
          name: '  Agents  ',
          members: ['terminal:a', 'terminal:a']
        }
      }
    })
  ).toEqual({
    schemaVersion: 1,
    root: [
      { kind: 'group', groupId: 'group:one' },
      { kind: 'session', terminalId: 'terminal:b' }
    ],
    groups: {
      'group:one': {
        id: 'group:one',
        name: 'Agents',
        members: ['terminal:a']
      }
    }
  })
})
