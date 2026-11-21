import { defineConfig, type Plugin } from 'vite'
import { nativeLicenses } from './vite.platform.ts'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { BROWSER_TARGET, legacyCssFallbacks, legacyRegexRewrite } from './vite.legacy.ts'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

/**
 * 跨章连续滚动: foliate-js 的 view.js 用 `import('./paginator.js')` 加载渲染器,
 * 这里把它 (以及直接 import 的 foliate-js/paginator.js) 指向 src/vendor/foliate/paginator.js 的 fork。
 * 设计见 docs/continuous-scroll.md。
 */
function foliatePaginatorFork(): Plugin {
  const fork = fileURLToPath(new URL('./src/vendor/foliate/paginator.js', import.meta.url))
  return {
    name: 'lightread:foliate-paginator-fork',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'foliate-js/paginator.js') return fork
      if (source === './paginator.js' && importer
        && /[\\/]foliate-js[\\/]view\.js(?:\?|$)/.test(importer)) return fork
      return null
    },
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_PLATFORM__: JSON.stringify(process.env.TAURI_ENV_PLATFORM || 'windows'),
    // 模拟器验收的遥控通道 (src/services/e2eDriver.ts); 不设就是空串, 模块不进产物
    __E2E_DRIVER__: JSON.stringify(process.env.LIGHTREAD_E2E_DRIVER || ''),
  },
  plugins: [nativeLicenses(), foliatePaginatorFork(), legacyRegexRewrite(), vue()],
  css: {
    postcss: { plugins: [legacyCssFallbacks()] },
  },
  build: {
    // 旧 WebView 兼容目标 (依据见 vite.legacy.ts); CSS 目标默认跟随, lightningcss 据此补前缀
    target: BROWSER_TARGET,
    chunkSizeWarningLimit: 2048,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // polyfill 单独成块: 入口 chunk 的第一条 import, 先于 vue/设置等共享块求值
          groups: [{ name: 'polyfills', test: /[\\/]src[\\/]polyfills\.ts$/, priority: 100 }],
        },
      },
    },
  },
  worker: {
    // 模块 Worker (重点词、PDF 重排、PDF 页面渲染) 与主包同一构建目标, 输出 ES 模块
    format: 'es',
  },
  // 开发模式不预构建 foliate-js: 预构建产物里 view.js 的 ./paginator.js 不经过上面的 fork 重定向
  optimizeDeps: {
    exclude: ['foliate-js'],
  },
  // Tauri 开发时使用固定端口
  server: {
    port: 5173,
    strictPort: true,
    // Native build outputs can contain hundreds of thousands of files. They
    // never participate in frontend HMR and exhaust Linux inotify otherwise.
    watch: { ignored: ['**/src-tauri/target/**', '**/src-tauri/gen/**'] },
  },
})
