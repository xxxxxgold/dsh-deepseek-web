/**
 * 回归：模型把动作信封包在散文 + ```json 围栏里、且信封 JSON 有语法缺损时，
 * 不能把整段 JSON 当最终回答交付。
 *
 * 样本来自 2026-10-25 会话 session-05eaac33-ae38-49be-9233-c797c5912c90：
 * 第 9 步模型输出「玖玖找到关键疑点：…」+ ```json 围栏 + 4 个动作，但第一个
 * 动作对象少了一个右花括号。旧解析器从每个 `{` 起点向后找第一个可解析对象，
 * 结果命中内层 `arguments`，判 hasActions=false；意图守卫又因为前面有散文而
 * 返回 false，于是工具调用被当作最终正文，回合 completed，任务中断。
 *
 * 契约：
 * 1. 这类回复必须解析出全部 4 个动作（结构抢救），或至少判为“想调工具”走纠错；
 * 2. 动作必须全部可信（工具名在本轮清单内、参数是合法对象），半个计划不执行；
 * 3. 正文里的文档示例不得被误判成工具调用。
 *
 * 运行：npx tsx tools/tool-envelope-check.ts
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DeepSeekWebAdapter } from '../src/adapter.ts'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import * as response from '../src/response.ts'
import { looksLikeIntendedToolReply, parseWebReply, replyChunks } from '../src/response.ts'
import type { WebToolAction } from '../src/response.ts'

type Salvage = (text: string, allowed: ReadonlySet<string>) => WebToolAction[] | undefined
const salvageToolEnvelope = (response as unknown as { salvageToolEnvelope?: Salvage }).salvageToolEnvelope

let failures = 0
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
}

const reply = readFileSync(new URL('./fixtures/session-05eaac33-malformed-actions.txt', import.meta.url), 'utf8')
const allowed = new Set(['ops_bash', 'pwsh', 'read', 'write', 'edit'])

console.log('网页动作信封抢救')

// 1. 真实样本：严格解析必须直接还原 4 个动作
const strict = parseWebReply(reply, { allowedToolNames: allowed })
check('真实样本解析出 4 个动作', strict.hasActions && strict.actions.length === 4, {
  hasActions: strict.hasActions,
  count: strict.actions.length,
})
check(
  '真实样本工具名顺序正确',
  strict.actions.map(action => action.tool).join(',') === 'ops_bash,pwsh,pwsh,pwsh',
  strict.actions.map(action => action.tool),
)

// 2. 即使解析不出来，也必须判为“想调工具”，走纠错而不是当最终回答
check('真实样本被判为工具意图', looksLikeIntendedToolReply(reply, allowed))

// 3. 结构抢救：逐个动作从 arguments 对象边界还原
check('存在结构抢救实现', typeof salvageToolEnvelope === 'function')
if (typeof salvageToolEnvelope === 'function') {
  const salvaged = salvageToolEnvelope(reply, allowed)
  check('抢救出 4 个动作', salvaged?.length === 4, salvaged?.length)
  check(
    '抢救保留全部工具名',
    salvaged?.map(action => action.tool).join(',') === 'ops_bash,pwsh,pwsh,pwsh',
    salvaged?.map(action => action.tool),
  )
  check(
    '抢救保留第一个动作的命令',
    typeof salvaged?.[0]?.params?.command === 'string'
    && (salvaged[0]!.params!.command as string).includes("grep ':51708'"),
  )
  check(
    '抢救保留代理检查命令',
    typeof salvaged?.[1]?.params?.command === 'string'
    && (salvaged[1]!.params!.command as string).includes('netsh winhttp show proxy'),
  )

  // 4. 未知工具名不得执行（文档示例 / 越权工具）
  const doc = '协议示例：\n\n```json\n{"actions":[{"tool":"example_tool","arguments":{"x":1}}]}\n```\n'
  check('文档示例不判为工具意图', !looksLikeIntendedToolReply(doc, allowed))
  check('文档示例不执行', salvageToolEnvelope(doc, allowed) === undefined)

  // 5. 半个计划不执行：动作数组被截断、或某个动作参数坏掉时整体放弃
  const truncated = '```json\n{"actions":[{"tool":"pwsh","arguments":{"command":"pwd"}},{"tool":"pwsh","arguments":{"command":"ls"}\n```'
  check('截断的计划不执行', salvageToolEnvelope(truncated, allowed) === undefined, salvageToolEnvelope(truncated, allowed))
  const brokenArgs = '```json\n{"actions":[{"tool":"pwsh","arguments":{"command":"pwd"}},{"tool":"pwsh","arguments":{"command":}}]}\n```'
  check('参数坏掉不执行', salvageToolEnvelope(brokenArgs, allowed) === undefined, salvageToolEnvelope(brokenArgs, allowed))
}

// 6. 交给宿主的 chunk 流必须是 4 个 tool-call 块 + finish(tool-calls)，而不是 text 块
const chunks = [...replyChunks(strict, { startIndex: 0, nextCallId: 1 })]
const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
const finish = chunks.find(chunk => chunk.type === 'finish')
check(
  '交付块全部是 tool-call',
  blocks.length === 4 && blocks.every(block => block.type === 'tool-call'),
  blocks.map(block => block.type),
)
check(
  'finish 原因为 tool-calls',
  finish?.type === 'finish' && finish.reason.kind === 'tool-calls',
  finish?.type === 'finish' ? finish.reason : undefined,
)

// 7. 既有行为不能回退
check('普通正文不判为工具意图', !looksLikeIntendedToolReply('主人，活儿干完了，结论如下。', allowed))
check(
  '整条信封仍可解析',
  parseWebReply('```json\n{"actions":[{"tool":"pwsh","arguments":{"command":"pwd"}}]}\n```').hasActions,
)
check('散文无信封不解析', !parseWebReply('玖玖先解释一下，然后就没有然后了。').hasActions)

// 8. 适配器端到端：同一份回复必须走 tool-call 流，不能落成最终正文
const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-envelope-'))
try {
  const stateFile = path.join(dir, 'state.json')
  let turns = 0
  const channel = {
    ensureReady: async () => {},
    resetConversationGate() {},
    status: async () => ({ ready: true }),
    focusBrowser: async () => {},
    focusHarness: async () => {},
    dispose: async () => {},
    turn: async () => {
      turns += 1
      return { text: reply, accumulatedUsage: 1 }
    },
  }
  const adapter = new DeepSeekWebAdapter(
    liveConfig(Config({ stateFile, focus: { enabled: false }, toolAllowlist: ['ops_bash', 'pwsh'] })),
    channel,
  )
  const request = {
    sessionId: 'tool-envelope',
    model: 'deepseek-web-auto',
    tools: [
      {
        name: 'ops_bash',
        description: 'shell',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
      {
        name: 'pwsh',
        description: 'powershell',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    ],
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '继续排查' }] }],
  } as unknown as GenerateOptions
  const streamed: StreamChunk[] = []
  for await (const chunk of adapter.stream(request)) streamed.push(chunk)
  const callDeltas = streamed.filter(chunk => chunk.type === 'tool-call-delta')
  check('适配器产出 4 个工具调用', callDeltas.length === 4, callDeltas.length)
  check('适配器不输出正文块', !streamed.some(chunk => chunk.type === 'text-delta'))
  const tail = streamed.at(-1)
  check('适配器以 tool-calls 结束', tail?.type === 'finish' && tail.reason.kind === 'tool-calls', tail)
  check('只调用一次网页回合（未浪费纠错往返）', turns === 1, turns)
} finally {
  await rm(dir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\nFAIL: ${failures} 项未通过`)
  process.exit(1)
}
console.log('\n网页动作信封抢救：全部通过')
