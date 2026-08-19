import {
  hasNotificationSound,
  notificationSoundUrl,
  type NotificationSoundEventKind
} from '../../shared/notification-sound'
import { useSettingsStore } from './settingsStore'

let audio: HTMLAudioElement | null = null

function currentAudio(): HTMLAudioElement {
  if (audio) return audio
  audio = new Audio()
  audio.preload = 'auto'
  return audio
}

function playUrl(url: string): void {
  const player = currentAudio()
  player.pause()
  player.currentTime = 0
  player.src = url
  player.load()
  void player.play().catch(() => {
    // 自动播放策略或音频解码失败时静默；不打断用户操作。
  })
}

/** 设置页「试听」：不检查总开关/事件开关，始终播放当前提示音。 */
export function playNotificationPreview(): void {
  const settings = useSettingsStore.getState()
  if (!hasNotificationSound(settings.notificationSoundName)) return
  playUrl(notificationSoundUrl(settings.notificationSoundRevision))
}

/** 会话事件触发：由 AppShell 在投影状态跃迁时调用。 */
export function playNotificationSound(kind: NotificationSoundEventKind): void {
  const settings = useSettingsStore.getState()
  if (!settings.notificationSoundEnabled) return
  if (kind === 'blocked' && !settings.notificationSoundOnBlocked) return
  if (kind === 'completed' && !settings.notificationSoundOnCompleted) return
  if (kind === 'error' && !settings.notificationSoundOnError) return
  if (!hasNotificationSound(settings.notificationSoundName)) return
  playUrl(notificationSoundUrl(settings.notificationSoundRevision))
}
