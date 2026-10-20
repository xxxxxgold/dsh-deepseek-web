/** 并发网关的运行态快照（只用于日志与观测）。 */
export interface GateStats {
  /** 当前生效的并发上限；0 表示不限制。 */
  limit: number
  /** 正在占用名额的请求数。 */
  active: number
  /** 正在排队等名额的请求数。 */
  pending: number
}

/** acquire 的附加选项。 */
export interface GateAcquireOptions {
  /**
   * 排队超过 waitLogMs 时的回调（只用于日志，不要在这里抛错）。
   * 用来把"在排队"和"卡死了"区分开：默认 3 秒后才提示一次。
   */
  onWait?: (info: { waitedMs: number; pending: number; limit: number }) => void
  /** 排队多久后触发 onWait（毫秒）；0 表示不提示。默认 3000。 */
  waitLogMs?: number
}

interface GateWaiter {
  resolve: (release: () => void) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort: () => void
  hintTimer?: ReturnType<typeof setTimeout>
}

/**
 * 全局并发网关：限制"同时真正在网页上跑的请求数"，超出的按先进先出排队。
 *
 * 为什么需要它：会话锁只保证同一会话串行，不同会话仍然会同时打同一个 DeepSeek 账号。
 * 网页端并发过高会触发频控（429），表现为所有会话一起变慢、重试堆叠。
 * 这里把并发收成一个可配置的上限（默认 2），超出的请求排队，按到达顺序一个个放行。
 *
 * 设计约束：
 * - 放行是严格 FIFO 的，不会因为后来的请求更短就插队（避免饥饿）。
 * - 排队可被 signal 取消：取消的请求立即从队列摘除，不会泄露名额。
 * - release 幂等：即使调用方重复释放，也不会多放行一个请求。
 * - 上限为 0 表示不限制，此时只计数不排队（便于观测当前真实并发）。
 */
export class ConcurrencyGate {
  private activeCount = 0
  private readonly waiters: GateWaiter[] = []
  private readonly limitOf: () => number

  constructor(limitOf: () => number) {
    this.limitOf = limitOf
  }

  /** 当前生效的并发上限；配置非法（NaN/负数）时按 0（不限制）处理。 */
  get limit(): number {
    const raw = this.limitOf()
    if (!Number.isFinite(raw) || raw <= 0) return 0
    return Math.floor(raw)
  }

  /** 正在占用名额的请求数。 */
  get active(): number {
    return this.activeCount
  }

  /** 正在排队的请求数。 */
  get pending(): number {
    return this.waiters.length
  }

  stats(): GateStats {
    return { limit: this.limit, active: this.activeCount, pending: this.waiters.length }
  }

  /**
   * 取一个并发名额：有空位立即返回，否则进入 FIFO 队列。
   * 返回的 release 必须调用一次（通常在 stream 的 finally 里）。
   */
  async acquire(signal?: AbortSignal, options: GateAcquireOptions = {}): Promise<() => void> {
    signal?.throwIfAborted()
    const limit = this.limit
    if (limit === 0 || this.activeCount < limit) {
      this.activeCount++
      return this.makeRelease()
    }

    return await new Promise<() => void>((resolve, reject) => {
      const waiter: GateWaiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter)
          // 已放行（不在队列里）时不要重复 reject：名额已经属于调用方，由正常流程释放。
          if (index < 0) return
          this.waiters.splice(index, 1)
          this.clearHint(waiter)
          reject(signal?.reason ?? new Error('请求已取消'))
        },
      }
      const waitLogMs = options.waitLogMs ?? 3_000
      if (waitLogMs > 0) {
        const startedAt = Date.now()
        waiter.hintTimer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index < 0) return
          options.onWait?.({
            waitedMs: Date.now() - startedAt,
            pending: this.waiters.length,
            limit: this.limit,
          })
        }, waitLogMs)
        unrefTimer(waiter.hintTimer)
      }
      this.waiters.push(waiter)
      if (signal) {
        if (signal.aborted) waiter.onAbort()
        else signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      // 上限可能在排队期间被调大：这里补一次派发，避免空等。
      this.dispatch()
    })
  }

  /** 幂等释放：重复调用不会多放行请求。 */
  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.activeCount > 0) this.activeCount--
      this.dispatch()
    }
  }

  /** 把空出来的名额按 FIFO 交给排队最久的请求；已取消的请求直接跳过。 */
  private dispatch(): void {
    while (this.waiters.length > 0) {
      const limit = this.limit
      if (limit !== 0 && this.activeCount >= limit) return
      const waiter = this.waiters.shift()!
      this.clearHint(waiter)
      if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason ?? new Error('请求已取消'))
        continue
      }
      this.activeCount++
      waiter.resolve(this.makeRelease())
    }
  }

  private clearHint(waiter: GateWaiter): void {
    if (waiter.hintTimer) {
      clearTimeout(waiter.hintTimer)
      waiter.hintTimer = undefined
    }
  }
}

/** Node 的 timer 有 unref()；浏览器/边缘运行时没有，安全降级。 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.()
}
