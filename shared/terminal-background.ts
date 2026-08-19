export const TERMINAL_BACKGROUND_SCHEME = 'hrack-terminal-bg'
export const TERMINAL_BACKGROUND_MAX_BYTES = 16 * 1024 * 1024
export const TERMINAL_BACKGROUND_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'avif'
] as const

export type TerminalBackgroundFit = 'cover' | 'contain' | 'fill' | 'tile'

export const terminalBackgroundFits = [
  'cover',
  'contain',
  'fill',
  'tile'
] as const satisfies readonly TerminalBackgroundFit[]

export interface TerminalBackgroundPickResult {
  name: string
  revision: number
}

export function isTerminalBackgroundFit(
  value: unknown
): value is TerminalBackgroundFit {
  return (
    value === 'cover' ||
    value === 'contain' ||
    value === 'fill' ||
    value === 'tile'
  )
}

export function normalizeTerminalBackgroundName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 260)
}

export function normalizeTerminalBackgroundRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}

export const DEFAULT_TERMINAL_BACKGROUND_OPACITY = 0.3

export function normalizeTerminalBackgroundOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_BACKGROUND_OPACITY
  }
  return Math.round(Math.max(0.1, Math.min(1, value)) * 100) / 100
}

export function hasTerminalBackground(
  name: string,
  revision: number
): boolean {
  return name.trim().length > 0 && revision > 0
}

export function terminalBackgroundUrl(revision: number): string {
  return `${TERMINAL_BACKGROUND_SCHEME}://local/current?v=${Math.max(0, revision)}`
}

export function terminalBackgroundLayerCss(fit: TerminalBackgroundFit): {
  backgroundSize: string
  backgroundRepeat: string
  backgroundPosition: string
} {
  switch (fit) {
    case 'fill':
      return {
        backgroundSize: '100% 100%',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'center'
      }
    case 'tile':
      return {
        backgroundSize: 'auto',
        backgroundRepeat: 'repeat',
        backgroundPosition: 'top left'
      }
    case 'contain':
      return {
        backgroundSize: 'contain',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'center'
      }
    case 'cover':
    default:
      return {
        backgroundSize: 'cover',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'center'
      }
  }
}

export function mimeForImageExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    case '.avif':
      return 'image/avif'
    default:
      return 'application/octet-stream'
  }
}

export function isAllowedBackgroundExtension(extension: string): boolean {
  const normalized = extension.toLowerCase().replace(/^\./, '')
  return (TERMINAL_BACKGROUND_EXTENSIONS as readonly string[]).includes(
    normalized
  )
}
