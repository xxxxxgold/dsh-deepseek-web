/**
 * 浏览器通道公共助手：DeepSeek / Kimi / GLM 三条通道共享的页面操作。
 *
 * @module dsh-deepseek-web/browser-shared
 */

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LlmError } from '@deepseek-ai/dsh-llm'

export const KEEPER_FILE = fileURLToPath(new URL('../tools/browser-keeper.mjs', import.meta.url))

/** 输入区候选选择器（textarea / contenteditable / role=textbox）。 */
export const EDITOR_CANDIDATES = [
  'textarea',
  'div[contenteditable="true"]',
  'div[contenteditable="plaintext-only"]',
  'div[role="textbox"]',
  '[data-lexical-editor="true"]',
]

export function locateEditor(page: Page): Locator {
  return page.locator(EDITOR_CANDIDATES.join(', ')).filter({ visible: true }).last()
}

/** 网页端“发送过于频繁/稍后重试”一类频控提示的匹配模式。 */
export const RATE_LIMIT_PATTERN = /过于频繁|太频繁|发送太快|发送太快了|请.{0,4}稍后.{0,4}(重试|再试)|稍后再试|操作频繁|请求过于|too\s+(many|frequent)|rate[._\s-]?limit(?:ed)?|try\s+again\s+(later|soon)/i

/**
 * 网页端「服务器暂时不可用 / 服务繁忙」一类**服务端临时故障**的匹配模式。
 *
 * 必须与频控严格区分，两者处置方式相反：
 * - 频控 = 这个账号发得太快，要等 10~15 分钟冷却，继续发会把临时限流拖成封号；
 * - 服务端故障 = DeepSeek 后端自己过载/重启，跟账号无关，等几十秒到几分钟就恢复。
 *
 * 网页上两者都以 toast 出现，而且服务端故障的文案常常带「请稍后重试」——
 * 早期只按频控判，于是后端抖一下就把账号锁进 10 分钟冷却；而如果完全不认它，
 * 又会落进 WEB_UNPARSEABLE_RESPONSE（用户看到的正是「本轮运行失败」）。
 */
export const SERVER_BUSY_PATTERN = /服务器.{0,10}(不可用|繁忙|开小差|打盹|过载|超时)|服务(暂时|临时)(不可用|繁忙|过载)|服务繁忙|系统繁忙|请求过于繁忙|当前.{0,8}繁忙|暂时无法(提供)?服务|service\s+(is\s+)?(temporarily\s+)?unavailable|server\s+(is\s+)?(busy|overloaded|unavailable)|temporarily\s+unavailable/i

/** 判断一段文本（toast 文案 / 错误体）是否是服务端临时故障提示。 */
export function looksLikeServerBusyText(text: string): boolean {
  return SERVER_BUSY_PATTERN.test(text)
}

/** 判断一段文本（toast 文案）是否是频控提示。 */
export function looksLikeRateLimitText(text: string): boolean {
  return RATE_LIMIT_PATTERN.test(text)
}

/**
 * 频控响应体判定：**只认明确的错误体**。
 *
 * 正常回复是 SSE 流（`data: {...}`），正文里出现“稍后重试”是模型在正常说话。
 * 早期版本直接对前 2000 字跑正则，于是每一条带“稍后再试”的正常回答都会被判成
 * 频控：重发同一条消息、再被判、再重发，最后抛 WEB_RATE_LIMITED。
 */
export function isRateLimitResponse(status: number, body: string): boolean {
  if (status === 429) return true
  // 服务端故障文案常带「请稍后重试」，先摘出去，别把后端抖动当成账号频控。
  if (isServerBusyResponse(status, body)) return false
  const head = body.slice(0, 4_000)
  const isEventStream = /^\s*(data:|event:)/.test(head) || head.includes('\ndata:')
  if (isEventStream) {
    // 流里的独立 error 帧才算数，正文段落一概不扫
    const errorFrame = /"error"\s*:\s*\{[^}]*\}/.exec(head)
    if (errorFrame === null) return false
    return looksLikeRateLimitText(errorFrame[0]) || errorFrame[0].includes('429')
  }
  const trimmed = body.trim()
  if (trimmed.length === 0 || trimmed.length > 500) return false
  return looksLikeRateLimitText(trimmed)
}

/**
 * 服务端临时故障判定：HTTP 502/503/504，或响应体是明确的「服务器暂时不可用」错误帧。
 *
 * 只认**明确的错误体**，与频控一样不扫正文：模型正常回答里出现「服务器暂时不可用」
 * 这句话（比如在讲运维）不该把整轮判成故障。
 */
export function isServerBusyResponse(status: number, body: string): boolean {
  // 网关侧明确的服务不可用：与文案无关
  if (status === 502 || status === 503 || status === 504) return true
  const head = body.slice(0, 4_000)
  const isEventStream = /^\s*(data:|event:)/.test(head) || head.includes('\ndata:')
  if (isEventStream) {
    const errorFrame = /"error"\s*:\s*\{[^}]*\}/.exec(head)
    if (errorFrame !== null) return looksLikeServerBusyText(errorFrame[0])
    // 网页端另一种错误帧形态：{"type":"error","content":"服务器暂时不可用…"}
    const typeFrame = /"type"\s*:\s*"error"[^\n]{0,300}/.exec(head)
    return typeFrame !== null && looksLikeServerBusyText(typeFrame[0])
  }
  const trimmed = body.trim()
  if (trimmed.length === 0 || trimmed.length > 500) return false
  // 网关错误页（nginx 502 之类）剥标签后只剩一句人话
  const plain = trimmed.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()
  return looksLikeServerBusyText(plain)
}

/** 插件自己画在网页右下角的那块浮层的 id（它本身带着频控字眼，必须排除）。 */
export const PAGE_NOTICE_ID = 'dsh-web-notice'

/**
 * 频控 toast 的“已认领”标记属性。
 *
 * 检测器每 800ms 扫一次全页，而 toast 往往**视觉上消失、节点仍留在 DOM 里**
 * （父容器 display:none、淡出后 opacity:0、被移出视口……）。没有这层标记，
 * 一条旧提示会让之后每一轮发送都在第一拍被判成频控：重发 5 次、共等 12 分钟、
 * 最后报 WEB_RATE_LIMITED——用户看到的是“网页上什么都没有，却一直失败”。
 */
export const RATE_LIMIT_SEEN_ATTR = 'data-dsh-rate-limit-seen'

/**
 * 「服务器暂时不可用」提示的认领标记属性（与频控分开记）。
 *
 * 为什么不能复用频控那个属性：两类的判据和处置都不同，共用标记会让一个
 * 已认领的频控节点顺带把同文案的服务端故障也认领掉，反之亦然。
 */
export const SERVER_BUSY_SEEN_ATTR = 'data-dsh-server-busy-seen'

/** 一个候选节点的事实集合（纯数据，便于离线检查覆盖判定规则）。 */
export interface RateLimitNodeFacts {
  /** 节点的可见文本（已 trim） */
  text: string
  /** 视觉上是否能被用户看到（含祖先链、尺寸、视口） */
  visible: boolean
  /** 直接子元素个数 */
  childElementCount: number
  /** 是否落在输入区内部 */
  insideEditor: boolean
  /** 是否是本插件自己画的浮层 */
  selfPaint: boolean
  /** 是否已被之前某一轮认领（旧节点） */
  seen: boolean
}

/**
 * 判定单个候选节点该不该算作“本轮正在显示的频控提示”。
 *
 * 纯函数：`hasRateLimitToast` 的页面内联逻辑必须与这里逐条对应，
 * 离线检查 `tools/rate-limit-check.ts` 依赖它覆盖“什么该算、什么不该算”。
 */
export function shouldCountRateLimitNode(facts: RateLimitNodeFacts): boolean {
  if (!facts.visible) return false
  if (facts.insideEditor) return false
  if (facts.selfPaint) return false
  if (facts.seen) return false
  if (facts.childElementCount > 2) return false
  const text = facts.text.trim()
  if (text.length === 0 || text.length > 120) return false
  // 服务端故障文案也常带「请稍后重试」，命中它就不算频控（处置方式相反）。
  if (looksLikeServerBusyText(text)) return false
  return looksLikeRateLimitText(text)
}

