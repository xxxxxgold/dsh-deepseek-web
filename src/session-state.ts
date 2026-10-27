/**
 * dsh 会话与网页端对话的映射与推进游标。
 *
 * 网页端对话是权威上下文：我们不把整段历史反复发给模型，只推进
 * “已入网页对话”的游标。assistant 回复由模型自己生成并停留在页面上，
 * 所以只要把新增的 user / tool-result 转成网页消息追加即可。
 *
 * @module dsh-deepseek-web/session-state
 */

import { dirname } from 'node:path'

export interface WebChatState {
  /** 网页端对话标题/URL 标记，用于定位页面。 */
  webChatKey?: string
  /** Harness message id 游标：已处理到哪一条。 */
  lastMessageId?: string
  /** 自协议快照注入以来的轮数。 */
  roundsSinceProtocol: number
  /** 上一次回复文本（供解析/纠错使用）。 */
  lastReply?: string
  /** 最近一次解析是否成功。 */
  lastParseOk: boolean
  /** 是否已经给该网页对话发送过初始化（协议+首个任务）。 */
  initialized: boolean
  /** 当前用户任务锚点；工具轮次也随消息重申，防止模型反问“请提供任务”。 */
  goalText?: string
  /** 已使用的审核轮数（按任务目标计）。 */
  reviewRoundsUsed: number
  /** 上一次已审核产出的签名，避免同一产出重复送审。 */
  reviewedSignature?: string
  /** 网页端最近一次上报的会话累计 token 用量（accumulated_token_usage 基线）。 */
  usageBaseline?: number
  /** 上下文同步协议版本；旧状态首次使用时从宿主历史重建。 */
  contextVersion?: number
  /** 宿主压缩检查点指纹，检查点变化时重建网页对话。 */
  checkpointSignature?: string
  /** 已发送的宿主系统指令指纹。 */
  systemSignature?: string
  /**
   * 当前网页对话里已经上传成功的图片附件 id。
   *
   * 网页端对重复的 `ref_file_ids` 会整轮拒绝，且该会话此后每轮都失败；
   * 而宿主可能把同一张图以不同轮次反复交过来（历史回放、压缩后重现）。
   * 记下成功上传的 id，增量轮就能跳过已在对话里的图，不重传。
   * 网页对话重建（initialize）时由适配层重置为本次实际重传成功的集合。
   */
  uploadedImageIds?: string[]
  /**
   * 该 dsh 会话在网页端产生过的对话 id（一对多）。
   *
   * 网页对话在三种情况下会换新：会话初次打开、上下文超限轮换、页面归属变化重建。
   * 每轮回复结束后从页面 URL（/a/chat/s/<id>）解析并追加；归档时按此列表逐个删除。
   */
  webChatKeys?: string[]
}

/** 通道级 token 用量总计（跨 dsh 会话持久，随 session-state.json 保存）。 */
export interface ChannelTokenTotals {
  /** 累计消耗 token 总量（网页端 accumulated_token_usage 的逐轮增量之和）。 */
  totalTokens: number
  /** 已计入统计的模型回合数。 */
  usageTurns: number
  /** 最近一次计数更新时间（ISO）。 */
  updatedAt?: string
}

export interface SessionRegistryOptions {
  /** 持久化文件路径；缺省时不落盘（仅内存）。 */
  file?: string
}

export class SessionRegistry {
  private readonly chats = new Map<string, WebChatState>()
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()
  private channelTotals: ChannelTokenTotals = { totalTokens: 0, usageTurns: 0 }
  /** 已完成网页端清理的 dsh 会话（归档联动删除成功后记账）。 */
  private readonly cleanedSessions = new Set<string>()
  /** 清理失败记录：会话 id → 时间与原因。 */
  private readonly failedCleanups = new Map<string, { at: string; error: string }>()

  private readonly options: SessionRegistryOptions

  constructor(options: SessionRegistryOptions = {}) {
    this.options = options
  }

