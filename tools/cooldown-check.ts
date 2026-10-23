/**
 * 离线回归：账号级冷却与失败分类。
 *
 * 要防的失败是「一次限流把整台机器锁死」和「限流后其它会话继续猛撞网页」这两头：
 * 1. 只有限流/封禁进冷却，断网、超时、5xx 一律不进（错一次不该停十分钟）；
 * 2. 冷却期内 remainingMs 递减、到期自动清零；
 * 3. 更长的冷却不能被更短的覆盖（反复小重试不能提前解锁）；
 * 4. 成功一轮可以提前解除（网页已经愿意回答，就没必要继续锁）。
 *
 * 时钟全部注入，用例不会真的等待。
 */
import assert from 'node:assert/strict'
import {
  AccountCooldown,
  classifyFailureCode,
  cooldownForFailure,
  resetSharedCooldown,
  sharedCooldown,
} from '../src/cooldown.ts'

// ---- 1. 错误码归类 ----
{
  assert.equal(classifyFailureCode('WEB_RATE_LIMITED'), 'rate-limit')
  assert.equal(classifyFailureCode('WEB_ACCOUNT_COOLDOWN'), 'rate-limit')
  assert.equal(classifyFailureCode('WEB_ACCOUNT_BLOCKED'), 'account-blocked')
  assert.equal(classifyFailureCode('WEB_LOGIN_REQUIRED'), 'login')
  assert.equal(classifyFailureCode('WEB_LOGIN_EXPIRED'), 'login')
  assert.equal(classifyFailureCode('WEB_PAGE_CLOSED'), 'network')
  assert.equal(classifyFailureCode('BROWSER_NOT_FOUND'), 'network')

  // 这些必须是 other：错进冷却会把正常失败变成十分钟不可用
  for (const code of ['WEB_TURN_TIMEOUT', 'WEB_HTTP_ERROR', 'WEB_EMPTY_RESPONSE', 'UNKNOWN_MODEL', '', undefined]) {
    assert.equal(classifyFailureCode(code), 'other', `不应归类为限流：${String(code)}`)
  }

  // 大小写与空白要能容忍
  assert.equal(classifyFailureCode(' web_rate_limited '), 'rate-limit')
}

// ---- 2. 冷却时长策略 ----
{
  const policy = { afterRateLimitMs: 600_000, afterAccountBlockedMs: 3_600_000 }
  assert.equal(cooldownForFailure('rate-limit', policy), 600_000)
  assert.equal(cooldownForFailure('account-blocked', policy), 3_600_000)
  for (const kind of ['login', 'network', 'other'] as const) {
    assert.equal(cooldownForFailure(kind, policy), 0, `${kind} 不应触发冷却`)
  }
  // 策略里给 0 就是不锁
  assert.equal(cooldownForFailure('rate-limit', { afterRateLimitMs: 0, afterAccountBlockedMs: 0 }), 0)
  // 负数按 0 处理，不能变成"负冷却"把判断搞反
  assert.equal(cooldownForFailure('rate-limit', { afterRateLimitMs: -5, afterAccountBlockedMs: -5 }), 0)
}

// ---- 3. 计时器语义 ----
{
  let now = 1_000
  const clock = new AccountCooldown(() => now)

  assert.equal(clock.remainingMs(), 0, '初始不在冷却')
  assert.deepEqual(clock.snapshot(), { until: 0 })

  clock.block(600_000, '网页提示发送过于频繁')
  assert.equal(clock.remainingMs(), 600_000)
  assert.equal(clock.snapshot().reason, '网页提示发送过于频繁')

  now += 100_000
  assert.equal(clock.remainingMs(), 500_000, '应随时钟递减')

  // 更短的冷却不能覆盖更长的
  clock.block(1_000, '短冷却')
  assert.equal(clock.remainingMs(), 500_000, '短冷却不应提前解锁')
  assert.equal(clock.snapshot().reason, '网页提示发送过于频繁')

  // 更长的可以延长
  clock.block(900_000, '账号被限')
  assert.equal(clock.remainingMs(), 900_000)
  assert.equal(clock.snapshot().reason, '账号被限')

  // 到期自动清零并清掉原因
  now += 900_000
  assert.equal(clock.remainingMs(), 0)
  assert.deepEqual(clock.snapshot(), { until: 0 })

  // 0 或负数不产生冷却
  clock.block(0, 'x')
  assert.equal(clock.remainingMs(), 0)

  // 成功一轮提前解除
  clock.block(600_000, 'y')
  assert.equal(clock.remainingMs(), 600_000)
  clock.clear()
  assert.equal(clock.remainingMs(), 0)
}

// ---- 4. 进程级单例：热重载不能绕过冷却 ----
{
  resetSharedCooldown()
  const first = sharedCooldown()
  first.block(600_000, '限流')
  const second = sharedCooldown()
  assert.equal(first, second, '应返回同一个实例')
  assert.equal(second.remainingMs() > 0, true, '新实例应看到同一份冷却状态')
  resetSharedCooldown()
  assert.notEqual(sharedCooldown(), first, 'reset 后应是新实例')
}

console.info('OK（账号冷却：归类 + 时长策略 + 计时语义 + 单例共享）')
