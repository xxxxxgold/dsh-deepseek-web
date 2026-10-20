/**
 * 用真实浏览器（本机 Edge，headless）验证 `sendEditorMessage` 的发送确认逻辑。
 *
 * 这是问题一「文字填进去了但没发送，必须人工点一下」的回归测试节点。
 * 四个场景覆盖真实站点的三类发送行为 + 一类网络先发的形态：
 *
 *   A. 回车即发送（Kimi / DeepSeek 网页版的默认行为）—— 必须由 Enter 一次搞定；
 *   B. 回车只换行，必须点发送按钮 —— 必须由按钮兜底，不能报失败；
 *   C. 回车无效、按钮禁用 —— 必须返回未发送，并把每次尝试写进 attempts；
 *   D. 输入框还没清空、但网络层已看到请求 —— 必须判为已发送（站点清空有延迟）。
 *
 * 判定“真的发出去了”不只靠返回值，还核对页面内计数器 `window.__sent`，
 * 避免只看输入框状态变化造成的假阳性。
 *
 * 需要本机有 Edge/Chrome；找不到浏览器时打印 SKIP 并以 0 退出（不阻断无头环境）。
 */
import { chromium, type Browser, type Page } from 'playwright-core'
import { locateEditor, readEditorText, sendEditorMessage } from '../src/browser-shared.ts'

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

/** 页面骨架：一个输入区 + 一个发送按钮，行为由 mode 决定。 */
function pageHtml(mode: 'enter' | 'button' | 'dead', tag: 'div' | 'textarea'): string {
  const editor = tag === 'textarea'
    ? '<textarea id="ed"></textarea>'
    : '<div id="ed" contenteditable="true"></div>'
  const script = `
    const ed = document.getElementById('ed')
    window.__sent = 0
    const send = () => {
      const text = ed.tagName === 'TEXTAREA' ? ed.value : ed.innerText
      if (!text.trim()) return
      window.__sent += 1
      if (ed.tagName === 'TEXTAREA') ed.value = ''
      else ed.innerText = ''
    }
    ${mode === 'enter' ? `
      ed.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
      })` : ''}
  `
  const disabled = mode === 'dead' ? ' disabled' : ''
  const onclick = mode === 'dead' ? '' : ' onclick="send()"'
  return `<!doctype html><html><body>
    ${editor}
    <button id="btn" aria-label="发送"${onclick}${disabled}>发送</button>
    <script>${script}</script>
  </body></html>`
}

async function openCase(browser: Browser, html: string): Promise<Page> {
  const page = await browser.newPage()
  await page.setContent(html)
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
    console.log(`SKIP: 本机没有可用的 Edge/Chrome，跳过真实浏览器发送校验（${error instanceof Error ? error.message : error}）`)
    return
  }

  try {
    // ---- 前置：readEditorText 对两种输入框都要读得到 ----
    const areaPage = await openCase(browser, pageHtml('enter', 'textarea'))
    const area = locateEditor(areaPage)
    await area.fill('textarea 内容')
    check('readEditorText 读 textarea', await readEditorText(area), 'textarea 内容')
    await areaPage.close()

    const editPage = await openCase(browser, pageHtml('enter', 'div'))
    const edit = locateEditor(editPage)
    await edit.click()
    await editPage.keyboard.insertText('contenteditable 内容')
    check('readEditorText 读 contenteditable', await readEditorText(edit), 'contenteditable 内容')
    await editPage.close()

    // ---- 场景 A：回车即发送（Kimi / DeepSeek 网页版默认行为）----
    {
      const page = await openCase(browser, pageHtml('enter', 'div'))
      const editor = locateEditor(page)
      await editor.click()
      await page.keyboard.insertText('请审核这段产出')
      // 不传 hasResponse：这里要检验的就是「回车本身有没有把消息发出去」，
      // 只能靠输入框被清空来判定，不能靠外部信号放水。
      const outcome = await sendEditorMessage(page, editor, { verifyTimeoutMs: 1_000, maxAttempts: 2 })
      check('A 回车即发送：判定已发送', outcome.sent, true)
      check('A 回车即发送：走的是回车路径', outcome.via, 'enter')
      check('A 回车即发送：页面确实收到并清空', await page.evaluate(() => (window as never as { __sent: number }).__sent), 1)
      check('A 回车即发送：输入框已清空', await readEditorText(editor), '')
      await page.close()
    }

    // ---- 场景 B：回车只换行，必须点按钮 ----
    {
      const page = await openCase(browser, pageHtml('button', 'div'))
      const editor = locateEditor(page)
      await editor.click()
      await page.keyboard.insertText('请审核这段产出')
      const outcome = await sendEditorMessage(page, editor, { verifyTimeoutMs: 400, maxAttempts: 2 })
      check('B 回车换行：判定已发送', outcome.sent, true)
      check('B 回车换行：走的是按钮兜底', outcome.via, 'button')
      check('B 回车换行：页面确实收到一次', await page.evaluate(() => (window as never as { __sent: number }).__sent), 1)
      await page.close()
    }

    // ---- 场景 C：回车无效 + 按钮禁用 ----
    {
      const page = await openCase(browser, pageHtml('dead', 'div'))
      const editor = locateEditor(page)
      await editor.click()
      await page.keyboard.insertText('请审核这段产出')
      const outcome = await sendEditorMessage(page, editor, { verifyTimeoutMs: 300, maxAttempts: 2 })
      check('C 发不出去：判定未发送', outcome.sent, false)
      check('C 发不出去：via 为 none', outcome.via, 'none')
      check('C 发不出去：页面从未收到', await page.evaluate(() => (window as never as { __sent: number }).__sent), 0)
      check('C 发不出去：记录了两轮尝试', outcome.attempts.length >= 2, true)
      check('C 发不出去：尝试记录里写明按钮不可用', outcome.attempts.some(item => item.includes('按钮不可用')), true)
      await page.close()
    }

    // ---- 场景 D：输入框没清空，但网络层已发出 ----
    {
      const page = await openCase(browser, pageHtml('dead', 'div'))
      const editor = locateEditor(page)
      await editor.click()
      await page.keyboard.insertText('请审核这段产出')
      let seen = false
      const outcome = await sendEditorMessage(page, editor, {
        verifyTimeoutMs: 400,
        maxAttempts: 1,
        hasResponse: () => { seen = true; return seen },
      })
      check('D 网络先发：判定已发送', outcome.sent, true)
      await page.close()
    }

    // ---- 空输入框不应触发任何点击 ----
    {
      const page = await openCase(browser, pageHtml('enter', 'div'))
      const editor = locateEditor(page)
      const outcome = await sendEditorMessage(page, editor, { verifyTimeoutMs: 200, maxAttempts: 2 })
      check('空输入框：判定未发送', outcome.sent, false)
      check('空输入框：页面未收到', await page.evaluate(() => (window as never as { __sent: number }).__sent), 0)
      await page.close()
    }
  } finally {
    await browser.close().catch(() => {})
  }

  if (failures > 0) {
    console.error(`\n${failures} 项失败`)
    process.exit(1)
  }
  console.log('\n真实浏览器发送确认检查全部通过')
}

await main()
