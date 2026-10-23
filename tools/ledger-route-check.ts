/**
 * 台账 / 自检只读桥的离线回归：来源围栏 + 方法白名单 + 信封形状。
 *
 * 只测纯逻辑与注册行为，不碰真实 HTTP 服务器 —— 宿主 `webServer` 的重复路由
 * 会抛错，这条约束也一并固化为断言。
 */

import assert from 'node:assert/strict'
import {
  DOCTOR_ROUTE,
  LEDGER_ROUTE,
  isBridgeRequestAllowed,
  registerBridgeRoutes,
  type BridgeRequest,
  type BridgeResponse,
  type WebServerLike,
} from '../src/ledger-route.ts'

function req(overrides: Partial<BridgeRequest> = {}): BridgeRequest {
  return {
    method: 'GET',
    url: LEDGER_ROUTE,
    headers: { host: '127.0.0.1:56184' },
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
    ...overrides,
  }
}

function capture(): { res: BridgeResponse; status: () => number; body: () => string; headers: () => Record<string, string> } {
  let status = 0
  let body = ''
  let headers: Record<string, string> = {}
  return {
    res: {
      writeHead(next, nextHeaders) {
        status = next
        headers = nextHeaders ?? {}
      },
      end(next) {
        body = next ?? ''
      },
    },
    status: () => status,
    body: () => body,
    headers: () => headers,
  }
}

// ---- 来源围栏 ----
assert.equal(isBridgeRequestAllowed(req()), true, '本机 loopback 请求应放行')
assert.equal(isBridgeRequestAllowed(req({ headers: {} })), false, '缺 Host 必须拒绝')
assert.equal(isBridgeRequestAllowed(req({ headers: { host: 'example.com' } })), false, '非 loopback Host 必须拒绝')
assert.equal(isBridgeRequestAllowed(req({ headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } })), false, '跨站请求必须拒绝')
assert.equal(
  isBridgeRequestAllowed(req({ headers: { host: '127.0.0.1:1', origin: 'http://evil.example' } })),
  false,
  'Origin 与 Host 不同 host 必须拒绝',
)
assert.equal(
  isBridgeRequestAllowed(req({ headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' } })),
  true,
  '同源 Origin 放行',
)
assert.equal(isBridgeRequestAllowed(req({ socket: { remoteAddress: '10.0.0.5' } })), false, 'loopback Host 但远端非 loopback 要拒绝')
assert.equal(isBridgeRequestAllowed(req({ headers: { host: 'localhost:56184' } })), true, 'localhost 也算 loopback')
assert.equal(isBridgeRequestAllowed(req({ headers: { host: '127.0.0.1' } })), true, '无端口 loopback 放行')

// ---- 注册与处理 ----
const registered: Array<{ kind: string; path: string; handler: (req: BridgeRequest, res: BridgeResponse) => void | Promise<void> }> = []
const webServer: WebServerLike = {
  register(route) {
    if (registered.some(item => item.path === route.path)) throw new Error(`duplicate route ${route.path}`)
    registered.push(route)
    return () => {
      const index = registered.findIndex(item => item.path === route.path)
      if (index >= 0) registered.splice(index, 1)
    }
  },
}

const dispose = registerBridgeRoutes({ webServer } as never, {
  readLedger: async () => ({
    days: [],
    totals: { total: 3, chat: 2, failed: 1 },
    intervals: { count: 1, medianMs: 61_000, p90Ms: 61_000, minMs: 61_000 },
    failures: { 'rate-limit': 1 },
  }),
  readDoctor: async live => ({ ok: !live, build: 'test', checks: [] }),
  ledgerFile: 'C:\\tmp\\call-ledger.json',
  build: 'test',
})

assert.equal(registered.length, 2, '应注册两条路由')
assert.deepEqual(registered.map(item => item.path).sort(), [DOCTOR_ROUTE, LEDGER_ROUTE].sort())
assert.ok(registered.every(item => item.kind === 'exact'), '两条都应是 exact')

const ledger = registered.find(item => item.path === LEDGER_ROUTE)!
const doctor = registered.find(item => item.path === DOCTOR_ROUTE)!

// 成功路径
{
  const box = capture()
  await ledger.handler(req(), box.res)
  assert.equal(box.status(), 200)
  const payload = JSON.parse(box.body())
  assert.equal(payload.ok, true)
  assert.equal(payload.value.summary.totals.total, 3)
  assert.equal(payload.value.file, 'C:\\tmp\\call-ledger.json')
  assert.equal(box.headers()['cache-control'], 'no-store')
}

// 方法白名单
{
  const box = capture()
  await ledger.handler(req({ method: 'POST' }), box.res)
  assert.equal(box.status(), 405, '非 GET 必须 405')
}

// 围栏拒绝
{
  const box = capture()
  await ledger.handler(req({ headers: { host: 'evil.example' } }), box.res)
  assert.equal(box.status(), 403, '非本机来源必须 403')
  assert.equal(JSON.parse(box.body()).code, 'FORBIDDEN')
}

// 自检默认静态、?live=1 才在线
{
  const box = capture()
  await doctor.handler(req({ url: DOCTOR_ROUTE }), box.res)
  assert.equal(JSON.parse(box.body()).value.report.ok, true, '默认静态检查（替身返回 ok=true）')
}
{
  const box = capture()
  await doctor.handler(req({ url: `${DOCTOR_ROUTE}?live=1` }), box.res)
  assert.equal(JSON.parse(box.body()).value.report.ok, false, '?live=1 走在线分支（替身返回 ok=false）')
}

// 读失败转 500，不抛
{
  const failing = capture()
  const failingRoutes: Array<{ path: string; handler: (req: BridgeRequest, res: BridgeResponse) => void | Promise<void> }> = []
  const disposeFail = registerBridgeRoutes({
    webServer: {
      register: route => {
        failingRoutes.push(route)
        return () => {}
      },
    },
  } as never, {
    readLedger: async () => { throw new Error('boom') },
    readDoctor: async () => { throw new Error('boom') },
  })
  await failingRoutes.find(item => item.path === LEDGER_ROUTE)!.handler(req(), failing.res)
  assert.equal(failing.status(), 500)
  assert.equal(JSON.parse(failing.body()).code, 'LEDGER_FAILED')
  disposeFail()
}

dispose()
assert.equal(registered.length, 0, 'dispose 后路由应清空')

console.log('OK（台账桥：来源围栏 + 方法白名单 + 信封 + 注册去重 + 失败降级）')
