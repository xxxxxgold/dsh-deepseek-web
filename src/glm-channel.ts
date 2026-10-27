/**
 * GLM 网页版浏览器通道：同时服务「GLM 主通道」与「GLM 审核通道」。
 *
 * 两个站点（chatglm.cn / chat.z.ai）共用一套发送流程，差异集中在：
 * - 模型/思考强度选择（`glm-sites.ts`）；
 * - 回复流地址与解析（chatglm 的 `assistant/stream` 快照 vs z.ai 的 `chat/completions` 增量）。
 *
 * 签名（X-Signature / X-FE-Version）由页面自身在发请求时生成，
 * 本通道只负责把消息填入输入框、等待响应、解析正文，不自行构造 HTTP 请求。
 *
 * @module dsh-deepseek-web/glm-channel
 */

import type { Browser, BrowserContext, Page } from 'playwright-core'
import path from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  connectBrowser,
  defaultProfileDir,
  locateEditor,
  focusDshWindow,
  looksLoginWall,
  markPageTitle,
  sendEditorMessage,
  type TitleMarkerState,
  withTimeout,
} from './browser-shared.ts'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from './browser-channel.ts'
import type { ReviewConfig } from './config.ts'
import type { LoginProbeResult } from './login-probe.ts'
import {
  formatNotice,
  noticeEnabled,
  type NoticeCategory,
  type NotifyConfig,
  type NoticeEvent,
} from './notify.ts'
import { detectGlmSite, ensureGlmSelection, type GlmSite } from './glm-sites.ts'
import { GLM_WEB_MODEL_IDS, normalizeGlmEffort, type GlmWebModelId } from './web-models.ts'

export interface GlmChannelOptions {
  config: ReviewConfig
  /** 主配置的窗口聚焦策略；GLM 通道用于审核结束后把 dsh 窗口提到最前。 */
  focus?: {
    enabled: boolean
    webWindow: boolean
    dshWindow: boolean
    dshProcessNames: string[]
    dshTitlePattern: string
  }
  /** 覆盖入口地址（主通道用 glmWeb.url，审核通道用 review.glmUrl）。 */
  url?: string
  /** 覆盖 CDP 端口。 */
  debugPort?: number
  profileDir?: string
  label?: string
  /** 同时保留的标签页上限；超出时回收最久未使用的会话页。 */
  maxPages?: number
  /**
   * 发送确认后等待网页响应头的上限。
   * 审核默认 120 秒；主通道可放宽（GLM 极致档位在长任务里可能很久才吐首个事件）。
   */
  ackTimeoutMs?: number
  /** 过程提示开关（与 DeepSeek 通道共用同一份 notify 配置）。 */
  notify?: NotifyConfig
}

/** GLM 对话接口（z.ai，SSE，`text/event-stream`）。 */
export function matchesGlmCompletion(url: string): boolean {
  return /chat\/completions/i.test(url)
}

/** chatglm.cn 的回复流地址。 */
export function matchesChatglmStream(url: string): boolean {
  return /\/backend-api\/assistant\/stream/i.test(url)
}

/**
 * 发送之后等“网页响应流”的上限。
 *
 * 这个值只管**发送确认完成之后**那一段：审核页正常 1~3 秒就回响应头，卡住时不该让回合白等
 * 10 分钟（`review.streamIdleTimeoutMs` 默认 600 秒）。填字与发送确认的耗时不计入这里。
 */
export const ACK_TIMEOUT_MS = 120_000

/**
 * 解析 GLM（chat.z.ai）SSE 流。
 *
 * 事件形态（2026-09 真实样本，`calibration/glm-chat-*.bin`）：
 * - `{"phase":"thinking","delta_content":"…"}` 思考过程 —— **不是正文**，单独归到 reasoning
 * - `{"phase":"answer","delta_content":"…"}` 增量正文
 * - `{"phase":"other","usage":{…}}` 用量统计等非正文事件
 * - `{"phase":"done","done":true}` 结束
 * - `data: [DONE]` 流结束哨兵
 *
 * 注意：thinking 与 answer 用的是同一个 `delta_content` 字段，只有 `phase` 能区分。
 */
