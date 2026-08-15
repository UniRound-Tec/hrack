/**
 * DSH presentation actions. Official DSH owns its full session catalog;
 * Vibing only renames through the official API or locally unfollows a
 * Home-created tracking slot. The official session itself remains untouched.
 */

import { useSessionsStore } from '../state/sessionsStore'
import { renameDshSession } from './rpc'

export async function renameVisibleDshSession(
  slotId: string,
  adapterSessionId: string,
  name: string
): Promise<void> {
  await renameDshSession(adapterSessionId, name)
  useSessionsStore.getState().updateSession(slotId, { name })
}

export async function unfollowVisibleDshSlot(slotId: string): Promise<void> {
  await window.dshSurfaceApi.unfollow(slotId)
  useSessionsStore.getState().unfollowSession(slotId)
}
