/**
 * DeepSeek 新版发送按钮的定位回归。
 *
 * 背景：2026-10 的 chat.deepseek.com 把发送按钮改成
 * `<div role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle">`，
 * 没有 aria-label / title / data-testid，也不是 <button>；禁用态用 `opacity: 0.4` 表达；
 * 生成中同一个按钮会变成「停止生成」（SVG path 从箭头变成方块）。
 *
 * 旧实现的 8 条候选全部要求 <button> 或 aria-label/title，因此按钮兜底从未生效。
 *
 * 本用例断言的是外部接缝：`sendEditorMessage()` 的返回值 + 页面内真实计数器
 * `window.__sent` / `window.__stopped`，不照抄内部实现细节。
 *
 * 场景：
 *   A. 回车无效（模拟未绑定键盘事件）→ 必须由按钮兜底发出；
 *   B. 按钮禁用（opacity 0.4）→ 不得点击，必须判为未发送；
 *   C. 生成中（停止图标）→ 不得误点停止；等生成结束后应正常发出；
 *   D. 正常回车 → 不回归。
 */
import { chromium, type Browser, type Page } from 'playwright-core'
import { locateEditor, locateSendButton, sendEditorMessage } from '../src/browser-shared.ts'

const SEND_PATH = 'M8.3125 0.980206C8.66767 1.05312 8.97902 1.2042 9.2627 1.43235L14.707 6.8347'
const STOP_PATH = 'M2 4.88C2 3.68009 2 3.08013 2.30557 2.65954C2.40426 2.52371 2.52371 2.40426 2.65954 2.30557'

type Mode = 'button' | 'dead' | 'generating' | 'enter'

function pageHtml(mode: Mode): string {
  return `<!doctype html><html><body>
    <textarea id="ed" placeholder="给 DeepSeek 发送消息"></textarea>
    <div id="bar">
      <div role="button" id="btn"
           class="ds-button ds-button--primary ds-button--filled ds-button--circle ds-button--m"
           style="opacity:0.4">
        <div class="ds-button__icon"><svg viewBox="0 0 16 16"><path id="icon" d="${SEND_PATH}"/></svg></div>
      </div>
    </div>
    <script>
      const ed = document.getElementById('ed')
      const btn = document.getElementById('btn')
      const icon = document.getElementById('icon')
      const MODE = ${JSON.stringify(mode)}
      window.__sent = 0
      window.__stopped = 0
      let generating = MODE === 'generating'

      const render = () => {
        if (generating) {
          icon.setAttribute('d', ${JSON.stringify(STOP_PATH)})
          btn.style.opacity = '1'
          return
        }
        icon.setAttribute('d', ${JSON.stringify(SEND_PATH)})
        const hasText = ed.value.trim().length > 0
        btn.style.opacity = MODE === 'dead' ? '0.4' : (hasText ? '1' : '0.4')
      }

      ed.addEventListener('input', render)
      ed.addEventListener('keydown', e => {
        if (MODE !== 'enter') return
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          if (!ed.value.trim()) return
          window.__sent += 1
          ed.value = ''
          render()
        }
      })
      btn.addEventListener('click', () => {
        if (generating) { window.__stopped += 1; return }
        if (MODE === 'dead') return
        if (!ed.value.trim()) return
        window.__sent += 1
        ed.value = ''
        render()
      })
      // 生成中：500ms 后结束，按钮恢复成发送态
      if (MODE === 'generating') setTimeout(() => { generating = false; render() }, 500)
      render()
    </script>
  </body></html>`
}

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

async function openCase(browser: Browser, mode: Mode): Promise<Page> {
  const page = await browser.newPage()
  await page.setContent(pageHtml(mode))
  return page
}

async function main(): Promise<void> {
  let browser: Browser
  try {
    browser = await chromium.launch({
      headless: true,
      channel: process.platform === 'win32' ? 'msedge' : undefined,
    })
  } catch (error) {
    console.log(`SKIP: 本机没有可用的 Edge/Chrome，跳过发送按钮定位校验（${error instanceof Error ? error.message : error}）`)
    return
  }

  try {
    // 定位层：新版按钮必须能被 locateSendButton 命中
    const barPage = await openCase(browser, 'button')
    check('新版发送按钮被 locateSendButton 命中', await locateSendButton(barPage).count(), 1)
    await barPage.close()

    // A. 回车无效 → 按钮兜底必须发出
    {
      const page = await openCase(browser, 'button')
      const editor = locateEditor(page)
      await editor.click()
      await page.keyboard.insertText('A 场景：回车无效，按钮兜底')
      const outcome = await sendEditorMessage(page, editor, { verifyTimeoutMs: 300, maxAttempts: 2 })
      check('A 回车无效时由按钮发出', outcome.sent, true)
      check('A 实际发出次数', await page.evaluate(() => (window as any).__sent), 1)
      await page.close()
    }

    // B. 按钮禁用（opacity 0.4）→ 不得点击、不得判成功
    {
      const page = await openCase(browser, 'dead')
      const editor = locateEditor(page)
      await editor.click()
      await page.keyboard.insertText('B 场景：按钮禁用')
      const outcome = await sendEditorMessage(page, editor, { verifyTimeoutMs: 300, maxAttempts: 2 })
      check('B 禁用态判为未发送', outcome.sent, false)
      check('B 禁用态未产生发送', await page.evaluate(() => (window as any).__sent), 0)
      check('B 尝试记录说明按钮不可用', outcome.attempts.some(item => item.includes('按钮不可用')), true)
      await page.close()
    }

    // C. 生成中（停止图标）→ 不得误点停止；生成结束后应发出
    {
      const page = await openCase(browser, 'generating')
      const editor = locateEditor(page)
      await editor.click()
      await page.keyboard.insertText('C 场景：生成中等待')
      const outcome = await sendEditorMessage(page, editor, {
        verifyTimeoutMs: 300,
        maxAttempts: 2,
        generatingWaitMs: 1_500,
      })
      check('C 未误点停止生成', await page.evaluate(() => (window as any).__stopped), 0)
      check('C 生成结束后由按钮发出', outcome.sent, true)
      check('C 实际发出次数', await page.evaluate(() => (window as any).__sent), 1)
      await page.close()
    }

    // D. 正常回车 → 不回归
    {
      const page = await openCase(browser, 'enter')
      const editor = locateEditor(page)
      await editor.click()
      await page.keyboard.insertText('D 场景：回车发送')
      const outcome = await sendEditorMessage(page, editor, { verifyTimeoutMs: 300, maxAttempts: 2 })
      check('D 回车发送成功', outcome.sent, true)
      check('D 实际发出次数', await page.evaluate(() => (window as any).__sent), 1)
      await page.close()
    }
  } finally {
    await browser.close().catch(() => {})
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} 项未通过`)
    process.exitCode = 1
  } else {
    console.log('\n全部通过')
  }
}

await main()
