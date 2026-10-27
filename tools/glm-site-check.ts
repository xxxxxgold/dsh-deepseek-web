/**
 * GLM 站点选择器离线检查。
 *
 * 用 Playwright `setContent` 构造两站最小 DOM 夹具，直接跑 `ensureGlmSelection`：
 *   - chatglm.cn：模型菜单 + 「思考强度」二级菜单；
 *   - z.ai：模型下拉 + 三档滑杆（含未登录禁用模型）。
 *
 * 夹具只模拟选择器契约，不联网、不启动真实站点。
 *
 * 用法：tsx tools/glm-site-check.ts
 */
import { chromium, type Page } from 'playwright-core'
import { detectGlmSite, ensureGlmSelection } from '../src/glm-sites.ts'

let failed = 0
function check(ok: boolean, label: string, detail: string): void {
  if (ok) {
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}：${detail}`)
  }
}

const CHATGLM_FIXTURE = `<!doctype html><meta charset="utf-8">
<div class="composer">
  <span class="el-tooltip__trigger">
    <div class="think-mode-trigger">
      <span class="think-label">GLM-5.3-Flash<span class="think-label-think">极致</span></span>
    </div>
  </span>
  <div class="think-mode-list">
    <div class="think-mode-item">
      <div class="item-text"><span class="item-model-box"><span class="item-name">GLM-5.3</span></span></div>
    </div>
    <div class="think-mode-item selected">
      <div class="item-text"><span class="item-model-box"><span class="item-name">GLM-5.3-Flash</span></span></div>
    </div>
    <div class="think-mode-item has-submenu">
      <span class="item-think">思考强度</span>
      <div class="think-submenu">
        <div class="think-mode-item">快速</div>
        <div class="think-mode-item">深度<span class="item-desc">处理复杂任务</span></div>
        <div class="think-mode-item selected">极致<span class="item-desc">全力推理，耗时更长</span></div>
      </div>
    </div>
  </div>
</div>
<script>
  const state = { model: 'GLM-5.3-Flash', effort: '极致' }
  const label = document.querySelector('.think-label')
  const menu = document.querySelector('.think-mode-list')
  menu.style.display = 'none'
  function render() {
    label.innerHTML = state.model + '<span class="think-label-think">' + state.effort + '</span>'
    document.querySelectorAll('.think-mode-list > .think-mode-item').forEach(row => {
      if (row.classList.contains('has-submenu')) return
      row.classList.toggle('selected', row.querySelector('.item-name').textContent.trim() === state.model)
    })
    document.querySelectorAll('.think-submenu .think-mode-item').forEach(item => {
      item.classList.toggle('selected', item.textContent.trim().startsWith(state.effort))
    })
  }
  document.querySelector('.think-mode-trigger').addEventListener('click', () => {
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none'
  })
  document.querySelectorAll('.think-mode-list > .think-mode-item:not(.has-submenu)').forEach(row => {
    row.addEventListener('click', () => {
      state.model = row.querySelector('.item-name').textContent.trim()
      render()
      menu.style.display = 'none'
    })
  })
  document.querySelectorAll('.think-submenu .think-mode-item').forEach(item => {
    item.addEventListener('click', () => {
      const text = item.textContent.trim()
      state.effort = text.startsWith('快速') ? '快速' : text.startsWith('深度') ? '深度' : '极致'
      render()
      menu.style.display = 'none'
    })
  })
</script>`

const ZAI_FIXTURE = `<!doctype html><meta charset="utf-8">
<div role="dialog" aria-modal="true">
  <button aria-label="关闭">×</button>
  <div>请切换至中国站点</div>
</div>
<button class="modelSelectorButton" aria-label="选择一个模型">GLM-5.3-Flash</button>
<div role="menu">
  <button aria-label="model-item" disabled data-selected="true"><span>GLM-5.3-Flash</span></button>
  <button aria-label="model-item"><span>GLM-5.3</span></button>
  <span data-slider-root style="display:block;width:240px;height:36px">
    <span role="slider" aria-label="思考强度" aria-valuemin="0" aria-valuemax="2" aria-valuenow="2" style="display:block;width:20px;height:20px"></span>
  </span>
</div>
<script>
  const menu = document.querySelector('[role="menu"]')
  menu.style.display = 'none'
  const trigger = document.querySelector('.modelSelectorButton')
  const slider = document.querySelector('[role="slider"]')
  trigger.addEventListener('click', () => {
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none'
  })
  document.querySelectorAll('[aria-label="model-item"]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.disabled) return
      document.querySelectorAll('[aria-label="model-item"]').forEach(other => other.setAttribute('data-selected', String(other === button)))
      trigger.textContent = button.textContent.trim()
      menu.style.display = 'none'
    })
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') menu.style.display = 'none'
  })
  document.querySelector('[data-slider-root]').addEventListener('click', event => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    slider.setAttribute('aria-valuenow', String(ratio < 0.25 ? 0 : ratio > 0.75 ? 2 : 1))
  })
  document.querySelector('[role="dialog"] button').addEventListener('click', () => {
    document.querySelector('[role="dialog"]').remove()
  })
