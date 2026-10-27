/**
 * 登录态解析与校验：纯逻辑，不做任何 IO。
 *
 * 为什么单独成文件：设置页的「导入登录态」会把用户从别处复制来的 token / cookie
 * 交给宿主，这段解析必须能被离线回归直接调用——不能藏在 HTTP handler 或
 * Playwright 页面里。校验规则也只有一份，避免「设置页放行、通道拒绝」。
 *
 * 安全约定：
 * - 解析失败一律返回 `{ error }`，不抛异常（调用方是 HTTP handler，一个坏输入
 *   不该把插件主流程拖崩）；
 * - 日志只能使用 {@link redactSecret}，不得输出完整 token。
 *
 * @module dsh-deepseek-web/login-state
 */

/** Playwright `addCookies` 需要的 cookie 形态（只保留会用到的字段）。 */
export interface NormalizedCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/** 解析后的登录态：token 与 cookies 至少有一个。 */
export interface LoginBundle {
  token?: string
  cookies?: NormalizedCookie[]
}

/** 解析结果；失败时只有 `error`。 */
export interface LoginBundleParseResult extends LoginBundle {
  error?: string
}

/** 原始粘贴内容上限（64 KiB）：正常登录态远小于这个量级。 */
export const MAX_RAW_CHARS = 64 * 1024

/** 单个 token 上限（8 KiB）：JWT / base64 长串都够用。 */
export const MAX_TOKEN_CHARS = 8 * 1024

/** cookie 条数上限：防误贴整份浏览器导出文件。 */
export const MAX_COOKIES = 100

/** token 最短长度：低于这个值基本是误贴（与 design.md 的 20 字符下限对齐）。 */
const MIN_TOKEN_CHARS = 20

/**
 * token 允许的字符集：JWT 的 `.`、base64 的 `+/=`、URL-safe 的 `-/_`、hex。
 * 不允许空白与控制字符——它们只可能来自复制时的换行/空格污染。
 */
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/

/** 未提供 URL 时的默认站点（cookie 的 domain/path 从它推导）。 */
export const DEFAULT_LOGIN_URL = 'https://chat.deepseek.com'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 把用户粘贴的 token 归一化成纯字符串。
 *
 * 支持三种常见形态：
 * - 纯 token（从 devtools 复制 `localStorage.userToken` 的 value）；
 * - `{"value":"..."}`（把 localStorage 原值整段复制过来）；
 * - `{"userToken":"..."}` / `{"token":"..."}`（本插件导出的 JSON 片段）。
 *
 * @returns 合法 token；不合法时返回 `undefined`（调用方负责给出人话错误）。
 */
export function normalizeUserToken(input: string): string | undefined {
  const trimmed = input.trim()
  if (trimmed === '') return undefined

  let candidate = trimmed
  if (trimmed.startsWith('{') || trimmed.startsWith('"')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return undefined
    }
    if (typeof parsed === 'string') {
      candidate = parsed.trim()
    } else {
      const record = asRecord(parsed)
      if (record === undefined) return undefined
      const value = nonEmptyString(record.value)
        ?? nonEmptyString(record.userToken)
        ?? nonEmptyString(record.token)
      if (value === undefined) return undefined
      candidate = value
    }
  }

  if (candidate.length < MIN_TOKEN_CHARS || candidate.length > MAX_TOKEN_CHARS) return undefined
  if (/\s/.test(candidate)) return undefined
  if (!TOKEN_PATTERN.test(candidate)) return undefined
  return candidate
}

function normalizeSameSite(value: unknown): 'Strict' | 'Lax' | 'None' | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  switch (value.trim().toLowerCase()) {
    case 'strict': return 'Strict'
    case 'lax': return 'Lax'
    case 'none': return 'None'
    default: return null
  }
}

