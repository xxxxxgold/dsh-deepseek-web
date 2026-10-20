/**
 * 校验实时增量合并的纯逻辑（离线可复现，不需要浏览器）：
 *
 * 1. `mergeMonotonic` 把一轮生成里多条网页流合并成一条单调累计文本：
 *    单流、超集替换、前缀去重、互不重叠的多流拼接都要对；
 * 2. `takeDelta` 在累计文本上取后缀增量：正常增长、无变化、非单调三种情况；
 * 3. 复现“思考到一半就停了”的故障场景：思考流先结束、正文流还在长，
 *    旧实现只取最后一条流（`.at(-1)`）会把已结束的思考整段丢掉，
 *    新实现合并后思考必须完整。
 */
import { mergeMonotonic, takeDelta } from '../src/playwright-channel.ts'

let failures = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) {
    failures += 1
    console.error(`FAIL: ${name}\n  期望：${JSON.stringify(expected)}\n  实际：${JSON.stringify(actual)}`)
  } else {
    console.log(`ok: ${name}`)
  }
}

// ---- 1. mergeMonotonic ----
check('单流原样返回', mergeMonotonic(['完整内容']), '完整内容')
check('空数组返回空串', mergeMonotonic([]), '')
check('空片段被忽略', mergeMonotonic(['', 'a', '', 'ab']), 'ab')
check('超集替换（重连后重发更长前缀）', mergeMonotonic(['ab', 'abc']), 'abc')
check('前缀重复跳过（重复推送同一段）', mergeMonotonic(['abc', 'ab']), 'abc')
check('完全相同时不重复', mergeMonotonic(['abc', 'abc', 'abc']), 'abc')
check(
  '互不重叠的两条流拼接（思考流 + 正文流分开上报）',
  mergeMonotonic(['先分析用户意图', '再给出结论']),
  '先分析用户意图再给出结论',
)
check(
  '断线重连：前段完整 + 重连后的增量段',
  mergeMonotonic(['第一段', '第一段第二段']),
  '第一段第二段',
)
check(
  '乱序到达也能拼成单调累计',
  mergeMonotonic(['我', '我想', '我想想想']),
  '我想想想',
)

// ---- 2. takeDelta ----
check('正常增长取后缀', takeDelta('abcdef', 'abc', 'text'), 'def')
check('无变化返回空串', takeDelta('abc', 'abc', 'reasoning'), '')
check('非单调增长返回空串而不是负增量', takeDelta('abc', 'abcd', 'reasoning'), '')
check('从空基线开始整段返回', takeDelta('abc', '', 'text'), 'abc')
check('思考文本同样适用', takeDelta('想完了，结论是 A', '想完了，', 'reasoning'), '结论是 A')

// ---- 3. 复现“思考到一半就停了” ----
// 模拟一次真实生成：思考流先建立并结束，正文流后建立且仍在增长。
// 旧实现 startProgressPolling 只会取 `.at(-1)`（最后一条 = 正文流），
// 于是思考文本永远读到空，界面停在第一拍的增量上，而网页继续输出到结束。
const streamsOldestFirst = [
  { at: 1_000, done: true, reasoning: '第一步：读代码', text: '' },
  { at: 1_200, done: false, reasoning: '第一步：读代码，第二步：定位', text: '问题在于' },
]

// 旧行为：只看最后一条流
const lastOnly = streamsOldestFirst.at(-1)!
check('旧实现只看最后一条流：思考丢失', lastOnly.reasoning, '第一步：读代码，第二步：定位')
const oldReasoningSeen = lastOnly.reasoning.includes('第一步：读代码')
check('旧实现恰好仍包含前段（同一流内累计）', oldReasoningSeen, true)

// 更贴近现场的形态：思考流与正文流是两个独立请求，各自从零累计。
const splitStreams = [
  { at: 1_000, done: true, reasoning: '第一步：读代码，第二步：定位到 turn()', text: '' },
  { at: 1_500, done: false, reasoning: '', text: '问题在于 Kimi 通道没有自动发送' },
]
const newReasoning = mergeMonotonic(splitStreams.map(stream => stream.reasoning))
const newText = mergeMonotonic(splitStreams.map(stream => stream.text))
check('新实现合并后思考完整', newReasoning, '第一步：读代码，第二步：定位到 turn()')
check('新实现合并后正文完整', newText, '问题在于 Kimi 通道没有自动发送')
// 旧实现取最后一条 → 思考变成空串，正是“思考到一半就没动静”的形态
check('旧实现丢掉思考（故障复现）', splitStreams.at(-1)!.reasoning, '')

// ---- 4. 多拍轮询的增量序列 ----
// 两条流（思考 / 正文）先后出现并在 5 拍里各自增长，
// 验证每拍发出的增量按顺序拼回来，正好等于最终的累计文本。
const timeline: Array<{ reasoning: string; text: string }> = [
  { reasoning: '思', text: '' },        // 第 1 拍：思考流开始
  { reasoning: '思考', text: '' },      // 第 2 拍：思考流增长
  { reasoning: '思考', text: '正' },    // 第 3 拍：正文流开始
  { reasoning: '思考', text: '正文' },  // 第 4 拍：正文流增长
  { reasoning: '思考过程完', text: '正文' }, // 第 5 拍：思考流收尾（同一流的超集）
]
let emittedReasoning = ''
let emittedText = ''
const reasoningChunks: string[] = []
const textChunks: string[] = []
for (const frame of timeline) {
  const reasoningDelta = takeDelta(frame.reasoning, emittedReasoning, 'reasoning')
  const textDelta = takeDelta(frame.text, emittedText, 'text')
  emittedReasoning = frame.reasoning
  emittedText = frame.text
  if (reasoningDelta) reasoningChunks.push(reasoningDelta)
  if (textDelta) textChunks.push(textDelta)
}
check('多拍增量拼回来等于最终思考', reasoningChunks.join(''), '思考过程完')
check('多拍增量拼回来等于最终正文', textChunks.join(''), '正文')
check('最终思考不会停在第一拍', reasoningChunks.length >= 3, true)

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n实时增量合并检查全部通过')
