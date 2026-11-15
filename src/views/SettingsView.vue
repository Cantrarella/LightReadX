<script setup lang="ts">
import { askConfirm } from '../services/confirm'
import AppSelect from '../components/AppSelect.vue'
import AppModal from '../components/AppModal.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MQ, useMediaQuery } from '../composables/useMediaQuery'
import { getStorage, isTauri } from '../storage'
import { useSettings } from '../stores/settings'
import { useLibrary } from '../stores/library'
import {
  exportBackup,
  exportBackupToFile,
  importBackupFromFile,
  importBackup,
  LIBRARY_ARCHIVE_EXTENSION,
} from '../services/backup'
import { backupToWebdav, restoreFromWebdav, testWebdav, verifyWebdav, WebdavConnectError, type WebdavDraft } from '../services/webdav'
import { detectProvider, displayHost, providerOf, WEBDAV_PROVIDERS, type WebdavProviderId } from '../services/webdavProviders'
import { requestAutoSync, syncConfigured, syncNow, syncState, waitForSync } from '../services/sync'
import type { SyncResult } from '../services/sync/types'
import { accountState, isLoggedIn } from '../services/account'
import AccountCard from '../components/settings/AccountCard.vue'
import AboutLinks from '../components/settings/AboutLinks.vue'
import { fetchRemote } from '../services/net'
import { toast } from '../services/toast'
import { cacheClear, cacheStats } from '../services/comicPlugin/imageCache'
import { clearFinished, downloadState, initDownloads } from '../services/comicPlugin/downloadCenter'
import { errorText, redactUrls } from '../services/errorText'
import {
  CURRENT_VERSION, RELEASES_URL, REPO_URL, ISSUES_URL,
  checkUpdate, pickDownloads, openDownload, canInAppInstall,
  downloadInstaller, installWithPrompt, downloadErrorMessage, openInstallPermission, installPermissionGranted, copyLink,
  type UpdateInfo, type DownloadOption,
} from '../services/updater'
import { t } from '../i18n'
import { bossKeyLabel, shortcutFromEvent, stealthSupported, STEALTH_BG_MIN, STEALTH_TEXT_MIN } from '../services/stealth'
import { providerById, chatStream } from '../services/ai'
import AiProviderPicker from '../components/settings/AiProviderPicker.vue'
import LocalModelPack from '../components/LocalModelPack.vue'

const settings = useSettings()

// ---- 摸鱼模式: 老板键用「点按后按下新组合键」录制, 格式与原生全局快捷键一致 ----
const stealthAvailable = stealthSupported()
const recording = ref(false)
function onRecordKey(e: KeyboardEvent) {
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    stopRecording()
    return
  }
  const key = shortcutFromEvent(e)
  if (!key) {
    // 只按了修饰键: 等后面的键; 按了不能用的键: 说明要怎样的组合, 继续录制
    if (!['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) toast(t('stealth.bossKeyNeedMod'))
    return
  }
  settings.stealth.bossKey = key
  stopRecording()
  toast(t('stealth.bossKeySaved', { key: bossKeyLabel(key) }))
}
function startRecording() {
  recording.value = true
  window.addEventListener('keydown', onRecordKey, true)
}
function stopRecording() {
  recording.value = false
  window.removeEventListener('keydown', onRecordKey, true)
}
onBeforeUnmount(stopRecording)
const isAndroid = /Android/i.test(navigator.userAgent)
const library = useLibrary()

const storageKind = ref('')
const busy = ref('')
/** busy 提示显示在哪张卡片: WebDAV 操作在「账号与同步」, 本地导入导出在「数据」 */
const busyScope = ref<'dav' | 'local'>('local')
const backupInput = ref<HTMLInputElement>()

// ---- WebDAV 网盘 ----
// 未连接: 选服务商 → 填账号与 (应用) 密码 → 「连接」一次完成校验、保存、开自动同步与首次同步.
// 已连接: 折叠为状态卡; 「修改」重新展开表单 (草稿), 校验通过才写回 settings.
/** 地址与账号已从其他设备同步过来、但没带密码 (未开「同步密码与密钥」): 需要本机补填密码才能连接 */
const davNeedsPass = computed(() => !!settings.webdavUrl.trim() && !!settings.webdavUser && !settings.webdavPass)
const davConnected = computed(() => !!settings.webdavUrl.trim() && !davNeedsPass.value)
const davProviderId = computed(() => detectProvider(settings.webdavUrl, settings.webdavProvider))
const davProvider = computed(() => providerOf(davProviderId.value))
const davEditing = ref(false)
const davShowForm = computed(() => !davConnected.value || davEditing.value)
const davHasAddress = computed(() => !!settings.webdavUrl.trim())
const davDraft = reactive<WebdavDraft>({ provider: 'jianguoyun', address: '', user: '', pass: '' })
const draftProvider = computed(() => providerOf(davDraft.provider))
/** 连接进度: '' 空闲 / verify 校验中 / sync 首次同步中 */
const davStage = ref<'' | 'verify' | 'sync'>('')
const davError = ref('')
const davErrorKind = ref('')
const davInfo = ref<{ text: string; error: boolean } | null>(null)

/** 本地操作失败: 标题 + 能看懂的原因 (原始技术报错只进控制台) */
function failText(key: string, e: unknown): string {
  const detail = errorText(e, '')
  return detail ? t('common.errorDetail', { head: t(key), detail }) : t(key)
}
const davPassInput = ref<HTMLInputElement>()
/** 网页版直连服务商时要提醒跨域 (固定服务商经中转, 无需提醒) */
const davWebNote = computed(() => {
  if (isTauri()) return ''
  return draftProvider.value.relay ? t('webdav.relayNote') : t('webdav.corsNote')
})

function resetDavDraft() {
  // 已连接或待补密码时以 settings 为准预填 (同步可能刚改过这些字段)
  const connected = davHasAddress.value
  davDraft.provider = connected ? davProviderId.value : 'jianguoyun'
  davDraft.address = connected && !davProvider.value.url ? settings.webdavUrl : ''
  davDraft.user = connected ? settings.webdavUser : ''
  davDraft.pass = connected ? settings.webdavPass : ''
  davError.value = ''
  davErrorKind.value = ''
}
resetDavDraft()

/** 未连接时先只列出服务商, 选中一个才展开表单 (渐进展开; 修改已有连接时直接展开) */
const davPicked = ref(davNeedsPass.value)

// 同步过程中 WebDAV 配置可能被其他设备的设置改写: 不在编辑 / 连接中时, 让表单跟上 settings
watch(() => [settings.webdavUrl, settings.webdavUser, settings.webdavPass, settings.webdavProvider], () => {
  if (davEditing.value || davStage.value) return
  resetDavDraft()
  davPicked.value = davNeedsPass.value
})

async function pickDavProvider(id: WebdavProviderId) {
  if (davStage.value) return
  const first = !davPicked.value
  davDraft.provider = id
  davPicked.value = true
  davError.value = ''
  davErrorKind.value = ''
  if (first) {
    await nextTick()
    document.getElementById(providerOf(id).url ? 'dav-user' : 'dav-address')?.focus({ preventScroll: true })
  }
}

// 改了表单就清掉上次的错误提示
watch(() => [davDraft.address, davDraft.user, davDraft.pass], () => {
  if (!davStage.value) { davError.value = ''; davErrorKind.value = '' }
})

function startDavEdit() {
  resetDavDraft()
  davEditing.value = true
  davPicked.value = true
  davInfo.value = null
}

function cancelDavEdit() {
  if (davStage.value) return
  davEditing.value = false
  davPicked.value = davNeedsPass.value
  resetDavDraft()
}

async function openExternalUrl(url: string) {
  try {
    await openDownload(url)
  } catch {
    toast(t('update.cannotOpenLink'), 'error')
  }
}

const davStageText = computed(() => {
  if (davStage.value === 'verify') return t('webdav.verifying')
  if (davStage.value === 'sync') return syncState.message || t('webdav.firstSync')
  return ''
})

async function connectWebdav() {
  if (davStage.value) return
  davError.value = ''
  davErrorKind.value = ''
  davStage.value = 'verify'
  let url: string
  try {
    url = await verifyWebdav(davDraft)
  } catch (e: any) {
    davStage.value = ''
    davError.value = errorText(e, t('common.unknownError'))
    davErrorKind.value = e instanceof WebdavConnectError ? e.kind : ''
    if (davErrorKind.value === 'auth') {
      await nextTick()
      davPassInput.value?.select()
    }
    return
  }
  settings.webdavProvider = davDraft.provider
  settings.webdavUrl = url
  settings.webdavUser = davDraft.user.trim()
  settings.webdavPass = davDraft.pass
  // 连网盘就是为了同步: 打开自动同步, 立刻同步一次
  settings.webdavSyncAuto = true
  davStage.value = 'sync'
  const name = t(`webdav.provider.${davDraft.provider}`)
  try {
    const r = await syncNow()
    // 有实际下载 / 待补文件时才附上同步明细, 否则一句「已连接」即可
    const detail = r.downloadedBooks > 0 || r.pendingBooks > 0 ? ' · ' + syncResultText(r) : ''
    toast(t('webdav.connectedToast', { name }) + detail, 'success', detail ? 6000 : 4000)
  } catch (e: any) {
    // 已通过校验并保存; 首次同步的错误留在同步状态行
    toast(errorText(e, t('sync.failed')), 'error', 6000)
  } finally {
    davStage.value = ''
    davEditing.value = false
    davPicked.value = false
  }
}

const showDavDisconnect = ref(false)
const davDisconnectCancel = ref<HTMLButtonElement>()

async function openDavDisconnect() {
  showDavDisconnect.value = true
  await nextTick()
  davDisconnectCancel.value?.focus()
}

async function confirmDavDisconnect() {
  // 正在同步时等它结束, 免得半路换掉配置
  await waitForSync()
  settings.webdavUrl = ''
  settings.webdavUser = ''
  settings.webdavPass = ''
  settings.webdavProvider = ''
  showDavDisconnect.value = false
  davEditing.value = false
  davPicked.value = false
  davInfo.value = null
  resetDavDraft()
  toast(t('webdav.disconnected'), 'success')
}

async function davTest() {
  busyScope.value = 'dav'
  busy.value = t('webdav.testing')
  davInfo.value = null
  try {
    const info = await testWebdav()
    davInfo.value = {
      error: false,
      text: info
        ? t('webdav.testOk', { size: (info.size / 1024 / 1024).toFixed(1), date: info.modified.slice(0, 22) })
        : t('webdav.testOkEmpty'),
    }
  } catch (e: any) {
    davInfo.value = { error: true, text: errorText(e, t('webdav.err.network')) }
  } finally {
    busy.value = ''
  }
}

async function davBackup() {
  busyScope.value = 'dav'
  busy.value = t('webdav.preparingBackup')
  davInfo.value = null
  try {
    await backupToWebdav(msg => (busy.value = msg))
    toast(t('webdav.backedUp'), 'success')
  } catch (e: any) {
    toast(errorText(e, t('webdav.backupFailed')), 'error', 6000)
  } finally {
    busy.value = ''
  }
}

async function davRestore() {
  if (!(await askConfirm(t('webdav.restoreConfirm')))) return
  busyScope.value = 'dav'
  busy.value = t('webdav.connectingCloud')
  davInfo.value = null
  try {
    const result = await restoreFromWebdav(msg => (busy.value = msg))
    await library.refresh()
    toast(t('webdav.restoreDone', { books: result.books, annotations: result.annotations }), 'success', 5000)
  } catch (e: any) {
    toast(errorText(e, t('settings.restoreFailed')), 'error', 6000)
  } finally {
    busy.value = ''
  }
}

const DAV_PROVIDER_ICONS: Record<WebdavProviderId, string> = {
  // 云
  jianguoyun: 'M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.75 4.75 0 0 1-.25 9.5H7z',
  koofr: 'M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.75 4.75 0 0 1-.25 9.5H7z',
  // 服务器
  selfhosted: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 9.5v-4zm0 9A1.5 1.5 0 0 1 5.5 13h13a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-4zM8 7.5h.01M8 16.5h.01',
  // 链接
  other: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
}

// ---- 轻阅账号 (登录流程见 components/settings/AccountCard.vue) ----
const loggedIn = computed(() => {
  void accountState.token
  try {
    return isLoggedIn()
  } catch {
    return !!accountState.token
  }
})

// ---- 多端同步 ----
// accountState.token / settings.webdavUrl 是响应式的, 放进 computed 后登录状态或地址变化会重新判断
const syncReady = computed(() => {
  void accountState.token
  void settings.webdavUrl
  try {
    return syncConfigured()
  } catch {
    return false
  }
})
const syncTargetNames = computed(() => {
  const names: string[] = []
  if (loggedIn.value) names.push(t('account.title'))
  if (davConnected.value) names.push(t(`webdav.provider.${davProviderId.value}`))
  return names.join(t('sync.targetSep'))
})
const syncNowTick = ref(Date.now())
const syncTicker = window.setInterval(() => (syncNowTick.value = Date.now()), 30_000)
onBeforeUnmount(() => window.clearInterval(syncTicker))

function formatSyncTime(at: number, now: number): string {
  const locale = settings.language === 'en' ? 'en' : 'zh-CN'
  const diff = now - at
  if (diff < 60_000) return t('sync.justNow')
  if (diff < 3_600_000) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-Math.floor(diff / 60_000), 'minute')
  }
  const then = new Date(at)
  const sameDay = then.toDateString() === new Date(now).toDateString()
  return new Intl.DateTimeFormat(locale, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(then)
}

