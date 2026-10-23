/**
 * 登录态探活调度的离线回归：排期、串行、停止、异常降级。
 *
 * 用假定时器把 30 分钟的间隔压成同步 tick，不依赖真实时间。
 */

import assert from 'node:assert/strict'
import {
  DEFAULT_PROBE_INITIAL_DELAY_MS,
  DEFAULT_PROBE_INTERVAL_MS,
  LoginProbeScheduler,
  summarizeLoginProbe,
  type LoginProbeResult,
  type LoginProbeTimers,
} from '../src/login-probe.ts'

interface Pending {
  handler: () => void
  delayMs: number
  cancelled: boolean
}

function fakeTimers(): { timers: LoginProbeTimers; pending: Pending[]; fire: () => Promise<void> } {
  const pending: Pending[] = []
  return {
    pending,
    timers: {
      schedule(handler, delayMs) {
        const entry: Pending = { handler, delayMs, cancelled: false }
        pending.push(entry)
        return entry
      },
      cancel(handle) {
        const entry = handle as Pending
        entry.cancelled = true
      },
    },
    async fire() {
      const entry = pending.find(item => !item.cancelled)
      assert.ok(entry, '应有待触发的探活')
      entry.cancelled = true
      entry.handler()
      // 让 run() 的 Promise 链走完
      await new Promise(resolve => setTimeout(resolve, 0))
    },
  }
}

// ---- 默认值 ----
assert.equal(DEFAULT_PROBE_INITIAL_DELAY_MS, 20_000, '首次延迟默认 20 秒')
assert.equal(DEFAULT_PROBE_INTERVAL_MS, 1_800_000, '探活间隔默认 30 分钟')

// ---- 排期：启动后 20 秒一次，之后按间隔 ----
{
  const clock = fakeTimers()
  let calls = 0
  const results: LoginProbeResult[] = []
  const scheduler = new LoginProbeScheduler({
    target: { probeLogin: async () => { calls += 1; return { status: 'ok', checkedAt: calls } } },
    timers: clock.timers,
    intervalMs: 1_000,
    onResult: result => results.push(result),
  })
  scheduler.start()
  assert.equal(clock.pending.length, 1)
  assert.equal(clock.pending[0]!.delayMs, 20_000, '首次排期用 initialDelayMs')
  await clock.fire()
  assert.equal(calls, 1)
  assert.equal(results.length, 1, '每次探活后回调一次')
  assert.equal(clock.pending.filter(item => !item.cancelled).length, 1, '应排下一次')
  assert.equal(clock.pending.filter(item => !item.cancelled)[0]!.delayMs, 1_000, '之后按 intervalMs')
  await clock.fire()
  assert.equal(calls, 2)
  assert.equal(scheduler.last()?.status, 'ok')
  scheduler.stop()
  assert.equal(clock.pending.filter(item => !item.cancelled).length, 0, 'stop 后不应有待触发')
}

// ---- interval = 0：只探一次 ----
{
  const clock = fakeTimers()
  let calls = 0
  const scheduler = new LoginProbeScheduler({
    target: { probeLogin: async () => { calls += 1; return { status: 'ok', checkedAt: calls } } },
    timers: clock.timers,
    intervalMs: 0,
  })
  scheduler.start()
  await clock.fire()
  assert.equal(calls, 1)
  assert.equal(clock.pending.filter(item => !item.cancelled).length, 0, 'interval=0 不排下一次')
}

// ---- 探活抛错 → unknown，不中断排期 ----
{
  const clock = fakeTimers()
  const scheduler = new LoginProbeScheduler({
    target: { probeLogin: async () => { throw new Error('boom') } },
    timers: clock.timers,
    intervalMs: 1_000,
  })
  scheduler.start()
  await clock.fire()
  assert.equal(scheduler.last()?.status, 'unknown')
  assert.match(scheduler.last()?.detail ?? '', /boom/)
  assert.equal(clock.pending.filter(item => !item.cancelled).length, 1, '异常后仍要排下一次')
  scheduler.stop()
}

// ---- 并发：上一次没结束时不并发第二次 ----
{
  let resolveFirst: ((value: LoginProbeResult) => void) | undefined
  let calls = 0
  const scheduler = new LoginProbeScheduler({
    target: {
      probeLogin: () => {
        calls += 1
        if (calls === 1) {
          return new Promise<LoginProbeResult>(resolve => { resolveFirst = resolve })
        }
        return Promise.resolve({ status: 'ok', checkedAt: calls })
      },
    },
    timers: { schedule: () => 1, cancel: () => {} },
    intervalMs: 1_000,
  })
  const first = scheduler.probeNow()
  const second = await scheduler.probeNow()
  assert.equal(calls, 1, '并发进入不应重复探活')
  assert.equal(second.status, 'unknown')
  assert.match(second.detail ?? '', /还没结束/)
  resolveFirst?.({ status: 'ok', checkedAt: 1 })
  assert.equal((await first).status, 'ok')
}

// ---- 文案口径 ----
assert.equal(summarizeLoginProbe(undefined), '还没探活')
assert.equal(summarizeLoginProbe({ status: 'ok', checkedAt: 1 }), '登录态正常')
assert.match(summarizeLoginProbe({ status: 'expired', checkedAt: 1, detail: '页面已跳到登录入口' }), /已失效/)
assert.match(summarizeLoginProbe({ status: 'unknown', checkedAt: 1 }), /无法判断/)

console.log('OK（登录探活：排期 + 只探一次 + 异常降级 + 并发抑制 + 文案）')
