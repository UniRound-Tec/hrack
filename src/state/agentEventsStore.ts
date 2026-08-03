import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { AgentEvent } from '../../shared/agent-events'

/**
 * 高频 AgentEvent 的独立有界 store（PLAN-S1 §9.2）。
 * 只保存当前页面需要的最新事件窗口，不把完整事件数组塞进 Session 条目。
 * 订阅由 AppShell 统一建立；渲染层按需消费。
 */

const MAX_EVENTS = 200

export interface AgentEventsState {
  events: AgentEvent[]
  record(events: readonly AgentEvent[]): void
  clear(): void
}

export function createAgentEventsStore(): UseBoundStore<
  StoreApi<AgentEventsState>
> {
  return create<AgentEventsState>((set) => ({
    events: [],
    record: (events) =>
      set((state) => ({
        events: [...state.events, ...events].slice(-MAX_EVENTS)
      })),
    clear: () => set({ events: [] })
  }))
}

export const useAgentEventsStore = createAgentEventsStore()
