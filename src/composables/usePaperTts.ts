/**
 * 论文阅读器 (PaperReaderView) 的听书 / TTS 逻辑。
 * 从 PaperReaderView.vue 抽离的「页级朗读编排 + 面板开关状态」,
 * 底层引擎 (speakText / prefetchSpeech / stopSpeech 等) 已在 services/tts, 这里只做编排。
 *
 * ## 接线清单 (PaperReaderView.vue)
 *
 * ```ts
 * const tts = usePaperTts({
 *   getPageText: n => pageTextFor(n),   // 内部走 pdm.pageText, 注入以解耦 pdfium
 *   currentPage,
 *   pageCount,
 *   gotoPage,
 *   stopAutoRead,
 *   pingReadingAuto,
 *   autoPanel,
 *   settings,
 * })
 * ```
 *
 * 返回: `ttsPanel / ttsState / ttsVoices / localInstalled / refreshLocalStatus /
 *        auditionLocal / openTTSPanel / startTTS / pauseTTS / resumeTTS / stopTTS`。
 */
import { computed, ref, type Ref } from 'vue'
import { useSettings } from '../stores/settings'
import { toast } from '../services/toast'
import { t } from '../i18n'
import {
  speakText,
  prefetchSpeech,
  warmUpSpeech,
  stopSpeech,
  pauseSpeech,
  resumeSpeech,
  resetEdgeFailure,
  listVoicesSorted,
} from '../services/tts'
import { playAudio } from '../services/edgeTts'
import { localPack, localTtsSynthesize, refreshLocalPack } from '../services/localTts'

export function usePaperTts(opts: {
  getPageText: (n: number) => Promise<string>
  currentPage: Ref<number>
  pageCount: Ref<number>
  gotoPage: (n: number) => void
  stopAutoRead: () => void
  pingReadingAuto: () => void
  autoPanel: Ref<boolean>
  settings: ReturnType<typeof useSettings>
}) {
  const { getPageText, currentPage, pageCount, gotoPage, stopAutoRead, pingReadingAuto, autoPanel, settings } = opts

  const ttsPanel = ref(false)
  const ttsState = ref<'stopped' | 'playing' | 'paused'>('stopped')
  const ttsVoices = ref<{ name: string; lang: string }[]>([])
  let ttsSession = 0

  /** 长文本按标点切块, 避免超长 utterance 在部分引擎上卡死 */
  function splitChunks(text: string, max = 400): string[] {
    const chunks: string[] = []
    let rest = text
    while (rest.length > max) {
      let cut = -1
      for (const re of [/[。！？.!?][^。！？.!?]*$/, /[；;，,][^；;，,]*$/, /\s\S*$/]) {
        const m = rest.slice(0, max).match(re)
        if (m && m.index != null && m.index > max * 0.3) {
          cut = m.index + 1
          break
        }
      }
      if (cut <= 0) cut = max
      chunks.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    if (rest.trim()) chunks.push(rest)
    return chunks
  }

  const waitWhilePaused = async () => {
    while (ttsState.value === 'paused') await new Promise(r => setTimeout(r, 200))
  }
  /** await 期间状态可能被外部修改, 用函数取值绕开 TS 控制流收窄 */
  const ttsStopped = () => ttsState.value === 'stopped'

  /** 语音包已装好且可用 (未因闪退暂停); 下载 / 恢复由 LocalTtsPack 处理 */
  const localInstalled = computed(() => localPack.installed && !localPack.crashed)
  const refreshLocalStatus = () => refreshLocalPack()

  async function auditionLocal() {
    try {
      await playAudio(await localTtsSynthesize(t('tts.sampleText'), settings.localVoiceId, settings.ttsRate))
    } catch (e: any) {
      toast(e?.message ?? t('tts.auditionFailed'), 'error')
    }
  }

  async function openTTSPanel() {
    ttsPanel.value = !ttsPanel.value
    if (ttsPanel.value) {
      autoPanel.value = false
      refreshLocalStatus()
      // 离线模型首次加载需 10–20s, 打开面板时就在后台加载
      warmUpSpeech()
      if (!ttsVoices.value.length) {
        ttsVoices.value = (await listVoicesSorted()).map(v => ({ name: v.name, lang: v.lang }))
      }
    }
  }

  async function startTTS() {
    const session = ++ttsSession
    stopSpeech()
    resetEdgeFailure()
    stopAutoRead()
    ttsState.value = 'playing'
    try {
      let pageNum = currentPage.value
      let spokeAnything = false
      while (session === ttsSession && !ttsStopped() && pageNum <= pageCount.value) {
        const text = await getPageText(pageNum)
        if (text) {
          spokeAnything = true
          const chunks = splitChunks(text)
          let nextPageChunks: string[] | undefined
          for (let ci = 0; ci < chunks.length; ci++) {
            await waitWhilePaused()
            if (session !== ttsSession || ttsStopped()) return
            // 预取深度 2 块, 页末接上下一页开头, 翻页时不再等合成
            const upcoming = chunks.slice(ci + 1, ci + 3)
            if (upcoming.length < 2 && pageNum < pageCount.value) {
              nextPageChunks ??= splitChunks(await getPageText(pageNum + 1))
              if (session !== ttsSession || ttsStopped()) return
              upcoming.push(...nextPageChunks.slice(0, 2 - upcoming.length))
            }
            const speaking = speakText(chunks[ci])
            upcoming.forEach((next, i) => prefetchSpeech(next, i + 1))
            await speaking
            pingReadingAuto()
          }
        }
        if (session !== ttsSession || ttsStopped()) return
        pageNum++
        if (pageNum > pageCount.value) break
        gotoPage(pageNum)
        await new Promise(r => setTimeout(r, 300))
      }
      if (!spokeAnything && session === ttsSession) {
        toast(t('tts.pdfNoText'), 'error', 4000)
      }
    } catch (e) {
      console.error(e)
      toast(t('tts.error'), 'error')
    }
    if (session === ttsSession) ttsState.value = 'stopped'
  }

  function pauseTTS() {
    ttsState.value = 'paused'
    pauseSpeech()
  }

  function resumeTTS() {
    ttsState.value = 'playing'
    resumeSpeech()
  }

  function stopTTS() {
    ttsSession++
    ttsState.value = 'stopped'
    stopSpeech()
  }

  return {
    ttsPanel,
    ttsState,
    ttsVoices,
    localInstalled,
    refreshLocalStatus,
    auditionLocal,
    openTTSPanel,
    startTTS,
    pauseTTS,
    resumeTTS,
    stopTTS,
  }
}
