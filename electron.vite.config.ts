import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createRequire } from 'node:module'
import { resolve } from 'path'

// dsh 全家桶住在隔离子树 dsh-runtime/（见 electron/dsh-host/DshHostManager.ts）。
// renderer 对 dsh 包的解析全部锚定这棵子树，与 vibing 根 node_modules 无关。
const dshRuntimeRequire = createRequire(
  resolve(__dirname, 'dsh-runtime/package.json')
)
const dshModulesBanner = dshRuntimeRequire.resolve(
  '@deepseek-ai/dsh-client-modules/client'
)
const dshClientWebDir = resolve(
  dshRuntimeRequire.resolve('@deepseek-ai/dsh-client-web/package.json'),
  '..'
)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'preload/index.ts') }
      }
    }
  },
  renderer: {
    root: '.',
    publicDir: false,
    resolve: {
      alias: [
        // npm 产物 dsh-client-modules/lib/client.js 首行是 __ModuleLoader__.load
        // banner，直接 import 会在 sink 装好前执行即崩；重定向到 capture-shim。
        // 顺序敏感：子路径必须先于任何裸名前缀命中。
        {
          find: /^@deepseek-ai\/dsh-client-modules\/client$/,
          replacement: resolve(__dirname, 'src/dsh/client-modules-client.ts')
        },
        { find: 'vibing-dsh:modules-banner', replacement: dshModulesBanner },
        // renderer 源码对 dsh shell 的引用锚定到隔离子树。
        {
          find: /^@deepseek-ai\/dsh-client-web$/,
          replacement: dshClientWebDir
        },
        // dsh-client-web 内 vendored cordis Loader 顶层 import node:module，
        // 浏览器路径从不调用；与上游 apps/web/vite.config.ts 相同的 stub。
        {
          find: /^node:module$/,
          replacement: resolve(__dirname, 'src/dsh/node-module-stub.ts')
        }
      ]
    },
    define: {
      // vendored cordis Loader 的三处 node 探测（上游 apps/web 同款 define）。
      'process.versions.node': '"0.0.0"',
      'process.execArgv': '[]',
      'process.env.CORDIS_SHARED': 'undefined'
    },
    build: {
      assetsInlineLimit: 0,
      rollupOptions: {
        input: { index: resolve(__dirname, 'index.html') }
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
