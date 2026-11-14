/**
 * Legado 规则解析引擎核心。
 *
 * 支持「阅读3.0」(Legado) 的规则语法，把书源规则字符串转换成实际数据：
 *  - CSS 选择器：Legado 特有语法 class.xxx / id.xxx / tag.xxx / text.xxx / @textNodes / @html
 *  - @json: JSONPath（$.xxx 形式）
 *  - @xpath: XPath（基于 DOMParser，浏览器原生 XPath 求值）
 *  - ## 正则替换清洗（##pattern##replacement##flags 多段）
 *  - {{}} 变量替换（{{key}} / {{$.path}} / {{java.timeFormat(...)}} 降级）
 *  - js: / @js: JavaScript 规则（宿主注入 DOM / result / 常用工具）
 *
 * 本模块刻意不依赖 Vue / Pinia / Tauri，便于在 Node 里用真实书源做回归测试。
 */

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** HTML 实体解码（&nbsp; 等） */
export function decodeEntities(s: string): string {
  const el = document.createElement('textarea')
  el.innerHTML = s
  return el.value
}

// ---------------------------------------------------------------------------
// 正则替换清洗（##pattern##replacement##flags）
// ---------------------------------------------------------------------------

/**
 * Legado 的 ## 正则替换语法：
 *   "正文##(第.{1,8}章)\\s*?(\\S*?)"  → 匹配并删除
 *   "text##pattern##replacement##flags" → 替换
 *   多段 ## 依次处理。
 *
 * 语法细节（对齐 Legado）：
 *   - 清洗规则 = "正则##替换串##标志" 的多组串联，每组之间也用 ## 分隔
 *   - "正则##" 表示删除匹配（替换串为空）
 *   - "正则##替换##" 表示替换；替换串支持 $1/$2 反向引用
 *   - 多组：正则1##替换1##正则2##替换2##
 */
export function applyReplaceRule(text: string, cleanRule: string | null | undefined): string {
  if (!cleanRule) return text
  let result = text
  // 按 ## 切分。Legado 的清洗规则里，正则本身可能含 ##（极少数），按惯例忽略。
  const segments = cleanRule.split('##')
  let i = 0
  while (i < segments.length) {
    const pattern = segments[i]
    if (!pattern) { i++; continue }
    let replacement = ''
    let flags = ''
    if (i + 1 < segments.length) replacement = segments[i + 1]
    if (i + 2 < segments.length) flags = segments[i + 2]
    // 标志里的合法正则标志（g/i/m/s/u），其他字符丢弃
    const validFlags = (flags.match(/[gimsuy]/g) ?? []).join('')
    try {
      const re = new RegExp(pattern, validFlags || 'g')
      result = result.replace(re, replacement)
      i += 3
    } catch {
      // 正则非法：跳过该段（不中断后续清洗）
      i += 1
    }
  }
  return result
}

/**
 * 分离规则字符串里的「取值规则」与「## 清洗规则」。
 * 例如 "tag.h1@textNodes&&id.content@tag.p@text##(第.{1,8}章)..."
 *  → { extractRule: "tag.h1@textNodes&&id.content@tag.p@text", cleanRule: "(第.{1,8}章)..." }
 */
export function splitCleanRule(rule: string): { extractRule: string; cleanRule: string | null } {
  const idx = rule.indexOf('##')
  if (idx < 0) return { extractRule: rule, cleanRule: null }
  return {
    extractRule: rule.slice(0, idx),
    cleanRule: rule.slice(idx + 2),
  }
}

// ---------------------------------------------------------------------------
// Legado CSS 选择器语法解析
// ---------------------------------------------------------------------------

