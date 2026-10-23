/**
 * 账号级冷却：被网页判定频控之后，整个账号在一段时间内不再发请求。
 *
 * 为什么是「账号级」而不是「会话级」：网页端的频控与临时封禁按**账号**结算，
 * 不是按标签页。竞品实测同账号两条生成并发不到 6 分钟即触发 1 天封禁；本插件
 * 原来只做「本回合退避重发」，A 会话在等的同时 B 会话仍会继续打网页，等于把
 * 冷却窗口当成可用时间。
 *
 * 设计要点：
 * - 只认「限流」和「账号被限」两类失败进冷却；**断网、超时、5xx、429 之外的
 *   临时故障一律不进**——否则一次网络抖动会把整台机器锁死十分钟。
 * - 时钟可注入：测试里不用真的等 10 分钟。
 * - 单例默认跟随进程：热重载换了 channel 实例，冷却状态不能跟着丢。
 *
 * @module dsh-deepseek-web/cooldown
 */

/** 失败分类，决定要不要进冷却。 */
export type FailureClass = 'rate-limit' | 'account-blocked' | 'login' | 'network' | 'other'

/**
 * 按错误码归类。
 *
 * 判据只认明确的限流/封禁信号；识别不出来的一律 `other`（不进冷却），
 * 宁可少锁一次，也不要把正常失败当成限流。
 */
export function classifyFailureCode(code: string | undefined): FailureClass {
  const normalized = (code ?? '').trim().toUpperCase()
  if (normalized === '') return 'other'
  if (normalized === 'WEB_RATE_LIMITED' || normalized === 'WEB_ACCOUNT_COOLDOWN') return 'rate-limit'
  if (normalized === 'WEB_ACCOUNT_BLOCKED') return 'account-blocked'
  if (normalized === 'WEB_LOGIN_REQUIRED' || normalized === 'WEB_LOGIN_EXPIRED') return 'login'
  if (normalized.startsWith('BROWSER_') || normalized === 'WEB_PAGE_CLOSED') return 'network'
  return 'other'
}

/** 这次失败该不该把账号锁进冷却，以及锁多久（毫秒；0 表示不锁）。 */
export function cooldownForFailure(
  failure: FailureClass,
  policy: { afterRateLimitMs: number; afterAccountBlockedMs: number },
): number {
  if (failure === 'rate-limit') return Math.max(0, policy.afterRateLimitMs)
  if (failure === 'account-blocked') return Math.max(0, policy.afterAccountBlockedMs)
  return 0
}

export interface CooldownSnapshot {
  /** 冷却结束的绝对时刻（毫秒时间戳）；0 表示未在冷却。 */
  until: number
  /** 触发冷却的原因（仅用于展示）。 */
  reason?: string
}

/**
 * 账号冷却计时器。
 *
 * 语义刻意很简单：只有一个「到某时刻为止别发」的标记，不做计数、不做滑动窗口
 * ——滑动窗口属于台账（ledger）的职责，这里只负责「现在能不能发」。
 */
export class AccountCooldown {
  private until = 0
  private reason: string | undefined
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** 进入冷却；已有更晚的冷却时保留更晚的那个（不能被短冷却提前解锁）。 */
  block(durationMs: number, reason: string): void {
    if (durationMs <= 0) return
    const target = this.now() + durationMs
    if (target <= this.until) return
    this.until = target
    this.reason = reason
  }

  /** 还剩多少毫秒（已过期返回 0，并顺手清掉标记）。 */
  remainingMs(): number {
    if (this.until === 0) return 0
    const left = this.until - this.now()
    if (left <= 0) {
      this.until = 0
      this.reason = undefined
      return 0
    }
    return left
  }

  /** 一次真正成功的往返可以提前解除冷却（网页已经愿意回答了）。 */
  clear(): void {
    this.until = 0
    this.reason = undefined
  }

  snapshot(): CooldownSnapshot {
    return this.remainingMs() > 0
      ? { until: this.until, ...this.reason !== undefined ? { reason: this.reason } : {} }
      : { until: 0 }
  }
}

/**
 * 进程级单例。
 *
 * 插件热重载会重建 channel，但账号还是那一个：冷却必须跨实例保留，
 * 否则「配置一改就绕过冷却」正是最容易被判机器行为的方式。
 */
let shared: AccountCooldown | undefined

export function sharedCooldown(): AccountCooldown {
  shared ??= new AccountCooldown()
  return shared
}

/** 仅供测试：重置单例，避免用例之间互相污染。 */
export function resetSharedCooldown(): void {
  shared = undefined
}
