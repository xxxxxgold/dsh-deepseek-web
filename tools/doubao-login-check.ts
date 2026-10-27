/** 豆包登录态路由回归：启用/未启用、探活、打开、方法/同源围栏。 */
import assert from 'node:assert/strict'
import {
  DOUBAO_LOGIN_OPEN_ROUTE,
  DOUBAO_LOGIN_PROBE_ROUTE,
  DOUBAO_LOGIN_ROUTE,
  registerDoubaoLoginRoutes,
  type DoubaoLoginBridgeData,
} from '../src/doubao-login-route.ts'
import type { BridgeContext, BridgeRequest, BridgeResponse } from '../src/ledger-route.ts'

interface FakeResponseState { status: number; body: string }

function makeResponse(): { res: BridgeResponse; state: FakeResponseState } {
  const state: FakeResponseState = { status: 0, body: '' }
  const res: BridgeResponse = {
    writeHead(status) { state.status = status },
    end(chunk) { state.body = chunk ?? '' },
  }
  return { res, state }
}

function makeRequest(method: string, headers: Record<string, string> = {}): BridgeRequest {
  return {
    method,
    url: '/',
    headers: { host: '127.0.0.1:64577', 'sec-fetch-site': 'same-origin', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on() {},
  } as unknown as BridgeRequest
}

const routes = new Map<string, (req: BridgeRequest, res: BridgeResponse) => void | Promise<void>>()
const ctx = {
  webServer: {
    register(route: { kind: 'exact'; path: string; handler: (req: BridgeRequest, res: BridgeResponse) => void | Promise<void> }) {
      assert.ok(!routes.has(route.path), `路由重复注册: ${route.path}`)
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
} as unknown as BridgeContext

const calls: string[] = []
const data: DoubaoLoginBridgeData = {
  enabled: true,
  status: async () => ({ ready: true }),
  browserStarted: () => true,
  open: async () => { calls.push('open'); return { opened: true, loggedIn: true } },
}

const dispose = registerDoubaoLoginRoutes(ctx, data)
assert.equal(routes.size, 3, '应注册 3 条豆包登录路由')

// 启用 + 已登录：状态 ok，导入/导出能力必须为 false
{
  const { res, state } = makeResponse()
  await routes.get(DOUBAO_LOGIN_ROUTE)?.(makeRequest('GET'), res)
  assert.equal(state.status, 200)
  const value = JSON.parse(state.body).value
  assert.equal(value.status, 'ok')
  assert.equal(value.enabled, true)
  assert.equal(value.canImport, false)
  assert.equal(value.canExport, false)
}

// 探活
{
  const { res, state } = makeResponse()
  await routes.get(DOUBAO_LOGIN_PROBE_ROUTE)?.(makeRequest('POST'), res)
  assert.equal(state.status, 200)
  assert.equal(JSON.parse(state.body).value.status, 'ok')
}

// 打开登录窗口
{
  const { res, state } = makeResponse()
  await routes.get(DOUBAO_LOGIN_OPEN_ROUTE)?.(makeRequest('POST'), res)
  assert.equal(state.status, 200)
  assert.equal(JSON.parse(state.body).value.loggedIn, true)
  assert.ok(calls.includes('open'))
}

// 未启用：状态 unknown + enabled=false；打开返回 409
const disabledRoutes = new Map<string, (req: BridgeRequest, res: BridgeResponse) => void | Promise<void>>()
const disabledCtx = {
  webServer: {
    register(route: { kind: 'exact'; path: string; handler: (req: BridgeRequest, res: BridgeResponse) => void | Promise<void> }) {
      disabledRoutes.set(route.path, route.handler)
      return () => disabledRoutes.delete(route.path)
    },
  },
} as unknown as BridgeContext
const disabledDispose = registerDoubaoLoginRoutes(disabledCtx, {
  enabled: false,
  status: async () => { throw new Error('未启用时不应调用 status()') },
  browserStarted: () => false,
  open: async () => { throw new Error('未启用时不应调用 open()') },
})
{
  const { res, state } = makeResponse()
  await disabledRoutes.get(DOUBAO_LOGIN_ROUTE)?.(makeRequest('GET'), res)
  const value = JSON.parse(state.body).value
  assert.equal(value.enabled, false)
  assert.equal(value.status, 'unknown')
  assert.equal(value.canOpen, false)
}
{
  const { res, state } = makeResponse()
  await disabledRoutes.get(DOUBAO_LOGIN_PROBE_ROUTE)?.(makeRequest('POST'), res)
  assert.equal(state.status, 200)
  assert.equal(JSON.parse(state.body).value.status, 'unknown')
  assert.match(JSON.parse(state.body).value.detail, /未启用/)
}
{
  const { res, state } = makeResponse()
  await disabledRoutes.get(DOUBAO_LOGIN_OPEN_ROUTE)?.(makeRequest('POST'), res)
  assert.equal(state.status, 409, '未启用时打开登录窗口应 409')
}

// 浏览器已启动但输入框未就绪：不能误报成「登录态已失效」
{
  const pendingRoutes = new Map<string, (req: BridgeRequest, res: BridgeResponse) => void | Promise<void>>()
  const pendingCtx = {
    webServer: {
      register(route: { kind: 'exact'; path: string; handler: (req: BridgeRequest, res: BridgeResponse) => void | Promise<void> }) {
        pendingRoutes.set(route.path, route.handler)
        return () => pendingRoutes.delete(route.path)
      },
    },
  } as unknown as BridgeContext
  const pendingDispose = registerDoubaoLoginRoutes(pendingCtx, {
    enabled: true,
    status: async () => ({ ready: false, state: 'pending', message: '豆包输入框未就绪' }),
    browserStarted: () => true,
    open: async () => ({ opened: true, loggedIn: false }),
  })
  const { res, state } = makeResponse()
  await pendingRoutes.get(DOUBAO_LOGIN_ROUTE)?.(makeRequest('GET'), res)
  const value = JSON.parse(state.body).value
  assert.equal(value.status, 'unknown')
  assert.match(value.detail, /未就绪/)
  pendingDispose()
}

// 同源围栏与方法
{
  const { res, state } = makeResponse()
  await routes.get(DOUBAO_LOGIN_ROUTE)?.(makeRequest('GET', { 'sec-fetch-site': 'cross-site' }), res)
  assert.equal(state.status, 403, '跨站请求应拒绝')
}
{
  const { res, state } = makeResponse()
  await routes.get(DOUBAO_LOGIN_PROBE_ROUTE)?.(makeRequest('GET'), res)
  assert.equal(state.status, 405, 'GET 探活应 405')
}

dispose()
disabledDispose()
assert.equal(routes.size, 0, 'dispose 后路由应清空')
console.log('doubao-login-check: OK')
