/**
 * 调用台账：按天记录「往网页发过几次请求、间隔多少、失败多少」的**元信息**。
 *
 * 为什么要有它：频控与临时封禁的判据是**请求密度**，而插件自己最该回答的两个问题是
 * 「我最近到底发了多少次」和「最短间隔是多少」。没有台账时只能靠翻日志数时间戳，
 * 用户报「怎么老是被限」根本无法核对。
 *
 * 边界（刻意做窄）：
 * - 只记元信息：时间戳、结果、错误码、耗时、用途分类。**不记对话内容、不记凭证**。
 * - 只保留近 N 天（默认 7 天），写入时顺手裁剪。
 * - 写失败一律吞掉：台账是观测工具，绝不能因为它写不了而影响真实发送。
 *
 * 这份实现参照竞品 `dsh-deepseek-web-login` 的调用台账（它按天记录并统计相邻间隔
 * 的中位/p90/最短，且**只统计 `purpose === 'chat'`**，把会话标题这类旁路排除掉，
 * 否则统计会被高频小请求带偏）。
 *
 * @module dsh-deepseek-web/ledger
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 一次调用的目的分类：只有 chat 参与「对话间隔」统计。 */
export type LedgerPurpose = 'chat' | 'auxiliary' | 'review'

export interface LedgerEntry {
  /** 调用开始时刻（毫秒时间戳）。 */
  at: number
  purpose: LedgerPurpose
  /** 结果：成功 / 失败（失败时带分类）。 */
  outcome: 'ok' | 'failed'
  /** 失败分类（成功时没有）。 */
  failure?: 'rate-limit' | 'account-blocked' | 'login' | 'network' | 'timeout' | 'other'
  /** 错误码（便于对账，不含 message）。 */
  code?: string
  /** 本轮总耗时（毫秒）。 */
  durationMs?: number
}

export interface LedgerDay {
  /** `YYYY-MM-DD`（本地日期，用户看的是本地时间）。 */
  date: string
  entries: LedgerEntry[]
}

export interface LedgerFile {
  version: 1
  days: LedgerDay[]
}

/** 间隔统计：只对 chat 的**成功**调用计算，按时间升序取相邻差。 */
export interface IntervalStats {
  count: number
  medianMs: number
  p90Ms: number
  minMs: number
}

const RETENTION_DAYS = 7

/** 本地日期键 `YYYY-MM-DD`（不用 UTC：用户看的是本地时间，跨时区会错一天）。 */
export function localDateKey(at: number): string {
  const date = new Date(at)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 分位数（线性插值），`ratio` 取 0~1。空数组返回 0。 */
export function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  const clamped = Math.min(1, Math.max(0, ratio))
  const position = (sorted.length - 1) * clamped
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  const weight = position - lower
  return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight)
}

/**
 * 相邻对话间隔统计。
 *
 * 只统计 `purpose === 'chat'` 且成功的调用：失败的重试会把间隔压得很小，
 * 混进去会让「最短间隔」变成一条无意义的 2 秒。最短间隔是这里最关键的指标——
 * 连环请求正是账号被判机器行为的最直接证据。
 */
export function intervalStats(entries: readonly LedgerEntry[]): IntervalStats {
  const stamps = entries
    .filter(entry => entry.purpose === 'chat' && entry.outcome === 'ok')
    .map(entry => entry.at)
    .sort((a, b) => a - b)
  if (stamps.length < 2) return { count: 0, medianMs: 0, p90Ms: 0, minMs: 0 }
  const gaps: number[] = []
  for (let index = 1; index < stamps.length; index++) gaps.push(stamps[index] - stamps[index - 1])
  return {
    count: gaps.length,
    medianMs: percentile(gaps, 0.5),
    p90Ms: percentile(gaps, 0.9),
    minMs: Math.min(...gaps),
  }
}

