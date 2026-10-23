/**
 * 回合间隔（pacing）：上一轮网页回合**结束**到下一次真正发请求之间要隔多久。
 *
 * 为什么单独一个模块：这段逻辑要被离线回归直接调用，不能藏在 Playwright 通道里。
 *
 * 设计口径（来自竞品实测）：
 * - 从「上次请求结束」起算，而不是从「上次请求开始」——否则长回合（几分钟）之后
 *   下一轮可以立刻发，节拍仍然是 0 间隔；
 * - 区间随机而不是固定值——固定延迟的方差≈0 本身就是最明显的机器特征；
 * - 第一次请求（`lastEndedAt <= 0`）不等待，否则每次重启都要白等。
 */

/** 夹到 0 以上的安全整数毫秒。 */
function clampMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/**
 * 计算本轮还需要等待多久才能发请求。
 *
 * @param lastEndedAt 上一次网页回合结束的时间戳（0 / 负数 = 还没有过回合）
 * @param now 当前时间戳
 * @param min 间隔下限（毫秒）
 * @param max 间隔上限（毫秒）；与 min 顺序颠倒也能工作
 * @param random 0~1 的随机源，默认 Math.random（测试可注入固定值）
 */
export function computeTurnGap(
  lastEndedAt: number,
  now: number,
  min: number,
  max: number,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(lastEndedAt) || lastEndedAt <= 0) return 0
  const lo = clampMs(Math.min(min, max))
  const hi = clampMs(Math.max(min, max))
  if (hi === 0) return 0
  const ratio = Math.min(1, Math.max(0, random()))
  const target = lo + ratio * (hi - lo)
  const elapsed = Math.max(0, now - lastEndedAt)
  return Math.max(0, Math.round(target - elapsed))
}

/**
 * 记录「上一次网页回合结束的时刻」，进程级共享。
 *
 * 共享而不是放在通道实例上的理由与账号冷却相同：热重载或重建通道不该让节拍归零，
 * 否则「改一次配置」就等于把间隔抹平一次。
 */
export class TurnPacer {
  private lastEndedAt = 0

  /** 上一次回合结束时间戳；0 表示本进程还没跑过回合。 */
  lastEnd(): number {
    return this.lastEndedAt
  }

  /** 回合结束时调用（成功失败都算——失败的请求同样消耗了账号配额）。 */
  noteEnded(at: number = Date.now()): void {
    if (Number.isFinite(at) && at > 0) this.lastEndedAt = at
  }

  /** 仅供测试：把头清零。 */
  reset(): void {
    this.lastEndedAt = 0
  }
}

let shared: TurnPacer | undefined

/** 进程级单例（账号只有一个，节拍也该只有一条）。 */
export function sharedPacer(): TurnPacer {
  shared ??= new TurnPacer()
  return shared
}

/** 仅供测试：丢弃单例。 */
export function resetSharedPacer(): void {
  shared = undefined
}