/**
 * 页面内扫描：是否正显示某一类提示（频控 / 服务端不可用）。
 *
 * 抽成一个模块级函数，让两类提示共用同一套可见性判据——早期两处各写一份，
 * 改了一边忘了另一边，线上就出现「页面上明明有提示，却一律判不出来」。
 *
 * 判据（都是真实踩过的坑）：
 * 1. 可见性沿祖先链判断（`checkVisibility`），父容器 `display:none` / `opacity:0`
 *    的残留节点不再算“正在显示”；
 * 2. 完全移出视口、零尺寸的节点算已消失；
 * 3. 排除插件自己画的浮层（它的文案本身就能命中原正则，会形成自锁）；
 * 4. 已被之前某一轮认领过的旧节点不再重复计数——只有**这一轮之后新出现的**才算数。
 *
 * 注意：函数体会被 `toString()` 后注入页面执行，**不要**在里面写具名函数表达式——
 * esbuild 的 keepNames 会把它包成 `__name(...)`，而页面里没有这个 helper，
 * 整个回调会抛错并被 `.catch` 吞成 false。
 */
export function scanNoticeToasts(params: { patternSource: string, seenAttr: string, noticeId: string }): boolean {
    const pattern = new RegExp(params.patternSource, 'i')
    const editors = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]'))
    const selfPaint = document.getElementById(params.noticeId)
    const elements = Array.from(document.querySelectorAll('div, span, p, section, aside')) as HTMLElement[]

    for (const element of elements) {
      if (!element.isConnected) continue
      if (editors.some(editor => editor.contains(element))) continue
      if (selfPaint !== null && (element === selfPaint || selfPaint.contains(element))) continue
      const text = (element.textContent ?? '').trim()
      if (text.length === 0 || text.length > 120) continue
      if (element.childElementCount > 2) continue
      // 旧节点：同一段文字已经被之前某一轮认领过，不再重复计数；
      // 文案变了说明是新的提示，照常识别（真实 toast 库会复用同一个节点改字）。
      if (element.getAttribute(params.seenAttr) === text) continue
      if (!pattern.test(text)) continue

      // 可见性沿祖先链判断：父容器 display:none / 淡出 opacity:0 / 被甩出视口的
      // 残留节点，用户看不见，就不该算“正在显示频控提示”。
      const maybeCheck = (element as HTMLElement & {
        checkVisibility?: (options?: { checkOpacity?: boolean, checkVisibilityCSS?: boolean }) => boolean
      }).checkVisibility
      let shown = true
      if (typeof maybeCheck === 'function') {
        shown = maybeCheck.call(element, { checkOpacity: true, checkVisibilityCSS: true })
      } else {
        for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
          const style = window.getComputedStyle(node)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0
            || node.hasAttribute('hidden')) {
            shown = false
            break
          }
        }
      }
      if (!shown) continue

      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) continue
      // 被祖先 overflow:hidden/clip 裁掉也算看不见（典型：0×0 容器里没清干净的残留 toast）。
      // 这段只对「文案已命中正则」的少数元素执行，不会拖慢每 800ms 的整页扫描。
      let clipTop = 0
      let clipLeft = 0
      let clipRight = window.innerWidth
      let clipBottom = window.innerHeight
      let hasClip = false
      for (let node: HTMLElement | null = element.parentElement; node !== null; node = node.parentElement) {
        const style = window.getComputedStyle(node)
        if (!/hidden|clip/.test(`${style.overflowX} ${style.overflowY}`)) continue
        const box = node.getBoundingClientRect()
        clipTop = Math.max(clipTop, box.top)
        clipLeft = Math.max(clipLeft, box.left)
        clipRight = Math.min(clipRight, box.right)
        clipBottom = Math.min(clipBottom, box.bottom)
        hasClip = true
      }
      if (hasClip && (rect.bottom <= clipTop || rect.top >= clipBottom
        || rect.right <= clipLeft || rect.left >= clipRight)) continue
      return true
    }
  return false
}

/** 页面里是否正显示频控 toast。 */
export async function hasRateLimitToast(page: Page): Promise<boolean> {
  return await page.evaluate(scanNoticeToasts, {
    patternSource: RATE_LIMIT_PATTERN.source,
    seenAttr: RATE_LIMIT_SEEN_ATTR,
    noticeId: PAGE_NOTICE_ID,
  }).catch(() => false)
}

/** 页面里是否正显示「服务器暂时不可用」类提示（与频控分开判定，处置方式相反）。 */
export async function hasServerBusyToast(page: Page): Promise<boolean> {
  return await page.evaluate(scanNoticeToasts, {
    patternSource: SERVER_BUSY_PATTERN.source,
    seenAttr: SERVER_BUSY_SEEN_ATTR,
    noticeId: PAGE_NOTICE_ID,
  }).catch(() => false)
}

/**
 * 页面内认领：给“此刻已经存在的某一类提示节点”打上标记。
 *
 * 语义：从这一轮发送开始，只有**新冒出来**的提示才算新提示。上一轮留下的、
 * 或网页历史上早就挂着的，都不会再把本轮拦下来。返回打标记的节点数，仅用于日志。
 */
export function claimNoticeToasts(params: { patternSource: string, seenAttr: string, noticeId: string }): number {
    const pattern = new RegExp(params.patternSource, 'i')
    const selfPaint = document.getElementById(params.noticeId)
    const elements = Array.from(document.querySelectorAll('div, span, p, section, aside')) as HTMLElement[]
    let marked = 0
    for (const element of elements) {
      if (!element.isConnected) continue
      if (selfPaint !== null && (element === selfPaint || selfPaint.contains(element))) continue
      const text = (element.textContent ?? '').trim()
      if (text.length === 0 || text.length > 120) continue
      if (element.childElementCount > 2) continue
      if (!pattern.test(text)) continue
      // 不筛可见性：隐藏的旧节点更该认领——它可能下一秒被重新显示。
      element.setAttribute(params.seenAttr, text)
      marked += 1
      if (marked >= 50) break
    }
    return marked
}

/**
 * 发送前给“此刻页面上已经存在的频控文案节点”打上认领标记。
 *
 * 少了这一步，上一轮残留的 toast（视觉上消失、节点仍在 DOM 里）会让每一轮
 * 都在第一拍被判死——网页上明明没有提示，却一直失败。
 */
export async function markRateLimitToastsSeen(page: Page): Promise<number> {
  return await page.evaluate(claimNoticeToasts, {
    patternSource: RATE_LIMIT_PATTERN.source,
    seenAttr: RATE_LIMIT_SEEN_ATTR,
    noticeId: PAGE_NOTICE_ID,
  }).catch(() => 0)
}

/** 发送前认领“服务器暂时不可用”类旧节点，避免上一轮的提示把本轮判死。 */
export async function markServerBusyToastsSeen(page: Page): Promise<number> {
  return await page.evaluate(claimNoticeToasts, {
    patternSource: SERVER_BUSY_PATTERN.source,
    seenAttr: SERVER_BUSY_SEEN_ATTR,
    noticeId: PAGE_NOTICE_ID,
  }).catch(() => 0)
}

/** 同一 frame 上另一次导航接管时的报错文案；浏览器启动页/崩溃恢复期很常见。 */
const NAVIGATION_INTERRUPTED = /interrupted by another navigation|net::ERR_ABORTED/i

export async function ensureChatPage(
  page: Page,
  url: string,
  options: { activate?: boolean } = {},
): Promise<void> {
  const current = page.url()
  if (current.startsWith(new URL(url).origin)) {
    // 关掉聚焦开关后不能再激活窗口：最小化启动的窗口会被这一句直接拉回前台。
    if (options.activate !== false) await page.bringToFront()
    return
  }
  // 浏览器启动器或崩溃恢复会在这个标签上继续自己的导航（典型是 Edge 的
  // ntp.msn.cn 启动页重定向），把我们的 goto 顶掉。启动期竞争通常在几秒内结束，
  // 所以短退避重试；仍失败才抛带错误码的 LlmError——Playwright 的原始文案没有
  // code，宿主按 retryability() 只会得到 'unknown'，不会重试，用户就直接看到
  // 「本轮运行失败」。给出 BROWSER_NAVIGATION_INTERRUPTED 才能让宿主再兜一轮。
  const delays = [500, 1_500]
  let detail = ''
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      return
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      if (!NAVIGATION_INTERRUPTED.test(message)) throw error
      detail = message
      const delay = delays[attempt]
      if (delay === undefined) break
      await page.waitForTimeout(delay)
    }
  }
  throw new LlmError(
    `打开 ${url} 时页面被另一条导航接管（浏览器启动页或崩溃恢复），已重试 ${delays.length} 次仍未稳定：${detail}`,
    'BROWSER_NAVIGATION_INTERRUPTED',
  )
}

