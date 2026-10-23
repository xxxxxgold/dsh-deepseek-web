/**
 * 重试预算：限制「同一账号在一段时间内最多用几次自动重发」。
 *
 * 为什么需要它（而不是只靠每回合的 `maxRetries`）：
 * `maxRetries` 是**每回合**的上限，宿主一旦连续自动续跑（长任务、子代理、压缩摘要），
 * 每个回合都能各自重试 4 次，叠加起来就是竞品记录过的那类事故——22 分钟里 49 次请求、
 * 间隔 8~12 秒，随后账号被吊销。单看每个回合都"合规"，合起来是机器密度。
 *
 * 因此预算必须活在**回合之外**：进程级、按账号、带 TTL 的计数器。
 * 这与竞品 `@wlv-zedd/dsh-chatgpt-web` 的 `retry-policy.ts` 同一思路（那边是因为
 * HTTP bridge 每个请求新建 adapter，预算只能活在外面），本项目则是为了跨回合封顶。
 *
 * @module dsh-deepseek-web/retry-policy
 */

/** 一次重试预算的默认参数。 */
export const RETRY_BUDGET = Object.freeze({
  /** 预算窗口：30 分钟内最多允许这么多次「触发自动重发」的失败。 */
  ttlMs: 30 * 60_000,
  /** 窗口内允许自动重发的总次数（不是回合数）。 */
  maxRetriesInWindow: 3,
})

interface Attempt {
  at: number
}

/**
 * 只在需要时才计数的预算表。
 *
 * 语义：`take(key)` 在窗口内还有余量时返回 true 并记一次；用尽返回 false。
 * 过期的记录在每次 `take` / `remaining` 时顺手清理，不需要定时器。
 */
export class TurnRetryBudget {
  private readonly attempts = new Map<string, Attempt[]>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly max: number

  constructor(options: { now?: () => number; ttlMs?: number; max?: number } = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? RETRY_BUDGET.ttlMs
    this.max = options.max ?? RETRY_BUDGET.maxRetriesInWindow
  }

  /** 清掉超过窗口的记录（惰性清理）。 */
  private prune(key: string): Attempt[] {
    const cutoff = this.now() - this.ttlMs
    const kept = (this.attempts.get(key) ?? []).filter(attempt => attempt.at > cutoff)
    if (kept.length === 0) this.attempts.delete(key)
    else this.attempts.set(key, kept)
    return kept
  }

  /** 窗口内还剩几次；`max` 为 0 表示不限（返回 Infinity）。 */
  remaining(key: string): number {
    if (this.max <= 0) return Number.POSITIVE_INFINITY
    return Math.max(0, this.max - this.prune(key).length)
  }

  /** 取一次预算；用尽返回 false（调用方应直接失败，不再重发）。 */
  take(key: string): boolean {
    if (this.max <= 0) return true
    const used = this.prune(key)
    if (used.length >= this.max) return false
    used.push({ at: this.now() })
    this.attempts.set(key, used)
    return true
  }

  /** 一次真的成功可以清空该键的计数（别让成功后的偶发失败继承旧账）。 */
  reset(key: string): void {
    this.attempts.delete(key)
  }

  /** 仅供诊断/自检：当前窗口内的使用量。 */
  used(key: string): number {
    return this.prune(key).length
  }
}

/**
 * 这个错误码值不值得让宿主再试一次。
 *
 * 判据来自本项目 52 个错误码的实测归类：
 * - 可重试：临时性、重来一次可能不同（超时、空响应、页面被关、上传失败…）；
 * - 不可重试：重来只会重复同样的结果（未登录、模型名不认识、页面改版、格式不兼容…）。
 *
 * 分类只是给调用方（宿主气泡、doctor、日记）一个统一口径，真正的重试决定权在宿主。
 */
const RETRYABLE = new Set([
  'WEB_TURN_TIMEOUT',
  'WEB_AUTO_SEND_TIMEOUT',
  'WEB_MANUAL_SEND_TIMEOUT',
  'WEB_EMPTY_RESPONSE',
  'WEB_REPLY_INTERRUPTED',
  'WEB_REPLY_TRUNCATED',
  'WEB_PAGE_CLOSED',
  'WEB_HTTP_ERROR',
  'WEB_IMAGE_UPLOAD_FAILED',
  'WEB_IMAGE_READ_FAILED',
  'WEB_CORRECTION_TIMEOUT',
  'WEB_DELEGATION_FAILED',
  'WEB_UNFINISHED_HANDOFF',
  'WEB_CONTEXT_LENGTH_AGAIN',
  'BROWSER_MANAGED_START_FAILED',
  'BROWSER_ATTACH_FAILED',
  'MALFORMED_TOOL_CALL',
])

const NOT_RETRYABLE = new Set([
  'WEB_LOGIN_REQUIRED',
  'WEB_LOGIN_EXPIRED',
  'WEB_ACCOUNT_BLOCKED',
  'WEB_ACCOUNT_COOLDOWN',
  'WEB_RATE_LIMITED',
  'WEB_UI_CHANGED',
  'WEB_EDITOR_NOT_FOUND',
  'WEB_UNPARSEABLE_RESPONSE',
  'WEB_SEND_NOT_TRIGGERED',
  'WEB_AUXILIARY_UNSUPPORTED',
  'BROWSER_NOT_FOUND',
  'UNKNOWN_MODEL',
  'CONTEXT_WINDOW_EXCEEDED',
])

/** 三态：'yes' 值得重试 / 'no' 不值得 / 'unknown' 没归类（交给宿主按默认处理）。 */
export function retryability(code: string | undefined): 'yes' | 'no' | 'unknown' {
  const normalized = (code ?? '').trim().toUpperCase()
  if (normalized === '') return 'unknown'
  if (RETRYABLE.has(normalized)) return 'yes'
  if (NOT_RETRYABLE.has(normalized)) return 'no'
  // 审核通道（Kimi/GLM）不是主通道：失败要不要重试取决于用户是否接受降级，不在这里断言
  return 'unknown'
}

/** 进程级单例：所有通道实例共用一份预算（热重载不重置）。 */
let shared: TurnRetryBudget | undefined

export function sharedRetryBudget(): TurnRetryBudget {
  shared ??= new TurnRetryBudget()
  return shared
}

/** 仅供测试。 */
export function resetSharedRetryBudget(): void {
  shared = undefined
}
