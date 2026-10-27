/**
 * 调用台账 / 自检的只读 HTTP 桥。
 *
 * 为什么需要它：台账落在 `%LOCALAPPDATA%\DshDeepSeekWeb\call-ledger.json`，
 * 浏览器半侧读不到文件系统；而「最近 7 天到底发了多少请求、最短间隔多少、
 * 失败主要是不是限流」恰恰是设置页最该显示的信息。宿主提供了 `webServer`
 * 服务（`register(route)` 注册 exact 路径），按同源只读接口暴露是最小通道。
 *
 * 设计约束（与竞品 `dsh-webchat` / `dsh-deepseek-monitor` 一致）：
 * - **只读**：只接受 GET，写入一律 405；
 * - **只出聚合元信息**：台账本身就不记对话正文与凭证，这里再收窄一层，只回统计值；
 * - **同源围栏**：`sec-fetch-site: cross-site` 直接拒，`Origin` 存在时必须与
 *   `Host` 同 host，loopback 主机还要求对端地址也是 loopback（防 confused deputy）；
 * - **失败不抛**：路由 handler 里任何异常都转成 `{ ok:false, code, message }`，
 *   绝不让一个只读接口把插件主流程拖崩。
 *
 * @module dsh-deepseek-web/ledger-route
 */

import type { LedgerSummary } from './ledger.ts'
import type { DoctorReport } from './doctor.ts'

/** 台账摘要路由（GET）。 */
export const LEDGER_ROUTE = '/api/dsh-deepseek-web/ledger'

/** 安装自检路由（GET；`?live=1` 才跑需要浏览器的在线检查）。 */
export const DOCTOR_ROUTE = '/api/dsh-deepseek-web/doctor'

/** 请求对象的最小形状（只用到围栏、查询串与 POST 请求体）。 */
export interface BridgeRequest {
  method?: string | undefined
  url?: string | undefined
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string | undefined; localAddress?: string | undefined } | undefined
  on?(event: 'data' | 'end' | 'error', listener: (chunk?: unknown) => void): void
}

/** 响应对象的最小形状。 */
export interface BridgeResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
}

/** `ctx.webServer` 的最小形状：只声明本插件用到的那一个方法。 */
export interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: BridgeRequest, res: BridgeResponse) => void | Promise<void>
  }): () => void
}

/** 桥接上下文：宿主可能没有 webServer 服务，所以这里是可选注入。 */
export interface BridgeContext {
  readonly webServer: WebServerLike
}

/** 台账 / 自检数据的读取口，由装配层注入（便于离线测试替身）。 */
export interface BridgeData {
  readLedger(): Promise<LedgerSummary>
  readDoctor(live: boolean): Promise<DoctorReport>
  ledgerFile?: string
  build?: string
}

function header(request: BridgeRequest, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  const value = String(address ?? '')
  return value === '::1' || value === '::ffff:127.0.0.1' || /^127\./.test(value)
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 同源围栏：判断这个请求是否来自本机同一页面。
 *
 * 只放行 loopback。非 loopback 的 Host 一律拒绝 —— 本插件没有需要被
 * 反向代理暴露的远程用法，宁可少支持一种部署，也不把只读接口开给任意来源。
 */
export function isBridgeRequestAllowed(request: BridgeRequest): boolean {
  const host = header(request, 'host')
  if (typeof host !== 'string' || host === '') return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  // 跨站发起的请求一律拒绝（防 confused deputy）；同源请求才继续看 Host。
  if (header(request, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request, 'origin')
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== hostUrl.host) return false
    } catch {
      return false
    }
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  return isLoopbackAddress(request.socket?.remoteAddress)
}

export function sendJson(res: BridgeResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

function methodNotAllowed(res: BridgeResponse): void {
  res.writeHead(405, { allow: 'GET' })
  res.end()
}

/**
 * 注册两条只读路由。返回值是处置函数（宿主 unload 时调用）。
 *
 * `webServer.register` 对重复的 `(kind, path)` 会直接抛错，所以调用方必须
 * 保证只注册一次；这里不吞异常，让装配错误在加载期就暴露。
 */
export function registerBridgeRoutes(ctx: BridgeContext, data: BridgeData): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LEDGER_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res)
      if (!isBridgeRequestAllowed(req)) return sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: '只允许本机同源页面读取。' })
      try {
        const summary = await data.readLedger()
        sendJson(res, 200, {
          ok: true,
          value: {
            summary,
            generatedAt: Date.now(),
            ...data.ledgerFile === undefined ? {} : { file: data.ledgerFile },
            ...data.build === undefined ? {} : { build: data.build },
          },
        })
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          code: 'LEDGER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: DOCTOR_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res)
      if (!isBridgeRequestAllowed(req)) return sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: '只允许本机同源页面读取。' })
      // 默认只跑静态检查：在线检查会连（必要时启动）浏览器，不该由一次页面点击
      // 悄悄拉起一个 Edge 进程。要在线检查必须显式 `?live=1`。
      const live = new URL(`http://localhost${req.url ?? '/'}`).searchParams.get('live') === '1'
      try {
        const report = await data.readDoctor(live)
        sendJson(res, 200, { ok: true, value: { report, generatedAt: Date.now() } })
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          code: 'DOCTOR_FAILED',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
