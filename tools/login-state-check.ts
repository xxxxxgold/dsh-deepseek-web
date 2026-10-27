/**
 * 登录态解析的离线回归：token 三种形态、非法输入、cookie 校验与脱敏。
 *
 * 这些规则同时被设置页的「导入登录态」和通道的写入逻辑复用，
 * 因此必须能脱离浏览器、脱离 HTTP 层单独验证。
 */

import assert from 'node:assert/strict'
import {
  LOGIN_EXPORT_ROUTE,
  LOGIN_IMPORT_ROUTE,
  LOGIN_OPEN_ROUTE,
  LOGIN_PROBE_ROUTE,
  LOGIN_ROUTE,
  MAX_LOGIN_BODY_BYTES,
  registerLoginRoutes,
  type LoginBridgeData,
} from '../src/login-route.ts'
import type { BridgeContext, BridgeRequest, BridgeResponse } from '../src/ledger-route.ts'
import { LoginProbeScheduler } from '../src/login-probe.ts'
import {
  DEFAULT_LOGIN_URL,
  MAX_COOKIES,
  MAX_RAW_CHARS,
  normalizeCookieList,
  normalizeUserToken,
  parseLoginBundle,
  redactSecret,
  type NormalizedCookie,
} from '../src/login-state.ts'

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789'
const SHORT_TOKEN = 'short'

/** 取出 cookie 校验错误；合法时返回空串，便于统一用 assert.match。 */
function cookieError(input: unknown): string {
  const result = normalizeCookieList(input)
  return Array.isArray(result) ? '' : result.error
}

/** 取出合法 cookie 数组；失败时直接断言失败。 */
function cookiesOf(input: unknown): NormalizedCookie[] {
  const result = normalizeCookieList(input)
  assert.ok(Array.isArray(result), `预期合法 cookie，实际: ${Array.isArray(result) ? '' : result.error}`)
  return result
}

// ---- normalizeUserToken：纯 token ----
assert.equal(normalizeUserToken(TOKEN), TOKEN, '纯 token 应原样返回')
assert.equal(normalizeUserToken(`  ${TOKEN}  `), TOKEN, '应去掉首尾空白')
assert.equal(normalizeUserToken(SHORT_TOKEN), undefined, '过短的 token 应拒绝')
assert.equal(normalizeUserToken(''), undefined, '空串应拒绝')
assert.equal(normalizeUserToken('has space in the middle long enough'), undefined, '含空白应拒绝')
assert.equal(normalizeUserToken('bad$token$with$symbols$long'), undefined, '非法字符应拒绝')

// ---- normalizeUserToken：JSON 形态 ----
assert.equal(normalizeUserToken(JSON.stringify({ value: TOKEN })), TOKEN, '{"value"} 应解析')
assert.equal(normalizeUserToken(JSON.stringify({ userToken: TOKEN })), TOKEN, '{"userToken"} 应解析')
assert.equal(normalizeUserToken(JSON.stringify({ token: TOKEN })), TOKEN, '{"token"} 应解析')
assert.equal(normalizeUserToken(JSON.stringify({ value: SHORT_TOKEN })), undefined, 'JSON 里的短 token 应拒绝')
assert.equal(normalizeUserToken('{"value":'), undefined, '坏 JSON 应拒绝')

// ---- parseLoginBundle：三种输入形态 ----
{
  const parsed = parseLoginBundle(TOKEN)
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.token, TOKEN)
  assert.equal(parsed.cookies, undefined)
}
{
  const parsed = parseLoginBundle(JSON.stringify({ value: TOKEN }))
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.token, TOKEN)
}
{
  const parsed = parseLoginBundle(JSON.stringify({
    userToken: TOKEN,
    cookies: [{ name: 'smidV2', value: 'abc', domain: '.deepseek.com', path: '/' }],
  }))
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.token, TOKEN)
  assert.equal(parsed.cookies?.length, 1)
  assert.equal(parsed.cookies?.[0]?.name, 'smidV2')
}
{
  const parsed = parseLoginBundle(JSON.stringify([
    { name: 'a', value: '1', domain: '.deepseek.com' },
    { name: 'b', value: '2', domain: '.deepseek.com', sameSite: 'lax' },
  ]))
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.cookies?.length, 2)
  assert.equal(parsed.cookies?.[1]?.sameSite, 'Lax', 'sameSite 应归一化为首字母大写')
}

// ---- parseLoginBundle：非法输入 ----
assert.match(parseLoginBundle('').error ?? '', /没有收到/, '空输入应报错')
assert.match(parseLoginBundle('   ').error ?? '', /没有收到/, '纯空白应报错')
assert.match(parseLoginBundle('{"value":').error ?? '', /JSON 格式/, '坏 JSON 应报错')
assert.match(parseLoginBundle('{}').error ?? '', /没有找到/, '空对象应报错')
assert.match(parseLoginBundle(JSON.stringify({ value: SHORT_TOKEN })).error ?? '', /没有找到/, '短 token 应报错')
assert.match(parseLoginBundle('x'.repeat(MAX_RAW_CHARS + 1)).error ?? '', /上限/, '超长输入应报错')