const syncStatus = computed(() => {
  if (syncState.running) return { text: syncState.message || t('sync.running'), error: false }
  if (syncState.lastError) return { text: syncState.lastError, error: true }
  // 没有同步目标时提示去登录或填 WebDAV (不算错误)
  if (!syncReady.value) return { text: t('sync.err.notConfigured'), error: false }
  if (syncState.lastSyncAt) {
    return { text: t('sync.lastAt', { time: formatSyncTime(syncState.lastSyncAt, syncNowTick.value) }), error: false }
  }
  return { text: t('sync.never'), error: false }
})

function syncResultText(r: SyncResult): string {
  let msg = t('sync.done', { applied: r.applied, downloaded: r.downloadedBooks, uploaded: r.uploadedFiles })
  if (r.pendingBooks > 0) msg += t('sync.pending', { pending: r.pendingBooks })
  if (r.settingsApplied) msg += t('sync.settingsAppliedSuffix', { n: r.settingsApplied })
  return msg
}

async function doSyncNow() {
  if (syncState.running) return
  try {
    const r = await syncNow()
    toast(syncResultText(r), 'success', r.pendingBooks > 0 ? 6000 : 4000)
  } catch (e: any) {
    toast(errorText(e, t('sync.failed')), 'error', 6000)
  }
}

// ---- 设置同步: 密码与密钥需显式确认才开启 ----
const showSecretsConfirm = ref(false)
const secretsCancelBtn = ref<HTMLButtonElement>()

async function onSecretsToggle(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.checked) {
    settings.syncSecrets = false
    return
  }
  // 先复原开关, 确认后才真正打开
  input.checked = false
  showSecretsConfirm.value = true
  await nextTick()
  secretsCancelBtn.value?.focus()
}

function confirmSecrets() {
  settings.syncSecrets = true
  showSecretsConfirm.value = false
  requestAutoSync('settings')
}

// 打开「同步设置」后尽快同步一次 (遵循自动同步开关)
watch(() => settings.syncSettings, on => {
  if (on) requestAutoSync('settings')
})

// ---- 分区导航 (吸顶, 随滚动高亮当前分区) ----
const navSections = computed(() => [
  { id: 'sync', label: t('settings.syncSection') },
  { id: 'general', label: t('settings.general') },
  { id: 'features', label: t('settings.features') },
  { id: 'reading', label: t('settings.navReading') },
  { id: 'ai', label: t('settings.aiTitle') },
  { id: 'data', label: t('settings.data') },
  { id: 'storage', label: t('settings.storage') },
  { id: 'network', label: t('settings.network') },
  { id: 'about', label: t('settings.about') },
])
const activeSection = ref('sync')
const rootEl = ref<HTMLElement>()
const navEl = ref<HTMLElement>()
let scroller: HTMLElement | null = null
let spyFrame = 0
/** 点击跳转的平滑滚动期间不随滚动改高亮, 免得高亮在途经的分区间跳动 */
let spyLockUntil = 0

function updateActiveSection() {
  spyFrame = 0
  if (!scroller || Date.now() < spyLockUntil) return
  const navBottom = navEl.value?.getBoundingClientRect().bottom ?? 0
  let current = navSections.value[0]?.id ?? ''
  for (const s of navSections.value) {
    const el = document.getElementById(`settings-${s.id}`)
    if (el && el.getBoundingClientRect().top <= navBottom + 32) current = s.id
  }
  // 滚到底时最后几个短分区够不到顶部, 直接高亮最后一个
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
    current = navSections.value[navSections.value.length - 1]?.id ?? current
  }
  setActiveSection(current)
}

function setActiveSection(id: string) {
  if (activeSection.value === id) return
  activeSection.value = id
  // 横向滚动的导航条把当前项带进可视区 (只滚导航条自身)
  nextTick(() => {
    const nav = navEl.value
    const chip = nav?.querySelector<HTMLElement>(`[data-section="${id}"]`)
    if (!nav || !chip) return
    const left = chip.offsetLeft - 16
    const right = chip.offsetLeft + chip.offsetWidth + 16 - nav.clientWidth
    if (nav.scrollLeft > left) nav.scrollTo({ left, behavior: 'smooth' })
    else if (nav.scrollLeft < right) nav.scrollTo({ left: right, behavior: 'smooth' })
  })
}

function onSettingsScroll() {
  if (!spyFrame) spyFrame = requestAnimationFrame(updateActiveSection)
}

function jumpTo(id: string) {
  const el = document.getElementById(`settings-${id}`)
  if (!el) return
  // 默认收起的分区: 跳过去时先展开
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  spyLockUntil = Date.now() + (reduce ? 50 : 700)
  setActiveSection(id)
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  // 焦点跟到分区标题, 读屏与键盘用户也能接着往下走
  el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
}

const route = useRoute()
const router = useRouter()

// ---- 手机 (≤720px): 分组列表 + 二级页; 二级页就是下面的各分区, 由 ?page= 驱动, 系统返回键退回列表 ----
const phone = useMediaQuery(MQ.phone)
const phonePage = computed(() => {
  const page = route.query.page
  return phone.value && typeof page === 'string' && navSections.value.some(s => s.id === page) ? page : ''
})
const phonePageTitle = computed(() => navSections.value.find(s => s.id === phonePage.value)?.label ?? '')
const showSection = (id: string) => !phone.value || phonePage.value === id
function openPhonePage(id: string) {
  void router.push({ query: { ...route.query, page: id } })
}
function closePhonePage() {
  if (window.history.state?.back) router.back()
  else void router.replace({ query: {} })
}
watch(phonePage, () => nextTick(() => scroller?.scrollTo({ top: 0 })))

const phoneSheet = ref<'' | 'appearance' | 'language' | 'goal' | 'pdf' | 'backup'>('')
const appearanceLabel = computed(() => t(APPEARANCE_OPTIONS.find(o => o.value === settings.appearance)?.labelKey ?? 'settings.appearanceSystem'))
const GOAL_PRESETS = [0, 10, 15, 20, 30, 45, 60, 90, 120]
const goalOptions = computed(() => [...new Set([...GOAL_PRESETS, settings.dailyGoalMinutes])].sort((a, b) => a - b))
const accountEmail = computed(() => accountState.account?.email ?? '')
const aiProviderLabel = computed(() => t(`aiProvider.${aiPreset.value.id}`))
const proxyValue = computed(() => (isTauri() ? settings.httpProxy : settings.corsProxy) ? t('settings.proxyOn') : t('settings.proxyOff'))
function pickSheet(run: () => void) {
  run()
  phoneSheet.value = ''
}
async function sheetThen(run: () => unknown) {
  phoneSheet.value = ''
  await nextTick()
  await run()
}
async function resetTypographyConfirmed() {
  if (!(await askConfirm(t('settings.resetTypographyConfirm')))) return
  settings.resetReader()
  toast(t('settings.resetDone'), 'success')
}

onMounted(() => {
  scroller = rootEl.value?.closest<HTMLElement>('.main') ?? null
  scroller?.addEventListener('scroll', onSettingsScroll, { passive: true })
  // 深链: /settings?section=agents 直接定位 (并展开) 对应分区; 手机上直接进对应二级页
  const section = typeof route.query.section === 'string' ? route.query.section : ''
  if (!section || !navSections.value.some(s => s.id === section)) return
  if (phone.value) {
    void router.replace({ query: { page: section } })
  } else nextTick(() => jumpTo(section))
})
onBeforeUnmount(() => {
  scroller?.removeEventListener('scroll', onSettingsScroll)
  if (spyFrame) cancelAnimationFrame(spyFrame)
})

// ---- 代理配置 (桌面端) ----
const PROXY_SCHEMES: Array<{ label?: string; labelKey?: string; value: string }> = [
  { labelKey: 'settings.proxyNone', value: '' },
  { label: 'HTTP', value: 'http' },
  { label: 'HTTPS', value: 'https' },
  { label: 'SOCKS5', value: 'socks5' },
  { labelKey: 'settings.proxySocks5h', value: 'socks5h' },
  { label: 'SOCKS4', value: 'socks4' },
]