export function parseGlmCompletion(input: Buffer | string): { text: string; reasoning?: string } {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  const raw = buffer.toString('utf8')
  let text = ''
  let reasoning = ''
  let sawAny = false
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let event: {
      type?: string
      data?: { delta_content?: string; delta_reasoning?: string; phase?: string }
    }
    try {
      event = JSON.parse(payload)
    } catch {
      continue
    }
    sawAny = true
    if (event.type === 'chat:completion') {
      const phase = typeof event.data?.phase === 'string' ? event.data.phase : ''
      const content = typeof event.data?.delta_content === 'string' ? event.data.delta_content : ''
      const deltaReasoning = typeof event.data?.delta_reasoning === 'string' ? event.data.delta_reasoning : ''
      if (deltaReasoning) reasoning += deltaReasoning
      if (content) {
        // phase=thinking 走 reasoning；phase=answer 才是正文；
        // 没有 phase 字段的历史样本按正文处理，保持兼容。
        if (phase === 'thinking') reasoning += content
        else if (phase === 'answer' || phase === '') text += content
      }
    }
  }
  if (!text && !reasoning && sawAny) {
    return { text: '' }
  }
  if (!text && !reasoning) {
    // 落盘原始样本，便于继续校准
    const dir = defaultProfileDir('calibration')
    const file = path.join(dir, `glm-unparsed-${Date.now()}.bin`)
    void import('node:fs/promises')
      .then(fs => fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(file, buffer)))
      .catch(() => {})
    throw new LlmError('glm: SSE 流里没有解析出正文', 'GLM_EMPTY_RESPONSE')
  }
  return { text, ...reasoning ? { reasoning } : {} }
}

/**
 * 解析 chatglm.cn 的 `assistant/stream` 流。
 *
 * 与 z.ai 的增量协议不同：每个 `data:` 事件是**消息快照**，正文在
 * `parts[].content[]` 里，`type=text` 的 `text` 是当前全文（会重复出现），
 * `type=think` 的 `think` 是思考增量片段。`type=tool_calls` 是站点内部工具
 * （样本里出现过 `finish`），不作为正文。
 */
export function parseGlmChatglmStream(input: Buffer | string): { text: string; reasoning?: string } {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  const raw = buffer.toString('utf8')
  let text = ''
  let reasoning = ''
  let sawAny = false
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let event: { parts?: Array<{ content?: Array<{ type?: string; text?: string; think?: string }> }> }
    try {
      event = JSON.parse(payload)
    } catch {
      continue
    }
    sawAny = true
    for (const part of event.parts ?? []) {
      for (const content of part.content ?? []) {
        if (content.type === 'think' && typeof content.think === 'string') {
          reasoning += content.think
        } else if (content.type === 'text' && typeof content.text === 'string') {
          const next = content.text
          if (!text || next.startsWith(text)) text = next
          else if (!text.endsWith(next)) text += next
        }
      }
    }
  }
  if (!text && !reasoning && sawAny) return { text: '' }
  if (!text && !reasoning) {
    const dir = defaultProfileDir('calibration')
    const file = path.join(dir, `glm-chatglm-unparsed-${Date.now()}.bin`)
    void import('node:fs/promises')
      .then(fs => fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(file, buffer)))
      .catch(() => {})
    throw new LlmError('glm: chatglm 流里没有解析出正文', 'GLM_EMPTY_RESPONSE')
  }
  return { text, ...reasoning ? { reasoning } : {} }
}

/** 把通道收到的 model 字符串收敛成 GLM 模型 id；不认识时返回 undefined。 */
export function toGlmModel(model: string): GlmWebModelId | undefined {
  return (GLM_WEB_MODEL_IDS as readonly string[]).includes(model) ? model as GlmWebModelId : undefined
}

