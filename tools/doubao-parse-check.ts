/**
 * 豆包 SSE 解析器回归：用 2026-10-26 的真实响应样本校验正文、模式字段与编码。
 * 运行：npx tsx tools/doubao-parse-check.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { classifyDoubaoResponse, decodeDoubaoCp1252, matchesDoubaoCompletion, parseDoubaoCompletion } from '../src/doubao-parse.ts'

const fixtureDir = path.join(import.meta.dirname, 'fixtures', 'doubao')
const readFixture = (name: string): string => readFileSync(path.join(fixtureDir, name), 'utf8')

// URL 判定
assert.equal(matchesDoubaoCompletion('https://www.doubao.com/chat/completion?aid=497858'), true)
assert.equal(matchesDoubaoCompletion('https://www.doubao.com/chat/completion'), true)
assert.equal(matchesDoubaoCompletion('https://www.doubao.com/chat'), false)
assert.equal(matchesDoubaoCompletion('https://www.doubao.com/api/v0/chat/completionX'), false)

// CP1252 反解
assert.equal(decodeDoubaoCp1252('è±†åŒ…'), '豆包')
assert.equal(decodeDoubaoCp1252('åªå›žå¤ OK ä¸¤ä¸ªå­—'), '只回复 OK 两个字')
assert.equal(decodeDoubaoCp1252('正常中文 unchanged'), '正常中文 unchanged')
assert.equal(decodeDoubaoCp1252('plain ascii'), 'plain ascii')

// 短回复：正文只在 STREAM_MSG_NOTIFY 首包里
const shortOk = parseDoubaoCompletion(readFixture('short-ok.sse.txt'))
assert.equal(shortOk.text.trim(), 'OK')
assert.equal(shortOk.finishReason, 'stop')
assert.equal(shortOk.ended, true)
assert.equal(shortOk.conversationId, '38449634834558210')
assert.equal(shortOk.mode?.modelItemKey, '0')
assert.equal(shortOk.mode?.replyMode, '0')

// 快速模式 + 围栏 JSON：正文不能重复，action 必须完整
const fast = parseDoubaoCompletion(readFixture('turn1-fast.sse.txt'))
assert.equal(fast.ended, true)
assert.equal(fast.finishReason, 'stop')
assert.equal(fast.mode?.modelItemKey, '0')
assert.equal(fast.mode?.replyMode, '0')
assert.equal((fast.text.match(/"actions"/g) ?? []).length, 1, `actions 重复：${fast.text}`)
assert.match(fast.text, /\{\"actions\":\[\{\"tool\":\"list\",\"arguments\":\{\"path\":\"D:\\\\dsh\\\\ds-web\\\\src\"\}\}\]\}/)
assert.ok(fast.text.trim().startsWith('```json'), fast.text.slice(0, 80))
assert.ok(fast.text.trim().endsWith('```'), fast.text.slice(-40))

// 专家模式：服务端回执必须是 3/3
const expert = parseDoubaoCompletion(readFixture('turn1-expert.sse.txt'))
assert.equal(expert.ended, true)
assert.equal(expert.mode?.modelItemKey, '3')
assert.equal(expert.mode?.replyMode, '3')
assert.match(expert.text, /"tool":"list"/)

// 中文最终正文：CHUNK_DELTA 路径
const final = parseDoubaoCompletion(readFixture('turn2-final.sse.txt'))
assert.equal(final.ended, true)
assert.ok(final.text.length > 20, `正文本体过短：${JSON.stringify(final.text)}`)
assert.match(final.text, /30/)
assert.match(final.text, /\.ts/)

// 空输入：不抛错、按 interrupted 处理
const empty = parseDoubaoCompletion('')
assert.equal(empty.text, '')
assert.equal(empty.ended, false)
assert.equal(empty.finishReason, 'interrupted')

// 增量片段：同一 block 连续两个「哈」不能被当成累计快照去重
const repeated = [
  'event: STREAM_MSG_NOTIFY\ndata: {"content":{"content_block":[{"block_type":10000,"block_id":"b1","content":{"text_block":{"text":"哈"}}}]}}',
  'event: STREAM_CHUNK\ndata: {"patch_op":[{"patch_object":1,"patch_value":{"content_block":[{"block_type":10000,"block_id":"b1","content":{"text_block":{"text":"哈哈"}}}]}}]}',
  'event: SSE_REPLY_END\ndata: {"end_type":2}',
].join('\n\n')
assert.equal(parseDoubaoCompletion(repeated).text, '哈哈哈')

// HTTP/JSON 错误映射：登录/频控不能被拖成首响应超时
assert.equal(classifyDoubaoResponse(401, 'application/json', '{}')?.code, 'DOUBAO_LOGIN_REQUIRED')
assert.equal(classifyDoubaoResponse(403, 'text/plain', '')?.code, 'DOUBAO_LOGIN_REQUIRED')
assert.equal(classifyDoubaoResponse(429, 'application/json', '{}')?.code, 'WEB_RATE_LIMITED')
assert.equal(classifyDoubaoResponse(200, 'application/json', '{"code":710012001,"msg":"登录已过期"}')?.code, 'DOUBAO_LOGIN_REQUIRED')
assert.equal(classifyDoubaoResponse(200, 'application/json', '{"code":710022002,"msg":"请求过于频繁"}')?.code, 'WEB_RATE_LIMITED')
assert.equal(classifyDoubaoResponse(500, 'application/json', '{}')?.code, 'DOUBAO_HTTP_ERROR')
assert.equal(classifyDoubaoResponse(200, 'text/event-stream', ''), undefined)

console.log('doubao-parse-check: OK')
console.log(JSON.stringify({
  short: shortOk.text,
  fastMode: fast.mode,
  expertMode: expert.mode,
  finalTextHead: final.text.slice(0, 120),
}, null, 2))
