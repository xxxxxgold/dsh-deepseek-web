/**
 * 豆包适配器级端到端验收：真调 `DeepSeekWebAdapter.stream()`，走完整
 * 模型解析 → 通道 → 浏览器 → SSE → 正文/结束原因链路；不依赖 DSH UI。
 *
 * 用法：DOUBAO_E2E=1 npx tsx tools/doubao-adapter-e2e-check.ts
 * 需要主人已登录的 doubao-profile；默认跳过，避免普通测试拉起浏览器。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DeepSeekWebAdapter } from '../src/adapter.ts'
import { DoubaoBrowserChannel } from '../src/doubao-channel.ts'
import { createDoubaoWebProfile } from '../src/doubao-provider.ts'
import { defaultProfileDir } from '../src/browser-shared.ts'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'

if (process.env.DOUBAO_E2E !== '1') {
  console.log('SKIP doubao-adapter-e2e-check（设置 DOUBAO_E2E=1 才跑真机）')
  process.exit(0)
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-doubao-e2e-'))
const stateFile = path.join(tempDir, 'session-state.json')
const config = liveConfig(Config({
  stateFile,
  focus: { enabled: false },
  autoCorrectMalformed: false,
  doubao: {
    enabled: true,
    profileDir: defaultProfileDir('doubao-profile'),
    debugPort: 9336,
    ackTimeoutMs: 120_000,
    replyTimeoutMs: 600_000,
  },
}))
const channel = new DoubaoBrowserChannel({ config })
const adapter = new DeepSeekWebAdapter(
  config,
  channel,
  undefined,
  undefined,
  undefined,
  createDoubaoWebProfile({ stateFile }),
)

function userMessage(id: string, text: string): GenerateOptions['messages'][number] {
  return { id, role: 'user', content: [{ type: 'text', text }] } as unknown as GenerateOptions['messages'][number]
}

function assistantMessage(id: string, text: string): GenerateOptions['messages'][number] {
  return { id, role: 'assistant', content: [{ type: 'text', text }] } as unknown as GenerateOptions['messages'][number]
}

function options(
  sessionId: string,
  model: string,
  messages: GenerateOptions['messages'],
): GenerateOptions {
  return { sessionId, model, messages } as unknown as GenerateOptions
}

async function answer(
  sessionId: string,
  model: string,
  messages: GenerateOptions['messages'],
): Promise<{ text: string; chunks: StreamChunk[] }> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options(sessionId, model, messages))) chunks.push(chunk)
  const textBlocks = chunks
    .filter((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> => chunk.type === 'block-end')
    .map(chunk => chunk.block)
    .filter(block => block.type === 'text')
    .map(block => block.text)
  return { text: textBlocks.join(''), chunks }
}

try {
  const firstUser = '只回复 E2E-OK，不要解释。'
  const first = await answer('doubao-e2e-plain', 'doubao-web-auto', [userMessage('u1', firstUser)])
  assert.match(first.text, /E2E-OK/i, `首轮正文应包含 E2E-OK，实际: ${first.text.slice(0, 200)}`)
  assert.equal(first.chunks.at(-1)?.type, 'finish', '首轮应以 finish 结束')

  // 同一 dsh 会话第二轮：宿主会带完整历史，验证复用网页对话 + 上下文回放
  const second = await answer('doubao-e2e-plain', 'doubao-web-auto', [
    userMessage('u1', firstUser),
    assistantMessage('a1', first.text),
    userMessage('u2', '刚才我让你回复什么？只回复那个词。'),
  ])
  assert.match(second.text, /E2E-OK/i, `第二轮应复用上下文，实际: ${second.text.slice(0, 200)}`)

  const fresh = await answer('doubao-e2e-fresh', 'doubao-web-auto', [userMessage('u1', '只回复 FRESH-OK，不要解释。')])
  assert.match(fresh.text, /FRESH-OK/i, `新会话正文应包含 FRESH-OK，实际: ${fresh.text.slice(0, 200)}`)

  console.log('DOUBAO_E2E_OK')
  console.log(JSON.stringify({
    plain: first.text,
    followUp: second.text,
    fresh: fresh.text,
  }, null, 2))
} finally {
  await channel.dispose().catch(() => {})
  await rm(tempDir, { recursive: true, force: true }).catch(() => {})
}
