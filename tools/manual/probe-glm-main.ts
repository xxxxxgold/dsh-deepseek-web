/**
 * GLM 主通道手动验收探针（不联网跑单测、不随包发布）。
 *
 * 用法：
 *   npx tsx tools/manual/probe-glm-main.ts --site chatglm --model glm-5.3 --effort low
 *   npx tsx tools/manual/probe-glm-main.ts --site zai --model glm-5.3-flash --effort max
 *
 * 会打开一个带独立 profile 的 Edge 窗口（默认 %LOCALAPPDATA%\DshDeepSeekWeb\glm-web-profile），
 * 留 60 秒给你登录；然后切换模型/强度、发一句话、等待回复并解析。
 */
import { chromium } from 'playwright-core'
import os from 'node:os'
import path from 'node:path'
import { detectGlmSite, ensureGlmSelection } from '../../src/glm-sites.ts'
import { parseGlmChatglmStream, parseGlmCompletion } from '../../src/glm-channel.ts'
import type { GlmWebModelId, GlmWebReasoningEffortId } from '../../src/web-models.ts'

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

const site = arg('site', 'chatglm') === 'zai' ? 'zai' : 'chatglm'
const model = arg('model', 'glm-5.3') as GlmWebModelId
const effort = arg('effort', 'high') as GlmWebReasoningEffortId
const url = site === 'zai' ? 'https://chat.z.ai/' : 'https://chatglm.cn/'
const profileDir = arg('profile', path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'DshDeepSeekWeb', 'glm-web-profile'))

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: false,
  viewport: null,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
})
const page = context.pages()[0] ?? await context.newPage()
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.bringToFront()
console.log(`[probe] ${url}，60 秒内可完成登录；随后自动选择 ${model} / ${effort}`)
await page.waitForTimeout(60_000)

const close = page.locator('[role="dialog"] button[aria-label="关闭"]').first()
if (await close.isVisible().catch(() => false)) await close.click().catch(() => {})

await ensureGlmSelection(page, detectGlmSite(url), { model, effort })
const label = await page.locator('.think-label').first().innerText().catch(() => '(z.ai 无触发器文案)')
console.log('[probe] 选择完成，触发器：', label.replace(/\n/g, ''))

const editor = page.locator('textarea, div[contenteditable="true"], div[role="textbox"]').filter({ visible: true }).last()
await editor.click()
await page.keyboard.insertText('请只回复四个字：链路正常')
const responsePromise = page.waitForResponse(
  response => response.request().method() === 'POST'
    && (site === 'chatglm' ? response.url().includes('assistant/stream') : /chat\/completions/i.test(response.url())),
  { timeout: 120_000 },
)
await page.keyboard.press('Enter')
const response = await responsePromise
const body = await response.body()
const parsed = site === 'chatglm' ? parseGlmChatglmStream(body) : parseGlmCompletion(body)
console.log('[probe] 解析结果：', JSON.stringify(parsed).slice(0, 500))
console.log(`[probe] ${parsed.text.includes('链路正常') ? 'PASS' : 'FAIL'}：正文应包含「链路正常」`)
await context.close()