function normalizeCookie(item: unknown, index: number, fallbackUrl: string): NormalizedCookie | { error: string } {
  const record = asRecord(item)
  if (record === undefined) return { error: `第 ${index + 1} 条 cookie 不是对象` }

  const name = nonEmptyString(record.name)
  const value = typeof record.value === 'string' ? record.value : undefined
  if (name === undefined) return { error: `第 ${index + 1} 条 cookie 缺少 name` }
  if (/[\s;,]/.test(name)) return { error: `第 ${index + 1} 条 cookie 的 name 含非法字符` }
  if (value === undefined) return { error: `第 ${index + 1} 条 cookie 缺少 value` }
  if (value.length > 4_096) return { error: `第 ${index + 1} 条 cookie 的 value 过长` }

  let domain = nonEmptyString(record.domain)
  let path = nonEmptyString(record.path) ?? '/'
  let secure = record.secure === true
  if (domain === undefined) {
    const url = nonEmptyString(record.url)
    if (url !== undefined) {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { error: `第 ${index + 1} 条 cookie 的 url 不合法` }
      }
      domain = parsed.hostname
      path = parsed.pathname === '' ? '/' : parsed.pathname
      secure = secure || parsed.protocol === 'https:'
    } else {
      // 没有 domain/url 时用默认站点兜底，避免 Playwright 直接抛 "cookie has no domain"。
      try {
        domain = new URL(fallbackUrl).hostname
      } catch {
        return { error: `第 ${index + 1} 条 cookie 缺少 domain` }
      }
    }
  }

  if (domain === '') return { error: `第 ${index + 1} 条 cookie 的 domain 为空` }
  if (/[\s;,]/.test(domain)) return { error: `第 ${index + 1} 条 cookie 的 domain 不合法` }

  const sameSite = normalizeSameSite(record.sameSite)
  if (sameSite === null) return { error: `第 ${index + 1} 条 cookie 的 sameSite 只能是 Strict / Lax / None` }

  let expires: number | undefined
  if (record.expires !== undefined) {
    const raw = record.expires
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { error: `第 ${index + 1} 条 cookie 的 expires 不是数字` }
    }
    // Playwright 用 -1 表示会话 cookie；其它负数一律视为非法。
    if (raw < 0 && raw !== -1) return { error: `第 ${index + 1} 条 cookie 的 expires 不合法` }
    expires = raw
  }

  return {
    name,
    value,
    domain,
    path,
    ...(expires !== undefined ? { expires } : {}),
    ...(record.httpOnly === true ? { httpOnly: true } : {}),
    ...(secure ? { secure: true } : {}),
    ...(sameSite !== undefined ? { sameSite } : {}),
  }
}

/**
 * 校验并归一化 cookie 数组。
 *
 * 只接受 Playwright 形态的数组（`[{name,value,domain,...}]`）。`document.cookie`
 * 那种 `k=v; k2=v2` 字符串**故意不支持**：httpOnly cookie 根本读不到，半套 cookie
 * 反而会让人误以为已经恢复登录态。
 */
export function normalizeCookieList(
  input: unknown,
  fallbackUrl: string = DEFAULT_LOGIN_URL,
): NormalizedCookie[] | { error: string } {
  if (!Array.isArray(input)) return { error: 'cookies 必须是数组' }
  if (input.length === 0) return { error: 'cookies 数组为空' }
  if (input.length > MAX_COOKIES) return { error: `cookies 超过上限（最多 ${MAX_COOKIES} 条）` }

  const cookies: NormalizedCookie[] = []
  for (const [index, item] of input.entries()) {
    const normalized = normalizeCookie(item, index, fallbackUrl)
    if ('error' in normalized) return { error: normalized.error }
    cookies.push(normalized)
  }
  return cookies
}

/**
 * 解析设置页粘贴的整段登录态。
 *
 * 支持：
 * - 纯 token；
 * - `{"value":"..."}`（localStorage 原样）；
 * - `{"userToken":"...","cookies":[...]}`（本插件导出格式）；
 * - 直接的 cookies 数组（`[{name,value,...}]`）。
 */
export function parseLoginBundle(raw: string): LoginBundleParseResult {
  const text = raw.trim()
  if (text === '') return { error: '没有收到登录态内容' }
  if (text.length > MAX_RAW_CHARS) return { error: `登录态内容超过上限（${MAX_RAW_CHARS} 字符）` }

  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { error: 'JSON 格式不正确，请检查粘贴内容是否完整' }
    }
    if (Array.isArray(parsed)) {
      const cookies = normalizeCookieList(parsed)
      if ('error' in cookies) return { error: cookies.error }
      return { cookies }
    }
    const record = asRecord(parsed)
    if (record === undefined) return { error: 'JSON 必须是对象或数组' }

    const tokenRaw = nonEmptyString(record.userToken)
      ?? nonEmptyString(record.token)
      ?? nonEmptyString(record.value)
    const token = tokenRaw === undefined ? undefined : normalizeUserToken(tokenRaw)
    let cookies: NormalizedCookie[] | undefined
    if (record.cookies !== undefined) {
      const normalized = normalizeCookieList(record.cookies)
      if ('error' in normalized) return { error: normalized.error }
      cookies = normalized
    }
    if (token === undefined && cookies === undefined) {
      return { error: '没有找到可用的 userToken 或 cookies' }
    }
    return {
      ...(token !== undefined ? { token } : {}),
      ...(cookies !== undefined ? { cookies } : {}),
    }
  }

  const token = normalizeUserToken(text)
  if (token === undefined) {
    return { error: '看起来不是有效的 userToken（应为不含空白的 20–8192 字符）' }
  }
  return { token }
}

/**
 * 日志用的脱敏：只保留首尾各 4 个字符。
 *
 * 任何可能被写进日志/错误信息的地方都必须经过它，禁止直接拼接 token。
 */
export function redactSecret(token: string): string {
  const value = token.trim()
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}