export async function looksLoggedOut(page: Page, markers: readonly string[] = ['sign_in', 'sign-in', 'login', 'auth']): Promise<boolean> {
  const current = new URL(page.url())
  const editorVisible = await locateEditor(page).isVisible().catch(() => false)
  if (editorVisible) return false
  return markers.some(marker => current.pathname.includes(marker) || current.search.includes(marker))
}

/**
 * 发送控件是否处于不可用状态。
 *
 * 登录墙的典型形态之一：输入框可见、也能填入文字，但发送按钮是 disabled
 * （chat.z.ai 未登录时正是如此），表现是“填进去了、回车/点发送都没反应”。
 * 找不到发送控件时返回 false（例如只认回车的站点），不误判正常页面。
 */
export async function looksSendBlocked(page: Page): Promise<boolean> {
  // 与发送兜底共用同一套候选：DeepSeek 的按钮没有语义属性，只认 <button> /
  // aria-label 会让登录墙判定在这类站点上永远返回 false。
  const control = locateSendButton(page)
  if ((await control.count().catch(() => 0)) === 0) return false
  if (!(await control.isVisible().catch(() => false))) return false
  return !(await isSendButtonEnabled(control))
}

/**
 * 给一个 promise 加超时，超时抛出带稳定错误码的 LlmError。
 *
 * `response.body()` / `response.finished()` 都没有 timeout 参数：网页流一旦卡住，
 * 这两个 promise 会一直挂着，整轮就“卡死、不会重新获取”。包一层超时后，
 * 卡住会变成一次明确的失败，上层才有机会重连重试。
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  code: string,
  message: string,
): Promise<T> {
  if (!(ms > 0)) return promise
  return new Promise<T>((resolve, reject) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => reject(new LlmError(message, code)), ms)
    // 不 unref：这里必须保证超时一定能触发。unref 会让事件循环在“只剩这个定时器”
    // 时直接退出（独立脚本里表现为函数永不返回、await 悬空）。promise 落定时一定会
    // clearTimeout，正常路径不会留下悬挂定时器。
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * 「浏览器/标签页已经被关掉」的报错特征。
 *
 * Playwright 在连接断掉时抛的是纯文本（`Target page, context or browser has been closed`
 * / `Browser has been closed`），不给我们错误码；而插件自己的 `WEB_PAGE_CLOSED` 是另一条路。
 * 自愈只该被这两类触发，频控、超时、用户取消都不能被当成"重启浏览器"。
 */
const BROWSER_CLOSED_PATTERN =
  /Target (?:page|context|browser)[^\n]{0,40}closed|Browser has been closed|browser has been closed|has been disconnected|Connection closed|connection closed|连接已关闭|连接已断开/u

/** 这条报错是不是「浏览器被关了」造成的。 */
export function isBrowserClosedMessage(text: string): boolean {
  return BROWSER_CLOSED_PATTERN.test(text)
}

/**
 * 把「审核窗口入口地址」补成「一定会新开对话」的地址。
 *
 * 用户在设置里填的就是新标签页要打开的链接，所以这里只做一件事：确保带上站点
 * 自己的建新参数（Kimi 是 `chat_enter_method=new_chat`）。已经带了就原样返回，
 * 让用户能完全接管地址（比如换成企业版域名、加自己的查询参数）。
 *
 * 注意这是**尽力而为**：Kimi 的项目页（`/project/<id>`）即使带上这个参数，
 * 发消息时也会跳到 `/chat/<uuid>` 普通对话（实测），参数只保证「打开时是空的对 话」，
 * 不保证「对话归属到那个项目」。
 */
export function ensureFreshChatUrl(raw: string, param = 'chat_enter_method=new_chat'): string {
  // 配置里的 volatile 字段在未解引用时读到的是引用对象，直接 `.trim()` 会把
  // “配置没读对”变成一句莫名其妙的 TypeError；这里按空串处理，交给调用方报人话错误。
  const trimmed = (typeof raw === 'string' ? raw : '').trim()
  if (!trimmed) return trimmed
  const [key, value = ''] = param.split('=')
  try {
    const url = new URL(trimmed)
    if (url.searchParams.has(key)) return url.toString()
    url.searchParams.set(key, value)
    return url.toString()
  } catch {
    // 不是合法 URL（用户可能还在输入中）：原样交给浏览器，由 goto 自己报错。
    return trimmed
  }
}

/**
 * 发送按钮候选选择器（点击发送的兜底路径，与 looksSendBlocked 共用语义）。
 *
 * 最后两条是 DeepSeek 2026-10 改版后的真实结构：
 * `<div role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle">`，
 * 没有 aria-label / title / data-testid，也不是 `<button>`。旧候选对它 0 命中，
 * 于是「按钮兜底」长期形同虚设——这是 WEB_SEND_NOT_TRIGGERED 的直接原因。
 */
export const SEND_BUTTON_CANDIDATES = [
  'button[class*="sendMessage" i]',
  'button[aria-label*="发送"]',
  'button[aria-label*="send" i]',
  'button[title*="发送"]',
  'button[title*="send" i]',
  '[role="button"][aria-label*="发送"]',
  '[role="button"][aria-label*="send" i]',
  '[data-testid*="send" i]',
  'div[role="button"][class*="ds-button--primary"][class*="ds-button--circle"]',
  'div[role="button"][class*="ds-button--primary"]',
]

/** 定位发送按钮（不可用/不存在时返回未命中的 locator）。 */
export function locateSendButton(page: Page): Locator {
  return page.locator(SEND_BUTTON_CANDIDATES.join(', ')).first()
}

/**
 * 发送按钮当前是否可点击。
 *
 * 不能只看 `disabled` / `aria-disabled`：DeepSeek 用 `opacity: 0.4` 表达禁用，
 * 两个属性都不存在。若只判属性，会把禁用态当成可点，点下去毫无反应，
 * 最终仍然报「发送失败」却查不到原因。
 */
export async function isSendButtonEnabled(button: Locator): Promise<boolean> {
  return await button.evaluate((element) => {
    const node = element as HTMLElement
    if (node.hasAttribute('disabled')) return false
    if (node.getAttribute('aria-disabled') === 'true') return false
    if (/(^|[\s_-])disabled([\s_-]|$)/i.test(String(node.className ?? ''))) return false
    const style = getComputedStyle(node)
    if (style.pointerEvents === 'none') return false
    const opacity = Number(style.opacity)
    if (Number.isFinite(opacity) && opacity < 0.5) return false
    return true
  }).catch(() => false)
}

/**
 * 页面是否仍在生成回复。
 *
 * DeepSeek 把「发送」和「停止生成」合并在同一个按钮上：生成中按钮换成方块图标
 * （SVG path 以 `M2 4.88` 开头），空闲/可发送时是向上箭头（`M8.3125` 开头），
 * 且两种状态 opacity 都是 1，无法只靠透明度区分。误点这个按钮会中断上一轮，
 * 所以发送前必须先认出来。
 */
