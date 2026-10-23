/**
 * 离线回归：长文本转文件附件。
 *
 * 覆盖四件事：
 * 1. 摘要保留开头 3000 字并点名附件，超长部分标注“见附件”；
 * 2. 超过阈值时 adapter 产出 kind=file 的 .md 附件，正文变摘要，fallbackText 是完整正文；
 * 3. 未超阈值时正文原样，不产生文件附件；
 * 4. 关闭 longTextAsFile 时即使超阈值也不转文件。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { buildLongTextNotice, DeepSeekWebAdapter } from '../src/adapter.ts'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from '../src/browser-channel.ts'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-longtext-'))

class CaptureChannel implements BrowserChannel {
  requests: BrowserTurnRequest[] = []
  async ensureReady(): Promise<void> {}
  resetConversationGate(): void {}
  async status(): Promise<{ ready: boolean }> { return { ready: true } }
  async focusBrowser(): Promise<void> {}
  async focusHarness(): Promise<void> {}
  async dispose(): Promise<void> {}
  async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    this.requests.push(request)
    return { text: '收到' }
  }
}

function options(id: string, text: string): GenerateOptions {
  return {
    sessionId: id,
    model: 'deepseek-web-auto',
    messages: [{ id: `user-${id}`, role: 'user', content: [{ type: 'text', text }] }],
  } as unknown as GenerateOptions
}

async function run(id: string, text: string, overrides: Record<string, unknown> = {}) {
  const config = liveConfig(Config({
    stateFile: path.join(tempDir, `${id}.json`),
    autoCorrectMalformed: false,
    focus: { enabled: false },
    ...overrides,
  }))
  const channel = new CaptureChannel()
  const adapter = new DeepSeekWebAdapter(config, channel)
  for await (const _chunk of adapter.stream(options(id, text))) {
    // 只关心通道收到的请求。
  }
  assert.equal(channel.requests.length, 1, 'each run should send exactly one browser turn')
  return channel.requests[0]
}

try {
  // 1. 摘要形状
  const short = buildLongTextNotice('abc', 'dsh-turn-x.md')
  assert.ok(short.includes('abc'))
  assert.ok(short.includes('共 3 字'))
  assert.ok(short.includes('dsh-turn-x.md'))
  assert.ok(!short.includes('中间省略'), 'short text must not claim omitted content')

  const longBody = '甲'.repeat(5_000)
  const long = buildLongTextNotice(longBody, 'dsh-turn-y.md')
  assert.ok(long.includes('共 5000 字'))
  assert.ok(long.includes('甲'.repeat(3_000)))
  assert.ok(long.includes('中间省略'))
  assert.ok(long.includes('请先读取附件 dsh-turn-y.md 的完整内容'))

  // 2. 超阈值 → 文件附件 + 摘要正文
  const body = '数据'.repeat(70_000) // 140 000 字符
  const over = await run('over', body, { longTextAsFile: true, longTextFileThreshold: 120_000 })
  assert.ok(over.text.length < 10_000, 'prompt text should be a short notice')
  assert.ok(over.text.includes('请先读取附件'))
  assert.ok((over.fallbackText ?? '').includes(body), 'fallback text must carry the complete body')
  // 附件字节与 fallbackText 必须一致：文件没挂上时通道就靠这段回退。
  const file = over.attachments?.find(item => item.kind === 'file')
  assert.ok(file, 'long text must produce a file attachment')
  assert.match(file.name, /^dsh-turn-.*\.md$/)
  assert.equal(file.mimeType, 'text/markdown')
  assert.equal(new TextDecoder().decode(file.data), over.fallbackText)

  // 3. 未超阈值 → 正文原样
  const smallBody = '小文本'.repeat(1_000) // 3 000 字符
  const under = await run('under', smallBody, { longTextAsFile: true, longTextFileThreshold: 120_000 })
  assert.ok(under.text.includes(smallBody))
  assert.ok(!under.attachments?.some(item => item.kind === 'file'))
  assert.equal(under.fallbackText, undefined)

  // 4. 关闭开关 → 超阈值也不转文件
  const off = await run('off', body, { longTextAsFile: false, longTextFileThreshold: 120_000 })
  assert.ok(off.text.includes(body))
  assert.ok(!off.attachments?.some(item => item.kind === 'file'))
  assert.equal(off.fallbackText, undefined)

  console.log('OK: 长文本摘要形状、文件附件生成、阈值边界与开关均正常')
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
