/**
 * @deepseek-ai/dsh-client-modules/client 的无 banner ESM 替身。
 *
 * 问题：该子路径的 npm 产物 lib/client.js 首行是 client 模块系统的注册
 * banner（window.__ModuleLoader__.load({...})）。上游 apps/web 的 vite 把它
 * alias 到 monorepo 源码，从不吃这个产物；npm 包不 ship src/，我们直接
 * import 会在 __ModuleLoader__ 存在之前就执行 banner，模块求值即崩。
 *
 * 解法（capture-shim）：先装一个临时捕获 sink，再动态 import 原始 banner
 * bundle 取出 factory 并立即物化（该 client 半自包含，无静态外部 require，
 * 已逐版本核实），最后拆掉临时 sink——真正的 ClientModuleSystem 安装时会
 * 检查 __ModuleLoader__ 必须不存在（double boot 防护），顺序不可颠倒。
 *
 * 上游契约锚点：packages/client/modules/src/client/system.ts 的注册 sink
 * 与 modules/README.md 的 bundle 形态说明。契约变动会在 boot 时 fail-loud。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  BootManifest,
  BootModuleRow,
  BootPluginRow,
  ClientModuleLoader,
  ClientModuleRecord,
  ClientModuleSystemOptions,
  ClientPluginHandoff,
  DshWindow,
  WebBootEntry,
  WebBootGraph
} from '@deepseek-ai/dsh-client-modules/client'

export type {
  BootManifest,
  BootModuleRow,
  BootPluginRow,
  ClientModuleLoader,
  ClientModuleRecord,
  ClientModuleSystemOptions,
  ClientPluginHandoff,
  DshWindow,
  WebBootEntry,
  WebBootGraph
}

interface FactoryHandoff {
  id: string
  factory: (require: (spec: string) => unknown) => unknown
}

interface ModuleLoaderSink {
  load(handoff: FactoryHandoff): void
}

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const win = window as unknown as { __ModuleLoader__?: ModuleLoaderSink }

if (win.__ModuleLoader__ !== undefined) {
  throw new Error(
    'dsh capture-shim: __ModuleLoader__ already present before capture'
  )
}
let captured: FactoryHandoff | undefined
win.__ModuleLoader__ = {
  load: (handoff) => {
    captured = handoff
  }
}
try {
  // 动态 import 保证执行顺序：sink 必须先于 banner 安装。
  await import('vibing-dsh:modules-banner')
} finally {
  delete win.__ModuleLoader__
}
if (captured === undefined || captured.id !== MODULES_ID) {
  throw new Error(
    `dsh capture-shim: banner bundle did not register ${MODULES_ID}`,
  )
}
const unexpectedRequire = (spec: string): never => {
  throw new Error(
    `dsh capture-shim: modules client-half unexpectedly requires ${spec}`,
  )
}
const materialized = captured.factory(unexpectedRequire) as Record<string, unknown>

// 按库形态重新暴露（导出清单对齐 lib/types/client/index.d.ts）。
export const ClientModuleSystem = materialized['ClientModuleSystem'] as ClientModuleSystemT
export const parseBootManifest = materialized['parseBootManifest'] as ParseBootManifestT
export const apply = materialized['apply'] as ApplyT

type ClientModuleSystemT = typeof import('@deepseek-ai/dsh-client-modules/client').ClientModuleSystem
type ParseBootManifestT = typeof import('@deepseek-ai/dsh-client-modules/client').parseBootManifest
type ApplyT = (ctx: Context) => void