export class GLMChannel implements BrowserChannel {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private readonly pages = new Map<string, Page>()
  private readonly started = new Set<string>()
  private readonly touched = new Map<string, number>()
  /** 被取消/失败的会话：下次请求必须先开新对话，但复用同一标签页而不是再开一个。 */
  private readonly needsFresh = new Set<string>()
  /** 每个会话当前回合的取消句柄；cancelTurn 用它中止等待并关掉页面。 */
  private readonly controllers = new Map<string, AbortController>()
  /** 提示节流：同会话同事件 500ms 内只发一条，避免刷屏。 */
  private readonly lastNoticeAt = new Map<string, number>()
  private readonly titleState: TitleMarkerState = {}
  private readonly options: GlmChannelOptions
  private readonly entryUrl: string
  private readonly debugPort: number
  private readonly profileDir: string
  private readonly label: string
  private readonly site: GlmSite
  private readonly maxPages: number
  private readonly ackTimeoutMs: number

  constructor(options: GlmChannelOptions) {
    this.options = options
    this.entryUrl = options.url ?? options.config.glmUrl
    this.debugPort = options.debugPort ?? options.config.glmDebugPort
    this.profileDir = options.profileDir ?? options.config.glmProfileDir ?? defaultProfileDir('glm-profile')
    this.label = options.label ?? 'glm'
    this.site = detectGlmSite(this.entryUrl)
    this.maxPages = Math.max(1, options.maxPages ?? 3)
    this.ackTimeoutMs = Math.max(10_000, options.ackTimeoutMs ?? ACK_TIMEOUT_MS)
  }

  async ensureReady(): Promise<void> {
    if (this.browser && this.context) return
    const { browser, context } = await connectBrowser({
      port: this.debugPort,
      profileDir: this.profileDir,
      url: this.entryUrl,
      autoStartKeeper: true,
      label: this.label,
    })
    this.browser = browser
    this.context = context
  }

  /**
   * 找一个浏览器里已存在、但还没分配给任何会话的同源页。
   * 启动自带的首页、用户点「打开浏览器去登录」留下的页都能被下一次会话复用，
   * 避免每开一个会话就多一个 GLM 标签。
   */
  private reuseCandidate(): Page | undefined {
    if (!this.context) return undefined
    let origin = ''
    try {
      origin = new URL(this.entryUrl).origin
    } catch {
      return undefined
    }
    const assigned = new Set(this.pages.values())
    return this.context.pages().find((page) => {
      if (page.isClosed() || assigned.has(page)) return false
      try {
        return new URL(page.url()).origin === origin
      } catch {
        return false
      }
    })
  }

