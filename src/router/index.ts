import { createRouter, createWebHashHistory } from 'vue-router'

// Tauri 生产环境走 file 协议, 统一使用 hash 路由
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/library' },
    { path: '/library', component: () => import('../views/LibraryView.vue') },
    { path: '/comics', component: () => import('../views/ComicsView.vue') },
    { path: '/comics/store', component: () => import('../views/ComicStoreView.vue') },
    { path: '/downloads', component: () => import('../views/DownloadsView.vue') },
    // 独立发现页已并入漫画源「进入」页, 旧链接/书签保留重定向 (含 ?tab=cloudFavorite)
    { path: '/comics/discover/:uuid', redirect: to => ({ path: `/comics/source/${to.params.uuid}`, query: to.query }) },
    { path: '/comics/settings/:uuid', component: () => import('../views/ComicPluginSettingsView.vue') },
    { path: '/comics/source/:uuid', component: () => import('../views/ComicSourceView.vue') },
    // 在线漫画阅读走 /read 前缀, 复用沉浸式外壳 (无侧栏, 顶栏自动隐藏)
    { path: '/read/comic/:uuid/:comicId/:chapterId', component: () => import('../views/ComicReaderView.vue') },
    { path: '/read-paper/:id', component: () => import('../views/PaperReaderView.vue') },
    { path: '/read/:id', component: () => import('../views/ReaderView.vue') },
    // 旧版 /read-pdf 已并入论文阅读器 (PDF 统一引擎)
    { path: '/read-pdf/:id', redirect: to => `/read-paper/${to.params.id}` },
    { path: '/read-djvu/:id', component: () => import('../views/DjvuReaderView.vue') },
    { path: '/catalogs', component: () => import('../views/CatalogView.vue') },
    { path: '/stats', component: () => import('../views/StatsView.vue') },
    // 互传 (设备间发送文字 / 链接 / 文件; ?code=123456 直接取件)
    { path: '/transfer', component: () => import('../views/TransferView.vue') },
    { path: '/settings', component: () => import('../views/SettingsView.vue') },
    { path: '/manual', component: () => import('../views/ManualView.vue') },
  ],
})
