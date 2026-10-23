/**
 * 离线回归：回合间隔（turn gap）。
 *
 * 覆盖：
 * 1. 第一次请求（没有上一轮）不等；
 * 2. 间隔从「上一轮结束」起算：已经过去的时间要扣掉；
 * 3. 区间随机且落在 [min, max] 内，不与固定值相等（方差不为零）；
 * 4. min/max 传反、负数、0 都能正常降级；
 * 5. TurnPacer 记账：只认正数时间戳，reset 后回到「没有上一轮」；
 * 6. 单例共享：同一进程里两次拿到的是同一个对象。
 *
 * 运行：npx tsx tools/pacing-check.ts
 */
import assert from 'node:assert/strict'
import {
  computeTurnGap,
  resetSharedPacer,
  sharedPacer,
  TurnPacer,
} from '../src/pacing.ts'

let failed = 0
const fail = (message: string): void => {
  failed += 1
  console.error(`FAIL: ${message}`)
}
const pass = (message: string): void => {
  console.log(`PASS ${message}`)
}
const check = (name: string, fn: () => void): void => {
  try {
    fn()
    pass(name)
  } catch (error) {
    fail(`${name} —— ${(error as Error).message}`)
  }
}

// 1. 没有上一轮 → 不等
check('首次请求不等待', () => {
  assert.equal(computeTurnGap(0, Date.now(), 2_000, 4_000), 0)
  assert.equal(computeTurnGap(-1, Date.now(), 2_000, 4_000), 0)
  assert.equal(computeTurnGap(Number.NaN, Date.now(), 2_000, 4_000), 0)
})

// 2. 从上一轮结束起算：时间已经过去的部分要扣掉
check('按上一轮结束时刻扣减已过去的时间', () => {
  const now = 1_000_000
  // 随机源固定在 0 时目标 = 下限 2000；已过去 500ms → 还要等 1500
  assert.equal(computeTurnGap(now - 500, now, 2_000, 4_000, () => 0), 1_500)
  // 已过去 3000ms，超过目标 → 不再等
  assert.equal(computeTurnGap(now - 3_000, now, 2_000, 4_000, () => 0), 0)
  // 已过去 10 秒，超过上限 → 0
  assert.equal(computeTurnGap(now - 10_000, now, 2_000, 4_000, () => 1), 0)
})

// 3. 随机区间：两端都要能取到，且中间不固定
check('随机落在区间内且方差不为零', () => {
  const now = 1_000_000
  assert.equal(computeTurnGap(now - 1, now, 2_000, 4_000, () => 0), 1_999)
  assert.equal(computeTurnGap(now - 1, now, 2_000, 4_000, () => 1), 3_999)
  const mid = computeTurnGap(now - 1, now, 2_000, 4_000, () => 0.5)
  assert.equal(mid, 2_999)
  const values = new Set<number>()
  for (let i = 0; i < 50; i += 1) values.add(computeTurnGap(now - 1, now, 2_000, 4_000))
  assert.ok(values.size > 10, `50 次采样只得到 ${values.size} 个不同值，像是固定值`)
})

// 4. 边界：上下限传反、负数、全 0
check('边界值降级', () => {
  const now = 1_000_000
  assert.equal(computeTurnGap(now, now, 4_000, 2_000, () => 0), 2_000)
  assert.equal(computeTurnGap(now, now, -500, 2_000, () => 0), 0)
  assert.equal(computeTurnGap(now, now, 0, 0, () => 0.5), 0)
  assert.equal(computeTurnGap(now, now, 2_000, Number.NaN, () => 0), 0)
})

// 5. TurnPacer 记账
check('TurnPacer 只记正数时间戳', () => {
  const pacer = new TurnPacer()
  assert.equal(pacer.lastEnd(), 0)
  pacer.noteEnded(0)
  assert.equal(pacer.lastEnd(), 0)
  pacer.noteEnded(-5)
  assert.equal(pacer.lastEnd(), 0)
  pacer.noteEnded(Number.NaN)
  assert.equal(pacer.lastEnd(), 0)
  pacer.noteEnded(123)
  assert.equal(pacer.lastEnd(), 123)
  pacer.reset()
  assert.equal(pacer.lastEnd(), 0)
})

// 6. 单例共享
check('单例共享且可重置', () => {
  resetSharedPacer()
  const a = sharedPacer()
  const b = sharedPacer()
  assert.equal(a, b)
  a.noteEnded(999)
  assert.equal(b.lastEnd(), 999)
  resetSharedPacer()
  assert.notEqual(sharedPacer(), a)
})

if (failed > 0) {
  console.error(`\n回合间隔校验失败 ${failed} 项`)
  process.exit(1)
}
console.log('\nOK（回合间隔：首轮不等 + 起算点 + 随机区间 + 边界 + 单例）')
