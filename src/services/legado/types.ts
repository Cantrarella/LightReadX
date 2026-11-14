/**
 * Legado 书源类型定义。
 *
 * 兼容「阅读3.0」(Legado) 的标准 JSON 书源格式。字段与 hadc188/reader 及
 * 手机版 Legado 保持一致，便于导入通用书源文件（单个 / 批量数组 / 远程订阅）。
 */

/** 搜索规则组（ruleSearch） */
export interface SearchRule {
  /** 关键词校验（如登录墙检测） */
  checkKeyWord?: string | null
  /** 结果列表元素选择器 */
  bookList: string | null
  name?: string | null
  author?: string | null
  intro?: string | null
  kind?: string | null
  lastChapter?: string | null
  updateTime?: string | null
  bookUrl: string | null
  coverUrl?: string | null
  wordCount?: string | null
}

/** 书籍详情规则组（ruleBookInfo） */
export interface BookInfoRule {
  init?: string | null
  name?: string | null
  author?: string | null
  intro?: string | null
  kind?: string | null
  lastChapter?: string | null
  updateTime?: string | null
  coverUrl?: string | null
  wordCount?: string | null
  tocUrl?: string | null
  canReName?: string | null
  downloadUrls?: string | null
}

/** 目录规则组（ruleToc） */
export interface TocRule {
  preUpdateJs?: string | null
  init?: string | null
  chapterList: string | null
  chapterName: string | null
  chapterUrl: string | null
  formatJs?: string | null
  isVolume?: string | null
  isVip?: string | null
  isPay?: string | null
  updateTime?: string | null
  nextTocUrl?: string | null
}

/** 正文规则组（ruleContent） */
export interface ContentRule {
  content: string | null
  title?: string | null
  nextContentUrl?: string | null
  webJs?: string | null
  sourceRegex?: string | null
  replaceRegex?: string | null
  imageStyle?: string | null
  imageDecode?: string | null
  payAction?: string | null
}

/** 完整书源对象（Legado 标准格式，仅保留搜索/阅读所需字段） */
export interface BookSource {
  bookSourceUrl: string
  bookSourceName: string
  bookSourceGroup?: string | null
  bookSourceType?: number
  customOrder?: number
  enabled?: boolean
  /** 请求头（JSON 字符串） */
  header?: string | null
  lastUpdateTime?: number
  weight?: number
  /** 搜索 URL，支持 {{key}} 关键词、{{page}} 页码 */
  searchUrl?: string | null
  ruleSearch?: SearchRule
  ruleBookInfo?: BookInfoRule
  ruleToc?: TocRule
  ruleContent?: ContentRule
}

/** 搜索结果条目 */
export interface SearchResultBook {
  name: string
  author: string
  bookUrl: string
  coverUrl?: string
  intro?: string
  kind?: string
  lastChapter?: string
  wordCount?: string
  /** 来源书源名 */
  origin: string
  /** 来源书源对象（换源用） */
  source?: BookSource
}

/** 同一本书的多个来源（换源用） */
export interface BookSourceEntry {
  /** 书源名 */
  sourceName: string
  /** 书源对象 */
  source: BookSource
  /** 该书在此源的地址 */
  bookUrl: string
  /** 该源上的简介/封面等（可选） */
  intro?: string
  coverUrl?: string
  lastChapter?: string
}

/** 合并后的搜索结果：一本书 + 它在各书源的入口（换源） */
export interface MergedSearchBook {
  name: string
  author: string
  /** 各书源入口（至少一个） */
  sources: BookSourceEntry[]
  /** 首选入口（第一个源） */
  primary: BookSourceEntry
}

/** 书籍详情 */
export interface BookInfo {
  name: string
  author: string
  intro?: string
  kind?: string
  coverUrl?: string
  tocUrl?: string
  lastChapter?: string
  wordCount?: string
}

/** 章节条目 */
export interface ChapterItem {
  name: string
  url: string
  /** 卷名（分卷书源） */
  volume?: string
  isVip?: boolean
  isPay?: boolean
}

/** 解析后的正文 */
export interface ChapterContent {
  /** 清洗后的正文文本 */
  text: string
  /** 下一页正文 URL；完整抓取时若仍存在，表示正文尚未抓完 */
  nextUrl?: string
}

/** 书源规则执行时的运行时变量 */
export interface RuleContext {
  /** 当前结果（searchUrl/bookUrl 抓取的原始响应） */
  baseUrl: string
  /** 搜索关键词 */
  key?: string
  /** 页码 */
  page?: number
  /** 上一级解析出的对象（详情页传给目录、目录传给正文） */
  result?: unknown
  /** 各步骤产物（$ 开头的变量由引擎注入） */
  vars: Record<string, unknown>
}
