import { app, nativeImage, nativeTheme, type NativeImage } from 'electron'
import { join } from 'node:path'
import { hrackIconBasename } from './icon-theme'

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
