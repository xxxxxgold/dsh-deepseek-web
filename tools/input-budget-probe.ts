/**
 * 真实容量探针：向 chat.deepseek.com 输入框逐级填入超长文本，测“能塞多大”。
 *
 * 用途：为 `maxToolResultChars`（默认 6000）与 `maxToolCatalogChars`（默认 28000）
 * 找真实投递上限——这两个配置最终都只是把一段更长的文本塞进网页输入框，
 * 配置本身没有 max，真正的天花板在网页/浏览器这一侧。
 *
 * 做法（不碰用户已有标签页）：
 * 1. 通过 CDP 连接已在跑的调试浏览器（默认 50986，即插件当前用的那个 profile）；
 * 2. 每档新开一个标签页，导航到 chat.deepseek.com；
 * 3. 点输入框 → Ctrl+A → Backspace → `insertText` 一次性填入 N 字（与插件同一条路径），
 *    记录填字耗时；
 * 4. 回车发送，轮询页面正文，找模型**计算后**回显的两个标记。
 *
 * 标记口径（关键）：负载里只出现正序的 `HEAD-xxx` / `TAIL-yyy`，提示词只要求
 * “把两个标记各自倒序后用 R-|S- 格式回复”，**倒序串本身不出现在负载里**。
 * 因此页面上出现 `R-<倒序>` / `S-<倒序>` 只可能来自模型输出，不会被自己的提问误判。
 *
 * 用法：
 *   npx tsx tools/input-budget-probe.ts
 *   PROBE_PORT=50986 PROBE_SIZES=6000,28000,60000 npx tsx tools/input-budget-probe.ts
 *   PROBE_OUT=.trellis/tasks/xxx/probe-results.json
 */
import { writeFile } from 'node:fs/promises'
import { chromium, type Browser, type Page } from 'playwright-core'
import { locateEditor } from '../src/browser-shared.ts'

const PORT = Number(process.env.PROBE_PORT ?? 50986)
const SIZES = (process.env.PROBE_SIZES ?? '6000,28000,60000,120000,200000,300000')
  .split(',')
  .map(item => Number(item.trim()))
  .filter(item => Number.isFinite(item) && item > 0)
const OUT = process.env.PROBE_OUT ?? 'probe-results.json'
const GAP_MS = Number(process.env.PROBE_GAP_MS ?? 20_000)
const REPLY_TIMEOUT_MS = Number(process.env.PROBE_REPLY_TIMEOUT_MS ?? 180_000)

interface ProbeResult {
  targetChars: number
  actualChars: number
  fillMs: number
  sendMs: number
  replyMs: number
  totalMs: number
  editorCleared: boolean
  conversationUrl: string
  headSeen: boolean
  tailSeen: boolean
  rateLimited: boolean
  verdict: 'full' | 'tail-truncated' | 'head-truncated' | 'failed' | 'rate-limited'
  replySnippet: string
  note?: string
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const code = (): string => Math.random().toString(36).slice(2, 8).toUpperCase()
const reverse = (text: string): string => [...text].reverse().join('')

/** 造一段恰好 `size` 字的负载：开头和结尾各带一个正序标记，其余用可辨识的行填充。 */
function buildPayload(size: number, head: string, tail: string): string {
  const header = '【容量测试】下面是一段占位文本，不要总结它。'
    + `这段文本开头的标记是 HEAD-${head}，结尾的标记是 TAIL-${tail}。`
    + '请把这两个标记各自倒序排列，然后只回复一行：R-<倒序后的开头标记>|S-<倒序后的结尾标记>。'
    + '不要复述原文，不要解释。\n'
  const footer = `\n【结束】尾部标记 TAIL-${tail}\n`
  const line = '这是一段用于填充输入框的测试文本，不包含任何需要执行的内容。\n'
  const bodyBudget = Math.max(0, size - header.length - footer.length)
  const repeat = Math.ceil(bodyBudget / line.length)
  const body = line.repeat(repeat).slice(0, bodyBudget)
  return header + body + footer
}

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? '')
}

