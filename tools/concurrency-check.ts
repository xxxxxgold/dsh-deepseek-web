/**
 * 离线并发回归：验证"主会话派生子代理后，两边同时请求会不会互相卡住"。
 *
 * 覆盖以下契约（全部不需要真实浏览器）：
 * 1. 跨会话并行：主会话与子代理（不同 sessionId）的网页回合必须能同时进行；
 * 2. 同会话串行：同一 sessionId 的两条流不能同时驱动网页回合（共用一个网页对话）；
 * 3. 放弃生成可回收：宿主中途放弃迭代器时，adapter 要取消网页回合并释放会话锁，
 *    后续请求不会被卡死的回合一直挡住；
 * 4. 辅助请求不排队：purpose=session-title/compaction 的请求不能排在主请求整轮后面；
 * 5. 锁租约兜底：持有者泄漏时，AsyncLock 到点强制释放，不会永久卡死；
 * 6. 并发上限排队：maxConcurrentTurns 超限后按先进先出一个个放行；
 * 7. 上限放开后恢复并行：maxConcurrentTurns=0 时只计数不排队；
 * 8. 名额池本身：FIFO 派发、release 幂等、排队可取消且不泄露名额。
 *
 * 运行：npx tsx tools/concurrency-check.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DeepSeekWebAdapter } from '../src/adapter.ts'
import { AsyncLock } from '../src/async-lock.ts'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from '../src/browser-channel.ts'
import { Config } from '../src/config.ts'
import { ConcurrencyGate } from '../src/concurrency-gate.ts'
import { liveConfig } from '../src/live-config.ts'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-concurrency-'))

function makeOptions(sessionId: string, purpose?: string): GenerateOptions {
  return {
    sessionId,
    model: 'deepseek-web-auto',
    ...purpose === undefined ? {} : { purpose },
    messages: [{ id: `${sessionId}-u1`, role: 'user', content: [{ type: 'text', text: '请给出结果' }] }],
    tools: [{
      name: 'read',
      description: '读取文件',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    }],
  } as unknown as GenerateOptions
}

function makeConfig(id: string, extra: Record<string, unknown> = {}) {
  return liveConfig(Config({
    stateFile: path.join(tempDir, `${id}.json`),
    autoCorrectMalformed: false,
    focus: { enabled: false },
    ...extra,
  }))
}

/** 记录并发度、时间窗与取消调用的假通道。 */
class TimedChannel implements BrowserChannel {
  active = 0
  maxActive = 0
  readonly maxActivePerSession = new Map<string, number>()
  private readonly activePerSession = new Map<string, number>()
  readonly turns: string[] = []
  readonly startedAt = new Map<string, number>()
  readonly endedAt = new Map<string, number>()
  readonly cancelled: string[] = []
  readonly windows: { sessionId: string; kind: 'turn' | 'isolated'; start: number; end: number }[] = []
  private readonly aborts = new Map<string, AbortController>()

  constructor(
    public holdMs: number | ((kind: 'turn' | 'isolated') => number),
    private readonly reply = '完成',
    private readonly announceProgress = false,
    /** 收到请求后立刻对外报告"已填入网页"（用于覆盖半自动/实时思考分支）。 */
    private readonly emitProgress = true,
  ) {}

  async ensureReady(): Promise<void> {}

  resetConversationGate(_sessionId?: string): void {}

  isConversationActive(_sessionId: string): boolean {
    return false
  }

  async status(): Promise<{ ready: boolean; url?: string; message?: string }> {
    return { ready: true }
  }

  async focusBrowser(): Promise<void> {}
  async focusHarness(): Promise<void> {}
  async dispose(): Promise<void> {}

  async cancelTurn(sessionId?: string): Promise<void> {
    if (sessionId !== undefined) this.cancelled.push(sessionId)
    const targets = sessionId === undefined ? [...this.aborts.values()] : [this.aborts.get(sessionId)]
    for (const abort of targets) if (abort && !abort.signal.aborted) abort.abort(new Error('cancelled'))
  }

