/**
 * 基于 Playwright-core 的真实浏览器通道（有头 Edge/Chrome，无扩展）。
 *
 * 工作方式：
 * 1. managed：插件用独立 user-data-dir 启动有头 Edge/Chrome 并打开 chat.deepseek.com；
 *    用户在该窗口用自己的账号登录一次，登录态持久保存在 profile。dsh 的每个新对话
 *    都复用这个浏览器窗口和当前 Page，通过网页“新对话”入口切换，不新开浏览器。
 * 2. attach：连接用户已经以 `--remote-debugging-port` 启动的浏览器。
 * 3. 每一轮：驱动把下一条消息填入输入框并前置窗口，由用户人工点击“发送”。
 * 4. 驱动监听该页面随后的 chat/completions 类网络响应，等流结束并解析正文，
 *    不依赖网页 DOM 的私有类名来读取回答。
 *
 * @module dsh-deepseek-web/playwright-channel
 */

import { type Browser, type BrowserContext, type Page } from 'playwright-core'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { BrowserChannel, BrowserImageAttachment, BrowserTurnRequest, BrowserTurnResult } from './browser-channel.ts'
import type { Config, WebModelId } from './config.ts'
import { WEB_MODEL_CAPABILITIES } from './config.ts'
import { AsyncLock } from './async-lock.ts'
import {
  bestEffortNewChat,
  connectBrowser,
  defaultProfileDir,
  focusDshWindow,
  hasRateLimitToast,
  looksLikeRateLimitText,
  looksLoggedOut,
  locateEditor,
  ensureChatPage,
  setBrowserWindowTopmost,
  launchManagedBrowser,
  type ManagedBrowserConnection,
} from './browser-shared.ts'

/** 频控 toast / 实时增量的轮询间隔。 */
const POLL_INTERVAL_MS = 800
/** 页面网络镜像保留的最近请求数。 */
const CAPTURE_KEEP = 20
/**
 * Playwright `setInputFiles` 单次内联传输的硬上限（50MB）。
 * 超过时必须走 CDP `DOM.setFileInputFiles`（浏览器按本地路径读文件），
 * 否则会抛 "Cannot transfer files larger than 50Mb to a browser not co-located with the server"。
 */
const INLINE_UPLOAD_LIMIT_BYTES = 45 * 1024 * 1024
/** 网页端输入框里已挂附件的预览容器。 */
const ATTACHMENT_PREVIEW_SELECTOR = '.ds-animated-size-item'
/** 增量里的原始流特征（SSE 帧 / DeepSeek 网页协议字段），出现即说明捕获错了流。 */
const POLLUTION_PATTERN = /(^|\n)\s*(event:\s*\w+|data:\s*\{)|request_message_id/

interface ChatCompletionResponse {
  url: string
  request: {
    postData?: string
  }
  status: number
  body: string
  interrupted?: boolean
}

export interface PlaywrightChannelOptions {
  config: Config
  /** 显式指定 profile 目录（测试/工具脚本用）。 */
  profileDir?: string
}

function matchesCompletionUrl(url: string): boolean {
  return /\/chat\/completion\b/i.test(url)
    || /\/chat\/completions?$/i.test(url)
    || /\/conversation\/(chat|completion)/i.test(url)
}

/** 临时文件名：只留安全字符，保留扩展名，避免超长路径。 */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(-80)
  return cleaned || 'image'
}

