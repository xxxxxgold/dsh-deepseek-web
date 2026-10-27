/**
 * 归档清理的 HTTP 桥：统计、手动清理、清空全部。
 *
 * 与 `ledger-route.ts` 的只读桥共用同一套同源围栏；这里多出两条写操作：
 * - `run`：只清理“已归档、有绑定、未清理”的会话；
 * - `purge-all`：清空网页端全部对话，要求确认词 + 当前数量双重校验。
 *
 * 所有 handler 都不抛异常：失败转成 `{ ok:false, code, message }`，避免把插件主流程拖崩。
 *
 * @module dsh-deepseek-web/archive-cleanup-route
 */

import {
  isBridgeRequestAllowed,
  sendJson,
  type BridgeContext,
  type BridgeRequest,
  type BridgeResponse,
} from './ledger-route.ts'
import type { ArchiveCleanupStats, CleanupRunResult } from './archive-cleanup.ts'

/** 统计与手动清理入口。 */
export const ARCHIVE_CLEANUP_ROUTE = '/api/dsh-deepseek-web/archive-cleanup'

/** 手动清理“待清理项”。 */
export const ARCHIVE_CLEANUP_RUN_ROUTE = '/api/dsh-deepseek-web/archive-cleanup/run'

/** 只读：当前网页端对话总数（清空前的确认弹窗用）。 */
export const ARCHIVE_CLEANUP_WEB_CHATS_ROUTE = '/api/dsh-deepseek-web/archive-cleanup/web-chats'

/** 清空全部网页端对话。 */
export const ARCHIVE_CLEANUP_PURGE_ROUTE = '/api/dsh-deepseek-web/archive-cleanup/purge-all'

/** 清空确认词：前端必须原样发送。 */
export const PURGE_CONFIRM_WORD = 'DELETE_ALL_WEB_CHATS'

/** 路由数据源，由装配层注入（便于离线测试替身）。 */
export interface ArchiveCleanupBridgeData {
  stats(): ArchiveCleanupStats
  runPending(): Promise<CleanupRunResult>
  listWebChatIds(): Promise<readonly string[]>
  purgeWebChats(ids: readonly string[]): Promise<{
    ok: boolean
    deleted: number
    failed: number
    error?: string
  }>
}

function forbidden(res: BridgeResponse): void {
  sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: '只允许本机同源页面访问。' })
}

function methodNotAllowed(res: BridgeResponse, allow: string): void {
  res.writeHead(405, { allow })
  res.end()
}

function failure(res: BridgeResponse, code: string, error: unknown): void {
  sendJson(res, 500, {
    ok: false,
    code,
    message: error instanceof Error ? error.message : String(error),
  })
}

function readBody(request: BridgeRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof request.on !== 'function') {
      resolve('')
      return
    }
    let raw = ''
    request.on('data', (chunk) => {
      raw += typeof chunk === 'string' ? chunk : String(chunk ?? '')
    })
    request.on('end', () => resolve(raw))
    request.on('error', () => reject(new Error('读取请求体失败')))
  })
}

/**
 * 注册归档清理路由；返回值是处置函数（宿主 unload 时调用）。
 */
export function registerArchiveCleanupRoutes(
  ctx: BridgeContext,
  data: ArchiveCleanupBridgeData,
): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: ARCHIVE_CLEANUP_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      if (!isBridgeRequestAllowed(req)) return forbidden(res)
      try {
        sendJson(res, 200, { ok: true, value: data.stats() })
      } catch (error) {
        failure(res, 'STATS_FAILED', error)
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: ARCHIVE_CLEANUP_WEB_CHATS_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      if (!isBridgeRequestAllowed(req)) return forbidden(res)
      try {
        const ids = await data.listWebChatIds()
        sendJson(res, 200, { ok: true, value: { total: ids.length } })
      } catch (error) {
        failure(res, 'WEB_CHATS_FAILED', error)
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: ARCHIVE_CLEANUP_RUN_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      if (!isBridgeRequestAllowed(req)) return forbidden(res)
      try {
        sendJson(res, 200, { ok: true, value: await data.runPending() })
      } catch (error) {
        failure(res, 'RUN_FAILED', error)
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: ARCHIVE_CLEANUP_PURGE_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      if (!isBridgeRequestAllowed(req)) return forbidden(res)
      const contentType = String(req.headers['content-type'] ?? '')
      if (!contentType.includes('application/json')) {
        return sendJson(res, 415, {
          ok: false,
          code: 'CONTENT_TYPE_REQUIRED',
          message: '清空请求必须是 application/json。',
        })
      }
      try {
        const raw = await readBody(req)
        const body = JSON.parse(raw) as { confirm?: unknown; expectedCount?: unknown }
        if (body.confirm !== PURGE_CONFIRM_WORD) {
          return sendJson(res, 400, {
            ok: false,
            code: 'CONFIRM_REQUIRED',
            message: '确认词不正确，未执行清空。',
          })
        }
        const expected = Number(body.expectedCount)
        if (!Number.isFinite(expected) || expected < 0) {
          return sendJson(res, 400, {
            ok: false,
            code: 'COUNT_REQUIRED',
            message: '缺少 expectedCount，未执行清空。',
          })
        }
        const ids = await data.listWebChatIds()
        if (ids.length !== expected) {
          return sendJson(res, 409, {
            ok: false,
            code: 'COUNT_MISMATCH',
            message: `当前网页端有 ${ids.length} 条对话，与确认时的 ${expected} 条不一致，请刷新后重试。`,
          })
        }
        const result = await data.purgeWebChats(ids)
        sendJson(res, 200, { ok: true, value: { ...result, total: ids.length } })
      } catch (error) {
        failure(res, 'PURGE_FAILED', error)
      }
    },
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
