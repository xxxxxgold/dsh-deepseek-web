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
import {
  browserNoticeEnabled,
  describeFailure,
  describeRateLimitPolicy,
  formatDuration,
  formatNotice,
  noticeEnabled,
  rateLimitDelayMs,
  serverBusyDelayMs,
  SERVER_BUSY_MAX_RETRIES,
  type NoticeCategory,
  type NoticeEvent,
} from './notify.ts'
import { AsyncLock } from './async-lock.ts'
import { AccountCooldown, sharedCooldown } from './cooldown.ts'
import { TurnRetryBudget, sharedRetryBudget } from './retry-policy.ts'
import type { LoginProbeResult } from './login-probe.ts'
import { computeTurnGap, sharedPacer, type TurnPacer } from './pacing.ts'
import {
  bestEffortNewChat,
  connectBrowser,
  defaultProfileDir,
  EDITOR_CANDIDATES,
  focusDshWindow,
  hasRateLimitToast,
  hasServerBusyToast,
  isRateLimitResponse,
  isServerBusyResponse,
  looksLikeServerBusyText,
  markRateLimitToastsSeen,
  markServerBusyToastsSeen,
  PAGE_NOTICE_ID,
  looksLoggedOut,
  looksLoginWall,
  locateEditor,
  ensureChatPage,
  isBrowserClosedMessage,
  setBrowserWindowTopmost,
  launchManagedBrowser,
  sendEditorMessage,
  type ManagedBrowserConnection,
} from './browser-shared.ts'

/**
 * 实时增量轮询间隔。
 *
 * 这个轮询只读页面里的 `window.__dshWebCapture`（一次 evaluate、几个字段），
 * 不产生任何网络请求，也不碰 DOM 样式计算，所以可以压到 250ms：
 * 思考文本几乎跟着网页同步出现，而不是原来 800ms 一跳的“一卡一卡”。
 */
const PROGRESS_POLL_MS = 250
/**
 * 频控 toast 检测间隔。
 *
 * 它要遍历大量 DOM 元素并逐个读 computed style，开销比增量轮询高一个量级，
 * 因此与增量轮询拆开：保持 800ms 低频，避免高频扫描把页面拖慢。
 */
const RATE_LIMIT_POLL_MS = 800
/**
 * 从“按下发送”到“看到 HTTP 响应头”的等待上限。
 *
 * 网页版正常 1~3 秒就会回响应头；等满 3 分钟还没有，说明消息根本没发出去
 *（页面弹了遮挡层）或站点异常。原来这里直接吃 `streamIdleTimeoutMs`
 *（默认 600 秒）——用户看到的就是“卡住十分钟、不会重来”。自动发送时取
 * `min(streamIdleTimeoutMs, SEND_ACK_TIMEOUT_MS)` 并给出准确定位；人工发送时不压，
 * 因为这一段等的是“人去点发送按钮”，3 分钟之外的限制太苛刻（去倒杯水就报超时，
 * 频控重发期间每一轮都要点一次，更容易踩到）。
 */
const SEND_ACK_TIMEOUT_MS = 180_000
/**
 * 单条消息长度告警线。
 *
 * 实测（本机 Edge，chat.deepseek.com 输入框）：10 万字符约 1.1 秒、30 万约 13 秒、
 * 60 万约 77 秒，接近二次方增长；110 万字符会把页面主线程拖死到连 CDP 都连不上。
 * 超过这条线就在日志和页面标题上显式提示"正在填入 N 字"，避免被当成卡死。
 */
const LONG_TEXT_WARN_CHARS = 200_000
/** 超过这个长度才在页面状态里显示字数（短文本不打扰）。 */
const LONG_TEXT_STATUS_CHARS = 100_000
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

/**
 * 把多条网页流的解析结果按时间顺序合并成一条累计文本。
 *
 * 一轮生成里网页可能产生多条对话流：断线重连、超时重发、思考流与正文流分成
 * 两条连接。只取最后一条会让前半段（通常是思考）凭空消失——这正是“思考到一半
 * 就没动静、而网页还在输出”的直接原因。简单首尾相接又会把重发的前缀重复一遍，
 * 所以这里做单调合并：
 * - 新片以已合并内容开头 → 它是超集，直接替换；
 * - 新片是已合并内容的前缀 → 重复内容，跳过；
 * - 其余情况 → 视为真正的新内容追加。
 */
export function mergeMonotonic(pieces: readonly string[]): string {
  let merged = ''
  for (const piece of pieces) {
    if (!piece) continue
    if (merged.length === 0) { merged = piece; continue }
    if (piece.startsWith(merged)) { merged = piece; continue }
    if (merged.startsWith(piece)) continue
    merged += piece
  }
  return merged
}

/**
 * 从“累计文本”里取出相对上一条已发内容的新增量。
 *
 * 累计文本本应单调增长；一旦不是扩展关系（协议变化、流被截断），说明 diff
 * 失去意义，此时返回空串只对齐基线，宁可少发一批增量也不发错的内容。
 * 返回空串的另一个含义是“确实没有新内容”，调用方据此直接跳过。
 */
export function takeDelta(current: string, emitted: string, kind: 'text' | 'reasoning'): string {
  if (current === emitted) return ''
  if (current.startsWith(emitted)) return current.slice(emitted.length)
  console.warn(`[deepseek-web] 实时${kind === 'text' ? '正文' : '思考'}累计文本非单调增长，已对齐基线（本拍不发增量）。`)
  return ''
}

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
  /** 账号冷却计时器（测试注入可控时钟；缺省用进程级单例，跨热重载保留）。 */
  cooldown?: AccountCooldown
  /** 跨回合重试预算（测试注入；缺省用进程级单例）。 */
  retryBudget?: TurnRetryBudget
  pacer?: TurnPacer
}

function matchesCompletionUrl(url: string): boolean {
  return /\/chat\/completion\b/i.test(url)
    || /\/chat\/completions?$/i.test(url)
    || /\/conversation\/(chat|completion)/i.test(url)
}

/**
 * 判断当前地址是否已经处在“新对话态”（入口页）。
 *
 * DeepSeek 的对话地址是 `/a/chat/s/<会话id>`，入口页是根路径 `/`（或 `/a/chat`）。
 * 在这种页面上点“开启新对话”不会改变 URL，所以不能再用“URL 有没有变”判定成功，
 * 否则每轮都会退化成整页重载，把填字撞进前端初始化竞态。
 */
