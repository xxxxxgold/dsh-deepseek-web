/**
 * 豆包网页版浏览器通道（doubao.com/chat）。
 *
 * 结构与 `playwright-channel.ts` / `kimi-channel.ts` 保持一致：
 * 真实 Edge 常驻窗口 + 每个 dsh 会话独占一个标签页 + 会话锁；
 * 差异在站点：输入区是 tiptap contenteditable，回复是 `/chat/completion`
 * 的 SSE；快速/专家模式由用户在网页端设置，插件不切换、不校验。
 *
 * 本文件只负责浏览器操作；SSE 的纯文本解析在 `doubao-parse.ts`。
 *
 * @module dsh-deepseek-web/doubao-channel
 */

import type { Browser, BrowserContext, Page } from 'playwright-core'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AsyncLock } from './async-lock.ts'
import {
  bestEffortNewChat,
  connectBrowser,
  defaultProfileDir,
  ensureChatPage,
  focusDshWindow,
  locateEditor,
  markPageTitle,
  sendEditorMessage,
  withTimeout,
} from './browser-shared.ts'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from './browser-channel.ts'
import type { Config, DoubaoConfig } from './config.ts'
import { classifyDoubaoResponse, matchesDoubaoCompletion, parseDoubaoCompletion } from './doubao-parse.ts'
import { computeTurnGap, TurnPacer } from './pacing.ts'
import { AccountCooldown } from './cooldown.ts'

/** 单个 dsh 会话在豆包窗口里的独占工作页。 */
interface DoubaoSessionPage {
  sessionId: string
  page: Page
  /** 该页是否已经承载过一轮对话（用于 initialize 时开新对话）。 */
  started: boolean
  /** 同一会话的网页回合必须串行；不同会话各用自己的锁。 */
  readonly lock: AsyncLock
  /** 当前正在跑的网页回合；cancelTurn 用它立即中止。 */
  abort?: AbortController
  /** 取消后的页面重置任务；下一轮 stateFor 会先等它完成。 */
  resetting?: Promise<void>
  lastUsedAt: number
}

export interface DoubaoChannelOptions {
  config: Config
  /** 覆盖 profile 目录（测试用）；缺省读 doubao.profileDir 或默认目录。 */
  profileDir?: string
  label?: string
}

/** 豆包输入区右下角的发送图标（div，不是 button，没有 aria-label）。 */
const DOUBAO_SEND_SELECTOR = 'div[class*="!rounded-full"][class*="cursor-pointer"]'