export async function looksGenerating(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const button = document.querySelector(
      'div[role="button"][class*="ds-button--primary"][class*="ds-button--circle"]',
    )
    if (!button) return false
    const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`
    if (/停止|stop/i.test(label)) return true
    const d = button.querySelector('svg path')?.getAttribute('d') ?? ''
    // 方块（停止）图标的 path 起点；箭头（发送）是 M8.3125 0.980206…
    return d.startsWith('M2 4.88')
  }).catch(() => false)
}

/**
 * 读取输入框当前文本。
 *
 * textarea/input 走 `inputValue()`；contenteditable 走 `innerText`。
 * 两者都要能读到，否则“发送后是否清空”的判断在 Kimi（contenteditable）
 * 与部分站点（textarea）上会有一半失效。
 */
export async function readEditorText(editor: Locator): Promise<string> {
  const tagName = await editor.evaluate(element => element.tagName.toLowerCase()).catch(() => '')
  if (tagName === 'textarea' || tagName === 'input') {
    return (await editor.inputValue().catch(() => '')).trim()
  }
  return (await editor.innerText().catch(() => '')).trim()
}

/** 一次发送尝试的结果，用于日志与最终错误信息。 */
export interface SendOutcome {
  /** 是否确认发送成功（输入框已被清空，或外部信号表明请求已发出）。 */
  sent: boolean
  /** 最终生效的方式；`none` 表示所有尝试都没能确认发出。 */
  via: 'enter' | 'button' | 'none'
  /** 每次尝试的简述（按发生顺序），便于定位站点差异。 */
  attempts: string[]
}

export interface SendEditorMessageOptions {
  /** 单次尝试后等待“已发送”信号的窗口（毫秒）。 */
  verifyTimeoutMs?: number
  /** 最多尝试几轮（每轮 = 回车 + 按钮兜底）。 */
  maxAttempts?: number
  /** 回车前的随机停顿区间（毫秒）；两者都为 0 即关闭。 */
  pauseMinMs?: number
  pauseMaxMs?: number
  /** 外部信号：网页请求是否已经发出（已发出即视为发送成功，不再纠结输入框状态）。 */
  hasResponse?: () => boolean
  /** 该回合是否已被取消；取消后不再继续尝试发送。 */
  isCancelled?: () => boolean
  /** 页面仍在生成时的最长等待（毫秒）；0 = 不等待。默认 15000。 */
  generatingWaitMs?: number
  /**
   * 自定义发送控件；缺省用 DeepSeek 的通用候选。
   * 豆包这类站点把发送做成无 aria 的圆角 div，必须由通道自己传定位器。
   */
  sendButton?: Locator
}

/**
 * 把输入框里已填好的内容真正发出去，并**确认**它发出去了。
 *
 * 这是“文字填进去了、但没发送、必须人工点一下”这个问题的根治点：
 * 只按一次回车是不够的——不同站点/不同版本对回车键的处理不同（有的发送、
 * 有的换行、有的被输入法或焦点吃掉），所以流程是
 * `回车 → 观察输入框是否清空 → 没清空就点发送按钮 → 再观察 → 仍不行才报失败`。
 *
 * 判定“已发送”的信号（任一命中即可）：
 * 1. 输入框被清空（绝大多数站点发送后清空输入区）；
 * 2. 外部 `hasResponse()` 返回 true（网络层已经看到本轮请求）；
 * 3. 发送按钮从“可用”变成“不可用/消失”（生成中按钮态）。
 *
 * 整个过程受 `isCancelled()` 约束：宿主取消回合时立刻停止尝试，不拖时间。
 */
export async function sendEditorMessage(
  page: Page,
  editor: Locator,
  options: SendEditorMessageOptions = {},
): Promise<SendOutcome> {
  // 配置值可能来自 volatile 字段，未提交时读到的是 `NaN`；`Math.max(1, NaN)` 仍是 `NaN`，
  // 会让 `attempt <= maxAttempts` 恒为 false，整个发送循环被静默跳过（表现为“填进去却没发”）。
  const finiteInt = (input: unknown, fallback: number, min: number, max: number): number => {
    const value = Number(input)
    if (!Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, Math.trunc(value)))
  }
  const verifyTimeoutMs = finiteInt(options.verifyTimeoutMs, 1_500, 200, 60_000)
  const maxAttempts = finiteInt(options.maxAttempts, 2, 1, 5)
  const pauseMinMs = finiteInt(options.pauseMinMs, 0, 0, 5_000)
  const pauseMaxMs = finiteInt(options.pauseMaxMs, pauseMinMs, pauseMinMs, 5_000)
  const isCancelled = options.isCancelled ?? (() => false)
  const hasResponse = options.hasResponse ?? (() => false)
  const generatingWaitMs = finiteInt(options.generatingWaitMs, 15_000, 0, 120_000)
  const attempts: string[] = []

  const before = await readEditorText(editor)
  if (before.length === 0) {
    return { sent: false, via: 'none', attempts: ['输入框为空，没有可发送的内容'] }
  }

  /** 等待“已发送”信号；命中返回 true。 */
  const waitSent = async (): Promise<boolean> => {
    const deadline = Date.now() + verifyTimeoutMs
    while (Date.now() < deadline) {
      if (isCancelled()) return false
      if (hasResponse()) return true
      const current = await readEditorText(editor).catch(() => before)
      // 发送后站点会清空输入区；只要内容变空（或大幅缩短）就认为消息已提交。
      if (current.length === 0 || current.length < before.length / 2) return true
      await page.waitForTimeout(80)
    }
    return false
  }

  const randomPause = async (): Promise<void> => {
    if (pauseMaxMs <= 0) return
    const span = pauseMaxMs - pauseMinMs
    const delay = pauseMinMs + (span > 0 ? Math.floor(Math.random() * span) : 0)
    await page.waitForTimeout(delay)
  }

  /**
   * 页面还在生成时，回车会被前端忽略，发送按钮也变成了「停止生成」——
   * 这两种情况下硬发都只会失败，点按钮还会把上一轮中断。先等它结束，
   * 最多 `generatingWaitMs`；仍不结束就记一条，交给后续尝试并如实上报。
   */
  const waitGenerationDone = async (attempt: number): Promise<void> => {
    if (generatingWaitMs <= 0) return
    if (!(await looksGenerating(page))) return
    const startedAt = Date.now()
    const deadline = startedAt + generatingWaitMs
    while (Date.now() < deadline) {
      if (isCancelled()) return
      await page.waitForTimeout(250)
      if (!(await looksGenerating(page))) {
        attempts.push(`第 ${attempt} 轮：等待 ${Math.round((Date.now() - startedAt) / 1000)}s 后上一轮生成结束`)
        return
      }
    }
    attempts.push(`第 ${attempt} 轮：页面仍在生成（已等待 ${Math.round(generatingWaitMs / 1000)}s）`)
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (isCancelled()) break

    await waitGenerationDone(attempt)

    // 路径一：回车。先聚焦，确保按键落到输入框而不是页面其它元素。
    await editor.focus().catch(() => {})
    await randomPause()
    if (isCancelled()) break
    const pressed = await page.keyboard.press('Enter').then(() => true).catch(() => false)
    attempts.push(`第 ${attempt} 轮回车：${pressed ? '已按下' : '按键失败'}`)
    if (pressed && await waitSent()) return { sent: true, via: 'enter', attempts }

    // 路径二：点发送按钮。回车被当成“换行”或焦点丢失时，这一步是主要兜底。
    if (isCancelled()) break
    const button = options.sendButton ?? locateSendButton(page)
    const visible = await button.isVisible().catch(() => false)
    if (visible) {
      const enabled = await isSendButtonEnabled(button)
      if (enabled) {
        const clicked = await button.click({ timeout: 3_000 }).then(() => true).catch(() => false)
        attempts.push(`第 ${attempt} 轮点发送按钮：${clicked ? '已点击' : '点击失败'}`)
        if (clicked && await waitSent()) return { sent: true, via: 'button', attempts }
      } else {
        attempts.push(`第 ${attempt} 轮点发送按钮：按钮不可用`)
      }
    } else {
      attempts.push(`第 ${attempt} 轮点发送按钮：未找到发送控件`)
    }
  }

  // 失败现场：把「输入框还剩多少字、发送控件是否命中、页面是否仍在生成」
  // 一次性写进错误信息，避免下次只能靠猜。
  const remaining = (await readEditorText(editor).catch(() => before)).length
  const hits = await (options.sendButton ?? locateSendButton(page)).count().catch(() => 0)
  const generating = await looksGenerating(page)
  attempts.push(`诊断：输入框剩 ${remaining} 字；发送控件命中 ${hits} 个；生成中 ${generating ? '是' : '否'}`)
  return { sent: false, via: 'none', attempts }
}

/**
 * 登录墙判定：URL 命中登录标记，或“输入框可见 + 页面有登录入口 + 发送控件被禁用”。
 *
 * 只按 URL 判断会漏掉 chat.z.ai 这类站点：未登录时停在首页、输入框照样可见，
 * 直到用户点发送才发现发不出去。把“发不出去”的信号也纳入判定后，通道可以
 * 立刻抛出“请先登录”的明确错误，而不是让用户等满一轮超时。
 */
export async function looksLoginWall(
  page: Page,
  markers: readonly string[] = ['sign_in', 'sign-in', 'login', 'auth', 'passport'],
): Promise<boolean> {
  const current = new URL(page.url())
  if (markers.some(marker => current.pathname.includes(marker) || current.search.includes(marker))) return true
  const editorVisible = await locateEditor(page).isVisible().catch(() => false)
  if (!editorVisible) return false
  const signInVisible = await page
    .getByText(/^\s*(登录|登入|立即登录|Sign in|Sign in \/ Sign up|Log in|Login)\s*$/i)
    .first()
    .isVisible()
    .catch(() => false)
  if (!signInVisible) return false
  return await looksSendBlocked(page)
}

/** 新建对话入口的自定义候选：不同站点文案/结构差异很大，允许调用方补充。 */
export interface NewChatOptions {
  /** 额外的文本候选（会排在默认候选之前，优先命中）。 */
  labels?: readonly string[]
  /** 额外的选择器候选（最可靠，优先尝试）。 */
  selectors?: readonly string[]
}

/**
 * 尝试点击“开启新对话/New chat”入口。返回是否成功触发点击。
 *
 * 全自动模式下 DeepSeek 标签页常处于后台，`locator.click()` 依赖元素可命中
 * （visible/stable/receives events），后台标签页里侧栏可能未布局，点击会静默失败，
 * 从而沿用上一次网页对话。因此除定位器点击外，追加页面内原生 DOM 点击兜底：
 * 它不要求标签页在前台，也不要求元素可命中。
 *
 * 注意：返回 true 只代表“点到了某个入口”，不代表新对话真的建起来了。
 * 站点是 SPA 时点击可能不产生任何跳转，调用方必须自己验证（见 Kimi 通道的
 * `openFreshConversation`，它在点击无效时回退到直接跳首页）。
 */
export async function bestEffortNewChat(page: Page, options: NewChatOptions = {}): Promise<boolean> {
  // 选择器最可靠（Kimi 的新建入口是只有图标、靠 aria-label 表达语义的链接）。
  for (const selector of options.selectors ?? []) {
    try {
      const element = page.locator(selector).first()
      if (await element.isVisible().catch(() => false)) {
        const clicked = await element.click({ timeout: 3_000 }).then(() => true).catch(() => false)
        if (clicked) return true
      }
    } catch {
      // 选择器语法不兼容当前 Playwright 时跳过，不影响后面的文本候选。
    }
  }
  const labels = [
    ...(options.labels ?? []),
    '开启新对话',
    '新建对话',
    '新建会话',
    '新对话',
    '新话题',
    'New chat',
    'New Chat',
    'New topic',
  ]
  for (const label of labels) {
    const candidate = page.getByText(label, { exact: true }).first()
    if (await candidate.isVisible().catch(() => false)) {
      const clicked = await candidate.click({ timeout: 3_000 }).then(() => true).catch(() => false)
      if (clicked) return true
    }
  }
  const roleButton = page.getByRole('button', { name: /新建对话|新对话|新话题|New chat|New topic/i }).first()
  if (await roleButton.isVisible().catch(() => false)) {
    const clicked = await roleButton.click({ timeout: 3_000 }).then(() => true).catch(() => false)
    if (clicked) return true
  }
  return await page.evaluate((texts: string[]) => {
    const norm = (value: string | null | undefined): string => (value ?? '').replace(/\s+/gu, ' ').trim()
    const elements = Array.from(document.querySelectorAll('button, a, [role="button"], div, span')) as HTMLElement[]
    for (const label of texts) {
      const exact = elements.find(el => norm(el.textContent) === label)
      if (exact) { exact.click(); return true }
    }
    for (const label of texts) {
      const partial = elements.find(el => {
        const aria = norm(el.getAttribute('aria-label'))
        const title = norm(el.getAttribute('title'))
        const text = norm(el.textContent)
        return aria.includes(label) || title.includes(label)
          || (text.includes(label) && text.length <= label.length + 4)
      })
      if (partial) { partial.click(); return true }
    }
    return false
  }, labels).catch(() => false)
}

export interface TitleMarkerState {
  original?: string
}

/** 用标题前缀提示当前状态（等待人工点击/生成中/需要选择）。 */
export async function markPageTitle(
  page: Page,
  marker: string | undefined,
  state: TitleMarkerState,
): Promise<void> {
  if (state.original === undefined) {
    state.original = await page.title()
  }
  const clean = state.original.replace(/^\[[^\]]*\]\s*/u, '')
  await page.evaluate(({ title, prefix }) => {
    document.title = prefix ? `${prefix} ${title}` : title
  }, { title: clean, prefix: marker }).catch(() => {})
}

/** 启动/复用脱离本进程的浏览器常驻守护。 */
export function spawnKeeper(options: { profileDir: string; port: number; url: string }): void {
  spawn(process.execPath, [
    KEEPER_FILE,
    '--profile', options.profileDir,
    '--port', String(options.port),
    '--url', options.url,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref()
}

/**
 * managed 浏览器端点记录。
 *
 * 背景：宿主的生命周期比浏览器短——`dsh headless` 退出、桌面版重启、或宿主崩溃后，
 * 插件托管的 Edge/Chrome 仍会留在桌面上。下一次启动若照旧 `findAvailablePort` +
 * `spawn`，Chromium 的单实例机制会把新进程交给已有实例，新端口永远等不到 CDP，
 * 60 秒后才报 BROWSER_MANAGED_START_FAILED 并把浏览器全杀一遍。
 *
 * 这里把「上一次实际使用的 CDP 端口」按 profile 落盘，启动前先尝试连它：
 * 连上就复用（不新开窗口），连不上再按原逻辑启动。文件只是提示，读写失败一律忽略。
 */
export interface ManagedBrowserEndpoint {
  /** 上一次 managed 浏览器实际使用的 CDP 端口。 */
  port: number
  /** 启动器进程 pid；仅用于诊断（Edge 可能把窗口交给子进程）。 */
  pid?: number
  /** 写入时间，ISO 8601。 */
  at: string
}

/** 端点文件名：profile 路径哈希，避免不同 profile 互相串。 */
export function managedEndpointFile(profileDir: string): string {
  const key = createHash('sha256').update(path.resolve(profileDir).toLowerCase()).digest('hex').slice(0, 12)
  return path.join(path.dirname(path.resolve(profileDir)), `.managed-browser-${key}.json`)
}

export function readManagedEndpoint(profileDir: string): ManagedBrowserEndpoint | undefined {
  try {
    const parsed = JSON.parse(readFileSync(managedEndpointFile(profileDir), 'utf8')) as Partial<ManagedBrowserEndpoint>
    if (typeof parsed.port !== 'number' || !Number.isInteger(parsed.port)) return undefined
    if (parsed.port < 1024 || parsed.port > 65535) return undefined
    return {
      port: parsed.port,
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      at: typeof parsed.at === 'string' ? parsed.at : '',
    }
  } catch {
    return undefined
  }
}

export function writeManagedEndpoint(profileDir: string, endpoint: ManagedBrowserEndpoint): void {
  try {
    writeFileSync(managedEndpointFile(profileDir), JSON.stringify(endpoint), 'utf8')
  } catch {
    // 只是加速复用的提示文件，写不了就退回“每次新起一个”的老路。
  }
}

export function clearManagedEndpoint(profileDir: string): void {
  try {
    rmSync(managedEndpointFile(profileDir), { force: true })
  } catch {
    // 同上：清理失败不影响启动。
  }
}

export interface ManagedBrowserConnection {
  browser: Browser
  context: BrowserContext
  /** 浏览器启动器句柄；Edge/Chrome 可能在启动后把窗口交给子进程。复用已有浏览器时不存在。 */
  process?: ChildProcess
  /** 实际分配给本次 managed 浏览器的 CDP 端口。 */
  port: number
}

function browserCandidates(channel: 'msedge' | 'chrome'): string[] {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? ''
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
    if (channel === 'msedge') {
      return [
        path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    }
    return [
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
  }
  if (process.platform === 'darwin') {
    return channel === 'msedge'
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  }
  return channel === 'msedge'
    ? ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
}

/**
 * 解析当前平台上的浏览器可执行文件。
 *
 * 导出给 doctor 用：自检要能回答「本机到底有没有 Edge/Chrome、装在哪」，
 * 而不是等启动时才抛 BROWSER_NOT_FOUND。返回 undefined 表示没找到。
 */
export function resolveBrowserExecutable(channel: 'msedge' | 'chrome'): string | undefined {
  return browserCandidates(channel).find(candidate => existsSync(candidate))
}

/** 选择 preferredPort；被占用时改用系统分配的本地空闲端口。 */
async function findAvailablePort(preferredPort: number): Promise<number> {
  const probe = (port: number): Promise<number | undefined> => new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(undefined))
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const selected = typeof address === 'object' && address ? address.port : undefined
      server.close(() => resolve(selected))
    })
  })
  return await probe(preferredPort) ?? await probe(0) ?? preferredPort
}

/**
 * 最小化启动时页面处于 hidden，Chromium 会节流定时器、把被遮挡窗口降优先级。
 * 这三条只关节流，不改 UA 与指纹，避免「后台等回复」被拖慢。
 */
const BACKGROUND_KEEPALIVE_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

/** PowerShell 单引号字符串转义：值里的单引号写成两个。 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * 用 `-EncodedCommand` 跑 PowerShell。
 *
 * 新脚本里带 C# here-string 和大量双引号，走 `-Command` 会被 Windows 命令行的
 * 引号转义规则截断（老函数一直这么写只是运气好）；UTF-16LE base64 不经过命令行解析。
 */
function spawnPowerShell(script: string): ChildProcess {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * 用 `Start-Process -WindowStyle Minimized` 拉起浏览器，避免新窗口抢前台。
 *
 * 为什么不用 spawn：Node 没有「指定 nCmdShow」的入口，`windowsHide` 只影响控制台窗口，
 * Chromium 建 GUI 窗口时会自己 ShowWindow，于是必然抢一次前台。本机实测
 * `Start-Process -WindowStyle Minimized` 拉起 Edge 后 `IsIconic=TRUE` 且前台窗口不变；
 * 而 `--start-minimized` 参数实测无效（窗口仍是普通大小）。
 *
 * 返回 undefined 表示 PowerShell 起不来或退出码非 0，调用方回退普通 spawn。
 */
async function spawnBrowserMinimized(
  executable: string,
  args: readonly string[],
): Promise<ChildProcess | undefined> {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$exe = [string](ConvertFrom-Json ${psQuote(JSON.stringify(executable))})`,
    `$raw = ConvertFrom-Json ${psQuote(JSON.stringify(args))}`,
    // Windows PowerShell 5.1 的 ConvertFrom-Json 把 JSON 数组当**单个对象**返回，
    // 直接 `@(...)` 只会得到 1 个元素（整个数组被拼成一行）。必须 foreach 逐项摊开。
    // 另外 Start-Process 不会替我们给含空格的参数补引号（同样是 5.1 的行为）。
    '$argv = @()',
    "foreach ($a in $raw) { $s = [string]$a; if ($s -match '\\s') { $argv += '\"' + $s + '\"' } else { $argv += $s } }",
    'Start-Process -FilePath $exe -ArgumentList $argv -WindowStyle Minimized',
    "Write-Output '1'",
  ].join('\n')
  return await new Promise<ChildProcess | undefined>(resolve => {
    const child = spawnPowerShell(script)
    let out = ''
    child.stdout?.on('data', chunk => { out += String(chunk) })
    const timer = setTimeout(() => {
      child.kill()
      console.warn('[deepseek-web] 最小化启动超时，回退普通启动。')
      resolve(undefined)
    }, 8_000)
    child.on('error', error => {
      clearTimeout(timer)
      console.warn('[deepseek-web] 无法启动 powershell.exe，回退普通启动：', error.message)
      resolve(undefined)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0 && out.trim().endsWith('1')) {
        resolve(child)
        return
      }
      console.warn(`[deepseek-web] 最小化启动失败（exit=${code}），回退普通启动。`)
      resolve(undefined)
    })
  })
}

