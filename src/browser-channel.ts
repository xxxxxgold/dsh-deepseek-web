/**
 * 真实浏览器传输层。
 *
 * 当前为接口 + 可运行状态机；浏览器驱动的 DOM/网络采集在用户登录
 * chat.deepseek.com 后按实际页面结构补齐（见 README.md）。
 *
 * @module dsh-deepseek-web/browser-channel
 */

import type { Config } from './config.ts'
import type { NoticePayload } from './notify.ts'

/** 一轮网页对话的实时增量：网页端已生成（累计解析出）的思考与正文。 */
export interface BrowserTurnProgress {
  /** 累计正文增量（自上次回调以来的新增部分）。 */
  text: string
  /** 累计思考增量（自上次回调以来的新增部分）。 */
  reasoning: string
}

/**
 * 一个待上传的附件。字节已由适配层准备好，通道只负责把它塞进网页输入框，
 * 不关心来源与路由。
 *
 * `kind` 区分两类附件：`image` 是宿主图片（按 attachmentId 跨轮去重）；
 * `file` 是本轮临时生成的长文本文件（不跨轮复用，失败时回退为直接填正文）。
 */
export interface BrowserImageAttachment {
  /** 宿主附件 id；用于跨轮去重（网页端拒绝重复的 ref_file_ids）。 */
  attachmentId: string
  /** 原文件名；网页端预览 alt 与提示词里的 `[附图 N: 文件名]` 都用它。 */
  name: string
  /** MIME 类型（image/png|jpeg|webp|gif；长文本文件为 text/markdown）。 */
  mimeType: string
  /** 原始字节；通道不做缩放或转码，按网页端限额自行判断走哪条上传路径。 */
  data: Uint8Array
  /**
   * 附件类别，缺省 `image`（兼容旧调用方）。
   * `file` 表示长文本转成的文件：上传失败时不能只留摘要，必须回退填完整正文。
   */
  kind?: 'image' | 'file'
}

export interface BrowserTurnRequest {
  sessionId: string
  /** 站点侧的模型标识（DeepSeek 为 deepseek-web 系列，Kimi 为 kimi-web，GLM 为 glm-web）。 */
  model: string
  text: string
  initialize: boolean
  /**
   * 本轮随消息一起上传的图片。缺省或空数组表示纯文本回合：
   * 通道必须零开销短路（内部辅助请求 `turnIsolated` 也走同一条发送方法）。
   */
  attachments?: readonly BrowserImageAttachment[]
  /**
   * 附件上传失败时的正文回退。
   *
   * 只在「正文被压缩成摘要 + 长文本文件附件」时出现：此时 `text` 只是摘要，
   * 文件没挂上去就不能把摘要发出去（模型会丢掉几十万字的任务数据）。通道发现
   * 文件附件没上传成功时，改用这段完整正文填输入框——慢，但内容不丢。
   */
  fallbackText?: string
  /** 全自动发送：填入后模拟回车，不等待人工点击。缺省回退通道的会话级设置。 */
  autoSend?: boolean
  signal?: AbortSignal
  /**
   * 实时进度回调（可选）：网页端流式生成期间按增量触发；适配层仅在开启
   * liveThinking 时把 reasoning 作为思考块展示。支持与否取决于通道实现。
   */
  onProgress?: (progress: BrowserTurnProgress) => void
  /** 同对话自审不能改变工作页面所属的正常 session。 */
  preserveConversation?: boolean
  /**
   * 复用对话时，明确指定要落到哪个 dsh 会话的网页页（同对话自审用）。
   * 比"最近用过的页"可靠：多会话并行（主会话 + 子代理）时，子代理在父会话审阅阶段
   * 启动会刷新"最近使用"的归属，导致自审文本写进子代理的网页对话。
   */
  conversationSessionId?: string
  /** 临时内部请求用途，用于浏览器标题提示。 */
  purpose?: string
  /**
   * 提示回调（可选）：通道在「发出消息 / 收到回复 / 频控等待 / 本轮失败」时触发。
   *
   * 与 onProgress 分开是刻意的：onProgress 受 liveThinking 门禁，而提示是用户
   * 要求的常驻能力，不能因为没开思考流就消失。
   */
  onNotice?: (notice: NoticePayload) => void
  /**
   * 本轮归属：session 是正常对话，review 是内部审核（自审 / 独立审核通道）。
   * 缺省按 session 处理；它决定提示前缀与开关，不影响网页里发什么。
   */
  role?: 'session' | 'review'
}

