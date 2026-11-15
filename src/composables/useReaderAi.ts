/**
 * AI 阅读助手 (ReaderView 的 AI 面板逻辑)。
 * 从 ReaderView.vue 抽离出来的对话/解读逻辑, ReaderView 只做接线与面板 UI。
 *
 * ## 接线清单 (ReaderView.vue)
 *
 * ```ts
 * const ai = useReaderAi({
 *   meta: () => meta.value,
 *   chapterLabel: () => chapterLabel.value,
 *   settings,
 * })
 * ```
 *
 * 返回: `aiMessages / aiInput / aiStreaming / aiListEl / aiReady /
 *        sendAi / clearAi / stopAi / useTrialAi / openRegister`。
 * 划词解读入口 `aiExplainSelection` 留在 ReaderView (它要操作 selection/panel/showBars),
 * 内部调用 `ai.sendAi(explainPrompt(text, settings.language))`。
 */
import { nextTick, ref } from 'vue'
import { useSettings } from '../stores/settings'
import type { BookMeta } from '../storage'
import {
  chatStream, aiConfigured, readerSystemPrompt, explainPrompt, plainAiText, providerById,
  type AiMessage,
} from '../services/ai'
import { t } from '../i18n'

export function useReaderAi(opts: {
  meta: () => BookMeta | undefined
  chapterLabel: () => string
  settings: ReturnType<typeof useSettings>
}) {
  const { meta, chapterLabel, settings } = opts

  const aiMessages = ref<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const aiInput = ref('')
  const aiStreaming = ref(false)
  const aiListEl = ref<HTMLElement>()
  let aiSession = 0

  const aiReady = () => aiConfigured()

  function aiScrollToEnd() {
    nextTick(() => {
      if (aiListEl.value) aiListEl.value.scrollTop = aiListEl.value.scrollHeight
    })
  }

  async function sendAi(text?: string) {
    const content = (text ?? aiInput.value).trim()
    if (!content || aiStreaming.value) return
    if (!text) aiInput.value = ''
    const session = ++aiSession
    aiMessages.value.push({ role: 'user', content })
    aiMessages.value.push({ role: 'assistant', content: '' })
    const reply = aiMessages.value[aiMessages.value.length - 1]
    aiStreaming.value = true
    aiScrollToEnd()
    try {
      const history: AiMessage[] = [
        { role: 'system', content: readerSystemPrompt(
          { title: meta()?.title, author: meta()?.author },
          chapterLabel(),
          settings.language,
        ) },
        // 只带最近 8 轮, 控制上下文长度
        ...aiMessages.value.slice(0, -1).slice(-16).map(m => ({ role: m.role, content: m.content })),
      ]
      for await (const delta of chatStream(history)) {
        if (session !== aiSession) return
        reply.content += delta
        aiScrollToEnd()
      }
      if (!reply.content) reply.content = t('ai.emptyReply')
    } catch (e: any) {
      if (session === aiSession) {
        reply.content = `⚠️ ${t('ai.requestFailed')}: ${e?.message ?? e}`
      }
    } finally {
      if (session === aiSession) aiStreaming.value = false
    }
  }

  /** 一键改用内置试用通道 (服务端中转, 免注册免密钥) */
  function useTrialAi() {
    const trial = providerById('trial')
    settings.aiProvider = trial.id
    settings.aiBaseUrl = trial.baseUrl
    settings.aiModel = trial.defaultModel
  }

  async function openRegister() {
    const { openDownload } = await import('../services/updater')
    openDownload('https://cloud.siliconflow.cn/i/TxUlXG3u')
  }

  function clearAi() {
    aiSession++
    aiStreaming.value = false
    aiMessages.value = []
  }

  function stopAi() {
    aiSession++
    aiStreaming.value = false
  }

  return {
    aiMessages,
    aiInput,
    aiStreaming,
    aiListEl,
    aiReady,
    sendAi,
    clearAi,
    stopAi,
    useTrialAi,
    openRegister,
  }
}

export { explainPrompt, plainAiText, providerById }
