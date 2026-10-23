/**
 * 离线回归：跨回合重试预算 + 可重试性分类。
 *
 * 要防的失败是「每回合都合规、合起来是机器密度」：宿主连续续跑时，单回合的
 * maxRetries 会叠加成几十次请求。预算必须活在回合之外，且有 TTL。
 */
import assert from 'node:assert/strict'
import {
  RETRY_BUDGET,
  TurnRetryBudget,
  resetSharedRetryBudget,
  retryability,
  sharedRetryBudget,
} from '../src/retry-policy.ts'

// ---- 1. 预算：窗口内计数、用尽拒绝 ----
{
  let now = 0
  const budget = new TurnRetryBudget({ now: () => now, ttlMs: 1_000, max: 3 })
  const key = 'deepseek-web:default'

  assert.equal(budget.remaining(key), 3)
  assert.equal(budget.take(key), true)
  assert.equal(budget.take(key), true)
  assert.equal(budget.take(key), true)
  assert.equal(budget.remaining(key), 0)
  assert.equal(budget.take(key), false, '用尽后必须拒绝')
  assert.equal(budget.used(key), 3)

  // 窗口滑过之后自动恢复
  now = 1_001
  assert.equal(budget.used(key), 0, '过期记录应被清理')
  assert.equal(budget.take(key), true)
}

// ---- 2. 预算是按 key 隔离的，且成功的 reset 能清账 ----
{
  let now = 0
  const budget = new TurnRetryBudget({ now: () => now, ttlMs: 60_000, max: 2 })
  assert.equal(budget.take('a'), true)
  assert.equal(budget.take('a'), true)
  assert.equal(budget.take('a'), false)
  // 另一个 key 不受影响（多账号/多用途互不牵连）
  assert.equal(budget.take('b'), true)

  budget.reset('a')
  assert.equal(budget.take('a'), true, 'reset 之后应重新有额度')
}

// ---- 3. max=0 表示不限 ----
{
  const budget = new TurnRetryBudget({ max: 0 })
  for (let i = 0; i < 50; i++) assert.equal(budget.take('x'), true)
  assert.equal(budget.remaining('x'), Number.POSITIVE_INFINITY)
}

// ---- 4. 默认参数与预期一致（改默认值要在这里同步，防静默漂移） ----
{
  assert.equal(RETRY_BUDGET.ttlMs, 30 * 60_000)
  assert.equal(RETRY_BUDGET.maxRetriesInWindow, 3)
}

// ---- 5. 单例共享：热重载不重置预算 ----
{
  resetSharedRetryBudget()
  const first = sharedRetryBudget()
  first.take('k')
  const second = sharedRetryBudget()
  assert.equal(first, second)
  assert.equal(second.used('k'), 1, '同一进程内应看到同一份预算')
  resetSharedRetryBudget()
  assert.notEqual(sharedRetryBudget(), first)
}

// ---- 6. 可重试性分类 ----
{
  assert.equal(retryability('WEB_TURN_TIMEOUT'), 'yes')
  assert.equal(retryability('WEB_EMPTY_RESPONSE'), 'yes')
  assert.equal(retryability('BROWSER_MANAGED_START_FAILED'), 'yes')

  assert.equal(retryability('WEB_LOGIN_REQUIRED'), 'no')
  assert.equal(retryability('WEB_RATE_LIMITED'), 'no')
  assert.equal(retryability('WEB_ACCOUNT_COOLDOWN'), 'no')
  assert.equal(retryability('WEB_UI_CHANGED'), 'no')
  assert.equal(retryability('UNKNOWN_MODEL'), 'no')

  // 没归类的不猜：审核通道失败要不要重试取决于用户是否接受降级
  assert.equal(retryability('KIMI_RESPONSE_TIMEOUT'), 'unknown')
  assert.equal(retryability(''), 'unknown')
  assert.equal(retryability(undefined), 'unknown')

  // 大小写/空白容忍
  assert.equal(retryability(' web_turn_timeout '), 'yes')
}

console.info('OK（重试预算：窗口计数 + key 隔离 + 单例 + 可重试性分类）')
