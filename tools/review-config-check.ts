/**
 * 校验审核通道的「自动化程度」和「对话模式」两个配置确实落到了通道调用上。
 *
 * 这两个配置最容易出的问题是「配了但没生效」：字段加进了 schema、设置页也画出来了，
 * 但 reviewer 调 `channel.turn()` 时还是写死的旧值。这里用假通道把
 * `turn()` 的实际入参和调用顺序全部录下来，逐条断言：
 *
 * 1. `autoSend: true`（全自动）→ turn 收到 `autoSend: true`；
 * 2. `autoSend: false`（半自动）→ turn 收到 `autoSend: false`，不会被下面的默认值覆盖；
 * 3. `conversationMode: 'fresh'` → 先清会话门控、再让 turn 带 `initialize: true`；
 * 4. `conversationMode: 'reuse'` → 不清门控、turn 的 `initialize` 为 false；
 * 5. 配置缺省（旧配置文件没有这两个键）时按全自动 + fresh 处理。
 */
import { KimiReviewer, GlmReviewer } from '../src/reviewer.ts'
import type { ReviewConfig } from '../src/config.ts'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from '../src/browser-channel.ts'

let failures = 0
function check(name: string, pass: boolean, detail = ''): void {
  if (!pass) {
    failures += 1
    console.error(`FAIL: ${name}${detail ? `\n  ${detail}` : ''}`)
  } else {
    console.log(`ok: ${name}`)
  }
}

interface Recorded {
  calls: string[]
  request?: BrowserTurnRequest
  verdictText: string
}

/** 假通道：只实现 reviewer 会用到的方法，并把调用顺序记下来。 */
function fakeChannel(): { channel: BrowserChannel; recorded: Recorded } {
  const recorded: Recorded = { calls: [], verdictText: '{"ok":true,"issues":[],"suggestions":[]}' }
  const channel = {
    ensureReady: async (): Promise<void> => { recorded.calls.push('ensureReady') },
    resetConversationGate: (_sessionId?: string): void => { recorded.calls.push('resetConversationGate') },
    turn: async (request: BrowserTurnRequest): Promise<BrowserTurnResult> => {
      recorded.calls.push('turn')
      recorded.request = request
      return { text: recorded.verdictText }
    },
    status: async () => ({ ready: true }),
    focusBrowser: async (): Promise<void> => {},
    focusHarness: async (): Promise<void> => {},
    dispose: async (): Promise<void> => {},
  } as unknown as BrowserChannel
  return { channel, recorded }
}

/** 一份最小可用的审核配置，用 `overrides` 覆盖待测字段。 */
function configWith(overrides: Partial<ReviewConfig>): ReviewConfig {
  return {
    enabled: true,
    provider: 'kimi',
    autoSend: true,
    conversationMode: 'fresh',
    sendVerifyMs: 1_500,
    sendRetries: 2,
    fetchRetries: 1,
    url: 'https://www.kimi.com/',
    debugPort: 9334,
    streamIdleTimeoutMs: 600_000,
    maxEvidenceChars: 60_000,
    maxRounds: 1,
    glmUrl: 'https://chat.z.ai/',
    glmDebugPort: 9335,
    ...overrides,
  } as ReviewConfig
}

const evidence = { task: '修 bug', artifact: '改了 A', files: ['src/a.ts'] }

async function main(): Promise<void> {
  // ---- 1. 全自动：autoSend true 原样透传到通道 ----
  {
    const { channel, recorded } = fakeChannel()
    await new KimiReviewer(channel, configWith({ autoSend: true })).review(evidence)
    check('全自动：turn 收到 autoSend=true', recorded.request?.autoSend === true,
      `实际：${String(recorded.request?.autoSend)}`)
  }

  // ---- 2. 半自动：autoSend false 不会被默认值吞掉 ----
  {
    const { channel, recorded } = fakeChannel()
    await new KimiReviewer(channel, configWith({ autoSend: false })).review(evidence)
    check('半自动：turn 收到 autoSend=false', recorded.request?.autoSend === false,
      `实际：${String(recorded.request?.autoSend)}`)
  }

  // ---- 3. fresh：先清会话门控，再要求新建对话 ----
  {
    const { channel, recorded } = fakeChannel()
    await new KimiReviewer(channel, configWith({ conversationMode: 'fresh' })).review(evidence)
    check('fresh：turn 的 initialize 为 true', recorded.request?.initialize === true,
      `实际：${String(recorded.request?.initialize)}`)
    check('fresh：清门控发生在 turn 之前', recorded.calls.join(',') === 'ensureReady,resetConversationGate,turn',
      `实际顺序：${recorded.calls.join(',')}`)
  }

  // ---- 4. reuse：复用同一对话，不清门控 ----
  {
    const { channel, recorded } = fakeChannel()
    await new KimiReviewer(channel, configWith({ conversationMode: 'reuse' })).review(evidence)
    check('reuse：turn 的 initialize 为 false', recorded.request?.initialize === false,
      `实际：${String(recorded.request?.initialize)}`)
    check('reuse：不清会话门控', !recorded.calls.includes('resetConversationGate'),
      `实际顺序：${recorded.calls.join(',')}`)
  }

  // ---- 5. 缺省值：旧配置没这两项时按全自动 + fresh ----
  {
    const { channel, recorded } = fakeChannel()
    const legacy = configWith({} as Partial<ReviewConfig>)
    delete (legacy as { autoSend?: boolean }).autoSend
    delete (legacy as { conversationMode?: string }).conversationMode
    await new KimiReviewer(channel, legacy).review(evidence)
    check('缺省：autoSend 视为 true（全自动）', recorded.request?.autoSend === true,
      `实际：${String(recorded.request?.autoSend)}`)
    check('缺省：conversationMode 视为 fresh', recorded.request?.initialize === true,
      `实际：${String(recorded.request?.initialize)}`)
  }

  // ---- 6. GLM 通道同一套语义 ----
  {
    const { channel, recorded } = fakeChannel()
    await new GlmReviewer(channel, configWith({ autoSend: false, conversationMode: 'reuse' })).review(evidence)
    check('GLM 半自动 + 复用：两个参数都生效',
      recorded.request?.autoSend === false && recorded.request?.initialize === false,
      `实际：autoSend=${String(recorded.request?.autoSend)}, initialize=${String(recorded.request?.initialize)}`)
  }

  // ---- 7. 审核提示词确实进了 turn.text（防止配置通了但证据没送）----
  {
    const { channel, recorded } = fakeChannel()
    await new KimiReviewer(channel, configWith({})).review(evidence)
    const text = recorded.request?.text ?? ''
    check('审核提示词包含任务目标', text.includes('修 bug'))
    check('审核提示词包含待审产出', text.includes('改了 A'))
    check('审核提示词包含涉及文件', text.includes('src/a.ts'))
  }

  if (failures > 0) {
    console.error(`\n${failures} 项失败`)
    process.exit(1)
  }
  console.log('\n审核配置接线检查全部通过')
}

await main()