/**
 * Legado 的 CSS 规则语法（非标准，需转换）：
 *   class.xxx        → .xxx
 *   id.xxx           → #xxx
 *   tag.a            → a
 *   text.xxx         → 取文本（用 :contains 或元素文本过滤）
 *   .0 / .1          → 第 N 个匹配（:nth-child 或索引）
 *   @tag.a           → 子元素 a（空格分隔，且 @ 表示「在已选元素内继续选」）
 *   @text            → 取元素文本
 *   @textNodes       → 取直接文本节点（含换行）
 *   @html            → 取 innerHTML
 *   @href / @src     → 取属性
 *   !0:1:2           → 排除第 0/1/2 个子元素
 *   @css:            → 前缀表示用标准 CSS 选择器
 *
 * 一条规则如 "class.odd.0@tag.a.0@text" 表示：
 *   选 .odd 的第 0 个 → 其下 a 的第 0 个 → 取其文本
 */
export interface CssRulePart {
  /** 选择器片段（转换后的标准 CSS） */
  selector: string
  /** 取值指令：text/textNodes/html/属性名/其他 */
  extract: string | null
  /** 索引（.N） */
  index: number | null
  /** 排除索引 !N */
  exclude: number[]
}

function parseLegadoCss(rule: string): CssRulePart[] {
  // 去掉 @css: 前缀（标准 CSS 直接当 selector 用）
  let s = rule.trim()
  const isStandardCss = s.startsWith('@css:')
  if (isStandardCss) s = s.slice(5)

  if (isStandardCss) {
    // 标准 CSS：整段是一个 selector，@ 后的部分作为 extract
    const atIdx = s.lastIndexOf('@')
    if (atIdx > 0) {
      return [{
        selector: s.slice(0, atIdx),
        extract: s.slice(atIdx + 1) || null,
        index: null,
        exclude: [],
      }]
    }
    return [{ selector: s, extract: null, index: null, exclude: [] }]
  }

  // Legado 特有语法：用 @ 分割为多个步骤
  const steps = s.split('@').filter(Boolean)
  const parts: CssRulePart[] = []

  for (let i = 0; i < steps.length; i++) {
    let step = steps[i].trim()
    if (!step) continue

    // 最后一步若是「取值指令」（text/textNodes/html/all 或属性名 href/src/alt/title 等），
    // 则作为 extract，不再当作选择器。
    // 判定：最后一步 && 是裸词（无 class./id./tag./text. 前缀、无 .N 索引、无 !N 排除）
    const isLast = i === steps.length - 1
    const isExtractDirective = isLast &&
      /^(text|textNodes|html|all|href|src|alt|title|value|content|class|id|data-[\w-]+)$/i.test(step)

    if (isExtractDirective) {
      if (parts.length > 0) {
        parts[parts.length - 1].extract = step
        break
      }
      // 前面没有选择器（如单独 "text"），返回空
      break
    }

    // 解析选择器片段：class.xxx / id.xxx / tag.xxx / text.xxx / .N / !N
    let selector = ''
    let index: number | null = null
    const exclude: number[] = []

    // 处理排除符 !N:M
    const bangMatch = step.match(/!([0-9:]+)$/)
    if (bangMatch) {
      exclude.push(...bangMatch[1].split(':').map(Number))
      step = step.slice(0, -bangMatch[0].length)
    }

    // 处理索引 .N（取最后一个 .数字）
    // 仅当 .数字 是一个「独立 token」时才当索引：
    //  - class.ch1 里 ch1 的 1 前面是 h，不是点，不受影响
    //  - text.123 这种纯数字文本匹配会被误判，需排除（.数字 前不是合法选择器前缀）
    const idxMatch = step.match(/\.(\d+)$/)
    if (idxMatch && !step.startsWith('text.')) {
      index = Number(idxMatch[1])
      step = step.slice(0, -idxMatch[0].length)
    }

    // class.xxx → .xxx
    if (step.startsWith('class.')) {
      selector = '.' + step.slice(6)
    } else if (step.startsWith('id.')) {
      selector = '#' + step.slice(3)
    } else if (step.startsWith('tag.')) {
      selector = step.slice(4)
    } else if (step.startsWith('text.')) {
      // text.xxx 表示文本匹配，Legado 中较少用，转成 :contains
      selector = `:contains("${step.slice(5)}")`
    } else if (step.startsWith('.')) {
      // 纯 .class 形式
      selector = step
    } else if (step.startsWith('#')) {
      selector = step
    } else {
      // 裸标签名
      selector = step
    }

    parts.push({ selector, extract: null, index, exclude })
  }

  return parts
}

