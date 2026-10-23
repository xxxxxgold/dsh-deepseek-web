/**
 * 校验「网页服务端暂时不可用」的识别与自动重发（离线可复现，不需要浏览器）。
 *
 * 背景（线上事故的回归项）：网页端提示「服务器暂时不可用」时，插件既不认识这条
 * 提示、也不认识 5xx，于是这一轮被当成「解析不出正文」，直接抛
 * WEB_UNPARSEABLE_RESPONSE —— 用户看到的是「本轮运行失败」，而实际上等半分钟
 * 重发一次就能过。
 *
 * 覆盖：
 * 1. looksLikeServerBusyText 认中英文服务端故障文案，且不误伤普通回复；
 * 2. isServerBusyResponse 认 5xx / error 帧 / 网关错误页，且不扫正文段落；
 * 3. isRateLimitResponse **不再**把服务端故障误判成频控（两者处置相反，这条最关键）；
 * 4. parseCompletionBody 把 SSE 里的服务端故障帧标成 serverBusy；
 * 5. 退避曲线是秒级起步，与频控的分钟级退避严格分开；
 * 6. 源码断言：服务端故障判定排在频控之前，且不进账号冷却。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  claimNoticeToasts,
  isRateLimitResponse,
  isServerBusyResponse,
  looksLikeServerBusyText,
  scanNoticeToasts,
  shouldCountRateLimitNode,
} from '../src/browser-shared.ts'
import { classifyFailureCode } from '../src/cooldown.ts'
import {
  describeFailure,
  SERVER_BUSY_BASE_DELAY_MS,
  SERVER_BUSY_MAX_DELAY_MS,
  serverBusyDelayMs,
} from '../src/notify.ts'
import { parseCompletionBody } from '../src/playwright-channel.ts'

const fail = (message: string): never => {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

/* ------------------------------------------------------------------ *
 * 1. 文案识别
 * ------------------------------------------------------------------ */

const busySamples = [
  '服务器暂时不可用，请稍后重试',
  '服务器繁忙，请稍后再试',
  '服务暂时不可用',
  '系统繁忙',
  '当前服务繁忙，请稍后重试',
  'Service Unavailable',
  'The server is temporarily unavailable',
  'Server is busy, please try again later',
]
for (const sample of busySamples) {
  if (!looksLikeServerBusyText(sample)) fail(`应识别为服务端故障：${sample}`)
}

const normalSamples = [
  '已完成任务：文件已写入 a.html',
  '服务器的部署流程分三步',
  '这个接口在服务不可用时会返回 503',
  '{"actions":[{"tool":"read","arguments":{"file_path":"a.txt"}}]}',
  '消息发送过于频繁，请稍后重试',
]
for (const sample of normalSamples) {
  if (looksLikeServerBusyText(sample)) fail(`不应误判为服务端故障：${sample}`)
}

/* ------------------------------------------------------------------ *
 * 2. 响应体判定
 * ------------------------------------------------------------------ */

const busyBodies: Array<[string, number, string, boolean]> = [
  ['HTTP 503', 503, '', true],
  ['HTTP 502', 502, '<html><body>502 Bad Gateway</body></html>', true],
  ['HTTP 504', 504, '', true],
  ['非流式短文本', 200, '服务器暂时不可用，请稍后重试', true],
  ['网关错误页', 200, '<html><body><h1>服务器暂时不可用</h1></body></html>', true],
  ['流里的 type=error 帧', 200, 'data: {"type":"error","content":"服务器暂时不可用，请稍后重试"}\n\n', true],
  ['流里的 error 对象帧', 200, 'data: {"error":{"code":503,"message":"Service Unavailable"}}\n\n', true],
  ['正常 SSE 回复（正文提到服务不可用）', 200,
    'data: {"v":{"response":{"fragments":[{"id":1,"type":"RESPONSE","content":"服务器暂时不可用是运维常见问题"}]}}}\n\n', false],
  ['普通短回复', 200, '今天天气不错', false],
  ['HTTP 500（文案不明确）', 500, '', false],
]
for (const [label, status, body, want] of busyBodies) {
  const got = isServerBusyResponse(status, body)
  if (got !== want) fail(`服务端故障判定「${label}」应为 ${want}，实际 ${got}`)
}

