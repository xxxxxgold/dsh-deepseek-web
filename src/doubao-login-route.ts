/**
 * 豆包登录态的 HTTP 桥：状态、只读探活、打开登录窗口。
 *
 * 与 DeepSeek 的 `login-route.ts` 同一套同源围栏与响应形状；豆包一期不做
 * 登录态导入/导出（需要单独逆向站点存储），所以只有三条路由。
 *
 * @module dsh-deepseek-web/doubao-login-route
 */

import {
  isBridgeRequestAllowed,
  sendJson,
  type BridgeContext,
  type BridgeRequest,
  type BridgeResponse,
} from './ledger-route.ts'

/** 状态查询。 */
export const DOUBAO_LOGIN_ROUTE = '/api/dsh-deepseek-web/doubao/login'

/** 立即探活（只读，不拉起浏览器）。 */
export const DOUBAO_LOGIN_PROBE_ROUTE = `${DOUBAO_LOGIN_ROUTE}/probe`

/** 打开豆包浏览器登录窗口。 */
export const DOUBAO_LOGIN_OPEN_ROUTE = `${DOUBAO_LOGIN_ROUTE}/open`

export type DoubaoProbeStatus = 'ok' | 'expired' | 'unknown'

/** 设置页需要的豆包登录态快照（与 DeepSeek 卡片共用一套渲染字段）。 */
export interface DoubaoLoginStatusView {
  /** 豆包通道是否启用；false 时卡片只显示「未启用」。 */
  enabled: boolean
  status: DoubaoProbeStatus
  detail?: string
  checkedAt: number
  browserStarted: boolean
  canOpen: boolean
  canImport: boolean
  canExport: boolean
}

export interface DoubaoLoginProbeResult {
  status: DoubaoProbeStatus
  detail?: string
  checkedAt: number
}

/** 路由数据源，由装配层注入（便于离线测试替身）。 */
export interface DoubaoLoginBridgeData {
  enabled: boolean
  /** 只读状态；不启动浏览器。`state` 区分登录失效与页面未就绪。 */
  status(): Promise<{
    ready: boolean
    url?: string
    state?: 'ok' | 'expired' | 'pending'
    message?: string
  }>
  browserStarted(): boolean
  open(): Promise<{ opened: boolean; loggedIn: boolean; detail?: string }>
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

/** 把通道状态映射成卡片的三态；未启动浏览器时报 unknown，不误报失效。 */
function toView(data: DoubaoLoginBridgeData, status: {
  ready: boolean
  state?: 'ok' | 'expired' | 'pending'
  message?: string
}): DoubaoLoginStatusView {
  const browserStarted = data.browserStarted()
  const state: DoubaoProbeStatus = status.state === 'ok'
    ? 'ok'
    : status.state === 'expired'
      ? 'expired'
      : status.state === 'pending'
        ? 'unknown'
        : status.ready ? 'ok' : browserStarted ? 'expired' : 'unknown'
  return {
    enabled: data.enabled,
    status: state,
    ...status.message !== undefined ? { detail: status.message } : {},
    checkedAt: Date.now(),
    browserStarted,
    canOpen: data.enabled,
    // 豆包一期不做登录态导入/导出：卡片会把「高级」区隐藏。
    canImport: false,
    canExport: false,
  }
}

/** 未启用时的固定快照。 */
function disabledView(): DoubaoLoginStatusView {
  return {
    enabled: false,
    status: 'unknown',
    detail: '豆包网页通道未启用，请先在上方开启「启用豆包网页通道」。',
    checkedAt: Date.now(),
    browserStarted: false,
    canOpen: false,
    canImport: false,
    canExport: false,
  }
}

/** 注册豆包登录态路由；返回值是处置函数（宿主 unload 时调用）。 */
export function registerDoubaoLoginRoutes(ctx: BridgeContext, data: DoubaoLoginBridgeData): () => void {
  const disposers: Array<() => void> = []

  const view = async (): Promise<DoubaoLoginStatusView> => {
    if (!data.enabled) return disabledView()
    return toView(data, await data.status())
  }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: DOUBAO_LOGIN_ROUTE,
    handler: async (req: BridgeRequest, res: BridgeResponse) => {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      if (!isBridgeRequestAllowed(req)) return forbidden(res)
      try {
        sendJson(res, 200, { ok: true, value: await view() })
      } catch (error) {
        failure(res, 'DOUBAO_LOGIN_STATUS_FAILED', error)
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: DOUBAO_LOGIN_PROBE_ROUTE,
    handler: async (req: BridgeRequest, res: BridgeResponse) => {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      if (!isBridgeRequestAllowed(req)) return forbidden(res)
      try {
        const current = await view()
        const result: DoubaoLoginProbeResult = {
          status: current.status,
          ...current.detail !== undefined ? { detail: current.detail } : {},
          checkedAt: current.checkedAt,
        }
        sendJson(res, 200, { ok: true, value: result })
      } catch (error) {
        failure(res, 'DOUBAO_LOGIN_PROBE_FAILED', error)
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: DOUBAO_LOGIN_OPEN_ROUTE,
    handler: async (req: BridgeRequest, res: BridgeResponse) => {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      if (!isBridgeRequestAllowed(req)) return forbidden(res)
      if (!data.enabled) {
        sendJson(res, 409, {
          ok: false,
          code: 'DOUBAO_DISABLED',
          message: '豆包网页通道未启用。',
        })
        return
      }
      try {
        sendJson(res, 200, { ok: true, value: await data.open() })
      } catch (error) {
        failure(res, 'DOUBAO_LOGIN_OPEN_FAILED', error)
      }
    },
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
