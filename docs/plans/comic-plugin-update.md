# 插件更新机制 · 待办清单

> 起因：天哥问「插件有更新怎么解决」。查完代码确认——**商店装的插件已经能更新，手动装的完全没有通道**。
> 天哥拍板要补三件：① 插件管理页加「检查更新」按钮 ② 漫画源列表顶部提示 ③ uuid 变更检测。
> 独立成篇，不和 `download-center-v2.md` 混。

---

## 一、现状盘点（已具备的能力，别重造）

| 能力 | 位置 | 说明 |
|---|---|---|
| 版本语义化比较 | `store.ts` `compareVersion()` | 处理 `1.2.10 > 1.2.9`、预发布标记，已可用 |
| 商店更新判定 | `store.ts` `storeState()` → `new / update / installed` | 比 `storeVersion`（缺则用 `version`） |
| 有更新徽章 + 更新按钮 | `ComicStoreView.vue:183,199` | 仅商店页，仅商店来源插件 |
| 同 uuid 覆盖安装 | `registry.ts` `savePlugin()` | 按 uuid 过滤后 push，天然幂等 |
| 配置独立存储 | `registry.ts` `CONFIG_KEY + uuid` | 更新只换 code，**配置不丢** |
| 插件自述版本落库 | `index.ts:139` `version: info.version` | 来自 bundle 自报，不是外部校验过的 |
| 宿主不缓存 | `index.ts:73` `openPlugin()` | 每次重新读 registry 建宿主，**更新后无需重启** |
| 从 updateUrl 挖 bundle 链接 | `store.ts` `resolveUpdateUrls()` / `collectBundleLinks()` | 兼容 GitHub Release assets 与自定义 latest.json |
| 插件列表 UI | `ComicsView.vue:233,239` | 显示 `v{version}`、启用开关、移除、从文件/URL 安装 |

**缺口**：手动来源（`source: 'file' | 'url'`）的插件，`updateUrl` 存了却没人用；没有任何全局提示；uuid 一变就成为孤儿插件。

---

## 二、P1 · 插件管理页「检查更新」按钮

**位置**：`ComicsView.vue` 每个插件行的操作区（`.source-actions`，现有「进入 / 启用 / 移除」那一排）。

**行为**：
1. 点「检查更新」→ 按插件逐条检查（或整页一个「全部检查」）
2. 检查逻辑：
   - `updateUrl` 为空 → 直接给「此插件未提供更新地址」，不请求网络
   - 有 `updateUrl` → 拉取并解析出**最新版本号**，与已装 `version` 比
   - 已有新版 → 按钮变「更新到 vX.Y.Z」，点了复用安装链路覆盖
   - 已是最新 → 「已是最新」
3. 状态展示：检测中（转圈）/ 有新版本 / 已是最新 / 检查失败（附原因：超时、404、JSON 解析失败）

**要新写的函数**（`store.ts` 或新建 `update.ts`）：

```ts
/** 从 updateUrl 里挖出最新版本号: 兼容 GitHub Release(tag_name)、latest.json(version) */
export async function resolveLatestVersion(url: string): Promise<string | null>
```

现有 `resolveUpdateUrls()` 只挖 bundle 链接**不挖版本号**，这是本项的主要工作量。解析要能兼容：
- GitHub Releases API：`tag_name` / `name`，常见前缀 `v`
- 自定义 `latest.json`：`version` / `latest` / `latestVersion`
- 直接给 `.cjs` 直链的：无版本信息 → 只能提示「无法判断版本」

**验收**：给一个带 `updateUrl` 的手动插件点检查 → 正确显示新版号；点更新 → 覆盖成功且配置仍在。

---

## 三、P2 · 漫画源列表顶部提示

**位置**：`ComicsView.vue` 插件列表上方，一条横幅。

**行为**：
- 检测到 N 个插件有更新 → 顶部横条：「N 个插件有新版本」+「查看 / 全部更新」
- 无更新 → 不显示（不占地方）
- 点击 → 滚到/高亮对应插件行，或直接全部更新

**数据来源分两路**：
1. 商店来源：走商店索引（已有缓存），沿用 `storeState()`
2. 手动来源：走 P1 的 `resolveLatestVersion()`

**必须做的节流**（否则每次进页面都发请求，既慢又可能吃限流）：
- 结果缓存进 localStorage，带时间戳
- 缓存有效期建议 6 小时；「检查更新」按钮强制刷新
- 首次进入页面若从没检查过，不自动请求（避免打开就卡），只在有缓存结果时显示横幅

**验收**：有更新时横幅出现、数字正确；无更新时页面干净；离线时不报错、不卡。

---

## 四、P3 · uuid 变更检测

**问题**：作者改 uuid 后，旧插件还躺在列表里，配置 / 收藏 / 下载记录里存的都是老 uuid，全部对不上。

**行为**（安装或更新时触发）：
1. 新插件安装时，若已存在**同名但 uuid 不同**的插件 → 弹提示：
   「检测到同名插件 XX（旧 uuid），可能是新版本。要替换它并继承配置吗？」
2. 用户确认后：
   - 把旧 uuid 的配置复制到新 uuid（`getPluginConfig(old)` → 逐项 `setPluginConfigValue(new, k, v)`）
   - 移除旧插件
   - 记录新旧映射，供历史数据迁移
3. 用户拒绝 → 保持两个插件并存（现状行为），但给一次提示说明「会有两个同名源」

**配套处理（容易漏）**：
- 下载任务表里 `task.uuid` 指向旧 uuid → 需迁移，否则详情页按钮状态对不上
- `lightread.comics.lastPath` 等路由记忆里可能带旧 uuid
- 收藏 / 继续阅读记录里的 uuid 引用

**验收**：装两个同 name 不同 uuid 的插件 → 弹出提示；确认后配置继承、旧插件消失、老下载记录仍能对上。

---

## 五、风险

1. **已装版本号不可靠**：`version` 来自插件 bundle 自报，作者写错了就没法比。必要时以 `storeVersion` 优先（商店来源已有此逻辑）。
2. **GitHub API 未认证限流**（60 次/小时/IP）。检查更新要做成用户主动触发 + 结果缓存，不能后台定时轮询。
3. **updateUrl 形态千奇百怪**：Release API / latest.json / 裸 .cjs 直链，解析要有兜底，失败时给明确原因而不是静默。
4. **uuid 迁移是破坏性操作**：必须先备份配置（复制而非移动），旧插件移除前要确认新插件已成功落库。
5. **正在运行的下载任务**：更新插件不影响已启动的任务（用的是旧实例，跑完为止），但 uuid 迁移可能让 `cancelDownload(key)` 对不上，需要在迁移时同步任务表。

## 六、不做

- 后台自动检查更新（默认静默联网，不合适；只做手动触发 + 缓存）
- 插件市场之外的自动发现（没有可靠来源）
