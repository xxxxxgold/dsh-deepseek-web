/**
 * 校验频控识别与实时增量的纯逻辑（离线可复现，不需要浏览器）：
 * 1. looksLikeRateLimitText 覆盖中英文频控文案，且不误伤普通回复；
 * 2. 累计重建 + 后缀差分（playwright-channel 的进度轮询逻辑）在
 *   追加流上产生正确的增量，且在回缩时只对齐基线不发负增量；
 * 3. 退避曲线、过程提示文案与开关、错误码到人话的覆盖。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  hasRateLimitToast,
  isRateLimitResponse,
  looksLikeRateLimitText,
  markRateLimitToastsSeen,
  shouldCountRateLimitNode,
} from '../src/browser-shared.ts'
import {
  browserNoticeEnabled,
  describeFailure,
  describeRateLimitPolicy,
  formatDuration,
  formatNotice,
  noticeEnabled,
  rateLimitDelayMs,
} from '../src/notify.ts'
import { parseCompletionBody } from '../src/playwright-channel.ts'

const rateLimitSamples = [
  '消息发送过于频繁，请稍后重试',
  '操作过于频繁，请稍后再试',
  '发送太快啦，休息一下吧',
  'Too many requests, please try again later',
  'You are doing that too frequently',
  'rate limited by server',
]
for (const sample of rateLimitSamples) {
  if (!looksLikeRateLimitText(sample)) {
    console.error(`FAIL: 应识别为频控：${sample}`)
    process.exit(1)
  }
}

const normalSamples = [
  '已完成任务：文件已写入 a.html',
  '好的，我会注意发送节奏',
  '{"actions":[{"tool":"read","arguments":{"file_path":"a.txt"}}]}',
]
for (const sample of normalSamples) {
  if (looksLikeRateLimitText(sample)) {
    console.error(`FAIL: 不应误判为频控：${sample}`)
    process.exit(1)
  }
}

/*
 * 响应体判定：正常回复里出现「稍后再试」不算频控。
 *
 * 这是线上事故的回归项。早期版本直接对回复正文前 2000 字跑正则，模型答一句
 * 「失败的话可以稍后再试」就把整轮判成频控：重发同一条、再被判、再重发，
 * 5 次后抛 WEB_RATE_LIMITED，用户看到的是「网页上一个提示都没有，却一直失败」。
 */
const sseWithApology = 'data: {"v":{"response":{"fragments":[{"id":1,"type":"RESPONSE","content":"如果还是失败，可以稍后再试一次。"}]}}}\n\n'
const bodyCases: Array<[string, number, string, boolean]> = [
  ['正常 SSE 回复里带「稍后再试」', 200, sseWithApology, false],
  ['正常 SSE 回复（无频控字眼）', 200, 'data: {"v":{"response":{"fragments":[{"id":1,"type":"RESPONSE","content":"今天天气不错"}]}}}\n\n', false],
  ['HTTP 429', 429, '', true],
  ['非流式短错误文本', 200, 'Too many requests. Please try again later.', true],
  ['流里的独立 error 帧', 200, 'data: {"error":{"code":429,"message":"rate limited"}}\n\n', true],
  ['非流式的 JSON 错误体', 200, '{"error":{"message":"rate limit exceeded, try again later"}}', true],
]
for (const [label, status, body, want] of bodyCases) {
  const got = isRateLimitResponse(status, body)
  if (got !== want) {
    console.error(`FAIL: 响应体判定「${label}」应为 ${want}，实际 ${got}`)
    process.exit(1)
  }
}

/*
 * 单节点判定规则：页面内联逻辑与 shouldCountRateLimitNode 必须逐条一致。
 * 这里覆盖「什么该算、什么不该算」，尤其是「视觉已消失」「旧节点已认领」两种。
 */
