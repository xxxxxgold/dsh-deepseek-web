/**
 * Kimi 网页版浏览器通道：结构与 DeepSeek 通道一致（常驻 Edge + 自动/人工发送），
 * 差异在响应协议（Connect-RPC / op / mask），需要抓包校准后实现解析。
 *
 * 发送方式由 `review.autoSend` 决定：`true`（全自动，默认）填入后自动发送并**确认**
 * 真的发出去了；`false`（半自动）则停在填入状态等人工点发送。
 * 对话模式由 `review.conversationMode` 决定：`fresh`（默认）每次审核新开对话。
 *
 * @module dsh-deepseek-web/kimi-channel
 */

import type { Browser, BrowserContext, Page } from 'playwright-core'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  bestEffortNewChat,
  connectBrowser,
  defaultProfileDir,
  ensureChatPage,
  ensureFreshChatUrl,
  locateEditor,
  focusDshWindow,
  looksLoginWall,
  looksSendBlocked,
  markPageTitle,
  sendEditorMessage,
  withTimeout,
  type TitleMarkerState,
} from './browser-shared.ts'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from './browser-channel.ts'
import type { ReviewConfig } from './config.ts'

export interface KimiChannelOptions {
  config: ReviewConfig
  /** 主配置的窗口聚焦策略；Kimi 通道用于审核结束后把 dsh 窗口提到最前。 */
  focus?: {
    enabled: boolean
    webWindow: boolean
    dshWindow: boolean
    dshProcessNames: string[]
    dshTitlePattern: string
  }
  profileDir?: string
  label?: string
}

/** Kimi 对话接口（Connect-RPC，`application/connect+json`）。 */
function matchesKimiCompletion(url: string): boolean {
  return /ChatService\/Chat/i.test(url)
}

/**
 * 发送确认之后等“网页响应流”的上限。
 *
 * 只管**发送确认完成之后**那一段：正常 1~3 秒就回响应头，卡住时不该让回合白等
 * `streamIdleTimeoutMs`（默认 600 秒）。填字与发送确认的耗时不计入这里——早期实现把这个
 * 窗口挂在填字之前，长审核提示词必然超时，Kimi 答了插件却报“等待回复超时”。
 */
export const KIMI_ACK_TIMEOUT_MS = 120_000

/**
 * 解析 Kimi Connect-RPC 流：5 字节帧头（1 字节 flags + 4 字节大端长度）+ JSON 载荷。
 *
 * 事件形态（实测样本）：
 * - `{"op":"set","mask":"block.text","block":{"id","text":{"content"}}}` 建立正文块
 * - `{"op":"append","mask":"block.text.content","block":{"id","text":{"content"}}}` 追加正文
 * - `block.think` / `block.think.content` 同理，属于思考内容
 * - `{"op":"set","mask":"message.status","message":{"status":"MESSAGE_STATUS_COMPLETED"}}` 结束
 * - flags=2 的帧是 Connect 的 end-of-stream 哨兵
 */
