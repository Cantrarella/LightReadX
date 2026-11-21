import type { Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The native speech client (src-tauri/src/mobile/edge_gec.rs, LGPL-3.0 port of edge-tts) ships in the
 *  Windows desktop build, so its license texts and desktop font/UnRAR licenses go into the bundle. */
export function nativeLicenses(root = fileURLToPath(new URL('.', import.meta.url))): Plugin {
  return {
    name: 'lightread:native-licenses',
    apply: 'build',
    generateBundle() {
      for (const name of ['edge-tts-LICENSE.txt', 'edge-tts-COPYING.txt']) {
        this.emitFile({ type: 'asset', fileName: `licenses/${name}`, source: readFileSync(resolve(root, 'src-tauri/src/mobile', name)) })
      }
      // 桌面原生 CBR 解包链接了 RARLAB UnRAR (src-tauri/src/comic.rs)
      this.emitFile({ type: 'asset', fileName: 'licenses/unrar-LICENSE.txt', source: readFileSync(resolve(root, 'src-tauri/src/unrar-LICENSE.txt')) })
      this.emitFile({ type: 'asset', fileName: 'fonts/WenKai-LICENSE.txt', source: readFileSync(resolve(root, 'src/assets/fonts/WenKai-LICENSE.txt')) })
      this.emitFile({ type: 'asset', fileName: 'fonts/Inter-LICENSE.txt', source: readFileSync(resolve(root, 'src/assets/fonts/Inter-LICENSE.txt')) })
      this.emitFile({ type: 'asset', fileName: 'fonts/SmileySans-LICENSE.txt', source: readFileSync(resolve(root, 'src/assets/fonts/SmileySans-LICENSE.txt')) })
    },
  }
}