export interface BrowserTurnResult {
  /** 模型可见正文（去掉思考过程）。 */
  text: string
  /** 深度思考模式下模型展示的思考内容（可选）。 */
  reasoning?: string
  /**
   * 网页端上报的会话累计 token 用量（accumulated_token_usage，可选）。
   * 每轮做差即为本轮消耗；仅在解析到该字段时存在。
   */
  accumulatedUsage?: number
  /** 网页端提示对话长度达到上限（需要轮换新对话）。 */
  contextLengthExceeded?: boolean
  /** 网页明确报告的结束原因；缺省表示网站未提供该信息。 */
  finishReason?: 'stop' | 'max-tokens' | 'interrupted'
  /** 页面/网络层诊断信息。 */
  meta?: Record<string, unknown>
  /**
   * 本轮确认已挂到网页输入框的图片附件 id。
   * 适配层用它维护跨轮去重集合，避免同一张图重复上传触发网页端整轮拒绝。
   */
  uploadedImageIds?: string[]
}

export interface BrowserChannel {
  /** 打开/连接浏览器并确保已登录 chat.deepseek.com。 */
  ensureReady(): Promise<void>
  /**
   * 全新 dsh 会话开始前调用：允许通道再次执行"开启新对话"。
   * 传 sessionId 时只重置该会话的状态；不传则重置所有会话（兼容旧实现）。
   */
  resetConversationGate(sessionId?: string): void
  /** 发起一轮网页对话并等待最终回复。 */
  turn(request: BrowserTurnRequest): Promise<BrowserTurnResult>
  /** 内部摘要/标题调用：独立临时页面，不能复用正常工作的网页对话。 */
  turnIsolated?(request: BrowserTurnRequest): Promise<BrowserTurnResult>
  /** 正常会话是否仍占用当前工作页面；否则 adapter 必须回放宿主上下文。 */
  isConversationActive?(sessionId: string): boolean
  /** 轮换到全新网页对话（可选；仅主对话通道需要）。传 sessionId 时只轮换该会话的页面。 */
  startNewConversation?(sessionId?: string): Promise<void>
  /**
   * 取消指定会话（不传则全部）当前挂在网页上的回合。
   * 宿主放弃本次生成时必须调用：否则后台回合会一直占着该会话的网页标签页，
   * 让该会话后续请求只能等它自然超时（这是"卡住"的另一半原因）。
   */
  cancelTurn?(sessionId?: string): Promise<void>
  /**
   * 记录"当前正在跑的是哪个 dsh 会话"。
   * 同对话自审等 preserveConversation 请求要落到这个会话的网页页上，
   * 而不是"最近用过的任意会话页"（多会话并行时后者可能是子代理的页）。
   */
  setConversationFocus?(sessionId: string): void
  /** 当前连接状态，供 UI/日志展示。 */
  status(): Promise<{ ready: boolean; url?: string; message?: string }>
  /** 把网页窗口提到最前（填入消息 / 首次请求时）。 */
  focusBrowser(): Promise<void>
  /** 网页对话（含审核）结束、正文交给 Harness 时，把 dsh 宿主窗口提到最前。 */
  focusHarness(): Promise<void>
  /** 记录会话的发送方式（全自动/半自动），供后续轮次与自审轮次回退使用。 */
  setSessionAutoSend?(sessionId: string, auto: boolean): void
  /** 设置插件浏览器窗口是否置顶（半自动填入时置顶+聚焦，回合结束取消）。 */
  setWebWindowTopmost?(sessionId: string, topmost: boolean): Promise<void>
  dispose(): Promise<void>
}

export class BrowserChannelUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserChannelUnavailable'
  }
}

/** 旧占位实现仅用于无 playwright-core 时的降级提示。 */
export class PlaceholderBrowserChannel implements BrowserChannel {
  private readonly config: Config

  constructor(config: Config) {
    this.config = config
  }

  async ensureReady(): Promise<void> {
    throw new BrowserChannelUnavailable(
      'deepseek-web: 浏览器驱动尚未接线。请先打开插件文档完成 chat.deepseek.com 页面结构校准。',
    )
  }

  async turn(_request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    throw new BrowserChannelUnavailable('deepseek-web: 浏览器驱动尚未接线。')
  }

  resetConversationGate(): void {
    // 占位实现无状态，无需重置
  }

  async status(): Promise<{ ready: boolean; message?: string }> {
    return { ready: false, message: '浏览器通道尚未接线' }
  }

  async focusBrowser(): Promise<void> {}

  async focusHarness(): Promise<void> {}

  async dispose(): Promise<void> {}
}

export function isBrowserChannelError(error: unknown): error is BrowserChannelUnavailable {
  return error instanceof BrowserChannelUnavailable
}