</script>`

const ZAI_IGNORE_FIXTURE = `<!doctype html><meta charset="utf-8">
<button class="modelSelectorButton" aria-label="选择一个模型">OLD-MODEL</button>
<div role="menu">
  <button aria-label="model-item" data-selected="false"><span>GLM-5.3-Flash</span></button>
  <span data-slider-root style="display:block;width:240px;height:36px">
    <span role="slider" aria-label="思考强度" aria-valuemin="0" aria-valuemax="2" aria-valuenow="1" style="display:block;width:20px;height:20px"></span>
  </span>
</div>
<script>
  const menu = document.querySelector('[role="menu"]')
  menu.style.display = 'none'
  document.querySelector('.modelSelectorButton').addEventListener('click', () => {
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none'
  })
  // 模拟点击被遮罩拦截：点击处理器存在但不更新任何状态。
  document.querySelectorAll('[aria-label="model-item"]').forEach(button => {
    button.addEventListener('click', event => event.preventDefault())
  })
</script>`

async function withPage(html: string, run: (page: Page) => Promise<void>): Promise<void> {  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await page.setContent(html)
    await run(page)
  } finally {
    await browser.close()
  }
}

check(detectGlmSite('https://chatglm.cn/') === 'chatglm', '识别 chatglm.cn', detectGlmSite('https://chatglm.cn/'))
check(detectGlmSite('https://chat.z.ai/') === 'zai', '识别 chat.z.ai', detectGlmSite('https://chat.z.ai/'))
check(detectGlmSite('https://zchat.z.ai/') === 'zai', '识别 zchat.z.ai', detectGlmSite('https://zchat.z.ai/'))
check(detectGlmSite('https://example.com/') === 'zai', '未知域名按 z.ai 处理', detectGlmSite('https://example.com/'))

await withPage(CHATGLM_FIXTURE, async (page) => {
  const before = await page.locator('.think-label').innerText()
  check(before.replace(/\s+/g, '') === 'GLM-5.3-Flash极致', 'chatglm 初始为 Flash + 极致', before)
  await ensureGlmSelection(page, 'chatglm', { model: 'glm-5.3', effort: 'low' })
  const after = (await page.locator('.think-label').innerText()).replace(/\s+/g, '')
  check(after === 'GLM-5.3快速', 'chatglm 切到 GLM-5.3 + 快速', after)
  await ensureGlmSelection(page, 'chatglm', { model: 'glm-5.3', effort: 'low' })
  const idempotent = (await page.locator('.think-label').innerText()).replace(/\s+/g, '')
  check(idempotent === 'GLM-5.3快速', 'chatglm 重复调用保持幂等', idempotent)
})

await withPage(ZAI_FIXTURE, async (page) => {
  check((await page.locator('[role="dialog"]').count()) === 1, 'zai 夹具含地区提示弹窗', '')
  // 初始是 Flash，跨模型切到 GLM-5.3：真正验证点击后模型变了，而不是"选中当前项"。
  await ensureGlmSelection(page, 'zai', { model: 'glm-5.3', effort: 'high' })
  check((await page.locator('[role="dialog"]').count()) === 0, 'zai 自动关闭地区提示', '')
  const triggerText = (await page.locator('button.modelSelectorButton').first().innerText()).trim()
  check(triggerText === 'GLM-5.3', 'zai 跨模型切换读回校验通过', triggerText)
  const now = await page.locator('[role="slider"][aria-label="思考强度"]').getAttribute('aria-valuenow')
  check(now === '1', 'zai 滑杆切到深度（1）', String(now))
  await ensureGlmSelection(page, 'zai', { model: 'glm-5.3', effort: 'low' })
  const low = await page.locator('[role="slider"][aria-label="思考强度"]').getAttribute('aria-valuenow')
  check(low === '0', 'zai 滑杆切到快速（0）', String(low))

  let blocked = false
  try {
    await ensureGlmSelection(page, 'zai', { model: 'glm-5.3-flash', effort: 'high' })
  } catch (error) {
    blocked = (error as { code?: string }).code === 'GLM_MODEL_UNAVAILABLE'
  }
  check(blocked, 'zai 禁用模型抛 GLM_MODEL_UNAVAILABLE', String(blocked))
})

await withPage(ZAI_IGNORE_FIXTURE, async (page) => {
  let mismatch = false
  try {
    await ensureGlmSelection(page, 'zai', { model: 'glm-5.3-flash', effort: 'high' })
  } catch (error) {
    mismatch = (error as { code?: string }).code === 'GLM_SELECTION_MISMATCH'
  }
  check(mismatch, 'zai 点击无效时抛 GLM_SELECTION_MISMATCH', String(mismatch))
})

if (failed === 0) console.log('OK（GLM 选择器：chatglm 菜单 / z.ai 滑杆 / 站点识别）')
process.exit(failed === 0 ? 0 : 1)

