/**
 * 离线回归：过程提示是否真的能到达 DSH 的对话流。
 *
 * 这一条是 0.4.0 的核心承诺，也是最容易悄悄失效的地方：
 * - liveThinking 默认 `false`，此时 playwright 的 `onProgress` 一次都不会触发，
 *   如果提示挂在 onProgress 上，用户在 DSH 里什么都看不到（0.3.x 就是这样）。
 * - 提示只能落在 reasoning 块里，不能混进正文，否则会污染交付内容。
 *
 * 所以这里用脚本化的假通道，直接把 `onNotice` 回调打出来，断言：
 * 1. liveThinking=false 时，提示照样变成一个 reasoning 块；
 * 2. 提示文本按到达顺序拼接，正文块里不含提示字样；
 * 3. 普通会话请求不带 `role`（默认按 session 归类），自审请求带 `role: 'review'`。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DeepSeekWebAdapter } from '../src/adapter.ts'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from '../src/browser-channel.ts'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { PlaywrightBrowserChannel } from '../src/playwright-channel.ts'
import { DeepSeekSelfReviewer } from '../src/reviewer.ts'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-notice-'))

const options = (id: string): GenerateOptions => ({
  sessionId: id,
  model: 'deepseek-web-auto',
  messages: [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: '请给出结果' }] }],
} as unknown as GenerateOptions)

/** 记录每个请求（含 role / onNotice 是否存在），并按预设脚本触发提示。 */
class NoticeChannel implements BrowserChannel {
  readonly requests: BrowserTurnRequest[] = []
  constructor(private readonly notices: readonly string[]) {}
  async ensureReady(): Promise<void> {}
  resetConversationGate(): void {}
  async status(): Promise<{ ready: boolean }> { return { ready: true } }
  async focusBrowser(): Promise<void> {}
  async focusHarness(): Promise<void> {}
  async dispose(): Promise<void> {}
  async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    this.requests.push(request)
    for (const text of this.notices) request.onNotice?.({ category: 'session', event: 'send', text })
    return { text: '最终回答' }
  }
}

async function collect(id: string, notices: readonly string[], liveThinking: boolean) {
  const config = liveConfig(Config({
    stateFile: path.join(tempDir, `${id}.json`),
    liveThinking,
    autoCorrectMalformed: false,
    focus: { enabled: false },
  }))
  const channel = new NoticeChannel(notices)
  const adapter = new DeepSeekWebAdapter(config, channel)
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options(id))) chunks.push(chunk)
  return { chunks, channel, config }
}

