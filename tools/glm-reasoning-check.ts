/**
 * GLM 思考回归：提示行先打开 reasoning 块后，最终思考仍要补进同一个块。
 *
 * 背景：GLM 通道不流式思考，只在解析完成后返回 reasoning；而 `[DSH]` 发送/接收提示
 * 会先打开 reasoning 块。旧逻辑只在 `!opened` 时补完整思考，导致开着「展示网页思考」
 * 也看不到 GLM 的思考内容。
 *
 * 用法：tsx tools/glm-reasoning-check.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DeepSeekWebAdapter } from '../src/adapter.ts'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from '../src/browser-channel.ts'
import { Config } from '../src/config.ts'
import { createGlmWebProfile } from '../src/glm-provider.ts'
import { liveConfig } from '../src/live-config.ts'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'glm-reasoning-'))

class NoticeThenReasoningChannel implements BrowserChannel {
  calls = 0
  async ensureReady(): Promise<void> {}
  resetConversationGate(): void {}
  async status(): Promise<{ ready: boolean }> { return { ready: true } }
  async focusBrowser(): Promise<void> {}
  async focusHarness(): Promise<void> {}
  async dispose(): Promise<void> {}
  async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    this.calls += 1
    request.onNotice?.({ category: 'session', event: 'send', text: '[DSH] 发送 · 已确认发送 3 字' })
    return { text: '391', reasoning: '先算 17×23，再给最终数字。' }
  }
}

const config = liveConfig(Config({
  stateFile: path.join(tempDir, 'session-state.json'),
  liveThinking: true,
  autoCorrectMalformed: false,
  focus: { enabled: false },
}))
const channel = new NoticeThenReasoningChannel()
const adapter = new DeepSeekWebAdapter(
  config,
  channel,
  undefined,
  undefined,
  undefined,
  createGlmWebProfile({
    autoSend: true,
    stateFile: path.join(tempDir, 'glm-state.json'),
    ledgerFile: path.join(tempDir, 'glm-ledger.json'),
  }),
)
const request = {
  sessionId: 'glm-reasoning',
  provider: 'glm-web',
  model: 'glm-5.3',
  messages: [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: '17×23 等于多少？' }] }],
} as unknown as GenerateOptions

const chunks: StreamChunk[] = []
for await (const chunk of adapter.stream(request)) chunks.push(chunk)

const reasoning = chunks.filter(chunk => chunk.type === 'reasoning-delta')
  .map(chunk => chunk.text).join('')
assert.ok(reasoning.includes('[DSH] 发送'), '提示行应保留在 reasoning 块里')
assert.ok(reasoning.includes('先算 17×23'), 'GLM 最终思考应补进 reasoning 块')
const end = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
assert.ok(end !== undefined && end.block.type === 'reasoning')
assert.equal(end.block.text, reasoning, '最终块正文应与流式 delta 一致')
assert.equal(channel.calls, 1)
assert.equal(chunks.at(-1)?.type, 'finish')

console.log('glm-reasoning-check: ok')