  async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    return this.runTurn(request, 'turn')
  }

  async turnIsolated(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    return this.runTurn(request, 'isolated')
  }

  private async runTurn(request: BrowserTurnRequest, kind: 'turn' | 'isolated'): Promise<BrowserTurnResult> {
    const sessionId = request.sessionId
    const window = { sessionId, kind, start: Date.now(), end: 0 }
    this.windows.push(window)
    const holdMs = typeof this.holdMs === 'function' ? this.holdMs(kind) : this.holdMs
    this.turns.push(sessionId)
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    this.activePerSession.set(sessionId, (this.activePerSession.get(sessionId) ?? 0) + 1)
    this.maxActivePerSession.set(
      sessionId,
      Math.max(this.maxActivePerSession.get(sessionId) ?? 0, this.activePerSession.get(sessionId)!),
    )
    if (!this.startedAt.has(sessionId)) this.startedAt.set(sessionId, Date.now())

    const abort = new AbortController()
    this.aborts.set(sessionId, abort)
    if (this.emitProgress && request.onProgress) {
      // 立刻上报一次真实增量：让 adapter 在网页回合还没结束时就产出 chunk，
      // 这样测试可以在回合仍挂起时放弃迭代器（覆盖"幽灵回合"场景）。
      request.onProgress({ text: '', reasoning: '思考中' })
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, holdMs)
        const onAbort = () => {
          clearTimeout(timer)
          reject(Object.assign(new Error('网页回合已取消。'), { code: 'ABORTED' }))
        }
        if (request.signal?.aborted) onAbort()
        else request.signal?.addEventListener('abort', onAbort, { once: true })
        abort.signal.addEventListener('abort', onAbort, { once: true })
      })
      return { text: this.reply }
    } finally {
      window.end = Date.now()
      this.active--
      this.activePerSession.set(sessionId, (this.activePerSession.get(sessionId) ?? 1) - 1)
      this.endedAt.set(sessionId, Date.now())
      this.aborts.delete(sessionId)
    }
  }
}

