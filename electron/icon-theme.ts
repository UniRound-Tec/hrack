export function hrackIconBasename(
  platform: NodeJS.Platform,
  shouldUseDarkColors: boolean
): 'hrack' | 'hrack-white' | 'hrackTemplate' {
  if (platform === 'darwin') return 'hrackTemplate'
  return shouldUseDarkColors ? 'hrack-white' : 'hrack'
}
