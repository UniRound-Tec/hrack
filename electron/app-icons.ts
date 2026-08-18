import {
  app,
  nativeImage,
  nativeTheme,
  shell,
  type BrowserWindow,
  type NativeImage
} from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import packageMetadata from '../package.json'
import { hrackIconBasename, hrackWindowsIconFile } from './icon-theme'

const WINDOWS_APP_USER_MODEL_ID =
  typeof packageMetadata.build?.appId === 'string'
    ? packageMetadata.build.appId
    : 'com.hrack.app'

function iconAssetsDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tray')
    : join(process.cwd(), 'resources', 'tray')
}

export function createThemedHrackIcon(): NativeImage {
  const basename = hrackIconBasename(
    process.platform,
    nativeTheme.shouldUseDarkColors
  )
  const directory = iconAssetsDirectory()
  const image = nativeImage.createFromPath(join(directory, `${basename}-16.png`))
  const highDpiImage = nativeImage.createFromPath(
    join(directory, `${basename}-32.png`)
  )
  if (!highDpiImage.isEmpty()) {
    image.addRepresentation({
      scaleFactor: 2,
      width: 32,
      height: 32,
      buffer: highDpiImage.toPNG()
    })
  }
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

export function applyHrackWindowIcon(win: BrowserWindow): void {
  if (process.platform === 'darwin' || win.isDestroyed()) return
  win.setIcon(createThemedHrackIcon())
  if (process.platform !== 'win32') return
  const appIconPath = join(
    iconAssetsDirectory(),
    hrackWindowsIconFile(nativeTheme.shouldUseDarkColors)
  )
  win.setAppDetails({
    appId: WINDOWS_APP_USER_MODEL_ID,
    appIconPath,
    appIconIndex: 0
  })
  syncWindowsShortcutIcon(appIconPath)
}

/** Taskbar follows the Start Menu / Desktop .lnk, which NSIS pins to HRack.exe,0 (black master). */
export function windowsShortcutCandidates(): string[] {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const programs = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const product = packageMetadata.build?.productName ?? 'HRack'
  return [
    join(homedir(), 'Desktop', `${product}.lnk`),
    join(programs, `${product}.lnk`),
    join(programs, product, `${product}.lnk`)
  ]
}

function sameExecutable(left: string, right: string): boolean {
  return left.replace(/\//g, '\\').toLowerCase() === right.replace(/\//g, '\\').toLowerCase()
}

function syncWindowsShortcutIcon(iconPath: string): void {
  if (!app.isPackaged) return
  const target = process.execPath
  for (const shortcutPath of windowsShortcutCandidates()) {
    try {
      const current = shell.readShortcutLink(shortcutPath)
      if (!current.target || !sameExecutable(current.target, target)) continue
      if (
        current.icon === iconPath &&
        current.iconIndex === 0 &&
        current.appUserModelId === WINDOWS_APP_USER_MODEL_ID
      ) {
        continue
      }
      shell.writeShortcutLink(shortcutPath, 'update', {
        ...current,
        icon: iconPath,
        iconIndex: 0,
        appUserModelId: WINDOWS_APP_USER_MODEL_ID
      })
    } catch {
      // Missing shortcuts or a locked .lnk are fine; the window ICO still applies.
    }
  }
}

export function registerWindowsAppUserModelId(): void {
  if (process.platform === 'win32') {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)
  }
}