/**
 * 启动插件自有的真实 Edge/Chrome，再通过 CDP 连接。
 *
 * 这里刻意不使用 Playwright 的 launchPersistentContext：直接启动用户安装的
 * 浏览器可以避免 Playwright 自动注入的启动参数，同时仍保留独立 profile 和
 * 可控的浏览器生命周期。
 */
/** 尝试复用同一 profile 上仍在运行的 managed 浏览器；连不上返回 undefined。 */
export async function reuseManagedBrowser(options: {
  profileDir: string
  url: string
  label: string
}): Promise<ManagedBrowserConnection | undefined> {
  const saved = readManagedEndpoint(options.profileDir)
  if (!saved) return undefined
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${saved.port}`, { timeout: 3_000 })
    const context = browser.contexts()[0]
    if (!context) {
      await browser.close().catch(() => {})
      return undefined
    }
    // 防止端口被别的调试程序占用：至少得有一个本插件目标站或空白页。
    const origin = new URL(options.url).origin
    const ours = context.pages().some(page => page.url().startsWith(origin) || page.url() === 'about:blank')
    if (!ours) {
      await browser.close().catch(() => {})
      clearManagedEndpoint(options.profileDir)
      return undefined
    }
    console.info(`[deepseek-web] ${options.label}: 复用已在运行的浏览器（CDP ${saved.port}）`)
    return { browser, context, port: saved.port }
  } catch {
    clearManagedEndpoint(options.profileDir)
    return undefined
  }
}

export async function launchManagedBrowser(options: {
  channel: 'msedge' | 'chrome'
  profileDir: string
  preferredPort: number
  url: string
  label: string
  /** true = 以最小化方式启动，不让新窗口抢到前台（仅 Windows 生效）。 */
  minimized?: boolean
}): Promise<ManagedBrowserConnection> {
  const executable = resolveBrowserExecutable(options.channel)
  if (!executable) {
    throw new LlmError(
      `${options.label}: 找不到 ${options.channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome'} 可执行文件。`,
      'BROWSER_NOT_FOUND',
    )
  }
  // 先复用同 profile 的已运行浏览器：宿主退出后浏览器可能还开着，
  // 直接再 spawn 一个会被 Chromium 单实例接管，CDP 永远不就绪。
  const reused = await reuseManagedBrowser(options)
  if (reused) return reused
  const port = await findAvailablePort(options.preferredPort)
  const minimized = options.minimized === true && process.platform === 'win32'
  const args = [
    `--user-data-dir=${options.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    ...(options.channel === 'msedge' ? ['--disable-features=msEdgeSidebarV2'] : []),
    ...(minimized ? BACKGROUND_KEEPALIVE_ARGS : []),
    // 必须把目标地址作为启动标签一起传进去。只带 --no-first-run 时 Edge 仍会打开
    // 默认启动页（ntp.msn.cn/edge/ntp），该页加载中还会再做一次重定向，和随后的
    // page.goto 抢同一个 frame，Playwright 就会抛
    // "Navigation ... is interrupted by another navigation to https://ntp.msn.cn/..."。
    // attach 模式的 tools/browser-keeper.mjs 一直是这么传的，managed 模式此前漏了。
    options.url,
  ]
  const child = (minimized ? await spawnBrowserMinimized(executable, args) : undefined)
    ?? spawn(executable, args, {
      detached: false,
      stdio: 'ignore',
      windowsHide: false,
    })
  const endpoint = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1_000))
    try {
      const browser = await chromium.connectOverCDP(endpoint)
      const context = browser.contexts()[0]
      if (context) {
        writeManagedEndpoint(options.profileDir, { port, pid: child.pid, at: new Date().toISOString() })
        return { browser, context, process: child, port }
      }
      await browser.close().catch(() => {})
    } catch {
      // 浏览器启动器和 CDP 服务需要一点时间，继续等待。
    }
  }
  child.kill()
  clearManagedEndpoint(options.profileDir)
  // 最小化启动时 child 是 powershell，杀它不会带走浏览器；按 profile 清残留。
  const killed = await killManagedBrowserProcesses({
    profileDir: options.profileDir,
    channel: options.channel,
  }).catch(() => 0)
  if (killed > 0) console.warn(`[deepseek-web] ${options.label}: 启动失败，已清理 ${killed} 个残留浏览器进程。`)
  throw new LlmError(
    `${options.label}: ${options.channel} 已启动，但 CDP ${port} 在 60 秒内未就绪。`,
    'BROWSER_MANAGED_START_FAILED',
  )
}

/** 连接（必要时拉起守护）CDP 浏览器。 */
export async function connectBrowser(options: {
  port: number
  profileDir: string
  url: string
  autoStartKeeper: boolean
  label: string
}): Promise<{ browser: Browser; context: BrowserContext }> {
  const endpoint = `http://127.0.0.1:${options.port}`
  try {
    const browser = await chromium.connectOverCDP(endpoint)
    const context = browser.contexts()[0]
    if (!context) throw new LlmError(`${options.label}: CDP 浏览器没有可用 context`, 'BROWSER_ATTACH_FAILED')
    return { browser, context }
  } catch (error) {
    if (!options.autoStartKeeper) throw error
    spawnKeeper({ profileDir: options.profileDir, port: options.port, url: options.url })
    // 守护拉起浏览器通常 1~2 秒就绪。原来是固定 1 秒一跳、最多 60 跳：
    // 已经就绪的情况下也要白等最多 1 秒。改成前 3 秒密集探测（150ms 一跳），
    // 之后就绪概率降低后再放慢到 500ms —— 总时长仍是 60 秒，但常见情况能快 3~6 倍。
    const deadline = Date.now() + 60_000
    let waited = 0
    while (Date.now() < deadline) {
      const delay = waited < 3_000 ? 150 : 500
      await new Promise(resolve => setTimeout(resolve, delay))
      waited += delay
      try {
        const browser = await chromium.connectOverCDP(endpoint)
        const context = browser.contexts()[0]
        if (context) return { browser, context }
      } catch {
        // 继续等待守护把浏览器拉起
      }
    }
    throw new LlmError(
      `${options.label}: 无法连接浏览器常驻进程（CDP ${options.port} 60 秒内未就绪）。`,
      'BROWSER_ATTACH_FAILED',
    )
  }
}