/* ------------------------------------------------------------------ *
 * 3. 与频控的互斥（本次事故的核心回归）
 * ------------------------------------------------------------------ */

const mutualExclusion: Array<[string, number, string, boolean]> = [
  // 服务端故障文案常带「请稍后重试」——早期会被频控正则命中，白锁 10 分钟冷却。
  ['服务端故障短文本不算频控', 200, '服务器暂时不可用，请稍后重试', false],
  ['服务端故障 error 帧不算频控', 200, 'data: {"type":"error","content":"服务器暂时不可用，请稍后重试"}\n\n', false],
  ['真正的频控仍然算频控', 200, '消息发送过于频繁，请稍后重试', true],
  ['HTTP 429 仍然算频控', 429, '', true],
]
for (const [label, status, body, want] of mutualExclusion) {
  const got = isRateLimitResponse(status, body)
  if (got !== want) fail(`互斥判定「${label}」应为 ${want}，实际 ${got}`)
}

// 节点级判定同样互斥：同一段文字不能既算频控又算服务端故障。
const busyNode = shouldCountRateLimitNode({
  text: '服务器暂时不可用，请稍后重试',
  visible: true,
  childElementCount: 0,
  insideEditor: false,
  selfPaint: false,
  seen: false,
})
if (busyNode) fail('服务端故障 toast 不应被算作频控节点')
const rateNode = shouldCountRateLimitNode({
  text: '消息发送过于频繁，请稍后重试',
  visible: true,
  childElementCount: 0,
  insideEditor: false,
  selfPaint: false,
  seen: false,
})
if (!rateNode) fail('真正的频控 toast 应被算作频控节点')

/* ------------------------------------------------------------------ *
 * 4. 解析层标记
 * ------------------------------------------------------------------ */

const parseCases: Array<[string, string, boolean]> = [
  ['SSE 里的 type=error 帧', 'data: {"type":"error","content":"服务器暂时不可用，请稍后重试"}\n\n', true],
  ['SSE 里的 error 对象帧', 'data: {"error":{"code":503,"message":"Service Unavailable"}}\n\n', true],
  ['纯文本服务端故障', '服务器暂时不可用', true],
  ['正常 SSE 回复', 'data: {"v":{"response":{"fragments":[{"id":1,"type":"RESPONSE","content":"你好"}]}}}\n\n', false],
  ['正常 JSON 回复', '{"choices":[{"message":{"content":"你好"}}]}', false],
]
for (const [label, body, want] of parseCases) {
  const parsed = parseCompletionBody(body)
  const got = parsed.serverBusy === true
  if (got !== want) fail(`解析标记「${label}」应为 ${want}，实际 ${got}`)
}

// 标记了 serverBusy 的解析结果不能同时宣称拿到了正文（否则上层会先按成功处理）。
const busyParsed = parseCompletionBody('data: {"type":"error","content":"服务器暂时不可用"}\n\n')
if (busyParsed.text !== '' || busyParsed.reliable) {
  fail(`服务端故障帧不应产出正文：${JSON.stringify(busyParsed)}`)
}

/* ------------------------------------------------------------------ *
 * 5. 退避曲线
 * ------------------------------------------------------------------ */

// random()=0.5 时抖动因子为 1，可精确断言：15s → 30s → 60s → 120s → 120s
const sequence = [0, 1, 2, 3, 4].map(attempt => serverBusyDelayMs(undefined, attempt, () => 0.5))
const expected = [15_000, 30_000, 60_000, 120_000, 120_000]
for (const [index, want] of expected.entries()) {
  if (sequence[index] !== want) fail(`服务端退避第 ${index} 次应为 ${want}ms，实际 ${sequence[index]}ms`)
}

// 必须比频控退避快一个量级：频控首次 60s，服务端故障首次 15s。
if (SERVER_BUSY_BASE_DELAY_MS >= 60_000) fail('服务端故障首次等待不该到分钟级')
if (SERVER_BUSY_MAX_DELAY_MS > 300_000) fail('服务端故障单次等待不该超过 5 分钟')

