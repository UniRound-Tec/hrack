export function hrackIconBasename(
  platform: NodeJS.Platform,
  shouldUseDarkColors: boolean
): 'hrack' | 'hrack-white' | 'hrackTemplate' {
  if (platform === 'darwin') return 'hrackTemplate'
  return shouldUseDarkColors ? 'hrack-white' : 'hrack'
}

/** Packaged Windows taskbar uses the exe/shortcut ICO unless we point AppUserModel at this file. */
export function hrackWindowsIconFile(
  shouldUseDarkColors: boolean
): 'hrack.ico' | 'hrack-white.ico' {
  return shouldUseDarkColors ? 'hrack-white.ico' : 'hrack.ico'
}