/**
 * 在 DOM 中按 Legado CSS 规则取值。
 * @param doc 解析后的 Document
 * @param rule 规则字符串
 * @param scope 起始元素（可选）：规则从这个元素内部开始查找，而不是从 doc 全局
 * @returns 取到的值（字符串或字符串数组）
 */
export function queryByCssRule(doc: Document, rule: string, scope?: Element | null): string | string[] {
  const parts = parseLegadoCss(rule)
  if (parts.length === 0) return ''

  // 逐步执行：先选第一个 selector 的元素集合，再在其内部继续选
  let currentElements: Element[] = []

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const isLast = i === parts.length - 1

    if (i === 0) {
      // 第一步：从 scope（若提供）或 doc 全局选择
      const root: ParentNode = scope ?? doc
      currentElements = Array.from(root.querySelectorAll(part.selector))
    } else {
      // 后续步骤：在当前元素集合内部继续选择
      const next: Element[] = []
      for (const el of currentElements) {
        next.push(...Array.from(el.querySelectorAll(part.selector)))
      }
      currentElements = next
    }

    // 排除
    if (part.exclude.length > 0) {
      currentElements = currentElements.filter((_, idx) => !part.exclude.includes(idx))
    }

    // 索引（取第 N 个，0 基）
    if (part.index !== null && !isLast) {
      currentElements = part.index < currentElements.length ? [currentElements[part.index]] : []
    }

    // 最后一步：如果是取值指令，直接返回；否则取文本
    if (isLast) {
      if (part.index !== null) {
        // 最后一步的索引：取该索引元素的文本
        const el = currentElements[part.index]
        if (!el) return ''
        return part.extract ? extractValue(el, part.extract) : el.textContent?.trim() ?? ''
      }
      if (part.extract) {
        // 文本类指令（text/textNodes/html/all）取所有匹配元素拼接；
        // 属性类指令（href/src/alt 等）取第一个匹配元素
        const isTextDirective = /^(text|textNodes|html|all)$/i.test(part.extract)
        if (isTextDirective) {
          const values = currentElements.map(el => extractValue(el, part.extract!))
          return values.join('')
        }
        const el = currentElements[0]
        return el ? extractValue(el, part.extract!) : ''
      }
      // 无取值指令：取第一个元素的文本
      return currentElements[0]?.textContent?.trim() ?? ''
    }
  }

  return ''
}

function extractValue(el: Element, directive: string): string {
  switch (directive) {
    case 'text':
      return el.textContent?.trim() ?? ''
    case 'textNodes':
      // 直接文本节点（含换行），用于正文抓取。nodeType 3 = 文本节点（避免依赖全局 Node）
      return Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent ?? '')
        .join('\n')
        .trim()
    case 'html':
    case 'all':
      return el.innerHTML
    case 'href':
      return el.getAttribute('href') ?? ''
    case 'src':
      return el.getAttribute('src') ?? ''
    case 'alt':
      return el.getAttribute('alt') ?? ''
    case 'title':
      return el.getAttribute('title') ?? ''
    case 'value':
      return (el as HTMLInputElement).value ?? ''
    default:
      // 自定义属性名
      return el.getAttribute(directive) ?? ''
  }
}

// ---------------------------------------------------------------------------
// XPath 支持
// ---------------------------------------------------------------------------

/**
 * 用 XPath 在 Document 上求值。
 * 浏览器原生支持 XPath（document.evaluate），但需要 XHTML 命名空间处理。
 */
export function queryByXPath(doc: Document, xpath: string): string {
  try {
    // 尝试标准 XPath
    const result = doc.evaluate(xpath, doc, null, XPathResult.STRING_TYPE, null)
    return result.stringValue.trim()
  } catch {
    // XHTML 命名空间场景：给元素加默认命名空间
    try {
      const resolver = (prefix: string) =>
        prefix === 'x' ? 'http://www.w3.org/1999/xhtml' : null
      const result = doc.evaluate(xpath, doc, resolver as XPathNSResolver, XPathResult.STRING_TYPE, null)
      return result.stringValue.trim()
    } catch {
      return ''
    }
  }
}

