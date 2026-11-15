# 书单：制作与分享

2026-10-06 用户需求：「支持做书单」。在已有的个人书单（藏书页，按书单归类自己的书）基础上扩展为：

1. **书单里可以有「待找」的书**——还没在藏书里的书也能列进书单；
2. **分享书单**——导出为文件 / 文本，另一台轻阅「导入书单」即可还原；也能导出成适合发到聊天里的纯文本清单。

## 数据模型

个人书单原有两张表：`booklists { id, name, createdAt, updatedAt }`、`booklist_items { booklistId, bookId, addedAt }`（只能引用藏书里的书）。

新增第三张表 **`booklist_wanted`（待找条目）**，向后兼容（旧表不动，旧版本应用看不到这张表、也不会报错）：

```ts
interface BooklistWantedRec {
  id: string          // 全局 UUID, 多端同步沿用
  booklistId: string
  title: string
  author: string
  isbn?: string       // 只存数字/X, 规范化成 ISBN-13 或 ISBN-10 原样
  year?: number       // 首次出版年, 负数为公元前
  note?: string
  originalTitle?: string   // 外文原名 (如「理想国」↔ The Republic), 参与匹配与「搜原名」
  originalAuthor?: string
  addedAt: number
}
```

- 桌面 SQLite：`booklist_wanted` 表；网页 IndexedDB：Dexie 版本 3 新增 `booklistWanted` 表。删除书单级联删除其待找条目。
- 书单在界面上 = 已在藏书的书（`booklist_items`）+ 待找条目，计数里分开显示。

### 自动关联（待找 → 藏书）

`library.refresh()`（导入、下载、同步之后都会调用）末尾跑一次纯函数 `planAutoLink(wanted, books)`：
待找条目匹配到藏书里的某本书（只看「藏书」类，不含论文）时，**把这本书加进该书单，并删除这条待找条目**。

匹配规则（`src/services/booklists.ts`）：
- 书名规范化：NFKC、小写、去书名号/标点/空白，去掉末尾括注（「红楼梦（程乙本）」→「红楼梦」）、副标题（`:` `;` `——` 之后）与文件扩展名；英文去掉开头的 The/A/An。
- 作者规范化：去掉朝代/国别括注（「[清] 曹雪芹」）、「著/编/译」等后缀，拆成词元；英文「Austen, Jane」与「Jane Austen」等价，忽略生卒年。
- 书名相同（或一方是另一方加副标题/卷次之前的部分）**且**作者相容（中文互相包含；拉丁文有一个长度 ≥ 3 的词元相同）。任一方缺作者时，只接受书名完全一致且足够长（中文 ≥ 2 字，其它 ≥ 4 字符）。
- 待找条目可带 `original`（外部导入书单里的外文原名，如「理想国」↔ *The Republic*）：原名也参与匹配，下载到的英文公版书能关联回中文条目。
- ISBN：藏书元数据里没有 ISBN，只用于条目之间去重（导入分享的书单时，同一 ISBN 或同名同作者的条目不重复添加）。

已知限制：关联是单向的；藏书里的书被删除后，书单不会把它恢复成待找条目。

## 从文件夹建立书单

藏书页选择或拖入文件夹时，确认框默认勾选「按文件夹建立书单」，可取消。
导入成功的书按所在目录加入书单，例如 `我的书/文学/中国`；根目录中的书加入 `我的书`。
书单名称保留完整路径，仍以现有书单列表展示，并非可展开的文件夹树。不同父目录下的同名子目录分别归类。
同名书单（忽略大小写）复用；导入失败、已存在而跳过、去重淘汰的文件不新建书单或关联。
空目录不创建书单。多目录拖入的散装文件不额外归类。当前选中的书单仍接收本次成功导入的全部书。
论文与私人书库上传没有此选项。Android/iOS 仍不提供文件夹选择入口；桌面导入的书单可按现有同步流程传到 App。

## 多端同步

同步文档新增可选集合 `booklistWanted`（见 `docs/sync.md`「记录与键」）：

| 集合 | 键 | 值 | 冲突规则 |
|---|---|---|---|
| booklistWanted（可选） | 待找条目 id | `{ booklistId, title, author, isbn?, year?, note?, originalTitle?, originalAuthor?, addedAt }` | LWW；删除为墓碑 |

- 规则与书单条目一致：有基线 diff、首次同步远端优先；所属书单此刻在本地才为缺失的条目生成墓碑；书单删除时由书单墓碑级联。
- 落地操作 `putWanted`（新增或改写，放在 `addBooklistItem` 同一阶段）、`deleteWanted`（放在删除阶段、`deleteBooklist` 之前）。
- 旧客户端读不到该字段，写自己的文档时也不会带上它；合并时新客户端的文档里仍有，所以不会丢。
- 自动关联在一台设备上完成后：该条目变成墓碑，同时多出一条书单条目（`booklistItems`）。另一台设备若还没有这本书的文件，条目暂时不显示，书落地后书单条目照常出现。

## 备份（藏书交换包）

`.okf.zip` 根目录新增 `booklists.json`（与 `reading-log.json` 并列，OKF 解析只看 `.md`，不受影响）：

```json
{ "format": "org.lightread.booklists", "version": 1,
  "lists": [{ "id", "name", "createdAt", "items": [{ "bookId", "addedAt" }], "wanted": [BooklistWantedRec] }] }
```

导入时 `bookId` 按恢复后的新 id 映射；同 id 的书单已存在则合并，否则同名书单合并，否则新建；待找条目按 id / 去重键幂等。

## 藏书页书单界面

- 选中书单时，待找条目以浅色卡片显示在书后面，带「找书」（跳到书源页并预填搜索）、「豆瓣查看」和移除；「添加待找的书」手动填书名/作者；「分享书单」「导入书单」。



本期不做服务端公开链接，分享走文件 / 文本：

- **书单文件 / 文本**（另一台轻阅可导入）：

```json
{ "format": "org.lightread.booklist", "version": 1, "name": "…", "description": "…",
  "exportedAt": "ISO 时间", "books": [{ "title", "author", "isbn?", "year?", "note?" }] }
```

  已在藏书的书也只导出书目信息（不含文件）。可以复制文本，也可以存成 `<书单名>.lightread-booklist.json`。
- **纯文本清单**（发到聊天里）：Markdown 编号列表「1. 《书名》— 作者（年份）」，附备注与「来自轻阅 LightRead」。
- **导入书单**：粘贴 JSON 文本 / 选择文件；也能粘贴上面的纯文本清单（按行解析「《书名》— 作者」）。预览后导入为新书单：藏书里能匹配上的直接关联，其余为待找条目；同名书单已存在时自动加序号。

### 后续：公开分享链接（未实现）

复用轻阅账号后端（`sync.jiangshu.ai`，Cloudflare Worker + D1）：
- `POST /v1/booklists`（需登录）上传上面的分享 JSON，返回短 id；`GET /v1/booklists/:id` 公开只读；`DELETE` 撤回。
- 网页端 `share` 路由渲染只读书单页，「在轻阅中打开」走现有导入流程。
- 需要内容审核与滥用限流（单账号数量/频率上限、举报下架），故本期不做。

## 假设

- 待找条目只在「藏书」书单里出现，论文页没有书单。
- 匹配到的藏书只限 `kind = book`；自动关联后待找条目的备注不保留（书单条目没有备注字段）。