try {
  const notices = ['[DSH] 发送 · 已发送 12 字', '[DSH] 接收 · 网页已响应，正在生成…'] as const

  for (const liveThinking of [false, true]) {
    const { chunks, channel, config } = await collect(`notice-${liveThinking}`, notices, liveThinking)
    assert.equal(config.liveThinking, liveThinking)
    assert.equal(channel.requests.length, 1)
    // 会话请求不显式带 role，由通道按 session 归类
    assert.equal(channel.requests[0]?.role, undefined)
    assert.equal(typeof channel.requests[0]?.onNotice, 'function', '会话请求必须带 onNotice')

    const blocks = chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
    const reasoning = blocks.filter(block => block.type === 'reasoning')
    assert.equal(reasoning.length, 1, `liveThinking=${liveThinking} 时应有且只有一个提示块`)
    assert.equal(reasoning[0]?.text, notices.join('\n'), '提示应按到达顺序换行拼接')

    const textBlocks = blocks.filter(block => block.type === 'text')
    assert.deepEqual(textBlocks, [{ type: 'text', text: '最终回答' }])
    for (const block of textBlocks) {
      assert.ok(!block.text.includes('[DSH]'), '正文里不能混入提示')
    }

    // 提示块的 block-start / delta / block-end 必须自洽，否则前端会吞掉这半截内容
    const startIndex = chunks.find(chunk => chunk.type === 'block-start' && chunk.blockType === 'reasoning')?.index
    assert.equal(typeof startIndex, 'number')
    const streamed = chunks
      .filter(chunk => chunk.type === 'reasoning-delta' && chunk.index === startIndex)
      .map(chunk => chunk.text)
      .join('')
    assert.equal(streamed, notices.join('\n'), '流式增量必须拼回完整提示')
    const ended = chunks.find(chunk => chunk.type === 'block-end' && chunk.index === startIndex)
    assert.ok(ended, '提示块必须有 block-end')
    // 提示块要排在正文之前，用户先看到进度再看结果
    const textStart = chunks.findIndex(chunk => chunk.type === 'block-start' && chunk.blockType === 'text')
    const noticeStart = chunks.findIndex(chunk => chunk.type === 'block-start' && chunk.blockType === 'reasoning')
    assert.ok(noticeStart >= 0 && noticeStart < textStart, '提示块应在正文块之前')
  }

  // 自审请求必须标明 role=review，提示才会走 [DSH·审核] 前缀与独立开关
  const reviewChannel = new NoticeChannel([])
  const verdict = await new DeepSeekSelfReviewer(reviewChannel).review({
    task: '检查交付',
    artifact: '交付内容',
  })
  assert.equal(reviewChannel.requests.length, 1)
  assert.equal(reviewChannel.requests[0]?.role, 'review', '自审请求必须带 role=review')
  assert.equal(reviewChannel.requests[0]?.sessionId, 'deepseek-self-review')
  assert.equal(verdict.ok, false, '非 JSON 回复应判为未通过而不是崩掉')

  console.log('OK: 提示块在 liveThinking 关闭时仍可见、不污染正文、审核请求带 role=review')

  // 通道层的开关与节流：不启动浏览器，直接借用原型方法，确认配置真的能关掉提示
  const proto = PlaywrightBrowserChannel.prototype as unknown as {
    emitNotice: (this: unknown, request: BrowserTurnRequest, event: string, detail: string) => void
  }
  const fakeChannel = (id: string, notify: Record<string, boolean> = {}) => {
    const config = liveConfig(Config({
      stateFile: path.join(tempDir, `${id}.json`),
      notify,
    })) as unknown as { notify: Record<string, boolean> }
    const instance = Object.create(PlaywrightBrowserChannel.prototype) as Record<string, unknown>
    instance.options = { config }
    instance.lastNoticeAt = new Map<string, number>()
    const collected: string[] = []
    const request = {
      sessionId: id,
      onNotice: (notice: { text: string }) => { collected.push(notice.text) },
    } as unknown as BrowserTurnRequest
    return { config, collected, request, instance }
  }
  const emit = (instance: Record<string, unknown>, request: BrowserTurnRequest, event: string) => {
    proto.emitNotice.call(instance, request, event, '细节')
  }

  // 默认：会话提示带 [DSH] 前缀，连发两次只保留一次（500ms 节流）
  const plain = fakeChannel('throttle')
  emit(plain.instance, plain.request, 'send')
  emit(plain.instance, plain.request, 'send')
  assert.equal(plain.collected.length, 1, '同一事件的连发必须被节流')
  assert.equal(plain.collected[0], '[DSH] 发送 · 细节')
  emit(plain.instance, plain.request, 'receive')
  assert.equal(plain.collected.length, 2, '不同事件各自放行')

  // 审核请求走自己的前缀，且与会话互不挤占节流槽
  const reviewRequest = { ...plain.request, role: 'review' } as unknown as BrowserTurnRequest
  emit(plain.instance, reviewRequest, 'send')
  assert.equal(plain.collected.at(-1), '[DSH·审核] 发送 · 细节')
  assert.equal(plain.collected.length, 3)

  // 分类开关
  const onlyReview = fakeChannel('only-review', { session: false })
  emit(onlyReview.instance, onlyReview.request, 'send')
  assert.equal(onlyReview.collected.length, 0, 'session=false 时必须静默')
  emit(onlyReview.instance, { ...onlyReview.request, role: 'review' } as BrowserTurnRequest, 'send')
  assert.equal(onlyReview.collected.length, 1, '审核分类不受会话开关影响')

  // 事件开关与总开关
  const noSend = fakeChannel('no-send', { send: false })
  emit(noSend.instance, noSend.request, 'send')
  emit(noSend.instance, noSend.request, 'receive')
  assert.deepEqual(noSend.collected, ['[DSH] 接收 · 细节'])

  const mute = fakeChannel('mute', { enabled: false })
  for (const event of ['send', 'receive', 'done', 'wait', 'retry', 'error']) {
    emit(mute.instance, mute.request, event)
  }
  assert.equal(mute.collected.length, 0, '总开关关闭时必须一条都不发')
  assert.equal(mute.config.notify.session, true, '总开关关闭不应改写分类默认值')

  console.log('OK: 提示开关（总/分类/事件）与节流生效，审核前缀独立')
} finally {
  await rm(tempDir, { recursive: true, force: true })
}