export function isEntryUrl(current: string, entryUrl: string): boolean {
  let now: URL
  let entry: URL
  try {
    now = new URL(current)
    entry = new URL(entryUrl)
  } catch {
    return false
  }
  if (now.origin !== entry.origin) return false
  const strip = (path: string): string => path.replace(/\/+$/u, '')
  const nowPath = strip(now.pathname)
  const entryPath = strip(entry.pathname)
  // 入口页配置成带具体会话地址时（用户把某个对话当入口），没有“新对话态”可言。
  if (/\/chat\/s\//i.test(entryPath)) return false
  if (nowPath === entryPath) return true
  // 入口页是根路径时，/a/chat 这类站点首页同样属于新对话态。
  if (entryPath === '' && (nowPath === '' || nowPath === '/a' || nowPath === '/a/chat')) return true
  return false
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
  /**
   * 网页端提示**服务端临时故障**（「服务器暂时不可用」/ 5xx 错误帧）。
   *
   * 与频控分开：这类失败跟账号无关，等一会儿重发就能过；如果当成普通解析失败，
   * 就会落进 WEB_UNPARSEABLE_RESPONSE（用户看到的正是「本轮运行失败」）。
   */
  serverBusy?: boolean
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
  let serverBusy = false
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

    // 网页端服务端故障提示：{"type":"error","content":"服务器暂时不可用…"}
    // 或 {"error":{"code":503,"message":"…"}}。必须在正文重建之前拦下：
    // 否则整个 body 会被当成「解析不出正文」，最终落进 WEB_UNPARSEABLE_RESPONSE。
    const errorPayload = (json as { error?: unknown }).error
    if (errorPayload !== undefined || (json as { type?: unknown }).type === 'error') {
      const errorText = typeof errorPayload === 'string'
        ? errorPayload
        : errorPayload !== undefined ? JSON.stringify(errorPayload) : ''
      const content = String((json as { content?: unknown }).content ?? '')
      const message = String((json as { message?: unknown }).message ?? '')
      if (looksLikeServerBusyText(`${errorText} ${content} ${message}`)
        || /"code"\s*:\s*(502|503|504)\b/u.test(errorText)) {
        serverBusy = true
        continue
      }
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
      ...serverBusy ? { serverBusy: true } : {},
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
        ...serverBusy ? { serverBusy: true } : {},
      }
    }
    // 结构化解析一无所获：不可靠，调用方（实时轮询）必须丢弃
    return {
      text: '',
      reliable: false,
      ...finishReason ? { finishReason } : {},
      ...accumulatedUsage !== undefined ? { accumulatedUsage } : {},
      ...contextLengthExceeded ? { contextLengthExceeded: true } : {},
      ...serverBusy ? { serverBusy: true } : {},
    }
  } catch {
    // body 不是可解析的结构化载荷（例如误捕获的状态/心跳流）：原始内容不可信。
    // 但网关错误页 / 纯文本「服务器暂时不可用」要单独认出来——它是可重试的服务端
    // 故障，而不是「插件没跟上网页改版」，两者给人的提示和处置完全不同。
    if (!serverBusy && isServerBusyResponse(200, body)) serverBusy = true
    return {
      // 服务端故障帧不是正文：把原始 SSE 塞进 text 会让上层误以为「拿到了回复」。
      text: serverBusy ? '' : body.trim(),
      reliable: false,
      ...finishReason ? { finishReason } : {},
      ...accumulatedUsage !== undefined ? { accumulatedUsage } : {},
      ...contextLengthExceeded ? { contextLengthExceeded: true } : {},
      ...serverBusy ? { serverBusy: true } : {},
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
  /** 账号级冷却：进程级共享，热重载/多实例都读同一份（见 cooldown.ts）。 */
  private readonly cooldownState: AccountCooldown
  /** 跨回合重试预算：同样进程级共享（见 retry-policy.ts）。 */
  private readonly retryBudgetState: TurnRetryBudget
  private readonly pacerState: TurnPacer
  private readonly profileDir: string
  private managedConnection: ManagedBrowserConnection | undefined
  /** 连续请求计数与最后一次请求时间（防风控长休用，见 maybeTakeLongRunPause）。 */
  private consecutiveSends = 0
  private lastSendAt = 0
  /** 提示节流：key 为「会话::分类::事件」，value 为上次发送时刻（毫秒）。 */
  private readonly lastNoticeAt = new Map<string, number>()

  constructor(options: PlaywrightChannelOptions) {
    this.options = options
    this.cooldownState = options.cooldown ?? sharedCooldown()
    this.retryBudgetState = options.retryBudget ?? sharedRetryBudget()
    this.pacerState = options.pacer ?? sharedPacer()
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
    // 已经在入口页（新对话态）时，点击“开启新对话”不会改变地址——DeepSeek 的会话地址形如
    // /a/chat/s/<id>，入口页就是根路径。旧判定只看 URL 是否变化，于是每一轮都会误判失败、
    // 回退去整页重载入口页；重载后前端初始化与随后的填字存在竞态，填进去的内容有被清空的
    // 风险，回车就成了空发。这里先把“本来就在新对话态”识别出来，直接跳过重载。
    if (isEntryUrl(beforeUrl, entryUrl)) {
      const clickedAtEntry = await bestEffortNewChat(page)
      if (clickedAtEntry) console.info('[deepseek-web] 已在入口页（新对话态），无需重载。')
      await locateEditor(page).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
      return
    }
    const existingPages = new Set(page.context().pages())
    const clicked = await bestEffortNewChat(page)
    // 网页把“新对话”做成 SPA 路由，点击到地址栏更新常要 1~3 秒：原来固定等 800ms 就判定失败，
    // 于是几乎每次新会话都走"重开入口页"的兜底——整页重载期间前端还在初始化，紧接着填字有概率被
    // 前端状态覆盖成空，回车等于没发，旧代码又只按一次回车不确认，最后表现成"未收到网页响应"。
    // 这里改成轮询等地址真正变化，仍失败才重载。
    const changeDeadline = Date.now() + 3_000
    while (clicked && page.url() === beforeUrl && Date.now() < changeDeadline) {
      await page.waitForTimeout(200)
    }
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

  /** 提示归属：审核请求（reviewer 传 role:'review'）与会话请求分开，绝不混成一锅。 */
  private noticeCategory(request: BrowserTurnRequest): NoticeCategory {
    return request.role === 'review' ? 'review' : 'session'
  }

  /**
   * 发一条提示。
   *
   * 节流按「会话 + 分类 + 事件」去重：重发循环里连续调用不会把同一句话刷屏，
   * 但等待 → 重发 → 完成这种真实状态变化一定各有一次。
   */
  private emitNotice(request: BrowserTurnRequest, event: NoticeEvent, detail: string): void {
    const onNotice = request.onNotice
    if (onNotice === undefined) return
    const category = this.noticeCategory(request)
    if (!noticeEnabled(this.options.config.notify, category, event)) return
    const key = `${request.sessionId}::${category}::${event}`
    const now = Date.now()
    const throttleMs = event === 'recover'
      ? 0 // 自愈全程只有三条，且每条都是不同的状态，压掉任何一条都会让人以为卡住了
      : event === 'send' || event === 'receive' ? 500 : 1_000
    if (now - (this.lastNoticeAt.get(key) ?? 0) < throttleMs) return
    if (this.lastNoticeAt.size > 200) this.lastNoticeAt.clear()
    this.lastNoticeAt.set(key, now)
    const text = formatNotice({ category, event, detail })
    try {
      onNotice({ category, event, text })
    } catch (error) {
      // 提示是旁路：回调自己炸了也不能影响回合本体。
      console.warn(
        '[deepseek-web] 提示回调异常（已忽略）：',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /**
   * 在网页右下角画一块浮层。
   *
   * 只服务「用户正盯着浏览器」的等待场景（频控倒计时、等人工点发送）：
   * pointer-events:none 保证它永远不挡住网页按钮和输入框。
   */
  private async paintPageNotice(page: Page, text: string): Promise<void> {
    if (!browserNoticeEnabled(this.options.config.notify)) return
    await page.evaluate((payload) => {
      let box = document.getElementById(payload.id)
      if (box === null) {
        box = document.createElement('div')
        box.id = payload.id
        box.setAttribute('role', 'status')
        box.style.cssText = [
          'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
          'max-width:320px', 'padding:10px 14px', 'border-radius:10px',
          'background:rgba(28,28,32,.92)', 'color:#fff', 'font-size:13px',
          'line-height:1.5', 'white-space:pre-line', 'pointer-events:none',
          'box-shadow:0 6px 24px rgba(0,0,0,.28)', 'font-family:system-ui,sans-serif',
        ].join(';')
        document.body.appendChild(box)
      }
      box.textContent = payload.text
    }, { id: PAGE_NOTICE_ID, text })
  }

  /**
   * 抹掉浮层；网页已关闭时静默跳过。
   *
   * 这里**不**再看 `browserNoticeEnabled`：开关只在“画”的时候判断，清理必须无条件执行。
   * 否则等待中途把「网页内提示」关掉，浮层就永远留在网页右下角；而它的文案
   * （“网页提示发送过于频繁…”）本身能命中频控正则，会把之后每一轮都锁死。
   */
  private async clearPageNotice(page: Page): Promise<void> {
    if (page.isClosed()) return
    await page.evaluate(id => document.getElementById(id)?.remove(), PAGE_NOTICE_ID)
  }

  /**
   * 频控等待：按秒刷新浮层倒计时，同时让 sleep 保持可中断。
   *
   * 倒计时只在秒数变化时重画（一次 evaluate），不会因为 200ms 步进而打满页面。
   */
  private async waitWithCountdown(
    page: Page,
    request: BrowserTurnRequest,
    waitMs: number,
    attemptIndex: number,
    maxRetries: number,
  ): Promise<void> {
    const canPaint = browserNoticeEnabled(this.options.config.notify) && !page.isClosed()
    let lastSecond = -1
    let lastNoticeSecond = -1
    try {
      await this.sleep(waitMs, request.signal, (remainingMs) => {
        const second = Math.ceil(remainingMs / 1000)
        if (second === lastSecond) return
        lastSecond = second
        if (canPaint) {
          void this.paintPageNotice(
            page,
            `DSH：网页提示发送过于频繁\n${formatDuration(remainingMs)} 后自动重发`
            + `（第 ${attemptIndex}/${maxRetries} 次）`,
          ).catch(() => {})
        }
        // 对话里的提示块不逐秒刷（12 分钟会刷出几百行），
        // 只在整分钟和最后 30 秒各报一次进度。
        const shouldNotify = second === 30 || (second > 30 && second % 60 === 0)
        if (!shouldNotify || second === lastNoticeSecond) return
        lastNoticeSecond = second
        this.emitNotice(
          request,
          'wait',
          `还需要 ${formatDuration(remainingMs)}（第 ${attemptIndex}/${maxRetries} 次重发）`,
        )
      })
    } finally {
      // 不论这轮有没有画成功都清一次：paintPageNotice 是 fire-and-forget（`void`），
      // 最后一次绘制可能晚于 canPaint 的判定落地，漏清就会在网页上留下一块自锁浮层。
      await this.clearPageNotice(page).catch(() => {})
    }
  }

  /**
   * 本轮失败提示。
   *
   * 放在 turn / turnIsolated 的 catch 里，而不是散落在每个 throw 点：
   * 只要这一轮以错误收场，就一定有一条提示，不会漏。
   */
  private emitFailure(request: BrowserTurnRequest, error: unknown): void {
    const failure = error instanceof LlmError
      ? error.failure
      : { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }
    this.emitNotice(request, 'error', describeFailure(failure))
  }

  /**
   * 这条错误是不是「浏览器/标签页被关掉」造成的。
   *
   * 两条证据：插件自己抛的 `WEB_PAGE_CLOSED`，以及 Playwright 断连的纯文本报错；
   * 另外浏览器对象已经明确断开时，任何错误都按可自愈处理——连接都没了，
   * 继续在死对象上重试没有意义。
   */
  private browserClosed(error: unknown): boolean {
    if (error instanceof LlmError && error.failure.code === 'WEB_PAGE_CLOSED') return true
    const text = error instanceof Error ? error.message : String(error)
    if (isBrowserClosedMessage(text)) return true
    return this.browser !== undefined && !this.browser.isConnected()
  }

  /**
   * 浏览器自愈：清掉断掉的连接/页面登记，再重启（或重连）浏览器。
   *
   * 只做「把环境恢复成可用」，新的标签页由调用方的 stateFor 重新创建；
   * 这样自愈和正常的会话页创建走同一条路，不会出现两套补页逻辑。
   */
  private async recoverBrowser(
    request: BrowserTurnRequest,
    attempt: number,
    maxAttempts: number,
    error: unknown,
    sessionId: string,
  ): Promise<void> {
    const connected = this.browser?.isConnected() === true
    const reason = error instanceof LlmError
      ? error.failure.message
      : error instanceof Error ? error.message : String(error)
    console.info(
      `[deepseek-web] 浏览器已断开，开始自愈（第 ${attempt}/${maxAttempts} 次）：`
      + `${connected ? '仅标签页被关，保留浏览器' : '重启浏览器'}；原因：${reason.slice(0, 200)}`,
    )
    this.emitNotice(
      request,
      'recover',
      connected
        ? `网页标签被关掉了，正在重新打开标签页（第 ${attempt}/${maxAttempts} 次）`
        : `浏览器被关掉了，正在重新启动浏览器（第 ${attempt}/${maxAttempts} 次）`,
    )

    // 至少要把这个会话的旧登记清掉：它指向的 Page 已经关闭，留着只会让下一轮继续踩空。
    const stale = this.sessionPages.get(sessionId)
    this.sessionPages.delete(sessionId)
    this.creatingPages.delete(sessionId)
    void stale?.page.close().catch(() => {})
    if (this.page === stale?.page) this.page = undefined
    if (!connected) {
      // 浏览器对象本身已死：别的会话页也一起失效，缓冲全清，连接句柄放掉，交给 ensureReady 重启。
      this.sessionPages.clear()
      this.pendingPages.clear()
      this.page = undefined
      const managed = this.managedConnection
      this.managedConnection = undefined
      this.browser = undefined
      this.context = undefined
      await managed?.browser.close().catch(() => {})
      if (managed?.process && !managed.process.killed) managed.process.kill()
    }

    const delayMs = this.options.config.browserRecovery.delayMs
    if (delayMs > 0) {
      this.emitNotice(
        request,
        'recover',
        `${formatDuration(delayMs)} 后重新${connected ? '打开标签页' : '启动浏览器'}，本轮消息会自动重发`,
      )
      await this.sleep(delayMs, request.signal)
    }

    await this.ensureReady()
    this.emitNotice(request, 'recover', '浏览器已就绪，正在重新打开网页并重发本轮消息')
  }

  async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    // 回合还没开始，浏览器/标签页就已经被关掉：ensureReady 会自己重启/补页，
    // 但那一步是静默的——用户只会看到"发出去没反应"。所以先记下现场，恢复后补一条提示。
    const healthyBefore = this.browser?.isConnected() === true
    const closedPageBefore = this.page !== undefined && this.page.isClosed()
    await this.ensureReady()
    if (this.browser !== undefined && (!healthyBefore || closedPageBefore)) {
      this.emitNotice(
        request,
        'recover',
        healthyBefore
          ? '网页标签已被关闭，已自动重新打开'
          : '浏览器已被关闭，已自动重新启动并打开网页',
      )
    }
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
    // 页面若已被关闭，不在这里直接抛：交给下面的自愈循环（turnOnPage 会抛 WEB_PAGE_CLOSED），
    // 这样"用户顺手关了标签页"和"浏览器整个退出"走同一条恢复路径。

    const acquire = (target: SessionPageState): Promise<() => void> => target.lock.acquire(request.signal, {
      maxHoldMs: this.options.config.lockLeaseMs,
      onLeak: info => console.warn(
        `[deepseek-web] 会话回合锁被强制回收：session=${target.sessionId} 已持有 ${Math.round(info.heldMs / 1000)}s。`
        + '该回合仍在后台收尾，但不会再永久阻塞这个会话的后续请求。',
      ),
    })
    let release = await acquire(state)

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

    const recovery = this.options.config.browserRecovery
    const maxRecoveries = recovery.enabled === false ? 0 : Math.max(0, Math.trunc(recovery.maxAttempts))

    try {
      for (let recovered = 0; ; recovered += 1) {
        try {
          console.info(
            `[deepseek-web] turn 入口 session=${request.sessionId} initialize=${String(request.initialize)} `
            + `页面会话=${state.sessionId} started=${String(state.started)} 会话页=${this.sessionPages.size}`
            + `${recovered > 0 ? ` 自愈第 ${recovered} 次` : ''}`,
          )
          request.signal?.throwIfAborted()
          if (request.initialize && !state.started) {
            await this.startFreshConversation(state.page)
            state.started = true
          }
          return await this.turnOnPage(state.page, inner)
        } catch (error) {
          // 超时/取消是"主动结束"，不能拿重启浏览器来掩盖；自愈只处理意外关闭。
          if (timedOut || abort.signal.aborted) throw error
          if (recovered >= maxRecoveries || !this.browserClosed(error)) throw error
          // 换新页之前先放锁：自愈可能要重启浏览器，别让其它请求堵在这把锁上干等。
          release()
          await this.recoverBrowser(request, recovered + 1, maxRecoveries, error, request.sessionId)
          state = await this.stateFor(request.sessionId)
          state.abort = abort
          release = await acquire(state)
        }
      }
    } catch (error) {
      if (timedOut) {
        const timeout = new LlmError(
          `deepseek-web: 本次网页回合超过单回合上限（${Math.round(timeoutMs / 1000)}s），已主动中止，避免长期占用网页与会话锁。`
          + '请检查网页是否卡在生成中，或调大 turnTimeoutMs 后重试。',
          'WEB_TURN_TIMEOUT',
        )
        this.emitFailure(request, timeout)
        throw timeout
      }
      if (abort.signal.aborted && !request.signal?.aborted) {
        const aborted = new LlmError('网页回合已被主动取消（宿主已放弃本次生成）。', 'WEB_TURN_ABORTED')
        this.emitFailure(request, aborted)
        throw aborted
      }
      this.emitFailure(request, error)
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
    } catch (error) {
      this.emitFailure(request, error)
      throw error
    } finally {
      await page?.close().catch(() => {})
      await this.setWebWindowTopmost(request.sessionId, false).catch(() => {})
    }
  }

  private async turnOnPage(page: Page, request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    const startedAt = Date.now()
    let waitedMs = 0
    // 账号级冷却：网页已经判过频控就不要继续打。这里拦在发请求之前，而不是等
    // 网页再拒一次——冷却期里的每一次尝试都算一次机器行为。
    const cooldown = this.cooldown()
    const coolingMs = cooldown.remainingMs()
    if (coolingMs > 0) {
      const snapshot = cooldown.snapshot()
      throw new LlmError(
        `deepseek-web: 账号仍在频控冷却中，还需等待 ${formatDuration(coolingMs)}。`
        + `${snapshot.reason !== undefined ? `（上次原因：${snapshot.reason}）` : ''}`
        + '冷却期内不会再向网页发送任何请求，避免把临时限流拖成封号。',
        'WEB_ACCOUNT_COOLDOWN',
      )
    }
    // 回合间隔：从「上一轮网页回合结束」起算的随机等待。sendPause 只夹在
    // 「填字完成 → 回车」之间，上一轮结束到下一轮开始原本是 0 间隔——长任务连续
    // 续跑时那正是最像脚本的节拍（真人不会每 0 秒接一条）。0 = 关闭。
    const gapMs = computeTurnGap(
      this.pacerState.lastEnd(),
      Date.now(),
      this.options.config.turnGapMinMs,
      this.options.config.turnGapMaxMs,
    )
    if (gapMs > 0) {
      console.info(`[deepseek-web] 距上一轮结束不足 ${formatDuration(gapMs)}，先等一会儿再发（回合间隔）。`)
      await this.sleep(gapMs, request.signal)
    }
    // 频控自动重发：网页提示“发送过于频繁”时等待后重发同一条消息，
    // 而不是中断回合报错；重试用尽才抛 WEB_RATE_LIMITED。
    // 默认走指数退避（60s→120s→240s→300s 封顶），覆盖实测 10~15 分钟冷却窗口。
    const rateLimit = this.options.config.rateLimit
    const maxRetries = rateLimit?.enabled === false ? 0 : rateLimit?.maxRetries ?? 4
    // 服务端临时故障（5xx / 网页「服务器暂时不可用」）：跟账号无关，等一会儿重发即可。
    // 独立计数、独立退避、不触发账号冷却——把它并进频控会白锁 10 分钟。
    const serverBusy = this.options.config.serverBusy
    const busyMaxRetries = serverBusy?.enabled === false
      ? 0
      : serverBusy?.maxRetries ?? SERVER_BUSY_MAX_RETRIES
    // 跨回合预算：单回合 maxRetries 只是一层闸；宿主连续续跑时，每回合各重试几次
    // 会叠成几十次请求（竞品记录过 22 分钟 49 次请求随后账号被吊销）。预算活在回合外。
    const budget = this.retryBudget()
    const budgetKey = `deepseek-web:${this.options.config.channel}`
    let attempt = 0
    let busyAttempt = 0
    let busyWaitedMs = 0

    /**
     * 服务端故障的等待与重发。
     *
     * 用尽时抛 WEB_SERVER_BUSY（**不**锁账号冷却）：这是后端的问题，跟这个账号
     * 有没有被判机器行为毫无关系；锁冷却只会让用户等更久还找不到原因。
     */
    const waitForServerRecovery = async (): Promise<void> => {
      if (busyAttempt >= busyMaxRetries) {
        throw new LlmError(
          `deepseek-web: 网页服务端暂时不可用，已自动重试 ${busyMaxRetries} 次仍未恢复`
          + `${busyWaitedMs > 0 ? `（累计等待 ${formatDuration(busyWaitedMs)}）` : ''}。`
          + '这是 DeepSeek 后端的问题，跟账号和插件都无关：等 1~2 分钟再试即可。',
          'WEB_SERVER_BUSY',
        )
      }
      const waitMs = serverBusyDelayMs(serverBusy, busyAttempt)
      busyWaitedMs += waitMs
      busyAttempt += 1
      const delayText = formatDuration(waitMs)
      console.info(
        `[deepseek-web] 网页服务端暂时不可用，${delayText} 后自动重发同一条消息`
        + `（第 ${busyAttempt}/${busyMaxRetries} 次，${describeRateLimitPolicy(serverBusy)}）…`,
      )
      this.emitNotice(
        request,
        'wait',
        `网页服务器暂时不可用，${delayText} 后自动重发（第 ${busyAttempt}/${busyMaxRetries} 次）`,
      )
      await this.markPageStatus(page, `[dsh 服务端繁忙：${delayText} 后自动重发]`).catch(() => {})
      await this.waitWithCountdown(page, request, waitMs, busyAttempt, busyMaxRetries)
      await this.markPageStatus(page, undefined).catch(() => {})
      this.emitNotice(request, 'retry', `正在第 ${busyAttempt}/${busyMaxRetries} 次重发同一条消息`)
    }

    while (true) {
      request.signal?.throwIfAborted()
      const outcome = await this.sendAndWait(page, request)
      // 服务端临时故障先于一切正文判定处理：它可能表现为 5xx 响应，也可能藏在
      // HTTP 200 的 SSE 里（一个 error 帧）。不拦下来就会落进 WEB_UNPARSEABLE_RESPONSE。
      if (outcome.kind === 'server-busy') {
        await waitForServerRecovery()
        continue
      }
      if (outcome.kind === 'completed') {
        const parsed = parseCompletionBody(outcome.completion.body)
        if (parsed.serverBusy === true) {
          await waitForServerRecovery()
          continue
        }
        if (outcome.completion.status >= 400) {
          // 5xx 一律先按服务端故障处理：这类失败跟账号无关，等一会儿重发就能过，
          // 报成 WEB_HTTP_ERROR 只会让用户以为插件坏了。
          if (isServerBusyResponse(outcome.completion.status, outcome.completion.body)) {
            await waitForServerRecovery()
            continue
          }
          throw new LlmError(
            `网页返回 HTTP ${outcome.completion.status}，未作为有效回复提交。`, 'WEB_HTTP_ERROR')
        }
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
        const result: BrowserTurnResult = {
          text: parsed.text,
          ...parsed.reasoning !== undefined ? { reasoning: parsed.reasoning } : {},
          ...parsed.accumulatedUsage !== undefined ? { accumulatedUsage: parsed.accumulatedUsage } : {},
          ...parsed.contextLengthExceeded === true ? { contextLengthExceeded: true } : {},
          ...outcome.completion.interrupted ? { finishReason: 'interrupted' as const }
            : parsed.finishReason ? { finishReason: parsed.finishReason } : {},
        }
        this.emitNotice(
          request,
          'done',
          `用时 ${formatDuration(Date.now() - startedAt)}，收到 ${parsed.text.length} 字`
          + `${waitedMs > 0 ? `（含频控等待 ${formatDuration(waitedMs)}）` : ''}`,
        )
        // 真的拿到一轮完整回复 = 网页愿意继续服务：提前解除冷却标记、清掉重试账。
        cooldown.clear()
        budget.reset(budgetKey)
        return result
      }
      if (attempt >= maxRetries) {
        // 重试用尽：锁住整个账号，而不只是让本回合失败。其它会话/子代理随后的
        // 请求会在 turnOnPage 入口被同一把锁挡下，不再往网页上撞。
        const coolMs = rateLimit?.accountCooldownMs ?? 600_000
        cooldown.block(coolMs, '网页提示发送过于频繁，自动重发已用尽')
        throw new LlmError(
          `deepseek-web: 网页提示发送过于频繁，已自动重发 ${maxRetries} 次仍未成功`
          + `${waitedMs > 0 ? `（累计等待 ${formatDuration(waitedMs)}）` : ''}。`
          + `${coolMs > 0 ? `账号已进入 ${formatDuration(coolMs)} 冷却，期间所有会话都不会再发请求。` : ''}`
          + '请稍后在网页端手动发送，或稍后重试本任务。',
          'WEB_RATE_LIMITED',
        )
      }
      // 跨回合预算：用尽就直接停手，不再进本回合的退避等待。
      if (!budget.take(budgetKey)) {
        throw new LlmError(
          'deepseek-web: 最近 30 分钟内自动重发次数已用尽，为避免账号被判机器行为，本轮不再重试。'
          + '请等冷却结束后再试，或先去网页端手动发一条确认账号可用。',
          'WEB_RATE_LIMITED',
        )
      }
      const waitMs = rateLimitDelayMs(rateLimit, attempt)
      waitedMs += waitMs
      attempt += 1
      const delayText = formatDuration(waitMs)
      const jitterPercent = Math.round((rateLimit?.jitterRatio ?? 0.15) * 100)
      console.info(
        `[deepseek-web] 网页提示发送频繁，${delayText} 后自动重发同一条消息`
        + `（第 ${attempt}/${maxRetries} 次，${describeRateLimitPolicy(rateLimit)}，抖动 ±${jitterPercent}%）…`,
      )
      this.emitNotice(
        request,
        'wait',
        `网页提示发送过于频繁，${delayText} 后自动重发（第 ${attempt}/${maxRetries} 次）`,
      )
      await this.markPageStatus(page, `[dsh 频控：${delayText} 后自动重发]`).catch(() => {})
      await this.waitWithCountdown(page, request, waitMs, attempt, maxRetries)
      await this.markPageStatus(page, undefined).catch(() => {})
      this.emitNotice(request, 'retry', `正在第 ${attempt}/${maxRetries} 次重发同一条消息`)
    }
  }

  /** 账号冷却计时器（进程级共享；状态接口给设置页/自检读）。 */
  cooldown(): AccountCooldown {
    return this.cooldownState
  }

  /** 跨回合重试预算（进程级共享；自检与台账读它）。 */
  retryBudget(): TurnRetryBudget {
    return this.retryBudgetState
  }

  /** 该页面是否由本通配给某个 dsh 会话（清理残留标签页时判断归属）。 */
  private ownedPage(page: Page): boolean {    if (page === this.page) return true
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
    | { kind: 'completed'; completion: ChatCompletionResponse }
    | { kind: 'rate-limited' }
    | { kind: 'server-busy' }
  > {
    // 连续发满 N 轮先静默一阵（防风控），再进入本轮。
    await this.maybeTakeLongRunPause(page, request.signal)

    const autoSend = request.autoSend
      ?? this.autoSendSessions.get(request.sessionId)
      ?? this.options.config.sendMode === 'approved'

    // 提前挂监听，防止用户在我们填完后立刻点击发送导致漏掉响应。
    // 频控重发时旧 waiter 用 waiterActive 作废，避免迟到响应串扰下一轮。
    // 自动发送等的是站点响应头，吃 streamIdleTimeoutMs；人工发送等的是人点按钮，
    // 必须给足 SEND_ACK_TIMEOUT_MS，否则用户稍一分神就报“未点击发送”。
    const ackTimeoutMs = autoSend
      ? Math.min(this.options.config.streamIdleTimeoutMs, SEND_ACK_TIMEOUT_MS)
      : SEND_ACK_TIMEOUT_MS
    let waiterActive = true
    let sawResponse = false
    // 监听必须在填字之前挂上（否则用户/脚本提前发送会漏掉响应），但监听本身**不能带超时**：
    // 超长文本的填写可能持续几分钟，原来从填字之前开始计 180 秒，会在消息还没发出去时
    // 就把这一轮判死，而后续代码仍会按下回车——网页确实收到并回答了，dsh 却报“未收到响应”。
    // 真正的等待上限改由 startAckClock() 从“发送确认完成”那一刻开始计。
    const waiter = page.waitForResponse(async response => {
      if (response.request().method() !== 'POST') return false
      if (!matchesCompletionUrl(response.url())) return false
      sawResponse = true
      return true
    }, { timeout: 0 }).then(async response => {
      await this.markPageStatus(page, request.purpose ? `[dsh 内部辅助：${request.purpose} 生成中]` : '[dsh 网页生成中]').catch(() => {})
      this.emitNotice(
        request,
        'receive',
        request.purpose ? `网页已响应（内部辅助：${request.purpose}），正在生成…` : '网页已响应，正在生成…',
      )
      // finished() 与 body() 并行：body() 内部本来就要等流结束，
      // 串行 await 等于把“等流结束”做两遍，白多一次往返。
      const [interrupted, body] = await Promise.all([
        response.finished().then(error => error !== null, () => true),
        response.body().catch(() => Buffer.alloc(0)),
      ])
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
    // 发送动作确认完成后的等待计时器：到点报“已发出但网页没有响应流”。
    // 只在发送之后启动，所以填字耗时（超长文本可达数分钟）不会吃掉这段等待窗口。
    let ackTimer: ReturnType<typeof setTimeout> | undefined
    let ackDeadline: Promise<never> | undefined
    const startAckClock = (): void => {
      clearTimeout(ackTimer)
      ackDeadline = new Promise<never>((_, reject) => {
        ackTimer = setTimeout(() => {
          reject(new LlmError(
            autoSend
              ? `deepseek-web: 消息已发送，但 ${formatDuration(ackTimeoutMs)} 内没有等到网页的响应流（HTTP 层未捕获到本轮请求）。`
                + '请人工检查网页：对话里若已出现这条消息并开始回答，说明响应被页面拦截或网络中断；'
                + '若输入框里还留着内容，说明回车没触发发送。确认后重试本轮任务。'
              : `deepseek-web: 消息已填入输入框，等待你点击“发送”超时（${formatDuration(ackTimeoutMs)}）。`
                + '请确认输入框内容后点击页面上的发送按钮重试。',
            autoSend ? 'WEB_AUTO_SEND_TIMEOUT' : 'WEB_MANUAL_SEND_TIMEOUT',
          ))
        }, ackTimeoutMs)
      })
      void ackDeadline.catch(() => {})
    }
    let progressTimer: ReturnType<typeof setInterval> | undefined
    let toastTimer: ReturnType<typeof setInterval> | undefined

    try {
      request.signal?.throwIfAborted()

      let rateLimitedNow: (() => void) | undefined
      const rateLimited = new Promise<{ kind: 'rate-limited' }>(resolve => {
        rateLimitedNow = () => resolve({ kind: 'rate-limited' })
      })
      // 服务端临时故障走独立信号：它跟账号无关，不能被并进频控（否则会白锁 10 分钟冷却）。
      let serverBusyNow: (() => void) | undefined
      const serverBusySignal = new Promise<{ kind: 'server-busy' }>(resolve => {
        serverBusyNow = () => resolve({ kind: 'server-busy' })
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
          // 页面改版专用错误码：登录态正常但输入框找不到，只可能是站点结构变了。
          // 单独分类的意义是让人一眼知道「该升级插件」而不是「该重新登录」。
          throw new LlmError(
            'deepseek-web: 未找到聊天输入框，页面结构很可能已经改版（登录态正常时才会走到这里）。'
            + `已尝试的选择器：${EDITOR_CANDIDATES.join(' | ')}。`
            + '请升级插件；急需用时可在网页端手动发送一条。',
            'WEB_UI_CHANGED',
          )
        }
      }

      // 实时思考流：确保页面里的网络镜像已就位（幂等），发送后轮询增量
      progressTimer = request.onProgress
        ? await this.startProgressPolling(page, request)
        : undefined
      // 先把「此刻页面上已经存在的」频控文案节点认领掉：只有这一轮发送之后
      // 新冒出来的提示才算新频控。少了这一步，上一轮残留的 toast（视觉上消失、
      // 节点仍在 DOM 里）会让每一轮都在第一拍被判死——网页上明明没有提示，却一直失败。
      const claimedBeforeSend = await markRateLimitToastsSeen(page)
      if (claimedBeforeSend > 0) {
        console.info(`[deepseek-web] 发送前认领 ${claimedBeforeSend} 个已存在的频控文案节点（不计入本轮判定）。`)
      }
      const claimedBusy = await markServerBusyToastsSeen(page)
      if (claimedBusy > 0) {
        console.info(`[deepseek-web] 发送前认领 ${claimedBusy} 个已存在的「服务器不可用」文案节点（不计入本轮判定）。`)
      }
      let toastTick = 0
      toastTimer = setInterval(() => {
        toastTick += 1
        void hasRateLimitToast(page).then(hit => {
          if (hit) rateLimitedNow?.()
        })
        // 服务端故障提示比 toast 稳定（会一直挂到后端恢复），降到每 3 拍扫一次：
        // 单次扫描要遍历全页并读 computed style，两个正则都跑满会明显拖慢网页。
        if (toastTick % 3 === 1) {
          void hasServerBusyToast(page).then(hit => {
            if (hit) serverBusyNow?.()
          })
        }
      }, RATE_LIMIT_POLL_MS)

      request.signal?.throwIfAborted()
      await editor.click()
      // 清掉可能残留的内容
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      await page.keyboard.press('Backspace')
      // 先清掉可能残留的旧附件，避免上一轮取消后留在输入框里的图串到本轮。
      await this.attachAttachments(page, request)
      request.signal?.throwIfAborted()
      const textLength = request.text.length
      if (textLength >= LONG_TEXT_WARN_CHARS) {
        console.warn(
          `[deepseek-web] 本轮单条消息 ${textLength} 字。网页输入框填字接近二次方级耗时`
          + '（实测 30 万字符约 13 秒、60 万约 77 秒、110 万会把页面主线程拖死数分钟），'
          + `填写期间页面可能毫无反应；响应等待 ${formatDuration(ackTimeoutMs)} 从“发送确认完成”才开始计，不会因此误判超时。`,
        )
      }
      if (textLength >= LONG_TEXT_STATUS_CHARS) {
        await this.markPageStatus(page, `[dsh 正在填入 ${textLength} 字，请稍候]`).catch(() => {})
      }
      const fillStartedAt = Date.now()
      await page.keyboard.insertText(request.text)
      const fillMs = Date.now() - fillStartedAt
      if (fillMs >= 5_000) {
        console.info(
          `[deepseek-web] 填入 ${textLength} 字耗时 ${formatDuration(fillMs)}（这一步不计入等待网页响应的超时）。`,
        )
      }
      if (page === this.page) this.markPageStarted(page)
      if (autoSend) {
        // 全自动：输入框已聚焦（editor.click），先随机停一段再回车发送。
        // 真人打完字不会立刻回车；固定延迟的方差≈0 反而是明显的机器特征。
        const pause = this.pickPause(this.options.config.sendPauseMinMs, this.options.config.sendPauseMaxMs)
        if (pause >= 1) {
          await this.markPageStatus(page, `[dsh 已填入，${(pause / 1000).toFixed(1)}s 后发送]`)
          await this.sleep(pause, request.signal)
        }
        await this.markPageStatus(page, request.purpose ? `[dsh 内部辅助：${request.purpose} 自动发送]` : '[dsh 自动发送中]')
        // 只按一次回车不够：焦点丢失、输入法吞键、页面改版都会把消息留在输入框里，
        // 然后我们空等三分钟报“未收到响应”。这里走带确认的发送：
        // 回车 → 看输入框是否清空（或网络层已看到本轮请求）→ 没清空就点发送按钮 → 再确认，
        // 每次尝试都记进 attempts，失败时能直接看出是哪一步没成。
        const outcome = await sendEditorMessage(page, editor, {
          // 网页端响应头通常 1~3 秒才回，确认窗口不能比它短，否则会把“已发出”误判成“没发出”。
          verifyTimeoutMs: Math.max(this.options.config.review.sendVerifyMs, 3_000),
          maxAttempts: 2,
          pauseMinMs: 0,
          pauseMaxMs: 0,
          hasResponse: () => sawResponse,
          isCancelled: () => request.signal?.aborted ?? false,
        })
        if (!outcome.sent) {
          throw new LlmError(
            `deepseek-web: 消息已填入输入框，但没能确认发送出去。尝试记录：${outcome.attempts.join('；')}。`
            + '页面可能改版导致回车与发送按钮都失效——请人工检查网页后重试。',
            'WEB_SEND_NOT_TRIGGERED',
          )
        }
        console.info(`[deepseek-web] 全自动：已确认发送（方式：${outcome.via}）。`)
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

      const attachText = request.attachments !== undefined && request.attachments.length > 0
        ? `，附图 ${request.attachments.length} 张`
        : ''
      this.emitNotice(
        request,
        'send',
        autoSend
          ? `已确认发送 ${request.text.length} 字${attachText}`
          : `已填入输入框 ${request.text.length} 字${attachText}，等待你在网页点击发送`,
      )

      // 发送动作到这里才算完成（自动模式已确认发出、半自动已填好等人工点）：
      // 从现在开始计“等网页响应”的时间，填字耗时（超长文本可达数分钟）不参与。
      startAckClock()
      const winner = await Promise.race([waiter, rateLimited, serverBusySignal, aborted, ackDeadline!])
      // 作废 waiter 的 undefined 不会先于 race 落定；防御性兜底按频控处理
      if (winner === undefined) return { kind: 'rate-limited' }
      if ('kind' in winner) return winner
      // 服务端故障必须先于频控判定：两者文案可能重叠（都带「请稍后重试」），
      // 但处置相反——判成频控会把账号锁进 10 分钟冷却，而它其实只是后端抖了一下。
      if (isServerBusyResponse(winner.status, winner.body)) {
        console.warn(`[deepseek-web] 响应判定为服务端暂时不可用（HTTP ${winner.status}）。`)
        return { kind: 'server-busy' }
      }
      // 只认明确的错误体（429 / 非流式短错误文本 / 流里的独立 error 帧）。
      // 早期版本扫正文前 2000 字，一句“失败的话可以稍后再试”就会把整轮判成频控。
      if (isRateLimitResponse(winner.status, winner.body)) {
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
      // 超时兜底：toast 可能出现在两次轮询之间又已消失，最后确认一次。
      // 服务端故障先判——它的文案常带「请稍后重试」，被当成频控就会白锁账号。
      if (await hasServerBusyToast(page)) return { kind: 'server-busy' }
      if (await hasRateLimitToast(page)) return { kind: 'rate-limited' }
      throw new LlmError(
        autoSend
          ? 'deepseek-web: 发送流程在确认网页响应之前就中断了（页面被关闭或网络监听失效）。请人工检查网页后重试。'
          : 'deepseek-web: 等待你点击“发送”期间流程中断（页面被关闭或网络监听失效）。请确认输入框内容后重试。',
        autoSend ? 'WEB_AUTO_SEND_TIMEOUT' : 'WEB_MANUAL_SEND_TIMEOUT',
      )
    } finally {
      waiterActive = false
      // 记下「上一次真正碰网页的回合结束」时刻：下一轮的随机间隔按它起算。
      // 成功与失败都算——失败的重发同样消耗了账号配额。
      this.pacerState.noteEnded()
      clearTimeout(ackTimer)
      clearInterval(toastTimer)
      if (progressTimer) clearInterval(progressTimer)
      if (abortListener) request.signal?.removeEventListener('abort', abortListener)
      await this.markPageStatus(page, undefined).catch(() => {})
    }
  }

  /**
   * 可中断的等待（AbortSignal 触发时抛 WEB_TURN_ABORTED）。
   *
   * `onTick` 每满 1 秒回调一次剩余毫秒，用于刷新倒计时；回调是同步的，
   * 内部也别 await——等待期间页面可能已经没了，刷新失败不该影响等待本身。
   */
  private async sleep(ms: number, signal?: AbortSignal, onTick?: (remainingMs: number) => void): Promise<void> {
    const step = 200
    for (let waited = 0; waited < ms; waited += step) {
      if (signal?.aborted) {
        throw new LlmError('deepseek-web: 等待频控重发期间回合被取消。', 'WEB_TURN_ABORTED')
      }
      if (onTick !== undefined && waited % 1_000 === 0) onTick(Math.max(0, ms - waited))
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
  ): Promise<ReturnType<typeof setInterval> | undefined> {
    if (this.options.config.liveThinking !== true) return undefined
    await this.ensureCapture(page)
    const startedAt = Date.now() - 1_000
    const onProgress = request.onProgress
    let emittedText = ''
    let emittedReasoning = ''
    /** 已结束的流不会再变，缓存解析结果，避免每 250ms 重复解析几十 KB。 */
    const settled = new Map<number, { text: string; reasoning: string; reliable: boolean }>()
    let failureStreak = 0
    let failureWarned = false

    return setInterval(() => {
      void page.evaluate((since) => {
        const state = (window as typeof window & {
          __dshWebCapture?: { entries: Array<{ at: number; body: string; done: boolean }> }
        }).__dshWebCapture
        if (!state) return undefined
        const candidates = state.entries.filter(entry => entry.at >= since && entry.body.length > 0)
        if (candidates.length === 0) return undefined
        // 返回全部候选流而不是只返回最后一条：一轮生成可能产生多条对话流，
        // 丢掉前面的那条，思考就会停在半截（而正文片段还在继续长）。
        return candidates.map(entry => ({ at: entry.at, body: entry.body, done: entry.done }))
      }, startedAt).then((captured) => {
        failureStreak = 0
        failureWarned = false
        if (!captured || captured.length === 0) return
        const texts: string[] = []
        const reasonings: string[] = []
        for (const entry of [...captured].sort((a, b) => a.at - b.at)) {
          let parsed = settled.get(entry.at)
          if (parsed === undefined) {
            const result = parseCompletionBody(entry.body)
            parsed = {
              text: result.text,
              reasoning: result.reasoning ?? '',
              reliable: result.reliable === true,
            }
            // 只有已结束的流才值得缓存；还在长的流下一拍必须重新解析。
            if (entry.done) settled.set(entry.at, parsed)
          }
          // 门禁 1：镜像可能捕获到非对话流（状态/心跳通道）。结构化解析一无所获时
          // parseCompletionBody 会把原始响应体当 text 兜底返回——绝不能把它灌进思考流
          //（2026-09-25 事故：46KB 原始 SSE 被持久化进 reasoning 块，污染会话日志）。
          if (!parsed.reliable) continue
          if (parsed.text) texts.push(parsed.text)
          if (parsed.reasoning) reasonings.push(parsed.reasoning)
        }
        const text = mergeMonotonic(texts)
        const reasoning = mergeMonotonic(reasonings)
        const textDelta = takeDelta(text, emittedText, 'text')
        const reasoningDelta = takeDelta(reasoning, emittedReasoning, 'reasoning')
        emittedText = text
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
      }).catch((error: unknown) => {
        // 原来这里是静默吞掉：页面导航/崩溃时轮询一直失败却毫无提示，
        // 用户看到的就是“思考卡住、而网页还在输出”。至少要在第一次连续失败时说一声。
        failureStreak += 1
        if (!failureWarned && failureStreak >= 4) {
          failureWarned = true
          console.warn(
            '[deepseek-web] 实时增量读取连续失败，页面可能在导航或已失效（最终回复不受影响）：',
            error instanceof Error ? error.message : error,
          )
        }
      })
    }, PROGRESS_POLL_MS)
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

  /**
   * 只读登录态探活。
   *
   * 刻意**不调用 `ensureReady()`**：探活是后台例行检查，不该因为一次定时检查
   * 就把浏览器拉起来（没有浏览器时返回 `unknown`）。有会话页时优先用它，否则用
   * 锚点页；页面已关就说明浏览器那边已经不在了。
   */
  async probeLogin(): Promise<LoginProbeResult> {
    const checkedAt = Date.now()
    if (!this.browser || !this.context) {
      return { status: 'unknown', detail: '浏览器还没启动，无法探活（探活不会主动拉起浏览器）', checkedAt }
    }
    if (!this.browser.isConnected()) {
      return { status: 'expired', detail: '浏览器连接已断开', checkedAt }
    }
    const page = this.page && !this.page.isClosed() ? this.page : this.mostRecentState()?.page
    if (page === undefined || page.isClosed()) {
      return { status: 'unknown', detail: '还没有可用的会话页', checkedAt }
    }
    if (await looksLoggedOut(page, ['sign_in', 'sign-in', 'login', 'auth'])) {
      return { status: 'expired', detail: '页面已跳到登录入口', checkedAt }
    }
    if (await looksLoginWall(page)) {
      return { status: 'expired', detail: '页面显示登录墙（输入框可用但发送被禁用）', checkedAt }
    }
    return { status: 'ok', checkedAt }
  }

  async dispose(): Promise<void> {
    if (this.options.config.browser === 'attach') {
      this.sessionPages.clear()
      this.creatingPages.clear()
      this.pendingPages.clear()
      this.autoSendSessions.clear()
      this.page = undefined
      return
    }
    await Promise.all([...this.sessionPages.values()].map(state => state.page.close().catch(() => {})))
    this.sessionPages.clear()
    this.creatingPages.clear()
    this.pendingPages.clear()
    this.autoSendSessions.clear()
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
