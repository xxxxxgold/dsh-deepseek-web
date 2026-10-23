/**
 * 离线回归：调用台账（间隔统计、分位数、失败分布、按天汇总、保留期裁剪）。
 *
 * 要防的失败是「台账自己把统计做错」——用户拿着错的「最短间隔」去判断有没有连环请求，
 * 比没有台账更糟。所以这里逐条固定语义：
 * 1. 间隔只算 chat + 成功（失败重试会把最短间隔压成无意义的 2 秒）；
 * 2. 分位数按线性插值，单元素与空数组有确定结果；
 * 3. 保留期按时间戳裁剪，跨天也能正确归档；
 * 4. 落盘往返后条目不变（含损坏文件时从空台账开始）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  Ledger,
  failureBreakdown,
  intervalStats,
  localDateKey,
  mergeEntries,
  percentile,
  summarize,
  type LedgerEntry,
} from '../src/ledger.ts'

const minute = 60_000

const entry = (at: number, overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  at,
  purpose: 'chat',
  outcome: 'ok',
  ...overrides,
})

// ---- 1. 间隔统计只算 chat + 成功 ----
{
  const entries = [
    entry(0),
    entry(5 * minute),
    // 失败的重试不参与（否则最短间隔会被压到 1 秒）
    entry(5 * minute + 1_000, { outcome: 'failed', failure: 'rate-limit' }),
    // 辅助请求（会话标题/摘要）不参与
    entry(7 * minute, { purpose: 'auxiliary' }),
    entry(20 * minute),
  ]
  const stats = intervalStats(entries)
  assert.equal(stats.count, 2, '只有 3 次成功 chat，应产生 2 个间隔')
  assert.equal(stats.minMs, 5 * minute)
  assert.equal(stats.medianMs, 10 * minute)
  assert.equal(stats.p90Ms, 14 * minute)

  // 少于两次无法算间隔
  assert.deepEqual(intervalStats([entry(0)]), { count: 0, medianMs: 0, p90Ms: 0, minMs: 0 })
  assert.deepEqual(intervalStats([]), { count: 0, medianMs: 0, p90Ms: 0, minMs: 0 })
}

// ---- 2. 分位数 ----
{
  assert.equal(percentile([], 0.5), 0)
  assert.equal(percentile([7], 0.9), 7)
  assert.equal(percentile([10, 20], 0.5), 15)
  assert.equal(percentile([0, 10, 20, 30], 0.5), 15)
  assert.equal(percentile([0, 10, 20, 30], 0.9), 27)
  // 越界比例要夹住，不能返回 undefined
  assert.equal(percentile([1, 2, 3], -1), 1)
  assert.equal(percentile([1, 2, 3], 2), 3)
}

// ---- 3. 失败分布 ----
{
  const entries = [
    entry(0, { outcome: 'failed', failure: 'rate-limit' }),
    entry(1, { outcome: 'failed', failure: 'rate-limit' }),
    entry(2, { outcome: 'failed', failure: 'login' }),
    entry(3, { outcome: 'failed' }),
    entry(4),
  ]
  assert.deepEqual(failureBreakdown(entries), { 'rate-limit': 2, login: 1, other: 1 })
}

// ---- 4. 按天汇总 ----
{
  const day1 = new Date(2026, 9, 21, 10, 0, 0).getTime()
  const day2 = new Date(2026, 9, 22, 10, 0, 0).getTime()
  assert.equal(localDateKey(day1), '2026-10-21')

  const summary = summarize([
    entry(day1),
    entry(day1 + 10 * minute),
    entry(day2),
    entry(day2 + 30 * minute, { outcome: 'failed', failure: 'timeout' }),
  ])
  assert.equal(summary.days.length, 2)
  // 新的在前
  assert.equal(summary.days[0].date, '2026-10-22')
  assert.equal(summary.days[0].total, 2)
  assert.equal(summary.days[0].failed, 1)
  assert.equal(summary.days[1].date, '2026-10-21')
  assert.equal(summary.totals.total, 4)
  assert.equal(summary.totals.chat, 4)
  assert.equal(summary.totals.failed, 1)
  assert.deepEqual(summary.failures, { timeout: 1 })
}

// ---- 5. 保留期裁剪 ----
{
  const now = 10 * 24 * 60 * minute
  const kept = mergeEntries(
    [entry(now - 1 * 24 * 60 * minute), entry(now - 30 * 24 * 60 * minute)],
    [entry(now)],
    now,
    7,
  )
  assert.equal(kept.length, 2, '超期条目应被裁掉')
  assert.deepEqual(kept.map(item => item.at), [now - 1 * 24 * 60 * minute, now])
}

// ---- 6. 落盘往返 + 损坏文件降级 ----
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-ledger-'))
  const file = path.join(dir, 'call-ledger.json')
  try {
    const now = new Date(2026, 9, 22, 12, 0, 0).getTime()
    const ledger = new Ledger({ file, now: () => now })
    await ledger.record(entry(now - minute))
    await ledger.record(entry(now, { outcome: 'failed', failure: 'rate-limit', code: 'WEB_RATE_LIMITED' }))
    assert.equal(ledger.list().length, 2)

    // 新实例应能读回
    const reopened = new Ledger({ file, now: () => now })
    await reopened.load()
    assert.equal(reopened.list().length, 2)
    assert.equal(reopened.list()[1].code, 'WEB_RATE_LIMITED')

    // 损坏文件：从空台账开始，不抛错
    await writeFile(file, '{ not json', 'utf8')
    const broken = new Ledger({ file, now: () => now })
    await broken.load()
    assert.deepEqual(broken.list(), [])
    await broken.record(entry(now))
    assert.equal(broken.list().length, 1, '损坏后仍应能继续记录')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.info('OK（调用台账：间隔统计 + 分位数 + 失败分布 + 按天汇总 + 保留期 + 落盘）')
