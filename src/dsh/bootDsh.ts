/**
 * dsh web surface 的装配启动（P0）。
 *
 * 流程（对齐上游 apps/web/tests/assembled-boot.ts 的自装配形态）：
 * 1. 安装 IPC 传输层（fetch/WebSocket 包装，必须在任何 client bundle 前）
 * 2. 确保 host 就绪，经主进程取回 host 注入的 __DSH_BOOT__ 清单
 *    —— 权威模块表来自 host 自己，版本永远一致，vibing 不手工维护条目
 * 3. loadBundle：经 wire 通道从 host 取回 /plugins/<id>/client.js 并 eval
 *    （bundle banner 会调 window.__ModuleLoader__.load 注册 factory）
 * 4. AppWebEntry 跑 two-stage boot，渲染完整 dsh GUI 到给定容器
 *
 * React 说明：dsh-client-web 的 seed 用其嵌套解析的 React 18 单例，dsh UI
 * 在容器内自建 createRoot，与 vibing 的 React 19 树互不嵌套（P2 再评估
 * 统一 React 的收益/成本）。
 */

import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import { installDshIpcTransport } from './ipcTransport'

export interface DshSurfaceHandle {
  dispose(): void
}

export async function bootDshSurface(
  container: HTMLElement
): Promise<DshSurfaceHandle> {
  installDshIpcTransport()

  const status = await window.dshApi.ensureStarted()
  if (status.state !== 'ready') {
    throw new Error(status.error ?? 'dsh host is not ready')
  }

  const manifest = await window.dshApi.getBootManifest()
  ;(window as unknown as Record<string, unknown>)['__DSH_BOOT__'] = manifest

  const entry = new AppWebEntry(container, {
    loadBundle: async (url: string) => {
      const response = await window.dshWireApi.fetch({
        requestId: crypto.randomUUID(),
        method: 'GET',
        // url 形如 /plugins/<id>/client.js?rev=<rev>
        path: url
      })
      if (response.status !== 200 || response.body.length === 0) {
        throw new Error(`dsh client bundle ${url} responded ${response.status}`)
      }
      // bundle 是带 __ModuleLoader__.load banner 的 CJS 包装，eval 即注册。
      ;(0, eval)(response.body)
    }
  })
  await entry.run()
  return {
    dispose: () => entry.dispose()
  }
}
