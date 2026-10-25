/**
 * 真实链路探针：开启 liveThinking（显示网页思考过程）后跑一轮，看会出什么问题。
 *
 * 观测点：
 * 1. 思考增量是否真的到达（条数、首条延迟、最大间隔、总字数）；
 * 2. 流式累计与最终解析是否一致（重复、缺尾、错位）；
 * 3. 正文是否被思考污染（正文里不应出现思考片段）；
 * 4. 页面是否报错（重点是打包器注入 __name 缺失那类）；
 * 5. 代价：思考文本会作为 reasoning 块进入会话，量有多大。
 *
 * 用法：npx tsx tools/live-thinking-probe.ts
 *      PROBE_PORT=9456 PROBE_OUT=thinking.json
 */
import { writeFile } from 'node:fs/promises'
import { chromium, type ConsoleMessage, type Page } from 'playwright-core'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { PlaywrightBrowserChannel } from '../src/playwright-channel.ts'

const PORT = Number(process.env.PROBE_PORT ?? 9456)
const OUT = process.env.PROBE_OUT ?? 'thinking-probe.json'
const PROMPT = process.env.PROBE_PROMPT
  ?? '一个三位数，各位数字之和是 15，十位数字比百位数字大 3，个位数字是百位数字的 2 倍。求这个数。只回答数字。'

const config = liveConfig(Config({
  browser: 'attach',
  debugPort: PORT,
  sendMode: 'approved',
  model: 'deepseek-web',
  liveThinking: true,
  focus: { enabled: false, webWindow: false, dshWindow: false },
  review: { enabled: false },
  sendPauseMinMs: 0,
  sendPauseMaxMs: 0,
  turnGapMinMs: 0,
  turnGapMaxMs: 0,
  maxSessionPages: 1,
}))

const inspector = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
const consoleErrors: string[] = []
const watch = (page: Page): void => {
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300))
  })
}
const context = inspector.contexts()[0]
for (const page of context?.pages() ?? []) watch(page)
context?.on('page', page => watch(page))

const channel = new PlaywrightBrowserChannel({ config })
const started = Date.now()
let firstDeltaMs = 0
let lastDeltaMs = 0
let maxGapMs = 0
let deltas = 0
let streamedText = ''
const samples: Array<{ at: number; chars: number }> = []

try {
  await channel.ensureReady()
  const result = await channel.turn({
    sessionId: 'dsh-thinking-probe',
    model: 'deepseek-web',
    text: PROMPT,
    initialize: true,
    autoSend: true,
    onProgress: progress => {
      if (!progress.reasoning) return
      const now = Date.now() - started
      if (firstDeltaMs === 0) firstDeltaMs = now
      if (lastDeltaMs > 0) maxGapMs = Math.max(maxGapMs, now - lastDeltaMs)
      lastDeltaMs = now
      deltas += 1
      streamedText += progress.reasoning
      samples.push({ at: now, chars: progress.reasoning.length })
    },
  })
  const finalReasoning = result.reasoning ?? ''
  const payload = {
    ok: true,
    promptChars: PROMPT.length,
    totalMs: Date.now() - started,
    deltas,
    streamedChars: streamedText.length,
    firstDeltaMs,
    lastDeltaMs,
    maxGapMs,
    finalReasoningChars: finalReasoning.length,
    finalTextChars: result.text.length,
    finishReason: result.finishReason ?? null,
    streamIsPrefixOfFinal: finalReasoning.startsWith(streamedText),
    tailFilledByFinal: Math.max(0, finalReasoning.length - streamedText.length),
    textHasReasoningLeak: finalReasoning.length > 40 && result.text.includes(finalReasoning.slice(0, 40)),
    consoleErrors: consoleErrors.filter(text => !/favicon|net::ERR|Failed to load resource/i.test(text)).slice(0, 10),
    textHead: result.text.slice(0, 120).replace(/\s+/g, ' '),
    reasoningHead: finalReasoning.slice(0, 120).replace(/\s+/g, ' '),
    samples: samples.slice(0, 200),
  }
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8')
  console.info(JSON.stringify(payload, null, 2))
} catch (error) {
  const payload = {
    ok: false,
    totalMs: Date.now() - started,
    deltas,
    streamedChars: streamedText.length,
    firstDeltaMs,
    lastDeltaMs,
    maxGapMs,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    consoleErrors,
  }
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8')
  console.info(JSON.stringify(payload, null, 2))
  process.exitCode = 1
} finally {
  await channel.dispose().catch(() => {})
  await inspector.close().catch(() => {})
}

// CDP 连接和页面定时器会让 Node 保持事件循环，探测结束后直接退出。
setTimeout(() => process.exit(process.exitCode ?? 0), 500)