/** 从 SSE / JSON body 里抽取模型可见正文与思考内容。 */
export function parseCompletionBody(body: string): {
  text: string
  reasoning?: string
  reliable: boolean
  /** 网页端上报的会话累计 token 用量（accumulated_token_usage，BATCH/全量补丁里的最大值）。 */
  accumulatedUsage?: number
  /** 网页端提示对话长度达到上限（finish_reason=context_length_exceeded）。 */
  contextLengthExceeded?: boolean
  finishReason?: BrowserTurnResult['finishReason']
} {
  interface LiveFragment {
    id?: number
    type: string
    content: string
  }
  // DeepSeek 网页端把回复组织成“fragments 数组 + JSON Pointer 补丁”，
  // 见 README.md 的协议说明。这里重建出完整 fragments。
  const fragments: LiveFragment[] = []
  let untrackedText = ''
  let untrackedReasoning = ''
  let lastPatchPath: string | undefined
  let lastPatchOp = 'APPEND'
  let accumulatedUsage: number | undefined
  let contextLengthExceeded = false
  let finishReason: BrowserTurnResult['finishReason']

  function observeFinish(value: unknown): void {
    if (typeof value !== 'string') return
    const reason = value.toLowerCase()
    if (reason === 'context_length_exceeded') contextLengthExceeded = true
    else if (['length', 'max_tokens', 'max-tokens', 'max_output_tokens'].includes(reason)) finishReason = 'max-tokens'
    else if (['interrupted', 'aborted', 'cancelled', 'canceled', 'content_filter', 'error'].includes(reason)) finishReason = 'interrupted'
    else if (['stop', 'finished'].includes(reason) && !finishReason) finishReason = 'stop'
  }

  /** 记录网页端上报的会话累计 token 用量（只增不减时取最新）。 */
  function observeUsage(value: unknown): void {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      accumulatedUsage = value
    }
  }

  function upsertFragment(fragment: LiveFragment, mode: 'replace' | 'append'): void {
    const index = fragment.id === undefined
      ? -1
      : fragments.findIndex(item => item.id === fragment.id)
    if (index >= 0) {
      const current = fragments[index]!
      current.type = fragment.type || current.type
      current.content = mode === 'replace' ? fragment.content : current.content + fragment.content
    } else {
      fragments.push({ ...fragment })
    }
  }

  function collectFullResponse(json: unknown): void {
    const root = json as {
      v?: { response?: { fragments?: LiveFragment[]; accumulated_token_usage?: unknown; finish_reason?: unknown } }
    }
    if (root.v?.response?.accumulated_token_usage !== undefined) {
      observeUsage(root.v.response.accumulated_token_usage)
    }
    const fragmentList = root.v?.response?.fragments
    observeFinish(root.v?.response?.finish_reason)
    if (!Array.isArray(fragmentList)) return
    for (const fragment of fragmentList) {
      if (typeof fragment.content !== 'string') continue
      // 整段 upsert：同一 id 视为服务端发来的最新完整内容
      upsertFragment({
        id: fragment.id,
        type: String(fragment.type ?? ''),
        content: fragment.content,
      }, 'replace')
    }
  }

  function lastFragmentIndex(): number {
    for (let i = fragments.length - 1; i >= 0; i--) {
      if ((fragments[i]?.type ?? '').toUpperCase() !== 'THINK') return i
    }
    return fragments.length - 1
  }

  function applyPatch(payload: Record<string, unknown>): void {
    const pointer = typeof payload.p === 'string' ? payload.p : lastPatchPath
    const op = typeof payload.o === 'string' ? payload.o : lastPatchOp
    const value = payload.v
    if (!pointer) return
    lastPatchPath = pointer
    lastPatchOp = op

    if (pointer === 'response/finish_reason') observeFinish(value)

    if (pointer === 'response/fragments' && op === 'APPEND' && Array.isArray(value)) {
      for (const fragment of value as LiveFragment[]) {
        if (fragment && typeof fragment === 'object' && typeof fragment.content === 'string') {
          upsertFragment(fragment, 'replace')
        }
      }
      return
    }

    if (pointer === 'response/fragments/-1/content') {
      const index = lastFragmentIndex()
      if (index >= 0 && typeof value === 'string') {
        const fragment = fragments[index]!
        fragment.content += value
      }
      return
    }

    // BATCH 补丁：{"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":N},…]}
    // 目前只提取 token 用量，其余子补丁不影响正文重建。
    if (op === 'BATCH' && Array.isArray(value)) {
      for (const item of value as Array<{ p?: unknown; v?: unknown }>) {
        if (item && item.p === 'accumulated_token_usage') observeUsage(item.v)
        if (item && item.p === 'finish_reason') observeFinish(item.v)
      }
      return
    }

    // SET 类补丁（status、token 计数等）不影响正文重建，忽略即可。
  }

  function consumeFragments(): void {
    for (const fragment of fragments) {
      const type = String(fragment.type ?? '').toUpperCase()
      if (type === 'RESPONSE' || type === 'TEXT' || type === 'CONTENT' || type === '') {
        untrackedText += fragment.content
      } else if (type === 'THINK' || type === 'THINKING' || type === 'REASONING' || type === 'THOUGHT') {
        untrackedReasoning += fragment.content
      }
    }
  }

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    // 兼容 "event: hint data: {…}" 同行形态：从首个 data: 起取载荷
    const dataIdx = line.indexOf('data:')
    if (dataIdx < 0) continue
    const payload = line.slice(dataIdx + 5).trim()
    if (!payload || payload === '[DONE]') continue
    let json: Record<string, unknown>
    try {
      json = JSON.parse(payload)
    } catch {
      continue
    }
    if (!json || typeof json !== 'object') continue
    observeFinish(json.finish_reason)

    if (json && typeof json === 'object' && 'p' in json) {
      applyPatch(json)
      continue
    }

    // 网页端长度上限提示：event: hint → {"finish_reason":"context_length_exceeded",…}
    if (
      (json as { finish_reason?: unknown }).finish_reason === 'context_length_exceeded'
      || (
        (json as { type?: unknown }).type === 'error'
        && String((json as { content?: unknown }).content ?? '').includes('对话长度上限')
      )
    ) {
      contextLengthExceeded = true
      continue
    }

    if (json.v && typeof json.v === 'object' && (json.v as { response?: unknown }).response) {
      collectFullResponse(json)
      continue
    }

    // 只有 {"v": "..."}：服务端对上一个 APPEND 补丁的连续增量
    if (!('p' in json) && Object.keys(json).length <= 1 && 'v' in json && lastPatchPath) {
      applyPatch({ ...json })
      continue
    }

    if (Array.isArray((json as { choices?: unknown }).choices)) {
      const choiceJson = json as unknown as {
        choices?: Array<{
          finish_reason?: unknown
          delta?: { content?: string; reasoning_content?: string; reasoner?: string }
          message?: { content?: string; reasoning_content?: string }
        }>
      }
      for (const choice of choiceJson.choices ?? []) {
        observeFinish(choice.finish_reason)
        const delta = choice.delta
        const message = choice.message
        if (typeof message?.content === 'string') untrackedText += message.content
        if (typeof message?.reasoning_content === 'string') untrackedReasoning += message.reasoning_content
        if (typeof delta?.content === 'string') untrackedText += delta.content
        const think = delta?.reasoning_content ?? delta?.reasoner
        if (typeof think === 'string') untrackedReasoning += think
      }
    }
  }

  consumeFragments()
  if (untrackedText || untrackedReasoning) {
    return {
      text: untrackedText.trim(),
      ...untrackedReasoning.trim() ? { reasoning: untrackedReasoning.trim() } : {},
      reliable: true,
      ...finishReason ? { finishReason } : {},
      ...accumulatedUsage !== undefined ? { accumulatedUsage } : {},
      ...contextLengthExceeded ? { contextLengthExceeded: true } : {},
    }
  }

  try {
    const json = JSON.parse(body) as {
      choices?: Array<{
        finish_reason?: unknown
        message?: { content?: string; reasoning_content?: string }
        text?: string
      }>
      content?: string
      finish_reason?: unknown
    }
    let fallbackText = ''
    let fallbackReasoning = ''
    observeFinish(json.finish_reason)
    for (const choice of json.choices ?? []) {
      observeFinish(choice.finish_reason)
      if (typeof choice.message?.content === 'string') fallbackText += choice.message.content
      if (typeof choice.message?.reasoning_content === 'string') fallbackReasoning += choice.message.reasoning_content
      if (typeof choice.text === 'string') fallbackText += choice.text
    }
    if (typeof json.content === 'string') fallbackText += json.content
    if (fallbackText.trim() || fallbackReasoning.trim()) {
      return {
        text: fallbackText.trim(),
        ...fallbackReasoning.trim() ? { reasoning: fallbackReasoning.trim() } : {},
        reliable: true,
        ...finishReason ? { finishReason } : {},
        ...accumulatedUsage !== undefined ? { accumulatedUsage } : {},
        ...contextLengthExceeded ? { contextLengthExceeded: true } : {},
      }
    }
    // 结构化解析一无所获：不可靠，调用方（实时轮询）必须丢弃
    return {
      text: '',
      reliable: false,
      ...finishReason ? { finishReason } : {},
      ...accumulatedUsage !== undefined ? { accumulatedUsage } : {},
      ...contextLengthExceeded ? { contextLengthExceeded: true } : {},
    }
  } catch {
    // body 不是可解析的结构化载荷（例如误捕获的状态/心跳流）：原始内容不可信
    return {
      text: body.trim(),
      reliable: false,
      ...finishReason ? { finishReason } : {},
      ...accumulatedUsage !== undefined ? { accumulatedUsage } : {},
      ...contextLengthExceeded ? { contextLengthExceeded: true } : {},
    }
  }
}

/** 单个 dsh 会话在浏览器里的独占工作页。 */
interface SessionPageState {
  sessionId: string
  page: Page
  /** 该页面是否已经承载过 agent 对话（原全局 conversationStarted 的按会话版）。 */
  started: boolean
  /** 同一会话的网页回合必须串行；不同会话各用自己的锁，因此可以并行。 */
  readonly lock: AsyncLock
  /** 当前正在跑的网页回合；cancelTurn 用它立即中止。 */
  abort?: AbortController
  /** 最近一次使用时间（用于回收最久未用的会话页）。 */
  lastUsedAt: number
}

export class PlaywrightBrowserChannel implements BrowserChannel {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  /** 锚点页面：第一个会话直接复用这个已登录的标签页，也供状态展示/聚焦使用。 */
  private page: Page | undefined
  /**
   * 每个 dsh 会话独占一个网页标签页 + 一把会话锁。
   *
   * 关键点：主会话和它派生的子代理是两个不同 sessionId，各自拿到自己的标签页，
   * 因此不会再互相等对方那个"最长 10 分钟"的网页回合；同一会话的多个网页回合仍然串行。
   */
  private readonly sessionPages = new Map<string, SessionPageState>()
  /** 会话工作页创建的单飞（同一会话并发进入时只建一次）。 */
  private readonly creatingPages = new Map<string, Promise<SessionPageState>>()
  /** 正在创建、尚未登记进 sessionPages 的标签页：清理残留标签时必须避开它们。 */
  private readonly pendingPages = new Set<Page>()
  /** ensureReady 的单飞：并发请求不会重复拉起浏览器。 */
  private ensureReadyTask: Promise<void> | undefined
  /** 当前正在跑的主 agent 会话（由 adapter 每次 streamTask 开始时打点）。 */
  private focusSessionId: string | undefined
  /** 页面原始标题，用于状态标记前缀的清除/还原。 */
  private readonly originalTitles = new WeakMap<Page, string>()
  private readonly options: PlaywrightChannelOptions
  private readonly profileDir: string
  private managedConnection: ManagedBrowserConnection | undefined
  /** 连续请求计数与最后一次请求时间（防风控长休用，见 maybeTakeLongRunPause）。 */
  private consecutiveSends = 0
  private lastSendAt = 0