// ---------------------------------------------------------------------------
// JSONPath 支持（$.xxx / $.xxx[*].yyy）
// ---------------------------------------------------------------------------

/**
 * 简化 JSONPath 求值，覆盖 Legado 常用语法：
 *   $.name / $.list[0].title / $.list[*].title / $.a.b
 * 返回原始值（字符串/数字/数组等）。
 */
export function queryByJsonPath(obj: unknown, path: string): unknown {
  if (path == null || path === '') return obj
  let s = path.trim()
  if (s.startsWith('$.')) s = s.slice(2)
  else if (s.startsWith('$')) s = s.slice(1)
  if (!s) return obj

  const tokens: Array<string | number> = []
  // 按 . 分割，但保留方括号
  const parts = s.split('.')
  for (const p of parts) {
    if (!p) continue
    // 处理 [0] / [*] / ['key'] 后缀
    const bracketMatch = p.match(/^(.+?)((?:\[[^\]]*\])+)$/)
    if (bracketMatch) {
      tokens.push(bracketMatch[1])
      const brackets = bracketMatch[2].match(/\[[^\]]*\]/g) ?? []
      for (const b of brackets) {
        const inner = b.slice(1, -1).trim()
        if (inner === '*') tokens.push('*')
        else if (/^\d+$/.test(inner)) tokens.push(Number(inner))
        else tokens.push(inner.replace(/^['"]|['"]$/g, ''))
      }
    } else {
      tokens.push(p)
    }
  }

  let current: unknown = obj
  for (const token of tokens) {
    if (current == null) return undefined
    if (token === '*') {
      // 通配：返回数组所有元素
      if (Array.isArray(current)) return current
      return undefined
    }
    if (Array.isArray(current)) {
      const idx = typeof token === 'number' ? token : -1
      if (idx >= 0) current = current[idx]
      else return undefined
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[String(token)]
    } else {
      return undefined
    }
  }
  return current
}

// ---------------------------------------------------------------------------
// 变量替换 {{key}} / {{$.path}} / {{java.xxx}}
// ---------------------------------------------------------------------------

/**
 * 替换规则字符串里的 {{}} 变量。
 * 支持：
 *   {{key}}          → 搜索关键词
 *   {{page}}         → 页码
 *   {{$.path}}       → 上一级解析结果的字段
 *   {{java.timeFormat(...)}} → Java 时间格式化（降级为 JS 实现）
 *   {{java.getString(...)}}  → 取字符串
 *   {{'\n'}}         → JS 字面量
 */
export function replaceVariables(
  template: string,
  ctx: { key?: string; page?: number; vars?: Record<string, unknown> },
): string {
  if (!template) return template
  const vars = ctx.vars ?? {}
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (_m, inner: string) => {
    const expr = inner.trim()
    // 简单变量
    if (expr === 'key') return ctx.key ?? ''
    if (expr === 'page') return String(ctx.page ?? 1)
    // $.path
    if (expr.startsWith('$')) {
      const v = queryByJsonPath(vars, expr)
      return v == null ? '' : String(v)
    }
    // java.xxx 降级
    if (expr.startsWith('java.')) {
      return evalJavaExpr(expr, vars)
    }
    // 直接变量名
    if (expr in vars) {
      const v = vars[expr]
      return v == null ? '' : String(v)
    }
    // JS 字面量（如 'xxx'、数字）
    try {
      const fn = new Function('return (' + expr + ')')
      const v = fn()
      return v == null ? '' : String(v)
    } catch {
      return ''
    }
  })
}

