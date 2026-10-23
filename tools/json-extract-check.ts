/**
 * extractJsonObject 回归：
 * - 固定形态（围栏、散文夹带、孤立引号、未闭合前缀、字符串内花括号）结果正确；
 * - 与旧实现（逐起点重扫）在随机文本上等价；
 * - 病态输入（大量未闭合 `{`）不再退化成 O(n²)。
 */
import assert from 'node:assert/strict'
import { extractJsonObject } from '../src/response.ts'

/** 旧实现原样复制，作为等价性对照；只用于本回归，不参与运行时。 */
function legacyExtractJsonObject(text: string): unknown | undefined {
  let candidate = text.trim()
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i)
  if (fenced) candidate = fenced[1]!.trim()
  for (let start = candidate.indexOf('{'); start >= 0; start = candidate.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]!
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return undefined
}

const fixed: Array<[string, string, unknown]> = [
  ['裸 JSON', '{"actions":[{"tool":"read"}]}', { actions: [{ tool: 'read' }] }],
  ['围栏', '```json\n{"actions":[]}\n```', { actions: [] }],
  ['散文夹带', '好的：\n{"tool":"x"}\n完毕。', { tool: 'x' }],
  ['孤立引号后仍有对象', '他说："没闭合 然后 {"tool":"x"}', { tool: 'x' }],
  ['字符串内花括号不算', '{"a":"文字 { 和 } 不算","b":1}', { a: '文字 { 和 } 不算', b: 1 }],
  ['转义引号', '{"a":"他说 \\"你好\\" {x}"}', { a: '他说 "你好" {x}' }],
  ['嵌套', '{"a":{"b":{"c":[1,2,{"d":"}"}]}}}', { a: { b: { c: [1, 2, { d: '}' }] } } }],
  ['未闭合前缀后取内层', '代码 { 未闭合 里面 {"tool":"x"} 后面', { tool: 'x' }],
  ['首段非法次段合法', '{bad} 然后 {"b":2}', { b: 2 }],
  ['纯文本', '没有任何 JSON 对象', undefined],
  ['空串', '', undefined],
]
for (const [label, input, expected] of fixed) {
  assert.deepEqual(extractJsonObject(input), expected, `固定用例失败：${label}`)
}

let seed = 20261023
const rng = (): number => {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const alphabet = ['{', '}', '"', '\\', 'a', ':', ',', '1', ' ', '\n', '[', ']', 't', 'r', 'u', 'e']
let randomCases = 0
for (let i = 0; i < 5000; i++) {
  let input = ''
  const length = Math.floor(rng() * 60)
  for (let k = 0; k < length; k++) input += alphabet[Math.floor(rng() * alphabet.length)]
  if (rng() < 0.5) input += JSON.stringify({ tool: 'x', n: Math.floor(rng() * 10) })
  if (rng() < 0.3) input = '```json\n' + input + '\n```'
  // 候选起点超过首尾各 32 个时新实现有意截断，这类输入不参与等价断言。
  const braces = input.split('{').length - 1
  if (braces > 64) continue
  randomCases++
  assert.deepEqual(
    extractJsonObject(input),
    legacyExtractJsonObject(input),
    `随机用例与旧实现不一致：${JSON.stringify(input.slice(0, 120))}`,
  )
}

const patho = ('{ 未闭合的代码片段 ' + 'a'.repeat(5)).repeat(1500).slice(0, 16_000)
const startedAt = performance.now()
assert.equal(extractJsonObject(patho), undefined)
const pathoMs = performance.now() - startedAt
assert.ok(pathoMs < 50, `病态输入耗时 ${pathoMs.toFixed(1)}ms，超过 50ms 预算`)

const actions = JSON.stringify({ actions: [{ tool: 'read', params: { file_path: 'src/a.ts' } }] })
const prose = '这是一段普通的回答，'.repeat(2000).slice(0, 20_000) + actions
const commonStart = performance.now()
for (let i = 0; i < 100; i++) assert.ok(extractJsonObject(prose))
const commonMs = (performance.now() - commonStart) / 100
assert.ok(commonMs < 5, `20KB 散文 + actions 单次 ${commonMs.toFixed(2)}ms，超过 5ms 预算`)

console.log(
  `json-extract-check: ${fixed.length} 条固定形态 + ${randomCases} 条随机等价 + 病态 ${pathoMs.toFixed(2)}ms / 常见 ${commonMs.toFixed(3)}ms 通过`,
)