async function consume(adapter: DeepSeekWebAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

function elapsed(from: number): number {
  return Date.now() - from
}

try {
  // ---- 1. 跨会话并行：主会话 + 子代理同时请求，网页回合必须重叠 ----
  {
    const channel = new TimedChannel(400)
    const adapter = new DeepSeekWebAdapter(makeConfig('parallel', { maxConcurrentTurns: 2 }), channel)
    const startedAt = Date.now()
    const [main, child] = await Promise.all([
      consume(adapter, makeOptions('main-session')),
      consume(adapter, makeOptions('child-agent')),
    ])
    assert.equal(main.at(-1)?.type, 'finish')
    assert.equal(child.at(-1)?.type, 'finish')
    assert.equal(channel.turns.length, 2)
    assert.equal(
      channel.maxActive,
      2,
      `主会话与子代理的网页回合必须能并行；实测最大并发 ${channel.maxActive}（=1 说明仍在共用全局锁）`,
    )
    const mainStart = channel.startedAt.get('main-session')!
    const childStart = channel.startedAt.get('child-agent')!
    assert.ok(
      Math.abs(mainStart - childStart) < 200,
      `两个会话的回合开始时间应几乎同时，实测相差 ${Math.abs(mainStart - childStart)}ms`,
    )
    assert.ok(400 <= elapsed(startedAt) && elapsed(startedAt) < 900,
      `并行时总耗时应≈单轮耗时（~400ms），实测 ${elapsed(startedAt)}ms（串行会是 ~800ms）`)
    console.log(`PASS 1 跨会话并行：maxActive=${channel.maxActive}，总耗时 ${elapsed(startedAt)}ms`)
  }

  // ---- 2. 同会话串行：同一 sessionId 的两条流不能同时驱动网页回合 ----
  {
    const channel = new TimedChannel(150)
    const adapter = new DeepSeekWebAdapter(makeConfig('serial'), channel)
    const startedAt = Date.now()
    await Promise.all([
      consume(adapter, makeOptions('same-session')),
      consume(adapter, makeOptions('same-session')),
    ])
    assert.equal(channel.turns.length, 2, '同一会话的两条流都应完成')
    assert.equal(
      channel.maxActivePerSession.get('same-session'),
      1,
      '同一会话的网页回合必须串行（共用同一个网页对话）',
    )
    assert.ok(elapsed(startedAt) >= 250, `同会话两条流应约 2×150ms 串行完成，实测 ${elapsed(startedAt)}ms`)
    console.log(`PASS 2 同会话串行：maxActivePerSession=1，总耗时 ${elapsed(startedAt)}ms`)
  }

  // ---- 3. 放弃生成：取消旧回合并释放会话锁，后续请求不被挡住 ----
  {
    const channel = new TimedChannel(10_000, '完成', false)
    const adapter = new DeepSeekWebAdapter(makeConfig('abandon', { liveThinking: true }), channel)
    const iterator = adapter.stream(makeOptions('abandoned-session'))[Symbol.asyncIterator]()
    const first = await iterator.next()
    assert.equal(first.done, false, '实时思考开启时应能先拿到网页增量')
    await iterator.return?.(undefined)
    // adapter 必须在 finally 里主动取消网页回合
    assert.ok(
      channel.cancelled.includes('abandoned-session'),
      `放弃迭代器后应调用 channel.cancelTurn('abandoned-session')，实测 ${JSON.stringify(channel.cancelled)}`,
    )
    // 旧回合应很快结束（不再挂着 10 秒）
    channel.holdMs = 30
    const retryStart = Date.now()
    const retry = await consume(adapter, makeOptions('abandoned-session'))
    assert.equal(retry.at(-1)?.type, 'finish')
    assert.ok(elapsed(retryStart) < 2_000, `放弃后同一会话的新请求应很快完成，实测 ${elapsed(retryStart)}ms`)
    console.log(`PASS 3 放弃生成：已取消旧回合，同会话新请求 ${elapsed(retryStart)}ms 完成`)
  }

  // ---- 4. 辅助请求（purpose）不排在主请求整轮后面 ----
  {
    // 主请求回合耗时 700ms，辅助请求回合只需 120ms：并行时辅助请求应在主请求结束前返回。
    const channel = new TimedChannel(kind => kind === 'isolated' ? 120 : 700)
    const adapter = new DeepSeekWebAdapter(makeConfig('auxiliary', { maxConcurrentTurns: 2 }), channel)
    const auxOptions = makeOptions('busy-session', 'session-title')
    const main = consume(adapter, makeOptions('busy-session'))
    await new Promise(resolve => setTimeout(resolve, 80))
    const auxStart = Date.now()
    const aux = await consume(adapter, auxOptions)
    const auxElapsed = elapsed(auxStart)
    assert.equal(aux.at(-1)?.type, 'finish')
    await main
    const mainWindow = channel.windows.find(window => window.kind === 'turn')!
    const auxWindow = channel.windows.find(window => window.kind === 'isolated')!
    assert.ok(
      auxWindow.start < mainWindow.end,
      `辅助请求的临时网页回合必须在主请求结束前开始（辅助开始 ${auxWindow.start - mainWindow.start}ms，`
      + `主请求结束 ${mainWindow.end - mainWindow.start}ms）——旧实现会排到主请求整轮之后`,
    )
    assert.ok(
      auxElapsed < 500,
      `辅助请求应并行完成，而不是等主请求整轮结束；实测 ${auxElapsed}ms（旧实现≈620ms+）`,
    )
    console.log(`PASS 4 辅助请求并行：${auxElapsed}ms 完成（主请求仍占用 ${mainWindow.end - auxWindow.start}ms）`)
  }

  // ---- 5. 锁租约兜底：持有者泄漏时到点强制释放 ----
  {
    // 租约定时器是 unref 的（不阻碍进程退出），测试里需要一个活的句柄撑住事件循环。
    const keepAlive = setInterval(() => {}, 1_000)
    try {
      const lock = new AsyncLock()
      let leaked = false
      const holdRelease = await lock.acquire(undefined, {
        maxHoldMs: 120,
        onLeak: () => { leaked = true },
      })
      assert.equal(typeof holdRelease, 'function')
      const waitStart = Date.now()
      // 持有者故意不释放：租约到点后新请求必须能拿到锁
      const second = await lock.acquire()
      assert.ok(leaked, '租约到点应回调 onLeak')
      assert.ok(elapsed(waitStart) < 1_000, `租约释放后应立即拿到锁，实测 ${elapsed(waitStart)}ms`)
      second()
      holdRelease()
      assert.equal(lock.pending, 0, '所有排队者都应结算完毕')
      console.log(`PASS 5 锁租约：泄漏的锁在 ${elapsed(waitStart)}ms 后恢复可用`)
    } finally {
      clearInterval(keepAlive)
    }
  }

  // ---- 6. 并发上限：maxConcurrentTurns=1 时不同会话也要排队，一个个来 ----
  {
    const channel = new TimedChannel(250)
    const adapter = new DeepSeekWebAdapter(makeConfig('gate-limit', { maxConcurrentTurns: 1 }), channel)
    const startedAt = Date.now()
    await Promise.all([
      consume(adapter, makeOptions('limit-a')),
      consume(adapter, makeOptions('limit-b')),
    ])
    assert.equal(
      channel.maxActive,
      1,
      `maxConcurrentTurns=1 时网页回合必须一次只跑一个，实测最大并发 ${channel.maxActive}`,
    )
    assert.deepEqual(
      channel.turns,
      ['limit-a', 'limit-b'],
      `超限请求必须按到达顺序先进先出，实测顺序 ${JSON.stringify(channel.turns)}`,
    )
    assert.ok(
      elapsed(startedAt) >= 450,
      `两次 250ms 回合被串成两轮，总耗时应在 500ms 左右，实测 ${elapsed(startedAt)}ms`,
    )
    console.log(`PASS 6 并发上限：maxActive=1，FIFO 顺序正确，总耗时 ${elapsed(startedAt)}ms`)
  }

  // ---- 7. 上限放开（maxConcurrentTurns=0）：只计数不排队 ----
  {
    const channel = new TimedChannel(300)
    const adapter = new DeepSeekWebAdapter(makeConfig('gate-unlimited', { maxConcurrentTurns: 0 }), channel)
    const startedAt = Date.now()
    await Promise.all([
      consume(adapter, makeOptions('unlimited-a')),
      consume(adapter, makeOptions('unlimited-b')),
      consume(adapter, makeOptions('unlimited-c')),
    ])
    assert.equal(channel.maxActive, 3, `上限为 0 时应完全并行，实测最大并发 ${channel.maxActive}`)
    assert.ok(
      elapsed(startedAt) < 800,
      `三个 300ms 回合应并行完成（<800ms），实测 ${elapsed(startedAt)}ms`,
    )
    console.log(`PASS 7 上限放开：maxActive=3，总耗时 ${elapsed(startedAt)}ms`)
  }

  // ---- 8. 名额池单元契约：FIFO、release 幂等、排队可取消且不泄露名额 ----
  {
    const keepAlive = setInterval(() => {}, 1_000)
    try {
      const gate = new ConcurrencyGate(() => 2)
      const order: string[] = []
      const a = await gate.acquire()
      const b = await gate.acquire()
      assert.equal(gate.stats().active, 2)
      assert.equal(gate.stats().pending, 0)

      const cPromise = gate.acquire().then(release => { order.push('c'); return release })
      const dPromise = gate.acquire().then(release => { order.push('d'); return release })
      const eController = new AbortController()
      const ePromise = gate.acquire(eController.signal)
        .then(release => ({ ok: true as const, release }), (error: unknown) => ({ ok: false as const, error }))
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(gate.stats().pending, 3, `超限的三个请求应全部在队列里，实测 ${gate.stats().pending}`)

      // 重复 release 只能放行一个请求：a 释放两次，c 被放行、d/e 仍在排队。
      a()
      a()
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.deepEqual(order, ['c'], `重复 release 不得多放行，实测 ${JSON.stringify(order)}`)
      assert.equal(gate.stats().pending, 2)
      assert.equal(gate.stats().active, 2)

      // 释放 b 后 d 按 FIFO 拿到名额；e 仍在排队。
      b()
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.deepEqual(order, ['c', 'd'], `必须严格先进先出，实测 ${JSON.stringify(order)}`)
      assert.equal(gate.stats().pending, 1)

      // 排队中的请求可以取消：e 立即出队，既不占名额也不阻塞队列。
      eController.abort(new Error('测试取消'))
      const eResult = await ePromise
      assert.equal(eResult.ok, false, '被取消的排队请求不能拿到名额')
      assert.equal(gate.stats().pending, 0, '取消后队列应清空')
      assert.equal(gate.stats().active, 2, '取消者不应占用或泄露名额')

      const cRelease = await cPromise
      const dRelease = await dPromise
      cRelease()
      dRelease()
      assert.equal(gate.stats().active, 0, '全部释放后活跃数应归零')
      assert.equal(gate.stats().pending, 0, '全部释放后队列应为空')
      console.log('PASS 8 名额池：FIFO 派发、release 幂等、排队取消不泄露名额')
    } finally {
      clearInterval(keepAlive)
    }
  }

  console.log('\n并发回归全部通过 ✅')
} finally {
  await rm(tempDir, { recursive: true, force: true }).catch(() => {})
}
