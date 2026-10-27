/**
 * 提示系统：把插件内部的「发送 / 接收 / 等待 / 失败」事件翻译成用户看得见的一行提示。
 *
 * 形态取舍（为什么不是正文、不是纯 toast）：
 * - 正文块会混进模型回答，污染交付内容 —— 否决；
 * - 页面 toast 只在浏览器可见，用户盯着 DSH 时看不到 —— 只能当辅助；
 * - reasoning 块可折叠、有独立样式、不占正文 —— 主通道。
 *
 * 因此主通道是 reasoning 块（前缀 `[DSH]` / `[DSH·审核]`，一眼能分清是会话还是审核），
 * 浏览器页面浮层只服务「用户正盯着网页」的等待场景（频控等待、等待人工发送）。
 *
 * 本文件只放纯函数：开关判定、文案格式化、退避计算。节流和 DOM 注入在通道实现里，
 * 这样 tools/notify-check.ts 可以不启浏览器直接验证行为。
 */

/** 提示归属：会话消息，还是内部审核消息。 */
export type NoticeCategory = 'session' | 'review'

/**
 * 提示事件。
 * - send：往网页里发消息
 * - receive：网页开始回 / 已经开始生成
 * - done：本轮完整结束
 * - wait：频控等待中
 * - retry：频控重发（第 n 次）
 * - recover：浏览器/标签页被关掉后正在自愈
 * - error：本轮失败
 */
export type NoticeEvent = 'send' | 'receive' | 'done' | 'wait' | 'retry' | 'recover' | 'error'

/** 提示开关。全部默认开启：用户要求「出现什么都提示」，关掉才安静。 */
export interface NotifyConfig {
  /** 总开关。关掉后所有提示都不发（含浏览器浮层）。 */
  enabled: boolean
  /** 会话消息提示。 */
  session: boolean
  /** 审核消息提示（同对话自审、独立审核通道）。 */
  review: boolean
  /** 发送侧提示。 */
  send: boolean
  /** 接收侧提示（已开始生成、完成、频控等待、重发）。 */
  receive: boolean
  /** 失败提示。 */
  errors: boolean
  /** 浏览器页面浮层（辅助通道，只服务等待场景）。 */
  browser: boolean
}

export const DEFAULT_NOTIFY: Readonly<NotifyConfig> = Object.freeze({
  enabled: true,
  session: true,
  review: true,
  send: true,
  receive: true,
  errors: true,
  browser: true,
})

/** 提示负载：通道产出、适配层消费。 */
export interface NoticePayload {
  readonly category: NoticeCategory
  readonly event: NoticeEvent
  /** 已格式化好的单行正文（含前缀），适配层直接用。 */
  readonly text: string
}

/**
 * 这条提示要不要发。
 *
 * 判定顺序：总开关 → 分类开关 → 事件开关。事件归组刻意做得粗：
 * 「开始生成 / 完成 / 等待 / 重发」都算接收侧，用户不会想去细分它们。
 */
export function noticeEnabled(
  config: NotifyConfig | undefined,
  category: NoticeCategory,
  event: NoticeEvent,
): boolean {
  const cfg = config ?? DEFAULT_NOTIFY
  if (cfg.enabled !== true) return false
  if (category === 'review' ? cfg.review !== true : cfg.session !== true) return false
  if (event === 'error') return cfg.errors !== false
  if (event === 'send') return cfg.send !== false
  return cfg.receive !== false
}

/** 浏览器浮层要不要画（浮层只用于等待场景）。 */
export function browserNoticeEnabled(config: NotifyConfig | undefined): boolean {
  return (config ?? DEFAULT_NOTIFY).enabled !== true
    ? false
    : (config ?? DEFAULT_NOTIFY).browser !== false
}

/** 前缀：会话与审核必须能一眼分开，不能搅成一锅。 */
export function noticePrefix(category: NoticeCategory): string {
  return category === 'review' ? '[DSH·审核]' : '[DSH]'
}

const EVENT_LABEL: Readonly<Record<NoticeEvent, string>> = Object.freeze({
  send: '发送',
  receive: '接收',
  done: '完成',
  wait: '频控等待',
  retry: '重发',
  recover: '恢复',
  error: '失败',
})