function finiteInt(input: unknown, fallback: number, min: number, max: number): number {
  const value = Number(input)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

/** 把任意错误包成带稳定错误码的 LlmError；已经是 LlmError 的原样返回。 */
function asLlmError(error: unknown, prefix: string, code: string): LlmError {
  if (error instanceof LlmError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new LlmError(`${prefix}: ${message}`, code)
}

/** 豆包页面上的发送按钮定位（找不到时返回未命中的 locator）。 */
export function locateDoubaoSendButton(page: Page) {
  return page
    .locator(`${DOUBAO_SEND_SELECTOR}:has(svg path[d^="M20 9"])`)
    .last()
}

export class DoubaoBrowserChannel implements BrowserChannel {
  private readonly config: Config
  private readonly doubao: DoubaoConfig
  private readonly profileDir: string
  private readonly label: string
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private page: Page | undefined
  /** 只有「页面已就绪且登录可用」才为 true；未登录时保留 page 供打开登录窗口。 */
  private ready = false
  private readyTask: Promise<void> | undefined
  private readonly sessionPages = new Map<string, DoubaoSessionPage>()
  private readonly creatingPages = new Map<string, Promise<DoubaoSessionPage>>()
  private readonly autoSendSessions = new Map<string, boolean>()
  private readonly cancels = new Map<string, AbortController>()
  private focusSessionId: string | undefined
  private readonly originalTitles = new WeakMap<Page, string>()
  /** 回合间隔与账号冷却：豆包自己的实例，与 DeepSeek 的账号状态隔离。 */
  private readonly pacerState = new TurnPacer()
  private readonly cooldownState = new AccountCooldown()

  constructor(options: DoubaoChannelOptions) {
    this.config = options.config
    this.doubao = options.config.doubao
    this.label = options.label ?? 'doubao'
    this.profileDir = options.profileDir
      || this.doubao.profileDir
      || defaultProfileDir('doubao-profile')
  }

  // ── 生命周期 ────────────────────────────────────────────────

  async ensureReady(): Promise<void> {
    if (this.ready && this.context && this.page && !this.page.isClosed()) return
    if (!this.readyTask) {
      this.readyTask = this.start().catch((error: unknown) => {
        this.readyTask = undefined
        throw error
      })
    }
    await this.readyTask
  }

  private async start(): Promise<void> {
    const connection = await connectBrowser({
      port: finiteInt(this.doubao.debugPort, 9336, 1024, 65535),
      profileDir: this.profileDir,
      url: this.doubao.url,
      autoStartKeeper: this.doubao.autoStartKeeper !== false,
      label: this.label,
    })
    this.browser = connection.browser
    this.context = connection.context
    const origin = new URL(this.doubao.url).origin
    const existing = connection.context.pages().find(page => page.url().startsWith(origin))
    const page = existing ?? await connection.context.newPage()
    this.page = page
    try {
      await ensureChatPage(page, this.doubao.url, { activate: false })
      await this.waitForEditor(page)
    } catch (error) {
      // 登录墙要保留 page，否则「打开登录窗口」没页面可用；其他启动失败连页一起清掉。
      if (!(error instanceof LlmError) || error.code !== 'DOUBAO_LOGIN_REQUIRED') {
        if (this.page === page) this.page = undefined
        await this.closePage(page).catch(() => {})
      }
      throw error
    }
    this.ready = true
    console.info(`[doubao] 浏览器就绪 profile=${this.profileDir}（模式由网页端设置）`)
  }

  private async waitForEditor(page: Page, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.looksLoggedOut(page)) {
        throw new LlmError(
          '豆包网页未登录：请先在插件专用浏览器窗口完成登录，再重试。',
          'DOUBAO_LOGIN_REQUIRED',
        )
      }
      const visible = await locateEditor(page).isVisible().catch(() => false)
      if (visible) return
      await page.waitForTimeout(250)
    }
    throw new LlmError('豆包页面没有出现输入框（可能改版或加载失败）。', 'DOUBAO_EDITOR_MISSING')
  }

  private async looksLoggedOut(page: Page): Promise<boolean> {
    return await page.getByRole('button', { name: '登录', exact: true })
      .isVisible()
      .catch(() => false)
  }

  // 模式（快速 / 专家）由用户在豆包网页端自行设置；插件不切换、不校验，
  // 只按页面当前状态发送，避免和用户的网页设置互相覆盖。

  // ── 页面管理 ────────────────────────────────────────────────

  private async stateFor(sessionId: string): Promise<DoubaoSessionPage> {
    const existing = this.sessionPages.get(sessionId)
    if (existing && !existing.page.isClosed()) {
      if (existing.resetting) await existing.resetting.catch(() => {})
      return existing
    }
    if (existing) {
      this.sessionPages.delete(sessionId)
      void existing.page.close().catch(() => {})
    }
    const running = this.creatingPages.get(sessionId)
    if (running) return running
    const task = this.createState(sessionId).finally(() => {
      if (this.creatingPages.get(sessionId) === task) this.creatingPages.delete(sessionId)
    })
    this.creatingPages.set(sessionId, task)
    return task
  }

  private async createState(sessionId: string): Promise<DoubaoSessionPage> {
    await this.ensureReady()
    const anchor = this.page
    const anchorFree = anchor !== undefined && !anchor.isClosed() && !this.assignedPage(anchor)
    let page: Page
    if (anchorFree) {
      page = anchor!
    } else {
      await this.makeRoomForPage()
      page = await this.context!.newPage()
      await ensureChatPage(page, this.doubao.url, { activate: false })
      await this.waitForEditor(page)
    }
    const state: DoubaoSessionPage = {
      sessionId,
      page,
      started: false,
      lock: new AsyncLock(),
      lastUsedAt: Date.now(),
    }
    this.sessionPages.set(sessionId, state)
    console.info(`[doubao] 会话工作页就绪 session=${sessionId} 会话页=${this.sessionPages.size}`)
    return state
  }

  private assignedPage(page: Page): boolean {
    for (const state of this.sessionPages.values()) if (state.page === page) return true
    return false
  }

  private async makeRoomForPage(): Promise<void> {
    const max = Math.max(1, finiteInt(this.doubao.maxSessionPages, 4, 1, 16))
    let guard = 0
    while (this.sessionPages.size >= max && guard++ < 16) {
      let victim: DoubaoSessionPage | undefined
      for (const state of this.sessionPages.values()) {
        if (state.abort || state.page.isClosed()) continue
        if (!victim || state.lastUsedAt < victim.lastUsedAt) victim = state
      }
      if (!victim) break
      this.sessionPages.delete(victim.sessionId)
      console.info(`[doubao] 会话页达到上限 ${max}，回收最久未用的 session=${victim.sessionId}`)
      await this.closePage(victim.page)
    }
  }

  private mostRecentState(): DoubaoSessionPage | undefined {
    let best: DoubaoSessionPage | undefined
    for (const state of this.sessionPages.values()) {
      if (!best || state.lastUsedAt > best.lastUsedAt) best = state
    }
    return best
  }

  // ── BrowserChannel 实现 ─────────────────────────────────────

  resetConversationGate(sessionId?: string): void {
    if (sessionId) {
      const state = this.sessionPages.get(sessionId)
      if (state) state.started = false
      return
    }
    for (const state of this.sessionPages.values()) state.started = false
  }

  setSessionAutoSend(sessionId: string, auto: boolean): void {
    this.autoSendSessions.set(sessionId, auto)
  }

  setConversationFocus(sessionId: string): void {
    this.focusSessionId = sessionId
  }

  isConversationActive(sessionId: string): boolean {
    const state = this.sessionPages.get(sessionId)
    return state !== undefined && !state.page.isClosed()
  }

  currentChatId(sessionId: string): string | undefined {
    const state = this.sessionPages.get(sessionId)
    if (!state) return undefined
    return state.page.url().match(/\/chat\/(\d+)/)?.[1]
  }

  async startNewConversation(sessionId?: string): Promise<void> {
    const state = sessionId ? this.sessionPages.get(sessionId) : this.mostRecentState()
    if (!state || state.page.isClosed()) return
    const page = state.page
    const beforeId = page.url().match(/\/chat\/(\d+)/)?.[1]
    const clicked = await bestEffortNewChat(page, {
      labels: ['新对话'],
      selectors: ['button:has-text("新对话")', '[class*="sidebar_nav_item"]:has-text("新对话")'],
    }).catch(() => false)
    if (!clicked) {
      await page.goto(this.doubao.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    } else {
      await page.waitForTimeout(800)
      const afterId = page.url().match(/\/chat\/(\d+)/)?.[1]
      // SPA 点击可能只命中侧栏标题；对话 id 没变就回退到首页。
      if (beforeId && afterId === beforeId) {
        await page.goto(this.doubao.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      }
    }
    await page.waitForTimeout(500)
    await this.waitForEditor(page)
    state.started = false
  }

  async cancelTurn(sessionId?: string): Promise<void> {
    if (sessionId) {
      const state = this.sessionPages.get(sessionId)
      state?.abort?.abort()
      if (state && !state.page.isClosed() && !state.resetting) {
        // 取消后网页端可能仍在生成，回车会被忽略；把工作页导航回首页。
        // 保留 state 并在 stateFor 里等待这个任务，避免下一轮拿到同一个页面并发操作。
        state.resetting = this.resetPage(state).finally(() => {
          state.resetting = undefined
        })
      }
      await state?.resetting?.catch(() => {})
      return
    }
    for (const controller of this.cancels.values()) controller.abort()
  }

  /** 取消后的复位：回到干净对话页并保持浏览器存活。 */
  private async resetPage(state: DoubaoSessionPage): Promise<void> {
    await state.page.goto(this.doubao.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
    await this.waitForEditor(state.page, 10_000).catch(() => {})
    state.started = false
  }

  async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    const state = await this.stateFor(request.sessionId)
    const release = await state.lock.acquire(request.signal, {
      maxHoldMs: this.config.lockLeaseMs > 0 ? this.config.lockLeaseMs : undefined,
      maxWaitMs: this.config.turnTimeoutMs > 0 ? this.config.turnTimeoutMs : undefined,
    })
    const controller = new AbortController()
    state.abort = controller
    this.cancels.set(request.sessionId, controller)
    state.lastUsedAt = Date.now()
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal
    let attempted = false
    try {
      const gap = computeTurnGap(
        this.pacerState.lastEnd(),
        Date.now(),
        this.config.turnGapMinMs,
        this.config.turnGapMaxMs,
      )
      if (gap > 0) await this.sleep(gap, signal)
      const cooldownLeft = this.cooldownState.remainingMs()
      if (cooldownLeft > 0) {
        throw new LlmError(
          `豆包账号冷却中，还需约 ${Math.ceil(cooldownLeft / 1000)} 秒再试。`,
          'WEB_RATE_LIMITED',
        )
      }
      if (request.initialize && (state.started || /\/chat\/\d+/.test(state.page.url()))) {
        await this.startNewConversation(request.sessionId)
      }
      attempted = true
      const result = await this.runOnPage(state.page, request, signal)
      this.cooldownState.clear()
      state.started = true
      return result
    } catch (error) {
      if (attempted && (error as { code?: string } | undefined)?.code === 'WEB_RATE_LIMITED') {
        this.cooldownState.block(
          finiteInt(this.config.rateLimit.accountCooldownMs, 0, 0, 3_600_000),
          'doubao rate-limit',
        )
      }
      throw error
    } finally {
      if (attempted) this.pacerState.noteEnded()
      if (state.abort === controller) state.abort = undefined
      if (this.cancels.get(request.sessionId) === controller) this.cancels.delete(request.sessionId)
      release()
    }
  }

  /** 可取消的 sleep（回合间隔等待用）。 */
  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return
    if (signal.aborted) throw new LlmError('豆包回合已被取消', 'DOUBAO_TURN_CANCELLED')
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const onAbort = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new LlmError('豆包回合已被取消', 'DOUBAO_TURN_CANCELLED'))
      }
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async turnIsolated(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    await this.ensureReady()
    const page = await this.context!.newPage()
    try {
      await ensureChatPage(page, this.doubao.url, { activate: false })
      await this.waitForEditor(page)
      return await this.runOnPage(
        page,
        { ...request, autoSend: true },
        request.signal ?? new AbortController().signal,
      )
    } finally {
      this.pacerState.noteEnded()
      await this.closePage(page)
    }
  }

  /** 在指定页面上完成一轮：填字 → 发送 → 抓 SSE → 解析 → 校验模式。 */
  private async runOnPage(
    page: Page,
    request: BrowserTurnRequest,
    signal: AbortSignal,
  ): Promise<BrowserTurnResult> {
    signal.throwIfAborted()
    if (await this.looksLoggedOut(page)) {
      throw new LlmError(
        '豆包网页未登录：请先在插件专用浏览器窗口完成登录，再重试。',
        'DOUBAO_LOGIN_REQUIRED',
      )
    }
    const editor = locateEditor(page)
    if (!(await editor.isVisible().catch(() => false))) {
      throw new LlmError('豆包页面找不到输入框。', 'DOUBAO_EDITOR_MISSING')
    }
    // 回答结束后偶发遮罩层会拦截点击；先尝试 click，失败就页面内 focus。
    await editor.click({ timeout: 5_000 }).catch(async () => {
      await page.evaluate(() => {
        const element = document.querySelector<HTMLElement>('div[contenteditable="true"]')
        element?.focus()
      }).catch(() => {})
    })
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    const fillStart = Date.now()
    await page.keyboard.insertText(request.text)
    const fillMs = Date.now() - fillStart
    if (fillMs >= 5_000) console.info(`[doubao] 填入 ${request.text.length} 字耗时 ${fillMs}ms`)

    let responseSeen = false
    const ackTimeout = finiteInt(this.doubao.ackTimeoutMs, 120_000, 5_000, 600_000)
    const replyTimeout = finiteInt(this.doubao.replyTimeoutMs, 600_000, 10_000, 3_600_000)
    const responsePromise = page.waitForResponse(
      response => response.request().method() === 'POST'
        && matchesDoubaoCompletion(response.url()),
      { timeout: 0 },
    ).then(response => {
      responseSeen = true
      return response
    })
    // 发送阶段被取消时，下面的 sendEditorMessage 会先抛错，这个 waitForResponse
    // 还没被 withTimeout 接走；先挂空 catch，避免页面关闭时变成未处理拒绝。
    void responsePromise.catch(() => {})

    const autoSend = request.autoSend ?? this.autoSendSessions.get(request.sessionId) ?? true
    if (autoSend) {
      const outcome = await sendEditorMessage(page, editor, {
        verifyTimeoutMs: Math.max(3_000, finiteInt(this.config.review.sendVerifyMs, 1_500, 200, 60_000)),
        maxAttempts: 2,
        pauseMinMs: finiteInt(this.config.sendPauseMinMs, 0, 0, 5_000),
        pauseMaxMs: finiteInt(this.config.sendPauseMaxMs, 0, 0, 5_000),
        hasResponse: () => responseSeen,
        isCancelled: () => signal.aborted,
        sendButton: locateDoubaoSendButton(page),
      })
      if (signal.aborted) throw new LlmError('豆包回合已被取消', 'DOUBAO_TURN_CANCELLED')
      if (!outcome.sent) {
        throw new LlmError(
          `豆包消息没有发出去：${outcome.attempts.join('；') || '未知原因'}`,
          'DOUBAO_SEND_FAILED',
        )
      }
    } else {
      // 半自动：消息已填入，等用户点网页发送；把窗口置前方便操作。
      await page.bringToFront().catch(() => {})
      console.info('[doubao] 半自动：消息已填入，等待用户在网页点击发送')
    }

    // 自动发送从「发送动作完成」开始计时；半自动要等用户点发送，不设首响应超时，
    // 交给适配层的 turnTimeoutMs / maxStreamMs 取消信号收尾。
    const responseTask = withTimeout(responsePromise, autoSend ? ackTimeout : 0, 'DOUBAO_ACK_TIMEOUT', '豆包没有在时限内返回响应头')
    // 取消/页面关闭时底层 waitForResponse 仍会 reject；先挂一个空 catch，
    // 避免它在 Promise.race 已经失败之后变成未处理拒绝把宿主进程打崩。
    void responseTask.catch(() => {})
    const response = await this.awaitAbort(
      responseTask,
      signal,
      'DOUBAO_TURN_CANCELLED',
      '豆包回合已被取消',
    )
    const bodyTask = withTimeout(response.body(), replyTimeout, 'DOUBAO_RESPONSE_TIMEOUT', '豆包响应体读取超时')
    void bodyTask.catch(() => {})
    const body = await this.awaitAbort(
      bodyTask,
      signal,
      'DOUBAO_TURN_CANCELLED',
      '豆包回合已被取消',
    )
    const status = response.status()
    const contentType = response.headers()['content-type'] ?? ''
    const bodyText = body.toString('utf8')
    const responseError = classifyDoubaoResponse(status, contentType, bodyText)
    if (responseError) {
      if (responseError.code === 'DOUBAO_HTTP_ERROR') {
        console.warn(`[doubao] HTTP ${status} 响应摘要：${bodyText.slice(0, 200)}`)
      }
      throw new LlmError(responseError.message, responseError.code)
    }
    const parsed = parseDoubaoCompletion(body)

    if (parsed.error) {
      console.warn(`[doubao] 服务端错误 ${parsed.error.code}：${parsed.error.message.slice(0, 200)}`)
      if (/登录|login|401|403|710012001/i.test(`${parsed.error.code} ${parsed.error.message}`)) {
        throw new LlmError('豆包登录态已过期，请重新登录。', 'DOUBAO_LOGIN_REQUIRED')
      }
      if (/过于频繁|太频繁|稍后再试|rate/i.test(parsed.error.message)) {
        throw new LlmError('豆包触发频控，请稍后再试。', 'WEB_RATE_LIMITED')
      }
      throw new LlmError(`豆包返回错误 ${parsed.error.code}，请稍后重试。`, 'DOUBAO_STREAM_ERROR')
    }
    if (!parsed.text.trim()) {
      throw new LlmError('豆包没有返回正文。', 'DOUBAO_EMPTY_RESPONSE')
    }
    // 模式由用户在网页端自行设置：解析器仍把服务端回执放进 meta.mode 供诊断，
    // 但通道不切模式、也不因为回执缺失而拦截本轮。

    const target = this.focusSessionId ? this.sessionPages.get(this.focusSessionId)?.page : undefined
    if (target && !target.isClosed() && !this.doubao.autoStartKeeper) {
      // 仅 attach/无守护场景下的兜底；managed 模式由 focus 配置控制，默认不抢前台。
      await target.bringToFront().catch(() => {})
    }
    return {
      text: parsed.text,
      ...parsed.reasoning ? { reasoning: parsed.reasoning } : {},
      finishReason: parsed.finishReason,
      ...parsed.contextLengthExceeded ? { contextLengthExceeded: true } : {},
      meta: {
        conversationId: parsed.conversationId,
        sectionId: parsed.sectionId,
        mode: parsed.mode,
        fillMs,
      },
    }
  }

  /** 把取消信号接到任意 promise 上；取消时抛出稳定错误码。 */
  private async awaitAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    code: string,
    message: string,
  ): Promise<T> {
    if (signal.aborted) throw new LlmError(message, code)
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        const onAbort = (): void => reject(new LlmError(message, code))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  }

  async status(): Promise<{
    ready: boolean
    url?: string
    state?: 'ok' | 'expired' | 'pending'
    message?: string
  }> {
    if (!this.context || !this.page || this.page.isClosed()) {
      return { ready: false, state: 'pending', message: '豆包浏览器未启动' }
    }
    const loggedOut = await this.looksLoggedOut(this.page)
    if (loggedOut) {
      this.ready = false
      return { ready: false, url: this.page.url(), state: 'expired', message: '豆包未登录' }
    }
    const editorReady = await locateEditor(this.page).isVisible().catch(() => false)
    if (!editorReady) {
      this.ready = false
      return { ready: false, url: this.page.url(), state: 'pending', message: '豆包输入框未就绪' }
    }
    return { ready: true, url: this.page.url(), state: 'ok' }
  }

  async focusBrowser(): Promise<void> {
    await this.page?.bringToFront().catch(() => {})
  }

  async revealLoginWindow(): Promise<boolean> {
    if (!this.page || this.page.isClosed()) return false
    await this.page.bringToFront().catch(() => {})
    const button = this.page.getByRole('button', { name: '登录', exact: true })
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5_000 }).catch(() => {})
    }
    return true
  }

  async openLoginWindow(): Promise<{ opened: boolean; loggedIn: boolean; detail?: string }> {
    await this.ensureReady().catch(async (error: unknown) => {
      // 未登录时 ensureReady 会抛 DOUBAO_LOGIN_REQUIRED；此时也要把页面拉起来。
      if (!(error instanceof LlmError) || error.code !== 'DOUBAO_LOGIN_REQUIRED') throw error
    })
    const page = this.page
    if (!page || page.isClosed()) return { opened: false, loggedIn: false, detail: '没有可用页面' }
    await page.bringToFront().catch(() => {})
    const button = page.getByRole('button', { name: '登录', exact: true })
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5_000 }).catch(() => {})
    }
    const loggedOut = await this.looksLoggedOut(page)
    return { opened: true, loggedIn: !loggedOut }
  }

  isBrowserStarted(): boolean {
    return this.context !== undefined && this.page !== undefined && !this.page.isClosed()
  }

  async focusHarness(): Promise<void> {
    if (!this.config.focus.enabled || !this.config.focus.dshWindow) return
    await focusDshWindow({
      processNames: this.config.focus.dshProcessNames,
      titlePattern: this.config.focus.dshTitlePattern,
    }).catch(() => {})
  }

  async dispose(): Promise<void> {
    this.ready = false
    for (const state of this.sessionPages.values()) {
      await this.closePage(state.page)
    }
    this.sessionPages.clear()
    this.creatingPages.clear()
    await this.closePage(this.page)
    this.page = undefined
    // CDP 连接断开即可；不关闭用户的整个浏览器。
    await this.browser?.close().catch(() => {})
    this.context = undefined
    this.browser = undefined
  }

  /** 关标签页；卡住时最多等 3 秒，避免收尾把宿主拖住。 */
  private async closePage(page?: Page): Promise<void> {
    if (!page || page.isClosed()) return
    await Promise.race([
      page.close({ runBeforeUnload: false }).catch(() => {}),
      new Promise<void>(resolve => setTimeout(resolve, 3_000)),
    ])
  }
}