/** 默认的浏览器 profile 目录（工作区外）。 */
export function defaultProfileDir(name: string): string {
  const appDataRoot = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(appDataRoot, 'DshDeepSeekWeb', name)
}

/**
 * 把 dsh 宿主窗口提到最前（“放在屏幕最上端”）。
 *
 * 仅在 Windows 上生效：用 PowerShell 枚举顶层窗口，按进程名或标题正则
 * 匹配第一个可见窗口并调用 SetForegroundWindow。找不到匹配时静默返回 false，
 * 不抛异常，避免影响主流程。
 */
export async function focusDshWindow(options: {
  processNames?: readonly string[]
  titlePattern?: string
}): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const names = (options.processNames ?? []).map(name => String(name).trim()).filter(name => name.length > 0)
  const pattern = (options.titlePattern ?? '').trim()
  if (names.length === 0 && !pattern) return false
  const script = buildFocusScript(names, pattern)
  return await new Promise<boolean>(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      console.warn('[deepseek-web] focusDshWindow: 聚焦脚本执行超时（5s），已放弃并继续主流程。')
      resolve(false)
    }, 5_000)
    child.stdout?.on('data', chunk => { out += String(chunk) })
    child.on('error', error => {
      clearTimeout(timer)
      console.warn('[deepseek-web] focusDshWindow: 无法启动 powershell.exe：', error.message)
      resolve(false)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const ok = out.trim() === '1'
      if (!ok) {
        console.warn(
          '[deepseek-web] focusDshWindow: 未匹配到 dsh 窗口，已静默跳过。'
          + ` 进程名候选=${JSON.stringify(names)} 标题正则=${JSON.stringify(pattern)}`,
        )
      }
      resolve(ok)
    })
  })
}