async function runOne(browser: Browser, size: number, index: number): Promise<ProbeResult> {
  const head = code()
  const tail = code()
  const wantHead = `R-${reverse(head)}`
  const wantTail = `S-${reverse(tail)}`
  const payload = buildPayload(size, head, tail)
  const context = browser.contexts()[0]
  if (!context) throw new Error('CDP 浏览器没有默认 context')
  const page = await context.newPage()
  const started = Date.now()
  let fillMs = 0
  let sendMs = 0
  let replyMs = 0
  let headSeen = false
  let tailSeen = false
  let rateLimited = false
  let editorCleared = false
  let conversationUrl = ''
  let verdict: ProbeResult['verdict'] = 'failed'
  let replySnippet = ''
  let note: string | undefined

  try {
    await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1_500)
    const editor = locateEditor(page)
    await editor.waitFor({ state: 'visible', timeout: 30_000 })
    await editor.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')

    const fillStart = Date.now()
    await page.keyboard.insertText(payload)
    fillMs = Date.now() - fillStart

    const sendStart = Date.now()
    await page.keyboard.press('Enter')
    sendMs = Date.now() - sendStart
    await page.waitForTimeout(1_500)
    conversationUrl = page.url()
    editorCleared = (await editor.innerText().catch(() => '')).trim().length === 0

    const deadline = Date.now() + REPLY_TIMEOUT_MS
    let text = ''
    while (Date.now() < deadline) {
      await sleep(1_000)
      text = await bodyText(page)
      headSeen = text.includes(wantHead)
      tailSeen = text.includes(wantTail)
      if (headSeen && tailSeen) break
      if (/过于频繁|发送太快|稍后再试|rate[._\s-]?limit/i.test(text)) {
        rateLimited = true
        break
      }
    }
    replyMs = Date.now() - sendStart
    replySnippet = text.slice(-300).replace(/\s+/g, ' ').trim()

    if (rateLimited) verdict = 'rate-limited'
    else if (headSeen && tailSeen) verdict = 'full'
    else if (!headSeen && tailSeen) verdict = 'head-truncated'
    else if (headSeen && !tailSeen) verdict = 'tail-truncated'
    else verdict = 'failed'
    if (verdict === 'failed' && /输入内容过长|内容过长|超出.{0,6}限制|too long|对话长度/i.test(text)) {
      note = '页面提示内容过长/达到对话长度上限'
    }
  } catch (error) {
    note = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  } finally {
    await page.close().catch(() => {})
  }

  const result: ProbeResult = {
    targetChars: size,
    actualChars: payload.length,
    fillMs,
    sendMs,
    replyMs,
    totalMs: Date.now() - started,
    editorCleared,
    conversationUrl,
    headSeen,
    tailSeen,
    rateLimited,
    verdict,
    replySnippet,
    ...(note ? { note } : {}),
  }
  console.info(
    `[probe ${index + 1}/${SIZES.length}] ${size} 字 → ${verdict}`
    + `（填字 ${fillMs}ms，回包 ${replyMs}ms，head=${headSeen} tail=${tailSeen}，清空=${editorCleared}）`
    + (note ? ` 备注：${note}` : ''),
  )
  return result
}

const results: ProbeResult[] = []
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
try {
  console.info(`[probe] 已连接 CDP :${PORT}，档位：${SIZES.join(', ')}`)
  for (const [index, size] of SIZES.entries()) {
    const result = await runOne(browser, size, index)
    results.push(result)
    await writeFile(OUT, JSON.stringify({ at: new Date().toISOString(), port: PORT, results }, null, 2), 'utf8')
    if (result.verdict !== 'full') {
      console.info(`[probe] ${size} 字这一档未通过（${result.verdict}），停止加压。`)
      break
    }
    if (index < SIZES.length - 1) await sleep(GAP_MS)
  }
} finally {
  await browser.close().catch(() => {})
}

console.info(`[probe] 结果已写入 ${OUT}`)
console.info(JSON.stringify(results, null, 2))
