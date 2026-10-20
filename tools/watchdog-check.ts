/**
 * 校验「卡住变明确失败」的看门狗逻辑（离线可复现，不需要浏览器）。
 *
 * 背景：`response.finished()` / `response.body()` 没有超时参数，网页流一旦卡住
 * 这两个 promise 会一直挂着，整轮就“卡死、不会重新获取”。`withTimeout()` 是
 * 把这个无限等待变成有限失败的唯一入口，所以它自己的行为必须先钉死：
 *
 * 1. 正常完成时原样返回结果，不做任何包装或延迟；
 * 2. 超时抛出带指定错误码的 LlmError（上层据此判断“值得重连重试”）；
 * 3. 被包装的 promise 自己失败时，原始错误原样冒泡，不被超时错误覆盖；
 * 4. 自定义失败同样冒泡，不会被吞成成功。
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { withTimeout } from '../src/browser-shared.ts'

let failures = 0
function check(name: string, pass: boolean, detail = ''): void {
  if (!pass) {
    failures += 1
    console.error(`FAIL: ${name}${detail ? `\n  ${detail}` : ''}`)
  } else {
    console.log(`ok: ${name}`)
  }
}

/** 等一个必然落定的 promise，拿到它的结果而不是抛出去。 */
async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

async function main(): Promise<void> {
  // ---- 1. 正常完成：原样返回，不额外拖延 ----
  {
    const startedAt = Date.now()
    const value = await withTimeout(Promise.resolve('完整回复'), 5_000, 'KIMI_STREAM_STALLED', '不该触发')
    const elapsed = Date.now() - startedAt
    check('正常完成原样返回', value === '完整回复', `实际：${String(value)}`)
    check('正常完成不额外拖延', elapsed < 500, `耗时：${elapsed}ms`)
  }

  // ---- 2. 超时：抛指定错误码的 LlmError ----
  {
    const hung = new Promise<string>(() => {}) // 永远不落定，模拟卡住的流
    const outcome = await settle(withTimeout(hung, 120, 'KIMI_STREAM_STALLED', 'kimi: 等待回复流结束超时'))
    const caught = outcome.ok ? undefined : outcome.error
    check('超时会失败而不是一直挂着', outcome.ok === false)
    check('超时抛的是 LlmError', caught instanceof LlmError, `实际类型：${caught?.constructor?.name}`)
    check('超时带着稳定错误码', (caught as { code?: string } | undefined)?.code === 'KIMI_STREAM_STALLED',
      `实际：${(caught as { code?: string } | undefined)?.code}`)
    check('超时带人话说明', caught instanceof Error && caught.message.includes('等待回复流结束超时'),
      `实际：${caught instanceof Error ? caught.message : String(caught)}`)
  }

  // ---- 3. 内部失败原样冒泡，不被超时覆盖 ----
  {
    const boom = Promise.reject(new Error('网页返回 500'))
    const outcome = await settle(withTimeout(boom, 5_000, 'KIMI_STREAM_STALLED', '不该触发'))
    check('内部失败会冒泡', outcome.ok === false)
    check('冒泡的是原始错误', outcome.ok === false && (outcome.error as Error)?.message === '网页返回 500',
      `实际：${outcome.ok === false ? String((outcome.error as Error)?.message) : '成功'}`)
  }

  // ---- 4. 超时与正常完成竞速：先完成的赢 ----
  {
    const quick = new Promise<number>(resolve => setTimeout(() => resolve(42), 30))
    const outcome = await settle(withTimeout(quick, 5_000, 'KIMI_STREAM_STALLED', '不该触发'))
    check('先完成的不受超时影响', outcome.ok === true && outcome.value === 42)
  }

  // ---- 5. ms <= 0 视为不设超时（0 = 关闭）----
  {
    const value = await withTimeout(Promise.resolve('无超时'), 0, 'KIMI_STREAM_STALLED', '不该触发')
    check('ms<=0 时不加超时', value === '无超时')
  }

  if (failures > 0) {
    console.error(`\n${failures} 项失败`)
    process.exit(1)
  }
  console.log('\n看门狗超时检查全部通过')
}

await main()