const nodeFacts = (patch: Partial<Parameters<typeof shouldCountRateLimitNode>[0]>) => ({
  text: '消息发送过于频繁，请稍后重试',
  visible: true,
  childElementCount: 0,
  insideEditor: false,
  selfPaint: false,
  seen: false,
  ...patch,
})
const nodeCases: Array<[string, ReturnType<typeof nodeFacts>, boolean]> = [
  ['正常频控 toast', nodeFacts({}), true],
  ['父容器隐藏（视觉已消失）', nodeFacts({ visible: false }), false],
  ['零尺寸 / 移出视口', nodeFacts({ visible: false }), false],
  ['已被上一轮认领的旧节点', nodeFacts({ seen: true }), false],
  ['插件自绘浮层', nodeFacts({ selfPaint: true }), false],
  ['输入区内的文字', nodeFacts({ insideEditor: true }), false],
  ['超长段落', nodeFacts({ text: '稍后重试'.repeat(40) }), false],
  ['子元素过多的容器', nodeFacts({ childElementCount: 5 }), false],
  ['普通文案', nodeFacts({ text: '已完成任务' }), false],
]
for (const [label, facts, want] of nodeCases) {
  const got = shouldCountRateLimitNode(facts)
  if (got !== want) {
    console.error(`FAIL: 节点判定「${label}」应为 ${want}，实际 ${got}`)
    process.exit(1)
  }
}

// 实时增量差分：模拟两轮轮询，SSE 体逐步追加。
// 样本按真实协议构造：fragments 整段 upsert（THINK+RESPONSE），随后 APPEND 补丁落到最后一个片段。
const sseHead = [
  'data: {"v":{"response":{"fragments":[{"id":1,"type":"THINK","content":"先想想"}]}}}',
  'data: {"v":{"response":{"fragments":[{"id":1,"type":"THINK","content":"先想想"},{"id":2,"type":"RESPONSE","content":"你好"}]}}}',
].join('\n')
const first = parseCompletionBody(`${sseHead}\n\n`)
let emittedText = ''
let emittedReasoning = ''
const diff = (text: string, reasoning: string): { text: string; reasoning: string } => {
  if (text.length < emittedText.length) emittedText = text
  if (reasoning.length < emittedReasoning.length) emittedReasoning = reasoning
  const textDelta = text.length > emittedText.length ? text.slice(emittedText.length) : ''
  const reasoningDelta = reasoning.length > emittedReasoning.length ? reasoning.slice(emittedReasoning.length) : ''
  emittedText = text
  emittedReasoning = reasoning
  return { text: textDelta, reasoning: reasoningDelta }
}

const firstDelta = diff(first.text, first.reasoning ?? '')
if (firstDelta.reasoning !== '先想想' || firstDelta.text !== '你好') {
  console.error(`FAIL: 第一轮增量不符：${JSON.stringify(firstDelta)}`)
  process.exit(1)
}

const second = parseCompletionBody(`${sseHead}\ndata: {"p":"response/fragments/-1/content","o":"APPEND","v":"，世界"}\n\n`)
const secondDelta = diff(second.text, second.reasoning ?? '')
if (secondDelta.text !== '，世界' || secondDelta.reasoning !== '') {
  console.error(`FAIL: 第二轮增量不符：${JSON.stringify(secondDelta)}`)
  process.exit(1)
}

// 回缩保护：更短的累计值只对齐基线，不产生负增量
const shrunk = diff('你好', '')
if (shrunk.text !== '' || shrunk.reasoning !== '') {
  console.error(`FAIL: 回缩时不应发增量：${JSON.stringify(shrunk)}`)
  process.exit(1)
}

/* ------------------------------------------------------------------ *
 * 退避策略与提示文案
 * ------------------------------------------------------------------ */

// 默认策略（不传任何配置）必须落在「60s 起、指数、300s 封顶」：
// 这条序列要和实测冷却窗口（10~15 分钟）对得上，改默认值时会先在这里炸。
const defaultSequence = [0, 1, 2, 3, 4].map(attempt =>
  rateLimitDelayMs(undefined, attempt, () => 0.5))
const expectedSequence = [60_000, 120_000, 240_000, 300_000, 300_000]
for (const [index, expected] of expectedSequence.entries()) {
  if (defaultSequence[index] !== expected) {
    console.error(`FAIL: 默认退避第 ${index} 次应为 ${expected}ms，实际 ${defaultSequence[index]}ms`)
    process.exit(1)
  }
}

// fixed 曲线每次都等基数；抖动为 0 时可精确断言
const fixedSequence = [0, 1, 2].map(attempt =>
  rateLimitDelayMs({ retryDelayMs: 45_000, backoff: 'fixed', jitterRatio: 0 }, attempt, () => 0.5))