  /** 从磁盘加载一次；重复调用为空操作。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.options.file) return
    const { readFile } = await import('node:fs/promises')
    let raw: string
    try {
      raw = await readFile(this.options.file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      throw error
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const rawTotals = parsed.__channel_totals__ as Partial<ChannelTokenTotals> | undefined
      if (rawTotals && typeof rawTotals === 'object') {
        this.channelTotals = {
          totalTokens: Number.isSafeInteger(rawTotals.totalTokens) ? rawTotals.totalTokens! : 0,
          usageTurns: Number.isSafeInteger(rawTotals.usageTurns) ? rawTotals.usageTurns! : 0,
          ...rawTotals.updatedAt !== undefined ? { updatedAt: rawTotals.updatedAt } : {},
        }
      }
      const rawCleanup = parsed.__archive_cleanup__ as {
        cleaned?: unknown
        failed?: unknown
      } | undefined
      if (rawCleanup && typeof rawCleanup === 'object') {
        if (Array.isArray(rawCleanup.cleaned)) {
          for (const id of rawCleanup.cleaned) {
            if (typeof id === 'string' && id.length > 0) this.cleanedSessions.add(id)
          }
        }
        if (rawCleanup.failed && typeof rawCleanup.failed === 'object') {
          for (const [id, value] of Object.entries(rawCleanup.failed)) {
            if (!value || typeof value !== 'object') continue
            const record = value as { at?: unknown; error?: unknown }
            this.failedCleanups.set(id, {
              at: typeof record.at === 'string' ? record.at : '',
              error: typeof record.error === 'string' ? record.error : '',
            })
          }
        }
      }
      for (const [sessionId, value] of Object.entries(parsed)) {
        if (sessionId === '__channel_totals__') continue
        if (value && typeof value === 'object') {
          const rawState = value as Partial<WebChatState>
          this.chats.set(sessionId, {
            roundsSinceProtocol: typeof rawState.roundsSinceProtocol === 'number'
              && Number.isSafeInteger(rawState.roundsSinceProtocol)
              ? rawState.roundsSinceProtocol
              : 0,
            lastParseOk: rawState.lastParseOk !== false,
            initialized: rawState.initialized === true,
            ...rawState.lastMessageId === undefined ? {} : { lastMessageId: rawState.lastMessageId },
            ...rawState.lastReply === undefined ? {} : { lastReply: rawState.lastReply },
            ...rawState.webChatKey === undefined ? {} : { webChatKey: rawState.webChatKey },
            ...rawState.goalText === undefined ? {} : { goalText: rawState.goalText },
            reviewRoundsUsed: typeof rawState.reviewRoundsUsed === 'number'
              && Number.isSafeInteger(rawState.reviewRoundsUsed)
              ? rawState.reviewRoundsUsed
              : 0,
            ...rawState.reviewedSignature === undefined ? {} : { reviewedSignature: rawState.reviewedSignature },
            ...rawState.usageBaseline === undefined ? {} : { usageBaseline: rawState.usageBaseline },
            ...rawState.contextVersion === undefined ? {} : { contextVersion: rawState.contextVersion },
            ...rawState.checkpointSignature === undefined ? {} : { checkpointSignature: rawState.checkpointSignature },
            ...rawState.systemSignature === undefined ? {} : { systemSignature: rawState.systemSignature },
            ...Array.isArray(rawState.uploadedImageIds)
              ? {
                uploadedImageIds: [...new Set(
                  rawState.uploadedImageIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
                )],
              }
              : {},
            ...Array.isArray(rawState.webChatKeys)
              ? {
                webChatKeys: [...new Set(
                  rawState.webChatKeys.filter((id): id is string => typeof id === 'string' && id.length > 0),
                )],
              }
              : {},
          })
        }
      }
    } catch (error) {
      throw new Error(`deepseek-web: 会话状态文件损坏（${this.options.file}）：${String(error)}`)
    }
  }

  /** 全量写回磁盘（排队串行，临时文件 + rename）。 */
  async save(): Promise<void> {
    if (!this.options.file) return
    const snapshot = JSON.stringify({
      __channel_totals__: this.channelTotals,
      __archive_cleanup__: {
        cleaned: [...this.cleanedSessions],
        failed: Object.fromEntries(this.failedCleanups),
      },
      ...Object.fromEntries(this.chats),
    }, null, 2)
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const { mkdir, rename, writeFile } = await import('node:fs/promises')
      const file = this.options.file!
      const dir = dirname(file)
      if (dir) await mkdir(dir, { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, snapshot, 'utf8')
      await rename(tmp, file)
    })
    await this.writeQueue
  }

  /**
   * 记入一次通道 token 消耗并返回最新总量（跨 dsh 会话累计）。
   * @param delta - 本轮消耗的 token 增量。
   */
  addChannelTokens(delta: number): ChannelTokenTotals {
    if (!Number.isFinite(delta) || delta <= 0) return { ...this.channelTotals }
    this.channelTotals = {
      totalTokens: this.channelTotals.totalTokens + Math.round(delta),
      usageTurns: this.channelTotals.usageTurns + 1,
      updatedAt: new Date().toISOString(),
    }
    return { ...this.channelTotals }
  }

  /** 读取通道 token 用量总计。 */
  getChannelTotals(): ChannelTokenTotals {
    return { ...this.channelTotals }
  }

  for(sessionId: string): WebChatState {
    let state = this.chats.get(sessionId)
    if (!state) {
      state = {
        roundsSinceProtocol: 0,
        lastParseOk: true,
        initialized: false,
        reviewRoundsUsed: 0,
      }
      this.chats.set(sessionId, state)
    }
    return state
  }

  /** 移除会话游标并落盘。 */
  async dispose(sessionId: string): Promise<void> {
    this.chats.delete(sessionId)
    await this.save()
  }

  /**
   * 记一条该会话的网页对话 id（去重）。
   * @returns 是否新增（调用方据此决定要不要落盘）。
   */
  recordWebChatKey(sessionId: string, chatId: string): boolean {
    if (chatId.length === 0) return false
    const state = this.for(sessionId)
    const list = state.webChatKeys ?? []
    if (list.includes(chatId)) return false
    state.webChatKeys = [...list, chatId]
    return true
  }

  /** 该会话记录过的网页对话 id（只读快照）。 */
  webChatKeysFor(sessionId: string): readonly string[] {
    return this.chats.get(sessionId)?.webChatKeys ?? []
  }

  /** 标记某会话的网页端清理已完成。 */
  markCleaned(sessionId: string): void {
    this.cleanedSessions.add(sessionId)
    this.failedCleanups.delete(sessionId)
  }

  /** 记录一次清理失败（保留最近一次原因）。 */
  markCleanupFailed(sessionId: string, error: string): void {
    this.failedCleanups.set(sessionId, { at: new Date().toISOString(), error })
  }

  /** 该会话是否已清理过。 */
  isCleaned(sessionId: string): boolean {
    return this.cleanedSessions.has(sessionId)
  }

  /** 清理记账快照（供统计与落盘）。 */
  cleanupSnapshot(): {
    cleaned: readonly string[]
    failed: Readonly<Record<string, { at: string; error: string }>>
  } {
    return {
      cleaned: [...this.cleanedSessions],
      failed: Object.fromEntries(this.failedCleanups),
    }
  }
}
