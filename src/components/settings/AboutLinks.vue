<script setup lang="ts">
/**
 * 关于页: 本机系统安装包。桌面与 App 共用 (openDownload 在 App 构建里解析到各自实现)。
 * 数据与规则见 services/aboutLinks.ts, 取数见 aboutLinksLoad.ts。
 */
import { computed, onMounted, ref } from 'vue'
import { t } from '../../i18n'
import { openDownload } from '../../services/updater'
import { toast } from '../../services/toast'
import { detectPlatform, type PackageKind, type PlatformDownload, type PlatformId } from '../../services/aboutLinks'
import { loadPlatformDownloads } from '../../services/aboutLinksLoad'

const PLATFORM_LABEL: Record<PlatformId, string> = {
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  android: 'Android',
}
const PKG_KEY: Record<PackageKind, string> = {
  installer: 'settings.pkgInstaller',
  appleSilicon: 'settings.pkgAppleSilicon',
  intel: 'settings.pkgIntel',
  appimage: 'settings.pkgAppImage',
  deb: 'settings.pkgDeb',
  rpm: 'settings.pkgRpm',
  apk: 'settings.pkgApk',
}

const thisPlatform = detectPlatform(navigator.userAgent)

const downloads = ref<PlatformDownload[]>([])
const downloadsState = ref<'loading' | 'ready' | 'failed'>('loading')

/** 只显示本机平台 (桌面版=Windows / App 版=Android), 其余系统安装包不再展示 */
const rows = computed(() => downloads.value.filter(d => d.platform === thisPlatform))

const fmtSize = (bytes: number) => (bytes > 0 ? ` · ${Math.max(1, Math.round(bytes / 1048576))} MB` : '')

async function open(url: string) {
  try {
    await openDownload(url)
  } catch {
    toast(t('update.cannotOpenLink'), 'error')
  }
}

onMounted(async () => {
  try {
    downloads.value = (await loadPlatformDownloads()).items
    downloadsState.value = 'ready'
  } catch {
    downloadsState.value = 'failed'
  }
})
</script>

<template>
  <div class="about-links-block">
    <section class="block" aria-labelledby="about-downloads-title">
      <h3 id="about-downloads-title" class="block-title">{{ t('settings.downloadsTitle') }}</h3>
      <div v-if="downloadsState === 'loading'" class="rows" aria-busy="true">
        <div v-for="i in 4" :key="i" class="row"><span class="skeleton sk-name" /><span class="skeleton sk-btn" /></div>
      </div>
      <p v-else-if="downloadsState === 'failed'" class="state">{{ t('settings.downloadsFailed') }}</p>
      <div v-else class="rows">
        <div v-for="d in rows" :key="d.platform" class="row" :data-platform="d.platform">
          <div class="row-name">
            <span class="platform">{{ PLATFORM_LABEL[d.platform] }}</span>
            <span v-if="d.platform === thisPlatform" class="chip chip-brand">{{ t('settings.downloadsThisDevice') }}</span>
            <span v-if="d.platform === 'android'" class="chip">{{ t('settings.downloadsExperimental') }}</span>
            <span class="version">v{{ d.version }}</span>
          </div>
          <div class="row-actions">
            <button
              v-for="p in d.packages"
              :key="p.name"
              type="button"
              class="btn btn-sm"
              :title="p.name"
              @click="open(p.url)"
            >{{ t(PKG_KEY[p.kind]) }}<span class="size">{{ fmtSize(p.size) }}</span></button>
          </div>
        </div>
      </div>
    </section>

  </div>
</template>

<style scoped>
.about-links-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  margin: var(--space-2) 0 var(--space-6);
}
.block-title {
  margin: 0 0 var(--space-2);
  font-size: var(--fs-sm, 13px);
  font-weight: 600;
  color: var(--text-3);
}
.rows {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  min-height: 52px;
  padding: var(--space-2) var(--space-4);
}
.row + .row {
  border-top: 1px solid var(--border);
}
.row-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.platform {
  font-weight: 500;
}
.version {
  font-size: var(--fs-sm, 13px);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.chip {
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-xs, 12px);
  line-height: 20px;
}
.chip-brand {
  background: var(--brand-soft);
  color: var(--brand);
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.size {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.state {
  margin: 0;
  padding: var(--space-4);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-3);
  font-size: var(--fs-sm, 13px);
}
.skeleton {
  display: block;
  border-radius: var(--radius-sm);
}
.sk-name {
  width: 120px;
  height: 16px;
  margin-right: auto;
}
.sk-btn {
  width: 96px;
  height: 28px;
}
@media (max-width: 720px) {
  .row {
    padding: var(--space-3) var(--space-4);
  }
  .row-name,
  .row-actions {
    flex: 1 1 100%;
  }
  /* 手机: 按钮高度保持触控尺寸, 收窄左右留白, 同一系统的包尽量排在一行 */
  .row-actions .btn {
    padding: 0 var(--space-3);
    font-size: var(--fs-sm, 13px);
  }
  .size {
    display: none;
  }
}
</style>
