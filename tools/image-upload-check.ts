/**
 * 离线回归：图片附件的渲染与收集。
 *
 * 覆盖四件事：
 * 1. 图片块不再被压成裸 sha，而是 `[附图: 文件名]`；
 * 2. 控制协议第 8 条随开关切换（能看到图 / 看不到图，禁止编造）；
 * 3. 本轮附件收集去重、受 `maxImagesPerTurn` 约束；
 * 4. replay 全量回放时只取最近的若干张，增量轮只取新增。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import {
  blockToText,
  renderNewWebMessages,
  stripProtocolPrefix,
  systemProtocolFor,
} from '../src/protocol.ts'
import type { WebChatState } from '../src/session-state.ts'

interface RefLike {
  attachmentId: string
  mediaType: 'image/png'
  bytes: number
  width: number
  height: number
  name?: string
}

const ref = (id: string, name?: string): RefLike => ({
  attachmentId: `sha256:${id}`,
  mediaType: 'image/png',
  bytes: 2048,
  width: 64,
  height: 64,
  ...(name ? { name } : {}),
})

const imageBlock = (attachment: RefLike) => ({ type: 'image' as const, attachment })

const userMessage = (id: string, text: string, images: RefLike[] = []) => ({
  id,
  role: 'user' as const,
  content: [{ type: 'text' as const, text }, ...images.map(imageBlock)],
})

const options = (messages: unknown[]): GenerateOptions => ({
  sessionId: 'image-check',
  model: 'deepseek-web',
  messages,
  tools: [],
} as unknown as GenerateOptions)

const freshState = (): WebChatState => ({
  roundsSinceProtocol: 0,
  lastParseOk: true,
  initialized: false,
  reviewRoundsUsed: 0,
})

const config = (over: Record<string, unknown> = {}) => liveConfig(Config({
  enableImageUpload: true,
  ...over,
} as never))

// 1. 占位文本：文件名优先，没有名字时退到 id 尾段。
assert.equal(blockToText(imageBlock(ref('aaaa1111', 'shot.png')) as never), '[附图: shot.png]')
assert.equal(blockToText(imageBlock(ref('aaaaaaaaaaaaaaaa2222')) as never), '[附图: 图片-aaaa2222]')

// 2. 协议第 8 条：开启时必须告诉模型"可以看"，关闭时必须告诉它"看不到、别猜"。
const on = systemProtocolFor(true)
const off = systemProtocolFor(false)
assert.ok(on.includes('你可以直接查看其内容'), '开启图片直传时协议应允许模型直接看图')
assert.ok(off.includes('看不到图片内容'), '关闭图片直传时协议应声明看不到图')
assert.ok(!off.includes('你可以直接查看其内容'), '关闭分支不能残留"可以看"的说法')
assert.ok(on.startsWith('你是一个 Agent 指令引擎'), '图片规则必须追加在原协议之后')

// 3. 剥协议：三种形态都要能认出来，正文原样保留。
const body = '正文第一行'
for (const protocol of [systemProtocolFor(true), systemProtocolFor(false)]) {
  assert.equal(stripProtocolPrefix(`${protocol}\n\n${body}`), body)
}

// 4. 首次渲染（replay）：两张图都在，顺序不变。
const st = freshState()
const messages = [
  userMessage('user-1', '这张图是什么？', [ref('r1', 'a.png'), ref('r2', 'b.png')]),
]
const first = renderNewWebMessages(options(messages), st, config())
assert.ok(first, '首次渲染必须返回 prompt')
assert.equal(first.prompt.attachments?.length, 2, '两张图都应被收集')
assert.deepEqual(
  first.prompt.attachments?.map(item => item.attachmentId),
  ['sha256:r1', 'sha256:r2'],
  '附件顺序应与消息中出现顺序一致',
)
assert.ok(first.prompt.text.includes('[附图: a.png]'), '占位标记应带文件名')

// 5. 关闭开关：一个附件都不收集，协议走"看不到图"分支。
const offPrompt = renderNewWebMessages(options(messages), freshState(), config({ enableImageUpload: false }))
assert.equal(offPrompt?.prompt.attachments, undefined, '关闭时不得收集附件')
assert.ok(offPrompt?.prompt.text.includes('看不到图片内容'), '关闭时协议应声明看不到图')

// 6. 张数上限：增量轮只留前 N 张，且去重同一附件。
//    这里手动把状态摆成"已初始化 + 上下文版本/检查点指纹已对齐"，走增量分支，
//    否则未初始化的状态会按 replay 处理、改成取最近 N 张。
const limitState = freshState()
limitState.initialized = true
limitState.contextVersion = 1
limitState.checkpointSignature = createHash('sha256').update(JSON.stringify([])).digest('hex')
const limited = renderNewWebMessages(
  options([userMessage('user-1', '三张图', [ref('r1'), ref('r2'), ref('r1'), ref('r3')])]),
  limitState,
  config({ maxImagesPerTurn: 2 }),
)
assert.equal(limited?.prompt.attachments?.length, 2, '上限 2 时只收集 2 张（去重后）')
assert.deepEqual(limited?.prompt.attachments?.map(item => item.attachmentId), ['sha256:r1', 'sha256:r2'])

// 7. 增量轮：游标之后的图才算本轮附件；纯文本轮不带附件。
const incrementalState = freshState()
renderNewWebMessages(options(messages), incrementalState, config())
incrementalState.initialized = true
incrementalState.lastMessageId = 'user-1'
const second = renderNewWebMessages(
  options([...messages, userMessage('user-2', '再看这张', [ref('r3', 'c.png')])]),
  incrementalState,
  config(),
)
assert.deepEqual(
  second?.prompt.attachments?.map(item => item.attachmentId),
  ['sha256:r3'],
  '增量轮只应收集游标之后新增的图',
)
const plain = renderNewWebMessages(
  options([...messages, userMessage('user-3', '纯文本问题')]),
  incrementalState,
  config(),
)
assert.equal(plain?.prompt.attachments, undefined, '纯文本轮不得带附件')

// 8. 跨轮去重：第一轮传过 A/B，第二轮纯文字，第三轮新加 C——
//    C 必须收集；若用户第三轮又把 A 拖进来（同 attachmentId），A 不重传。
const crossState = freshState()
renderNewWebMessages(options(messages), crossState, config())
crossState.initialized = true
crossState.lastMessageId = 'user-1'
crossState.uploadedImageIds = ['sha256:r1', 'sha256:r2']
const third = renderNewWebMessages(
  options([
    ...messages,
    userMessage('user-2', '纯文字追问'),
    userMessage('user-3', '再来一张，顺便把第一张再贴一次', [ref('r9', 'd.png'), ref('r1', 'a.png')]),
  ]),
  crossState,
  config(),
)
assert.deepEqual(
  third?.prompt.attachments?.map(item => item.attachmentId),
  ['sha256:r9'],
  '第三轮新图必须收集，已在网页对话里的旧图不重复上传',
)

// 9. replay 时的历史图：只取最近若干张，避免重建对话时重传一大堆旧图。
const historyState = freshState()
const historyMessages = [
  userMessage('h1', '第一张', [ref('h1', '1.png'), ref('h2', '2.png')]),
  userMessage('h2', '第二张', [ref('h3', '3.png')]),
  userMessage('h3', '第三张', [ref('h4', '4.png')]),
]
const replay = renderNewWebMessages(options(historyMessages), historyState, config({ maxImagesPerTurn: 2 }))
assert.deepEqual(
  replay?.prompt.attachments?.map(item => item.attachmentId),
  ['sha256:h3', 'sha256:h4'],
  'replay 应取最近的两张图',
)

console.log('OK: 图片占位文本、协议第 8 条分支、附件收集去重与上限、增量/replay 选择均正常')
