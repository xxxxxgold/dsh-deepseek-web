/**
 * 归档联动清理：DSH 会话被归档后，删除它在 DeepSeek 网页端产生过的对话。
 *
 * 数据来源：
 * - `workspaceRegistry.archivedSessionIds`：DSH 侧归档集合（宿主服务）；
 * - `SessionRegistry`：每个会话记录过的 `webChatKeys`（一对多），以及清理记账。
 *
 * 只处理“本次运行期间新增的归档”，启动时把当前集合记为基线，不追溯历史；
 * 历史条目没有 `webChatKeys`，只能在统计里显示为“无绑定”，不做猜测性删除。
 *
 * @module dsh-deepseek-web/archive-cleanup
 */

import type { Config } from './config.ts'
import type { SessionRegistry } from './session-state.ts'
import type { PlaywrightBrowserChannel } from './playwright-channel.ts'

/** 宿主工作区注册表的最小形状（只用到归档集合）。 */
export interface ArchiveRegistryLike {
  readonly archivedSessionIds: readonly string[]
}

export interface ArchiveCleanupOptions {
  readonly registry: ArchiveRegistryLike
  readonly sessions: SessionRegistry
  readonly channel: PlaywrightBrowserChannel
  readonly config: Config
  /** 日志出口；缺省不打印。 */
  readonly log?: (message: string) => void
  /** 轮询间隔（毫秒）。 */
  readonly intervalMs?: number
}

/** 统计面板的四个数字。 */
export interface ArchiveCleanupStats {
  archivedTotal: number
  cleaned: number
  pending: number
  unbound: number
  failed: number
}

/** 一次清理批次的结果。 */
export interface CleanupRunResult {
  attempted: number
  deleted: number
  failed: number
}

const DEFAULT_INTERVAL_MS = 5_000

export class ArchiveCleanup {
  private readonly options: ArchiveCleanupOptions
  private baseline: Set<string> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private busy = false

  constructor(options: ArchiveCleanupOptions) {
    this.options = options
  }

  /** 开始轮询；重复调用为空操作。 */
  start(): void {
    if (this.timer !== undefined) return
    this.baseline = new Set(this.options.registry.archivedSessionIds)
    const interval = this.options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.timer = setInterval(() => {
      void this.tick()
    }, interval)
    this.timer.unref?.()
  }

  /** 停止轮询。 */
  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * 一轮归档检测：找出“启动基线之后新增”的归档会话并清理。
   *
   * 即使总开关关闭也要更新基线：关闭期间归档的会话算“待清理”，
   * 由统计面板展示，用户手动点“清理待清理项”时才处理。
   */
  async tick(): Promise<void> {
    if (this.busy) return
    const current = new Set(this.options.registry.archivedSessionIds)
    const baseline = this.baseline ?? new Set<string>()
    const added = [...current].filter(id => !baseline.has(id))
    this.baseline = current
    if (added.length === 0) return
    if (this.options.config.archiveCleanup.deleteOnArchive !== true) return
    this.busy = true
    try {
      for (const sessionId of added) {
        await this.cleanSession(sessionId)
      }
    } finally {
      this.busy = false
    }
  }

  /**
   * 清理一个会话的网页对话。
   *
   * 没有 `webChatKeys` 的会话只记账为“无绑定”，不猜标题、不删任何东西。
   */
  async cleanSession(sessionId: string): Promise<CleanupRunResult> {
    const result: CleanupRunResult = { attempted: 0, deleted: 0, failed: 0 }
    if (this.options.sessions.isCleaned(sessionId)) return result
    const keys = this.options.sessions.webChatKeysFor(sessionId)
    if (keys.length === 0) return result
    const targets = this.options.config.archiveCleanup.includeRotatedChats === false
      ? keys.slice(-1)
      : [...keys]
    for (const chatId of targets) {
      result.attempted += 1
      let outcome = await this.options.channel.deleteWebChat(chatId)
      if (!outcome.ok) {
        // 单条失败重试一次：网页接口偶发超时，重试一次仍失败才记账。
        outcome = await this.options.channel.deleteWebChat(chatId)
      }
      if (outcome.ok) {
        result.deleted += 1
      } else {
        result.failed += 1
        this.options.sessions.markCleanupFailed(sessionId, outcome.error ?? 'unknown')
      }
    }
    if (result.failed === 0) {
      this.options.sessions.markCleaned(sessionId)
      this.options.log?.(`[deepseek-web] 已清理会话 ${sessionId} 的 ${result.deleted} 条网页对话`)
    } else {
      this.options.log?.(`[deepseek-web] 会话 ${sessionId} 清理失败 ${result.failed} 条（已重试一次）`)
    }
    await this.options.sessions.save()
    return result
  }

  /** 手动清理全部“已归档、有绑定、未清理”的会话。 */
  async runPending(): Promise<CleanupRunResult> {
    const total: CleanupRunResult = { attempted: 0, deleted: 0, failed: 0 }
    for (const sessionId of this.options.registry.archivedSessionIds) {
      if (this.options.sessions.isCleaned(sessionId)) continue
      if (this.options.sessions.webChatKeysFor(sessionId).length === 0) continue
      const result = await this.cleanSession(sessionId)
      total.attempted += result.attempted
      total.deleted += result.deleted
      total.failed += result.failed
    }
    return total
  }

  /** 统计面板数据。 */
  stats(): ArchiveCleanupStats {
    const archived = this.options.registry.archivedSessionIds
    const snapshot = this.options.sessions.cleanupSnapshot()
    let cleaned = 0
    let pending = 0
    let unbound = 0
    let failed = 0
    for (const sessionId of archived) {
      if (this.options.sessions.isCleaned(sessionId)) {
        cleaned += 1
        continue
      }
      if (this.options.sessions.webChatKeysFor(sessionId).length === 0) unbound += 1
      else pending += 1
      if (sessionId in snapshot.failed) failed += 1
    }
    return { archivedTotal: archived.length, cleaned, pending, unbound, failed }
  }

  /** 清空网页端全部对话（危险操作；调用方负责二次确认与数量校验）。 */
  async purgeAll(): Promise<{ ok: boolean; deleted: number; failed: number; error?: string }> {
    return this.options.channel.purgeAllWebChats()
  }
}
