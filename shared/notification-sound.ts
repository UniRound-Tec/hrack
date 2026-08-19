/**
 * 可设置提示音契约 —— 主进程 / preload / renderer 三方共享。
 *
 * 默认提示音随应用打包在 resources/done.mp3；用户上传的提示音由主进程
 * 复制到 userData/notification-sound/current.<ext>，通过自定义协议提供给
 * renderer 试听与事件触发。
 */

export const NOTIFICATION_SOUND_SCHEME = 'hrack-notification'
export const NOTIFICATION_SOUND_MAX_BYTES = 10 * 1024 * 1024
export const DEFAULT_NOTIFICATION_SOUND_NAME = 'done.mp3'

export const NOTIFICATION_SOUND_EXTENSIONS = [
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'aac',
  'flac'
] as const

export type NotificationSoundEventKind =
  | 'blocked'
  | 'completed'
  | 'error'

export interface NotificationSoundPickResult {
  /** 用户原始文件名，用于设置页展示。 */
  name: string
  /** 导入时间戳，用于协议缓存 bust。 */
  revision: number
}

export const NotificationSoundInvokeChannel = {
  Pick: 'notification-sound:pick',
  Clear: 'notification-sound:clear'
} as const

export interface NotificationSoundApi {
  pick: () => Promise<NotificationSoundPickResult | null>
  clear: () => Promise<void>
}

export function isNotificationSoundEventKind(
  value: unknown
): value is NotificationSoundEventKind {
  return (
    value === 'blocked' ||
    value === 'completed' ||
    value === 'error'
  )
}

export function normalizeNotificationSoundName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_NOTIFICATION_SOUND_NAME
  return value.trim().slice(0, 260) || DEFAULT_NOTIFICATION_SOUND_NAME
}

export function normalizeNotificationSoundRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}

/** 有可播放提示音：默认文件或用户上传文件都算。 */
export function hasNotificationSound(name: string): boolean {
  return name.trim().length > 0
}

/** 供 <audio> 使用的当前提示音 URL。revision=0 时仍可访问打包默认音。 */
export function notificationSoundUrl(revision: number): string {
  return `${NOTIFICATION_SOUND_SCHEME}://local/current?v=${Math.max(0, revision)}`
}

export function mimeForSoundExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.ogg':
      return 'audio/ogg'
    case '.m4a':
      return 'audio/mp4'
    case '.aac':
      return 'audio/aac'
    case '.flac':
      return 'audio/flac'
    default:
      return 'application/octet-stream'
  }
}

export function isAllowedSoundExtension(extension: string): boolean {
  const normalized = extension.toLowerCase().replace(/^\./, '')
  return (NOTIFICATION_SOUND_EXTENSIONS as readonly string[]).includes(
    normalized
  )
}