/** 毫秒转人类可读：950ms → "0.9s"，61_000 → "1m1s"。 */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (safe < 60_000) return `${(safe / 1000).toFixed(safe < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(safe / 60_000)
  const seconds = Math.round((safe % 60_000) / 1000)
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`
}

/**
 * 拼一行提示。
 *
 * 只做拼接，不做截断：调用方知道该带多少细节；错误信息在适配层另有限长。
 */
export function formatNotice(input: {
  readonly category: NoticeCategory
  readonly event: NoticeEvent
  readonly detail: string
  /** 本地时间；缺省不带时间戳（普通回合不需要）。 */
  readonly at?: Date
}): string {
  const label = EVENT_LABEL[input.event]
  const stamp = input.at === undefined
    ? ''
    : ` ${input.at.toLocaleTimeString('zh-CN', { hour12: false })}`
  const detail = input.detail.trim()
  return detail === ''
    ? `${noticePrefix(input.category)} ${label}${stamp}`
    : `${noticePrefix(input.category)} ${label}${stamp} · ${detail}`
}

/** 频控退避策略。与 config.rateLimit 同形，便于直接传进来。 */
export interface RateLimitPolicy {
  readonly retryDelayMs?: number
  /** fixed：每次都等 retryDelayMs；exponential：按尝试次数翻倍（默认）。 */
  readonly backoff?: 'fixed' | 'exponential'
  /** 指数退避的单次上限。 */
  readonly retryMaxDelayMs?: number
  /** 抖动比例 0~0.5，避免多个实例同一秒重撞。 */
  readonly jitterRatio?: number
}

/** 单次等待下限：再小就没有退避意义，还会把冷却期撞得更狠。 */
export const RATE_LIMIT_MIN_DELAY_MS = 1_000

/** 默认退避基数：首次等 1 分钟。 */
export const RATE_LIMIT_BASE_DELAY_MS = 60_000

/** 默认单次上限：5 分钟。 */
export const RATE_LIMIT_MAX_DELAY_MS = 300_000

/** 默认抖动：±15%。 */
export const RATE_LIMIT_JITTER_RATIO = 0.15

/**
 * 第 `attempt` 次频控后该等多少毫秒（attempt 从 0 开始）。
 *
 * 默认指数退避：60s → 120s → 240s → 300s（封顶），累计约 12 分钟，覆盖
 * 实测最常见的 10~15 分钟冷却窗口；`backoff: 'fixed'` 时退化为固定 x 秒。
 * 抖动是乘法抖动，`random` 可注入，测试里传固定函数即可拿确定值。
 */
export function rateLimitDelayMs(
  policy: RateLimitPolicy | undefined,
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.max(RATE_LIMIT_MIN_DELAY_MS, policy?.retryDelayMs ?? RATE_LIMIT_BASE_DELAY_MS)
  const cap = Math.max(base, policy?.retryMaxDelayMs ?? RATE_LIMIT_MAX_DELAY_MS)
  const step = Math.max(0, Math.trunc(attempt))
  const raw = policy?.backoff === 'fixed'
    ? base
    : Math.min(base * 2 ** step, cap)
  const jitter = Math.min(0.5, Math.max(0, policy?.jitterRatio ?? RATE_LIMIT_JITTER_RATIO))
  const factor = 1 + (random() * 2 - 1) * jitter
  return Math.max(RATE_LIMIT_MIN_DELAY_MS, Math.round(raw * factor))
}

/** 一句话描述退避策略，用于启动日志和设置页提示。 */
export function describeRateLimitPolicy(policy: RateLimitPolicy | undefined): string {
  const base = Math.max(RATE_LIMIT_MIN_DELAY_MS, policy?.retryDelayMs ?? RATE_LIMIT_BASE_DELAY_MS)
  const cap = Math.max(base, policy?.retryMaxDelayMs ?? RATE_LIMIT_MAX_DELAY_MS)
  return policy?.backoff === 'fixed'
    ? `固定 ${formatDuration(base)}`
    : `指数 ${formatDuration(base)} 起、单次封顶 ${formatDuration(cap)}`
}

