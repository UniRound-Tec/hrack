import { strings } from './strings'

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

export const statusLabel: Record<SessionStatus, string> = {
  working: strings.sessionStatus.working,
  'needs-you': strings.sessionStatus.needsYou,
  done: strings.sessionStatus.done,
  error: strings.sessionStatus.error,
  idle: strings.sessionStatus.idle,
  exited: strings.sessionStatus.exited
}