if (fixedSequence.join(',') !== '45000,45000,45000') {
  console.error(`FAIL: fixed 退避应恒为基数，实际 ${fixedSequence.join(',')}`)
  process.exit(1)
}

// 抖动边界：random()=0 → ×(1-ratio)，random()=1 → ×(1+ratio)
const lowJitter = rateLimitDelayMs({ retryDelayMs: 10_000, backoff: 'fixed', jitterRatio: 0.2 }, 0, () => 0)
const highJitter = rateLimitDelayMs({ retryDelayMs: 10_000, backoff: 'fixed', jitterRatio: 0.2 }, 0, () => 1)
if (lowJitter !== 8_000 || highJitter !== 12_000) {
  console.error(`FAIL: 抖动边界应为 8000/12000，实际 ${lowJitter}/${highJitter}`)
  process.exit(1)
}

// 单次等待不得低于下限（配置写 1ms 也要被抬到 1000ms）
if (rateLimitDelayMs({ retryDelayMs: 1, backoff: 'fixed', jitterRatio: 0 }, 0, () => 0.5) !== 1_000) {
  console.error('FAIL: 退避不应低于 1000ms 下限')
  process.exit(1)
}

const policyText = describeRateLimitPolicy(undefined)
if (!policyText.includes('指数') || !policyText.includes('5m')) {
  console.error(`FAIL: 默认策略描述应含「指数」与 5m 封顶，实际：${policyText}`)
  process.exit(1)
}

// 会话与审核的提示前缀必须不同，否则用户分不清谁在说话
const sessionLine = formatNotice({ category: 'session', event: 'send', detail: '已发送 12 字' })
const reviewLine = formatNotice({ category: 'review', event: 'send', detail: '开始审核' })
if (!sessionLine.startsWith('[DSH] 发送') || !reviewLine.startsWith('[DSH·审核] 发送')) {
  console.error(`FAIL: 提示前缀不符：${sessionLine} / ${reviewLine}`)
  process.exit(1)
}
if (sessionLine === reviewLine || sessionLine.startsWith('[DSH·审核]')) {
  console.error('FAIL: 会话提示与审核提示没有分开')
  process.exit(1)
}

// 开关：总开关 → 分类开关 → 事件开关，逐层都能单独关掉
const allOn = { enabled: true, session: true, review: true, send: true, receive: true, errors: true, browser: true }
const expectNotice = (config: typeof allOn, category: 'session' | 'review', event: 'send' | 'error', want: boolean): void => {
  if (noticeEnabled(config, category, event) !== want) {
    console.error(`FAIL: noticeEnabled(${category},${event}) 期望 ${want}`)
    process.exit(1)
  }
}
expectNotice(allOn, 'session', 'send', true)
expectNotice({ ...allOn, enabled: false }, 'session', 'send', false)
expectNotice({ ...allOn, session: false }, 'session', 'send', false)
expectNotice({ ...allOn, session: false }, 'review', 'send', true)
expectNotice({ ...allOn, review: false }, 'review', 'error', false)
expectNotice({ ...allOn, errors: false }, 'session', 'error', false)
expectNotice({ ...allOn, send: false }, 'session', 'send', false)
if (browserNoticeEnabled({ ...allOn, browser: false }) || !browserNoticeEnabled(allOn)) {
  console.error('FAIL: 浏览器浮层开关判定不对')
  process.exit(1)
}

// 时长格式：给用户体验看的，不能出现 60000ms 这种原始值
if (formatDuration(60_000) !== '1m' || formatDuration(300_000) !== '5m' || !formatDuration(1_500).endsWith('s')) {
  console.error(`FAIL: formatDuration 不对：${formatDuration(60_000)} / ${formatDuration(300_000)}`)
  process.exit(1)
}

/*
 * 错误提示覆盖：从源码里把所有错误码抓出来，逐个要求 describeFailure 给出
 * 人话（而不是只把 code 原样吐回来）。新增错误码却忘了写提示时这里会失败。
 */
