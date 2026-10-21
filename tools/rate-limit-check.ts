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
import { looksLikeRateLimitText } from '../src/browser-shared.ts'
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

console.log(`OK（频控识别 + 退避序列 + 提示文案，覆盖 ${discovered.size} 个错误码）`)
