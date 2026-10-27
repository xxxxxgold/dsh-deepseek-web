/**
 * 豆包通道真机验收脚本（需要已登录的 doubao-profile）。
 *
 * 运行：
 *   $env:DOUBAO_LIVE='1'; npx tsx tools/doubao-live-check.ts
 *
 * 覆盖：普通问答 1 轮、协议+工具 2 轮、新对话 1 次、取消 1 次。
 * 不设置 DOUBAO_LIVE 时直接退出，避免 CI/误触拉起浏览器。
 */
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { DoubaoBrowserChannel } from '../src/doubao-channel.ts'
import { defaultProfileDir } from '../src/browser-shared.ts'
import { parseWebReply } from '../src/response.ts'

if (process.env.DOUBAO_LIVE !== '1') {
  console.log('跳过：这是真机验收脚本。设置 DOUBAO_LIVE=1 后运行。')
  process.exit(0)
}

const PROTOCOL = `你是一个 Agent 指令引擎。你的任务是把收到的任务/工具结果转化为下一步操作。

规则：
1. 需要调用本地工具时，只输出一个 JSON 对象，格式如下（可以放在 \`\`\`json 围栏内）：
   {"actions":[{"tool":"<工具名>","arguments":{...}}]}
   工具名必须取自下面列出的可用工具。
2. 任务已经完成、不需要再调用工具时，直接输出面向用户的最终回答正文，不要输出 JSON。
3. 不要解释 JSON 本身；不要输出 Markdown 表格或额外前缀；除围栏外不要夹带其它文本。
5. 输出必须可被 JSON.parse 解析：不要尾随逗号、不要注释。

可用工具：
- read：读取文件。arguments: {"path": string}
- list：列出目录。arguments: {"path": string}

【当前用户任务】
统计 D:\\dsh\\ds-web\\src 目录下有多少个 .ts 文件，先调用工具读取目录。`

const TOOL_RESULT = `【当前用户任务】
统计 D:\\dsh\\ds-web\\src 目录下有多少个 .ts 文件，直接给出最终数量与结论。

【宿主上下文：工具结果】
list({"path":"D:\\\\dsh\\\\ds-web\\\\src"}) =>
adapter.ts
archive-cleanup-route.ts
archive-cleanup.ts
async-lock.ts
browser-channel.ts
browser-shared.ts
build-info.ts
concurrency-gate.ts
config.ts
cooldown.ts
doctor.ts
glm-channel.ts
index.ts
kimi-channel.ts
ledger-route.ts
ledger.ts
live-config.ts
login-probe.ts
login-route.ts
login-state.ts
notify.ts
pacing.ts
playwright-channel.ts
protocol.ts
response.ts
retry-policy.ts
reviewer.ts
session-state.ts
web-models.ts
window-policy.ts
`

const config = liveConfig(Config({
  doubao: {
    enabled: true,
    debugPort: 9336,
    profileDir: defaultProfileDir('doubao-profile'),
  },
}))
const channel = new DoubaoBrowserChannel({ config })
const report: Record<string, unknown> = {}

try {
  await channel.ensureReady()
  report.status = await channel.status()

  const started = Date.now()
  const plain = await channel.turn({
    sessionId: 'doubao-live',
    model: 'doubao-web-auto',
    text: '只回复 OK',
    initialize: true,
    autoSend: true,
  })
  report.plain = { text: plain.text, elapsedMs: Date.now() - started, mode: plain.meta?.mode }
  if (!plain.text.includes('OK')) throw new Error(`普通问答失败：${plain.text}`)

  const toolStart = Date.now()
  const first = await channel.turn({
    sessionId: 'doubao-live',
    model: 'doubao-web-auto',
    text: PROTOCOL,
    initialize: false,
    autoSend: true,
  })
  const parsed = parseWebReply(first.text, { allowedToolNames: new Set(['read', 'list', 'write', 'bash']) })
  report.toolTurn1 = { text: first.text, elapsedMs: Date.now() - toolStart, actions: parsed.actions }
  if (!parsed.hasActions || parsed.actions[0]?.tool !== 'list') {
    throw new Error(`第一轮没有解析出 list 动作：${first.text}`)
  }
  const secondStart = Date.now()
  const second = await channel.turn({
    sessionId: 'doubao-live',
    model: 'doubao-web-auto',
    text: TOOL_RESULT,
    initialize: false,
    autoSend: true,
  })
  report.toolTurn2 = { text: second.text, elapsedMs: Date.now() - secondStart }
  if (!/30/.test(second.text) || !/\.ts/.test(second.text)) {
    throw new Error(`第二轮没有得到 30 个 .ts 的结论：${second.text}`)
  }

  const beforeNewChat = channel.currentChatId('doubao-live')
  await channel.startNewConversation('doubao-live')
  const afterNewChat = channel.currentChatId('doubao-live')
  const fresh = await channel.turn({
    sessionId: 'doubao-live',
    model: 'doubao-web-auto',
    text: '只回复好的',
    initialize: false,
    autoSend: true,
  })
  report.newChat = { beforeNewChat, afterNewChat, text: fresh.text }
  if (beforeNewChat && beforeNewChat === afterNewChat) {
    throw new Error('新对话没有切换到新的 conversation id')
  }

  const longTurn = channel.turn({
    sessionId: 'doubao-live',
    model: 'doubao-web-auto',
    text: '请写一篇一万字的长篇小说第一章，详细描写人物、环境和对话，不要只给提纲。',
    initialize: false,
    autoSend: true,
  }).then(result => ({ ok: true as const, result }), error => ({ ok: false as const, error }))
  await new Promise(resolve => setTimeout(resolve, 2_500))
  await channel.cancelTurn('doubao-live')
  const cancelled = await longTurn
  report.cancel = cancelled.ok
    ? { ok: true, text: cancelled.result.text.slice(0, 80) }
    : { ok: false, code: (cancelled.error as { code?: string }).code }
  if (cancelled.ok) throw new Error('取消没有生效：长回合正常返回')

  await new Promise(resolve => setTimeout(resolve, 2_000))
  const next = await channel.turn({
    sessionId: 'doubao-live',
    model: 'doubao-web-auto',
    text: '只回复 OK2',
    initialize: false,
    autoSend: true,
  })
  report.afterCancel = { text: next.text }
  if (!next.text.includes('OK2')) throw new Error(`取消后下一轮失败：${next.text}`)

  console.log('DOUBAO_LIVE_OK')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await channel.dispose().catch(() => {})
}