export function parseKimiCompletion(input: Buffer | string): { text: string; reasoning?: string } {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'binary')
  const textBlocks = new Map<string, string>()
  const thinkBlocks = new Map<string, string>()
  const textOrder: string[] = []
  const thinkOrder: string[] = []

  const upsert = (
    store: Map<string, string>,
    order: string[],
    id: string,
    content: string,
    append: boolean,
  ): void => {
    if (!store.has(id)) order.push(id)
    store.set(id, append ? `${store.get(id) ?? ''}${content}` : content)
  }

  let offset = 0
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset]!
    const length = buffer.readUInt32BE(offset + 1)
    if (offset + 5 + length > buffer.length) break
    let payload = buffer.subarray(offset + 5, offset + 5 + length)
    offset += 5 + length
    if ((flags & 0b10) !== 0) break
    if ((flags & 0b01) !== 0) {
      // Connect 压缩帧：payload 为 gzip 压缩的 JSON；解不出来就保持原样。
      try {
        payload = gunzipSync(payload)
      } catch {
        // 保持原样，交给 JSON 解析失败路径处理
      }
    }

    let event: {
      op?: string
      mask?: string
      message?: { role?: string; status?: string; blocks?: unknown[] }
      block?: {
        id?: string
        text?: { content?: string }
        think?: { content?: string }
      }
    }
    try {
      event = JSON.parse(payload.toString('utf8'))
    } catch {
      continue
    }

    const append = event.op === 'append'
    const mask = event.mask ?? ''
    const blockId = event.block?.id ?? mask
    if (mask.startsWith('block.text')) {
      const content = event.block?.text?.content
      if (typeof content === 'string') upsert(textBlocks, textOrder, blockId, content, append)
    } else if (mask.startsWith('block.think')) {
      const content = event.block?.think?.content
      if (typeof content === 'string') upsert(thinkBlocks, thinkOrder, blockId, content, append)
    } else if (
      mask === 'message'
      && event.message?.role === 'assistant'
      && Array.isArray(event.message.blocks)
    ) {
      for (const raw of event.message.blocks) {
        const block = raw as {
          id?: string
          text?: { content?: string }
          think?: { content?: string }
        }
        const id = block.id ?? `${textOrder.length}`
        if (typeof block.text?.content === 'string') upsert(textBlocks, textOrder, id, block.text.content, false)
        if (typeof block.think?.content === 'string') upsert(thinkBlocks, thinkOrder, id, block.think.content, false)
      }
    }
  }

  const collect = (store: Map<string, string>, order: string[]): string =>
    order.map(id => store.get(id) ?? '').join('').trim()

  const text = collect(textBlocks, textOrder)
  const reasoning = collect(thinkBlocks, thinkOrder)
  if (!text && !reasoning) {
    // 落盘原始样本，便于继续校准
    const dir = path.join(process.env.LOCALAPPDATA ?? '', 'DshDeepSeekWeb', 'calibration')
    const file = path.join(dir, `kimi-unparsed-${Date.now()}.bin`)
    void import('node:fs/promises')
      .then(fs => fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(file, buffer)))
      .catch(() => {})
    throw new LlmError('kimi: Connect-RPC 流里没有解析出正文', 'KIMI_EMPTY_RESPONSE')
  }
  return { text, ...reasoning ? { reasoning } : {} }
}

export class KimiBrowserChannel implements BrowserChannel {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private page: Page | undefined
  private conversationStarted = false
  private readonly titleState: TitleMarkerState = {}
  private readonly options: KimiChannelOptions
  private readonly profileDir: string
  private readonly label: string
  /** 每个会话当前的取消控制器；cancelTurn 据此打断等待中的回合。 */
  private readonly cancels = new Map<string, AbortController>()
  /** 会话级的自动发送设置（来自主配置 sendMode 或 setSessionAutoSend）。 */
  private readonly autoSendSessions = new Map<string, boolean>()
  /**
   * 当前审核页是用哪种模式的入口打开的（undefined = 本实例还没开过，页面来源未知）。
   *
   * 必须记下来而不是看 URL：项目页发出第一条消息后地址会变成 `/chat/<uuid>`，
   * 与普通对话完全同形，靠路径无法分辨“这一页属于项目模式还是正常模式”。
   */
  private pageMode: 'normal' | 'project' | undefined

  constructor(options: KimiChannelOptions) {
    this.options = options
    this.profileDir = options.profileDir ?? options.config.profileDir ?? defaultProfileDir('kimi-profile')
    this.label = options.label ?? 'kimi'
  }

  /** 缓存的页面是否仍然可用：浏览器连着、页面没被关掉。 */
  private isPageUsable(): boolean {
    return Boolean(this.browser?.isConnected() && this.page && !this.page.isClosed())
  }

  /** 丢掉失效连接，让下一次 ensureReady 重新建连。 */
  private dropConnection(): void {
    this.browser = undefined
    this.context = undefined
    this.page = undefined
    this.pageMode = undefined
    this.conversationStarted = false
  }