const proxy = reactive({ scheme: '', host: '127.0.0.1', port: '7890', username: '', password: '' })

function parseProxyUrl(raw: string) {
  const m = raw.trim().match(
    /^(https?|socks5h?|socks4a?):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/@]+)(?::(\d+))?$/i)
  if (!m) return
  proxy.scheme = m[1].toLowerCase()
  proxy.username = m[2] ? decodeURIComponent(m[2]) : ''
  proxy.password = m[3] ? decodeURIComponent(m[3]) : ''
  proxy.host = m[4]
  proxy.port = m[5] ?? ''
}

function composeProxyUrl(): string {
  if (!proxy.scheme || !proxy.host.trim()) return ''
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? ':' + encodeURIComponent(proxy.password) : ''}@`
    : ''
  const port = proxy.port.trim() ? `:${proxy.port.trim()}` : ''
  return `${proxy.scheme}://${auth}${proxy.host.trim()}${port}`
}

watch(proxy, () => {
  settings.httpProxy = composeProxyUrl()
})

// ---- 代理连通性测试 ----
const testing = ref(false)
const testResult = ref('')

async function testProxy() {
  testing.value = true
  testResult.value = ''
  const start = performance.now()
  try {
    await fetchRemote('https://www.google.com/generate_204')
    testResult.value = t('settings.proxyOk', { ms: Math.round(performance.now() - start) })
  } catch (e: any) {
    testResult.value = `❌ ${errorText(e, t('settings.connectionFailed'))}`
  } finally {
    testing.value = false
  }
}

onMounted(async () => {
  parseProxyUrl(settings.httpProxy)
  doCheckUpdate(false)
  const storage = await getStorage()
  storageKind.value = storage.kind
})

// ---- AI 助手 ----
const aiTesting = ref(false)
const aiTestResult = ref('')

function onAiProviderChange() {
  const preset = providerById(settings.aiProvider)
  if (preset.id !== 'custom') {
    settings.aiBaseUrl = preset.baseUrl
    settings.aiModel = preset.defaultModel
  }
  aiTestResult.value = ''
}

/** 预设服务商的接口地址已自动填好, 默认收起; 自定义或改过时展开 */
const aiBaseUrlOpen = ref(false)
const aiShowBaseUrl = computed(() => {
  const preset = providerById(settings.aiProvider)
  return aiBaseUrlOpen.value || preset.id === 'custom' || !settings.aiBaseUrl || settings.aiBaseUrl !== preset.baseUrl
})

const aiPreset = computed(() => providerById(settings.aiProvider))
const aiNeedsKey = computed(() => aiPreset.value.needsKey || aiPreset.value.id === 'custom')
const aiDocsUrl = computed(() => providerById(settings.aiProvider).docsUrl ?? '')

async function testAi() {
  if (aiTesting.value) return
  aiTesting.value = true
  aiTestResult.value = ''
  const started = performance.now()
  try {
    let got = ''
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout 20s')), 20000))
    await Promise.race([
      (async () => {
        for await (const delta of chatStream([{ role: 'user', content: '请回复: OK' }])) {
          got += delta
          if (got.length >= 2) break
        }
      })(),
      timeout,
    ])
    aiTestResult.value = `✅ ${t('settings.aiTestOk', { ms: Math.round(performance.now() - started), reply: got.slice(0, 20) })}`
  } catch (e: any) {
    aiTestResult.value = `❌ ${redactUrls(String(e?.message ?? e))}`
  } finally {
    aiTesting.value = false
  }
}

// ---- 版本与更新 ----
const updateInfo = ref<UpdateInfo | null>(null)
const checking = ref(false)
const checkError = ref('')
/** 手动检查过才显示"已是最新", 静默检查只在有新版时提示 */
const checkedManually = ref(false)
const downloads = computed(() => updateInfo.value ? pickDownloads(updateInfo.value.assets) : [])

async function doCheckUpdate(manual = true) {
  if (checking.value) return
  checking.value = true
  checkError.value = ''
  if (manual) checkedManually.value = true
  try {
    updateInfo.value = await checkUpdate(manual)
  } catch (e: any) {
    if (manual) checkError.value = errorText(e, t('update.checkFailed'))
  } finally {
    checking.value = false
  }
}

const fmtSize = (bytes: number) => `${(bytes / 1048576).toFixed(0)} MB`

// ---- 存储与缓存 (在线漫画阅读缓存 / 下载记录 / 商店索引) ----
const cacheInfo = reactive({ count: 0, bytes: 0, ready: false })
const downloadInfo = reactive({ total: 0, failed: 0, active: 0 })

function fmtCacheSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}
const cacheSizeText = computed(() => fmtCacheSize(cacheInfo.bytes))

function refreshStorageInfo() {
  initDownloads()
  downloadInfo.total = downloadState.tasks.length
  downloadInfo.failed = downloadState.tasks.filter(t => t.status === 'failed' || t.status === 'interrupted').length
  downloadInfo.active = downloadState.tasks.filter(t => t.status === 'queued' || t.status === 'running').length
  void cacheStats().then(stats => {
    cacheInfo.count = stats.count
    cacheInfo.bytes = stats.bytes
    cacheInfo.ready = true
  })
}

async function clearReaderCache() {
  await cacheClear()
  refreshStorageInfo()
  toast(t('settings.storageCleared'), 'success')
}

async function clearDownloadRecords() {
  const ok = await askConfirm(t('settings.storageClearDownloadsConfirm'), {
    title: t('settings.storageClearDownloads'),
    confirmLabel: t('settings.storageClear'),
  })
  if (!ok) return
  clearFinished('all')
  refreshStorageInfo()
  toast(t('settings.storageCleared'), 'success')
}

function clearStoreIndex() {
  try { localStorage.removeItem('lightread.comicStore.cache.v1') } catch { /* 忽略 */ }
  toast(t('settings.storageCleared'), 'success')
}
// 切到「存储」分区才去数一次, 免得每次进设置都扫 IndexedDB
watch(activeSection, id => { if (id === 'storage') refreshStorageInfo() })


async function download(url: string) {
  try {
    await openDownload(url)
    return true
  } catch {
    toast(t('update.cannotOpenLink'), 'error')
    return false
  }
}

// ---- 应用内下载安装 (桌面端与安卓应用, 走已配置的网络代理) ----
const installing = ref('')
const installedPath = ref('')
/** 安卓应用: 安装包存在应用缓存里, 不展示路径, 只给「安装」按钮 */
const isAndroidApp = isTauri() && isAndroid
/** 安卓: 等用户允许轻阅安装应用 (从设置页回来时重新判断) */
const needsInstallPermission = ref(false)
const refreshInstallPermission = () => {
  if (needsInstallPermission.value && document.visibilityState !== 'hidden') {
    needsInstallPermission.value = !installPermissionGranted()
  }
}
document.addEventListener('visibilitychange', refreshInstallPermission)
onBeforeUnmount(() => document.removeEventListener('visibilitychange', refreshInstallPermission))

async function downloadOption(d: DownloadOption) {
  if (!canInAppInstall()) {
    if (await download(d.url)) toast(t('update.browserDownloadStarted'), 'success')
    return
  }
  if (installing.value) return
  installing.value = t('common.connecting')
  installedPath.value = ''
  needsInstallPermission.value = false
  try {
    const fileName = decodeURIComponent(d.url.split('/').pop() ?? 'LightRead-installer')
    installedPath.value = await downloadInstaller(d.url, fileName, p => {
      installing.value = p.fraction != null
        ? t('update.downloadingPct', { pct: (p.fraction * 100).toFixed(0), received: p.receivedMB, total: p.totalMB })
        : t('update.downloadingMB', { received: p.receivedMB })
    })
  } catch (e) {
    toast(downloadErrorMessage(e), 'error', 10_000, { label: t('update.retry'), run: () => { void downloadOption(d) } })
    return
  } finally {
    installing.value = ''
  }
  await installDownloaded()
}

async function installDownloaded() {
  if (!installedPath.value) return
  try {
    await installWithPrompt(installedPath.value)
    // 已打开安装 (或回到前台后由 App 自动接着装); 没开权限时卡片上留一个「去开启」
    needsInstallPermission.value = !installPermissionGranted()
  } catch (e: any) {
    installedPath.value = ''
    needsInstallPermission.value = false
    toast(errorText(e, t('update.openFailed')), 'error', 6000)
  }
}

async function doCopyLink(url: string) {
  const ok = await copyLink(url)
  toast(ok ? t('update.linkCopied') : t('common.copyFailed'), ok ? 'success' : 'error')
}

// ---- 存储位置 (桌面端) ----
const migrating = ref('')

async function changeLibraryRoot() {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, title: t('settings.pickLibraryFolder') })
  if (typeof picked !== 'string') return
  const { hasLibraryAt, migrateLibraryTo } = await import('../storage/tauri')

  try {
    if (await hasLibraryAt(picked)) {
      if (!(await askConfirm(t('settings.useExistingLibrary', { path: picked })))) return
    } else {
      if (!(await askConfirm(t('settings.migrateConfirm', { path: picked })))) return
      migrating.value = t('settings.preparingMigration')
      await migrateLibraryTo(picked, msg => (migrating.value = msg))
    }
    settings.libraryRoot = picked
    // 设置持久化有 300ms 防抖, 直接落盘后重载
    localStorage.setItem('lightread-settings', JSON.stringify(settings.$state))
    toast(t('settings.locationSwitched'), 'success')
    setTimeout(() => location.reload(), 800)
  } catch (e: any) {
    migrating.value = ''
    toast(failText('settings.switchFailed', e), 'error', 6000)
  }
}

async function resetLibraryRoot() {
  if (!(await askConfirm(t('settings.resetLocationConfirm')))) return
  settings.libraryRoot = ''
  localStorage.setItem('lightread-settings', JSON.stringify(settings.$state))
  setTimeout(() => location.reload(), 300)
}

/** 在资源管理器中打开书库文件夹 */
async function openLibraryFolder() {
  try {
    const [{ openPath }, { appDataDir, join }] = await Promise.all([
      import('@tauri-apps/plugin-opener'),
      import('@tauri-apps/api/path'),
    ])
    const base = settings.libraryRoot || await appDataDir()
    const books = await join(base, 'books')
    await openPath(books)
  } catch (e: any) {
    toast(failText('settings.openFolderFailed', e), 'error', 5000)
  }
}