// 抖动边界：random()=0 → ×0.8，random()=1 → ×1.2
const low = serverBusyDelayMs({ retryDelayMs: 10_000, backoff: 'fixed', jitterRatio: 0.2 }, 0, () => 0)
const high = serverBusyDelayMs({ retryDelayMs: 10_000, backoff: 'fixed', jitterRatio: 0.2 }, 0, () => 1)
if (low !== 8_000 || high !== 12_000) fail(`抖动边界应为 8000/12000，实际 ${low}/${high}`)

/* ------------------------------------------------------------------ *
 * 6. 错误码与冷却分类
 * ------------------------------------------------------------------ */

const hint = describeFailure({ code: 'WEB_SERVER_BUSY' })
if (hint === 'WEB_SERVER_BUSY' || hint.trim() === '') fail('WEB_SERVER_BUSY 缺少人话提示')
if (!hint.includes('服务端')) fail(`WEB_SERVER_BUSY 提示应说明是服务端问题，实际：${hint}`)

// 服务端故障绝不能进账号冷却：那会让一次后端抖动把整台机器锁 10 分钟。
const failureClass = classifyFailureCode('WEB_SERVER_BUSY')
if (failureClass !== 'other') fail(`WEB_SERVER_BUSY 应归为 other（不进冷却），实际 ${failureClass}`)

/* ------------------------------------------------------------------ *
 * 7. 源码一致性断言
 * ------------------------------------------------------------------ */

const sourceDir = fileURLToPath(new URL('../src/', import.meta.url))
const channelSource = readFileSync(path.join(sourceDir, 'playwright-channel.ts'), 'utf8')

// race 的胜者现在可能是 HTTP 响应，也可能是页面镜像（见 sendAndWait 的 mirrorDone 分支），
// 因此判定入参从 winner.status 变成了 response.status。两种写法都接受，
// 断言的目的只是「判定存在且服务端故障排在频控之前」，不锁死局部变量名。
const busyJudgeAt = Math.max(
  channelSource.indexOf('isServerBusyResponse(winner.status'),
  channelSource.indexOf('isServerBusyResponse(response.status'),
)
const rateJudgeAt = Math.max(
  channelSource.indexOf('isRateLimitResponse(winner.status'),
  channelSource.indexOf('isRateLimitResponse(response.status'),
)
if (busyJudgeAt < 0) fail('找不到 sendAndWait 里的服务端故障判定，源码断言已失效')
if (rateJudgeAt < 0) fail('找不到 sendAndWait 里的频控判定，源码断言已失效')
if (busyJudgeAt > rateJudgeAt) {
  fail('服务端故障判定必须排在频控之前——顺序反了会把后端抖动锁成账号冷却')
}

if (!channelSource.includes("outcome.kind === 'server-busy'")) {
  fail('turnOnPage 没有处理 server-busy 结果，服务端故障不会被自动重发')
}
if (!channelSource.includes('parsed.serverBusy === true')) {
  fail('turnOnPage 没有处理解析层标记的 serverBusy（HTTP 200 里的 error 帧会漏掉）')
}
if (!channelSource.includes("'WEB_SERVER_BUSY'")) {
  fail('没有抛出 WEB_SERVER_BUSY：重试用尽后仍会报成别的错误')
}

// page.evaluate 的回调被 toString() 注入页面执行，页面里没有 esbuild 的 keepNames helper。
// 回调体里出现 __name(...) 会让整段检测抛 ReferenceError 并被 .catch 吞成 false。
for (const [name, fn] of [['scanNoticeToasts', scanNoticeToasts], ['claimNoticeToasts', claimNoticeToasts]] as const) {
  if (String(fn).includes('__name')) {
    fail(`${name} 的页面回调含 __name(...)，注入页面后会抛错并被吞掉`)
  }
}

// 发送前必须同时认领两类旧节点：只认领频控会让上一轮残留的「服务器不可用」把本轮判死。
if (!channelSource.includes('markServerBusyToastsSeen(page)')) {
  fail('发送前没有认领服务端故障旧节点，残留提示会锁死之后每一轮')
}

console.log('OK（服务端故障识别 + 与频控互斥 + 自动重发退避 + 不进冷却）')
