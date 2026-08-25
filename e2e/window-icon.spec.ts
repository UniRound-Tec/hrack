import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PNG } from 'pngjs'
import { windowsShortcutCandidates } from '../electron/app-icons'
import {
  hrackIconBasename,
  hrackWindowsIconFile
} from '../electron/icon-theme'
import { launchApp } from './helpers'

function icoContainsSize(path: string, size: number): boolean {
  const buffer = readFileSync(path)
  if (buffer.length < 6 || buffer.readUInt16LE(2) !== 1) return false
  const count = buffer.readUInt16LE(4)
  for (let index = 0; index < count; index++) {
    const width = buffer.readUInt8(6 + index * 16)
    if ((width === 0 ? 256 : width) === size) return true
  }
  return false
}

function averageVisibleLuminance(path: string): number {
  const png = PNG.sync.read(readFileSync(path))
  let luminance = 0
  let visiblePixels = 0
  for (let index = 0; index < png.data.length; index += 4) {
    if (png.data[index + 3] <= 32) continue
    luminance +=
      0.2126 * png.data[index] +
      0.7152 * png.data[index + 1] +
      0.0722 * png.data[index + 2]
    visiblePixels += 1
  }
  return visiblePixels > 0 ? luminance / visiblePixels : 0
}

test('desktop uses the branded app icon and keeps the macOS tray template', () => {
  expect(hrackIconBasename('win32', true)).toBe('hrack-white')
  expect(hrackIconBasename('win32', false)).toBe('hrack')
  expect(hrackIconBasename('darwin', true)).toBe('hrackTemplate')
  expect(hrackWindowsIconFile()).toBe('hrack-app.ico')
  expect(
    averageVisibleLuminance(
      resolve(__dirname, '../resources/tray/hrack-white-32.png')
    )
  ).toBeGreaterThan(200)
  expect(
    readFileSync(resolve(__dirname, '../resources/tray/hrack-app.ico')).length
  ).toBeGreaterThan(16)
  expect(icoContainsSize(
    resolve(__dirname, '../resources/tray/hrack-app.ico'),
    256
  )).toBe(true)
  expect(
    windowsShortcutCandidates().some((path) => path.endsWith('HRack.lnk'))
  ).toBe(true)
})

const WINDOWS_ICON_LUMINANCE_SCRIPT = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HRackWindowIconProbe {
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", EntryPoint="GetClassLongPtrW")] public static extern IntPtr GetClassLongPtr(IntPtr hWnd, int index);
}
'@
$windowHandle = [IntPtr]([long]$env:HRACK_ICON_HWND)
$handle = [HRackWindowIconProbe]::SendMessage($windowHandle, 0x007F, [IntPtr]2, [IntPtr]::Zero)
if ($handle -eq [IntPtr]::Zero) { $handle = [HRackWindowIconProbe]::GetClassLongPtr($windowHandle, -34) }
if ($handle -eq [IntPtr]::Zero) { Write-Output 0; exit 0 }
$bitmap = [System.Drawing.Icon]::FromHandle($handle).ToBitmap()
$total = 0.0; $count = 0
for ($y=0; $y -lt $bitmap.Height; $y++) { for ($x=0; $x -lt $bitmap.Width; $x++) { $pixel=$bitmap.GetPixel($x,$y); if ($pixel.A -gt 32) { $total += 0.2126*$pixel.R + 0.7152*$pixel.G + 0.0722*$pixel.B; $count++ } } }
$average = if ($count) { $total / $count } else { 0 }
$bitmap.Dispose()
Write-Output $average
`

test('a real Windows BrowserWindow applies the branded app icon', async () => {
  test.skip(process.platform !== 'win32')
  const { app } = await launchApp({ createDefaultTerminal: false })
  try {
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
    })
    const windowHandle = await app.evaluate(({ BrowserWindow }) => {
      const handle = BrowserWindow.getAllWindows()[0].getNativeWindowHandle()
      return handle.readBigUInt64LE().toString()
    })
    await expect.poll(
      () => Number(execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ICON_LUMINANCE_SCRIPT],
        {
          encoding: 'utf8',
          env: { ...process.env, HRACK_ICON_HWND: windowHandle }
        }
      ).trim()),
      { timeout: 10_000, intervals: [100, 250, 500] }
    ).toBeGreaterThan(20)
  } finally {
    await app.close()
  }
})
