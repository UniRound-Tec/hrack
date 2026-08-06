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

test('manual reorder and attention promotion operate on individual sessions', () => {
  const initial = reconcileSessionNavigation(
    createEmptySessionNavigation(),
    ['terminal:a', 'terminal:b', 'terminal:c'],
    { recoveryComplete: true }
  )
  const reordered = applySessionNavigationIntent(
    initial,
    { kind: 'reorder-root', sourceId: 'terminal:a', beforeId: null },
    { attentionPriorityEnabled: false }
  )
  expect(reordered.root.map((ref) => ref.terminalId)).toEqual([
    'terminal:b',
    'terminal:c',
    'terminal:a'
  ])
  expect(
    applySessionNavigationIntent(
      reordered,
      { kind: 'activity', terminalId: 'terminal:c' },
      { attentionPriorityEnabled: false }
    )
  ).toBe(reordered)
  expect(
    applySessionNavigationIntent(
      reordered,
      { kind: 'activity', terminalId: 'terminal:c' },
      { attentionPriorityEnabled: true }
    ).root.map((ref) => ref.terminalId)
  ).toEqual(['terminal:c', 'terminal:b', 'terminal:a'])
})

test('navigation store defers attention promotion until drag ends', () => {
  const store = createSessionNavigationStore({ persist: false })
  store
    .getState()
    .reconcile(['terminal:a', 'terminal:b', 'terminal:c'], true)
  store.getState().beginInteraction()
  store
    .getState()
    .dispatch({ kind: 'activity', terminalId: 'terminal:c' }, true)
  expect(store.getState().snapshot.root[0].terminalId).toBe('terminal:a')
  store.getState().endInteraction(true)
  expect(store.getState().snapshot.root[0].terminalId).toBe('terminal:c')
})

test('legacy persisted groups are flattened in place without duplicates', () => {
  expect(
    normalizeSessionNavigationSnapshot({
      schemaVersion: 1,
      root: [
        { kind: 'session', terminalId: 'terminal:before' },
        { kind: 'group', groupId: 'group:one' },
        { kind: 'session', terminalId: 'terminal:a' },
        { kind: 'session', terminalId: 'terminal:after' }
      ],
      groups: {
        'group:one': {
          members: ['terminal:a', 'terminal:b', 'terminal:b']
        }
      }
    })
  ).toEqual({
    schemaVersion: 1,
    root: [
      { kind: 'session', terminalId: 'terminal:before' },
      { kind: 'session', terminalId: 'terminal:a' },
      { kind: 'session', terminalId: 'terminal:b' },
      { kind: 'session', terminalId: 'terminal:after' }
    ]
  })
})
