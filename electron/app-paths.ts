import { join } from 'node:path'
import type { DshHomeMode } from '../shared/dsh-ipc'

export function resolveHrackUserDataDir(
  appDataDir: string,
  isPackaged: boolean
): string {
  return join(appDataDir, isPackaged ? 'HRack' : 'HRack Dev')
}

export function resolveNativeDshHome(
  mode: DshHomeMode,
  userHome: string,
  isolatedHome: string
): string {
  return mode === 'shared' ? join(userHome, '.dsh') : isolatedHome
}

export function resolveWslDshHome(
  mode: DshHomeMode,
  userHome: string
): string {
  const root = userHome === '/' ? '' : userHome.replace(/\/+$/, '')
  return mode === 'shared'
    ? `${root}/.dsh`
    : `${root}/.local/share/hrack/dsh-home`
}