const sourceDir = fileURLToPath(new URL('../src/', import.meta.url))
const codePattern = /'(WEB_[A-Z_]+|BROWSER_[A-Z_]+|KIMI_[A-Z_]+|GLM_[A-Z_]+|UNKNOWN_MODEL|MALFORMED_TOOL_CALL|CONTEXT_WINDOW_EXCEEDED)'/gu
const discovered = new Set<string>()
for (const file of readdirSync(sourceDir)) {
  if (!file.endsWith('.ts') || file === 'notify.ts') continue
  const text = readFileSync(path.join(sourceDir, file), 'utf8')
  for (const match of text.matchAll(codePattern)) discovered.add(match[1])
}
if (discovered.size < 20) {
  console.error(`FAIL: 只抓到 ${discovered.size} 个错误码，扫描逻辑可能失效`)
  process.exit(1)
}
const missing: string[] = []
for (const code of discovered) {
  const text = describeFailure({ code })
  if (text === code || text.trim() === '') missing.push(code)
}
if (missing.length > 0) {
  console.error(`FAIL: 这些错误码没有提示文案：${missing.join(', ')}`)
  process.exit(1)
}
// 表外错误码也要回退到原文，不能空着
if (!describeFailure({ code: 'SOMETHING_NEW', message: '原始错误' }).includes('原始错误')) {
  console.error('FAIL: 未知错误码应回退到错误原文')
  process.exit(1)
}

/*
 * 源码一致性断言。
 *
 * `page.evaluate` 的回调在页面里执行，无法 import 模块函数，只能内联一份逻辑。
 * 这两处一旦漂移，离线用例（测的是纯函数）就会全绿，而线上仍旧误判——所以直接
 * 对源码做结构化断言：判据缺一条就炸。
 */
const sharedSource = readFileSync(path.join(sourceDir, 'browser-shared.ts'), 'utf8')
const toastStart = sharedSource.indexOf('export async function hasRateLimitToast')
if (toastStart < 0) {
  console.error('FAIL: 找不到 hasRateLimitToast，源码断言已失效')
  process.exit(1)
}
const claimStart = sharedSource.indexOf('export async function markRateLimitToastsSeen')
const toastSource = sharedSource.slice(toastStart, claimStart > toastStart ? claimStart : undefined)
for (const needle of ['checkVisibility', 'params.seenAttr', 'params.noticeId', 'getBoundingClientRect']) {
  if (!toastSource.includes(needle)) {
    console.error(`FAIL: hasRateLimitToast 缺少判据「${needle}」——隐藏或旧的节点会重新被当成新提示`)
    process.exit(1)
  }
}

/*
 * page.evaluate 的回调是 toString() 之后注入页面执行的，页面里没有打包器的 helper。
 * esbuild 的 keepNames 会把具名函数表达式包成 `__name(...)`；回调体内只要出现一个
 * 具名函数，整个检测就会 ReferenceError，再被 `.catch(() => false)` 吞掉——
 * 现象是「页面上明明有频控提示，也一律判不出来」。这条断言直接盯转译产物。
 */
for (const [name, fn] of [['hasRateLimitToast', hasRateLimitToast], ['markRateLimitToastsSeen', markRateLimitToastsSeen]] as const) {
  if (String(fn).includes('__name')) {
    console.error(`FAIL: ${name} 的 evaluate 回调含 __name(...)，页面端会抛 ReferenceError 并被吞成 false`)
    process.exit(1)
  }
}

const channelSource = readFileSync(path.join(sourceDir, 'playwright-channel.ts'), 'utf8')
const claimAt = channelSource.indexOf('markRateLimitToastsSeen(page)')
const timerAt = channelSource.indexOf('toastTimer = setInterval')
if (claimAt < 0 || timerAt < 0 || claimAt > timerAt) {
  console.error('FAIL: 必须在启动 toast 轮询之前认领旧节点，否则残留 toast 会锁死之后每一轮')
  process.exit(1)
}
if (channelSource.includes('looksLikeRateLimitText(winner.body.slice')) {
  console.error('FAIL: 不能再用正文前 N 字判频控——正常回复里的一句「稍后再试」会误伤整轮')
  process.exit(1)
}

console.log(`OK（频控识别 + 退避序列 + 提示文案，覆盖 ${discovered.size} 个错误码）`)