/**
 * 生成聚焦脚本。
 *
 * 注意：窗口枚举与匹配全部放在 C# 内完成（包括用 .NET 的 Process 取进程名），
 * 不依赖 PowerShell 委托回调的 runspace 与 $script: 作用域——后者在
 * EnumWindows 回调里写回外层变量并不可靠，会静默失败。
 */
function buildFocusScript(processNames: readonly string[], titlePattern: string): string {
  const namesJson = JSON.stringify(processNames)
  const patternJson = JSON.stringify(titlePattern)
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    'Add-Type @"',
    'using System;',
    'using System.Text;',
    'using System.Diagnostics;',
    'using System.Runtime.InteropServices;',
    'public class DshFocus {',
    '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);',
    '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);',
    '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  public static IntPtr Target = IntPtr.Zero;',
    '  static string[] Names = new string[0];',
    '  static string Pattern = "";',
    '  public static string Find(string[] names, string pattern) {',
    '    Names = names ?? new string[0];',
    '    Pattern = pattern ?? "";',
    '    Target = IntPtr.Zero;',
    '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
    '      if (!IsWindowVisible(h)) return true;',
    '      int len = GetWindowTextLength(h);',
    '      if (len <= 0) return true;',
    '      var sb = new StringBuilder(len + 1);',
    '      GetWindowText(h, sb, sb.Capacity);',
    '      string text = sb.ToString();',
    '      uint pid = 0;',
    '      GetWindowThreadProcessId(h, out pid);',
    '      string pname = "";',
    '      try { pname = Process.GetProcessById((int)pid).ProcessName; } catch {}',
    '      bool hit = false;',
    '      foreach (var n in Names) {',
    '        if (!string.IsNullOrEmpty(n) && string.Equals(n, pname, StringComparison.OrdinalIgnoreCase)) { hit = true; break; }',
    '      }',
    '      if (!hit && Pattern.Length > 0) {',
    '        try { if (System.Text.RegularExpressions.Regex.IsMatch(text, Pattern)) hit = true; } catch {}',
    '      }',
    '      if (hit) { Target = h; return false; }',
    '      return true;',
    '    }, IntPtr.Zero);',
    '    return Target.ToString();',
    '  }',
    '  public static void Activate() {',
    '    ShowWindow(Target, 9);',
    '    SetForegroundWindow(Target);',
    '  }',
    '}',
    '"@',
    `[string[]]$names = @(ConvertFrom-Json '${namesJson}')`,
    `[string]$pattern = [string](ConvertFrom-Json '${patternJson}')`,
    '$found = [DshFocus]::Find($names, $pattern)',
    'if ($found -ne "0") {',
    '  [DshFocus]::Activate()',
    "  Write-Output '1'",
    '} else {',
    "  Write-Output '0'",
    '}',
  ].join('\n')
}

/**
 * 设置插件浏览器窗口是否置顶（屏幕最上方）。
 *
 * 仅 Windows 生效：按命令行里的 profile 目录特征定位插件专用的 msedge 窗口，
 * SetWindowPos(HWND_TOPMOST/NOTOPMOST)，置顶时同时 SetForegroundWindow。
 * 进程匹配放在 PowerShell 管道里完成（Get-CimInstance 提供 CommandLine，
 * Get-Process 提供 MainWindowHandle），只把句柄交给 P/Invoke。
 * 找不到匹配时静默返回 false，不影响主流程。
 */
export async function setBrowserWindowTopmost(options: {
  profileDir: string
  topmost: boolean
}): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const marker = String(options.profileDir ?? '').trim()
  if (!marker) return false
  const markerJson = JSON.stringify(marker)
  const topmostJson = JSON.stringify(options.topmost === true)
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `[string]$marker = [string](ConvertFrom-Json '${markerJson}')`,
    `[bool]$topmost = [bool](ConvertFrom-Json '${topmostJson}')`,
    `$pattern = '*' + $marker + '*'`,
    `$ids = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like $pattern } | ForEach-Object { $_.ProcessId })`,
    'if ($ids.Count -eq 0) { Write-Output "0"; exit }',
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class DshTop {',
    '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  public static void Apply(IntPtr h, bool topmost) {',
    '    IntPtr after = topmost ? new IntPtr(-1) : new IntPtr(-2);',
    '    SetWindowPos(h, after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);',
    '    if (topmost) SetForegroundWindow(h);',
    '  }',
    '}',
    '"@',
    '$hit = 0',
    'Get-Process -Name msedge | Where-Object { $ids -contains $_.Id -and $_.MainWindowHandle -ne 0 } | ForEach-Object {',
    '  if ([DshTop]::IsWindowVisible($_.MainWindowHandle)) { [DshTop]::Apply($_.MainWindowHandle, $topmost); $hit++ }',
    '}',
    'if ($hit -gt 0) { Write-Output "1" } else { Write-Output "0" }',
  ].join('\n')
  return await new Promise<boolean>(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      console.warn('[deepseek-web] setBrowserWindowTopmost: 脚本执行超时（5s），已放弃并继续主流程。')
      resolve(false)
    }, 5_000)
    child.stdout?.on('data', chunk => { out += String(chunk) })
    child.on('error', error => {
      clearTimeout(timer)
      console.warn('[deepseek-web] setBrowserWindowTopmost: 无法启动 powershell.exe：', error.message)
      resolve(false)
    })
    child.on('close', code => {
      clearTimeout(timer)
      // $true 路径由参数写死（topmost 由调用方决定），这里只关心是否命中窗口
      resolve(code === 0 && out.trim() === '1')
    })
  })
}

