import type { ComponentType, SVGProps } from 'react'

/** SPEC §11.5 归一化会话状态(六态) */
export type SessionStatus =
  | 'working'
  | 'needs-you'
  | 'done'
  | 'error'
  | 'idle'
  | 'exited'

export type BrandIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>

export interface SessionItem {
  id: string
  cli: string
  Icon: BrandIcon
  time: string
  status: SessionStatus
  message: string
}

export interface TerminalItem {
  id: string
  name: string
  cwd: string
}

/** 六态色板:侧栏 / 首页 / 悬浮窗 / Tab 徽标共用 */
export const statusDot: Record<SessionStatus, string> = {
  working: 'bg-sky-500 animate-pulse',
  'needs-you': 'bg-pending-dot',
  done: 'bg-emerald-500',
  error: 'bg-error',
  idle: 'bg-neutral-300',
  exited: 'border border-neutral-400 bg-transparent',
}

export const statusTone: Record<SessionStatus, string> = {
  working: 'text-sky-700',
  'needs-you': 'text-pending',
  done: 'text-emerald-700',
  error: 'text-error',
  idle: 'text-neutral-500',
  exited: 'text-neutral-400',
}

export const statusLabel: Record<SessionStatus, string> = {
  working: '运行中',
  'needs-you': '待处理',
  done: '已完成',
  error: '出错',
  idle: '空闲',
  exited: '已退出',
}
