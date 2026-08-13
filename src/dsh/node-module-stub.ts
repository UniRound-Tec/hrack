/**
 * node:module 的浏览器 stub —— dsh-client-web 内 vendored cordis Loader 在
 * 模块顶层 import createRequire，但浏览器路径从不调用它（loader.internal 会
 * 被 ClientModuleSystem 覆盖）。与上游 apps/web/src/node-module-stub.ts 一致。
 */
export const createRequire = (): never => {
  throw new Error('node:module is not available in the browser')
}
export type LoadHookContext = never