  async ensureReady(): Promise<void> {
    if (this.isPageUsable()) return
    // 缓存还在但已失效（用户手动关了窗口、页面崩了）：必须先清掉再重连，
    // 否则后续所有 page 操作都打在一个死页面上，表现为“一直卡着不动”。
    if (this.browser || this.page) {
      console.info('[kimi] 浏览器或页面已失效，重新建立连接…')
      this.dropConnection()
    }
    const entryUrl = this.resolveEntryUrl()
    const { browser, context } = await connectBrowser({
      port: this.options.config.debugPort,
      profileDir: this.profileDir,
      url: entryUrl,
      autoStartKeeper: true,
      label: this.label,
    })
    this.browser = browser
    this.context = context
    const pages = context.pages()
    const origin = KimiBrowserChannel.safeOrigin(entryUrl)
    this.page = (origin ? pages.find(item => item.url().startsWith(origin)) : undefined)
      ?? pages[0]
      ?? await context.newPage()
    await ensureChatPage(this.page, entryUrl)
    // 原来这里无条件等 1.5 秒（每轮都付一次）；改成等输入框真正可用，
    // 页面本来就绪时 100~300ms 就能返回。
    await this.waitEditorReady(this.page)
    if (await looksLoginWall(this.page)) {
      throw new LlmError(
        'kimi: 浏览器窗口已打开，但尚未登录（发送按钮处于禁用状态）。'
        + '请先运行 node tools/open-login-kimi.mjs 完成一次登录。',
        'KIMI_LOGIN_REQUIRED',
      )
    }
  }

