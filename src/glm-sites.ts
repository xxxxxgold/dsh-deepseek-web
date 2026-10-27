/**
 * GLM 网页模型/思考强度选择器。
 *
 * 两个站点（chatglm.cn / chat.z.ai）的菜单结构完全不同，必须分开适配：
 * - chatglm.cn：`.think-mode-trigger` 打开自定义菜单，模型行 `.think-mode-item`，
 *   思考强度是 `.think-submenu` 二级菜单。
 * - chat.z.ai：`button.modelSelectorButton` 打开 Radix 菜单，模型项
 *   `button[aria-label="model-item"]`，思考强度是三档滑杆。
 *
 * 选择器集中在这个文件里：站点改版时只改这里，并通过明确的错误码暴露失败步骤。
 *
 * @module dsh-deepseek-web/glm-sites
 */

import type { Page } from 'playwright-core'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  GLM_WEB_MODEL_NAMES,
  GLM_WEB_REASONING_EFFORTS,
  normalizeGlmEffort,
  type GlmWebModelId,
  type GlmWebReasoningEffortId,
} from './web-models.ts'

export type GlmSite = 'chatglm' | 'zai'

export interface GlmSelection {
  model: GlmWebModelId
  effort: GlmWebReasoningEffortId
}

/** 按地址识别站点；未知域名按 z.ai 处理（反代通常保留同一套前端结构）。 */
export function detectGlmSite(url: string): GlmSite {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    host = url.toLowerCase()
  }
  return host.includes('chatglm.cn') ? 'chatglm' : 'zai'
}

/** 当前档位的中文名（触发器和子菜单都用它）。 */
export function glmEffortLabel(effort: GlmWebReasoningEffortId): string {
  return GLM_WEB_REASONING_EFFORTS.find(item => item.id === effort)?.name ?? effort
}

/** 当前档位在 z.ai 滑杆上的下标。 */
export function glmEffortSlider(effort: GlmWebReasoningEffortId): number {
  return GLM_WEB_REASONING_EFFORTS.find(item => item.id === effort)?.slider ?? 1
}

function selectionError(code: string, message: string, cause?: unknown): LlmError {
  return new LlmError(message, code, cause === undefined ? undefined : { cause })
}

/** 读 chatglm.cn 触发器的「模型 + 档位」文案；读不到返回 undefined。 */
async function readChatglmLabel(page: Page): Promise<string | undefined> {
  const label = page.locator('.think-label').first()
  if (!(await label.isVisible().catch(() => false))) return undefined
  return (await label.innerText().catch(() => '')).replace(/\s+/g, '')
}

/** 在 chatglm.cn 的模型行里按 `.item-name` 精确点选模型。 */
async function selectChatglmModel(page: Page, model: GlmWebModelId): Promise<void> {
  const name = GLM_WEB_MODEL_NAMES[model]
  const rows = page.locator('.think-mode-list > .think-mode-item')
  const count = await rows.count().catch(() => 0)
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index)
    const text = (await row.locator('.item-name').innerText().catch(() => '')).trim()
    if (text !== name) continue
    await row.click({ timeout: 5_000 }).catch((error: unknown) => {
      throw selectionError('GLM_MODEL_NOT_FOUND', `glm: 点击模型「${name}」失败`, error)
    })
    return
  }
  throw selectionError('GLM_MODEL_NOT_FOUND', `glm: 菜单里找不到模型「${name}」`)
}

/** 在 chatglm.cn 的「思考强度」二级菜单里按文案点选档位。 */
async function selectChatglmEffort(page: Page, effort: GlmWebReasoningEffortId): Promise<void> {
  const label = glmEffortLabel(effort)
  const row = page.locator('.think-mode-item.has-submenu').first()
  if (!(await row.isVisible().catch(() => false))) {
    throw selectionError('GLM_EFFORT_NOT_FOUND', 'glm: 菜单里找不到「思考强度」入口')
  }
  await row.hover().catch(() => {})
  const items = page.locator('.think-submenu .think-mode-item')
  const count = await items.count().catch(() => 0)
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index)
    const text = (await item.innerText().catch(() => '')).trim()
    if (!text.startsWith(label)) continue
    await item.click({ timeout: 5_000 }).catch((error: unknown) => {
      throw selectionError('GLM_EFFORT_NOT_FOUND', `glm: 点击思考强度「${label}」失败`, error)
    })
    return
  }
  throw selectionError('GLM_EFFORT_NOT_FOUND', `glm: 思考强度菜单里找不到「${label}」`)
}

async function ensureChatglmSelection(page: Page, selection: GlmSelection): Promise<void> {
  const want = `${GLM_WEB_MODEL_NAMES[selection.model]}${glmEffortLabel(selection.effort)}`
  const before = await readChatglmLabel(page)
  if (before === want) return

  if (before !== want) {
    const list = page.locator('.think-mode-list').first()
    if (!(await list.isVisible().catch(() => false))) {
      await page.locator('.think-mode-trigger').first().click({ timeout: 5_000 })
      await page.waitForTimeout(300)
    }
  }
  await selectChatglmModel(page, selection.model)
  await page.waitForTimeout(400)

  // 选模型会让菜单自动关闭；重新打开再选强度。
  await page.locator('.think-mode-trigger').first().click({ timeout: 5_000 })
  await page.waitForTimeout(300)
  await selectChatglmEffort(page, selection.effort)
  await page.waitForTimeout(400)

  const after = await readChatglmLabel(page)
  if (after !== want) {
    throw selectionError(
      'GLM_SELECTION_MISMATCH',
      `glm: 模型/强度没有切到期望值（期望 ${want}，实际 ${after ?? '读不到'}）`,
    )
  }
}