/** 失败分布：按分类计数，便于回答「失败主要是限流还是掉登录」。 */
export function failureBreakdown(entries: readonly LedgerEntry[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of entries) {
    if (entry.outcome !== 'failed') continue
    const key = entry.failure ?? 'other'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/** 按天汇总，供设置页卡片展示。 */
export interface LedgerSummary {
  days: Array<{
    date: string
    total: number
    chat: number
    failed: number
    intervals: IntervalStats
  }>
  /** 近 N 天合计。 */
  totals: { total: number; chat: number; failed: number }
  intervals: IntervalStats
  failures: Record<string, number>
}

export function summarize(entries: readonly LedgerEntry[]): LedgerSummary {
  const byDate = new Map<string, LedgerEntry[]>()
  for (const entry of entries) {
    const key = localDateKey(entry.at)
    const bucket = byDate.get(key)
    if (bucket === undefined) byDate.set(key, [entry])
    else bucket.push(entry)
  }
  const days = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, list]) => ({
      date,
      total: list.length,
      chat: list.filter(entry => entry.purpose === 'chat').length,
      failed: list.filter(entry => entry.outcome === 'failed').length,
      intervals: intervalStats(list),
    }))
  return {
    days,
    totals: {
      total: entries.length,
      chat: entries.filter(entry => entry.purpose === 'chat').length,
      failed: entries.filter(entry => entry.outcome === 'failed').length,
    },
    intervals: intervalStats(entries),
    failures: failureBreakdown(entries),
  }
}

/** 裁掉超期日并合并新条目（纯函数，便于离线断言）。 */
export function mergeEntries(
  previous: readonly LedgerEntry[],
  next: readonly LedgerEntry[],
  now: number,
  retentionDays = RETENTION_DAYS,
): LedgerEntry[] {
  const cutoff = now - retentionDays * 24 * 60 * 60_000
  return [...previous, ...next].filter(entry => entry.at >= cutoff)
}

/**
 * 落盘台账。
 *
 * 与 `session-state.ts` 同款做法：串行队列 + 临时文件 + rename 原子替换。
 * 台账是跨进程共享的（热重载、重启后还要看历史），所以内存里也保留一份。
 */
export class Ledger {
  private readonly file: string
  private entries: LedgerEntry[] = []
  private loaded = false
  private queue: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly retentionDays: number

  constructor(options: { file: string; now?: () => number; retentionDays?: number }) {
    this.file = options.file
    this.now = options.now ?? Date.now
    this.retentionDays = options.retentionDays ?? RETENTION_DAYS
  }

  static defaultFile(appDataRoot: string): string {
    return join(appDataRoot, 'DshDeepSeekWeb', 'call-ledger.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const days = (parsed as LedgerFile | undefined)?.days
      if (!Array.isArray(days)) return
      const restored: LedgerEntry[] = []
      for (const day of days) {
        if (!Array.isArray((day as LedgerDay).entries)) continue
        for (const entry of (day as LedgerDay).entries) {
          if (typeof entry?.at === 'number') restored.push(entry)
        }
      }
      this.entries = mergeEntries(restored, [], this.now(), this.retentionDays)
    } catch {
      // 文件不存在或损坏：从空台账开始，绝不影响真实发送
    }
  }

  /** 记一次调用（内存里立即生效，落盘串行）。 */
  async record(entry: LedgerEntry): Promise<void> {
    await this.load()
    this.entries = mergeEntries(this.entries, [entry], this.now(), this.retentionDays)
    const snapshot = [...this.entries]
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true })
        const byDate = new Map<string, LedgerEntry[]>()
        for (const item of snapshot) {
          const key = localDateKey(item.at)
          const bucket = byDate.get(key)
          if (bucket === undefined) byDate.set(key, [item])
          else bucket.push(item)
        }
        const payload: LedgerFile = {
          version: 1,
          days: [...byDate.entries()].map(([date, list]) => ({ date, entries: list })),
        }
        const temp = `${this.file}.${process.pid}.tmp`
        await writeFile(temp, `${JSON.stringify(payload, undefined, 2)}\n`, 'utf8')
        await rename(temp, this.file)
      })
      .catch(() => {
        // 台账写失败不改变任何真实行为
      })
    await this.queue
  }

  /** 当前窗口内的条目（只读副本）。 */
  list(): LedgerEntry[] {
    return [...this.entries]
  }

  summary(): LedgerSummary {
    return summarize(this.entries)
  }
}