/** Java API 降级实现 */
function evalJavaExpr(expr: string, vars: Record<string, unknown>): string {
  // java.timeFormat(timestamp) / java.timeFormat(timestamp, pattern)
  const timeFormatMatch = expr.match(/^java\.timeFormat\((.*)\)$/)
  if (timeFormatMatch) {
    // 参数可能嵌套 java.getString('$.x')*1000 之类，逐级求值
    const rawArgs = splitArgs(timeFormatMatch[1])
    const ts = evalInnerExpr(rawArgs[0], vars)
    const ms = typeof ts === 'number' ? ts : Number(ts)
    if (!Number.isFinite(ms)) return ''
    const d = new Date(ms < 1e12 ? ms * 1000 : ms)
    const pattern = rawArgs[1] != null ? String(evalInnerExpr(rawArgs[1], vars)).replace(/['"]/g, '') : 'yyyy-MM-dd'
    return formatJavaDate(d, pattern)
  }
  // java.getString(x)
  const getStringMatch = expr.match(/^java\.getString\((.*)\)$/)
  if (getStringMatch) {
    const arg = getStringMatch[1].trim()
    // getString('$.path')：参数是字符串字面量时，其内容是 path，需按 path 取值
    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      const innerPath = arg.slice(1, -1)
      if (innerPath.startsWith('$')) {
        const v = queryByJsonPath(vars, innerPath)
        return v == null ? '' : String(v)
      }
      return innerPath
    }
    const v = evalInnerExpr(arg, vars)
    return v == null ? '' : String(v)
  }
  // 其他 java.* 不支持，返回空
  return ''
}

/** 按顶层逗号切分参数（忽略括号/引号内的逗号） */
function splitArgs(s: string): string[] {
  const args: string[] = []
  let depth = 0
  let cur = ''
  let inStr: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      cur += c
      if (c === inStr && s[i - 1] !== '\\') inStr = null
      continue
    }
    if (c === '"' || c === "'") { inStr = c; cur += c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    if (c === ')' || c === ']' || c === '}') depth--
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) args.push(cur.trim())
  return args
}

