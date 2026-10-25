/**
 * 网页通道「工具调用显示」回归。
 *
 * 覆盖三类已确认缺陷（见 .trellis/tasks/issue-10-25-web-tool-call-display-issue/analysis.md）：
 * 1) 动作信封只在「整条回复是 JSON」时才被认出来，散文 / 多围栏 / 轻微语法错都会静默变正文；
 * 2) tool-call id 每条消息从 web-1 重新计数，DSH 按 id 复用会话节点，后发生的覆盖先发生的；
 * 3) 坏信封必须走纠正或明确报错，不得作为最终正文交付。
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
import { looksLikeIntendedToolReply, parseWebReply, replyChunks } from '../src/response.ts'

const FENCE = '```'
const allowed = new Set(['read', 'write', 'pwsh', 'ops_bash'])
const readAction = (file: string): string => `{"tool":"read","arguments":{"file_path":"${file}"}}`
const envelope = (...items: string[]): string => `{"actions":[${items.join(',')}]}`
const parse = (text: string) => parseWebReply(text, { allowedToolNames: allowed })

// ---------------------------------------------------------------------------
// 1. 解析层：动作信封识别
// ---------------------------------------------------------------------------

// 散文 + 单个 json 围栏（现状已支持，防回归）
{
  const text = `先看文件。\n\n${FENCE}json\n${envelope(readAction('a.txt'))}\n${FENCE}`
  const parsed = parse(text)
  assert.equal(parsed.hasActions, true, '散文 + 围栏动作信封必须识别')
  assert.equal(parsed.actions.length, 1)
  assert.equal(parsed.actions[0]!.tool, 'read')
}

// 正文 + dsh-ui 围栏 + json 动作围栏：不能只取第一个 JSON（真实会话 seq 56 形态）
{
  const genui = `${FENCE}dsh-ui\n{"title":"本轮执行方案","gap":14,"items":[]}\n${FENCE}`
  const text = `主人，方案如下。\n\n${genui}\n\n${FENCE}json\n${envelope(readAction('b.txt'))}\n${FENCE}`
  const parsed = parse(text)
  assert.equal(parsed.hasActions, true, 'GenUI 围栏之后的动作围栏必须识别')
  assert.equal(parsed.actions.length, 1, '不能把 GenUI JSON 当成动作')
  assert.equal(parsed.actions[0]!.tool, 'read')
}

// Windows 路径里的非法转义（\d）应被保守修复（真实会话 seq 676 形态）
{
  const text = `主人，先跑。\n\n${FENCE}json\n{"actions":[{"tool":"pwsh","arguments":{"description":"看目录","command":"cd 'D:\\dsh\\ds-web'"}}]}\n${FENCE}`
  const parsed = parse(text)
  assert.equal(parsed.hasActions, true, '非法转义应本地修复后解析')
  assert.equal(parsed.actions[0]!.tool, 'pwsh')
  assert.equal((parsed.actions[0]!.params as Record<string, unknown>).command, "cd 'D:\\dsh\\ds-web'")
}

// 正文里行内提到围栏符号：不能让围栏配对错位（真实会话 seq 676 的散文形态）
{
  const text = `源库的 prompt 末尾多带了围栏符号 ${FENCE}，去掉后比较一致。\n\n${FENCE}json\n${envelope(readAction('c.txt'))}\n${FENCE}`
  const parsed = parse(text)
  assert.equal(parsed.hasActions, true, '正文里的行内反引号不得干扰围栏配对')
  assert.equal(parsed.actions.length, 1)
}

// 缺一个 } 但动作本身完整：按结构抢救出全部动作，不丢条目不执行半截
{
  // 与真实会话同形：第一个动作对象少一个右花括号，数组与信封仍闭合。
  const text = `主人，找到了。\n\n${FENCE}json\n{"actions":[{"tool":"read","arguments":{"file_path":"a.txt"},{"tool":"read","arguments":{"file_path":"b.txt"}}]}\n${FENCE}`
  const parsed = parse(text)
  assert.equal(parsed.hasActions, true, '缺外层括号时应结构抢救')
  assert.deepEqual(
    parsed.actions.map(action => (action.params as Record<string, unknown>).file_path),
    ['a.txt', 'b.txt'],
    '抢救必须保留全部动作与顺序',
  )
}

// 动作数组被截断（没有 ]）：不得猜，必须判为「想调工具」
{
  const text = `主人，找到了。\n\n${FENCE}json\n{"actions":[${readAction('a.txt')}\n${FENCE}`
  const parsed = parse(text)
  assert.equal(parsed.hasActions, false, '截断的动作数组不得执行')
  assert.equal(parsed.actions.length, 0)
  assert.equal(looksLikeIntendedToolReply(text, allowed), true, '截断信封必须触发纠正，而不是当正文')
}

// 正文里行内提到动作示例（不在围栏里）不能误判
{
  const text = '示例：{"actions":[]} 只是文档，不是调用。'
  assert.equal(parse(text).hasActions, false)
  assert.equal(looksLikeIntendedToolReply(text, allowed), false, '行内示例不得触发工具调用')
}

// 普通 GenUI 围栏（没有 actions）仍是正文
{
  const text = `方案如下。\n\n${FENCE}json\n{"title":"方案","gap":14,"items":[]}\n${FENCE}`
  assert.equal(parse(text).hasActions, false)
  assert.equal(looksLikeIntendedToolReply(text, allowed), false)
}

// ---------------------------------------------------------------------------
// 2. 流层：tool-call id 会话内唯一
// ---------------------------------------------------------------------------

{
  const reply = parse(envelope(readAction('a.txt')))
  const first = [...replyChunks(reply)].filter(chunk => chunk.type === 'tool-call-delta')
  const second = [...replyChunks(reply)].filter(chunk => chunk.type === 'tool-call-delta')
  const ids = [...first, ...second].map(chunk => (chunk as { id: string }).id)
  assert.equal(ids.length, 2)
  assert.equal(new Set(ids).size, 2, '两次回复的 tool-call id 不能重复（DSH 按 id 复用节点）')
  // block-end 里的 id 必须与同一次流里的 delta 一致，否则宿主的工具结果无法回填
  const oneRun = [...replyChunks(reply)]
  const oneDelta = oneRun.filter(chunk => chunk.type === 'tool-call-delta')
  const oneEnd = oneRun.filter(chunk => chunk.type === 'block-end')
  assert.equal(
    (oneEnd[0] as { block: { id: string } }).block.id,
    (oneDelta[0] as { id: string }).id,
    'block-end 与 tool-call-delta 的 id 必须一致',
  )
}

// ---------------------------------------------------------------------------
// 3. 适配器：正常动作产出工具调用；截断信封明确失败
// ---------------------------------------------------------------------------

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-toolcall-'))

function options(id: string): GenerateOptions {
  return {
    sessionId: id,
    model: 'deepseek-web-auto',
    messages: [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: '请执行' }] }],
    tools: [{ name: 'read', description: '读取文件', parameters: {
      type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'],
    } }],
  } as unknown as GenerateOptions
}

class ScriptedChannel implements BrowserChannel {
  calls = 0
  constructor(private readonly replies: BrowserTurnResult[]) {}
  async ensureReady(): Promise<void> {}
  resetConversationGate(): void {}
  async status(): Promise<{ ready: boolean }> { return { ready: true } }
  async focusBrowser(): Promise<void> {}
  async focusHarness(): Promise<void> {}
  async dispose(): Promise<void> {}
  async turn(_request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    const reply = this.replies[this.calls++]
    assert.ok(reply, 'unexpected extra browser turn')
    return reply
  }
}

async function collect(id: string, reply: BrowserTurnResult): Promise<{ chunks: StreamChunk[]; error?: Error & { code?: string } }> {
  const config = liveConfig(Config({
    stateFile: path.join(tempDir, `${id}.json`),
    autoCorrectMalformed: false,
    focus: { enabled: false },
  }))
  const adapter = new DeepSeekWebAdapter(config, new ScriptedChannel([reply]))
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream(options(id))) chunks.push(chunk)
  } catch (error) {
    return { chunks, error: error as Error & { code?: string } }
  }
  return { chunks }
}

try {
  // 正常：散文 + 围栏动作 → tool-call 块，finish=tool-calls
  {
    const text = `先看文件。\n\n${FENCE}json\n${envelope(readAction('a.txt'))}\n${FENCE}`
    const { chunks, error } = await collect('ok', { text })
    assert.equal(error, undefined)
    assert.ok(chunks.some(chunk => chunk.type === 'tool-call-delta' && chunk.name === 'read'))
    assert.ok(!chunks.some(chunk => chunk.type === 'text-delta'), '动作回复不该再产出正文块')
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  }

  // 截断信封：不得作为正文交付，必须抛 MALFORMED_TOOL_CALL
  {
    const text = `主人，找到了。\n\n${FENCE}json\n{"actions":[${readAction('a.txt')}\n${FENCE}`
    const { chunks, error } = await collect('broken', { text })
    assert.ok(error, '截断信封必须报错，不能静默当正文')
    assert.equal(error?.code, 'MALFORMED_TOOL_CALL')
    assert.ok(!chunks.some(chunk => chunk.type === 'text-delta'), '坏信封不得先交付一段正文')
  }

  console.log('OK: 动作信封识别、id 唯一、坏信封不落正文')
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
