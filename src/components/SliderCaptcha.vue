<script setup lang="ts">
/**
 * Breeze 滑块验证 (kind='slider-captcha')。
 *
 * 交互对齐插件作者预期的站点前端: 背景图上有一块缺口, 拖动底部滑块把拼图块送进缺口,
 * 松手后把「x(原图坐标) + 轨迹 [[毫秒, x, clientY], ...]」交给插件校验, 拿回一次性通行证。
 * 宿主不参与判定, 只负责出题、渲染、采集轨迹。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../i18n'
import { toast } from '../services/toast'
import { createSliderChallenge, verifySliderChallenge, type SliderChallenge } from '../services/comicPlugin/slider'

const props = defineProps<{
  uuid: string
  createFnPath: string
  verifyFnPath: string
}>()
const emit = defineEmits<{ (e: 'verified', pass: string): void }>()

const challenge = ref<SliderChallenge | null>(null)
const loading = ref(true)
const verified = ref(false)
const failed = ref(false)
const submitting = ref(false)
const error = ref('')
/** 拼图块左偏移 (显示像素) */
const dx = ref(0)
const frameW = ref(320)
const host = ref<HTMLDivElement>()

/** 背景原始宽度 → 显示宽度 的缩放比 */
const scale = computed(() => {
  const c = challenge.value
  if (!c) return 1
  return frameW.value / (c.w || 320)
})
const frameH = computed(() => Math.round((challenge.value?.h ?? 180) * scale.value))
const pieceW = computed(() => Math.round((challenge.value?.s ?? 52) * scale.value))
const pieceTop = computed(() => Math.round((challenge.value?.y ?? 0) * scale.value))
const knobW = computed(() => frameW.value >= 300 ? 52 : 44)
const maxMove = computed(() => Math.max(0, frameW.value - pieceW.value))

let observer: ResizeObserver | null = null
let dragStartX = 0
let dragStartAt = 0
let track: number[][] = []
let dragging = false

function measure() {
  const el = host.value
  if (!el) return
  const w = Math.min(320, Math.max(220, Math.floor(el.clientWidth || 320)))
  frameW.value = w
}

async function load() {
  loading.value = true
  verified.value = false
  failed.value = false
  error.value = ''
  dx.value = 0
  try {
    challenge.value = await createSliderChallenge(props.uuid, props.createFnPath)
    measure()
  } catch (e: any) {
    error.value = e?.message ?? String(e)
    challenge.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && host.value) {
    observer = new ResizeObserver(measure)
    observer.observe(host.value)
  }
  void load()
})
onBeforeUnmount(() => { observer?.disconnect(); observer = null })

function onDown(event: PointerEvent) {
  if (loading.value || submitting.value || verified.value || !challenge.value) return
  dragging = true
  dragStartX = event.clientX
  dragStartAt = Date.now()
  track = [[0, 0, Math.round(event.clientY)]]
  ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
  event.preventDefault()
}

function onMove(event: PointerEvent) {
  if (!dragging) return
  const next = Math.max(0, Math.min(maxMove.value, event.clientX - dragStartX))
  dx.value = next
  // 轨迹按原图坐标记录, 与站点前端 dx / 缩放比 一致
  track.push([Date.now() - dragStartAt, Math.round((next / scale.value) * 10) / 10, Math.round(event.clientY)])
  if (track.length > 500) track.splice(1, 1)
}

