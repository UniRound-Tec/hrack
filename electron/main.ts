import { app, BrowserWindow } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createWindow } from './window'
import { registerIpc } from './ipc'
import { PTYManager } from './pty/PTYManager'

const manager = new PTYManager()

app.whenReady().then(() => {
  // M0 验收：抵达此行即证明 node-pty 已按 Electron ABI 成功加载
  console.log('[vibing] app ready; node-pty loaded against Electron ABI OK')
  // 诊断日志目录
  try {
    mkdirSync(join(process.cwd(), 'logs'), { recursive: true })
  } catch {
    /* ignore */
  }
  registerIpc(manager)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  manager.killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => manager.killAll())