// ---- normalizeCookieList ----
{
  const cookies = cookiesOf([{ name: 'a', value: '1', domain: '.deepseek.com' }])
  assert.equal(cookies[0]?.path, '/', '默认 path 应为 /')
}
{
  const cookies = cookiesOf([{ name: 'a', value: '1', url: 'https://chat.deepseek.com/a/chat' }])
  assert.equal(cookies[0]?.domain, 'chat.deepseek.com')
  assert.equal(cookies[0]?.path, '/a/chat')
  assert.equal(cookies[0]?.secure, true, 'https URL 应带 secure')
}
{
  const cookies = cookiesOf([{ name: 'a', value: '1', domain: '.deepseek.com', expires: -1 }])
  assert.equal(cookies[0]?.expires, -1, '-1 表示会话 cookie，应允许')
}
assert.match(cookieError('not-array'), /必须是数组/, '非数组应报错')
assert.match(cookieError([]), /数组为空/, '空数组应报错')
assert.match(cookieError([{ value: '1', domain: '.deepseek.com' }]), /缺少 name/, '缺 name 应报错')
assert.match(cookieError([{ name: 'a', domain: '.deepseek.com' }]), /缺少 value/, '缺 value 应报错')
assert.match(
  cookieError([{ name: 'a', value: '1', domain: '.deepseek.com', sameSite: 'weird' }]),
  /sameSite/,
  '非法 sameSite 应报错',
)
assert.match(
  cookieError(Array.from({ length: MAX_COOKIES + 1 }, (_, index) => ({
    name: `c${index}`,
    value: 'v',
    domain: '.deepseek.com',
  }))),
  /上限/,
  '超过 cookie 上限应报错',
)
assert.equal(DEFAULT_LOGIN_URL, 'https://chat.deepseek.com')

// ---- redactSecret：绝不输出完整 token ----
assert.equal(redactSecret(TOKEN), 'abcd…6789', '长 token 只保留首尾各 4 位')
assert.equal(redactSecret('short'), '***', '短 token 完全隐藏')
assert.ok(!redactSecret(TOKEN).includes(TOKEN), '脱敏结果不应包含完整 token')

// ---- probeNow 不触发后台副作用（onResult 只给定时探活用） ----
{
  let notified = 0
  const scheduler = new LoginProbeScheduler({
    target: { probeLogin: async () => ({ status: 'ok', checkedAt: 1 }) },
    onResult: () => { notified += 1 },
  })
  const result = await scheduler.probeNow()
  assert.equal(result.status, 'ok')
  assert.equal(notified, 0, '设置页手动检测不应触发 onResult（置前/日志）')
  assert.equal(scheduler.last()?.status, 'ok', '手动检测结果仍应更新 last()')
  scheduler.stop()
}

// ---- 路由契约：403 / 405 / 200 ----
interface FakeResponseState {
  status: number
  body: string
}

function makeResponse(): { res: BridgeResponse; state: FakeResponseState } {
  const state: FakeResponseState = { status: 0, body: '' }
  const res: BridgeResponse = {
    writeHead(status) { state.status = status },
    end(chunk) { state.body = chunk ?? '' },
  }
  return { res, state }
}

function makeRequest(
  method: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): BridgeRequest {
  const listeners = new Map<string, Array<(chunk?: unknown) => void>>()
  const request: BridgeRequest = {
    method,
    url: '/',
    headers: {
      host: '127.0.0.1:64577',
      'sec-fetch-site': 'same-origin',
      ...options.headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, listener) {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      if (event === 'data' && options.body !== undefined) listener(options.body)
      if (event === 'end') listener()
    },
  }
  return request
}

