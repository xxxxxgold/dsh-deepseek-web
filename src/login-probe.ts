/**
 * 登录态主动探活。
 *
 * 为什么需要：发送路径只在「真的要发」的那一刻才判断登录态（`looksLoggedOut` /
 * `looksLoginWall`），所以登录过期往往要等到用户发出一整轮、等了十几秒才暴露。
 * 竞品 `dsh-deepseek-web-login` 的做法是启动后 20 秒探一次、之后每 30 分钟探一次，
 * 只读判断、零额度。这里照同一口径实现，但额外守住两条：
 *
 * - **绝不为了探活拉起浏览器**：浏览器没起来时返回 `unknown`，不启动进程（探活不该有副作用）；
 * - **单飞 + 串行重排**：一次探活没结束不排下一次，避免页面卡住时堆出一串并发探测。
 *
 * @module dsh-deepseek-web/login-probe
 */

/** 探活结论：`unknown` 表示「现在没法判断」，不是失败。 */
export type LoginProbeStatus = 'ok' | 'expired' | 'unknown'

/** 一次探活的结果。 */
export interface LoginProbeResult {
  readonly status: LoginProbeStatus
  /** 人话说明；`unknown` 时写清为什么判断不了。 */
  readonly detail?: string
  readonly checkedAt: number
}

/** 被探活的对象（真实的 Playwright 通道或离线替身）。 */
export interface LoginProbeTarget {
  probeLogin(): Promise<LoginProbeResult>
}

/** 定时器注入面：离线测试用假时钟，线上用 `setTimeout`。 */
export interface LoginProbeTimers {
  schedule(handler: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

const DEFAULT_TIMERS: LoginProbeTimers = {
  schedule: (handler, delayMs) => {
    const timer = setTimeout(handler, delayMs)
    // 探活不该把进程钉住：Node 下 unref，浏览器环境没有该方法时忽略。
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return timer
  },
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** 调度参数。 */
export interface LoginProbeOptions {
  readonly target: LoginProbeTarget
  /** 启动后第一次探活的延迟；默认 20 秒（等页面把登录态渲染出来）。 */
  readonly initialDelayMs?: number
  /** 两次探活之间的间隔；默认 30 分钟。`<= 0` 表示只探一次。 */
  readonly intervalMs?: number
  readonly timers?: LoginProbeTimers
  readonly now?: () => number
  /** 每次探活结束后的回调（用于日志/提示）。 */
  readonly onResult?: (result: LoginProbeResult) => void
}

/** 默认首次延迟：20 秒。 */
export const DEFAULT_PROBE_INITIAL_DELAY_MS = 20_000

/** 默认探活间隔：30 分钟。 */
export const DEFAULT_PROBE_INTERVAL_MS = 30 * 60_000

/**
 * 登录态探活调度器。
 *
 * `start()` 之后按「首次延迟 → 间隔 → 间隔 → …」串行排期；`stop()` 立即取消
 * 未到期的下一次探活，并让正在跑的那次结果不再触发重排。
 */
export class LoginProbeScheduler {
  private readonly target: LoginProbeTarget
  private readonly initialDelayMs: number
  private readonly intervalMs: number
  private readonly timers: LoginProbeTimers
  private readonly now: () => number
  private readonly onResult: ((result: LoginProbeResult) => void) | undefined
  private handle: unknown
  private stopped = true
  private running = false
  private result: LoginProbeResult | undefined

  constructor(options: LoginProbeOptions) {
    this.target = options.target
    this.initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_PROBE_INITIAL_DELAY_MS)
    this.intervalMs = options.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS
    this.timers = options.timers ?? DEFAULT_TIMERS
    this.now = options.now ?? Date.now
    this.onResult = options.onResult
  }

  /** 开始排期；重复调用无副作用。 */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.scheduleNext(this.initialDelayMs)
  }

  /** 停止排期。 */
  stop(): void {
    this.stopped = true
    if (this.handle !== undefined) {
      this.timers.cancel(this.handle)
      this.handle = undefined
    }
  }

  /** 最近一次探活结果（还没探过时为 `undefined`）。 */
  last(): LoginProbeResult | undefined {
    return this.result
  }

  /** 立即探一次（自检/设置页用），不影响既有排期，也不触发后台副作用。 */
  async probeNow(): Promise<LoginProbeResult> {
    return await this.run(false)
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return
    this.handle = this.timers.schedule(() => {
      this.handle = undefined
      void this.run(true).then(result => {
        if (result === undefined) return
        if (this.intervalMs > 0) this.scheduleNext(this.intervalMs)
        else this.stopped = true
      })
    }, delayMs)
  }

  /**
   * 执行一次探活。
   *
   * `notify=false` 用于设置页的「立即检测」：手动点击只想要一个结果，
   * 不应该触发登录页置前/提示这类后台副作用。
   */
  private async run(notify = true): Promise<LoginProbeResult> {
    if (this.running) {
      return this.result ?? { status: 'unknown', detail: '上一次探活还没结束', checkedAt: this.now() }
    }
    this.running = true
    let result: LoginProbeResult
    try {
      result = await this.target.probeLogin()
    } catch (error) {
      result = {
        status: 'unknown',
        detail: `探活失败：${error instanceof Error ? error.message : String(error)}`,
        checkedAt: this.now(),
      }
    } finally {
      this.running = false
    }
    this.result = result
    if (notify) this.onResult?.(result)
    return result
  }
}

/** 把探活结果压成一行提示文案（日志 / 自检 / 面板共用同一口径）。 */
export function summarizeLoginProbe(result: LoginProbeResult | undefined): string {
  if (result === undefined) return '还没探活'
  switch (result.status) {
    case 'ok': return '登录态正常'
    case 'expired': return `登录态已失效${result.detail === undefined ? '' : `：${result.detail}`}`
    default: return `无法判断登录态${result.detail === undefined ? '' : `：${result.detail}`}`
  }
}
