/** 锁租约到点被强制回收时上报的信息（用于日志与观测）。 */
export interface LockLeakInfo {
  /** 从真正拿到锁到被判定为泄漏的毫秒数。 */
  heldMs: number
  /** 判定泄漏时仍在排队的请求数。 */
  waiters: number
}

/** acquire 的附加选项：全部可选，默认行为与旧版完全一致（无租约、无排队上限）。 */
export interface AcquireOptions {
  /**
   * 持锁租约（毫秒）。超过该时长仍未释放，就强制释放并回调 onLeak。
   * 用于兜底"持有者异常 / 消费者放弃生成器导致 finally 永不执行"造成的永久卡死。
   * 0 或未设置表示不启用。
   */
  maxHoldMs?: number
  /** 租约到点强制释放时的回调（只用于日志，不要在这里抛错）。 */
  onLeak?: (info: LockLeakInfo) => void
  /** 排队等待上限（毫秒）：超时抛错放弃排队，避免请求无限期空等。0 或未设置表示不限制。 */
  maxWaitMs?: number
}

/** 串行化共享浏览器/会话操作；排队时可取消，失败不会阻塞后续请求。 */
export class AsyncLock {
  private tail: Promise<void> = Promise.resolve()
  /** 当前排队中的请求数（只用于观测与日志，不含已持有者）。 */
  private waiters = 0
  /** 当前持有锁的请求数（正常是 0 或 1；租约强制释放后可能短暂重叠）。 */
  private held = 0

  /** 排队中的请求数（快照）。 */
  get pending(): number {
    return this.waiters
  }

  /**
   * 这把锁现在还有没有人在用（持有中或有人排队）。
   *
   * 给调用方做「空闲即回收」用：按会话建锁的 Map 如果不回收，
   * 每开一个新会话就永久留下一个锁对象，长跑的宿主会慢慢涨。
   * 判断必须保守——宁可多留一会儿，也不能删掉一把可能有人排队的锁。
   */
  get busy(): boolean {
    return this.held > 0 || this.waiters > 0
  }

  async acquire(signal?: AbortSignal, options: AcquireOptions = {}): Promise<() => void> {
    signal?.throwIfAborted()
    const previous = this.tail
    let releaseRaw!: () => void
    const gate = new Promise<void>(resolve => { releaseRaw = resolve })
    this.tail = previous.then(() => gate)
    this.waiters++

    // 释放动作幂等：租约强制释放之后持有者再调用一次 release() 不会重复解锁，
    // 也不会影响后面新排队的请求。
    let released = false
    let leaseTimer: ReturnType<typeof setTimeout> | undefined
    let waitTimer: ReturnType<typeof setTimeout> | undefined
    const settle = (): void => {
      if (released) return
      released = true
      if (this.held > 0) this.held--
      if (leaseTimer) {
        clearTimeout(leaseTimer)
        leaseTimer = undefined
      }
      releaseRaw()
    }

    let onAbort: (() => void) | undefined
    let counted = true
    try {
      const waits: Array<Promise<void>> = [previous]
      if (signal) {
        waits.push(new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason ?? new Error('请求已取消'))
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        }))
      }
      if (options.maxWaitMs && options.maxWaitMs > 0) {
        const { maxWaitMs } = options
        waits.push(new Promise<never>((_, reject) => {
          waitTimer = setTimeout(() => reject(new Error(`等待锁超过 ${maxWaitMs}ms，已放弃排队`)), maxWaitMs)
          unrefTimer(waitTimer)
        }))
      }
      await (waits.length === 1 ? waits[0]! : Promise.race(waits))
      signal?.throwIfAborted()
      this.waiters--
      counted = false
      this.held++

      if (options.maxHoldMs && options.maxHoldMs > 0) {
        const { maxHoldMs } = options
        const heldAt = Date.now()
        leaseTimer = setTimeout(() => {
          if (released) return
          const heldMs = Date.now() - heldAt
          console.warn(
            `[async-lock] 锁租约到点强制释放：已持有 ${Math.round(heldMs / 1000)}s，排队 ${this.waiters} 个请求。`
            + '持有者未按时释放（典型原因：宿主放弃生成器后 finally 未执行），强制释放以恢复服务。',
          )
          options.onLeak?.({ heldMs, waiters: this.waiters })
          settle()
        }, maxHoldMs)
        unrefTimer(leaseTimer)
      }
      return settle
    } catch (error) {
      if (counted) this.waiters--
      // 放弃排队时必须解开自己的 gate，否则 tail 链会一直等着它。
      settle()
      throw error
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      if (waitTimer) clearTimeout(waitTimer)
    }
  }
}

/** Node 的 timer 有 unref()；浏览器/边缘运行时没有，安全降级。 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.()
}