  constructor(options: PlaywrightChannelOptions) {
    this.options = options
    // 空串等价于「用默认目录」：设置页里清空 profileDir 就是在表达这个意思，
    // 而 Config 里该字段的默认值也是空串，所以这里按 falsy 兜底。
    this.profileDir = options.profileDir
      || options.config.profileDir
      || defaultProfileDir('edge-profile')
  }

  /** 打开/连接浏览器并确保已登录；并发进入时只执行一次（单飞）。 */
  async ensureReady(): Promise<void> {
    const running = this.ensureReadyTask
    if (running) return running
    const task = this.ensureReadyCore().finally(() => {
      if (this.ensureReadyTask === task) this.ensureReadyTask = undefined
    })
    this.ensureReadyTask = task
    return task
  }

  private async ensureReadyCore(): Promise<void> {
    if (this.browser?.isConnected() && this.context) {
      // 浏览器还活着：只补齐锚点页，绝不重复拉起浏览器，也不动其它会话的标签页。
      this.pruneClosedStates()
      if (!this.page || this.page.isClosed()) {
        const pages = this.context.pages().filter(candidate => !candidate.isClosed())
        this.page = pages.find(candidate => candidate.url().startsWith(new URL(this.options.config.url).origin))
          ?? await this.context.newPage()
        await ensureChatPage(this.page, this.options.config.url)
      }
      return
    }

    if (this.options.config.browser === 'attach') {
      // 连接（必要时自动拉起）浏览器常驻守护，逻辑集中在 browser-shared 的 connectBrowser
      const { browser, context } = await connectBrowser({
        port: this.options.config.debugPort,
        profileDir: this.profileDir,
        url: this.options.config.url,
        autoStartKeeper: this.options.config.autoStartKeeper,
        label: 'deepseek-web',
      })
      this.browser = browser
      this.context = context
    } else {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(this.profileDir, { recursive: true })
      this.managedConnection = await launchManagedBrowser({
        channel: this.options.config.channel,
        profileDir: this.profileDir,
        preferredPort: this.options.config.debugPort,
        url: this.options.config.url,
        label: 'deepseek-web',
      })
      this.browser = this.managedConnection.browser
      this.context = this.managedConnection.context
    }

    const pages = this.context.pages()
    this.page = pages.find(p => p.url().startsWith(new URL(this.options.config.url).origin))
      ?? pages[0]
      ?? await this.context.newPage()
    // managed profile 只由本插件使用：保留一个工作标签，关闭启动器或旧版本
    // 残留的空白/重复标签，避免首次请求同时出现两个网页。attach 模式不碰
    // 用户自己打开的其他标签；已分配给 dsh 会话的标签页一律保留。
    if (this.options.config.browser === 'managed') {
      await Promise.all(pages
        .filter(page => !page.isClosed() && !this.ownedPage(page))
        .map(page => page.close().catch(() => {})))
    }

    await ensureChatPage(this.page, this.options.config.url)
    // 等待前端登录态/编辑器出现
    await this.page.waitForTimeout(1_500)

    if (await looksLoggedOut(this.page)) {
      throw new LlmError(
        'deepseek-web: 浏览器窗口已打开，但 chat.deepseek.com 尚未登录。'
        + '请在窗口中完成登录后重试本轮任务（登录状态会保存在本地 profile）。',
        'WEB_LOGIN_REQUIRED',
      )
    }
  }

  resetConversationGate(sessionId?: string): void {
    // 新的 dsh 会话开始时由 adapter 调用；只解除该会话"已开始对话"的标记。
    if (sessionId === undefined) {
      for (const state of this.sessionPages.values()) state.started = false
      return
    }
    const state = this.sessionPages.get(sessionId)
    if (state) state.started = false
  }

  isConversationActive(sessionId: string): boolean {
    const state = this.sessionPages.get(sessionId)
    if (!state) return false
    if (state.page.isClosed()) {
      this.sessionPages.delete(sessionId)
      return false
    }
    return state.started
  }

  /** 轮换到全新网页对话（上下文长度达到上限时由 adapter 调用）。 */
  async startNewConversation(sessionId?: string): Promise<void> {
    // 只切换目标会话自己那个标签页里的网页会话；不创建新 Browser/Context/Page。
    const state = sessionId !== undefined
      ? await this.stateFor(sessionId)
      : this.mostRecentState() ?? await this.stateFor('anonymous')
    this.originalTitles.delete(state.page)
    await this.startFreshConversation(state.page)
    state.started = true
    state.lastUsedAt = Date.now()
  }

  /**
   * 确保网页端切到一个全新对话。
   *
   * 先尝试点击侧栏入口；若点击失败或 URL 未变化，则回退为重新打开入口页，
   * 强制落到全新对话，避免沿用上一次的网页会话（全自动模式下的典型问题）。
   */
  private async startFreshConversation(page: Page, entryUrl = this.options.config.url): Promise<void> {
    const beforeUrl = page.url()
    const existingPages = new Set(page.context().pages())
    const clicked = await bestEffortNewChat(page)
    await page.waitForTimeout(800)
    // 某些网页版本会把“新对话”按钮实现成新标签。插件要求所有 dsh 对话
    // 复用同一个网页标签，因此关闭点击产生的额外标签并回退到当前页面。
    await Promise.all(page.context().pages().filter(candidate => candidate !== page
      && !existingPages.has(candidate)
      && !this.ownedPage(candidate))
      .map(candidate => candidate.close().catch(() => {})))
    if (clicked && page.url() !== beforeUrl) {
      console.info('[deepseek-web] 已切换到新对话。')
    } else {
      console.warn('[deepseek-web] 未能确认切换到新对话，回退为重新打开入口页以强制新会话。')
      await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
      await page.waitForTimeout(1_000)
    }
    // 新对话页/入口页是 SPA：导航完成后编辑器可能滞后渲染，等待它出现再返回
    await locateEditor(page).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  }

