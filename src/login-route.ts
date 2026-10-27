/**
 * 登录态的 HTTP 桥：状态、探活、打开登录窗口、导入、导出。
 *
 * 与 `ledger-route.ts` / `archive-cleanup-route.ts` 共用同一套同源围栏：
 * - 只接受本机同源页面，跨站请求 403；
 * - 方法不符 405；
 * - handler 不抛异常，失败统一转成 `{ ok:false, code, message }`。
 *
 * 为什么需要它：登录态探活结果和浏览器状态只存在于宿主进程里，设置页
 * （浏览器半侧）看不到；而「打开登录窗口 / 导入登录态」又必须由宿主执行。
 * `webServer` 是项目里唯一现成的浏览器↔宿主通道，沿用既有模式即可。
 *
 * 安全约定：请求体里的 token **不写日志、不落盘**，只透传给通道写进浏览器。
 *
 * @module dsh-deepseek-web/login-route
 */

import {
  isBridgeRequestAllowed,
  sendJson,
  type BridgeContext,
  type BridgeRequest,
  type BridgeResponse,
} from './ledger-route.ts'
import type { LoginProbeResult, LoginProbeStatus } from './login-probe.ts'
import { parseLoginBundle, type LoginBundle } from './login-state.ts'

/** 状态查询。 */
export const LOGIN_ROUTE = '/api/dsh-deepseek-web/login'

/** 立即探活（只读，不拉起浏览器）。 */
export const LOGIN_PROBE_ROUTE = '/api/dsh-deepseek-web/login/probe'

/** 打开浏览器登录窗口。 */
export const LOGIN_OPEN_ROUTE = '/api/dsh-deepseek-web/login/open'

/** 导入登录态。 */
export const LOGIN_IMPORT_ROUTE = '/api/dsh-deepseek-web/login/import'

/** 导出登录态。 */
export const LOGIN_EXPORT_ROUTE = '/api/dsh-deepseek-web/login/export'

/** 请求体上限：raw 本身最多 64 KiB，JSON 包装再留一点余量。 */
export const MAX_LOGIN_BODY_BYTES = 80 * 1024

/** 设置页需要的当前状态快照。 */
export interface LoginStatusView {
  status: LoginProbeStatus
  detail?: string
  checkedAt?: number
  /** 浏览器当前是否已启动（探活只能判断已启动的浏览器）。 */
  browserStarted: boolean
  canOpen: boolean
  canImport: boolean
  canExport: boolean
}

/** 导入结果：写入内容 + 导入后的探活结论。 */
export interface LoginImportResult {
  status: LoginProbeResult
  applied: { token: boolean; cookies: number }
}

/** 路由数据源，由装配层注入（便于离线测试替身）。 */
export interface LoginBridgeData {
  current(): LoginStatusView
  probe(): Promise<LoginProbeResult>
  open(): Promise<{ opened: boolean; loggedIn: boolean; detail?: string }>
  importLogin(bundle: LoginBundle): Promise<LoginImportResult>
  exportLogin(): Promise<{ token: string; cookies: unknown[] }>
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

function badRequest(res: BridgeResponse, code: string, message: string): void {
  sendJson(res, 400, { ok: false, code, message })
}

/** 读取请求体并限长；超限返回 `{ error }` 而不是把内存吃满。 */
function readBody(request: BridgeRequest): Promise<string | { error: string }> {
  return new Promise((resolve) => {
    if (typeof request.on !== 'function') {
      resolve('')
      return
    }
    let raw = ''
    let settled = false
    const finish = (value: string | { error: string }): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      // 超限后不再继续累积：坏客户端不该把内存撑爆。
      if (settled) return
      raw += typeof chunk === 'string' ? chunk : String(chunk ?? '')
      if (raw.length > MAX_LOGIN_BODY_BYTES) finish({ error: `请求体超过上限（${MAX_LOGIN_BODY_BYTES} 字符）` })
    })
    request.on('end', () => finish(raw))
    request.on('error', () => finish({ error: '读取请求体失败' }))
  })
}

/** 从请求体里取出 `raw` 字段；格式不对时返回错误。 */
function rawFieldOf(body: string): string | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { error: '请求体不是合法 JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '请求体必须是对象' }
  }
  const raw = (parsed as { raw?: unknown }).raw
  if (typeof raw !== 'string') return { error: '缺少 raw 字段（字符串）' }
  return raw
}

/**
 * 注册登录态路由；返回值是处置函数（宿主 unload 时调用）。
 */
export interface LoginRouteOptions {
  /**
   * 路由前缀；缺省用 DeepSeek 的 `/api/dsh-deepseek-web/login`。
   * GLM 主通道用 `/api/dsh-deepseek-web/glm-login` 注册第二组同构路由。
   */
  basePath?: string
}

export function registerLoginRoutes(
  ctx: BridgeContext,
  data: LoginBridgeData,
  options: LoginRouteOptions = {},
): () => void {
  const disposers: Array<() => void> = []
  const base = options.basePath ?? LOGIN_ROUTE
  const paths = {
    status: base,
    probe: `${base}/probe`,
    open: `${base}/open`,
    import: `${base}/import`,
    export: `${base}/export`,
  }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: paths.status,
    handler: (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      if (!isBridgeRequestAllowed(req)) return forbidden(res)
      try {
        sendJson(res, 200, { ok: true, value: data.current() })
      } catch (error) {
        failure(res, 'LOGIN_STATUS_FAILED', error)
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: paths.probe,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      if (!isBridgeRequestAllowed(req)) return forbidden(res)
      try {
        sendJson(res, 200, { ok: true, value: await data.probe() })
      } catch (error) {
        failure(res, 'LOGIN_PROBE_FAILED', error)
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: paths.open,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      if (!isBridgeRequestAllowed(req)) return forbidden(res)
      try {
        sendJson(res, 200, { ok: true, value: await data.open() })
      } catch (error) {
        failure(res, 'LOGIN_OPEN_FAILED', error)
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: paths.import,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      if (!isBridgeRequestAllowed(req)) return forbidden(res)
      try {
        const body = await readBody(req)
        if (typeof body !== 'string') return badRequest(res, 'LOGIN_BODY_TOO_LARGE', body.error)
        const raw = rawFieldOf(body)
        if (typeof raw !== 'string') return badRequest(res, 'LOGIN_BODY_INVALID', raw.error)
        const bundle = parseLoginBundle(raw)
        if (bundle.error !== undefined) return badRequest(res, 'LOGIN_STATE_INVALID', bundle.error)
        sendJson(res, 200, { ok: true, value: await data.importLogin(bundle) })
      } catch (error) {
        failure(res, 'LOGIN_IMPORT_FAILED', error)
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: paths.export,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      if (!isBridgeRequestAllowed(req)) return forbidden(res)
      try {
        sendJson(res, 200, { ok: true, value: await data.exportLogin() })
      } catch (error) {
        failure(res, 'LOGIN_EXPORT_FAILED', error)
      }
    },
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