async function doExport() {
  busyScope.value = 'local'
  busy.value = t('settings.preparingExport')
  try {
    const fileName = `lightread-library-${new Date().toISOString().slice(0, 10)}${LIBRARY_ARCHIVE_EXTENSION}`
    if (isTauri() && !isAndroid) {
      // 桌面: 先选保存位置, 再由原生层流式写包 (书不经 WebView, 大书库不爆内存)
      const { save } = await import('@tauri-apps/plugin-dialog')
      const dest = await save({ defaultPath: fileName, filters: [{ name: 'LightRead', extensions: ['zip'] }] })
      if (!dest) return
      await exportBackupToFile(dest, msg => (busy.value = msg))
    } else {
      const blob = await exportBackup(msg => (busy.value = msg))
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = fileName
      a.click()
      URL.revokeObjectURL(a.href)
    }
    toast(t('settings.backupExported'), 'success')
  } catch (e: any) {
    toast(failText('settings.exportFailed', e), 'error', 5000)
  } finally {
    busy.value = ''
  }
}

/** 桌面: 用系统对话框拿到路径, 由原生层读包 (书不经 WebView); 网页 / App: 文件选择框 */
async function pickBackup() {
  if (!isTauri() || isAndroid) {
    backupInput.value?.click()
    return
  }
  const { open } = await import('@tauri-apps/plugin-dialog')
  const src = await open({ multiple: false, directory: false, filters: [{ name: 'LightRead', extensions: ['zip', 'lightread'] }] })
  if (typeof src === 'string') await runImport(msg => importBackupFromFile(src, msg))
}

async function doImport(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  await runImport(msg => importBackup(file, msg))
}

async function runImport(run: (onProgress: (msg: string) => void) => ReturnType<typeof importBackup>) {
  busyScope.value = 'local'
  busy.value = t('settings.readingBackup')
  try {
    const result = await run(msg => (busy.value = msg))
    await library.refresh()
    toast(t('settings.importDone', { books: result.books, annotations: result.annotations, sources: result.sources }), 'success', 5000)
  } catch (e: any) {
    toast(failText('settings.restoreFailed', e), 'error', 5000)
  } finally {
    busy.value = ''
  }
}

