/**
 * GLM 审核通道契约检查：审核请求必须带上设置页选的模型与思考强度。
 *
 * 用法：tsx tools/glm-review-check.ts
 */
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from '../src/browser-channel.ts'
import type { ReviewConfig } from '../src/config.ts'
import { GlmReviewer } from '../src/reviewer.ts'

let failed = 0
function check(ok: boolean, label: string, detail: string): void {
  if (ok) {
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}：${detail}`)
  }
}

class RecordingChannel implements BrowserChannel {
  readonly requests: BrowserTurnRequest[] = []
  async ensureReady(): Promise<void> {}
  resetConversationGate(): void {}
  async status(): Promise<{ ready: boolean }> { return { ready: true } }
  async focusBrowser(): Promise<void> {}
  async focusHarness(): Promise<void> {}
  async dispose(): Promise<void> {}
  async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    this.requests.push(request)
    return { text: '{"ok":true,"issues":[],"suggestions":[]}' }
  }
}

const config = {
  enabled: true,
  provider: 'glm',
  autoSend: true,
  conversationMode: 'fresh',
  sendVerifyMs: 1_500,
  sendRetries: 2,
  fetchRetries: 1,
  kimiMode: 'normal',
  url: 'https://www.kimi.com/',
  projectUrl: '',
  debugPort: 9334,
  streamIdleTimeoutMs: 600_000,
  maxEvidenceChars: 60_000,
  maxRounds: 1,
  glmUrl: 'https://chat.z.ai/',
  glmDebugPort: 9335,
  glmModel: 'glm-5.3-flash',
  glmEffort: 'max',
} as ReviewConfig

const channel = new RecordingChannel()
const reviewer = new GlmReviewer(channel, config)
const verdict = await reviewer.review({ task: '实现 X', artifact: '完成 Y', files: ['src/x.ts'] })
const request = channel.requests[0]

check(verdict.ok === true, '审核结论正常解析', JSON.stringify(verdict))
check(request?.model === 'glm-5.3-flash', '审核请求带设置页模型', String(request?.model))
check(request?.reasoningEffort === 'max', '审核请求带设置页强度', String(request?.reasoningEffort))
check(request?.role === 'review', '审核请求标记 review', String(request?.role))
check(request?.autoSend === true, '审核自动发送', String(request?.autoSend))

if (failed === 0) console.log('OK（GLM 审核：模型 / 强度 / 归属）')
process.exit(failed === 0 ? 0 : 1)