/** z.ai 地区提示会拦截所有点击，先关掉。 */
async function dismissZaiRegionDialog(page: Page): Promise<void> {
  const close = page.locator('[role="dialog"] button[aria-label="关闭"], [role="dialog"] button[aria-label="Close"]').first()
  if (await close.isVisible().catch(() => false)) {
    await close.click().catch(() => {})
    await page.waitForTimeout(200)
  }
}

async function selectZaiModel(page: Page, model: GlmWebModelId): Promise<void> {
  const name = GLM_WEB_MODEL_NAMES[model]
  const items = page.locator('button[aria-label="model-item"]')
  const count = await items.count().catch(() => 0)
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index)
    const text = (await item.innerText().catch(() => '')).trim()
    if (text !== name) continue
    if (await item.isDisabled().catch(() => false)) {
      throw selectionError(
        'GLM_MODEL_UNAVAILABLE',
        `glm: 模型「${name}」当前不可用（z.ai 未登录时只开放 GLM-5.3-Flash），请先完成登录`,
      )
    }
    await item.click({ timeout: 5_000 })
    await page.waitForTimeout(300)
    // 点击后必须读回校验：地区弹窗/遮罩拦截时点击可能"成功返回"但模型没变，
    // 只校验滑杆会让整轮悄悄用旧模型发送。
    const triggerText = (await page.locator('button.modelSelectorButton').first().innerText().catch(() => '')).trim()
    const selected = await item.getAttribute('data-selected').catch(() => null)
    if (triggerText !== name && selected !== 'true') {
      throw selectionError(
        'GLM_SELECTION_MISMATCH',
        `glm: 模型没有切到「${name}」（触发器显示「${triggerText || '读不到'}」）`,
      )
    }
    return
  }
  throw selectionError('GLM_MODEL_NOT_FOUND', `glm: 菜单里找不到模型「${name}」`)
}

async function selectZaiEffort(page: Page, effort: GlmWebReasoningEffortId): Promise<void> {
  const target = glmEffortSlider(effort)
  const slider = page.locator('[role="slider"][aria-label="思考强度"]').first()
  if (!(await slider.isVisible().catch(() => false))) {
    throw selectionError('GLM_EFFORT_NOT_FOUND', 'glm: 菜单里找不到「思考强度」滑杆')
  }
  const now = Number(await slider.getAttribute('aria-valuenow').catch(() => ''))
  if (Number.isFinite(now) && now === target) return

  const root = page.locator('[data-slider-root]').first()
  const box = await root.boundingBox()
  if (!box) throw selectionError('GLM_EFFORT_NOT_FOUND', 'glm: 思考强度滑杆不可见，无法点击')
  // 三档等距：左端 / 中点 / 右端；不要用键盘（实测 Home/End 不生效）。
  const ratio = target <= 0 ? 0.03 : target >= 2 ? 0.97 : 0.5
  await root.click({ position: { x: Math.round(box.width * ratio), y: Math.round(box.height / 2) } })
  await page.waitForTimeout(300)

  const after = Number(await slider.getAttribute('aria-valuenow').catch(() => ''))
  if (after !== target) {
    throw selectionError(
      'GLM_SELECTION_MISMATCH',
      `glm: 思考强度没有切到「${glmEffortLabel(effort)}」（期望档位 ${target}，实际 ${Number.isFinite(after) ? after : '读不到'}）`,
    )
  }
}

async function ensureZaiSelection(page: Page, selection: GlmSelection): Promise<void> {
  await dismissZaiRegionDialog(page)
  const trigger = page.locator('button.modelSelectorButton').first()
  if (!(await trigger.isVisible().catch(() => false))) {
    throw selectionError('GLM_MODEL_NOT_FOUND', 'glm: 找不到模型选择按钮（页面可能未加载完或已改版）')
  }
  const menu = page.locator('[role="menu"]').first()
  if (!(await menu.isVisible().catch(() => false))) {
    await trigger.click({ timeout: 5_000 })
    await page.waitForTimeout(400)
  }
  try {
    await selectZaiModel(page, selection.model)
    // Radix 菜单在选中模型后可能自动关闭；强度滑杆还在同一个菜单里，需要时重开。
    const menuAfterPick = page.locator('[role="menu"]').first()
    if (!(await menuAfterPick.isVisible().catch(() => false))) {
      await trigger.click({ timeout: 5_000 })
      await page.waitForTimeout(300)
    }
    await selectZaiEffort(page, selection.effort)
  } finally {
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(150)
  }
}

/**
 * 把页面切到指定模型与思考强度；已是目标状态时幂等返回。
 *
 * 每轮发送前都要调用：新开对话、页面重载都会把站点选择重置回默认值。
 */
export async function ensureGlmSelection(
  page: Page,
  site: GlmSite,
  selection: GlmSelection,
): Promise<void> {
  const normalized: GlmSelection = {
    model: selection.model,
    effort: normalizeGlmEffort(selection.effort),
  }
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (site === 'chatglm') await ensureChatglmSelection(page, normalized)
      else await ensureZaiSelection(page, normalized)
      return
    } catch (error) {
      lastError = error
      if (error instanceof LlmError && error.code === 'GLM_MODEL_UNAVAILABLE') throw error
      await page.waitForTimeout(300)
    }
  }
  if (lastError instanceof LlmError) throw lastError
  throw selectionError(
    'GLM_SELECTION_FAILED',
    `glm: 切换模型/思考强度失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    lastError,
  )
}
