/**
 * GLM 过程提示契约检查（不启动浏览器）。
 *
 * 用户反馈 GLM 回合没有 DeepSeek 那种「已发送 / 已接收」提示；
 * 这里直接验证 `emitNotice` 的前缀、分类与开关。
 *
 * 用法：tsx tools/glm-notice-check.ts
 */
import type { BrowserTurnRequest } from '../src/browser-channel.ts'
import type { ReviewConfig } from '../src/config.ts'
import { GLMChannel } from '../src/glm-channel.ts'
import type { NotifyConfig, NoticePayload } from '../src/notify.ts'

let failed = 0
function check(ok: boolean, label: string, detail: string): void {
  if (ok) {
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}：${detail}`)
  }
}

const baseConfig = {
  glmUrl: 'https://chatglm.cn/',
  glmDebugPort: 9337,
  streamIdleTimeoutMs: 600_000,
} as unknown as ReviewConfig

const enabled: NotifyConfig = {
  enabled: true,
  session: true,
  review: true,
  send: true,
  receive: true,
  errors: true,
  browser: true,
}

function requestWith(sink: NoticePayload[], role?: 'session' | 'review'): BrowserTurnRequest {
  return {
    sessionId: 'notice-check',
    model: 'glm-5.3',
    text: 'hello',
    initialize: false,
    ...role === undefined ? {} : { role },
    onNotice: (notice) => sink.push(notice),
  }
}

function emit(channel: GLMChannel, request: BrowserTurnRequest, event: 'send' | 'receive' | 'error' | 'done', detail: string): void {
  ;(channel as unknown as {
    emitNotice: (req: BrowserTurnRequest, ev: string, text: string) => void
  }).emitNotice(request, event, detail)
}

{
  const channel = new GLMChannel({ config: baseConfig, notify: enabled })
  const sink: NoticePayload[] = []
  emit(channel, requestWith(sink), 'send', '已确认发送 5 字（回车）')
  emit(channel, requestWith(sink), 'receive', '网页已收到，正在生成回复…')
  check(sink.length >= 2, '发送/接收提示都会产出', String(sink.length))
  check(sink[0]?.text.startsWith('[DSH] 发送 ·') === true, '会话提示前缀为 [DSH]', sink[0]?.text ?? '')
  check(sink[1]?.text.includes('网页已收到') === true, '接收提示含状态文案', sink[1]?.text ?? '')
}

{
  const channel = new GLMChannel({ config: baseConfig, notify: enabled })
  const sink: NoticePayload[] = []
  emit(channel, requestWith(sink, 'review'), 'send', '审核消息已发送')
  check(sink[0]?.text.startsWith('[DSH·审核] 发送 ·') === true, '审核提示前缀为 [DSH·审核]', sink[0]?.text ?? '')
}

{
  const channel = new GLMChannel({ config: baseConfig, notify: { ...enabled, enabled: false } })
  const sink: NoticePayload[] = []
  emit(channel, requestWith(sink), 'send', '不会出现')
  check(sink.length === 0, 'notify.enabled=false 时完全静默', String(sink.length))
}

{
  const channel = new GLMChannel({ config: baseConfig, notify: { ...enabled, send: false } })
  const sink: NoticePayload[] = []
  emit(channel, requestWith(sink), 'send', '不会出现')
  emit(channel, requestWith(sink), 'receive', '接收仍然保留')
  check(sink.length === 1 && sink[0]?.event === 'receive', 'send 开关只关发送侧', JSON.stringify(sink.map(item => item.event)))
}

if (failed === 0) console.log('OK（GLM 过程提示：前缀 / 分类 / 开关）')
process.exit(failed === 0 ? 0 : 1)
