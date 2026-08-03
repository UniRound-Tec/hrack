import { getStrings, type AppStrings } from './i18n'
import { useSettingsStore } from '../state/settingsStore'

/** SPEC §11.5 normalized six-state UI contract. */
export const sessionStatuses = [
  'working',
  'needs-you',
  'done',
  'error',
  'idle',
  'exited'
] as const

export type SessionStatus = (typeof sessionStatuses)[number]

/** Shared by Sidebar, Home, TopTabBar and the future floating window. */
export const statusDot: Record<SessionStatus, string> = {
  working: 'bg-status-working-dot animate-pulse',
  'needs-you': 'bg-status-needs-you-dot',
  done: 'bg-status-done-dot',
  error: 'bg-status-error-dot',
  idle: 'bg-status-idle-dot',
  exited: 'border border-status-exited bg-transparent'
}

export const statusTone: Record<SessionStatus, string> = {
  working: 'text-status-working',
  'needs-you': 'text-status-needs-you',
  done: 'text-status-done',
  error: 'text-status-error',
  idle: 'text-status-idle',
  exited: 'text-status-exited'
}

const statusStringKey: Record<
  SessionStatus,
  keyof AppStrings['sessionStatus']
> = {
  working: 'working',
  'needs-you': 'needsYou',
  done: 'done',
  error: 'error',
  idle: 'idle',
  exited: 'exited'
}

/** 语言感知标签：组件渲染时读取当前持久化语言（组件本身订阅 language 触发重渲染）。 */
export function statusLabel(status: SessionStatus): string {
  const group = getStrings(useSettingsStore.getState().language).sessionStatus
  // statusStringKey 保证命中纯字符串键（exitedDetail 为函数，不在映射内）。
  return group[statusStringKey[status]] as string
}