async function onUp(event: PointerEvent) {
  if (!dragging) return
  dragging = false
  const c = challenge.value
  if (!c) return
  // 轨迹太短不提交 (和站点前端一致, 至少 3 个点)
  if (track.length < 3) { dx.value = 0; return }
  submitting.value = true
  error.value = ''
  const x = Math.round((dx.value / scale.value) * 10) / 10
  if (!track.length) track.push([Date.now() - dragStartAt, x, Math.round(event.clientY)])
  try {
    const pass = await verifySliderChallenge(props.uuid, props.verifyFnPath, { token: c.token, x, track })
    verified.value = true
    failed.value = false
    emit('verified', pass)
    toast(t('comics.sliderPassed'), 'success')
  } catch (e: any) {
    failed.value = true
    error.value = e?.message ?? String(e)
    // 失败即换题, 位置是随机的, 重试旧题没有意义
    setTimeout(() => { void load() }, 900)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div ref="host" class="slider-captcha">
    <div class="sc-frame" :style="{ width: frameW + 'px', height: frameH + 'px' }">
      <img v-if="challenge" class="sc-bg" :src="challenge.bg" :width="frameW" :height="frameH" alt="" draggable="false" />
      <img
        v-if="challenge" class="sc-piece" :src="challenge.piece" alt="" draggable="false"
        :style="{ width: pieceW + 'px', top: pieceTop + 'px', left: dx + 'px' }"
      />
      <div v-if="loading" class="sc-tip">{{ t('comics.sliderLoading') }}</div>
      <div v-else-if="verified" class="sc-tip ok">✓ {{ t('comics.sliderPassed') }}</div>
      <button v-if="!loading && !verified" type="button" class="sc-reload" :title="t('comics.sliderReload')" @click="load">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>
      </button>
    </div>
    <div class="sc-bar" :class="{ done: verified, bad: failed }">
      <div class="sc-fill" :style="{ width: (dx + knobW / 2) + 'px' }" />
      <span v-if="!verified" class="sc-bar-text">{{ t('comics.sliderHint') }}</span>
      <div
        class="sc-knob" :class="{ ok: verified, bad: failed, dragging }"
        :style="{ left: dx + 'px', width: knobW + 'px' }"
        role="slider" :aria-valuenow="Math.round(dx)" aria-valuemin="0" :aria-valuemax="maxMove"
        @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
      >
        <span v-if="verified">✓</span>
        <span v-else-if="submitting">…</span>
        <span v-else>➜</span>
      </div>
    </div>
    <p v-if="error" class="sc-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.slider-captcha { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.sc-frame {
  position: relative; overflow: hidden; border-radius: 8px;
  background: var(--surface-2); border: 1px solid var(--line); user-select: none;
}
.sc-bg { display: block; width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
.sc-piece {
  position: absolute; left: 0; pointer-events: none;
  filter: drop-shadow(0 0 4px rgba(0, 0, 0, 0.55));
}
.sc-tip {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 13px; color: var(--text-2); background: color-mix(in srgb, var(--bg) 72%, transparent);
}
.sc-tip.ok {
  display: block;
  inset: auto 8px 8px auto; padding: 3px 10px; border-radius: 999px;
  color: #fff; font-weight: 600; font-size: 12px;
  background: color-mix(in srgb, var(--success, #22c55e) 92%, transparent);
}
.sc-reload {
  position: absolute; right: 6px; top: 6px; width: 26px; height: 26px;
  display: grid; place-items: center; padding: 0;
  border: 0; border-radius: 6px; cursor: pointer;
  background: rgba(0, 0, 0, 0.45); color: #fff;
}
.sc-reload:hover { background: rgba(0, 0, 0, 0.62); }

.sc-bar {
  position: relative; height: 40px; border-radius: 20px;
  background: var(--surface-2); border: 1px solid var(--line); overflow: hidden;
}
.sc-fill {
  position: absolute; left: 0; top: 0; bottom: 0;
  background: color-mix(in srgb, var(--brand) 16%, transparent);
}
.sc-bar-text {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 12px; color: var(--text-3); pointer-events: none;
}
.sc-knob {
  position: absolute; left: 0; top: -1px; height: 40px;
  display: grid; place-items: center;
  border-radius: 20px; background: var(--brand); color: #fff; font-size: 17px;
  cursor: grab; touch-action: none; box-shadow: 0 2px 8px color-mix(in srgb, var(--brand) 40%, transparent);
}
.sc-knob.dragging { cursor: grabbing; }
.sc-knob.ok { background: var(--success, #22c55e); cursor: default; }
.sc-knob.bad { background: var(--danger, #ef4444); }
.sc-bar.bad { animation: sc-shake 0.35s; }
@keyframes sc-shake {
  25% { transform: translateX(-5px); }
  50% { transform: translateX(5px); }
  75% { transform: translateX(-3px); }
}
.sc-error { margin: 0; font-size: 12px; color: var(--danger, #ef4444); }
</style>
