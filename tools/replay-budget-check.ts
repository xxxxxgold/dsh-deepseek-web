/**
 * 离线回归：回放预算（Config.maxReplayChars）的裁剪行为。
 *
 * 为什么单独测：网页输入框填字耗时随长度接近二次方增长，长任务一旦把整段历史
 * 全量回放成单条上百万字符的消息，浏览器主线程会被拖死几分钟——响应等待窗口
 * 在填字阶段就过期，表现成「网页明明回答了、dsh 却报没收到响应」。
 * 裁剪逻辑一旦回退，上面这条故障链会原样复活，所以必须有离线护栏。
 *
 * 覆盖：
 * 1. 未超预算时一字不改（不能误伤正常轮次）；
 * 2. 超预算时丢最早的历史、保留最新的，并在原位置留一行可读的省略说明；
 * 3. 系统指令段永远不裁（协议与身份靠它）；
 * 4. 单段自身就超预算时转为截断并保留尾部；
 * 5. maxReplayChars = 0 视为关闭该限制；
 * 6. 增量轮（非 replay）不受影响。
 */
import assert from 'node:assert/strict'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { renderNewWebMessages } from '../src/protocol.ts'
import type { WebChatState } from '../src/session-state.ts'

const options = (messages: unknown[], system?: string): GenerateOptions => ({
  sessionId: 'replay-budget-check',
  model: 'deepseek-web',
  messages,
  tools: [],
  ...(system ? { system } : {}),
} as unknown as GenerateOptions)

const freshState = (): WebChatState => ({
  roundsSinceProtocol: 0,
  lastParseOk: true,
  initialized: false,
  reviewRoundsUsed: 0,
})

const config = (over: Record<string, unknown> = {}) => liveConfig(Config({
  maxReplayChars: 4_000,
  ...over,
} as never))

/** 造一条带明确标记的消息，便于断言「哪一段被保留、哪一段被丢掉」。 */
const userMessage = (id: string, text: string) => ({
  id,
  role: 'user' as const,
  content: [{ type: 'text' as const, text }],
})

const history = (count: number, size: number) => Array.from({ length: count }, (_, i) =>
  userMessage(`u${i}`, `第${i}段开头-${'x'.repeat(size)}-第${i}段结尾`))

// 1. 未超预算：完整保留，不出现省略说明。
{
  const messages = history(3, 100)
  const rendered = renderNewWebMessages(options(messages), freshState(), config())!
  assert.ok(rendered.prompt.text.includes('第0段开头'), '预算内不得丢历史')
  assert.ok(rendered.prompt.text.includes('第2段结尾'), '预算内必须保留最新一段')
  assert.ok(!rendered.prompt.text.includes('历史过长已省略'), '预算内不得插入省略说明')
}

// 2. 超预算：丢最早、留最新，并留下可读说明。
{
  const messages = history(12, 2_000)  // 约 24k 字符，远超 4k 预算
  const rendered = renderNewWebMessages(options(messages), freshState(), config())!
  const text = rendered.prompt.text
  assert.ok(text.length < 6_000, `裁剪后应接近预算（实际 ${text.length}）`)
  assert.ok(text.includes('第11段结尾'), '最新一段必须保留')
  assert.ok(!text.includes('第0段开头'), '最早的一段应被丢弃')
  assert.ok(text.includes('历史过长已省略'), '必须有省略说明')
  assert.ok(/省略了 \d+ 段更早的记录/u.test(text), '说明里应写出省略了几段')
  assert.ok(text.includes('请以当前任务与最近上下文为准继续推进'), '说明应告诉模型以最近上下文为准')
}

// 3. 系统指令永不裁：即使它自己就吃掉大半预算。
{
  const system = `系统规则开头-${'s'.repeat(3_000)}-系统规则结尾`
  const messages = history(10, 2_000)
  const rendered = renderNewWebMessages(options(messages, system), freshState(), config())!
  assert.ok(rendered.prompt.text.includes('系统规则开头'), '系统指令开头必须保留')
  assert.ok(rendered.prompt.text.includes('系统规则结尾'), '系统指令结尾必须保留')
  assert.ok(rendered.prompt.text.includes('第9段结尾'), '历史仍按最近优先保留')
}

// 4. 单段自身超预算：截断并保留尾部（最新进展通常在尾部）。
//    用「宿主上下文」而不是用户消息来测，避免正文同时被 [当前用户任务] 锚点复述一遍。
{
  const huge = {
    id: 'big',
    role: 'user' as const,
    content: [{ type: 'text' as const, text: `开头标记-${'y'.repeat(20_000)}-结尾标记` }],
    source: { kind: 'context', provider: 'deepseek-web', model: 'deepseek-web' },
  }
  const rendered = renderNewWebMessages(options([huge]), freshState(), config())!
  const text = rendered.prompt.text
  assert.ok(text.includes('历史过长已截断：仅保留最近'), '超长单段应标注截断')
  assert.ok(text.includes('结尾标记'), '必须保留尾部')
  assert.ok(!text.includes('开头标记'), '尾部截断后开头应消失')
  assert.ok(text.length < 8_000, `截断后应接近预算（实际 ${text.length}）`)
}

// 5. maxReplayChars = 0 关闭限制。
{
  const messages = history(12, 2_000)
  const rendered = renderNewWebMessages(
    options(messages), freshState(), config({ maxReplayChars: 0 }))!
  assert.ok(rendered.prompt.text.includes('第0段开头'), '关闭预算后应完整回放')
  assert.ok(!rendered.prompt.text.includes('历史过长已省略'), '关闭预算后不得出现省略说明')
}

// 6. 增量轮（非 replay）不受预算影响：先跑一轮把状态primed 好，再追加一条新消息。
//    这里刻意把预算调到 100 字——若裁剪逻辑误伤增量轮，最新这条就会被截掉。
{
  const state = freshState()
  const base = history(2, 100)
  renderNewWebMessages(options(base), state, config())
  // 适配层在真正发出去之后才会把这两个标记打上；这里手工补齐，模拟「已经在网页上聊过两轮」。
  state.initialized = true
  state.lastMessageId = 'u1'
  const incremental = [...base, userMessage('u9', '这一条是新增的增量消息，必须原样送出')]
  const rendered = renderNewWebMessages(options(incremental), state, config({ maxReplayChars: 100 }))!
  assert.ok(rendered.prompt.text.includes('这一条是新增的增量消息'), '增量消息不得被预算裁掉')
  assert.ok(!rendered.prompt.initialize, '增量轮不应标记为初始化')
  assert.ok(!rendered.prompt.text.includes('历史过长已省略'), '增量轮不该触发回放裁剪')
}

console.log('OK: 回放预算的保留/裁剪/截断/关闭/系统指令豁免均符合预期')