const APPEARANCE_OPTIONS = [
  { value: 'system', labelKey: 'settings.appearanceSystem', icon: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm4 16h8m-4-5v5' },
  { value: 'light', labelKey: 'settings.appearanceLight', icon: 'M12 3v2m0 14v2M5.6 5.6l1.4 1.4m10 10 1.4 1.4M3 12h2m14 0h2M5.6 18.4l1.4-1.4m10-10 1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z' },
  { value: 'dark', labelKey: 'settings.appearanceDark', icon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' },
] as const
</script>

<template>
  <div ref="rootEl" class="settings" :class="{ 'phone-sub': !!phonePage }">
    <template v-if="!phone">
      <h1>{{ t('settings.title') }}</h1>

      <nav ref="navEl" class="settings-nav" :aria-label="t('settings.navLabel')">
        <button
          v-for="s in navSections"
          :key="s.id"
          type="button"
          class="nav-chip"
          :class="{ active: activeSection === s.id }"
          :aria-current="activeSection === s.id ? 'true' : undefined"
          :data-section="s.id"
          @click="jumpTo(s.id)"
        >{{ s.label }}</button>
      </nav>
    </template>

    <!-- 手机二级页: 顶部返回栏 -->
    <nav v-else-if="phonePage" class="pl-navbar" :aria-label="phonePageTitle">
      <button type="button" class="pl-back" @click="closePhonePage">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m15 6-6 6 6 6"/></svg>
        {{ t('settings.title') }}
      </button>
      <span class="pl-navtitle">{{ phonePageTitle }}</span>
    </nav>

    <!-- 手机设置首页: 账号卡 + 分组列表 -->
    <div v-else class="phone-settings">
      <h1>{{ t('settings.title') }}</h1>

      <button type="button" class="pl-account" @click="openPhonePage('sync')">
        <span class="pl-avatar" aria-hidden="true">
          <template v-if="loggedIn && accountEmail">{{ accountEmail.charAt(0).toUpperCase() }}</template>
          <svg v-else viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20a7.5 7.5 0 0 1 15 0"/></svg>
        </span>
        <span class="pl-text">
          <span class="pl-account-title">{{ loggedIn ? accountEmail : syncReady ? syncTargetNames : t('settings.phoneLogin') }}</span>
          <span class="pl-account-sub" :class="{ error: syncStatus.error }">
            <span v-if="syncReady && !syncStatus.error" class="pl-dot" aria-hidden="true" />
            {{ syncReady ? syncStatus.text : t('settings.phoneLoginDesc') }}
          </span>
        </span>
        <span
          v-if="syncReady"
          class="pl-sync"
          role="button"
          tabindex="0"
          :class="{ spinning: syncState.running }"
          :aria-label="t('sync.now')"
          :title="t('sync.now')"
          @click.stop="doSyncNow"
          @keydown.enter.stop.prevent="doSyncNow"
        ><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4"/></svg></span>
        <template v-else><svg class="pl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg></template>
      </button>

      <div class="pl-label">{{ t('settings.general') }}</div>
      <div class="pl-group">
        <button type="button" class="pl-row" @click="phoneSheet = 'appearance'">
          <span class="pl-ico tone-ink" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg></span>
          <span class="pl-text"><span class="pl-title">{{ t('settings.appearance') }}</span></span>
          <span class="pl-value">{{ appearanceLabel }}</span><svg class="pl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
        </button>
        <button type="button" class="pl-row" @click="phoneSheet = 'language'">
          <span class="pl-ico tone-brand" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h9M8.5 3v2M6 5c1 4 4 7 7 8M11 5c-1 4-4 7-7 8M13 21l4-9 4 9M14.5 18h5"/></svg></span>
          <span class="pl-text"><span class="pl-title">{{ t('settings.language') }}</span></span>
          <span class="pl-value">{{ settings.language === 'en' ? 'English' : '中文' }}</span><svg class="pl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
        </button>
      </div>

      <div class="pl-label">{{ t('settings.navReading') }}</div>
      <div class="pl-group">
        <button type="button" class="pl-row" @click="phoneSheet = 'goal'">
          <span class="pl-ico tone-success" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/></svg></span>
          <span class="pl-text"><span class="pl-title">{{ t('settings.dailyGoal') }}</span></span>
          <span class="pl-value">{{ settings.dailyGoalMinutes ? t('settings.goalMinutes', { m: settings.dailyGoalMinutes }) : t('stats.goalOff') }}</span><svg class="pl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
        </button>
        <button type="button" class="pl-row" @click="phoneSheet = 'pdf'">
          <span class="pl-ico tone-danger" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6"/></svg></span>
          <span class="pl-text"><span class="pl-title">{{ t('settings.pdfRenderer') }}</span><span class="pl-desc">{{ t('settings.pdfRendererDesc') }}</span></span>
          <span class="pl-value">{{ settings.pdf.renderer === 'pdfium' ? 'PDFium' : 'MuPDF' }}</span><svg class="pl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
        </button>
        <button type="button" class="pl-row" @click="resetTypographyConfirmed">
          <span class="pl-ico tone-gray" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/></svg></span>
          <span class="pl-text"><span class="pl-title">{{ t('settings.resetTypography') }}</span><span class="pl-desc">{{ t('settings.resetTypographyDesc') }}</span></span>
        </button>
      </div>
      <p class="pl-foot">{{ t('settings.phoneTypographyHint') }}</p>

      <div class="pl-label">{{ t('settings.phoneAiGroup') }}</div>
      <div class="pl-group">
        <button type="button" class="pl-row" @click="openPhonePage('ai')">
          <span class="pl-ico tone-purple" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg></span>
          <span class="pl-text"><span class="pl-title">{{ t('settings.aiTitle') }}</span></span>
          <span class="pl-value">{{ aiProviderLabel }}</span><svg class="pl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
        </button>
      </div>

      <div class="pl-label">{{ t('settings.features') }}</div>
      <div class="pl-group">
        <label class="pl-row">
          <span class="pl-ico tone-warning" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg></span>
          <span class="pl-text"><span class="pl-title">{{ t('settings.featureBooklists') }}</span><span class="pl-desc">{{ t('settings.featureBooklistsDesc') }}</span></span>
          <span class="switch">
            <input v-model="settings.features.recommendedBooklists" type="checkbox" role="switch" :aria-label="t('settings.featureBooklists')" :aria-checked="settings.features.recommendedBooklists" />
            <span class="switch-track" aria-hidden="true"></span>
          </span>
        </label>
        <label class="pl-row">
          <span class="pl-ico tone-brand" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l3 3-3 3M20 6H5M7 21l-3-3 3-3M4 18h15"/></svg></span>
          <span class="pl-text"><span class="pl-title">{{ t('settings.featureTransfer') }}</span><span class="pl-desc">{{ t('settings.featureTransferDesc') }}</span></span>
          <span class="switch">
            <input v-model="settings.features.transfer" type="checkbox" role="switch" :aria-label="t('settings.featureTransfer')" :aria-checked="settings.features.transfer" />
            <span class="switch-track" aria-hidden="true"></span>
          </span>
        </label>
        <router-link v-if="settings.features.transfer" to="/transfer" class="pl-row pl-sub">
          <span class="pl-text"><span class="pl-title">{{ t('transfer.settingsEntry') }}</span></span><svg class="pl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
        </router-link>
      </div>
      <p class="pl-foot">{{ t('settings.featuresDesc') }}</p>

      <div class="pl-label">{{ t('settings.data') }}</div>
      <div class="pl-group">
        <button type="button" class="pl-row" @click="phoneSheet = 'backup'">
          <span class="pl-ico tone-brand" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5l9 4.5 9-4.5M12 12v9"/></svg></span>
          <span class="pl-text"><span class="pl-title">{{ t('settings.backupRestore') }}</span><span class="pl-desc">{{ t('settings.backupDesc') }}</span></span><svg class="pl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
        </button>
        <button type="button" class="pl-row" @click="openPhonePage('data')">
          <span class="pl-ico tone-gray" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg></span>
          <span class="pl-text"><span class="pl-title">{{ t('settings.storageBackend') }}</span><span class="pl-desc">{{ storageKind === 'filesystem' ? t('settings.storageDesktop') : t('settings.storageWeb') }}</span></span><svg class="pl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
        </button>
        <button type="button" class="pl-row" @click="openPhonePage('network')">
          <span class="pl-ico tone-gray" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg></span>
          <span class="pl-text"><span class="pl-title">{{ t('settings.network') }}</span><span class="pl-desc">{{ t('settings.phoneNetworkDesc') }}</span></span>
          <span class="pl-value">{{ proxyValue }}</span><svg class="pl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
        </button>
      </div>
      <div v-if="busy && busyScope === 'local'" class="busy pl-busy" role="status">{{ busy }}</div>

      <div class="pl-label">{{ t('settings.about') }}</div>
      <div class="pl-group">
        <button type="button" class="pl-row" @click="openPhonePage('about')">
          <img class="pl-app-icon" src="/icon-192.png" alt="" />
          <span class="pl-text"><span class="pl-title">LightRead 轻阅</span><span class="pl-desc">{{ !isTauri() ? t('settings.webVersion') : isAndroid ? t('settings.androidVersion') : t('settings.desktopVersion') }} · v{{ CURRENT_VERSION }}</span></span>
          <span v-if="updateInfo?.hasUpdate" class="pl-badge">{{ t('update.newVersion') }}</span>
          <span v-else class="pl-value">{{ t('update.check') }}</span><svg class="pl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
        </button>
        <button type="button" class="pl-row" @click="$router.push('/manual')">
          <span class="pl-ico tone-success" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.5C10.5 5 8 4.5 4 4.5v13c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-13c-4 0-6.5.5-8 2zM12 6.5v13"/></svg></span>
          <span class="pl-text"><span class="pl-title">{{ t('manual.title') }}</span></span><svg class="pl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6"/></svg>
        </button>
      </div>
      <div class="pl-end" />
    </div>

    <!-- 账号与同步 -->
    <section v-show="showSection('sync')" id="settings-sync" class="card section sync-section" :class="{ 'account-first': loggedIn }" aria-labelledby="settings-sync-heading">
      <h2 id="settings-sync-heading" tabindex="-1">{{ t('settings.syncSection') }}</h2>

      <!-- 同步状态: 账号与 WebDAV 共用, 有同步目标时显示 -->
      <div v-if="syncReady" class="sync-bar">
        <div class="sync-bar-main">
          <span class="sync-bar-icon" :class="{ error: syncStatus.error }" aria-hidden="true">
            <svg v-if="syncStatus.error" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5m0 3.5h.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.75 4.75 0 0 1-.25 9.5H7z" /><path d="m9.5 13.5 2 2 3.5-4" /></svg>
          </span>
          <div class="sync-bar-text">
            <div class="row-title">{{ t('sync.targets', { targets: syncTargetNames }) }}</div>
            <span class="sync-status" :class="{ error: syncStatus.error }" role="status" aria-live="polite">{{ syncStatus.text }}</span>
          </div>
          <button class="btn btn-primary sync-now" :disabled="syncState.running || !!busy || !!davStage" @click="doSyncNow">
            <svg :class="{ spinning: syncState.running }" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2" /><path d="M18.5 2.5v3.7h-3.7M5.5 21.5v-3.7h3.7" /></svg>
            {{ syncState.running ? t('sync.running') : t('sync.now') }}
          </button>
        </div>
        <div class="sync-toggles">
          <label class="toggle-row">
            <span class="toggle-text">
              <span class="row-title">{{ t('sync.auto') }}</span>
              <span class="row-desc">{{ t('sync.autoHint') }}</span>
            </span>
            <span class="switch">
              <input v-model="settings.webdavSyncAuto" type="checkbox" role="switch" :aria-checked="settings.webdavSyncAuto" />
              <span class="switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <label class="toggle-row">
            <span class="toggle-text">
              <span class="row-title">{{ t('sync.settings') }}</span>
              <span class="row-desc">{{ t('sync.settingsHint') }}</span>
            </span>
            <span class="switch">
              <input v-model="settings.syncSettings" type="checkbox" role="switch" :aria-checked="settings.syncSettings" />
              <span class="switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <label v-if="settings.syncSettings" class="toggle-row toggle-sub">
            <span class="toggle-text">
              <span class="row-title">
                {{ t('sync.secrets') }}
                <svg class="lock" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
              </span>
              <span class="row-desc">{{ t('sync.secretsHint') }}</span>
            </span>
            <span class="switch">
              <input type="checkbox" role="switch" :checked="settings.syncSecrets" :aria-checked="settings.syncSecrets" @change="onSecretsToggle" />
              <span class="switch-track" aria-hidden="true"></span>
            </span>
          </label>
        </div>
        <!-- 互传入口 (手机底部标签栏没有「互传」); 「功能」里关闭互传时隐藏 -->
        <router-link v-if="settings.features.transfer" to="/transfer" class="transfer-entry">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16.3 3.3a1 1 0 0 1 1.4 0l3 3a1 1 0 0 1 0 1.4l-3 3a1 1 0 1 1-1.4-1.4L17.58 8H5a1 1 0 0 1 0-2h12.59l-1.3-1.3a1 1 0 0 1 0-1.4zM7.7 13.3a1 1 0 0 1 0 1.4L6.42 16H19a1 1 0 1 1 0 2H6.41l1.3 1.3a1 1 0 1 1-1.42 1.4l-3-3a1 1 0 0 1 0-1.4l3-3a1 1 0 0 1 1.42 0z" /></svg>
          <span class="toggle-text">
            <span class="row-title">{{ t('transfer.settingsEntry') }}</span>
            <span class="row-desc">{{ t('transfer.settingsEntryDesc') }}</span>
          </span>
          <svg class="transfer-entry-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </router-link>
      </div>

      <!-- 轻阅账号 -->
      <div class="sync-block account-block">
        <AccountCard />
      </div>

      <!-- WebDAV 网盘 -->
      <div class="sync-block webdav-block">
        <template v-if="!davShowForm">
          <div class="conn-card">
            <span class="conn-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="DAV_PROVIDER_ICONS[davProviderId]" /></svg>
            </span>
            <div class="conn-id">
              <div class="row-title">
                {{ t(`webdav.provider.${davProviderId}`) }}
                <span class="conn-chip">{{ t('webdav.connected') }}</span>
              </div>
              <div class="conn-sub">
                {{ settings.webdavUser }}<template v-if="!davProvider.url"> · {{ displayHost(settings.webdavUrl) }}</template>
              </div>
            </div>
            <div class="conn-actions">
              <button class="btn btn-sm" :disabled="!!busy" @click="startDavEdit">{{ t('webdav.edit') }}</button>
              <button class="btn btn-sm" :disabled="!!busy" @click="openDavDisconnect">{{ t('webdav.disconnect') }}</button>
            </div>
          </div>
          <label class="toggle-row sync-files">
            <span class="toggle-text">
              <span class="row-title">{{ t('sync.files') }}</span>
              <span class="row-desc">{{ t('sync.filesHint') }}</span>
            </span>
            <span class="switch">
              <input v-model="settings.webdavSyncFiles" type="checkbox" role="switch" :aria-checked="settings.webdavSyncFiles" />
              <span class="switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <details class="more">
            <summary>
              <svg class="more-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
              {{ t('webdav.more') }}
            </summary>
            <div class="more-body">
              <div class="action-row">
                <button class="btn btn-sm" :disabled="!!busy || syncState.running" @click="davTest">{{ t('settings.testConnection') }}</button>
                <button class="btn btn-sm" :disabled="!!busy || syncState.running" @click="davBackup">{{ t('webdav.backup') }}</button>
                <button class="btn btn-sm" :disabled="!!busy || syncState.running" @click="davRestore">{{ t('webdav.restore') }}</button>
              </div>
              <div class="row-desc">{{ t('webdav.backupDesc') }}</div>
              <div v-if="busy && busyScope === 'dav'" class="busy" role="status">{{ busy }}</div>
              <div v-else-if="davInfo" class="dav-info" :class="{ error: davInfo.error }" role="status">{{ davInfo.text }}</div>
            </div>
          </details>
        </template>

        <template v-else>
          <div class="block-head">
            <div class="row-title">{{ t('webdav.title') }}</div>
            <div class="row-desc">{{ t(syncReady && !davConnected ? 'webdav.descAlt' : 'webdav.desc') }}</div>
          </div>
          <div v-if="davNeedsPass && !davEditing" class="dav-notice" role="status">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
            <span>{{ t('webdav.passNeeded') }}</span>
          </div>
          <div class="dav-providers" role="group" :aria-label="t('webdav.chooseProvider')">
            <button
              v-for="p in WEBDAV_PROVIDERS"
              :key="p.id"
              type="button"
              class="dav-provider"
              :class="{ active: davPicked && davDraft.provider === p.id }"
              :aria-pressed="davPicked && davDraft.provider === p.id"
              :disabled="!!davStage"
              @click="pickDavProvider(p.id)"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="DAV_PROVIDER_ICONS[p.id]" /></svg>
              <span class="dav-provider-text">
                <span class="dav-provider-name">{{ t(`webdav.provider.${p.id}`) }}</span>
                <span class="dav-provider-hint">{{ t(`webdav.providerHint.${p.id}`) }}</span>
              </span>
            </button>
          </div>

          <form v-if="davPicked" class="dav-form" novalidate @submit.prevent="connectWebdav">
            <div v-if="!draftProvider.url" class="field">
              <label class="field-label" for="dav-address">{{ t('webdav.address') }}</label>
              <input
                id="dav-address"
                v-model="davDraft.address"
                class="input"
                type="url"
                inputmode="url"
                autocapitalize="off"
                autocomplete="url"
                spellcheck="false"
                :placeholder="t(`webdav.addressPlaceholder.${davDraft.provider}`)"
                :disabled="!!davStage"
              />
              <div class="field-hint">{{ t(`webdav.addressHint.${davDraft.provider}`) }}</div>
            </div>
            <div class="dav-grid">
              <div class="field">
                <label class="field-label" for="dav-user">{{ t('webdav.user') }}</label>
                <input
                  id="dav-user"
                  v-model="davDraft.user"
                  class="input"
                  autocomplete="username"
                  autocapitalize="off"
                  spellcheck="false"
                  :placeholder="t(`webdav.userPlaceholder.${draftProvider.url ? davDraft.provider : 'default'}`)"
                  :disabled="!!davStage"
                />
              </div>
              <div class="field">
                <label class="field-label" for="dav-pass">{{ draftProvider.appPasswordUrl ? t('webdav.appPassword') : t('webdav.password') }}</label>
                <input
                  id="dav-pass"
                  ref="davPassInput"
                  v-model="davDraft.pass"
                  class="input"
                  type="password"
                  autocomplete="current-password"
                  :placeholder="draftProvider.appPasswordUrl ? t('webdav.appPasswordPlaceholder') : t('webdav.passwordPlaceholder')"
                  :aria-invalid="davErrorKind === 'auth'"
                  :aria-describedby="davError ? 'dav-error' : undefined"
                  :disabled="!!davStage"
                />
              </div>
            </div>
            <div v-if="draftProvider.appPasswordUrl" class="field-hint dav-app-pass">
              {{ t(`webdav.appPasswordHint.${davDraft.provider}`) }}
              <button type="button" class="link-btn" @click="openExternalUrl(draftProvider.appPasswordUrl!)">
                {{ t(`webdav.getAppPassword.${davDraft.provider}`) }}
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>
              </button>
            </div>
            <div v-if="davWebNote" class="field-hint">{{ davWebNote }}</div>
            <div v-if="davError" id="dav-error" class="dav-error" role="alert">{{ davError }}</div>
            <div class="dav-submit">
              <button type="submit" class="btn btn-primary dav-connect" :disabled="!!davStage">
                <svg v-if="davStage" class="spinning" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg>
                {{ davStage ? t('webdav.connecting') : t('webdav.connect') }}
              </button>
              <button v-if="davEditing" type="button" class="btn" :disabled="!!davStage" @click="cancelDavEdit">{{ t('common.cancel') }}</button>
              <button v-else-if="davNeedsPass" type="button" class="btn" :disabled="!!davStage" @click="openDavDisconnect">{{ t('webdav.disconnect') }}</button>
              <span v-if="davStageText" class="dav-stage" role="status" aria-live="polite">{{ davStageText }}</span>
            </div>
          </form>
        </template>
      </div>
    </section>

    <!-- 通用 -->
    <section v-show="showSection('general')" id="settings-general" class="card section" aria-labelledby="settings-general-heading">
      <h2 id="settings-general-heading" tabindex="-1">{{ t('settings.general') }}</h2>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.language') }}</div>
        </div>
        <div class="segmented" role="group" :aria-label="t('settings.language')">
          <button :aria-pressed="settings.language === 'zh'" :class="{ active: settings.language === 'zh' }" @click="settings.language = 'zh'">中文</button>
          <button :aria-pressed="settings.language === 'en'" :class="{ active: settings.language === 'en' }" @click="settings.language = 'en'">English</button>
        </div>
      </div>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.appearance') }}</div>
          <div class="row-desc">{{ t('settings.appearanceDesc') }}</div>
        </div>
        <div class="segmented" role="group" :aria-label="t('settings.appearance')">
          <button
            v-for="opt in APPEARANCE_OPTIONS"
            :key="opt.value"
            :aria-pressed="settings.appearance === opt.value"
            :class="{ active: settings.appearance === opt.value }"
            @click="settings.appearance = opt.value"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="opt.icon" /></svg>
            {{ t(opt.labelKey) }}
          </button>
        </div>
      </div>
    </section>


    <!-- 存储: 在线漫画阅读缓存 / 下载记录 / 商店索引 -->
    <section v-show="showSection('storage')" id="settings-storage" class="card section" aria-labelledby="settings-storage-heading">
      <h2 id="settings-storage-heading" tabindex="-1">{{ t('settings.storage') }}</h2>
      <p class="section-desc">{{ t('settings.storageDesc') }}</p>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.storageReaderCache') }}</div>
          <div class="row-desc">{{ t('settings.storageReaderCacheDesc', { count: cacheInfo.count, size: cacheSizeText }) }}</div>
        </div>
        <button class="btn" :disabled="!cacheInfo.count" @click="clearReaderCache">{{ t('settings.storageClear') }}</button>
      </div>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.storageDownloads') }}</div>
          <div class="row-desc">{{ t('settings.storageDownloadsDesc', { total: downloadInfo.total, failed: downloadInfo.failed }) }}</div>
        </div>
        <button class="btn" :disabled="!downloadInfo.total" @click="clearDownloadRecords">{{ t('settings.storageClear') }}</button>
      </div>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.storageStoreIndex') }}</div>
          <div class="row-desc">{{ t('settings.storageStoreIndexDesc') }}</div>
        </div>
        <button class="btn" @click="clearStoreIndex">{{ t('settings.storageClear') }}</button>
      </div>

      <h3 class="subheading">{{ t('settings.comicDownload') }}</h3>
      <p class="sub-desc">{{ t('settings.comicDownloadDesc') }}</p>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.comicConcurrency') }}</div>
          <div class="row-desc">{{ t('settings.comicConcurrencyDesc', { n: 8 }) }}<span class="val-badge">{{ settings.comicDownload.concurrency }}</span></div>
        </div>
        <input v-model.number="settings.comicDownload.concurrency" class="slider" type="range" min="1" max="16" step="1" :aria-label="t('settings.comicConcurrency')" />
      </div>
      <label class="toggle-row">
        <span class="toggle-text">
          <span class="row-title">{{ t('settings.comicRest') }}</span>
          <span class="row-desc">{{ t('settings.comicRestDesc') }}</span>
        </span>
        <span class="switch">
          <input v-model="settings.comicDownload.rest" type="checkbox" role="switch" :aria-label="t('settings.comicRest')" :aria-checked="settings.comicDownload.rest" />
          <span class="switch-track" aria-hidden="true"></span>
        </span>
      </label>
      <div v-if="settings.comicDownload.rest" class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.comicRestEvery') }}</div>
          <div class="row-desc"><span class="val-badge">{{ settings.comicDownload.restEvery }}</span></div>
        </div>
        <input v-model.number="settings.comicDownload.restEvery" class="slider" type="range" min="5" max="100" step="5" :aria-label="t('settings.comicRestEvery')" />
      </div>
      <div v-if="settings.comicDownload.rest" class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.comicRestFor') }}</div>
          <div class="row-desc"><span class="val-badge">{{ settings.comicDownload.restFor }}s</span></div>
        </div>
        <input v-model.number="settings.comicDownload.restFor" class="slider" type="range" min="1" max="120" step="1" :aria-label="t('settings.comicRestFor')" />
      </div>
    </section>

    <!-- 功能: 可选功能开关 (默认关) -->
    <section v-show="showSection('features')" id="settings-features" class="card section" aria-labelledby="settings-features-heading">
      <h2 id="settings-features-heading" tabindex="-1">{{ t('settings.features') }}</h2>
      <p class="section-desc">{{ t('settings.featuresDesc') }}</p>
      <label class="toggle-row">
        <span class="toggle-text">
          <span class="row-title">{{ t('settings.featureBooklists') }}</span>
          <span class="row-desc">{{ t('settings.featureBooklistsDesc') }}</span>
        </span>
        <span class="switch">
          <input v-model="settings.features.recommendedBooklists" type="checkbox" role="switch" :aria-label="t('settings.featureBooklists')" :aria-checked="settings.features.recommendedBooklists" />
          <span class="switch-track" aria-hidden="true"></span>
        </span>
      </label>
      <label class="toggle-row">
        <span class="toggle-text">
          <span class="row-title">{{ t('settings.featureTransfer') }}</span>
          <span class="row-desc">{{ t('settings.featureTransferDesc') }}</span>
        </span>
        <span class="switch">
          <input v-model="settings.features.transfer" type="checkbox" role="switch" :aria-label="t('settings.featureTransfer')" :aria-checked="settings.features.transfer" />
          <span class="switch-track" aria-hidden="true"></span>
        </span>
      </label>
    </section>

    <!-- 阅读 -->
    <section v-show="showSection('reading')" id="settings-reading" class="card section" aria-labelledby="settings-reading-heading">
      <h2 id="settings-reading-heading" tabindex="-1">{{ t('settings.reading') }}</h2>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.pdfRenderer') }}</div>
          <div class="row-desc">{{ t('settings.pdfRendererDesc') }}</div>
        </div>
        <div class="segmented" role="group" :aria-label="t('settings.pdfRenderer')">
          <button :aria-pressed="settings.pdf.renderer === 'mupdf'" :class="{ active: settings.pdf.renderer === 'mupdf' }" @click="settings.pdf.renderer = 'mupdf'">MuPDF</button>
          <button :aria-pressed="settings.pdf.renderer === 'pdfium'" :class="{ active: settings.pdf.renderer === 'pdfium' }" @click="settings.pdf.renderer = 'pdfium'">PDFium</button>
        </div>
      </div>
      <div class="row row-inline">
        <div class="row-text">
          <div class="row-title">{{ t('settings.resetTypography') }}</div>
          <div class="row-desc">{{ t('settings.resetTypographyDesc') }}</div>
        </div>
        <button class="btn" @click="resetTypographyConfirmed">{{ t('settings.restoreDefault') }}</button>
      </div>
      <!-- 摸鱼模式 (桌面安装版): services/stealth.ts -->
      <div v-if="stealthAvailable" class="stealth-settings">
        <div class="stealth-head">
          <div class="row-title">{{ t('stealth.title') }}</div>
          <div class="row-desc">{{ t('stealth.desc') }}</div>
        </div>
        <label class="toggle-row">
          <span class="toggle-text">
            <span class="row-title">{{ t('stealth.autoEnter') }}</span>
            <span class="row-desc">{{ t('stealth.autoEnterDesc') }}</span>
          </span>
          <span class="switch">
            <input v-model="settings.stealth.autoEnter" type="checkbox" role="switch" :aria-checked="settings.stealth.autoEnter" />
            <span class="switch-track" aria-hidden="true"></span>
          </span>
        </label>
        <div class="row">
          <div class="row-text">
            <div class="row-title">{{ t('stealth.bgOpacity') }}</div>
            <div class="row-desc">{{ t('stealth.bgOpacityDesc') }}</div>
          </div>
          <div class="ss-range">
            <input v-model.number="settings.stealth.bgOpacity" type="range" :min="STEALTH_BG_MIN" max="1" step="0.05" :aria-label="t('stealth.bgOpacity')" />
            <span class="ss-value">{{ Math.round(settings.stealth.bgOpacity * 100) }}%</span>
          </div>
        </div>
        <div class="row">
          <div class="row-text">
            <div class="row-title">{{ t('stealth.textOpacity') }}</div>
            <div class="row-desc">{{ t('stealth.textOpacityDesc') }}</div>
          </div>
          <div class="ss-range">
            <input v-model.number="settings.stealth.textOpacity" type="range" :min="STEALTH_TEXT_MIN" max="1" step="0.05" :aria-label="t('stealth.textOpacity')" />
            <span class="ss-value">{{ Math.round(settings.stealth.textOpacity * 100) }}%</span>
          </div>
        </div>
        <div class="row">
          <div class="row-text">
            <div class="row-title">{{ t('stealth.bossKey') }}</div>
            <div class="row-desc">{{ t('stealth.bossKeyDesc') }}</div>
          </div>
          <div class="ss-key">
            <button
              type="button"
              class="btn"
              :class="{ recording }"
              :aria-pressed="recording"
              @click="recording ? stopRecording() : startRecording()"
            >{{ recording ? t('stealth.bossKeyRecording') : (settings.stealth.bossKey ? bossKeyLabel(settings.stealth.bossKey) : t('stealth.bossKeyOff')) }}</button>
            <button v-if="settings.stealth.bossKey && !recording" type="button" class="btn" @click="settings.stealth.bossKey = ''">{{ t('stealth.bossKeyClear') }}</button>
          </div>
        </div>
        <label class="toggle-row">
          <span class="toggle-text">
            <span class="row-title">{{ t('stealth.disguise') }}</span>
            <span class="row-desc">{{ t('stealth.disguiseDesc') }}</span>
          </span>
          <span class="switch">
            <input v-model="settings.stealth.disguise" type="checkbox" role="switch" :aria-checked="settings.stealth.disguise" />
            <span class="switch-track" aria-hidden="true"></span>
          </span>
        </label>
        <div v-if="settings.stealth.disguise" class="row">
          <div class="row-text">
            <div class="row-title">{{ t('stealth.disguiseTitle') }}</div>
          </div>
          <input
            v-model="settings.stealth.disguiseTitle"
            class="input ss-title"
            maxlength="80"
            :placeholder="t('stealth.defaultTitle')"
            :aria-label="t('stealth.disguiseTitle')"
          />
        </div>
        <label class="toggle-row">
          <span class="toggle-text">
            <span class="row-title">{{ t('stealth.alwaysOnTop') }}</span>
            <span class="row-desc">{{ t('stealth.alwaysOnTopDesc') }}</span>
          </span>
          <span class="switch">
            <input v-model="settings.stealth.alwaysOnTop" type="checkbox" role="switch" :aria-checked="settings.stealth.alwaysOnTop" />
            <span class="switch-track" aria-hidden="true"></span>
          </span>
        </label>
        <label class="toggle-row">
          <span class="toggle-text">
            <span class="row-title">{{ t('stealth.skipTaskbar') }}</span>
            <span class="row-desc">{{ t('stealth.skipTaskbarDesc') }}</span>
          </span>
          <span class="switch">
            <input v-model="settings.stealth.skipTaskbar" type="checkbox" role="switch" :aria-checked="settings.stealth.skipTaskbar" />
            <span class="switch-track" aria-hidden="true"></span>
          </span>
        </label>
        <label class="toggle-row">
          <span class="toggle-text">
            <span class="row-title">{{ t('stealth.hideFromCapture') }}</span>
            <span class="row-desc">{{ t('stealth.hideFromCaptureDesc') }}</span>
          </span>
          <span class="switch">
            <input v-model="settings.stealth.hideFromCapture" type="checkbox" role="switch" :aria-checked="settings.stealth.hideFromCapture" />
            <span class="switch-track" aria-hidden="true"></span>
          </span>
        </label>
      </div>
    </section>

    <!-- AI 助手 -->
    <section v-show="showSection('ai')" id="settings-ai" class="card section" aria-labelledby="settings-ai-heading">
      <h2 id="settings-ai-heading" tabindex="-1">{{ t('settings.aiTitle') }}</h2>
      <p class="section-desc">{{ t('settings.aiDesc') }}</p>
      <div class="field-grid ai-fields">
        <div class="field field-wide">
          <label class="field-label" for="ai-provider">{{ t('settings.aiProvider') }}</label>
          <AiProviderPicker v-model="settings.aiProvider" @change="onAiProviderChange" />
          <p class="ai-provider-hint">{{ t(`aiProvider.${aiPreset.id}Desc`) }}</p>
        </div>
        <div class="field">
          <label class="field-label" for="ai-model">{{ t('settings.aiModelLabel') }}</label>
          <input id="ai-model" v-model="settings.aiModel" class="input" autocapitalize="off" spellcheck="false" :placeholder="t('settings.aiModelPh')" />
        </div>
        <div v-if="aiShowBaseUrl" class="field field-wide">
          <label class="field-label" for="ai-base-url">{{ t('settings.aiBaseUrlLabel') }}</label>
          <input id="ai-base-url" v-model="settings.aiBaseUrl" class="input" type="url" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://api.siliconflow.cn/v1" />
        </div>
        <div v-if="aiNeedsKey" class="field field-wide">
          <label class="field-label" for="ai-key">API Key</label>
          <input id="ai-key" v-model="settings.aiApiKey" class="input" type="password" :placeholder="t('settings.aiKeyPh')" autocomplete="new-password" />
        </div>
      </div>
      <div class="ai-actions">
        <button class="btn btn-primary" :disabled="aiTesting || !settings.aiBaseUrl.trim() || !settings.aiModel.trim() || (aiPreset.needsKey && !settings.aiApiKey.trim())" @click="testAi">
          {{ aiTesting ? t('settings.testing') : t('settings.aiTest') }}
        </button>
        <button v-if="!aiShowBaseUrl" type="button" class="link-btn" @click="aiBaseUrlOpen = true">{{ t('settings.aiEditBaseUrl') }}</button>
        <button v-if="aiDocsUrl" type="button" class="link-btn" @click="download(aiDocsUrl)">{{ t('settings.aiGetKey') }}</button>
      </div>
      <div v-if="aiTestResult" class="dav-info ai-result" role="status">{{ aiTestResult }}</div>
      <LocalModelPack />
      <LocalModelPack kind="tts" />
    </section>


    <!-- 数据 -->
    <section v-show="showSection('data')" id="settings-data" class="card section" aria-labelledby="settings-data-heading">
      <h2 id="settings-data-heading" tabindex="-1">{{ t('settings.data') }}</h2>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.storageBackend') }}</div>
          <div class="row-desc">{{ storageKind === 'filesystem' ? t('settings.storageDesktop') : t('settings.storageWeb') }}</div>
        </div>
      </div>
      <div v-if="isTauri()" class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.storageLocation') }}</div>
          <div class="row-desc">
            {{ t('settings.storageLocationDesc') }}<br />
            {{ t('common.current') }}: <code>{{ settings.libraryRoot || t('settings.defaultAppData') }}</code>
          </div>
        </div>
        <div class="row-actions">
          <button class="btn" :disabled="!!migrating" @click="openLibraryFolder">{{ t('settings.openFolder') }}</button>
          <button class="btn" :disabled="!!migrating" @click="changeLibraryRoot">{{ t('settings.changeLocation') }}</button>
          <button v-if="settings.libraryRoot" class="btn" :disabled="!!migrating" @click="resetLibraryRoot">{{ t('settings.restoreDefault') }}</button>
        </div>
      </div>
      <div v-if="migrating" class="busy">{{ migrating }}</div>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.backupRestore') }}</div>
          <div class="row-desc">{{ t('settings.backupDesc') }}</div>
        </div>
        <div class="row-actions">
          <button class="btn" :disabled="!!busy" @click="doExport">{{ t('settings.exportBackup') }}</button>
          <button class="btn" :disabled="!!busy" @click="pickBackup">{{ t('settings.importBackup') }}</button>
          <input ref="backupInput" type="file" accept=".okf.zip,.lightread,.zip" hidden @change="doImport" />
        </div>
      </div>
      <div v-if="busy && busyScope === 'local'" class="busy">{{ busy }}</div>
    </section>

    <!-- 网络 -->
    <section v-show="showSection('network')" id="settings-network" class="card section" aria-labelledby="settings-network-heading">
      <h2 id="settings-network-heading" tabindex="-1">{{ t('settings.network') }}</h2>
      <template v-if="isTauri()">
        <div class="row">
          <div class="row-text">
            <div class="row-title">{{ t('settings.proxyTitle') }}</div>
            <div class="row-desc">
              {{ t('settings.proxyDesc') }}
              ({{ t('settings.proxyDescPort') }} <code>7890</code>)
            </div>
          </div>
        </div>
        <div class="proxy-grid">
          <AppSelect v-model="proxy.scheme" class="input" :aria-label="t('settings.proxyTitle')">
            <option v-for="s in PROXY_SCHEMES" :key="s.value" :value="s.value">{{ s.labelKey ? t(s.labelKey) : s.label }}</option>
          </AppSelect>
          <input v-model="proxy.host" class="input" :placeholder="t('settings.proxyHostPlaceholder')" :aria-label="t('settings.proxyHostPlaceholder')" :disabled="!proxy.scheme" />
          <input v-model="proxy.port" class="input port" inputmode="numeric" :placeholder="t('settings.proxyPort')" :aria-label="t('settings.proxyPort')" :disabled="!proxy.scheme" />
        </div>
        <div v-if="proxy.scheme" class="proxy-grid">
          <input v-model="proxy.username" class="input" :placeholder="t('common.usernameOptional')" :aria-label="t('common.usernameOptional')" autocomplete="off" />
          <input v-model="proxy.password" class="input" type="password" :placeholder="t('common.passwordOptional')" :aria-label="t('common.passwordOptional')" autocomplete="new-password" />
          <button class="btn port" :disabled="testing" @click="testProxy">
            {{ testing ? t('settings.testingProxy') : t('settings.testConnection') }}
          </button>
        </div>
        <div v-if="settings.httpProxy" class="proxy-current">{{ t('common.current') }}: <code>{{ settings.httpProxy }}</code></div>
        <div v-if="testResult" class="proxy-result">{{ testResult }}</div>
      </template>
      <template v-else>
        <div class="field">
          <label class="row-title" for="cors-proxy">{{ t('settings.corsTitle') }}</label>
          <div class="row-desc cors-desc">
            {{ t('settings.corsDesc1') }}
            {{ t('settings.corsDesc2pre') }} <code>{url}</code> {{ t('settings.corsDesc2post') }}
          </div>
          <input
            id="cors-proxy"
            v-model="settings.corsProxy"
            class="input proxy-input"
            type="url"
            inputmode="url"
            autocapitalize="off"
            spellcheck="false"
            placeholder="https://your-proxy.example.com/?url={url}"
          />
        </div>
      </template>
    </section>

    <!-- 关于 -->
    <section v-show="showSection('about')" id="settings-about" class="card section" aria-labelledby="settings-about-heading">
      <h2 id="settings-about-heading" tabindex="-1">{{ t('settings.about') }}</h2>

      <div class="app-identity">
        <img class="app-icon" src="/icon-192.png" alt="LightRead" />
        <div class="app-meta">
          <div class="app-name">
            LightRead 轻阅
            <span class="version-chip">v{{ CURRENT_VERSION }}</span>
            <span class="env-chip">{{ !isTauri() ? t('settings.webVersion') : isAndroid ? t('settings.androidVersion') : t('settings.desktopVersion') }}</span>
          </div>
          <div class="app-tagline">{{ t('settings.tagline') }}</div>
        </div>
        <div class="about-actions">
          <button class="btn" @click="$router.push('/manual')">{{ t('manual.title') }}</button>
          <button class="btn" :disabled="checking" @click="doCheckUpdate()">
            {{ checking ? t('update.checking') : t('update.check') }}
          </button>
        </div>
      </div>

      <!-- 检查结果 -->
      <div v-if="checkError" class="update-state error" role="alert">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 3a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1zm0 8.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z"/></svg>
        {{ checkError }}
      </div>
      <div v-else-if="checkedManually && !checking && updateInfo && !updateInfo.hasUpdate" class="update-state ok" role="status">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm4.2 5.3a1 1 0 0 1 0 1.4l-4.9 4.9a1 1 0 0 1-1.4 0l-2.1-2.1a1 1 0 1 1 1.4-1.4l1.4 1.4 4.2-4.2a1 1 0 0 1 1.4 0z"/></svg>
        {{ t('update.latest') }}
      </div>

      <!-- 新版本卡片 -->
      <div v-if="updateInfo?.hasUpdate" class="update-card">
        <div class="update-head">
          <span class="update-badge">{{ t('update.newVersion') }}</span>
          <strong>v{{ updateInfo.version }}</strong>
          <span class="update-date">{{ updateInfo.publishedAt }}</span>
        </div>
        <pre v-if="updateInfo.notes" class="update-notes">{{ updateInfo.notes }}</pre>
        <div class="update-actions">
          <template v-for="(d, i) in downloads.filter(x => x.recommended)" :key="d.url">
            <button
              class="btn btn-sm"
              :class="{ 'btn-primary': i === 0 }"
              :disabled="!!installing"
              @click="downloadOption(d)"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/></svg>
              {{ d.label }} · {{ fmtSize(d.size) }}
            </button>
            <button class="copy-link-btn" :title="t('update.copyLinkTitle')" :aria-label="t('update.copyLinkTitle')" @click="doCopyLink(d.url)">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-2v-2h2a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-8a1 1 0 0 0-1 1v2H8V5zM2 11a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-8zm3-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1H5z"/></svg>
            </button>
          </template>
          <a class="all-downloads" href="javascript:void 0" @click="download(updateInfo.pageUrl)">
            {{ t('update.allPlatforms') }}
          </a>
        </div>
        <div v-if="installing" class="install-progress">
          {{ installing }}
          <span v-if="settings.httpProxy" class="install-hint">{{ t('update.viaProxy', { proxy: settings.httpProxy }) }}</span>
        </div>
        <div v-else-if="installedPath && isAndroidApp" class="install-done" role="status">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm4.2 5.3a1 1 0 0 1 0 1.4l-4.9 4.9a1 1 0 0 1-1.4 0l-2.1-2.1a1 1 0 1 1 1.4-1.4l1.4 1.4 4.2-4.2a1 1 0 0 1 1.4 0z"/></svg>
          <template v-if="needsInstallPermission">
            {{ t('update.needInstallPermission') }}
            <button class="btn btn-sm btn-primary" @click="openInstallPermission()">{{ t('update.allowInstall') }}</button>
          </template>
          <template v-else>
            {{ t('update.readyToInstall') }}
            <button class="btn btn-sm" @click="installDownloaded()">{{ t('update.install') }}</button>
          </template>
        </div>
        <div v-else-if="installedPath" class="install-done">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm4.2 5.3a1 1 0 0 1 0 1.4l-4.9 4.9a1 1 0 0 1-1.4 0l-2.1-2.1a1 1 0 1 1 1.4-1.4l1.4 1.4 4.2-4.2a1 1 0 0 1 1.4 0z"/></svg>
          {{ t('update.downloadedTo') }} <code>{{ installedPath }}</code>
          <button class="btn btn-sm" @click="installDownloaded()">{{ t('update.openInstaller') }}</button>
        </div>
        <p v-else-if="canInAppInstall() && isAndroidApp" class="install-tip">{{ t('update.installTipAndroid') }}</p>
        <p v-else-if="canInAppInstall()" class="install-tip">
          {{ t('update.installTipMain') }}{{ settings.httpProxy ? t('update.installTipProxied') : t('update.installTipNoProxy') }}{{ t('update.installTipEnd') }}
        </p>
      </div>

      <AboutLinks v-if="showSection('about')" />

      <div class="star-callout">
        <div class="star-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 2.5a1 1 0 0 1 .9.56l2.44 4.95 5.46.8a1 1 0 0 1 .56 1.7l-3.95 3.85.93 5.44a1 1 0 0 1-1.45 1.05L12 18.28l-4.89 2.57a1 1 0 0 1-1.45-1.05l.93-5.44-3.95-3.85a1 1 0 0 1 .56-1.7l5.46-.8 2.44-4.95A1 1 0 0 1 12 2.5z"/></svg>
        </div>
        <div class="star-copy">
          <div class="star-title">{{ t('settings.starTitle') }}</div>
          <div class="star-desc">{{ t('settings.starDesc') }}</div>
        </div>
        <button class="btn btn-primary star-action" @click="download(REPO_URL)">
          {{ t('settings.starAction') }}
        </button>
      </div>

      <div class="about">
        <details class="about-formats">
          <summary>{{ t('settings.aboutFormatsShort') }}</summary>
          <p>{{ t('settings.aboutFormats') }}</p>
        </details>
        <p class="about-links">
          <a href="javascript:void 0" @click="download(REPO_URL)">{{ t('settings.repoLink') }}</a>
          <a href="javascript:void 0" @click="download(ISSUES_URL)">{{ t('settings.issuesLink') }}</a>
          <a href="javascript:void 0" @click="download(RELEASES_URL)">{{ t('settings.releasesLink') }}</a>
        </p>
        <p class="muted">
          {{ t('settings.author') }}: 云中江树 ({{ t('settings.wechat') }}: 云中江树) · {{ t('settings.license') }}: GNU AGPL v3.0+
        </p>
      </div>
    </section>

    <!-- 手机设置: 选择面板 -->
    <AppModal v-if="phoneSheet === 'appearance'" :title="t('settings.appearance')" :description="t('settings.appearanceDesc')" @close="phoneSheet = ''">
      <div class="ps-list" role="radiogroup" :aria-label="t('settings.appearance')">
        <button
          v-for="opt in APPEARANCE_OPTIONS"
          :key="opt.value"
          type="button"
          role="radio"
          class="ps-row"
          :class="{ on: settings.appearance === opt.value }"
          :aria-checked="settings.appearance === opt.value"
          @click="pickSheet(() => (settings.appearance = opt.value))"
        >
          <span class="ps-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="opt.icon" /></svg></span>
          <span class="ps-label">{{ t(opt.labelKey) }}</span><svg class="ps-tick" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="m5 12.5 4.5 4.5L19 7.5"/></svg>
        </button>
      </div>
    </AppModal>
    <AppModal v-if="phoneSheet === 'language'" :title="t('settings.language')" @close="phoneSheet = ''">
      <div class="ps-list" role="radiogroup" :aria-label="t('settings.language')">
        <button
          v-for="opt in [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }] as const"
          :key="opt.value"
          type="button"
          role="radio"
          class="ps-row"
          :class="{ on: settings.language === opt.value }"
          :aria-checked="settings.language === opt.value"
          @click="pickSheet(() => (settings.language = opt.value))"
        ><span class="ps-label">{{ opt.label }}</span><svg class="ps-tick" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="m5 12.5 4.5 4.5L19 7.5"/></svg></button>
      </div>
    </AppModal>
    <AppModal v-if="phoneSheet === 'pdf'" :title="t('settings.pdfRenderer')" :description="t('settings.pdfRendererDesc')" @close="phoneSheet = ''">
      <div class="ps-list" role="radiogroup" :aria-label="t('settings.pdfRenderer')">
        <button
          v-for="opt in (['mupdf', 'pdfium'] as const)"
          :key="opt"
          type="button"
          role="radio"
          class="ps-row"
          :class="{ on: settings.pdf.renderer === opt }"
          :aria-checked="settings.pdf.renderer === opt"
          @click="pickSheet(() => (settings.pdf.renderer = opt))"
        ><span class="ps-label">{{ opt === 'mupdf' ? 'MuPDF' : 'PDFium' }}</span><svg class="ps-tick" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="m5 12.5 4.5 4.5L19 7.5"/></svg></button>
      </div>
    </AppModal>
    <AppModal v-if="phoneSheet === 'goal'" :title="t('settings.dailyGoal')" :description="t('stats.goalHint')" @close="phoneSheet = ''">
      <div class="ps-goals" role="radiogroup" :aria-label="t('stats.goalPickerAria')">
        <button
          v-for="m in goalOptions"
          :key="m"
          type="button"
          role="radio"
          :class="{ on: settings.dailyGoalMinutes === m }"
          :aria-checked="settings.dailyGoalMinutes === m"
          @click="pickSheet(() => (settings.dailyGoalMinutes = m))"
        >{{ m === 0 ? t('stats.goalOff') : m }}</button>
      </div>
    </AppModal>
    <AppModal v-if="phoneSheet === 'backup'" :title="t('settings.backupRestore')" :description="t('settings.backupDesc')" @close="phoneSheet = ''">
      <div class="ps-list">
        <button type="button" class="ps-row" :disabled="!!busy" @click="sheetThen(doExport)">
          <span class="ps-ico brand" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg></span>
          <span class="ps-label">{{ t('settings.exportBackup') }}</span>
        </button>
        <button type="button" class="ps-row" :disabled="!!busy" @click="sheetThen(pickBackup)">
          <span class="ps-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5l9 4.5 9-4.5M12 12v9"/></svg></span>
          <span class="ps-label">{{ t('settings.importBackup') }}</span>
        </button>
      </div>
    </AppModal>
    <AppModal v-if="showSecretsConfirm" :title="t('sync.secretsConfirmTitle')" initial-focus=".settings-confirm-cancel" @close="showSecretsConfirm = false">
      <div class="settings-confirm-body"><p>{{ t('sync.secretsConfirmBody') }}</p><p>{{ t('sync.secretsConfirmAdvice') }}</p></div>
      <template #footer><div class="modal-actions">
        <button ref="secretsCancelBtn" class="btn settings-confirm-cancel" @click="showSecretsConfirm = false">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" @click="confirmSecrets">{{ t('sync.secretsConfirmAction') }}</button>
      </div></template>
    </AppModal>
    <AppModal v-if="showDavDisconnect" :title="t('webdav.disconnectTitle', { name: t(`webdav.provider.${davProviderId}`) })" initial-focus=".settings-confirm-cancel" @close="showDavDisconnect = false">
      <div class="settings-confirm-body"><p>{{ t('webdav.disconnectConfirm') }}</p></div>
      <template #footer><div class="modal-actions">
        <button ref="davDisconnectCancel" class="btn settings-confirm-cancel" @click="showDavDisconnect = false">{{ t('common.cancel') }}</button>
        <button class="btn btn-danger" @click="confirmDavDisconnect">{{ t('webdav.disconnect') }}</button>
      </div></template>
    </AppModal>
  </div>
</template>

<style scoped src="../styles/views/settings.css"></style>
