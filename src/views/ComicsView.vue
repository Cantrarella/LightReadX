<script setup lang="ts">
/**
 * 漫画页: 本地漫画 (CBZ/CBR) 与在线漫画源分开显示。
 * 书籍与漫画共用同一个书库, 只在 UI 层按 format 分流 —— 同步、进度、标注全部沿用。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { importFiles } from '../services/importer'
import { readerPath } from '../services/readerRoute'
import { isComicFormat } from '../services/comicFormat'
import { toast } from '../services/toast'
import { t } from '../i18n'
import type { BookMeta } from '../storage'
import BookCard from '../components/BookCard.vue'

const router = useRouter()
const library = useLibrary()
const keyword = ref('')
const importing = ref(false)
const fileInput = ref<HTMLInputElement>()

const localComics = computed(() => library.books.filter(b => isComicFormat(b.format)))
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list = kw
    ? localComics.value.filter(b =>
      b.title.toLowerCase().includes(kw)
      || b.author.toLowerCase().includes(kw)
      || b.tags.some(tag => tag.toLowerCase().includes(kw)))
    : localComics.value
  return [...list].sort((a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt))
})

function openBook(book: BookMeta) {
  router.push(readerPath(book))
}

async function removeBook(book: BookMeta) {
  await library.removeBook(book.id)
}

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  importing.value = true
  try {
    const results = await importFiles(files, '本地导入')
    await library.refresh()
    const ok = results.filter(r => r.ok).length
    if (ok) toast(t('comics.importSuccess', { count: ok }), 'success')
    for (const f of results.filter(r => !r.ok)) toast(`${f.fileName}: ${f.error}`, 'error', 5000)
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error', 6000)
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <div class="comics">
    <header class="toolbar">
      <div class="heading">
        <h1>{{ t('nav.comics') }}</h1>
        <span v-if="library.loaded" class="count">{{ t('comics.localCount', { count: localComics.length }) }}</span>
      </div>
      <div class="spacer" />
      <div class="search-field">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16.5 16.5 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input v-model="keyword" class="search" type="search" :placeholder="t('comics.searchLocal')" :aria-label="t('comics.searchLocal')" />
      </div>
      <button class="btn btn-primary" :disabled="importing" @click="fileInput?.click()">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
        {{ t('comics.import') }}
      </button>
      <input ref="fileInput" type="file" accept=".cbz,.cbr,application/x-cbz,application/x-cbr" multiple hidden @change="onFiles" />
    </header>

    <section class="comic-section">
      <h2 class="section-title">{{ t('comics.local') }}</h2>
      <div v-if="filtered.length" class="grid">
        <BookCard
          v-for="book in filtered"
          :key="book.id"
          :book="book"
          :cover-url="library.coverUrls[book.id]"
          @open="openBook(book)"
          @remove="removeBook(book)"
        />
      </div>
      <div v-else class="empty">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="10" rx="1"/><rect x="13" y="3" width="8" height="6" rx="1"/><rect x="3" y="15" width="8" height="6" rx="1"/><rect x="13" y="11" width="8" height="10" rx="1"/></svg>
        </div>
        <p class="empty-title">{{ keyword ? t('comics.noMatch') : t('comics.localEmptyTitle') }}</p>
        <p class="hint">{{ t('comics.localEmptyHint') }}</p>
        <div class="empty-actions">
          <button class="btn btn-primary" @click="fileInput?.click()">{{ t('comics.import') }}</button>
        </div>
      </div>
    </section>

    <section class="comic-section">
      <h2 class="section-title">{{ t('comics.sources') }}</h2>
      <div class="empty">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>
        </div>
        <p class="empty-title">{{ t('comics.sourcesEmptyTitle') }}</p>
        <p class="hint">{{ t('comics.sourcesEmptyHint') }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.comics {
  min-height: 100%;
  max-width: calc(var(--page-max) + 2 * var(--page-x));
  margin: 0 auto;
  padding: 0 var(--page-x) calc(var(--page-bottom) + var(--lr-safe-bottom));
  position: relative;
}
.toolbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 calc(-1 * var(--page-x)) 18px;
  padding: var(--page-top) calc(var(--page-x) + var(--chrome-inset-right)) 12px var(--page-x);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid transparent;
}
.heading { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.toolbar h1 { font-size: var(--page-title); font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; }
.count { color: var(--text-3); font-size: 13px; white-space: nowrap; }
.spacer { flex: 1; }
.search-field { position: relative; display: flex; align-items: center; width: 260px; max-width: 100%; }
.search-icon { position: absolute; left: 12px; color: var(--text-3); pointer-events: none; }
.search { width: 100%; padding-left: 34px; padding-right: 30px; border-color: transparent; border-radius: var(--radius-pill); background: var(--surface-2); }
.comic-section { margin-top: 8px; }
.section-title { font-size: 15px; font-weight: 650; margin: 18px 0 14px; color: var(--text-2); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 22px 16px; }
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 40px 16px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-lg, 14px);
  background: var(--surface-1);
}
.empty-icon { color: var(--text-3); width: 38px; height: 38px; margin-bottom: 12px; }
.empty-icon svg { width: 100%; height: 100%; }
.empty-title { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
.hint { color: var(--text-3); font-size: 13px; line-height: 1.6; margin: 0; }
.empty-actions { margin-top: 16px; }
</style>