/** 服务端故障的默认退避基数：首次等 15 秒（后端抖动通常几十秒内恢复）。 */
export const SERVER_BUSY_BASE_DELAY_MS = 15_000

/** 服务端故障的单次等待上限：2 分钟。 */
export const SERVER_BUSY_MAX_DELAY_MS = 120_000

/** 服务端故障的默认重试次数：15s + 30s + 60s + 120s ≈ 3.75 分钟。 */
export const SERVER_BUSY_MAX_RETRIES = 4

/**
 * 第 `attempt` 次服务端故障后该等多少毫秒（attempt 从 0 开始）。
 *
 * 与频控退避刻意分开：频控是账号被判发太快，要等满冷却窗口（分钟级起步）；
 * 服务端故障是后端过载/重启，恢复得快，等太久只会让用户干坐着。
 * 曲线：15s → 30s → 60s → 120s（封顶），带 ±20% 抖动。
 */
export function serverBusyDelayMs(
  policy: RateLimitPolicy | undefined,
  attempt: number,
  random: () => number = Math.random,
): number {
  return rateLimitDelayMs({
    retryDelayMs: policy?.retryDelayMs ?? SERVER_BUSY_BASE_DELAY_MS,
    backoff: policy?.backoff ?? 'exponential',
    retryMaxDelayMs: policy?.retryMaxDelayMs ?? SERVER_BUSY_MAX_DELAY_MS,
    jitterRatio: policy?.jitterRatio ?? 0.2,
  }, attempt, random)
}

/** 失败信息的结构形（LlmError.failure 同形，便于直接传）。 */
export interface FailureLike {
  readonly code?: string
  readonly message?: string
}

/**
 * 错误码 → 一句人话 + 该怎么办。
 *
 * 宿主气泡已经会显示插件原文和 code，这里补的是「接下来怎么办」：
 * 每条都带行动建议，而不是把 code 再念一遍。
 */