const routes = new Map<string, (req: BridgeRequest, res: BridgeResponse) => void | Promise<void>>()
const ctx = {
  webServer: {
    register(route: { kind: 'exact'; path: string; handler: (req: BridgeRequest, res: BridgeResponse) => void | Promise<void> }) {
      assert.ok(!routes.has(route.path), `路由重复注册: ${route.path}`)
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  },
} as unknown as BridgeContext

const calls: string[] = []
const data: LoginBridgeData = {
  current: () => ({ status: 'ok', checkedAt: 1, browserStarted: true, canOpen: true, canImport: true, canExport: true }),
  probe: async () => {
    calls.push('probe')
    return { status: 'ok', checkedAt: 2 }
  },
  open: async () => {
    calls.push('open')
    return { opened: true, loggedIn: false }
  },
  importLogin: async (bundle) => {
    calls.push(`import:${bundle.token === undefined ? 'no-token' : 'token'}`)
    return { status: { status: 'ok', checkedAt: 3 }, applied: { token: true, cookies: bundle.cookies?.length ?? 0 } }
  },
  exportLogin: async () => {
    calls.push('export')
    return { token: TOKEN, cookies: [] }
  },
}

const dispose = registerLoginRoutes(ctx, data)
assert.equal(routes.size, 5, '应注册 5 条路由')

// 同源 GET 状态
{
  const { res, state } = makeResponse()
  await routes.get(LOGIN_ROUTE)?.(makeRequest('GET'), res)
  assert.equal(state.status, 200)
  assert.equal(JSON.parse(state.body).value.status, 'ok')
}
// 跨站请求 403
{
  const { res, state } = makeResponse()
  await routes.get(LOGIN_ROUTE)?.(makeRequest('GET', { headers: { 'sec-fetch-site': 'cross-site' } }), res)
  assert.equal(state.status, 403, '跨站请求应拒绝')
}
// 方法不符 405
{
  const { res, state } = makeResponse()
  await routes.get(LOGIN_PROBE_ROUTE)?.(makeRequest('GET'), res)
  assert.equal(state.status, 405, 'GET 探活路由应 405')
}
// 探活
{
  const { res, state } = makeResponse()
  await routes.get(LOGIN_PROBE_ROUTE)?.(makeRequest('POST'), res)
  assert.equal(state.status, 200)
  assert.equal(JSON.parse(state.body).value.status, 'ok')
  assert.ok(calls.includes('probe'))
}
// 打开登录窗口
{
  const { res, state } = makeResponse()
  await routes.get(LOGIN_OPEN_ROUTE)?.(makeRequest('POST'), res)
  assert.equal(state.status, 200)
  assert.equal(JSON.parse(state.body).value.opened, true)
  assert.ok(calls.includes('open'))
}
// 导入：合法
{
  const { res, state } = makeResponse()
  await routes.get(LOGIN_IMPORT_ROUTE)?.(makeRequest('POST', { body: JSON.stringify({ raw: TOKEN }) }), res)
  assert.equal(state.status, 200)
  assert.equal(JSON.parse(state.body).value.applied.token, true)
  assert.ok(calls.includes('import:token'))
}
// 导入：非法 raw
{
  const { res, state } = makeResponse()
  await routes.get(LOGIN_IMPORT_ROUTE)?.(makeRequest('POST', { body: JSON.stringify({ raw: 'bad' }) }), res)
  assert.equal(state.status, 400)
  assert.equal(JSON.parse(state.body).code, 'LOGIN_STATE_INVALID')
}
// 导入：坏 JSON
{
  const { res, state } = makeResponse()
  await routes.get(LOGIN_IMPORT_ROUTE)?.(makeRequest('POST', { body: 'not-json' }), res)
  assert.equal(state.status, 400)
  assert.equal(JSON.parse(state.body).code, 'LOGIN_BODY_INVALID')
}
// 导入：请求体超限
{
  const { res, state } = makeResponse()
  await routes.get(LOGIN_IMPORT_ROUTE)?.(makeRequest('POST', { body: 'x'.repeat(MAX_LOGIN_BODY_BYTES + 1) }), res)
  assert.equal(state.status, 400)
  assert.equal(JSON.parse(state.body).code, 'LOGIN_BODY_TOO_LARGE')
}
// 导出：方法不符 405、跨站 403
{
  const { res, state } = makeResponse()
  await routes.get(LOGIN_EXPORT_ROUTE)?.(makeRequest('GET'), res)
  assert.equal(state.status, 405)
}
{
  const { res, state } = makeResponse()
  await routes.get(LOGIN_EXPORT_ROUTE)?.(makeRequest('POST', { headers: { 'sec-fetch-site': 'cross-site' } }), res)
  assert.equal(state.status, 403)
}
// 导出
{
  const { res, state } = makeResponse()
  await routes.get(LOGIN_EXPORT_ROUTE)?.(makeRequest('POST'), res)
  assert.equal(state.status, 200)
  assert.equal(JSON.parse(state.body).value.token, TOKEN)
  assert.ok(calls.includes('export'))
}
dispose()
assert.equal(routes.size, 0, 'dispose 应注销全部路由')

// 自定义 basePath：GLM 主通道复用同一套登录态路由，前缀必须是独立的。
{
  const glmRoutes = new Map<string, (req: BridgeRequest, res: BridgeResponse) => void | Promise<void>>()
  const glmCtx = {
    webServer: {
      register(route: { kind: 'exact'; path: string; handler: (req: BridgeRequest, res: BridgeResponse) => void | Promise<void> }) {
        assert.ok(!glmRoutes.has(route.path), `GLM 路由重复注册: ${route.path}`)
        glmRoutes.set(route.path, route.handler)
        return () => { glmRoutes.delete(route.path) }
      },
    },
  } as unknown as BridgeContext
  const disposeGlm = registerLoginRoutes(glmCtx, data, { basePath: '/api/dsh-deepseek-web/glm-login' })
  assert.equal(glmRoutes.size, 5, 'GLM 通道应注册 5 条路由')
  const { res, state } = makeResponse()
  await glmRoutes.get('/api/dsh-deepseek-web/glm-login')?.(makeRequest('GET'), res)
  assert.equal(state.status, 200)
  assert.equal(JSON.parse(state.body).value.status, 'ok')
  disposeGlm()
  assert.equal(glmRoutes.size, 0, 'GLM dispose 应注销全部路由')
}

console.log('login-state-check: ok')