/**
 * 还原并激活插件专用的浏览器窗口。
 *
 * 最小化启动后，只有在「必须让人看」的时候才调用：检到未登录、即将抛
 * `WEB_LOGIN_REQUIRED`。找不到窗口时静默返回 false，不影响主流程。
 *
 * 单靠 `SetForegroundWindow` 会被 Windows 前台锁拦下：实测窗口还原了，前台
 * 仍是 DSH 主窗口。这里用 `AttachThreadInput` 临时挂到当前前台线程，再
 * `HWND_TOPMOST` + `BringWindowToTop` + `SetForegroundWindow`，最后恢复普通
 * 层级，尽量把登录页硬拽到最前面。
 *
 * 进程名按 `channel` 取，不再写死 msedge.exe——选 Chrome 时旧实现会静默失配。
 *
 * 返回值语义：`true` = 找到窗口且已抢到前台焦点；`false` = 没找到或没抢到。
 */
export async function restoreBrowserWindow(options: {
  profileDir: string
  channel: 'msedge' | 'chrome'
}): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const marker = String(options.profileDir ?? '').trim()
  if (!marker) return false
  const exeName = options.channel === 'chrome' ? 'chrome.exe' : 'msedge.exe'
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$marker = [string](ConvertFrom-Json ${psQuote(JSON.stringify(marker))})`,
    `$ids = @(Get-CimInstance Win32_Process -Filter "Name='${exeName}'" | Where-Object { $_.CommandLine -like ('*' + $marker + '*') } | ForEach-Object { $_.ProcessId })`,
    'if ($ids.Count -eq 0) { Write-Output "0"; exit }',
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class DshWinReveal {',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);',
    '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool fAltTab);',
    '  public static void Reveal(IntPtr h) {',
    '    // SW_RESTORE 对最大化窗口等价于 SW_SHOWNORMAL，会把窗口缩回普通尺寸；',
    '    // 只有最小化时才用 SW_RESTORE，其余保持原尺寸/最大化状态。',
    '    if (IsIconic(h)) ShowWindow(h, 9); else ShowWindow(h, 5);',
    '    IntPtr fg = GetForegroundWindow();',
    '    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);',
    '    uint curThread = GetCurrentThreadId();',
    '    bool attached = false;',
    '    if (fgThread != 0 && fgThread != curThread) attached = AttachThreadInput(fgThread, curThread, true);',
    '    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);',
    '    BringWindowToTop(h);',
    '    SetForegroundWindow(h);',
    '    if (attached) AttachThreadInput(fgThread, curThread, false);',
    '  }',
    '  public static void Retry(IntPtr h) {',
    '    SwitchToThisWindow(h, true);',
    '    SetForegroundWindow(h);',
    '  }',
    '  public static void Focus(IntPtr h) {',
    '    IntPtr fg = GetForegroundWindow();',
    '    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);',
    '    uint curThread = GetCurrentThreadId();',
    '    bool attached = false;',
    '    if (fgThread != 0 && fgThread != curThread) attached = AttachThreadInput(fgThread, curThread, true);',
    '    BringWindowToTop(h);',
    '    SetForegroundWindow(h);',
    '    if (attached) AttachThreadInput(fgThread, curThread, false);',
    '  }',
    '  public static void DropTopmost(IntPtr h) {',
    '    SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);',
    '  }',
    '}',
    '"@',
    '$hit = 0',
    'Get-Process -Id $ids | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {',
    '  if ([DshWinReveal]::IsWindowVisible($_.MainWindowHandle)) {',
    '    [DshWinReveal]::Reveal($_.MainWindowHandle)',
    '    $hit++',
    '  }',
    '}',
    'if ($hit -eq 0) { Write-Output "0"; exit }',
    'Start-Sleep -Milliseconds 300',
    '$focused = $false',
    '$fg = [DshWinReveal]::GetForegroundWindow().ToInt64()',
    'Get-Process -Id $ids | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {',
    '  if ($fg -eq $_.MainWindowHandle.ToInt64()) { $focused = $true }',
    '}',
    'if (-not $focused) {',
    '  Get-Process -Id $ids | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {',
    '    if ([DshWinReveal]::IsWindowVisible($_.MainWindowHandle)) { [DshWinReveal]::Retry($_.MainWindowHandle) }',
    '  }',
    '  Start-Sleep -Milliseconds 300',
    '  $fg = [DshWinReveal]::GetForegroundWindow().ToInt64()',
    '  Get-Process -Id $ids | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {',
    '    if ($fg -eq $_.MainWindowHandle.ToInt64()) { $focused = $true }',
    '  }',
    '}',
    'Get-Process -Id $ids | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {',
    '  [DshWinReveal]::DropTopmost($_.MainWindowHandle)',
    '}',
    '# DropTopmost 可能让当前前台窗口接管焦点：恢复普通层级后再抢一次。',
    '$focused = $false',
    'Get-Process -Id $ids | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {',
    '  if ([DshWinReveal]::IsWindowVisible($_.MainWindowHandle)) { [DshWinReveal]::Focus($_.MainWindowHandle) }',
    '}',
    'Start-Sleep -Milliseconds 300',
    '$fg = [DshWinReveal]::GetForegroundWindow().ToInt64()',
    'Get-Process -Id $ids | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {',
    '  if ($fg -eq $_.MainWindowHandle.ToInt64()) { $focused = $true }',
    '}',
    '# 前台窗口由本进程设置；进程退出过早时系统会把前台还给原窗口。',
    '# 多存活 2 秒，让焦点在调用方返回后仍然稳定；退出前再确认一次。',
    'Start-Sleep -Milliseconds 2000',
    '$focused = $false',
    '$fg = [DshWinReveal]::GetForegroundWindow().ToInt64()',
    'Get-Process -Id $ids | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {',
    '  if ($fg -eq $_.MainWindowHandle.ToInt64()) { $focused = $true }',
    '}',
    'if ($focused) { Write-Output "1" } else { Write-Output "2" }',
  ].join('\n')
  return await new Promise<boolean>(resolve => {
    const child = spawnPowerShell(script)
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      console.warn('[deepseek-web] restoreBrowserWindow: 脚本执行超时（8s），已放弃并继续主流程。')
      resolve(false)
    }, 8_000)
    child.stdout?.on('data', chunk => { out += String(chunk) })
    child.on('error', error => {
      clearTimeout(timer)
      console.warn('[deepseek-web] restoreBrowserWindow: 无法启动 powershell.exe：', error.message)
      resolve(false)
    })
    child.on('close', code => {
      clearTimeout(timer)
      const status = out.trim()
      if (code === 0 && status === '1') {
        resolve(true)
        return
      }
      if (code === 0 && status === '2') {
        console.warn('[deepseek-web] restoreBrowserWindow: 窗口已找到，但未抢到前台焦点。')
      }
      resolve(false)
    })
  })
}

/**
 * 兜底关闭某个 profile 关联的全部浏览器进程。
 *
 * 最小化启动走 `Start-Process` 后，插件手上只有 powershell 的句柄，拿不到浏览器 PID；
 * CDP 60 秒未就绪时必须按 profile 特征把残留的 Edge/Chrome 收掉，否则它会占住
 * profile 与调试端口，下一次启动直接连到半死的实例。
 */
export async function killManagedBrowserProcesses(options: {
  profileDir: string
  channel: 'msedge' | 'chrome'
}): Promise<number> {
  if (process.platform !== 'win32') return 0
  const marker = String(options.profileDir ?? '').trim()
  if (!marker) return 0
  const exeName = options.channel === 'chrome' ? 'chrome.exe' : 'msedge.exe'
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$marker = [string](ConvertFrom-Json ${psQuote(JSON.stringify(marker))})`,
    `$ids = @(Get-CimInstance Win32_Process -Filter "Name='${exeName}'" | Where-Object { $_.CommandLine -like ('*' + $marker + '*') } | ForEach-Object { $_.ProcessId })`,
    'if ($ids.Count -eq 0) { Write-Output "0"; exit }',
    '$n = 0',
    '$ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue; $n++ }',
    'Write-Output "$n"',
  ].join('\n')
  return await new Promise<number>(resolve => {
    const child = spawnPowerShell(script)
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve(0)
    }, 5_000)
    child.stdout?.on('data', chunk => { out += String(chunk) })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(0)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const parsed = Number.parseInt(out.trim(), 10)
      resolve(Number.isFinite(parsed) ? parsed : 0)
    })
  })
}