const FAILURE_HINT: Readonly<Record<string, string>> = Object.freeze({
  WEB_RATE_LIMITED: '网页频控未解除，等 10~15 分钟再发，或先去网页端手动发一条试探',
  WEB_SERVER_BUSY: '网页服务端暂时不可用（不是账号问题）：插件已自动等待重发仍未恢复，等 1~2 分钟再试即可',
  WEB_ACCOUNT_COOLDOWN: '账号还在频控冷却期，所有会话都已暂停发请求；到点后重试即可',
  WEB_ACCOUNT_BLOCKED: '网页判定账号受限（临时封禁），只能等限制到期；期间别再发请求',
  WEB_LOGIN_EXPIRED: '登录态已失效，请在插件浏览器窗口里重新登录后重试',
  WEB_UI_CHANGED: '页面结构变了：输入框或发送按钮已找不到。多半是网页改版，先升级插件；急需用时在网页端手动发一条',
  WEB_TURN_TIMEOUT: '单回合超过上限，检查网页是否卡在生成中，或调大 turnTimeoutMs',
  WEB_TURN_FAILED: '网页对话中途异常，重试本轮；反复失败时看插件日志里的原始报错',
  WEB_AUTO_SEND_TIMEOUT: '网页 3 分钟没响应，可能卡住或掉登录，重试会重新走一遍',
  WEB_SEND_NOT_TRIGGERED: '回车和发送按钮都没把消息发出去，页面可能改版；需人工检查网页后重试',
  WEB_MANUAL_SEND_TIMEOUT: '等了很久没检测到发送，请在网页里回车/点发送，或重试本轮',
  WEB_TURN_ABORTED: '本轮被取消，可直接重发',
  WEB_HTTP_ERROR: '网页返回了错误状态码，稍后重试或先看网页里是否要求验证',
  WEB_EMPTY_RESPONSE: '网页没有产出可解析正文，重试或换一个问法',
  WEB_STREAM_STALLED: '网页的响应流卡住了：已经收到回复头，但正文迟迟没读完。重试本轮；反复出现就看网页是否停在生成中',
  WEB_UNPARSEABLE_RESPONSE: '网页响应格式变了，插件还没跟上，可先升级插件',
  WEB_REPLY_TRUNCATED: '回复太长被截断，下一轮补齐即可',
  WEB_REPLY_INTERRUPTED: '网页生成中断，重发本次请求',
  WEB_PAGE_CLOSED: '网页标签被关掉了，自愈开启时会自动重开标签页并重发本轮；关掉自愈就手动重试',
  WEB_LOGIN_REQUIRED: '请在浏览器窗口里登录 chat.deepseek.com，然后重试',
  WEB_LOGIN_REVEAL_TIMEOUT: '登录页置前超时，已继续尝试窗口置前；若仍看不到浏览器窗口，请手动切过去登录',
  WEB_EDITOR_NOT_FOUND: '没找到聊天输入框，确认浏览器停在对话页再重试',
  WEB_ACTION_REJECTED: '网页拒绝了这次操作，重试或手动在网页操作一次',
  WEB_AUXILIARY_UNSUPPORTED: '内部辅助请求不被支持，不影响主对话',
  WEB_CONTEXT_LENGTH_AGAIN: '网页上下文又超限了，等自动压缩完成后重试',
  WEB_CORRECTION_TIMEOUT: '纠正回合超时，重试本轮',
  WEB_DELEGATION_FAILED: '网页端执行子任务失败，重试本轮',
  WEB_UNFINISHED_HANDOFF: '上一轮没交接完，重试本轮',
  WEB_IMAGE_UPLOAD_FAILED: '图片上传失败，换一张图或去掉附图重试',
  WEB_IMAGE_READ_FAILED: '图片读取失败，附件可能已失效，重新上传',
  WEB_CHATS_FAILED: '读取或清空网页端对话失败，稍后重试；不影响正常发送',
  BROWSER_ATTACH_FAILED: '连不上已开的浏览器，检查 --remote-debugging-port 端口',
  BROWSER_MANAGED_START_FAILED: '浏览器没起来，重试会自动重启；反复失败看占用与残留进程',
  BROWSER_NAVIGATION_INTERRUPTED: '打开页面时被浏览器自己的启动页/恢复页抢了导航，已自动重试；再试一次通常就好',
  GLM_AUTO_SEND_TIMEOUT: 'GLM 网页 2 分钟没响应，可能卡住或掉登录，重试会重新走一遍',
  GLM_SEND_NOT_TRIGGERED: 'GLM 的回车和发送按钮都没把消息发出去，页面可能改版；需人工检查网页后重试',
  GLM_MANUAL_SEND_TIMEOUT: 'GLM 等了很久没检测到发送，请在网页里回车/点发送，或重试本轮',
  GLM_SEND_BLOCKED: 'GLM 发送按钮不可用，多半是没登录；先登录 chat.z.ai 再重试',
  BROWSER_NOT_FOUND: '本机没找到可用的 Edge/Chrome，装一个或指定 executablePath',
  UNKNOWN_MODEL: '模型 id 不认识，改用 deepseek-web',
  MALFORMED_TOOL_CALL: '工具调用格式错误，重试本轮',
  CONTEXT_WINDOW_EXCEEDED: '上下文超出模型窗口，等自动压缩或开新会话',
})

/**
 * 把失败翻译成一行提示正文。
 *
 * 前缀由 formatNotice 加；这里只管「code · 人话」。表外错误回退到错误原文，
 * 截 120 字——长栈会把提示撑爆，而原文在宿主气泡里完整可查。
 */
export function describeFailure(failure: FailureLike | undefined): string {
  const raw = (failure?.code ?? '').trim()
  const code = raw === '' ? 'UNKNOWN' : raw
  const hint = FAILURE_HINT[code]
  if (hint !== undefined) return `${code} · ${hint}`
  if (code.startsWith('KIMI_')) {
    return `${code} · Kimi 审核通道失败，可改用 DeepSeek 自审或先关掉 Kimi 审核`
  }
  if (code.startsWith('GLM_')) {
    return `${code} · GLM 审核通道失败，可改用 DeepSeek 自审或先关掉 GLM 审核`
  }
  if (code.startsWith('BROWSER_')) {
    return `${code} · 浏览器环节失败：重试会自动重启浏览器`
  }
  const message = (failure?.message ?? '').trim().replace(/\s+/gu, ' ')
  if (message === '') return code
  return `${code} · ${message.length > 120 ? `${message.slice(0, 120)}…` : message}`
}