/** 求值单个表达式：支持 $.path、java.getString(...)、字符串字面量、数字、算术 */
function evalInnerExpr(expr: string, vars: Record<string, unknown>): unknown {
  const s = expr.trim()
  if (!s) return ''
  // 纯 $.path
  if (/^\$\.[\w.\[\]*'"]+$/.test(s)) return queryByJsonPath(vars, s)
  // 含 java.getString(...) 嵌套：先替换成值，再继续求值（可能是算术表达式）
  if (s.includes('java.getString')) {
    const substituted = s.replace(/java\.getString\(([^()]*)\)/g, (_m, inner) => {
      const raw = inner.trim()
      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        const p = raw.slice(1, -1)
        if (p.startsWith('$')) {
          const v = queryByJsonPath(vars, p)
          return v == null ? '0' : JSON.stringify(v)
        }
        return JSON.stringify(p)
      }
      const v = evalInnerExpr(raw, vars)
      return v == null ? '0' : JSON.stringify(v)
    })
    // 替换后再整体求值（可能含算术）
    try { return new Function('return (' + substituted + ')')() } catch { return substituted }
  }
  // 含 $.path 的算术表达式（如 $.update_time*1000）：先替换再算
  if (s.includes('$.')) {
    // 匹配 $.xxx.yyy 或 $.list[0].title，其中 * 仅在 [*] 内合法，
    // 避免把算术里的乘号 * 误当成 path 的一部分
    const substituted = s.replace(/\$[A-Za-z_][\w]*(\.[A-Za-z_][\w]*|\[\d+\]|\[\*\]|\[['"][\w]+['"]\])*/g, m => {
      const v = queryByJsonPath(vars, m)
      return v == null ? '0' : JSON.stringify(v)
    })
    try { return new Function('return (' + substituted + ')')() } catch { return s }
  }
  // 字符串字面量
  if (s.startsWith('"') || s.startsWith("'")) {
    try { return new Function('return ' + s)() } catch { return s.replace(/['"]/g, '') }
  }
  // 数字或算术
  const n = Number(s)
  if (!Number.isNaN(n)) return n
  // 纯变量名
  if (s in vars) return vars[s]
  return s
}

/** Java SimpleDateFormat 模式的简化实现 */
function formatJavaDate(d: Date, pattern: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const y = d.getFullYear()
  const M = d.getMonth() + 1
  const day = d.getDate()
  const h = d.getHours()
  const m = d.getMinutes()
  const sec = d.getSeconds()
  return pattern
    .replace(/yyyy/g, String(y))
    .replace(/MM/g, pad(M))
    .replace(/dd/g, pad(day))
    .replace(/HH/g, pad(h))
    .replace(/mm/g, pad(m))
    .replace(/ss/g, pad(sec))
    .replace(/M/g, String(M))
    .replace(/d/g, String(day))
}

// ---------------------------------------------------------------------------
// JS 规则执行
// ---------------------------------------------------------------------------

/**
 * 执行 js: / @js: 规则脚本。
 *
 * Legado 的 JS 规则分两类：
 *  - 内联 js:xxx：把 result 当作输入，脚本最后一句作为返回值（或返回 result）
 *  - @js: 块：多行脚本，可能定义函数、import Java 包等
 *
 * 宿主注入的全局变量：
 *  - result：当前待处理的值（字符串或对象）
 *  - java：Java 桥（降级实现常用方法）
 *  - baseUrl：当前请求的基准 URL
 *  - bookSource：当前书源
 *
 * 返回值：脚本返回值（字符串或对象）。
 */
export function runJsRule(
  script: string,
  ctx: {
    result?: unknown
    baseUrl?: string
    vars?: Record<string, unknown>
    bookSource?: unknown
  } = {},
): unknown {
  let code = script.trim()
  // 去掉 js: / @js: 前缀
  if (code.startsWith('js:')) code = code.slice(3)
  else if (code.startsWith('@js:')) code = code.slice(4)
  // 去掉 <js>...</js> 包裹
  if (code.startsWith('<js>') && code.endsWith('</js>')) code = code.slice(4, -5)

  if (!code) return ctx.result ?? ''

  // 构建降级的 java 桥
  const java = {
    timeFormat: (ts: unknown, pattern?: string) => {
      const ms = typeof ts === 'number' ? ts : Number(ts)
      if (!Number.isFinite(ms)) return ''
      const d = new Date(ms < 1e12 ? ms * 1000 : ms)
      return formatJavaDate(d, pattern ?? 'yyyy-MM-dd')
    },
    getString: (v: unknown) => (v == null ? '' : String(v)),
    // importPackage 等无法在纯 JS 实现，返回空对象，脚本若依赖会报错（外部捕获）
    importPackage: () => {},
  }

  try {
    // Legado 的 JS 规则语义：脚本以 result 为输入执行，返回值是「最后一条表达式的值」。
    // 书源脚本常写裸表达式（如 result.replace(...) 或 result.toUpperCase()），
    // 也常写 var/if/for 多语句，末尾可能是表达式。
    //
    // 稳妥做法：把脚本最后一条「表达式语句」提取出来，包成 return。
    // 具体：把脚本按行处理，若最后一条语句不是 return/var/if/for/while/let/const
    // 等声明或控制流，就把它作为返回值。这里用「把整个 body 放进函数，
    // 末尾自动 return 最后一条表达式」的方式。
    const lines = code.split('\n')
    // 找到最后一条非空、非纯注释的语句
    let lastStmtIdx = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim()
      if (t && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*')) {
        lastStmtIdx = i
        break
      }
    }
    const lastStmt = lastStmtIdx >= 0 ? lines[lastStmtIdx].trim() : ''

    const isReturnLike = /^(return|var|let|const|if|for|while|function|switch|try|throw|})\s*/.test(lastStmt)
    // 若最后一条是「表达式语句」（不是 return/声明/控制流），自动加 return
    let body = code
    if (lastStmt && !isReturnLike) {
      const indent = lines[lastStmtIdx].match(/^\s*/)?.[0] ?? ''
      lines[lastStmtIdx] = `${indent}return ${lastStmt}`
      body = lines.join('\n')
    }

    const fn = new Function(
      'result',
      'java',
      'baseUrl',
      'bookSource',
      body,
    )
    const ret = fn(ctx.result ?? '', java, ctx.baseUrl ?? '', ctx.bookSource)
    return ret !== undefined ? ret : ctx.result ?? ''
  } catch (err) {
    // 脚本执行失败：返回原始 result（不中断链路，但记录）
    console.warn('[legado] JS 规则执行失败:', err, '\n脚本:', code.slice(0, 200))
    return ctx.result ?? ''
  }
}

// ---------------------------------------------------------------------------
// 规则分发入口
// ---------------------------------------------------------------------------

/**
 * 统一的规则求值入口：根据规则前缀分发到对应的解析器。
 *
 * 支持 Legado 的组合语法：
 *  - && 连接符：多个取文本规则的结果拼接（如 tag.h1@textNodes&&id.content@tag.p@text）
 *  - || 连接符：取第一个非空结果
 *  - ## 正则替换清洗：作用于整条规则最终结果
 *
 * @param rule 规则字符串
 * @param doc HTML Document（CSS/XPath 用）
 * @param jsonObj JSON 对象（@json: 用）
 * @param ctx 运行时上下文
 */
export function evaluateRule(
  rule: string | null | undefined,
  doc: Document | null,
  jsonObj: unknown,
  ctx: {
    key?: string
    page?: number
    vars?: Record<string, unknown>
    result?: unknown
    baseUrl?: string
    bookSource?: unknown
    host?: string
  } = {},
): unknown {
  if (!rule) return null
  const r = rule.trim()
  if (!r) return null

  const vars = ctx.vars ?? {}
  const mergedVars: Record<string, unknown> = { ...vars }
  if (ctx.result != null) mergedVars['result'] = ctx.result
  if (ctx.host) mergedVars['ho'] = ctx.host
  if (ctx.key != null) mergedVars['key'] = ctx.key

  // 先做变量替换（{{}}），让后续解析拿到完整规则
  const resolved = replaceVariables(r, { key: ctx.key, page: ctx.page, vars: mergedVars })

  // 拆分 || 连接符（取第一个非空）
  const orParts = splitTopLevel(resolved, '||')
  if (orParts.length > 1) {
    for (const part of orParts) {
      const v = evaluateRule(part, doc, jsonObj, ctx)
      if (v != null && v !== '') return v
    }
    return null
  }

  // 拆分 && 连接符（结果拼接）
  const andParts = splitTopLevel(resolved, '&&')
  if (andParts.length > 1) {
    const results = andParts.map(part => evaluateSingleRule(part, doc, jsonObj, ctx))
    // 全部为 null 时返回 null；否则拼接字符串
    const valid = results.filter(v => v != null)
    if (valid.length === 0) return null
    return valid.map(v => String(v)).join('')
  }

  return evaluateSingleRule(resolved, doc, jsonObj, ctx)
}

/** 按顶层连接符切分（忽略正则/引号内的连接符） */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = []
  let cur = ''
  let depth = 0
  let inStr: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      cur += c
      if (c === inStr && s[i - 1] !== '\\') inStr = null
      continue
    }
    if (c === '"' || c === "'") { inStr = c; cur += c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    if (c === ')' || c === ']' || c === '}') depth--
    if (c === sep[0] && s[i + 1] === sep[1] && depth === 0) {
      parts.push(cur)
      cur = ''
      i++
      continue
    }
    cur += c
  }
  if (cur) parts.push(cur)
  return parts
}

/** 求值单条规则（不含 && / || 连接符） */
function evaluateSingleRule(
  r: string,
  doc: Document | null,
  jsonObj: unknown,
  ctx: {
    key?: string
    page?: number
    vars?: Record<string, unknown>
    result?: unknown
    baseUrl?: string
    bookSource?: unknown
    host?: string
  },
): unknown {
  const vars = ctx.vars ?? {}
  const mergedVars: Record<string, unknown> = { ...vars }
  if (ctx.result != null) mergedVars['result'] = ctx.result
  if (ctx.host) mergedVars['ho'] = ctx.host
  if (ctx.key != null) mergedVars['key'] = ctx.key

  const rule = r.trim()

  // 分离「取值规则」与「## 清洗规则」
  const { extractRule, cleanRule } = splitCleanRule(rule)

  // @json: JSONPath
  if (extractRule.startsWith('@json:') || extractRule.startsWith('@JSON:')) {
    const path = extractRule.replace(/^@json:/i, '')
    const v = queryByJsonPath(jsonObj, path)
    return cleanRule && typeof v === 'string' ? applyReplaceRule(v, cleanRule) : v
  }
  // 裸 JSONPath（$.xxx）：部分 JSON 书源省略 @json: 前缀，直接写 $.title / $.author 等。
  // 优先对当前 result（通常是 bookList 里取出的单个 JSON 对象）取值，
  // 取不到再回退到顶层 jsonObj。
  if (extractRule.startsWith('$')) {
    let v = ctx.result != null && typeof ctx.result === 'object' && !(typeof (ctx.result as any).querySelectorAll === 'function')
      ? queryByJsonPath(ctx.result, extractRule)
      : undefined
    if (v === undefined) v = queryByJsonPath(jsonObj, extractRule)
    if (v !== undefined) {
      return cleanRule && typeof v === 'string' ? applyReplaceRule(v, cleanRule) : v
    }
  }
  // @xpath: XPath
  if (extractRule.startsWith('@xpath:') || extractRule.startsWith('@XPath:') || extractRule.startsWith('@XPATH:')) {
    if (!doc) return null
    const v = queryByXPath(doc, extractRule.replace(/^@xpath:/i, ''))
    return cleanRule ? applyReplaceRule(v, cleanRule) : v
  }
  // js: / @js:
  if (extractRule.startsWith('js:') || extractRule.startsWith('@js:') || extractRule.startsWith('<js>')) {
    const v = runJsRule(extractRule, {
      result: ctx.result,
      baseUrl: ctx.baseUrl,
      vars: mergedVars,
      bookSource: ctx.bookSource,
    })
    return cleanRule && typeof v === 'string' ? applyReplaceRule(v, cleanRule) : v
  }

  // CSS 规则（@css: / class. / id. / tag. / text. / . / # 开头，或含 @ 取指令）
  // 也处理纯属性取值（如 "href"、"text"、"a@href" 之类）
  const isCssLike = extractRule.startsWith('@css:') ||
    /^(class\.|id\.|tag\.|text\.)/.test(extractRule) ||
    /^[.#]/.test(extractRule) ||
    /@/.test(extractRule)

  const scopeEl = (ctx.result && typeof ctx.result === 'object' && typeof (ctx.result as any).querySelectorAll === 'function')
    ? ctx.result as Element
    : null

  // 裸取值指令：text / href / src / html 等，直接对 result 元素取值
  const isBareDirective = /^(text|textNodes|html|all|href|src|alt|title|value|content)$/i.test(extractRule)
  if (isBareDirective && scopeEl) {
    let v: string
    switch (extractRule.toLowerCase()) {
      case 'text': v = scopeEl.textContent?.trim() ?? ''; break
      case 'textnodes': {
        v = Array.from(scopeEl.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('\n').trim()
        break
      }
      case 'html':
      case 'all': v = scopeEl.innerHTML; break
      case 'href': v = scopeEl.getAttribute('href') ?? ''; break
      case 'src': v = scopeEl.getAttribute('src') ?? ''; break
      case 'alt': v = scopeEl.getAttribute('alt') ?? ''; break
      case 'title': v = scopeEl.getAttribute('title') ?? ''; break
      case 'value': v = (scopeEl as any).value ?? ''; break
      case 'content': v = scopeEl.getAttribute('content') ?? ''; break
      default: v = scopeEl.textContent?.trim() ?? ''
    }
    return cleanRule ? applyReplaceRule(v, cleanRule) : v
  }

  let value: unknown = null
  if (isCssLike && doc) {
    value = queryByCssRule(doc, extractRule, scopeEl)
  } else {
    // 纯文本规则：可能是变量替换后的 URL、正则替换串等
    value = extractRule
  }

  // ## 正则替换清洗：作用于最终值
  if (cleanRule && typeof value === 'string') {
    value = applyReplaceRule(value, cleanRule)
  }

  return value
}

/**
 * 解析 HTML 文本为 Document。
 */
export function parseHtml(html: string): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return doc
}