  private async markPageStatus(page: Page, marker: string | undefined): Promise<void> {
    if (!this.originalTitles.has(page)) {
      this.originalTitles.set(page, await page.title())
    }
    const clean = this.originalTitles.get(page)!.replace(/^\[dsh[^\]]*\]\s*/u, '')
    await page.evaluate(({ title, prefix }) => {
      document.title = prefix ? `${prefix} ${title}` : title
    }, { title: clean, prefix: marker })
  }

  async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    await this.ensureReady()
    // 同对话自审（preserveConversation）必须落回"发起审阅的那个会话"的网页页：
    // 优先用请求里显式指定的 conversationSessionId（不受并发子会话影响），
    // 其次才回落 adapter 打点的 focusSessionId，最后才是"最近用过的页"。
    // 否则主会话审阅阶段一旦有子代理启动，自审文本就会写进子代理的网页对话。
    const explicitTarget = request.conversationSessionId
      ?? (request.preserveConversation ? this.focusSessionId : undefined)
    const targeted = explicitTarget !== undefined ? this.sessionPages.get(explicitTarget) : undefined
    let state: SessionPageState
    if (request.preserveConversation) {
      if (targeted !== undefined && !targeted.page.isClosed()) {
        state = targeted
      } else if (explicitTarget !== undefined) {
        state = await this.stateFor(explicitTarget)
      } else {
        state = this.mostRecentState() ?? await this.stateFor(request.sessionId)
      }
    } else {
      state = await this.stateFor(request.sessionId)
    }
    if (state.page.isClosed()) {
      throw new LlmError('deepseek-web: 会话工作页已被关闭，请重试本轮任务（会重新回放宿主上下文）。', 'WEB_PAGE_CLOSED')
    }

    const release = await state.lock.acquire(request.signal, {
      maxHoldMs: this.options.config.lockLeaseMs,
      onLeak: info => console.warn(
        `[deepseek-web] 会话回合锁被强制回收：session=${state.sessionId} 已持有 ${Math.round(info.heldMs / 1000)}s。`
        + '该回合仍在后台收尾，但不会再永久阻塞这个会话的后续请求。',
      ),
    })

    // 内部中止源：cancelTurn（宿主放弃生成）与单回合超时都走这里，和宿主 signal 并联，
    // 谁先触发都能让网页回合立刻结束，不再出现"没人等它但页面还在生成"的幽灵回合。
    const abort = new AbortController()
    state.abort = abort
    let relay: (() => void) | undefined
    if (request.signal) {
      relay = () => abort.abort(request.signal?.reason)
      if (request.signal.aborted) relay()
      else request.signal.addEventListener('abort', relay, { once: true })
    }
    let timedOut = false
    const timeoutMs = this.options.config.turnTimeoutMs
    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        abort.abort(new Error('turn timeout'))
      }, timeoutMs)
      : undefined
    if (timer) (timer as unknown as { unref?: () => void }).unref?.()
    const inner: BrowserTurnRequest = { ...request, signal: abort.signal }

    try {
      console.info(
        `[deepseek-web] turn 入口 session=${request.sessionId} initialize=${String(request.initialize)} `
        + `页面会话=${state.sessionId} started=${String(state.started)} 会话页=${this.sessionPages.size}`,
      )
      request.signal?.throwIfAborted()
      if (request.initialize && !state.started) {
        await this.startFreshConversation(state.page)
        state.started = true
      }
      return await this.turnOnPage(state.page, inner)
    } catch (error) {
      if (timedOut) {
        throw new LlmError(
          `deepseek-web: 本次网页回合超过单回合上限（${Math.round(timeoutMs / 1000)}s），已主动中止，避免长期占用网页与会话锁。`
          + '请检查网页是否卡在生成中，或调大 turnTimeoutMs 后重试。',
          'WEB_TURN_TIMEOUT',
        )
      }
      if (abort.signal.aborted && !request.signal?.aborted) {
        throw new LlmError('网页回合已被主动取消（宿主已放弃本次生成）。', 'WEB_TURN_ABORTED')
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (relay) request.signal?.removeEventListener('abort', relay)
      if (state.abort === abort) state.abort = undefined
      state.lastUsedAt = Date.now()
      release()
    }
  }

  /** 取消指定会话（不传则全部）当前挂在网页上的回合。 */
  async cancelTurn(sessionId?: string): Promise<void> {
    const targets = sessionId === undefined
      ? [...this.sessionPages.values()]
      : [this.sessionPages.get(sessionId)]
        .filter((state): state is SessionPageState => state !== undefined)
    for (const state of targets) {
      const abort = state.abort
      if (!abort || abort.signal.aborted) continue
      console.info(
        `[deepseek-web] 取消会话回合 session=${state.sessionId}：宿主已放弃本次生成，`
        + '立即结束网页回合，避免该会话后续请求排队等待。',
      )
      abort.abort(new Error('cancelled'))
    }
  }

  async turnIsolated(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    // 隔离辅助请求用一次性标签页：不占任何会话锁，多个会话的摘要/标题因此可以真并行。
    await this.ensureReady()
    request.signal?.throwIfAborted()
    let page: Page | undefined
    try {
      page = await this.context!.newPage()
      const entryUrl = new URL('/', this.options.config.url).href
      await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await this.startFreshConversation(page, entryUrl)
      return await this.turnOnPage(page, request)
    } finally {
      await page?.close().catch(() => {})
      await this.setWebWindowTopmost(request.sessionId, false).catch(() => {})
    }
  }

  private async turnOnPage(page: Page, request: BrowserTurnRequest): Promise<BrowserTurnResult> {

    // 频控自动重发：网页提示“发送过于频繁”时等待后重发同一条消息，
    // 而不是中断回合报错；重试用尽才抛 WEB_RATE_LIMITED。
    const rateLimit = this.options.config.rateLimit
    const maxRetries = rateLimit?.enabled === false ? 0 : rateLimit?.maxRetries ?? 5
    for (let attempt = 0; ; attempt++) {
      request.signal?.throwIfAborted()
      const outcome = await this.sendAndWait(page, request)
      if (outcome.kind === 'completed') {
        const parsed = parseCompletionBody(outcome.completion.body)
        if (outcome.completion.status >= 400) throw new LlmError(
          `网页返回 HTTP ${outcome.completion.status}，未作为有效回复提交。`, 'WEB_HTTP_ERROR')
        if (!parsed.text && !parsed.reasoning && parsed.contextLengthExceeded !== true
          && !outcome.completion.interrupted && !['max-tokens', 'interrupted'].includes(parsed.finishReason ?? '')) {
          throw new LlmError(
            `deepseek-web: 网页响应没有可解析正文（HTTP ${outcome.completion.status}，${outcome.completion.url}）`,
            'WEB_EMPTY_RESPONSE',
          )
        }
        if (!parsed.reliable && !parsed.contextLengthExceeded && !parsed.finishReason
          && !outcome.completion.interrupted) {
          throw new LlmError('网页响应格式无法识别，原始网络内容未作为正文提交。', 'WEB_UNPARSEABLE_RESPONSE')
        }
        return {
          text: parsed.text,
          ...parsed.reasoning !== undefined ? { reasoning: parsed.reasoning } : {},
          ...parsed.accumulatedUsage !== undefined ? { accumulatedUsage: parsed.accumulatedUsage } : {},
          ...parsed.contextLengthExceeded === true ? { contextLengthExceeded: true } : {},
          ...outcome.completion.interrupted ? { finishReason: 'interrupted' as const }
            : parsed.finishReason ? { finishReason: parsed.finishReason } : {},
        }
      }
      if (attempt >= maxRetries) {
        throw new LlmError(
          `deepseek-web: 网页提示发送过于频繁，已自动重发 ${maxRetries} 次仍未成功。`
          + '请稍后在网页端手动发送，或稍后重试本任务。',
          'WEB_RATE_LIMITED',
        )
      }
      const delayMs = rateLimit?.retryDelayMs ?? 30_000
      console.info(
        `[deepseek-web] 网页提示发送频繁，${Math.round(delayMs / 1000)}s 后自动重发同一条消息（第 ${attempt + 1}/${maxRetries} 次）…`,
      )
      await this.markPageStatus(page, `[dsh 频控：${Math.round(delayMs / 1000)}s 后自动重发]`)
      await this.sleep(delayMs, request.signal)
      await this.markPageStatus(page, undefined).catch(() => {})
    }
  }

  /** 该页面是否由本通配给某个 dsh 会话（清理残留标签页时判断归属）。 */
  private ownedPage(page: Page): boolean {
    if (page === this.page) return true
    return this.assignedPage(page)
  }

  /** 该页面是否已分配给某个会话（不算"锚点页"这一层身份，供复用判断）。 */
  private assignedPage(page: Page): boolean {
    if (this.pendingPages.has(page)) return true
    for (const state of this.sessionPages.values()) if (state.page === page) return true
    return false
  }

  private markPageStarted(page: Page): void {
    for (const state of this.sessionPages.values()) {
      if (state.page === page) {
        state.started = true
        return
      }
    }
  }

  private mostRecentState(): SessionPageState | undefined {
    let best: SessionPageState | undefined
    for (const state of this.sessionPages.values()) {
      if (state.page.isClosed()) continue
      if (!best || state.lastUsedAt > best.lastUsedAt) best = state
    }
    return best
  }

  /** 取（必要时创建）会话独占的工作页；同一会话并发进入只会创建一次。 */
  private stateFor(sessionId: string): Promise<SessionPageState> {
    const existing = this.sessionPages.get(sessionId)
    if (existing && !existing.page.isClosed()) return Promise.resolve(existing)
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

  private async createState(sessionId: string): Promise<SessionPageState> {
    await this.ensureReady()
    // 首个会话直接复用已登录的锚点页；后续会话各自新开一个标签页。
    const anchor = this.page
    const anchorFree = anchor !== undefined && !anchor.isClosed() && !this.assignedPage(anchor)
    let page: Page
    if (anchorFree) {
      page = anchor!
    } else {
      await this.makeRoomForPage()
      page = await this.context!.newPage()
      // 新标签页在登记进 sessionPages 之前也要算"本插件占用"：
      // 否则同时进行的"开启新对话"清理残留标签时可能把它当野标签关掉。
      this.pendingPages.add(page)
      try {
        const entryUrl = new URL('/', this.options.config.url).href
        await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
        await ensureChatPage(page, this.options.config.url).catch(() => {})
        await page.waitForTimeout(500)
      } finally {
        this.pendingPages.delete(page)
      }
    }
    const state: SessionPageState = {
      sessionId,
      page,
      started: false,
      lock: new AsyncLock(),
      lastUsedAt: Date.now(),
    }
    this.sessionPages.set(sessionId, state)
    console.info(
      `[deepseek-web] 会话工作页就绪 session=${sessionId} 会话页=${this.sessionPages.size}/${this.options.config.maxSessionPages}`
      + `${page === anchor ? '（复用锚点页）' : '（新开标签页）'}`,
    )
    return state
  }

  /** 达到标签页上限时回收最久未用且当前空闲的会话页。 */
  private async makeRoomForPage(): Promise<void> {
    const max = Math.max(1, this.options.config.maxSessionPages)
    let guard = 0
    while (this.sessionPages.size >= max && guard++ < 16) {
      let victim: SessionPageState | undefined
      for (const state of this.sessionPages.values()) {
        if (state.abort || state.page.isClosed()) continue
        if (!victim || state.lastUsedAt < victim.lastUsedAt) victim = state
      }
      if (!victim) break
      console.info(
        `[deepseek-web] 会话页达到上限 ${max}，回收最久未用的工作页 session=${victim.sessionId}`
        + '（该会话下次请求会重新回放宿主上下文）。',
      )
      this.sessionPages.delete(victim.sessionId)
      await victim.page.close().catch(() => {})
      // 被回收的可能正是复用过锚点页的那个会话：锚点指针要跟着失效，
      // 下次 ensureReady 会挑一个存活页或新开一个，避免后续操作落在已关闭页上。
      if (this.page === victim.page) this.page = undefined
    }
  }

  private pruneClosedStates(): void {
    for (const [sessionId, state] of this.sessionPages) {
      if (state.page.isClosed()) this.sessionPages.delete(sessionId)
    }
  }

  /**
   * 一轮“填入 → 发送 → 等回复”。检测到频控（toast / 429 / 响应体提示）时
   * 返回 rate-limited，由 turn() 的重发循环接手；其余情况返回完整响应。
   * 同时把网页端的流式增量经 onProgress 回调上抛（实时思考流）。
   */
  /**
   * 清掉输入框里残留的附件预览。
   *
   * 用户取消上一轮、或发送前抛错时，网页输入框里可能还挂着上次的图；不清掉就会
   * 串到本轮（发一条纯文本却带上旧图）。每轮发送前统一清一次，无附件时零开销
   * （找不到预览就直接返回）。
   */
  private async clearAttachments(page: Page): Promise<void> {
    // 删除按钮是预览块里唯一"直接子元素是 .ds-icon"的 div（class 名是构建哈希，不可依赖）。
    const remove = page.locator(`${ATTACHMENT_PREVIEW_SELECTOR} div:has(> .ds-icon)`)
    for (let guard = 0; guard < 40; guard += 1) {
      const count = await remove.count().catch(() => 0)
      if (count === 0) return
      const clicked = await remove.first().click({ timeout: 2_000 }).then(() => true, () => false)
      if (!clicked) return
      await this.sleep(150).catch(() => {})
    }
  }

  /**
   * 把本轮的图片挂到网页输入框（由网页端自己完成上传并回填 `ref_file_ids`）。
   *
   * 顺序很重要：必须在键盘输入文本之前完成——半自动模式一把窗口置顶，用户可能
   * 看到输入框就立刻回车；附件没挂上就发出去，本轮图片会静默丢失。
   *
   * 复用的两条上传路径：
   * - 总字节 ≤ 45MB：`setInputFiles` 内联传 buffer；
   * - 超过则先落临时文件，再走 CDP `DOM.setFileInputFiles`（浏览器按本地路径读）。
   *
   * 失败处理遵循 `uploadOnError`：`abort` 抛 `WEB_IMAGE_UPLOAD_FAILED`；
   * `fallback-text` 只告警并继续，正文里的 `[附图: …]` 标记不因此变成"已上传"。
   */
  private async attachAttachments(page: Page, request: BrowserTurnRequest): Promise<void> {
    const files = request.attachments ?? []
    const { config } = this.options

    try {
      if (files.length === 0) {
        // 纯文本轮：清掉可能残留的旧附件，避免上一轮取消后留在输入框里的图串到本轮。
        await this.clearAttachments(page)
        return
      }

      const input = page.locator('input[type="file"]').first()
      if (await input.count().catch(() => 0) === 0) {
        this.handleUploadFailure(request, new Error('页面上没有找到 input[type="file"]'))
        return
      }

      // 幂等：频控重发会再次走到这里，已挂上的同名预览不再传一遍。
      const attached = await page
        .locator(`${ATTACHMENT_PREVIEW_SELECTOR} img`)
        .evaluateAll(nodes => nodes.map(node => node.getAttribute('alt') ?? ''))
        .catch(() => [] as string[])
      if (files.every(file => attached.includes(file.name))) {
        console.info('[deepseek-web] 本轮图片已在输入框里，跳过重复上传。')
        return
      }

      // 只留本轮的图：先清掉残留（上一次取消/失败留下的），再挂新的。
      await this.clearAttachments(page)
      const before = await page.locator(ATTACHMENT_PREVIEW_SELECTOR).count().catch(() => 0)
      // 网页端自己的上传状态机：upload_file → fetch_files（PENDING → PARSING → SUCCESS）。
      // 预览缩略图出现只说明"文件被接住"，PARSING 完成才能发送，否则模型看不到图。
      const parsed = page.waitForResponse(async response => {
        if (!response.url().includes('/api/v0/file/fetch_files')) return false
        const body = await response.json().catch(() => undefined) as
          { data?: { biz_data?: { files?: Array<{ status?: string }> } } } | undefined
        const list = body?.data?.biz_data?.files
        return Array.isArray(list) && list.length > 0 && list.every(item => item.status === 'SUCCESS')
      }, { timeout: config.uploadTimeoutMs }).then(response => response != null, () => false)

      const totalBytes = files.reduce((sum, file) => sum + file.data.byteLength, 0)
      if (totalBytes > INLINE_UPLOAD_LIMIT_BYTES) {
        console.info(`[deepseek-web] 图片总计 ${Math.round(totalBytes / 1024 / 1024)}MB，走 CDP 路径上传。`)
        await this.attachViaCdp(page, files)
      } else {
        await input.setInputFiles(files.map(file => ({
          name: file.name,
          mimeType: file.mimeType,
          buffer: Buffer.from(file.data),
        })))
      }

      const previewed = await page.waitForFunction(
        ({ selector, count }) => document.querySelectorAll(selector).length > count,
        { selector: ATTACHMENT_PREVIEW_SELECTOR, count: before },
        { timeout: 15_000 },
      ).then(() => true, () => false)
      if (!previewed) {
        this.handleUploadFailure(request, new Error('上传后 15 秒内没有出现附件预览'))
        return
      }

      if (!(await parsed)) {
        this.handleUploadFailure(request, new Error(`等待图片解析超时（${config.uploadTimeoutMs}ms）`))
        return
      }
      console.info(`[deepseek-web] 已上传 ${files.length} 张图片，网页端解析完成。`)
    } catch (error) {
      if (error instanceof LlmError) throw error
      this.handleUploadFailure(request, error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** 上传失败出口：按配置抛错或降级（降级只告警，不改正文，也不谎报成功）。 */
  private handleUploadFailure(request: BrowserTurnRequest, error: Error): void {
    if (this.options.config.uploadOnError === 'abort') {
      throw new LlmError(
        `deepseek-web: 图片上传失败（会话 ${request.sessionId}）：${error.message}`,
        'WEB_IMAGE_UPLOAD_FAILED',
        { cause: error },
      )
    }
    console.warn(`[deepseek-web] 图片上传失败，本轮退回文本标记继续：${error.message}`)
  }

  /**
   * >45MB 的图片走 CDP：先落临时文件，再让浏览器按绝对路径读。
   * Playwright 的 `setInputFiles` 不适合大文件（跨进程传 buffer 有 50MB 硬上限）。
   */
  private async attachViaCdp(page: Page, files: readonly BrowserImageAttachment[]): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-web-upload-'))
    try {
      const absolute: string[] = []
      for (const [index, file] of files.entries()) {
        const target = path.join(dir, `${index}-${sanitizeFileName(file.name)}`)
        await writeFile(target, Buffer.from(file.data))
        absolute.push(target)
      }
      const session = await page.context().newCDPSession(page)
      try {
        const { root } = await session.send('DOM.getDocument') as { root: { nodeId: number } }
        const { nodeId } = await session.send('DOM.querySelector', {
          nodeId: root.nodeId,
          selector: 'input[type="file"]',
        }) as { nodeId: number }
        if (!nodeId) throw new Error('未找到 input[type="file"] 节点')
        await session.send('DOM.setFileInputFiles', { files: absolute, nodeId })
      } finally {
        await session.detach().catch(() => {})
      }
      // 浏览器是异步读文件的：留出拷贝窗口再清理临时目录。
      await this.sleep(3_000)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async sendAndWait(
    page: Page,
    request: BrowserTurnRequest,
  ): Promise<
    { kind: 'completed'; completion: ChatCompletionResponse } | { kind: 'rate-limited' }
  > {
    // 连续发满 N 轮先静默一阵（防风控），再进入本轮。
    await this.maybeTakeLongRunPause(page, request.signal)

    const autoSend = request.autoSend
      ?? this.autoSendSessions.get(request.sessionId)
      ?? this.options.config.sendMode === 'approved'

    // 提前挂监听，防止用户在我们填完后立刻点击发送导致漏掉响应。
    // 频控重发时旧 waiter 用 waiterActive 作废，避免迟到响应串扰下一轮。
    let waiterActive = true
    const waiter = page.waitForResponse(async response => {
      if (response.request().method() !== 'POST') return false
      if (!matchesCompletionUrl(response.url())) return false
      return true
    }, { timeout: this.options.config.streamIdleTimeoutMs }).then(async response => {
      await this.markPageStatus(page, request.purpose ? `[dsh 内部辅助：${request.purpose} 生成中]` : '[dsh 网页生成中]').catch(() => {})
      const interrupted = await response.finished().then(error => error !== null, () => true)
      const body = await response.body().catch(() => '')
      if (!waiterActive) return undefined
      return {
        url: response.url(),
        request: {
          postData: response.request().postData()?.slice(0, 4_000),
        },
        status: response.status(),
        body: body.toString(),
        interrupted,
      } satisfies ChatCompletionResponse
    }, (error) => {
      if (!waiterActive) return undefined
      throw error
    })
    // 编辑器等待或取消可能先于 waiter 结束，提前安装 rejection handler。
    void waiter.catch(() => {})

    let abortListener: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      if (!request.signal) return
      abortListener = () => reject(new LlmError('网页回合已取消。', 'WEB_TURN_ABORTED'))
      request.signal.addEventListener('abort', abortListener, { once: true })
      if (request.signal.aborted) abortListener()
    })
    void aborted.catch(() => {})
    let progressTimer: NodeJS.Timeout | undefined
    let toastTimer: NodeJS.Timeout | undefined

    try {
      request.signal?.throwIfAborted()

      let rateLimitedNow: (() => void) | undefined
      const rateLimited = new Promise<{ kind: 'rate-limited' }>(resolve => {
        rateLimitedNow = () => resolve({ kind: 'rate-limited' })
      })

      const editor = locateEditor(page)
      if (!(await editor.isVisible().catch(() => false))) {
        // 轮换/导航后 SPA 渲染可能滞后：先等输入框出现（最多 15 秒），仍没有再报错
        const appeared = await editor.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)
        if (!appeared) {
          waiterActive = false
          if (await looksLoggedOut(page)) {
            throw new LlmError(
              'deepseek-web: 浏览器窗口已打开，但 chat.deepseek.com 尚未登录。'
              + '请在窗口中完成登录后重试本轮任务（登录状态会保存在本地 profile）。',
              'WEB_LOGIN_REQUIRED',
            )
          }
          throw new LlmError(
            'deepseek-web: 未找到聊天输入框。请确认浏览器停留在 chat.deepseek.com 的对话页；'
            + '若刚切换过页面请稍等片刻后重试。',
            'WEB_EDITOR_NOT_FOUND',
          )
        }
      }

      // 实时思考流：确保页面里的网络镜像已就位（幂等），发送后轮询增量
      progressTimer = request.onProgress
        ? await this.startProgressPolling(page, request)
        : undefined
      toastTimer = setInterval(() => {
        void hasRateLimitToast(page).then(hit => {
          if (hit) rateLimitedNow?.()
        })
      }, POLL_INTERVAL_MS)

      request.signal?.throwIfAborted()
      await editor.click()
      // 清掉可能残留的内容
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      await page.keyboard.press('Backspace')
      // 先清掉可能残留的旧附件，避免上一轮取消后留在输入框里的图串到本轮。
      await this.attachAttachments(page, request)
      request.signal?.throwIfAborted()
      await page.keyboard.insertText(request.text)
      if (page === this.page) this.markPageStarted(page)
      if (autoSend) {
        // 全自动：输入框已聚焦（editor.click），先随机停一段再回车发送。
        // 真人打完字不会立刻回车；固定延迟的方差≈0 反而是明显的机器特征。
        const pause = this.pickPause(this.options.config.sendPauseMinMs, this.options.config.sendPauseMaxMs)
        if (pause >= 1) {
          await this.markPageStatus(page, `[dsh 已填入，${(pause / 1000).toFixed(1)}s 后发送]`)
          await this.sleep(pause, request.signal)
        }
        await editor.focus()
        await page.keyboard.press('Enter')
        await this.markPageStatus(page, request.purpose ? `[dsh 内部辅助：${request.purpose} 自动发送]` : '[dsh 自动发送中]')
        console.info('[deepseek-web] 全自动：已输入并回车发送…')
      } else {
        // 半自动：网页窗口置顶到屏幕最上方并聚焦输入框，用户直接回车或点击发送
        await page.bringToFront()
        const focus = this.options.config.focus
        if (focus?.enabled !== false && focus?.webWindow !== false) {
          await setBrowserWindowTopmost({ profileDir: this.profileDir, topmost: true }).catch(() => {})
        }
        await editor.focus()
        await this.markPageStatus(page, request.purpose ? `[dsh 内部辅助：${request.purpose} 等待点击发送]` : '[dsh 等待你在网页点击发送]')
        console.info('[deepseek-web] 消息已填入 Edge 并置顶聚焦，请回车或点击“发送”…')
      }

      const winner = await Promise.race([waiter, rateLimited, aborted])
      // 作废 waiter 的 undefined 不会先于 race 落定；防御性兜底按频控处理
      if (winner === undefined) return { kind: 'rate-limited' }
      if ('kind' in winner) return winner
      if (winner.status === 429 || looksLikeRateLimitText(winner.body.slice(0, 2_000))) {
        console.warn(`[deepseek-web] 响应判定为频控（HTTP ${winner.status}）。`)
        return { kind: 'rate-limited' }
      }
      console.info('[deepseek-web] 已收到网页完整回复，正在解析…')
      return { kind: 'completed', completion: winner }
    } catch (error) {
      if (request.signal?.aborted) throw new LlmError('网页回合已取消。', 'WEB_TURN_ABORTED')
      if (error instanceof LlmError) throw error
      if (page.isClosed()) {
        throw new LlmError('deepseek-web: 浏览器页面被关闭', 'WEB_PAGE_CLOSED')
      }
      // 超时兜底：toast 可能出现在两次轮询之间又已消失，最后确认一次
      if (await hasRateLimitToast(page)) return { kind: 'rate-limited' }
      throw new LlmError(
        autoSend
          ? 'deepseek-web: 全自动发送后未收到网页响应。可能回车未触发发送（输入框为空或页面结构变化），请人工检查网页后重试。'
          : 'deepseek-web: 已把消息填入浏览器，等待你点击“发送”超时。请确认输入框内容后点击页面上的发送按钮重试。',
        autoSend ? 'WEB_AUTO_SEND_TIMEOUT' : 'WEB_MANUAL_SEND_TIMEOUT',
      )
    } finally {
      waiterActive = false
      clearInterval(toastTimer)
      if (progressTimer) clearInterval(progressTimer)
      if (abortListener) request.signal?.removeEventListener('abort', abortListener)
      await this.markPageStatus(page, undefined).catch(() => {})
    }
  }

  /** 可中断的等待（AbortSignal 触发时抛 WEB_TURN_ABORTED）。 */
  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const step = 200
    for (let waited = 0; waited < ms; waited += step) {
      if (signal?.aborted) {
        throw new LlmError('deepseek-web: 等待频控重发期间回合被取消。', 'WEB_TURN_ABORTED')
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(step, ms - waited)))
    }
  }

  /** 在 [min, max] 区间内取一个随机毫秒数；任何一端非法就按另一端处理。 */
  private pickPause(min: number, max: number): number {
    const lo = Math.max(0, Math.min(min, max))
    const hi = Math.max(0, Math.max(min, max))
    return lo + Math.random() * (hi - lo)
  }

  /**
   * 连续请求过多时强制长休：真人不会连着几十轮零休息地发消息。
   * 计数按"账号/通道实例"累积，10 分钟内没有新请求即视为断开、重新从 0 数。
   */
  private async maybeTakeLongRunPause(page: Page, signal?: AbortSignal): Promise<void> {
    const { longRunAfterSends, longRunPauseMinMs, longRunPauseMaxMs } = this.options.config
    if (!longRunAfterSends || longRunAfterSends <= 0) return
    const now = Date.now()
    if (now - this.lastSendAt > 10 * 60_000) this.consecutiveSends = 0
    this.consecutiveSends += 1
    this.lastSendAt = now
    if (this.consecutiveSends <= longRunAfterSends) return
    const pause = this.pickPause(longRunPauseMinMs, longRunPauseMaxMs)
    this.consecutiveSends = 0
    if (pause < 1) return
    console.info(
      `[deepseek-web] 连续 ${longRunAfterSends} 轮请求，按防风控策略静默 ${(pause / 1000).toFixed(1)}s…`,
    )
    await this.markPageStatus(page, `[dsh 防风控静默 ${(pause / 1000).toFixed(0)}s]`).catch(() => {})
    await this.sleep(pause, signal)
  }

  /**
   * 注入页面网络镜像（fetch + XHR）：把匹配 chat/completion 的 POST 响应体
   * 累积到 window.__dshWebCapture，供实时思考流轮询。幂等，页面导航后重装。
   */
  private async ensureCapture(page: Page): Promise<void> {
    await page.evaluate(() => {
      const w = window as typeof window & {
        __dshWebCapture?: { entries: Array<{ at: number; body: string; done: boolean }> }
      }
      if (w.__dshWebCapture) {
        w.__dshWebCapture.entries = w.__dshWebCapture.entries.slice(-20)
        return
      }
      const state: { entries: Array<{ at: number; body: string; done: boolean }> } = { entries: [] }
      w.__dshWebCapture = state
      const matches = (url: string, method?: string): boolean => {
        if (method !== undefined && method.toUpperCase() !== 'POST') return false
        return /\/chat\/completion/i.test(url)
      }
      const keep = (entry: { at: number; body: string; done: boolean }): void => {
        state.entries.push(entry)
        if (state.entries.length > 20) state.entries.splice(0, state.entries.length - 20)
      }
      const originalFetch = w.fetch.bind(w)
      w.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? ''
        const method = init?.method ?? (input instanceof Request ? input.method : undefined)
        if (!matches(String(url), method)) return originalFetch(input, init)
        const entry = { at: Date.now(), body: '', done: false }
        keep(entry)
        try {
          const response = await originalFetch(input, init)
          // 增量读取克隆流：正文随 SSE 逐块累积，页面侧照常消费原始流
          const reader = response.clone().body?.getReader()
          if (reader) {
            const decoder = new TextDecoder()
            void (async () => {
              for (;;) {
                const { done, value } = await reader.read()
                if (value) entry.body += decoder.decode(value, { stream: true })
                if (done) break
              }
              entry.done = true
            })().catch(() => { entry.done = true })
          } else {
            entry.done = true
          }
          return response
        } catch (error) {
          entry.done = true
          throw error
        }
      }
      const originalOpen = XMLHttpRequest.prototype.open
      const originalSend = XMLHttpRequest.prototype.send
      XMLHttpRequest.prototype.open = function (
        this: XMLHttpRequest & { __dshUrl?: string; __dshMethod?: string },
        method: string,
        url: string | URL,
        ...rest: unknown[]
      ) {
        this.__dshUrl = String(url)
        this.__dshMethod = String(method)
        return originalOpen.apply(this, [method, url, ...rest] as Parameters<typeof originalOpen>)
      } as typeof XMLHttpRequest.prototype.open
      XMLHttpRequest.prototype.send = function (
        this: XMLHttpRequest & { __dshUrl?: string; __dshMethod?: string },
        ...args: unknown[]
      ) {
        if (matches(this.__dshUrl ?? '', this.__dshMethod)) {
          const entry = { at: Date.now(), body: '', done: false }
          keep(entry)
          this.addEventListener('progress', () => {
            try { entry.body = this.responseText ?? '' } catch { /* responseText 不可读时忽略 */ }
          })
          this.addEventListener('loadend', () => { entry.done = true })
        }
        return originalSend.apply(this, args as Parameters<typeof originalSend>)
      } as typeof XMLHttpRequest.prototype.send
    }).catch(error => {
      console.warn('[deepseek-web] 实时思考流镜像注入失败（不影响最终回复）：', error instanceof Error ? error.message : error)
    })
  }

  /** 启动实时增量轮询；返回要清理的 timer（仅当 liveThinking 开启）。 */
  private async startProgressPolling(
    page: Page,
    request: BrowserTurnRequest,
  ): Promise<NodeJS.Timeout | undefined> {
    if (this.options.config.liveThinking !== true) return undefined
    await this.ensureCapture(page)
    const startedAt = Date.now() - 1_000
    const onProgress = request.onProgress
    let emittedText = ''
    let emittedReasoning = ''
    return setInterval(() => {
      void page.evaluate((since) => {
        const state = (window as typeof window & {
          __dshWebCapture?: { entries: Array<{ at: number; body: string; done: boolean }> }
        }).__dshWebCapture
        if (!state) return undefined
        const candidates = state.entries.filter(entry => entry.at >= since && entry.body.length > 0)
        const latest = candidates.at(-1)
        return latest === undefined ? undefined : { body: latest.body, done: latest.done }
      }, startedAt).then((captured) => {
        if (captured === undefined) return
        const parsed = parseCompletionBody(captured.body)
        // 门禁 1：镜像可能捕获到非对话流（状态/心跳通道）。结构化解析一无所获时
        // parseCompletionBody 会把原始响应体当 text 兜底返回——绝不能把它灌进思考流
        //（2026-09-25 事故：46KB 原始 SSE 被持久化进 reasoning 块，污染会话日志）。
        if (parsed.reliable !== true) return
        // 累计重建应当单调增长；一旦回缩（协议变化）就只对齐基线，不发负增量
        if (parsed.text.length < emittedText.length) emittedText = parsed.text
        const reasoning = parsed.reasoning ?? ''
        if (reasoning.length < emittedReasoning.length) emittedReasoning = reasoning
        const textDelta = parsed.text.length > emittedText.length ? parsed.text.slice(emittedText.length) : ''
        const reasoningDelta = reasoning.length > emittedReasoning.length ? reasoning.slice(emittedReasoning.length) : ''
        emittedText = parsed.text
        emittedReasoning = reasoning
        if (textDelta === '' && reasoningDelta === '') return
        // 门禁 2：增量里出现 SSE 原始帧特征一律丢弃（防御性，正常解析不会出现）
        if (POLLUTION_PATTERN.test(textDelta) || POLLUTION_PATTERN.test(reasoningDelta)) {
          console.warn('[deepseek-web] 实时增量里检测到原始流特征，已丢弃本批增量。')
          return
        }
        // 门禁 3：单条增量异常巨大视为不可信
        if (textDelta.length > 8_000 || reasoningDelta.length > 8_000) {
          console.warn('[deepseek-web] 实时增量异常巨大，已丢弃本批增量。')
          return
        }
        try {
          onProgress?.({ text: textDelta, reasoning: reasoningDelta })
        } catch (error) {
          console.warn('[deepseek-web] 实时思考流回调异常（已忽略）：', error instanceof Error ? error.message : error)
        }
      }).catch(() => {})
    }, POLL_INTERVAL_MS)
  }

  /** 填入消息 / 首次请求：把网页窗口提到最前（受 config.focus 开关控制）。 */
  async focusBrowser(): Promise<void> {
    const focus = this.options.config.focus
    if (focus?.enabled === false || focus?.webWindow === false) return
    if (!this.page || this.page.isClosed()) return
    await this.page.bringToFront().catch(() => {})
  }

  /** 回合（含审核）结束、正文交给 Harness：把 dsh 宿主窗口提到最前。 */
  async focusHarness(): Promise<void> {
    const focus = this.options.config.focus
    if (focus?.enabled === false || focus?.dshWindow === false) return
    await focusDshWindow({
      processNames: focus?.dshProcessNames,
      titlePattern: focus?.dshTitlePattern,
    }).catch(() => {})
  }

  private readonly autoSendSessions = new Map<string, boolean>()

  /** 记录会话的发送方式：全自动会话的后续轮次与自审轮次都自动发送。 */
  setSessionAutoSend(sessionId: string, auto: boolean): void {
    this.autoSendSessions.set(sessionId, auto)
  }

  /**
   * 记录"当前 agent 会话"。
   * 同对话自审（preserveConversation）用它定位要写入的网页页：
   * 多会话并行时，"最近用过的页"可能是子代理的页，审稿内容就会串进子代理的对话。
   */
  setConversationFocus(sessionId: string): void {
    this.focusSessionId = sessionId
  }

  /** 置顶/取消置顶插件专用的 Edge 窗口（按 profile 目录定位）。 */
  async setWebWindowTopmost(_sessionId: string, topmost: boolean): Promise<void> {
    const focus = this.options.config.focus
    if (focus?.enabled === false || focus?.webWindow === false) return
    await setBrowserWindowTopmost({ profileDir: this.profileDir, topmost }).catch(() => {})
  }

  async status(): Promise<{ ready: boolean; url?: string; message?: string }> {
    if (!this.browser || !this.context) {
      return { ready: false, message: '浏览器尚未启动' }
    }
    const anchor = this.page && !this.page.isClosed()
      ? this.page
      : this.mostRecentState()?.page
    const modelLabel = WEB_MODEL_CAPABILITIES[this.options.config.model as WebModelId]?.label
    const tabs = this.sessionPages.size
    return {
      ready: anchor !== undefined && !anchor.isClosed(),
      ...anchor ? { url: anchor.url() } : {},
      message: `浏览器已连接${modelLabel ? `，目标模型：${modelLabel}` : ''}`
        + `${tabs > 0 ? `，并行会话页 ${tabs}/${this.options.config.maxSessionPages}` : ''}`,
    }
  }

  async dispose(): Promise<void> {
    if (this.options.config.browser === 'attach') {
      this.sessionPages.clear()
      this.creatingPages.clear()
      this.pendingPages.clear()
      this.page = undefined
      return
    }
    await Promise.all([...this.sessionPages.values()].map(state => state.page.close().catch(() => {})))
    this.sessionPages.clear()
    this.creatingPages.clear()
    this.pendingPages.clear()
    const managed = this.managedConnection
    this.managedConnection = undefined
    await managed?.browser.close().catch(() => {})
    // browser.close() normally terminates the real browser. The launcher handle
    // is kept as a fallback for startup failures or browsers that ignore CDP close.
    if (managed?.process && !managed.process.killed) managed.process.kill()
    this.browser = undefined
    this.context = undefined
    this.page = undefined
    this.focusSessionId = undefined
  }
}
