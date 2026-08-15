import { create, type StateCreator, type StoreApi, type UseBoundStore } from 'zustand'
import { persist } from 'zustand/middleware'
import { migrateLegacyStorageKey } from '../state/legacyStorage'
import {
  applySessionNavigationIntent,
  createEmptySessionNavigation,
  normalizeSessionNavigationSnapshot,
  reconcileSessionNavigation,
  type SessionNavigationIntent,
  type SessionNavigationSnapshot
} from './sessionNavigation'

export interface SessionNavigationState {
  snapshot: SessionNavigationSnapshot
  recoveryComplete: boolean
  interactionActive: boolean
  dispatch(intent: SessionNavigationIntent, attentionPriorityEnabled: boolean): void
  reconcile(activeTerminalIds: readonly string[], recoveryComplete: boolean): void
  beginInteraction(): void
  endInteraction(attentionPriorityEnabled: boolean): void
  reset(): void
}

function createSessionNavigationState(): StateCreator<SessionNavigationState> {
  let deferredActivities: string[] = []

  return (set) => ({
    snapshot: createEmptySessionNavigation(),
    recoveryComplete: false,
    interactionActive: false,
    dispatch: (intent, attentionPriorityEnabled) => {
      set((state) => {
        if (intent.kind === 'activity' && state.interactionActive) {
          deferredActivities.push(intent.terminalId)
          return state
        }
        const snapshot = applySessionNavigationIntent(state.snapshot, intent, {
          attentionPriorityEnabled
        })
        return snapshot === state.snapshot ? state : { ...state, snapshot }
      })
    },
    reconcile: (activeTerminalIds, recoveryComplete) => {
      set((state) => {
        const snapshot = reconcileSessionNavigation(
          state.snapshot,
          activeTerminalIds,
          { recoveryComplete }
        )
        if (
          snapshot === state.snapshot &&
          state.recoveryComplete === recoveryComplete
        ) {
          return state
        }
        return { ...state, snapshot, recoveryComplete }
      })
    },
    beginInteraction: () => set({ interactionActive: true }),
    endInteraction: (attentionPriorityEnabled) => {
      set((state) => {
        let snapshot = state.snapshot
        for (const terminalId of deferredActivities) {
          snapshot = applySessionNavigationIntent(
            snapshot,
            { kind: 'activity', terminalId },
            { attentionPriorityEnabled }
          )
        }
        deferredActivities = []
        return { ...state, snapshot, interactionActive: false }
      })
    },
    reset: () => {
      deferredActivities = []
      set({
        snapshot: createEmptySessionNavigation(),
        recoveryComplete: false,
        interactionActive: false
      })
    }
  })
}

export function createSessionNavigationStore(
  options: { persist?: boolean } = {}
): UseBoundStore<StoreApi<SessionNavigationState>> {
  const stateCreator = createSessionNavigationState()
  if (options.persist === false) return create<SessionNavigationState>()(stateCreator)

  migrateLegacyStorageKey('hrack-session-navigation', 'vibing-session-navigation')

  return create<SessionNavigationState>()(
    persist(stateCreator, {
      name: 'hrack-session-navigation',
      version: 1,
      partialize: (state) => ({ snapshot: state.snapshot }),
      merge: (persisted, current) => ({
        ...current,
        snapshot: normalizeSessionNavigationSnapshot(
          (persisted as { snapshot?: unknown } | undefined)?.snapshot
        )
      })
    })
  )
}

export const useSessionNavigationStore = createSessionNavigationStore()