  /** 取该 dsh 会话的标签页；没有就新建并打开入口（入口页即新对话）。 */
  private async pageFor(sessionId: string): Promise<Page> {
    await this.ensureReady()
    const existing = this.pages.get(sessionId)
    if (existing && !existing.isClosed()) {
      this.touch(sessionId)
      return existing
    }
    // 复用浏览器启动时自带、还没分配给任何会话的同源标签页，避免首轮凭空多一个空标签。
    const reusable = this.reuseCandidate()
    const page = reusable ?? await this.context!.newPage()
    try {
      await page.goto(this.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(1_500)
    } catch (error) {
      await page.close().catch(() => {})
      throw new LlmError(
        `glm: 打开 ${this.entryUrl} 失败：${error instanceof Error ? error.message : String(error)}`,
        'GLM_PAGE_OPEN_FAILED',
        { cause: error },
      )
    }
    this.pages.set(sessionId, page)
    this.touch(sessionId)
    await this.evictIfNeeded(sessionId)
    return page
  }

  private touch(sessionId: string): void {
    this.touched.set(sessionId, Date.now())
  }

  private async evictIfNeeded(keep: string): Promise<void> {
    while (this.pages.size > this.maxPages) {
      let oldest: string | undefined
      let stamp = Number.POSITIVE_INFINITY
      for (const [sessionId, value] of this.touched) {
        if (sessionId === keep || !this.pages.has(sessionId)) continue
        // 正在跑的回合不能回收：关页会直接中断它，还可能让下一次请求串台。
        if (this.controllers.has(sessionId)) continue
        if (value < stamp) {
          oldest = sessionId
          stamp = value
        }
      }
      if (oldest === undefined) return
      const page = this.pages.get(oldest)
      this.pages.delete(oldest)
      this.started.delete(oldest)
      this.touched.delete(oldest)
      await page?.close().catch(() => {})
    }
  }

  private lastPage(): Page | undefined {
    let latest: Page | undefined
    let stamp = -1
    for (const [sessionId, page] of this.pages) {
      const value = this.touched.get(sessionId) ?? 0
      if (value > stamp && !page.isClosed()) {
        latest = page
        stamp = value
      }
    }
    return latest ?? this.context?.pages().find(page => !page.isClosed())
  }

  /** 在指定会话的页面上开新对话（两站首页即新对话）。 */
  async startNewConversation(sessionId?: string): Promise<void> {
    if (sessionId === undefined) {
      for (const key of [...this.pages.keys()]) {
        const page = this.pages.get(key)
        if (!page || page.isClosed()) continue
        await page.goto(this.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
        await page.waitForTimeout(1_000)
        this.started.add(key)
        this.needsFresh.delete(key)
      }
      return
    }
    const page = await this.pageFor(sessionId)
    await page.goto(this.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1_000)
    this.started.add(sessionId)
    this.needsFresh.delete(sessionId)
  }

  private async newConversation(page: Page): Promise<void> {
    await page.goto(this.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1_200)
  }

  resetConversationGate(sessionId?: string): void {
    if (sessionId === undefined) {
      this.started.clear()
      this.needsFresh.clear()
    } else {
      this.started.delete(sessionId)
      this.needsFresh.delete(sessionId)
    }
  }

  /**
   * 内部辅助请求（上下文压缩、起标题）：固定用一个隔离标签页，每次从新对话开始。
   * 不复用正常会话页，避免压缩摘要污染用户对话。
   */
  async turnIsolated(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    // 唯一 session id：并发 compaction/title（maxConcurrentTurns>1）不能共享同一页，
    // 否则两个辅助请求会互相覆盖输入框与响应监听。
    const isolated = `glm-isolated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      return await this.turn({ ...request, sessionId: isolated, initialize: true })
    } finally {
      await this.cancelTurn(isolated)
      // 辅助请求页用完即关：cancelTurn 为了正常会话复用标签只做标记，这里必须真正关闭，
      // 否则标题/压缩每次都会留下一个空标签。
      const page = this.pages.get(isolated)
      this.pages.delete(isolated)
      this.started.delete(isolated)
      this.needsFresh.delete(isolated)
      this.touched.delete(isolated)
      await page?.close().catch(() => {})
    }
  }

  isConversationActive(sessionId: string): boolean {
    if (this.needsFresh.has(sessionId)) return false
    const page = this.pages.get(sessionId)
    return page !== undefined && !page.isClosed()
  }

  /**
   * 取消指定会话（不传则全部）当前回合。
   *
   * 只 abort 不够：网页端可能继续生成，下一次同会话请求会在同一页上再挂一个
   * waitForResponse，读到上一轮的响应。因此这里连页面一起关掉，下次请求会新开标签页
   * 并回放宿主上下文（adapter 通过 isConversationActive=false 触发 replay）。
   */
  async cancelTurn(sessionId?: string): Promise<void> {
    // 必须把 controllers 也算进来：取消可能发生在 pageFor 的 newPage/goto 期间，
    // 此时页面还没进 pages，但控制器已经在跑。只遍历 pages 会漏掉这种取消。
    const keys = sessionId === undefined
      ? new Set([...this.pages.keys(), ...this.controllers.keys()])
      : new Set([sessionId])
    for (const key of keys) {
      this.controllers.get(key)?.abort()
      this.controllers.delete(key)
      // 不再关页：重试/宿主取消时反复关页再新开，会让用户看到一串 GLM 标签。
      // 保留标签页，只标记「下次必须开新对话」；真正的旧生成会在下一轮 goto 时被中止。
      if (this.pages.has(key)) this.needsFresh.add(key)
      this.started.delete(key)
    }
  }

  currentChatId(sessionId: string): string | undefined {
    if (this.site !== 'chatglm') return undefined
    const page = this.pages.get(sessionId)
    if (!page || page.isClosed()) return undefined
    try {
      return new URL(page.url()).searchParams.get('cid') ?? undefined
    } catch {
      return undefined
    }
  }

  private async applySelection(page: Page, request: BrowserTurnRequest): Promise<void> {
    const model = toGlmModel(request.model)
    if (!model) return
    await ensureGlmSelection(page, this.site, {
      model,
      effort: normalizeGlmEffort(request.reasoningEffort),
    })
  }

  /**
   * 发一条 `[DSH]` / `[DSH·审核]` 过程提示。
   * 与 DeepSeek 通道同口径：开关看 notify 配置，500ms 内同会话同事件只发一条。
   */
  private emitNotice(request: BrowserTurnRequest, event: NoticeEvent, detail: string): void {
    const onNotice = request.onNotice
    if (onNotice === undefined) return
    const category: NoticeCategory = request.role === 'review' ? 'review' : 'session'
    if (!noticeEnabled(this.options.notify, category, event)) return
    const key = `${request.sessionId}::${category}::${event}`
    const now = Date.now()
    if (now - (this.lastNoticeAt.get(key) ?? 0) < 500) return
    if (this.lastNoticeAt.size > 200) this.lastNoticeAt.clear()
    this.lastNoticeAt.set(key, now)
    const text = formatNotice({ category, event, detail })
    try {
      onNotice({ category, event, text })
    } catch (error) {
      // 提示是旁路：回调自己炸了也不能影响回合本体。
      console.warn('[glm] 提示回调异常（已忽略）：', error instanceof Error ? error.message : String(error))
    }
  }

  /** 失败/取消后主动中止页面里仍在跑的生成，避免网页继续慢慢生成、下一次重试又撞 429。 */
  private async stopPageGeneration(sessionId: string): Promise<void> {
    const page = this.pages.get(sessionId)
    if (!page || page.isClosed()) return
    this.needsFresh.add(sessionId)
    this.started.delete(sessionId)
    await page.goto(this.entryUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
  }

  async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (request.signal?.aborted) controller.abort()
    else request.signal?.addEventListener('abort', onAbort, { once: true })
    this.controllers.set(request.sessionId, controller)
    try {
      return await this.runTurn(request, controller)
    } catch (error) {
      // 失败/取消后网页可能还在生成：立刻导航回入口中止它，否则宿主重试会在生成中再发一条，
      // chatglm 会回 429，用户看到的就是「网页还在生成、插件报频控」。
      await this.stopPageGeneration(request.sessionId).catch(() => {})
      // 取消可能落在 newConversation / applySelection / 填字等 Playwright 操作内部：
      // 原生异常会被适配器包成 WEB_TURN_FAILED，这里统一收敛成 GLM_CANCELLED。
      if (controller.signal.aborted && !(error instanceof LlmError && error.code === 'GLM_CANCELLED')) {
        throw new LlmError('glm: 回合已取消', 'GLM_CANCELLED', { cause: error })
      }
      if (!(error instanceof LlmError && error.code === 'GLM_CANCELLED')) {
        this.emitNotice(request, 'error', error instanceof Error ? error.message : String(error))
      }
      throw error
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
      if (this.controllers.get(request.sessionId) === controller) this.controllers.delete(request.sessionId)
    }
  }

  private async runTurn(request: BrowserTurnRequest, controller: AbortController): Promise<BrowserTurnResult> {
    const ensureActive = (): void => {
      if (controller.signal.aborted) throw new LlmError('glm: 回合已取消', 'GLM_CANCELLED')
    }
    ensureActive()
    const page = await this.pageFor(request.sessionId)
    // pageFor 可能耗时（newPage + goto）；期间被取消时页面已经挂在会话上，
    // 保留标签页并标记「下次开新对话」，不要关页制造标签抖动。
    if (controller.signal.aborted) {
      this.needsFresh.add(request.sessionId)
      throw new LlmError('glm: 回合已取消', 'GLM_CANCELLED')
    }

    const mustFresh = this.needsFresh.has(request.sessionId)
    if (mustFresh || (request.initialize && !this.started.has(request.sessionId))) {
      await this.newConversation(page)
      this.started.add(request.sessionId)
      this.needsFresh.delete(request.sessionId)
    }
    ensureActive()

    await this.applySelection(page, request)
    ensureActive()

    if (await looksLoginWall(page)) {
      throw new LlmError(
        `glm: 浏览器窗口已打开，但尚未登录 ${this.site === 'chatglm' ? 'chatglm.cn' : 'chat.z.ai'}`
        + '（发送按钮处于禁用状态）。请先在 GLM 窗口完成登录后重试。',
        'GLM_LOGIN_REQUIRED',
      )
    }
    ensureActive()

    // 监听必须在填字之前挂上（否则脚本提前发送会漏掉响应），但监听本身**不能带超时**：
    // 长提示词填字可能花掉几十秒到几分钟，真正的等待上限由 startAckClock() 从发送确认后开始计。
    let sawResponse = false
    const completionPromise = page.waitForResponse(
      response => response.request().method() === 'POST'
        && (this.site === 'chatglm' ? matchesChatglmStream(response.url()) : matchesGlmCompletion(response.url())),
      { timeout: 0 },
    ).then(async response => {
      sawResponse = true
      this.emitNotice(request, 'receive', '网页已收到，正在生成回复…')
      await markPageTitle(page, '[dsh GLM 生成中]', this.titleState).catch(() => {})
      const [, body] = await Promise.all([
        withTimeout(response.finished().catch(() => undefined), this.options.config.streamIdleTimeoutMs,
          'GLM_STREAM_STALLED', 'glm: 等待回复流结束超时'),
        withTimeout(response.body().catch(() => Buffer.alloc(0)), this.options.config.streamIdleTimeoutMs,
          'GLM_STREAM_STALLED', 'glm: 读取回复体超时'),
      ])
      return { url: response.url(), status: response.status(), body }
    })
    completionPromise.catch(() => {})

    // 取消信号与等待竞速：宿主放弃生成时立刻结束本回合，不再占着会话页。
    const cancelPromise = new Promise<never>((_, reject) => {
      const onCancel = (): void => reject(new LlmError('glm: 回合已取消', 'GLM_CANCELLED'))
      if (controller.signal.aborted) onCancel()
      else controller.signal.addEventListener('abort', onCancel, { once: true })
    })
    cancelPromise.catch(() => {})

    const ackTimeoutMs = this.ackTimeoutMs
    let ackTimer: ReturnType<typeof setTimeout> | undefined
    let ackDeadline: Promise<never> | undefined
    const startAckClock = (): void => {
      clearTimeout(ackTimer)
      ackDeadline = new Promise<never>((_, reject) => {
        ackTimer = setTimeout(() => {
          reject(new LlmError(
            request.autoSend
              ? `glm: 消息已发送，但 ${Math.round(ackTimeoutMs / 1000)} 秒内没有等到网页的响应流（HTTP 层未捕获到本轮请求）。`
                + '请人工检查网页：对话里若已出现这条消息并开始回答，说明响应被页面拦截或网络中断；'
                + '若输入框里还留着内容，说明回车没触发发送。确认后重试本轮任务。'
              : `glm: 消息已填入输入框，等待你点击“发送”超时（${Math.round(ackTimeoutMs / 1000)} 秒）。`,
            request.autoSend ? 'GLM_AUTO_SEND_TIMEOUT' : 'GLM_MANUAL_SEND_TIMEOUT',
          ))
        }, ackTimeoutMs)
      })
      void ackDeadline.catch(() => {})
    }

    const editor = locateEditor(page)
    if (!(await editor.isVisible().catch(() => false))) {
      throw new LlmError('glm: 未找到对话输入框。请确认浏览器停留在 GLM 对话页。', 'GLM_EDITOR_NOT_FOUND')
    }
    await editor.click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.insertText(request.text)
    // 填字期间也可能被取消：此时消息还在输入框里，绝不能继续回车发送。
    ensureActive()

    if (request.autoSend) {
      await markPageTitle(page, '[dsh 自动发送中]', this.titleState)
      const outcome = await sendEditorMessage(page, editor, {
        verifyTimeoutMs: 3_000,
        maxAttempts: 2,
        pauseMinMs: 0,
        pauseMaxMs: 0,
        hasResponse: () => sawResponse,
        isCancelled: () => controller.signal.aborted,
      })
      if (!outcome.sent) {
        throw new LlmError(
          `glm: 消息已填入输入框，但没能确认发送出去。尝试记录：${outcome.attempts.join('；')}。`
          + '页面可能改版导致回车与发送按钮都失效——请人工检查网页后重试。',
          'GLM_SEND_NOT_TRIGGERED',
        )
      }
      console.info(`[glm] 全自动：已确认发送（方式：${outcome.via}）。`)
      this.emitNotice(request, 'send', `已确认发送 ${request.text.length} 字（${outcome.via === 'enter' ? '回车' : '发送按钮'}）`)
    } else {
      await page.bringToFront()
      this.started.add(request.sessionId)
      await markPageTitle(page, '[dsh 等待你在 GLM 点击发送]', this.titleState)
      console.info('[glm] 消息已填入浏览器，请在 GLM 页面点击“发送”…')
      this.emitNotice(request, 'send', `已填入输入框 ${request.text.length} 字，等待你在网页点击发送`)
    }

    startAckClock()

    let completion: { url: string; status: number; body: Buffer }
    try {
      completion = await Promise.race([completionPromise, ackDeadline!, cancelPromise])
      console.info('[glm] 已收到 GLM 完整回复，正在解析…')
    } catch (error) {
      if (error instanceof LlmError) throw error
      if (controller.signal.aborted) throw new LlmError('glm: 回合已取消', 'GLM_CANCELLED')
      if (page.isClosed()) throw new LlmError('glm: 浏览器页面被关闭', 'GLM_PAGE_CLOSED')
      throw new LlmError(
        request.autoSend
          ? 'glm: 发送流程在确认网页响应之前就中断了（页面被关闭或网络监听失效）。请人工检查网页后重试。'
          : 'glm: 等待你点击“发送”期间流程中断（页面被关闭或网络监听失效）。请确认输入框内容后重试。',
        request.autoSend ? 'GLM_AUTO_SEND_TIMEOUT' : 'GLM_MANUAL_SEND_TIMEOUT',
        { cause: error },
      )
    } finally {
      clearTimeout(ackTimer)
      // 页面可能已被 cancelTurn 关掉；标题重置失败不能覆盖 GLM_CANCELLED 等主错误。
      await markPageTitle(page, undefined, this.titleState).catch(() => {})
    }

    if (completion.status >= 400) {
      const code = completion.status === 401 || completion.status === 403
        ? 'GLM_LOGIN_REQUIRED'
        : completion.status === 429
          ? 'GLM_RATE_LIMITED'
          : `GLM_HTTP_${completion.status}`
      throw new LlmError(
        completion.status === 401 || completion.status === 403
          ? 'glm: 网页拒绝了本轮请求（401/403），通常是登录态失效，请在 GLM 窗口重新登录。'
          : completion.status === 429
            ? 'glm: 网页提示请求过于频繁（429），请稍后再试。'
            : `glm: 网页返回 HTTP ${completion.status}，本轮没有拿到正文。`,
        code,
      )
    }

    const parsed = this.site === 'chatglm'
      ? parseGlmChatglmStream(completion.body)
      : parseGlmCompletion(completion.body)
    if (parsed.text.trim().length === 0) {
      throw new LlmError(
        'glm: 网页回复正文为空（可能被中断、被风控或页面改版），本轮不作为有效交付。',
        'GLM_EMPTY_RESPONSE',
      )
    }
    this.emitNotice(request, 'done', `已收到回复 ${parsed.text.length} 字`)
    return parsed
  }

  /** 当前是否有已打开的 GLM 页面（只读判断，不创建页）。 */
  private activePage(): Page | undefined {
    const page = this.lastPage()
    if (!page || page.isClosed()) return undefined
    try {
      if (new URL(page.url()).origin !== new URL(this.entryUrl).origin) return undefined
    } catch {
      return undefined
    }
    return page
  }

  /** 浏览器当前是否已启动（探活不会主动拉起浏览器）。 */
  isBrowserStarted(): boolean {
    return this.browser?.isConnected() === true && this.context !== undefined
  }

  /**
   * 只读探活：不启动浏览器、不新建标签页。
   *
   * z.ai 游客态发送按钮禁用，按登录墙判 expired；chatglm.cn 游客可以正常发送，
   * 只有在存在「登录」入口且没有头像时把 detail 标成游客态，状态仍算可用。
   */
  async probeLogin(): Promise<LoginProbeResult> {
    const checkedAt = Date.now()
    if (!this.browser || !this.context) {
      return { status: 'unknown', detail: '浏览器还没启动，无法探活（探活不会主动拉起浏览器）', checkedAt }
    }
    if (!this.browser.isConnected()) {
      return { status: 'expired', detail: '浏览器连接已断开', checkedAt }
    }
    const page = this.activePage()
    if (!page) {
      return { status: 'unknown', detail: 'GLM 窗口还没打开，点「打开浏览器去登录」后再检测', checkedAt }
    }
    if (this.site === 'zai') {
      const wall = await looksLoginWall(page).catch(() => false)
      return wall
        ? { status: 'expired', detail: 'z.ai 发送按钮不可用，通常表示未登录', checkedAt }
        : { status: 'ok', checkedAt }
    }
    const guest = await page.evaluate(() => {
      const loginEntry = Array.from(document.querySelectorAll('button, a, div, span'))
        .some(element => /^登录$/.test((element.textContent ?? '').trim()))
      const hasAvatar = document.querySelector('[class*="avatar" i], img[class*="user" i]') !== null
      return loginEntry && !hasAvatar
    }).catch(() => false)
    return guest
      ? { status: 'ok', detail: '游客态：可以发送，登录后可保存历史并提升额度', checkedAt }
      : { status: 'ok', checkedAt }
  }

  /**
   * 打开/复用 GLM 窗口并置前，让用户完成登录。
   * 不抛登录错误——这里的目标就是让用户去登录。
   */
  async openLoginWindow(): Promise<{ opened: boolean; loggedIn: boolean; detail?: string }> {
    await this.ensureReady()
    // 不把登录页注册成某个会话的页：用「未分配的复用页」，下一次真正聊天会直接接管它，
    // 而不是再开一个新标签。登录流程自己弹出的第三方页（如微信扫码）不归插件管。
    let page = this.activePage() ?? this.reuseCandidate()
    if (!page) {
      page = await this.context!.newPage()
      await page.goto(this.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(1_500)
    }
    await page.bringToFront().catch(() => {})
    const probe = await this.probeLogin()
    return {
      opened: true,
      loggedIn: probe.status === 'ok' && probe.detail === undefined,
      ...probe.detail === undefined ? {} : { detail: probe.detail },
    }
  }

  /** 填入消息：把 GLM 窗口提到最前（受注入的 focus 开关控制）。 */
  async focusBrowser(): Promise<void> {
    const focus = this.options.focus
    if (focus && (focus.enabled === false || focus.webWindow === false)) return
    const page = this.lastPage()
    if (!page || page.isClosed()) return
    await page.bringToFront().catch(() => {})
  }

  /**
   * 仅用于满足 BrowserChannel 接口的一致性占位：
   * 实际“审核完全结束后聚焦 dsh 窗口”由主通道 adapter 在最终正文交付前统一触发。
   */
  async focusHarness(): Promise<void> {
    const focus = this.options.focus
    if (!focus || focus.enabled === false || focus.dshWindow === false) return
    await focusDshWindow({
      processNames: focus.dshProcessNames,
      titlePattern: focus.dshTitlePattern,
    }).catch(() => {})
  }

  async status(): Promise<{ ready: boolean; url?: string; message?: string }> {
    if (!this.browser || !this.context) return { ready: false, message: 'GLM 浏览器尚未启动' }
    const page = this.lastPage()
    return {
      ready: page !== undefined && !page.isClosed(),
      ...page ? { url: page.url() } : {},
      message: `GLM 通道已连接（${this.site === 'chatglm' ? 'chatglm.cn' : 'chat.z.ai'}）`,
    }
  }

  async dispose(): Promise<void> {
    // 浏览器由常驻守护拥有，这里只关闭本通道创建的标签页并释放引用。
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    const pages = [...this.pages.values()]
    this.pages.clear()
    this.started.clear()
    this.touched.clear()
    this.needsFresh.clear()
    this.browser = undefined
    this.context = undefined
    await Promise.all(pages.map(page => page.close().catch(() => {})))
  }
}