  /** 等输入框可见可用；提前就绪就提前返回，不再固定长等待。 */
  private async waitEditorReady(page: Page): Promise<void> {
    const editor = locateEditor(page)
    const ready = await editor.waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false)
    if (!ready) {
      throw new LlmError(
        'kimi: 等待输入框出现超时。请确认浏览器停留在 Kimi 的对话页面（未登录时也会停在登录页）。',
        'KIMI_EDITOR_NOT_FOUND',
      )
    }
  }

  /** 新建对话后等页面重新进入可输入状态；就绪即返回。 */
  private async settleAfterNewChat(page: Page): Promise<void> {
    const editor = locateEditor(page)
    await editor.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
    await page.waitForTimeout(120)
  }

  /**
   * 解析本轮审核要打开的入口地址：正常模式与项目模式各用各的，互不兜底。
   *
   * 选了项目模式却没填项目时直接报错——静默退回普通对话会让审核结果落错地方，
   * 比明确失败更难发现。
   */
  private resolveEntryUrl(): string {
    const config = this.options.config
    if (config.kimiMode === 'project') {
      const raw = (config.projectUrl ?? '').trim()
      if (raw.length === 0) {
        throw new LlmError(
          'kimi: 审核模式是「项目模式」，但还没填项目。请到设置里把「项目 ID」填上'
          + '（从项目页地址 https://www.kimi.com/project/<项目ID> 里取最后那段，形如'
          + ' 1a15bef4-b7a2-894f-8000-0e7143648841，只填 ID 就行）；'
          + '若只想用普通对话，把「审核模式」切回「正常模式」。',
          'KIMI_PROJECT_URL_MISSING',
        )
      }
      return KimiBrowserChannel.toProjectUrl(raw, config.url)
    }
    const raw = (config.url ?? '').trim()
    return raw.length > 0 ? raw : 'https://www.kimi.com/?chat_enter_method=new_chat'
  }

  /**
   * 把用户填的「项目」变成可打开的项目页地址。
   *
   * 只填项目 ID 是常态：手动抄一整条带查询参数的链接太容易出错，而域名在
   * 「正常模式链接」里已经有了（企业版域名也能跟着走）。所以：
   * - 已经是完整 URL（有 scheme）→ 原样返回，兼容老配置里存整条链接的情况；
   * - 只给了 ID → 用正常模式的 origin 拼 `<origin>/project/<ID>?chat_enter_method=new_chat`；
   * - 看起来不是 ID → 明确报错，别把一句说明文字拼进路径里再打开一个 404。
   */
  private static toProjectUrl(raw: string, normalUrl: string): string {
    const text = raw.trim()
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) return text
    const id = text.replace(/^\/+/u, '').replace(/\/+$/u, '').trim()
    if (!/^[0-9A-Za-z][0-9A-Za-z_-]*$/u.test(id)) {
      throw new LlmError(
        `kimi: 项目 ID「${text}」看起来不合法。只填项目页地址里 /project/ 后面那一段，`
        + '形如 1a15bef4-b7a2-894f-8000-0e7143648841（字母、数字和连字符）；'
        + '要填完整项目页链接也可以，但必须以 http(s):// 开头。',
        'KIMI_PROJECT_ID_INVALID',
      )
    }
    const origin = KimiBrowserChannel.safeOrigin(normalUrl) ?? 'https://www.kimi.com'
    return `${origin}/project/${id}?chat_enter_method=new_chat`
  }

  /**
   * 当前页面是否属于所选审核模式的入口。
   *
   * 正常模式不该停在项目页里（那会把对话归档到项目下）；项目模式两种页面都算——
   * 项目页发出第一条消息后地址会变成 `/chat/<uuid>`，无法再用路径判断归属。
   */
  private pageMatchesMode(page: Page): boolean {
    // 本实例开过的页面知道自己是用哪种模式打开的，这比看路径可靠：
    // 项目页发出第一条消息后同样会变成 `/chat/<uuid>`，路径上分辨不出来。
    if (this.pageMode !== undefined && this.pageMode !== this.options.config.kimiMode) return false
    try {
      const entry = new URL(this.resolveEntryUrl())
      return new URL(page.url()).origin === entry.origin
    } catch {
      return true
    }
  }

  /** 取地址的 origin；地址不合法时返回 undefined，避免 `new URL` 直接抛错盖掉真正原因。 */
  private static safeOrigin(raw: string): string | undefined {
    try {
      return new URL(raw).origin
    } catch {
      return undefined
    }
  }

  /**
   * 开一个**全新的标签页**当审核窗口，而不是在旧标签里点“新建会话”。
   *
   * 为什么不用点按钮：Kimi 的入口是只有一个图标的链接，标签页在后台时
   * `locator.click()` 点不动；而直接 `goto` 首页又会被恢复成上一次的对话。
   * 两条路都实测失败过，表现就是「每轮审核都在同一个对话里」，越审越慢。
   *
   * 现在直接开新标签并带上 Kimi 自己的新建参数 `?chat_enter_method=new_chat`，
   * 实测新标签打开就是 0 条消息的干净对话（约 3 秒）。旧的审核标签在新标签就绪后关掉，
   * 保证任何时候只有一个 Kimi 审核页，不会攒一堆标签。
   */
  private async openFreshConversation(): Promise<void> {
    const context = this.page?.context()
    if (!context) throw new LlmError('kimi: 找不到浏览器上下文，无法新建审核标签页。', 'KIMI_PAGE_CLOSED')
    // 用户填的地址就是新标签要打开的地址：已经带了建新参数就照用，
    // 这样企业版域名 / 项目页 / 自定义查询参数都能原样生效。
    const freshUrl = ensureFreshChatUrl(this.resolveEntryUrl())
    const fresh = await context.newPage()
    try {
      await fresh.goto(freshUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await this.waitEditorReady(fresh)
      // 极少数情况下列表仍带着旧消息（参数被改版忽略）时，再补一次入口点击。
      const carried = await fresh
        .evaluate(`document.querySelectorAll('[class*="chat-content-item"], [class*="message-item"]').length`)
        .catch(() => 0)
      if (typeof carried === 'number' && carried > 0) {
        await this.clickNewChatEntry(fresh)
        await fresh.waitForTimeout(800)
      }
    } catch (error) {
      await fresh.close().catch(() => {})
      throw error
    }
    const previous = this.page
    this.page = fresh
    this.pageMode = this.options.config.kimiMode
    // 旧标签整页关掉了，它记过的标题状态跟着一起作废（新标签从未被改过标题，不需要清理）。
    // 关闭失败不能影响本轮审核，但必须留痕：否则标签会一轮一个地攒下去。
    if (previous && previous !== fresh) {
      const closed = await Promise.race([
        previous.close({ runBeforeUnload: false }).then(() => true).catch(error => {
          console.warn(`[kimi] 关闭旧审核标签失败（不影响本轮）：${error instanceof Error ? error.message : String(error)}`)
          return false
        }),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3_000)),
      ])
      if (closed) console.info('[kimi] 已关闭上一轮的审核标签')
      else console.warn('[kimi] 关闭旧审核标签超时，该标签会保留在浏览器里')
    }
    const carriedNow = await fresh
      .evaluate(`document.querySelectorAll('[class*="chat-content-item"], [class*="message-item"]').length`)
      .catch(() => 0)
    console.info(`[kimi] 已打开新的审核标签页（历史消息 ${String(carriedNow)} 条）`)
  }

  /** 兜底：在页面内原生点一次“新建会话”（不要求元素可命中）。 */
  private async clickNewChatEntry(page: Page): Promise<boolean> {
    const NEW_CHAT_CLICK = `(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
      };
      const all = Array.from(document.querySelectorAll('a, button, div, span'));
      const hit = all.find((el) => (el.getAttribute('aria-label') || '').indexOf('新建会话') >= 0 && vis(el))
        || all.find((el) => /new-chat-btn|sidebar-new-chat/.test(String(el.className || '')) && vis(el));
      if (!hit) return false;
      hit.click();
      return true;
    })()`
    try {
      const clicked = await page.evaluate(NEW_CHAT_CLICK)
      if (clicked === true) return true
    } catch {
      // 页面正在跳转时 evaluate 会失败，交给下面的定位器路径。
    }
    return await bestEffortNewChat(page, {
      labels: ['新建会话'],
      selectors: ['a[aria-label*="新建会话"]', '.new-chat-btn', '.sidebar-new-chat'],
    }).catch(() => false)
  }

  /** 只清“已初始化对话”的标记：下一轮带 `initialize` 就会新开对话。发送设置不受影响。 */
  resetConversationGate(_sessionId?: string): void {
    this.conversationStarted = false
  }

  /** 记录会话级发送方式；主通道调用同接口，保持两条通道行为一致。 */
  setSessionAutoSend(sessionId: string, auto: boolean): void {
    this.autoSendSessions.set(sessionId, auto)
  }

  /** 取消挂在网页上的回合：打断等待中的 promise，让上层立刻拿到结束信号。 */
  async cancelTurn(sessionId?: string): Promise<void> {
    if (sessionId) {
      this.cancels.get(sessionId)?.abort()
      return
    }
    for (const controller of this.cancels.values()) controller.abort()
  }

  /**
   * 这一轮失败后还值得再试一次吗？
   *
   * 只重试“环境抖动”类失败：等回复超时、拿到空响应、页面/连接断掉、发送没被确认。
   * 认得出根因、再试也没用的失败（没登录、发送被禁用、找不到输入框、用户取消）
   * 直接抛给用户，避免用重试把明确的错误拖成更长的等待。
   */
  private static retryable(error: unknown): boolean {
    const code = (error as { code?: string } | undefined)?.code
    return code === 'KIMI_RESPONSE_TIMEOUT'
      || code === 'KIMI_EMPTY_RESPONSE'
      || code === 'KIMI_PAGE_CLOSED'
      || code === 'KIMI_SEND_FAILED'
      || code === 'KIMI_STREAM_STALLED'
  }

  /**
   * 提交一轮审核。
   *
   * 获取阶段出错时会自动重连并重试（`review.fetchRetries`，默认 1 次）：
   * 原实现失败即抛，网页卡住时只能由用户手动再点一次，这正是“获取出问题就卡住、
   * 不会重新获取”的形态。重试前一律丢弃旧连接，避免在已经死掉的页面上重试。
   */
  async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    // 重试次数先收敛成合法整数：volatile 数值字段可能读到 NaN，
    // 而 `attempt <= NaN` 恒为 false，会让整个重试循环被跳过并抛出 undefined。
    const retries = KimiBrowserChannel.sanitizeRetries(this.options.config.fetchRetries, 1, 3)
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (request.signal?.aborted) {
        throw new LlmError('kimi: 本轮审核已被取消', 'KIMI_TURN_CANCELLED')
      }
      try {
        return await this.turnOnce(request)
      } catch (error) {
        lastError = error
        const canRetry = attempt < retries && KimiBrowserChannel.retryable(error) && !request.signal?.aborted
        if (!canRetry) throw error
        const reason = error instanceof Error ? error.message : String(error)
        console.warn(`[kimi] 第 ${attempt + 1} 次尝试失败（${reason}），重连后重试…`)
        // 丢弃可能已经失效的连接：下一轮从 ensureReady 重新建立，而不是复用死页面。
        this.dropConnection()
        try {
          await this.ensureReady()
        } catch (connectError) {
          throw new LlmError(
            `kimi: 重新连接审核浏览器失败（${connectError instanceof Error ? connectError.message : String(connectError)}）。`,
            'KIMI_RECONNECT_FAILED',
            { cause: connectError },
          )
        }
        // 退避一下再重发，避免在同一秒内连续打到同一个限流点。
        await new Promise(resolve => setTimeout(resolve, 800))
      }
    }
    // 防御：循环一次都没跑时 lastError 仍是 undefined，直接抛出会得到「抛 undefined」的哑谜错误。
    throw lastError ?? new LlmError('kimi: 审核回合没有执行（内部重试计数异常）', 'KIMI_TURN_NOT_RUN')
  }

  /**
   * 把配置里的重试次数收敛成安全整数。
   *
   * volatile 数值字段在 Loader 尚未提交值时可能读到 `NaN`，而 `NaN ?? 1` 仍是 `NaN`；
   * `Math.max(0, Math.min(3, NaN))` 依旧是 `NaN`，会让 `attempt <= retries` 恒为 false，
   * 循环整体被跳过、上层收到 `undefined` 异常。这里统一按有限值校验并夹到合法区间。
   */
  private static sanitizeRetries(raw: unknown, fallback: number, max: number): number {
    // 注意 `Number(null)` 与 `Number('')` 都等于 0，会被当成「用户显式关掉重试」，
    // 所以空值必须先判掉，不能交给 Number 转换。
    if (raw === null || raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    return Math.max(0, Math.min(max, Math.trunc(value)))
  }

  private async turnOnce(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    if (!this.isPageUsable()) {
      this.dropConnection()
      await this.ensureReady()
    }
    const config = this.options.config

    // 发送方式：显式请求 > 会话级设置 > 审核配置的默认值。
    // 之前 Kimi 通道完全没有这条链路，只能等人工点发送，这是问题一的直接原因。
    const autoSend = request.autoSend
      ?? this.autoSendSessions.get(request.sessionId)
      ?? config.autoSend !== false
    const verifyMs = config.sendVerifyMs ?? 1_500
    const maxAttempts = config.sendRetries ?? 2

    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (request.signal?.aborted) controller.abort()
    else request.signal?.addEventListener('abort', abort, { once: true })
    this.cancels.set(request.sessionId, controller)
    const cancelled = (): boolean => controller.signal.aborted

    try {
      if (request.initialize && !this.conversationStarted) {
        await this.openFreshConversation()
        this.conversationStarted = true
      } else if (this.page !== undefined && !this.page.isClosed() && !this.pageMatchesMode(this.page)) {
        // 复用模式（initialize=false）下上一轮可能停在另一种模式的页面里：
        // 比如刚从项目模式切回正常模式，旧页还在项目内，继续发会把对话落到项目里。
        console.info('[kimi] 当前审核页与所选模式不符，按新模式重开一个标签页')
        await this.openFreshConversation()
        this.conversationStarted = true
      }
      // 新建对话会换掉 this.page，所以 page 必须在这之后取。
      const page = this.page!
      if (!page || page.isClosed()) {
        throw new LlmError('kimi: 审核标签页已关闭，重试时会自动重连。', 'KIMI_PAGE_CLOSED')
      }

      // 响应监听必须在“填入/发送”之前挂上，否则会漏掉第一个响应。
      // 但监听本身**不能带超时**：审核提示词可能很长，填字本身就要花几十秒到几分钟，
      // 原来从填字之前开始计 2 分钟，会在消息还没发出去时就把这一轮判死，而后面的代码
      // 仍会按下回车——Kimi 确实收到并回答了，插件却报“等待回复超时”。
      // 真正的等待上限改由 startAckClock() 从发送确认完成那一刻开始计。
      const responsePromise = page.waitForResponse(
        response => response.request().method() === 'POST' && matchesKimiCompletion(response.url()),
        { timeout: 0 },
      )
      let sawResponse = false
      responsePromise.then(() => { sawResponse = true }).catch(() => {})

      const completionPromise = responsePromise.then(async response => {
        await markPageTitle(page, '[dsh Kimi 审核生成中]', this.titleState).catch(() => {})
        // finished() 与 body() 并行：body() 内部本就会等流结束，串行等于多等一次。
        const [, body] = await Promise.all([
          withTimeout(response.finished().catch(() => undefined), config.streamIdleTimeoutMs, 'KIMI_STREAM_STALLED', 'kimi: 等待回复流结束超时'),
          withTimeout(response.body().catch(() => Buffer.alloc(0)), config.streamIdleTimeoutMs, 'KIMI_STREAM_STALLED', 'kimi: 读取回复体超时'),
        ])
        return { url: response.url(), status: response.status(), body }
      })
      // 取消后没人再 await 它，先挂一个空 catch，避免变成 unhandled rejection。
      completionPromise.catch(() => {})

      const aborted = new Promise<never>((_, reject) => {
        const rejectCancelled = (): void => reject(new LlmError('kimi: 本轮审核已被取消', 'KIMI_TURN_CANCELLED'))
        if (cancelled()) { rejectCancelled(); return }
        controller.signal.addEventListener('abort', rejectCancelled, { once: true })
      })

      // 发送完成之后的等待计时器：到点报“已发出但网页没有响应流”。
      // 只在发送动作确认之后启动，填字耗时（长提示词可达数分钟）不参与这段窗口。
      const ackTimeoutMs = Math.min(config.streamIdleTimeoutMs, KIMI_ACK_TIMEOUT_MS)
      let ackTimer: ReturnType<typeof setTimeout> | undefined
      let ackDeadline: Promise<never> | undefined
      const startAckClock = (): void => {
        clearTimeout(ackTimer)
        ackDeadline = new Promise<never>((_, reject) => {
          ackTimer = setTimeout(() => {
            reject(new LlmError(
              autoSend
                ? `kimi: 消息已发送，但 ${Math.round(ackTimeoutMs / 1000)} 秒内没有等到网页的响应流（HTTP 层未捕获到本轮请求）。`
                  + '请人工检查 Kimi 窗口：对话里若已出现这条消息并开始回答，说明响应被页面拦截或网络中断；'
                  + '若输入框里还留着内容，说明回车没触发发送。确认后重试本轮任务。'
                : `kimi: 消息已填入输入框，等待你点击“发送”超时（${Math.round(ackTimeoutMs / 1000)} 秒）。`
                  + '请确认输入框内容后点击页面上的发送按钮重试。',
              autoSend ? 'KIMI_RESPONSE_TIMEOUT' : 'KIMI_MANUAL_SEND_TIMEOUT',
            ))
          }, ackTimeoutMs)
        })
        void ackDeadline.catch(() => {})
      }

      const editor = locateEditor(page)
      if (!(await editor.isVisible().catch(() => false))) {
        throw new LlmError('kimi: 未找到对话输入框。请确认浏览器停留在 Kimi 的对话页。', 'KIMI_EDITOR_NOT_FOUND')
      }
      await editor.click()
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      await page.keyboard.press('Backspace')
      await page.keyboard.insertText(request.text)

      // 登录态失效时同样会“填得进去、发不出去”：立刻给出原因，不空等超时。
      let sendBlocked = await looksSendBlocked(page)
      if (sendBlocked) {
        await page.waitForTimeout(300)
        sendBlocked = await looksSendBlocked(page)
      }
      if (sendBlocked) {
        throw new LlmError(
          'kimi: 发送按钮不可用，消息发不出去——通常是尚未登录 www.kimi.com。'
          + '请先运行 node tools/open-login-kimi.mjs 登录；'
          + '若已登录请确认页面没有正在生成的回复。',
          'KIMI_SEND_BLOCKED',
        )
      }

      this.conversationStarted = true

      if (autoSend) {
        await this.focusBrowser()
        await markPageTitle(page, '[dsh Kimi 审核发送中]', this.titleState).catch(() => {})
        // 关键：不只按回车，还要“确认真的发出去了”，并带按钮兜底与重试。
        const outcome = await sendEditorMessage(page, editor, {
          verifyTimeoutMs: verifyMs,
          maxAttempts,
          pauseMinMs: 80,
          pauseMaxMs: 240,
          hasResponse: () => sawResponse,
          isCancelled: cancelled,
        })
        if (!outcome.sent) {
          throw new LlmError(
            'kimi: 消息已填入输入框，但没能确认发送出去。'
            + `尝试记录：${outcome.attempts.join('；')}。`
            + '页面可能改版导致回车和发送按钮都失效：请在 Kimi 窗口手动点一次“发送”后重试，'
            + '或把 review.autoSend 关掉改为半自动（人工点发送）。',
            'KIMI_SEND_FAILED',
          )
        }
        console.info(`[kimi] 审核消息已自动发送（方式：${outcome.via}）`)
      } else {
        await page.bringToFront()
        await markPageTitle(page, '[dsh 等待你在 Kimi 点击发送]', this.titleState).catch(() => {})
        console.info('[kimi] 消息已填入 Edge，请在 Kimi 页面点击“发送”…')
      }

      // 发送动作到这里才算完成：从现在开始计“等网页响应”的时间。
      startAckClock()

      let completion: { url: string; status: number; body: Buffer }
      try {
        completion = await Promise.race([completionPromise, aborted, ackDeadline!])
        console.info('[kimi] 已收到 Kimi 完整回复，正在解析…')
      } catch (error) {
        if (error instanceof LlmError) throw error
        // 页面/浏览器死掉时清掉缓存，下一轮 ensureReady 会重连而不是继续打空页面，
        // 这就是“出问题就卡住、不会重新获取”的治理点。
        if (!this.browser?.isConnected() || page.isClosed()) {
          console.warn('[kimi] 页面或浏览器已失效，丢弃连接以便下一轮重连：', error instanceof Error ? error.message : error)
          this.dropConnection()
          throw new LlmError(
            'kimi: 浏览器页面已关闭或连接中断，本轮审核未完成。重试时会自动重新连接。',
            'KIMI_PAGE_CLOSED',
            { cause: error },
          )
        }
        throw new LlmError(
          autoSend
            ? 'kimi: 发送流程在确认网页响应之前就中断了（页面被关闭或网络监听失效）。请人工检查 Kimi 窗口后重试。'
            : 'kimi: 等待你点击“发送”期间流程中断（页面被关闭或网络监听失效）。请确认输入框内容后重试。',
          autoSend ? 'KIMI_RESPONSE_TIMEOUT' : 'KIMI_MANUAL_SEND_TIMEOUT',
          { cause: error },
        )
      } finally {
        clearTimeout(ackTimer)
        await markPageTitle(page, undefined, this.titleState).catch(() => {})
      }

      if (completion.body.length === 0) {
        throw new LlmError(
          'kimi: 收到回复响应但响应体为空（通常是限流或网络中断）。已保留页面，请检查 Kimi 窗口后重试。',
          'KIMI_EMPTY_RESPONSE',
        )
      }
      return parseKimiCompletion(completion.body)
    } finally {
      request.signal?.removeEventListener('abort', abort)
      this.cancels.delete(request.sessionId)
    }
  }

  /** 填入消息：把 Kimi 窗口提到最前（受注入的 focus 开关控制）。 */
  async focusBrowser(): Promise<void> {
    const focus = this.options.focus
    if (focus && (focus.enabled === false || focus.webWindow === false)) return
    if (!this.page || this.page.isClosed()) return
    await this.page.bringToFront().catch(() => {})
  }

  /**
   * 仅用于满足 BrowserChannel 接口的一致性占位：
   * 实际“审核完全结束后聚焦 dsh 窗口”由主通道 adapter 在最终正文交付前统一触发，
   * 本方法当前没有调用点，保留是为了让两条通道实现同一接口时不出现方法缺失。
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
    if (!this.isPageUsable()) {
      return {
        ready: false,
        url: this.page && !this.page.isClosed() ? this.page.url() : undefined,
        message: this.browser && !this.browser.isConnected()
          ? 'Kimi 浏览器连接已断开，下次请求会自动重连'
          : 'Kimi 浏览器尚未启动',
      }
    }
    return { ready: true, url: this.page!.url(), message: 'Kimi 审核通道已连接' }
  }

  async dispose(): Promise<void> {
    // 先把在跑的回合取消掉，避免等待中的 promise 悬着。
    for (const controller of this.cancels.values()) controller.abort()
    this.cancels.clear()
    this.autoSendSessions.clear()
    // 浏览器由常驻守护拥有，这里只释放引用，不关闭窗口。
    this.dropConnection()
  }
}
