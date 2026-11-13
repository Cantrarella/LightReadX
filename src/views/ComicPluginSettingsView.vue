<script setup lang="ts">
/**
 * 插件账号 / 设置页: Breeze 的 getSettingsBundle / getLoginBundle /
 * getUserInfoBundle / getCapabilitiesBundle 全部由插件提供表单与动作,
 * 宿主只渲染并转发, 账号密码由插件自己存进本地插件配置。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { t } from '../i18n'
import { toast } from '../services/toast'
import { getPlugin, isUnauthorizedError } from '../services/comicPlugin'
import {
  loadCapabilities, loadLoginBundle, loadPluginSettings, loadUserInfo,
  runCapability, saveSettingValue, submitLogin,
  type PluginCapability, type PluginLoginBundle, type PluginSettingsBundle,
} from '../services/comicPlugin/account'
import AppModal from '../components/AppModal.vue'

const route = useRoute()
const router = useRouter()
const uuid = String(route.params.uuid ?? '')
const plugin = getPlugin(uuid)

const settings = ref<PluginSettingsBundle | null>(null)
const loginBundle = ref<PluginLoginBundle | null>(null)
const userInfo = ref<Record<string, unknown>>({})
const capabilities = ref<PluginCapability[]>([])
const settingValues = reactive<Record<string, unknown>>({})
const loginValues = reactive<Record<string, unknown>>({})
const showLogin = ref(false)
const loading = ref(true)
const submitting = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')

const userName = computed(() => String(userInfo.value.username ?? userInfo.value.nickname ?? ''))
const userAvatar = computed(() => String(userInfo.value.photo ?? userInfo.value.avatar ?? ''))
const userMeta = computed(() => {
  const level = userInfo.value.level_name ?? userInfo.value.levelName ?? ''
  const coin = userInfo.value.coin ?? ''
  const exp = userInfo.value.exp ?? ''
  return [level && String(level), coin && `${t('comics.userCoin')} ${coin}`, exp && `${t('comics.userExp')} ${exp}`]
    .filter(Boolean).join(' · ')
})
const loggedIn = computed(() => !!userName.value)

function messageOf(e: unknown): string {
  if (isUnauthorizedError(e)) return t('comics.loginRequired')
  return e instanceof Error ? e.message : String(e)
}

async function loadAll() {
  loading.value = true
  error.value = ''
  try {
    settings.value = await loadPluginSettings(uuid)
    for (const [key, value] of Object.entries(settings.value.values)) settingValues[key] = value
  } catch (e) { error.value = messageOf(e) }
  try { userInfo.value = await loadUserInfo(uuid) } catch { userInfo.value = {} }
  try { capabilities.value = await loadCapabilities(uuid) } catch { capabilities.value = [] }
  loading.value = false
}

onMounted(() => { void loadAll() })

async function openLogin() {
  error.value = ''
  try {
    const bundle = await loadLoginBundle(uuid)
    if (!bundle) { toast(t('comics.loginUnavailable'), 'error'); return }
    loginBundle.value = bundle
    for (const field of bundle.fields) loginValues[field.key] = bundle.values[field.key] ?? ''
    showLogin.value = true
  } catch (e) { error.value = messageOf(e) }
}

async function doLogin() {
  if (!loginBundle.value || submitting.value) return
  submitting.value = true
  error.value = ''
  try {
    await submitLogin(uuid, loginBundle.value.fnPath, { ...loginValues })
    showLogin.value = false
    notice.value = t('comics.loginSuccess')
    await loadAll()
  } catch (e) { error.value = messageOf(e) }
  finally { submitting.value = false }
}

async function saveSettings() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    for (const [key, value] of Object.entries(settingValues)) {
      await saveSettingValue(uuid, key, value)
    }
    notice.value = t('comics.settingsSaved')
    await loadAll()
  } catch (e) { error.value = messageOf(e) }
  finally { saving.value = false }
}

async function doCapability(cap: PluginCapability) {
  error.value = ''
  try {
    await runCapability(uuid, cap.fnPath)
    notice.value = cap.title
    await loadAll()
  } catch (e) { error.value = messageOf(e) }
}

function goCloudFavorite() {
  void router.push(`/comics/discover/${encodeURIComponent(uuid)}?tab=cloudFavorite`)
}

function updateField(target: Record<string, unknown>, key: string, event: Event) {
  const el = event.target as HTMLInputElement | HTMLSelectElement
  target[key] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value
}
</script>

<template>
  <div class="plugin-settings">
    <header class="toolbar">
      <button class="btn btn-ghost back-btn" @click="router.push('/comics')">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m15 18-6-6 6-6"/></svg>
        {{ t('nav.comics') }}
      </button>
      <div class="heading"><h1>{{ plugin?.name ?? t('comics.pluginSettings') }}</h1></div>
      <div class="spacer" />
      <button class="btn btn-primary" @click="goCloudFavorite">{{ t('comics.viewCloudFavorite') }}</button>
    </header>

    <p v-if="!plugin" class="error-text">{{ t('comics.sourceMissing') }}</p>
    <template v-else>
      <p v-if="loading" class="hint loading-hint">{{ t('comics.discoverLoading') }}</p>
      <p v-if="error" class="error-text">{{ error }}</p>
      <p v-if="notice" class="notice">{{ notice }}</p>

      <section class="panel">
        <div class="panel-head">
          <h2 class="panel-title">{{ t('comics.account') }}</h2>
          <button v-if="settings?.canLogin" class="btn" @click="openLogin">{{ loggedIn ? t('comics.relogin') : t('comics.login') }}</button>
        </div>
        <div v-if="loggedIn" class="user-row">
          <img v-if="userAvatar" :src="userAvatar" class="user-avatar" alt="" referrerpolicy="no-referrer" />
          <div v-else class="user-avatar user-avatar-fallback" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>
          </div>
          <div class="user-meta">
            <div class="user-name">{{ userName }}</div>
            <div v-if="userMeta" class="hint">{{ userMeta }}</div>
          </div>
        </div>
        <p v-else class="hint">{{ t('comics.notLoggedIn') }}</p>
      </section>

      <section v-if="settings?.sections.length" class="panel">
        <div class="panel-head">
          <h2 class="panel-title">{{ t('comics.pluginSettings') }}</h2>
          <button class="btn btn-primary" :disabled="saving" @click="saveSettings">{{ t('comics.saveSettings') }}</button>
        </div>
        <div v-for="section in settings.sections" :key="section.id" class="setting-section">
          <h3 v-if="section.title" class="section-label">{{ section.title }}</h3>
          <label v-for="field in section.fields" :key="field.key" class="field">
            <span class="field-label">{{ field.label }}</span>
            <input
              v-if="field.kind !== 'choice' && field.kind !== 'switch' && field.kind !== 'confirm'"
              class="input" :type="field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'"
              :placeholder="field.placeholder || ''"
              :value="String(settingValues[field.key] ?? '')"
              @input="updateField(settingValues, field.key, $event)"
            />
            <select v-else-if="field.kind === 'choice'" class="input" :value="String(settingValues[field.key] ?? '')" @change="updateField(settingValues, field.key, $event)">
              <option v-for="(option, i) in field.options ?? []" :key="i" :value="String(option.value ?? '')">{{ option.label }}</option>
            </select>
            <input v-else class="checkbox" type="checkbox" :checked="Boolean(settingValues[field.key])" @change="updateField(settingValues, field.key, $event)" />
            <span v-if="field.description" class="hint field-desc">{{ field.description }}</span>
          </label>
        </div>
      </section>
      <p v-else-if="!loading" class="hint">{{ t('comics.settingsEmpty') }}</p>

      <section v-if="capabilities.length" class="panel">
        <h2 class="panel-title">{{ t('comics.pluginCapabilities') }}</h2>
        <div class="cap-row">
          <button v-for="cap in capabilities" :key="cap.key" class="btn" @click="doCapability(cap)">{{ cap.title }}</button>
        </div>
      </section>
    </template>

    <AppModal v-if="showLogin && loginBundle" :title="loginBundle.title" @close="showLogin = false">
      <div class="login-form">
        <p v-if="loginBundle.title" class="hint">{{ t('comics.loginHint') }}</p>
        <label v-for="field in loginBundle.fields" :key="field.key" class="field">
          <span class="field-label">{{ field.label }}</span>
          <input
            class="input" :type="field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'"
            :placeholder="field.placeholder || ''"
            :value="String(loginValues[field.key] ?? '')"
            @input="updateField(loginValues, field.key, $event)"
          />
        </label>
        <div class="modal-actions">
          <button class="btn" @click="showLogin = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="submitting" @click="doLogin">{{ loginBundle.submitText }}</button>
        </div>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
.plugin-settings {
  min-height: 100%;
  max-width: calc(var(--page-max) + 2 * var(--page-x));
  margin: 0 auto;
  padding: 0 var(--page-x) calc(var(--page-bottom) + var(--lr-safe-bottom));
}
.toolbar {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 0 calc(-1 * var(--page-x)) 18px;
  padding: calc(var(--page-top) + 20px) calc(var(--page-x) + var(--chrome-inset-right)) 16px var(--page-x);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
}
.toolbar h1 { font-size: var(--page-title); font-weight: 700; white-space: nowrap; }
.spacer { flex: 1; }
.back-btn { padding-left: 8px; }
.hint { color: var(--text-3); font-size: 13px; line-height: 1.6; margin: 0; }
.loading-hint { padding: 12px 0; }
.error-text { color: var(--danger, #d9534f); font-size: 13px; padding: 8px 0; margin: 0; }
.notice {
  color: var(--text-2); font-size: 13px; padding: 10px 14px; margin: 0 0 14px;
  border-radius: 8px; background: var(--surface-2);
}
.panel {
  border: 1px solid var(--border, var(--surface-2)); border-radius: 12px;
  padding: 18px 20px; margin-bottom: 16px; background: var(--surface);
}
.panel-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.panel-title { font-size: 15px; font-weight: 600; margin: 0; flex: 1; }
.user-row { display: flex; align-items: center; gap: 14px; }
.user-avatar { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: var(--surface-2); }
.user-avatar-fallback { display: grid; place-items: center; color: var(--text-3); padding: 10px; }
.user-name { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
.setting-section + .setting-section { margin-top: 18px; }
.section-label { font-size: 13px; font-weight: 600; color: var(--text-2); margin: 0 0 12px; }
.field { display: block; margin-bottom: 14px; }
.field-label { display: block; font-size: 13px; margin-bottom: 6px; color: var(--text-2); }
.field-desc { display: block; margin-top: 4px; font-size: 12px; }
.input {
  width: 100%; max-width: 420px; padding: 9px 12px; font-size: 14px;
  border: 1px solid var(--border, var(--surface-2)); border-radius: 8px;
  background: var(--bg); color: var(--text);
}
.checkbox { width: 18px; height: 18px; }
.cap-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.login-form { padding: 16px 20px 20px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
</style>
