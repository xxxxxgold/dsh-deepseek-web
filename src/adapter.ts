/** 把冷却分类映射成台账里的失败分类（timeout 单独拆出来，便于看「是超时还是限流」）。 */
function toLedgerFailure(kind: FailureClass, code: string | undefined): NonNullable<LedgerEntry['failure']> {
  if ((code ?? '').toUpperCase().includes('TIMEOUT')) return 'timeout'
  return kind
}

/**
 * deepseek-web LlmAdapter：把网页版对话包装成 Harness 的流式模型调用。
 *
 * @module dsh-deepseek-web/adapter
 */

import {
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { BrowserChannel, BrowserImageAttachment, BrowserTurnRequest, BrowserTurnProgress, BrowserTurnResult } from './browser-channel.ts'
import type { Config, WebModelId } from './config.ts'
import { normalizeWebModel, WEB_MODEL_CAPABILITIES, WEB_MODEL_IDS } from './config.ts'
import type { ActionProblem, WebToolAction } from './response.ts'
import {
  looksLikeIntendedToolReply,
  looksLikeTaskRequest,
  looksLikeToolDenial,
  looksLikeUnfinishedHandoff,
  parseWebReply,
  repairAndValidateActions,
  replyChunks,
} from './response.ts'
import {
  buildDelegationPrompt,
  buildHandoffBrief,
  buildRecoveryPrompt,
  buildToolCatalog,
  buildAuxiliaryPrompt,
  renderNewWebMessages,
  stripProtocolPrefix,
  systemProtocolFor,
  visibleToolsOf,
  WEB_MARKERS,
} from './protocol.ts'
import type { ImageAttachmentRef } from './protocol.ts'
import { buildReviewEvidence } from './protocol.ts'
import {
  Ledger,
  type LedgerEntry,
  type LedgerPurpose,
  type LedgerSummary,
} from './ledger.ts'
import { classifyFailureCode, type FailureClass } from './cooldown.ts'
import { SessionRegistry, type ChannelTokenTotals, type WebChatState } from './session-state.ts'
import { ConcurrencyGate } from './concurrency-gate.ts'
import type { ReviewVerdict } from './reviewer.ts'
import { formatNotice, noticeEnabled, type NoticeEvent, type NoticePayload } from './notify.ts'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { AsyncLock } from './async-lock.ts'

/** 拆出委托动作（如 web_search/web_fetch）：本地校验与执行都不含它们。 */
function splitDelegatedActions(
  actions: readonly WebToolAction[],
  delegated: ReadonlySet<string>,
): WebToolAction[] {
  if (delegated.size === 0) return []
  return actions.filter((action) => {
    const name = action.tool ?? action.action
    return typeof name === 'string' && delegated.has(name)
  })
}

const CONTEXT_WINDOW = 128_000
const MAX_TOKENS = 16_000

/** 产出签名：同一任务下内容未变就不重复送审。 */
function reviewSignature(goal: string, artifact: string): string {
  const input = `${goal.length}:${goal.slice(0, 200)}|${artifact.length}:${artifact.slice(0, 200)}`
  let hash = 5381
  for (let index = 0; index < input.length; index++) {
    hash = ((hash * 33) ^ input.charCodeAt(index)) >>> 0
  }
  return `${hash.toString(16)}-${artifact.length}`
}

/** 审核器最小接口；KimiReviewer / GlmReviewer / DeepSeekSelfReviewer 均满足该结构。 */
type ReviewerLike = {
  readonly needsEvidence: boolean
  review: (
    evidence: { task: string; artifact: string; files: string[] },
    /** 同对话自审要落回发起审阅的会话页（多会话并行时不能靠"最近用过的页"）。 */
    options?: { conversationSessionId?: string },
  ) => Promise<ReviewVerdict>
}

/**
 * 网页实时增量的缓冲管道：onProgress 回调把 chunk 推进来，
 * driveTurn 的消费循环在等待网页回复的同时把它们 yield 给 Harness。
 */
class TurnProgressPipe {
  private readonly buffer: StreamChunk[] = []
  private waiters: Array<() => void> = []

  push(chunk: StreamChunk): void {
    this.buffer.push(chunk)
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  /** 把一次网页增量翻译成 reasoning 流 chunk。 */
  pushProgress(progress: BrowserTurnProgress, index: number): void {
    if (progress.reasoning) this.push({ type: 'reasoning-delta', index, text: progress.reasoning })
  }

  /** 等待下一次 push（buffer 为空时阻塞；push 会同步唤醒）。 */
  wait(): Promise<void> {
    if (this.buffer.length > 0) return Promise.resolve()
    return new Promise(resolve => { this.waiters.push(resolve) })
  }

  takeAll(): readonly StreamChunk[] {
    if (this.buffer.length === 0) return []
    const chunks = [...this.buffer]
    this.buffer.length = 0
    return chunks
  }
}

/**
 * 把一张图片引用读成通道能直接上传的字节。
 * 由插件入口绑定到宿主的 AttachmentStore；未注入时图片直传自动降级为文本标记。
 */
export type ReadImageAttachment = (
  ref: ImageAttachmentRef,
) => Promise<{ name: string; mimeType: string; data: Uint8Array } | undefined>

export class DeepSeekWebAdapter extends LlmAdapter {
  /**
   * 会话级锁（不是全局锁）。
   *
   * 旧实现用一把 `requestLock` 包住整次 stream：主会话与其派生的子代理是两个不同
   * sessionId，却要排队共用同一把锁，谁先拿到就独占整轮网页生成（人工模式/频控
   * 时最长十分钟），另一方只能干等——这就是"其中一个卡住"的直接成因。
   * 现在按会话分锁，不同会话并行；同一会话仍串行（它们共用同一个网页对话）。
   */
  private readonly sessionLocks = new Map<string, AsyncLock>()
  /**
   * 全局并发网关：所有会话共用一个"同时最多 N 条真在网页上跑"的名额池，
   * 超出的请求按到达顺序排队。会话锁解决的是"不同会话不该互相排队"，
   * 网关解决的是"并发太高会一起吃账号频控"——两者互补：先拿会话锁，再抢并发名额。
   */
  private readonly gate: ConcurrencyGate
  private readonly replaySessions = new Set<string>()
  private readonly sessions: SessionRegistry
  private readonly config: Config
  private readonly channel: BrowserChannel
  private readonly reviewer?: ReviewerLike
  /** 每轮记账后的总量回调（宿主用于把总计推送到前端展示）。 */
  private readonly onUsage?: (totals: ChannelTokenTotals) => void
  /** 图片附件读取器；缺省表示宿主没提供附件服务，图片退回文本标记。 */
  private readonly readImage?: ReadImageAttachment
  /** 调用台账：按天记请求密度的元信息（不记正文、不记凭证）。 */
  private readonly ledger: Ledger

  constructor(
    config: Config,
    channel: BrowserChannel,
    reviewer?: ReviewerLike,
    onUsage?: (totals: ChannelTokenTotals) => void,
    readImage?: ReadImageAttachment,
  ) {
    super()
    this.config = config
    this.channel = channel
    this.reviewer = reviewer
    this.onUsage = onUsage
    this.readImage = readImage
    const appDataRoot = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    const defaultStateFile = config.stateFile
      ?? path.join(appDataRoot, 'DshDeepSeekWeb', 'session-state.json')
    this.sessions = new SessionRegistry({ file: defaultStateFile })
    // 台账跟状态文件放同一目录：生产环境仍是 %LOCALAPPDATA%\DshDeepSeekWeb\call-ledger.json，
    // 但离线回归把 stateFile 指到临时目录时，测试数据不会写进用户的真实台账
    // （否则自检卡片会把测试跑出来的 0ms 间隔当成真实使用统计）。
    this.ledger = new Ledger({ file: path.join(path.dirname(defaultStateFile), 'call-ledger.json') })
    this.gate = new ConcurrencyGate(() => this.config.maxConcurrentTurns)
    this.warnAboutTimeoutConfig()
  }

  /**
   * 超时/租约三件套的交叉校验：配错了不会崩，但防护会失效，所以在启动时明确告警。
   * 约束：turnTimeoutMs ≤ maxStreamMs，且 lockLeaseMs ≥ maxStreamMs + turnTimeoutMs。
   * 理由：一条 llm.stream 会串联多个网页回合（纠错 / 委托 / 多轮审核），人工模式
   * 每回合都可能等满 streamIdleTimeoutMs（默认 600s，即 10 分钟）；租约必须比"最大合法整轮"更长，
   * 否则会在回合仍正常进行时强行放锁，让同一会话的两条流交替写同一个网页对话。
   */
  private warnAboutTimeoutConfig(): void {
    const { turnTimeoutMs, maxStreamMs, lockLeaseMs, sendMode } = this.config
    if (lockLeaseMs === 0) {
      console.warn('[deepseek-web] lockLeaseMs=0：锁租约防护已关闭，一旦有回合泄漏将永久占住该会话队列。')
    } else if (maxStreamMs === 0) {
      console.warn(
        `[deepseek-web] maxStreamMs=0（整轮无上限）但 lockLeaseMs=${lockLeaseMs}ms：`
        + '一旦单条流超出租约就会被强制放锁，建议同时把 maxStreamMs 设为有限值。',
      )
    } else if (lockLeaseMs < maxStreamMs + Math.max(0, turnTimeoutMs)) {
      const need = maxStreamMs + Math.max(0, turnTimeoutMs)
      console.warn(
        `[deepseek-web] lockLeaseMs(${lockLeaseMs}ms) 小于 maxStreamMs + turnTimeoutMs(${need}ms)：`
        + '多回合（纠错/委托/审核）的合法请求可能在租约到点时被强拆，建议 lockLeaseMs ≥ 该和。',
      )
    }
    if (turnTimeoutMs > 0 && maxStreamMs > 0 && turnTimeoutMs > maxStreamMs) {
      console.warn(
        `[deepseek-web] turnTimeoutMs(${turnTimeoutMs}ms) 大于 maxStreamMs(${maxStreamMs}ms)：`
        + '单回合上限永远不会触发，建议 turnTimeoutMs ≤ maxStreamMs。',
      )
    }
    if (turnTimeoutMs === 0) {
      // 单回合上限关掉后，卡住的网页回合不会被收尾（Playwright 动作本身没有默认超时），
      // 到点只能靠租约强拆，两条流就会交替写同一个网页对话——所以这里不分发送模式都要告警。
      console.warn(
        '[deepseek-web] turnTimeoutMs=0：单个网页回合没有上限，'
        + `${sendMode === 'manual' ? '人工等待可能无限长' : '卡住的回合不会被收尾'}，`
        + '一旦超出租约会被强制放锁，建议保留有限的 turnTimeoutMs。',
      )
    }
    const { maxConcurrentTurns, maxSessionPages } = this.config
    if (maxConcurrentTurns > 0 && maxConcurrentTurns > maxSessionPages) {
      console.warn(
        `[deepseek-web] maxConcurrentTurns(${maxConcurrentTurns}) 大于 maxSessionPages(${maxSessionPages})：`
        + '并发名额比可用的会话标签页还多，多出来的请求会先等页面回收，建议让两者一致或把 maxSessionPages 调大。',
      )
    }
  }

  /** 按会话取锁：首次使用时创建，释放后由 releaseLock() 回收（锁本身无状态，只有排队链）。 */
  private lockFor(key: string): AsyncLock {
    let lock = this.sessionLocks.get(key)
    if (!lock) {
      lock = new AsyncLock()
      this.sessionLocks.set(key, lock)
    }
    return lock
  }

  /**
   * 释放后回收空闲锁。
   *
   * 为什么要有：锁是按会话（以及「会话::用途」）建的，会话结束没有任何回调通知插件，
   * 不回收就是每开一个新会话永久留下一个锁对象——长跑宿主 + 大量子代理会话会慢慢涨。
   * 只在 busy=false（没人持有、没人排队）时删：此时 Map 里删掉不会有第二个持有者，
   * 下一个请求会重新建一把新锁，语义与复用等价。
   */
  private releaseLock(key: string, lock: AsyncLock): void {
    if (this.sessionLocks.get(key) !== lock) return
    if (lock.busy) return
    this.sessionLocks.delete(key)
  }

  /** 读取通道 token 用量总计（宿主注册设置命名空间时用作初始值）。 */
  getChannelTotals(): ChannelTokenTotals {
    return this.sessions.getChannelTotals()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek Web（免费网页版）' }
  }

  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(
      WEB_MODEL_IDS.map((id: WebModelId) => {
        const cap = WEB_MODEL_CAPABILITIES[id]!
        return {
          provider: 'deepseek-web',
          id,
          name: cap.label,
          description: '通过你的 DeepSeek 网页账号对话；模式（极速/专家/识图、深度思考、联网）由网页端自行选择。',
          // 只在上传可用时声明 image：否则宿主会按"未知能力"照发 ImageBlock，
          // 我们却只能把它降级成文本标记，模型会误以为看到了图。
          inputModalities: this.config.enableImageUpload ? ['text', 'image'] : ['text'],
        }
      }),
    )
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const normalized = normalizeWebModel(model)
    if (!normalized) {
      throw new LlmError(`deepseek-web: 未知网页模型 ${model}`, 'UNKNOWN_MODEL')
    }
    return {
      provider,
      id: model,
      name: WEB_MODEL_CAPABILITIES[normalized]!.label,
      context: { contextWindow: CONTEXT_WINDOW },
      defaultMaxTokens: MAX_TOKENS,
    }
  }

  /**
   * 驱动一轮网页对话：仅在用户开启 liveThinking 时，把网页真实思考增量
   * 作为 reasoning 块实时 yield 给 Harness；正文在解析后单独输出。
   *
   * `blocks.next` 是本次 stream() 内下一个空闲内容块序号：每次 driveTurn
   * 消耗一个 reasoning 块并自增；调用方最后把它作为正文/工具块的起始序号，
   * 保证同一条助手消息内所有块序号互不冲突。
   */
  private async *driveTurn(
    request: Omit<BrowserTurnRequest, 'onProgress'>,
    blocks: { next: number },
  ): AsyncGenerator<StreamChunk, BrowserTurnResult> {
    const pipe = new TurnProgressPipe()
    const reasoningIndex = blocks.next++
    let opened = false
    let reasoningText = ''
    /*
     * 提示通道：插件自己的状态（已发送 / 已接收 / 频控等待 / 失败）也写进这个
     * reasoning 块，前缀 `[DSH]` / `[DSH·审核]` 由 notify.ts 统一加。
     *
     * 为什么不另开一个块：Harness 要求块按 index 递增开启，而「模型先思考」与
     * 「插件先提示」两种顺序都可能出现，两个块会撞顺序约束；提示本身就是过程
     * 信息，和思考同块、按真实时间交错最自然。
     */
    const appendNotice = (text: string): void => {
      if (!opened) {
        opened = true
        pipe.push({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' })
      }
      const line = reasoningText === '' ? text : `\n${text}`
      reasoningText += line
      pipe.push({ type: 'reasoning-delta', index: reasoningIndex, text: line })
    }
    const turnPromise = this.channel.turn({
      ...request,
      // 内部辅助（上下文压缩、起标题）不给用户添噪声：只对真实对话出提示。
      ...(request.purpose === undefined
        ? { onNotice: (notice: NoticePayload) => { appendNotice(notice.text) } }
        : {}),
      onProgress: (progress) => {
        if (this.config.liveThinking !== true || !progress.reasoning) return
        if (!opened) {
          opened = true
          pipe.push({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' })
        }
        reasoningText += progress.reasoning
        pipe.pushProgress(progress, reasoningIndex)
      },
    }).then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    )
    for (;;) {
      for (const chunk of pipe.takeAll()) yield chunk
      const raced = await Promise.race([
        turnPromise,
        pipe.wait().then(() => 'progress' as const),
      ])
      if (raced === 'progress') continue
      for (const chunk of pipe.takeAll()) yield chunk
      if (!raced.ok) {
        if (opened) {
          yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } }
        }
        throw raced.error
      }
      /*
       * 用最终解析出的完整思考兜底，修两种“思考到一半就没动静”：
       *
       * 1. 通道不支持流式思考（Kimi / GLM 走完整解析）：开到“展示思考”却一个块都没有，
       *    这里整块补上，让用户至少能在结束时看到完整思考。
       * 2. 流式中途断了或错位（网页重连导致跨 entry 拼接错位）：以最终解析结果为准，
       *    把缺的尾巴补上，而不是让界面停在半截。
       */
      if (this.config.liveThinking === true) {
        const finalReasoning = raced.value.reasoning ?? ''
        if (finalReasoning.length > 0 && !opened) {
          opened = true
          reasoningText = finalReasoning
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
          yield { type: 'reasoning-delta', index: reasoningIndex, text: finalReasoning }
        } else if (finalReasoning.length > reasoningText.length && finalReasoning.startsWith(reasoningText)) {
          const tail = finalReasoning.slice(reasoningText.length)
          reasoningText = finalReasoning
          yield { type: 'reasoning-delta', index: reasoningIndex, text: tail }
        }
      }
      if (opened) {
        yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } }
      }
      return raced.value
    }
  }

  /**
   * driveTurn 的自动轮换包装：网页端提示对话长度达到上限时，生成任务简报、
   * 轮换到全新网页对话，并以「协议 + 工具目录 + 任务简报 + 原消息」重发本轮（仅重试一次）。
   */
  private async *driveTurnAuto(
    request: Omit<BrowserTurnRequest, 'onProgress'>,
    blocks: { next: number },
    state: WebChatState,
    options: GenerateOptions,
  ): AsyncGenerator<StreamChunk, BrowserTurnResult> {
    const reply = yield* this.driveTurn(request, blocks)
    if (reply.contextLengthExceeded !== true) return reply

    console.info('[deepseek-web] 网页提示对话长度达到上限，生成任务简报并轮换新对话…')
    const brief = buildHandoffBrief(options, state)
    // 原消息若已带协议前缀则剥掉，避免与新对话首条消息里的协议重复
    const bodyText = stripProtocolPrefix(request.text)
    const catalog = buildToolCatalog(visibleToolsOf(options, this.config), this.config.compactToolCatalog, this.config.maxToolCatalogChars)
    const retryText = [
      systemProtocolFor(this.config.enableImageUpload),
      catalog && `当前任务上下文可用的工具：\n${catalog}`,
      brief,
      bodyText,
    ].filter(Boolean).join('\n\n')

    await this.channel.startNewConversation?.(request.sessionId)
    // 新网页对话从零累计：token 基线清零；协议已随重发注入
    state.usageBaseline = 0
    state.roundsSinceProtocol = 0

    const retry = yield* this.driveTurn({ ...request, text: retryText, initialize: true }, blocks)
    if (retry.contextLengthExceeded === true) {
      throw new LlmError(
        'deepseek-web: 轮换到新对话后仍提示达到长度上限，请人工检查网页状态。',
        'WEB_CONTEXT_LENGTH_AGAIN',
      )
    }
    console.info('[deepseek-web] 已在新对话注入任务简报并完成本轮重发。')
    return retry
  }

  /**
   * 记录一轮网页回复上报的会话累计 token 用量（accumulated_token_usage），
   * 返回本轮增量。新网页对话（initialize）基线为 0；dsh 重启后附着到已有
   * 网页对话的首个观测值只作基线、不计增量（之前轮次的消耗无法回溯）。
   */
  private accountUsage(reply: BrowserTurnResult, state: WebChatState, initialize: boolean): number {
    const accumulated = reply.accumulatedUsage
    if (typeof accumulated !== 'number' || !Number.isFinite(accumulated)) return 0
    const baseline = typeof state.usageBaseline === 'number'
      ? state.usageBaseline
      : initialize ? 0 : accumulated
    state.usageBaseline = accumulated
    return Math.max(0, Math.round(accumulated - baseline))
  }

  /** 台账摘要（设置页只读卡片 / 自检读）。 */
  async ledgerSummary(): Promise<LedgerSummary> {
    await this.ledger.load()
    return this.ledger.summary()
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const sessionId = options.sessionId ?? 'anonymous'
    // 台账的 `at` 用「真正开始打网页」的时刻，而不是进入 stream 的时刻：
    // 排队等会话锁/并发名额的时间不该算进相邻对话间隔，否则台账会把排队误报成请求过密。
    let webStartedAt = Date.now()
    // 失败码只在 catch 里赋值；finally 用它记台账（成功时为 undefined）。
    let failureCode: string | undefined
    // 锁粒度 = 会话。不同会话（主会话 vs 它派生的子代理）各自持锁、各自用网页标签页，
    // 可以真并行；同一会话的多个网页回合仍然串行，因为共用一个网页对话。
    // 辅助请求（compaction / session-title）走一次性临时标签页，锁键再带上 purpose：
    // 既不排在主请求整轮生成后面，也不挡住同一会话的后续请求。
    const lockKey = options.purpose !== undefined ? `${sessionId}::${options.purpose}` : sessionId
    const lock = this.lockFor(lockKey)
    let release: (() => void) | undefined
    let gateRelease: (() => void) | undefined
    let completed = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let queueLog: ReturnType<typeof setTimeout> | undefined
    const releaseOnce = (): void => {
      const fn = release
      release = undefined
      fn?.()
    }
    try {
      // 排队超过 3 秒才打印：同会话的上一个网页回合还没结束（网页对话必须串行，属预期），
      // 让用户能区分"在排队"与"卡死了"。
      queueLog = setTimeout(() => {
        console.info(
          `[deepseek-web] 会话 ${sessionId} 排队中：该会话上一个网页回合仍未结束（同一网页对话必须串行）。`,
        )
      }, 3_000)
      ;(queueLog as unknown as { unref?: () => void }).unref?.()
      release = await lock.acquire(options.signal, {
        maxHoldMs: this.config.lockLeaseMs,
        onLeak: info => console.warn(
          `[deepseek-web] 会话锁超过租约被强制回收：key=${lockKey} 已持有 ${Math.round(info.heldMs / 1000)}s，`
          + `仍有 ${info.waiters} 个请求在排队。强制释放以恢复服务。`,
        ),
      })

      if (queueLog) {
        clearTimeout(queueLog)
        queueLog = undefined
      }

      // 会话锁只保证"同一会话串行"；名额池保证"同时打网页的请求不超过 maxConcurrentTurns"。
      // 顺序必须是先会话锁后名额：反过来的话，同一会话的第 2、3 个请求会抱着全局名额
      // 等自己的会话锁，白白占住名额把别的会话饿死。
      const gateStartedAt = Date.now()
      gateRelease = await this.gate.acquire(options.signal, {
        onWait: info => console.info(
          `[deepseek-web] 并发上限 ${info.limit} 已满，会话 ${sessionId} 排队中：`
          + `前面还有 ${Math.max(0, info.pending - 1)} 条请求，已等 ${Math.round(info.waitedMs / 1000)}s（先进先出逐个放行）。`,
        ),
      })
      const gateWaitedMs = Date.now() - gateStartedAt
      // 名额到手才算「真的开始打网页」：排队时间不计入台账的请求间隔。
      webStartedAt = Date.now()
      const gateStats = this.gate.stats()
      if (gateWaitedMs >= 500 || gateStats.pending > 0) {
        console.info(
          `[deepseek-web] 取得并发名额 session=${sessionId}（active=${gateStats.active}/${gateStats.limit || '∞'}，`
          + `排队=${gateStats.pending}，本次等待 ${Math.round(gateWaitedMs / 1000)}s）。`,
        )
      }

      // 整条流的兜底上限：无论卡在人工发送、频控重试还是网页不响应，
      // 到点主动取消网页回合，让这次请求以明确错误结束，而不是永远"生成中"。
      const maxStreamMs = this.config.maxStreamMs
      if (maxStreamMs && maxStreamMs > 0) {
        watchdog = setTimeout(() => {
          console.warn(
            `[deepseek-web] 本次请求超过 ${Math.round(maxStreamMs / 60_000)} 分钟仍未结束，`
            + `主动取消网页回合（session=${sessionId}）。可用 maxStreamMs 调整，设为 0 关闭。`,
          )
          const cancelling = this.channel.cancelTurn?.(sessionId)
          if (cancelling) void cancelling.catch(() => {})
        }, maxStreamMs)
        ;(watchdog as unknown as { unref?: () => void }).unref?.()
      }

      if (options.purpose !== undefined) {
        yield* this.streamAuxiliary(options)
        completed = true
      } else {
        try {
          yield* this.streamTask(options)
          completed = true
          this.replaySessions.delete(sessionId)
        } finally {
          if (!completed) this.replaySessions.add(sessionId)
        }
      }
    } catch (error) {
      // 台账只记分类，不记正文：把失败码留下来给 finally 用。
      failureCode = error instanceof LlmError ? error.code : 'WEB_TURN_FAILED'
      throw error
    } finally {
      if (queueLog) clearTimeout(queueLog)
      if (watchdog) clearTimeout(watchdog)
      if (!completed && options.purpose === undefined) {
        // 宿主放弃本次生成（取消 / 切换会话 / 迭代器被 return）时，主动结束仍挂在
        // 网页上的回合：否则后台 turn 会一直占着该会话的网页标签页，让后续请求干等。
        const cancelling = this.channel.cancelTurn?.(sessionId)
        if (cancelling) void cancelling.catch(() => {})
      }
      const releaseGate = gateRelease
      gateRelease = undefined
      releaseGate?.()
      releaseOnce()
      this.releaseLock(lockKey, lock)
      // 记账放在放锁之后：台账写盘再慢也不该占着并发名额。
      // 仍然要 await：台账文件与状态文件同目录，调用方（尤其是离线回归）
      // 会在流结束后立刻清理临时目录，后台写盘会撞上「目录已删 / 非空」。
      await this.recordLedger(options, webStartedAt, completed, failureCode)
    }
  }

  /**
   * 往调用台账记一笔（元信息，不含正文）。
   *
   * 失败分类复用 cooldown 的归类口径，保证「进冷却」与「台账里算失败」是同一套判据，
   * 不会出现台账显示一片正常、实际却已经被限流的情况。
   */
  private async recordLedger(
    options: GenerateOptions,
    startedAt: number,
    completed: boolean,
    failureCode: string | undefined,
  ): void {
    const purpose: LedgerPurpose = options.purpose === undefined
      ? 'chat'
      : options.purpose === 'compaction' || options.purpose === 'session-title'
        ? 'auxiliary'
        : 'review'
    const kind = classifyFailureCode(failureCode)
    const entry: LedgerEntry = {
      at: startedAt,
      purpose,
      outcome: completed ? 'ok' : 'failed',
      durationMs: Date.now() - startedAt,
      ...completed ? {} : { failure: toLedgerFailure(kind, failureCode), ...failureCode !== undefined ? { code: failureCode } : {} },
    }
    try {
      await this.ledger.record(entry)
    } catch {
      // 台账是观测工具，任何写入失败都不该影响真实发送
    }
  }

  /** 摘要和标题是独立的一次性请求；不能解析成动作或进入普通会话状态机。 */
  private async *streamAuxiliary(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (!normalizeWebModel(options.model)) throw new LlmError('未知网页模型', 'UNKNOWN_MODEL')
    if (!this.channel.turnIsolated) {
      throw new LlmError('当前浏览器通道不支持隔离辅助请求，请升级通道实现。', 'WEB_AUXILIARY_UNSUPPORTED')
    }
    await this.sessions.load()
    console.info(`[deepseek-web] 内部辅助请求开始：${options.purpose}；使用临时网页对话，结束后关闭。`)
    const reply = await this.channel.turnIsolated({
      sessionId: options.sessionId ?? 'anonymous',
      model: options.model,
      text: buildAuxiliaryPrompt(options, this.config.compactionLanguage),
      initialize: true,
      autoSend: options.model === 'deepseek-web-auto',
      purpose: options.purpose,
      signal: options.signal,
    })
    options.signal?.throwIfAborted()
    if (reply.contextLengthExceeded) {
      throw new LlmError('辅助请求历史超过网页上下文上限；保留原任务，请配置独立摘要模型或缩小压缩范围。', 'CONTEXT_WINDOW_EXCEEDED')
    }
    if (reply.finishReason === 'interrupted') throw new LlmError('辅助请求被网页中断，摘要未提交。', 'WEB_REPLY_INTERRUPTED')
    if (!reply.text.trim() && reply.finishReason !== 'max-tokens') {
      throw new LlmError('辅助请求没有返回正文，摘要未提交。', 'WEB_EMPTY_RESPONSE')
    }
    if (reply.accumulatedUsage !== undefined && reply.accumulatedUsage > 0) {
      const totals = this.sessions.addChannelTokens(reply.accumulatedUsage)
      this.onUsage?.(totals)
      await this.sessions.save()
      // 网页仅提供累计总量，不能伪报为输出 token；保留独立通道统计。
    }
    // 原样文本返回：即使摘要里包含 actions 示例，也不能变成可执行工具调用。
    console.info(`[deepseek-web] 内部辅助请求结束：${options.purpose}；摘要供宿主使用，普通任务状态保持。`)
    for (const chunk of replyChunks({ hasActions: false, actions: [], text: reply.text })) {
      yield chunk.type === 'finish' && reply.finishReason === 'max-tokens'
        ? { type: 'finish', reason: { kind: 'max-tokens' } } : chunk
    }
  }

  /**
   * 把本轮图片引用读成可以上传的字节。
   * 单张读失败按 `uploadOnError` 处理：`abort` 直接抛错；`fallback-text` 跳过该张，
   * 正文里仍留着 `[附图: 文件名]` 标记，但该张确实没上去（不会假装成功）。
   *
   * 同一张图在**同一轮**里只上传一次：按字节 sha256 去重。网页端对重复的
   * `ref_file_ids` 会整轮拒绝（并让该会话后续每轮都失败），而宿主完全可能把同
   * 一张图以两个 attachmentId 交过来（例如用户重复拖入、或压缩后重现）。去重只影响
   * 上传列表，`[附图: N]` 标记与正文顺序保持不变。
   */
  private async loadAttachments(
    refs: readonly ImageAttachmentRef[],
    signal?: AbortSignal,
  ): Promise<BrowserImageAttachment[] | undefined> {
    if (!this.readImage) return undefined
    const loaded: BrowserImageAttachment[] = []
    const seen = new Set<string>()
    for (const ref of refs) {
      signal?.throwIfAborted()
      try {
        const image = await this.readImage(ref)
        if (!image) continue
        const digest = createHash('sha256').update(image.data).digest('hex')
        if (seen.has(digest)) {
          console.info(`[deepseek-web] 同一张图本轮已上传过，跳过重复附件：${image.name}`)
          continue
        }
        seen.add(digest)
        loaded.push(image)
      } catch (error) {
        if (this.config.uploadOnError === 'abort') {
          throw new LlmError(
            `deepseek-web: 读取图片附件失败（${ref.attachmentId.slice(0, 24)}）：`
            + `${error instanceof Error ? error.message : String(error)}`,
            'WEB_IMAGE_READ_FAILED',
            { cause: error },
          )
        }
        console.warn(
          `[deepseek-web] 跳过一张读不出的图片附件：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return loaded.length > 0 ? loaded : undefined
  }

  private checkReplyEnd(reply: BrowserTurnResult): void {
    if (reply.finishReason === 'interrupted') throw new LlmError('网页明确报告回复被中断，请重试当前任务。', 'WEB_REPLY_INTERRUPTED')
    if (reply.finishReason === 'max-tokens') throw new LlmError('网页回复达到输出上限，未作为完整交付提交，请缩小单次任务后重试。', 'WEB_REPLY_TRUNCATED')
  }

  private async *streamTask(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const sessionId = options.sessionId ?? 'anonymous'
    await this.sessions.load()
    const model = options.model as WebModelId
    if (!normalizeWebModel(model)) {
      throw new LlmError(`deepseek-web: 未知网页模型 ${options.model}`, 'UNKNOWN_MODEL')
    }
    // 全自动模型（deepseek-web-auto）：填入后模拟回车发送，焦点全程留在 dsh；
    // 半自动（deepseek-web）：填入后网页置顶聚焦，等人工回车/点击。
    const autoSend = model === 'deepseek-web-auto'
    this.channel.setSessionAutoSend?.(sessionId, autoSend)
    this.channel.setSessionAutoSend?.('deepseek-self-review', autoSend)
    // 记录"当前 agent 会话"：同对话自审（preserveConversation）要落回这个会话的网页页，
    // 多会话并行时不能落到"最近用过的页"（那可能是子代理的页）。
    this.channel.setConversationFocus?.(sessionId)

    await this.channel.ensureReady()

    const savedState = this.sessions.for(sessionId)
    // 成功消费完整结果后才提交；失败或取消不能提前推进游标/同步标记。
    const state = { ...savedState }

    const goalBefore = state.goalText
    const forceReplay = this.replaySessions.has(sessionId)
      || this.channel.isConversationActive?.(sessionId) === false
    const rendered = renderNewWebMessages(options, state, this.config, forceReplay, this.readImage !== undefined)
    if (state.goalText !== goalBefore) {
      // 新的用户任务：重置审核计数
      state.reviewRoundsUsed = 0
      state.reviewedSignature = undefined
    }
    if (!rendered) {
      // 无新增内容却要求生成：直接让模型空转一次也不会损坏会话
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    // 图片直传：把本轮引用读成字节，随请求交给通道上传。
    // 读不出时按 uploadOnError 决定抛错还是跳过（跳过则文本里仍有 [附图] 标记，
    // 模型不会假装看过——那个标记在开关开启时不代表"已上传成功"）。
    const attachments = rendered.prompt.attachments?.length
      ? await this.loadAttachments(rendered.prompt.attachments, options.signal)
      : undefined

    // 初始化只更新本轮快照；完整结果被消费后再提交持久状态。
    if (rendered.prompt.initialize) {
      if (savedState.initialized) console.info('[deepseek-web] 宿主上下文或页面归属变化，重建工作网页对话并回放检查点；继续原 dsh 会话。')
      this.channel.resetConversationGate(sessionId)
      state.initialized = true
      state.usageBaseline = 0
    }

    // 需要人工/浏览器确认的轮次在 turn() 内部完成；异常时给出可诊断错误。
    // blocks 记录本次助手消息的内容块序号水位：实时思考流每轮占一个块。
    const blocks = { next: 0 }
    // 本轮（一次模型调用）内各网页回合上报的 token 用量增量之和
    let usageDeltaSum = 0
    let usageObserved = false
    let reply: BrowserTurnResult
    try {
      reply = yield* this.driveTurnAuto({
        sessionId,
        model,
        text: rendered.prompt.text,
        attachments,
        initialize: rendered.prompt.initialize,
        autoSend,
        signal: options.signal,
      }, blocks, state, options)
      usageDeltaSum += this.accountUsage(reply, state, rendered.prompt.initialize)
      usageObserved = usageObserved || reply.accumulatedUsage !== undefined
    } catch (error) {
      if (error instanceof LlmError) throw error
      throw new LlmError(
        `deepseek-web: 网页对话失败: ${error instanceof Error ? error.message : String(error)}`,
        'WEB_TURN_FAILED',
        { cause: error },
      )
    }

    this.checkReplyEnd(reply)
    let parsed = parseWebReply(reply.text)
    const visibleTools = visibleToolsOf(options, this.config)
    const allowedToolNames = new Set(visibleTools.map(tool => tool.name))
    const toolSchemas = new Map(visibleTools.map(tool => [tool.name, tool]))
    // 委托工具（如 web_search/web_fetch）不进入本地校验与执行：
    // 拆分后在下一轮把查询转交网页端自带能力，结果并入正文。
    const delegatedNames = new Set(this.config.delegatedTools)
    let delegatedActions = splitDelegatedActions(parsed.actions, delegatedNames)
    let problems: ActionProblem[] = []
    let correctedChars = 0
    let delegatedChars = 0
    let delegatedTurns = 0

    const revalidate = (): void => {
      delegatedActions = splitDelegatedActions(parsed.actions, delegatedNames)
      const delegatedSet = new Set(delegatedActions)
      const local = parsed.actions.filter(action => !delegatedSet.has(action))
      const outcome = parsed.hasActions && (local.length > 0 || delegatedActions.length === 0)
        ? repairAndValidateActions(local, allowedToolNames, toolSchemas)
        : { actions: local, problems: [] as ActionProblem[] }
      parsed = { ...parsed, actions: outcome.actions, hasActions: local.length > 0 }
      problems = outcome.problems
    }
    revalidate()

    /**
     * 游标只在完整 chunk 流交给上层之后再落盘：
     * 进程若在回合中途被杀，游标不会超前于 Harness 会话日志。
     */
    const advanceAndSave = async (): Promise<void> => {
      options.signal?.throwIfAborted()
      const lastIdentified = [...options.messages].reverse().find(message => message.id)
      state.lastMessageId = lastIdentified?.id
      state.roundsSinceProtocol = rendered.prompt.includeProtocol ? 0 : state.roundsSinceProtocol + 1
      state.lastReply = reply.text
      Object.assign(savedState, state)
      await this.sessions.save()
    }

    // 格式漂移自愈：明显是想调工具但没给出合法 JSON 时，注入纠错再等一轮人工发送。
    // 委托动作是合法意图（本地不执行），不触发纠错。
    if (
      this.config.autoCorrectMalformed !== false
      && delegatedActions.length === 0
      && (
        problems.length > 0
        || (
          !parsed.hasActions
          && (
            looksLikeIntendedToolReply(reply.text)
            || looksLikeUnfinishedHandoff(reply.text, state.goalText ?? '')
            || looksLikeTaskRequest(reply.text)
            || ((options.tools?.length ?? 0) > 0 && looksLikeToolDenial(reply.text))
          )
        )
      )
    ) {
      const reviewNote = problems.length > 0
        ? `\n\n本地审查未通过，请修正后重新输出：\n${
          problems.map(item => `- actions[${item.index}]${item.tool ? ` (${item.tool})` : ''}: ${item.problem}`).join('\n')
        }`
        : ''
      let correctedReply
      try {
        correctedReply = yield* this.driveTurnAuto({
          sessionId,
          model,
          text: `${buildRecoveryPrompt(options, state, this.config)}${reviewNote}`,
          initialize: false,
          autoSend,
          signal: options.signal,
        }, blocks, state, options)
      } catch (error) {
        throw new LlmError(
          'deepseek-web: 已请求模型纠正输出格式，但等待网页发送超时。'
          + '请在浏览器中点击发送以完成纠错。',
          'WEB_CORRECTION_TIMEOUT',
          { cause: error },
        )
      }
      usageDeltaSum += this.accountUsage(correctedReply, state, false)
      usageObserved = usageObserved || correctedReply.accumulatedUsage !== undefined
      reply = correctedReply
      this.checkReplyEnd(reply)
      parsed = parseWebReply(correctedReply.text)
      revalidate()
      correctedChars += correctedReply.text.length + reviewNote.length
    }

    if (problems.length > 0) {
      console.warn(
        '[deepseek-web] 本地审查拒绝执行，模型原始输出：',
        reply.text.slice(0, 800),
      )
      throw new LlmError(`本地审查拒绝执行：${
        problems.map(item => `actions[${item.index}]${item.tool ? ` (${item.tool})` : ''} ${item.problem}`).join('；')
      }`, 'WEB_ACTION_REJECTED')
    }

    if (!parsed.hasActions && delegatedActions.length === 0 && looksLikeIntendedToolReply(reply.text)) {
      throw new LlmError('网页工具调用格式仍无法完整解析，未作为最终交付提交；请重试当前任务。', 'MALFORMED_TOOL_CALL')
    }

    // 网页委托：把委托动作转成下一轮提示词，交给网页端自带能力执行（如联网搜索/网页阅读），
    // 每次委托多一轮人工发送；结果并入正文，本地动作照常交给 Harness 执行。
    if (delegatedActions.length > 0) {
      const sections: string[] = []
      for (const action of delegatedActions) {
        const name = action.tool ?? action.action ?? ''
        const prompt = buildDelegationPrompt(name, action)
        if (!prompt) {
          console.warn('[deepseek-web] 委托动作缺少可识别参数，已跳过：', name)
          continue
        }
        let outcome
        try {
          outcome = yield* this.driveTurnAuto({
            sessionId,
            model,
            text: prompt,
            initialize: false,
            autoSend,
            signal: options.signal,
          }, blocks, state, options)
        } catch (error) {
          throw new LlmError(
            `deepseek-web: 工具委托轮失败（${name}）。请在浏览器中点击发送以完成委托。: ${error instanceof Error ? error.message : String(error)}`,
            'WEB_DELEGATION_FAILED',
            { cause: error },
          )
        }
        usageDeltaSum += this.accountUsage(outcome, state, false)
        this.checkReplyEnd(outcome)
        usageObserved = usageObserved || outcome.accumulatedUsage !== undefined
        const outcomeParsed = parseWebReply(outcome.text)
        // maxToolResultChars 只限制送入网页模型的工具结果，不截断用户收到的正文。
        sections.push(`[${name} 委托结果]\n${outcomeParsed.text}`)
        delegatedChars += prompt.length + outcome.text.length
        delegatedTurns += 1
      }
      if (sections.length > 0) {
        // 原回复是委托动作 JSON，交付时只显示委托结果。
        parsed = { ...parsed, text: sections.join('\n\n') }
      }
    }

    // 可选审核（Kimi / GLM / DeepSeek 自审）：仅对“最终正文”生效，最多审核 maxRounds 轮。
    // 结论名称按当前审核器动态生成，避免固定写成 Kimi。
    const reviewLabel = this.config.review.provider === 'kimi' ? 'Kimi'
      : this.config.review.provider === 'glm' ? 'GLM'
      : 'DeepSeek'
    let reviewSummary: string | undefined
    /*
     * 审核提示单独成块，与会话提示分开（用户明确要求两类消息不能搅成一锅）。
     *
     * 位置安全：审核发生在正文产出之后，此时 blocks.next 已越过正文起始位，
     * 新块严格递增，不会违反「块按 index 顺序开启」的约束。
     */
    let reviewNoticeIndex = -1
    let reviewNoticeText = ''
    const reviewLines = (event: NoticeEvent, detail: string): readonly StreamChunk[] => {
      if (!noticeEnabled(this.config.notify, 'review', event)) return []
      const text = formatNotice({ category: 'review', event, detail })
      if (reviewNoticeIndex < 0) {
        reviewNoticeIndex = blocks.next++
        reviewNoticeText = text
        return [
          { type: 'block-start', index: reviewNoticeIndex, blockType: 'reasoning' },
          { type: 'reasoning-delta', index: reviewNoticeIndex, text },
        ]
      }
      const line = `\n${text}`
      reviewNoticeText += line
      return [{ type: 'reasoning-delta', index: reviewNoticeIndex, text: line }]
    }
    const reviewBlockEnd = (): readonly StreamChunk[] => (
      reviewNoticeIndex < 0
        ? []
        : [{ type: 'block-end', index: reviewNoticeIndex, block: { type: 'reasoning', text: reviewNoticeText } }]
    )
    if (
      !parsed.hasActions
      && this.reviewer
      && this.config.review.enabled
      && this.config.review.maxRounds > 0
      && state.reviewRoundsUsed < this.config.review.maxRounds
      && state.reviewedSignature !== reviewSignature(state.goalText ?? '', parsed.text)
    ) {
      for (const chunk of reviewLines('send', `${reviewLabel} 审核：开始检查本轮产出…`)) yield chunk
      let reviewRound = 0
      while (reviewRound < this.config.review.maxRounds) {
        reviewRound++
        const signature = reviewSignature(state.goalText ?? '', parsed.text)
        const evidence = this.reviewer.needsEvidence
          ? await buildReviewEvidence(options, state, parsed.text, this.config.review.maxEvidenceChars)
          : { task: state.goalText ?? '', artifact: '', files: [] }
        let verdict: ReviewVerdict
        try {
          verdict = await this.reviewer.review(evidence, { conversationSessionId: sessionId })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          console.warn(`[deepseek-web] ${reviewLabel} 审核失败，跳过本轮审核：`, reason)
          for (const chunk of reviewLines('error', `${reviewLabel} 审核失败，已跳过本轮审核：${reason}`)) yield chunk
          break
        }
        state.reviewRoundsUsed += 1
        state.reviewedSignature = signature
        console.info(`[deepseek-web] ${reviewLabel} 审核结果：ok=${verdict.ok} issues=${verdict.issues.length}`)
        if (verdict.ok) {
          reviewSummary = [
            `✅ ${reviewLabel} 审核：通过`,
            verdict.suggestions.length > 0 ? `建议：${verdict.suggestions.slice(0, 3).join('；')}` : '',
          ].filter(Boolean).join('；')
          for (const chunk of reviewLines('receive', reviewSummary)) yield chunk
          break
        }
        reviewSummary = [
          `⚠️ ${reviewLabel} 审核（首版）：未通过，已回注修正`,
          verdict.issues.length > 0 ? `问题：${verdict.issues.slice(0, 3).join('；')}` : '',
          verdict.suggestions.length > 0 ? `建议：${verdict.suggestions.slice(0, 3).join('；')}` : '',
        ].filter(Boolean).join('；')
        for (const chunk of reviewLines('receive', reviewSummary)) yield chunk
        const feedback = [
          '[审核反馈] 独立审核员认为当前产出未通过审核，请修正后重新输出。',
          verdict.issues.length > 0 ? `问题：\n${verdict.issues.map(item => `- ${item}`).join('\n')}` : '',
          verdict.suggestions.length > 0 ? `建议：\n${verdict.suggestions.map(item => `- ${item}`).join('\n')}` : '',
          state.goalText ? `${WEB_MARKERS.goal}\n${state.goalText}` : '',
          '若需要调用工具，请只输出 JSON 动作；否则输出修正后的最终正文。',
        ].filter(Boolean).join('\n\n')
        const revised = yield* this.driveTurnAuto({
          sessionId,
          model,
          text: feedback,
          initialize: false,
          autoSend,
          signal: options.signal,
        }, blocks, state, options)
        usageDeltaSum += this.accountUsage(revised, state, false)
        usageObserved = usageObserved || revised.accumulatedUsage !== undefined
        reply = revised
        this.checkReplyEnd(reply)
        parsed = parseWebReply(revised.text)
        revalidate()
        correctedChars += revised.text.length + feedback.length
        if (problems.length > 0) break
        if (parsed.hasActions) break
      }
    }

    // 审核块收尾：必须在正文块开启（下方 replyChunks）之前关闭，
    // 否则会变成「块 1 还没结束就开块 2」，前端按块渲染时会出现串台。
    for (const chunk of reviewBlockEnd()) yield chunk

    if (!parsed.hasActions && looksLikeUnfinishedHandoff(parsed.text, state.goalText ?? '')) {
      throw new LlmError('网页仍返回未完成的任务交接摘要，未作为最终交付提交；请重试当前任务。', 'WEB_UNFINISHED_HANDOFF')
    }
    if (problems.length > 0) throw new LlmError('审核修正后的工具调用未通过本地校验。', 'WEB_ACTION_REJECTED')
    if (!parsed.hasActions && looksLikeIntendedToolReply(parsed.text)) {
      throw new LlmError('网页仍返回无法解析的工具调用，未作为最终交付提交。', 'MALFORMED_TOOL_CALL')
    }

    // 网页对话（含审核）完全结束、正文即将交给 Harness 呈现给用户时：
    // 半自动——取消网页置顶并把 dsh 窗口带到最前；全自动——焦点全程留在 dsh，不动窗口。
    if (!parsed.hasActions) {
      if (autoSend) {
        // 全自动不做任何窗口切换
      } else {
        await this.channel.setWebWindowTopmost?.(sessionId, false).catch(() => {})
        if (this.config.focus?.enabled !== false && this.config.focus?.dshWindow !== false) {
          await this.channel.focusHarness().catch(() => {})
        }
      }
    }

    if (parsed.hasActions) {
      state.lastParseOk = true
    } else {
      state.lastParseOk = false
    }

    if (usageObserved) {
      const totals = usageDeltaSum > 0
        ? this.sessions.addChannelTokens(usageDeltaSum)
        : this.sessions.getChannelTotals()
      this.onUsage?.(totals)
      console.info(
        `[deepseek-web] 本轮 token 用量：${usageDeltaSum}（网页会话累计 ${String(state.usageBaseline)}），`
        + `通道总计：${totals.totalTokens} tokens / ${totals.usageTurns} 轮`,
      )
      // 无输入/输出分类的网页总量只进入通道统计，不进入宿主 TokenUsage。
    }

    yield* replyChunks(parsed, { startIndex: blocks.next, nextCallId: 1 })
    await advanceAndSave()
  }
}
