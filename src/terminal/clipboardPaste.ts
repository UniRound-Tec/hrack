const CTRL_V = '\x16'
const ALT_V = '\x1bv'

/** Image-paste shortcuts are CLI-specific; preserve Ctrl+V unless verified otherwise. */
export function terminalImagePasteSequence(
  platform: string,
  adapterId?: string
): string {
  return platform === 'win32' && adapterId === 'claude-code' ? ALT_V : CTRL_V
}
