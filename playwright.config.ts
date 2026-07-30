import { defineConfig } from '@playwright/test'

/**
 * Playwright E2E 配置（Electron）。
 * 测试前需先 `npm run build` 产出 out/。测试通过 _electron.launch 启动打包后的主进程。
 * 串行执行（单一 Electron 实例，避免多窗口争用）。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    trace: 'off'
  }
})
