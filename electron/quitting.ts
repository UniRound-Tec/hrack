/** 运行时退出标志：托盘「退出」/ before-quit 置位后，窗口 close 才真正关闭。 */
let quitting = false

export function markQuitting(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}
