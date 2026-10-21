/**
 * 离线回归：浏览器/标签页被关掉时的识别与自愈。
 *
 * 这一条要防的失败是「用户手滑关了浏览器，插件当没看见」：回合直接报一个
 * plawright 的英文报错，人得自己去翻日志才知道发生了什么。这里断言三件事：
 * 1. 只把「关闭类」报错认成可自愈，频控/超时/取消不能被误判（否则会把正常
 *    错误掩盖成"重启浏览器"）；
 * 2. 浏览器还活着时只补标签页，不重启浏览器（不能把用户其它标签页一锅端）；
 * 3. 浏览器整个没了才放掉连接句柄并重新拉起，同时留下「恢复」提示。
 */
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { isBrowserClosedMessage } from '../src/browser-shared.ts'
import type { BrowserTurnRequest } from '../src/browser-channel.ts'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { PlaywrightBrowserChannel } from '../src/playwright-channel.ts'

const tempDir = path.join(os.tmpdir(), `dsh-browser-recovery-${process.pid}`)

// ---- 1. 报错文本识别 ----
const closedSamples = [
  'Target page, context or browser has been closed',
  'Target browser has been closed',
  'Browser has been closed',
  'browser has been disconnected',
  'Connection closed',
  '连接已断开',
]
for (const sample of closedSamples) {
  assert.equal(isBrowserClosedMessage(sample), true, `应判为关闭类：${sample}`)
}
const notClosedSamples = [
  'deepseek-web: 网页提示发送过于频繁，请稍后重试',
  'deepseek-web: 本次网页回合超过单回合上限（900s）',
  'deepseek-web: 等待频控重发期间回合被取消。',
  'Request failed with status code 500',
]
for (const sample of notClosedSamples) {
  assert.equal(isBrowserClosedMessage(sample), false, `不应判为关闭类：${sample}`)
}

// ---- 2. 通道级判定与自愈 ----
const proto = PlaywrightBrowserChannel.prototype as unknown as {
  browserClosed: (this: unknown, error: unknown) => boolean
  recoverBrowser: (
    this: unknown,
    request: BrowserTurnRequest,
    attempt: number,
    maxAttempts: number,
    error: unknown,
    sessionId: string,
  ) => Promise<void>
}

function fakeChannel(options: { connected: boolean; delayMs?: number }) {
  const config = liveConfig(Config({
    stateFile: path.join(tempDir, 'state.json'),
    browserRecovery: { delayMs: options.delayMs ?? 0 },
  })) as unknown as { notify: Record<string, boolean> }
  const collected: string[] = []
  const calls: string[] = []
  const closedPage = { isClosed: () => true, close: async () => {} }
  const deadBrowser = { isConnected: () => false, close: async () => {} }
  const liveBrowser = { isConnected: () => true, close: async () => {} }
  const instance = Object.create(PlaywrightBrowserChannel.prototype) as Record<string, unknown>
  Object.assign(instance, {
    options: { config },
    lastNoticeAt: new Map<string, number>(),
    sessionPages: new Map([['session-1', { sessionId: 'session-1', page: closedPage, started: false, lastUsedAt: 0 }]]),
    creatingPages: new Map(),
    pendingPages: new Set<unknown>(),
    page: closedPage,
    browser: options.connected ? liveBrowser : deadBrowser,
    context: { pages: () => [] },
    managedConnection: options.connected ? undefined : { browser: deadBrowser, process: { killed: true } },
    ensureReady: async () => { calls.push('ensureReady') },
  })
  const request = {
    sessionId: 'session-1',
    onNotice: (notice: { text: string }) => { collected.push(notice.text) },
  } as unknown as BrowserTurnRequest
  return { collected, calls, instance, request, closedPage, liveBrowser, deadBrowser }
}

// 2a. 判定：关闭类报错才算可自愈
{
  const { instance, liveBrowser } = fakeChannel({ connected: true })
  const closed = proto.browserClosed.call(instance, new LlmError('页面没了', 'WEB_PAGE_CLOSED'))
  assert.equal(closed, true, 'WEB_PAGE_CLOSED 应可自愈')
  const rateLimited = proto.browserClosed.call(instance, new LlmError('太频繁', 'WEB_RATE_LIMITED'))
  assert.equal(rateLimited, false, '频控不该触发浏览器自愈')
  const timeout = proto.browserClosed.call(instance, new LlmError('超时', 'WEB_TURN_TIMEOUT'))
  assert.equal(timeout, false, '回合超时不该触发浏览器自愈')
  const rawClosed = proto.browserClosed.call(instance, new Error('Target page, context or browser has been closed'))
  assert.equal(rawClosed, true, 'Playwright 的关闭报错应可自愈')
  // 浏览器对象已经断了：任何错误都按可自愈处理（在死连接上重试没有意义）
  ;(instance as { browser: unknown }).browser = { isConnected: () => false }
  const deadBrowserFailure = proto.browserClosed.call(instance, new Error('随便什么错'))
  assert.equal(deadBrowserFailure, true, '浏览器已断开时任何错误都应可自愈')
  ;(instance as { browser: unknown }).browser = liveBrowser
}

// 2b. 浏览器还活着：只补标签页，不重启浏览器
{
  const { collected, calls, instance, request, liveBrowser } = fakeChannel({ connected: true })
  await proto.recoverBrowser.call(instance, request, 1, 2, new Error('Target page has been closed'), 'session-1')
  assert.deepEqual(calls, ['ensureReady'], '应调用一次 ensureReady 补页')
  assert.equal((instance as { browser: unknown }).browser, liveBrowser, '浏览器活着时不能被清掉')
  assert.equal((instance as { sessionPages: Map<string, unknown> }).sessionPages.size, 0, '旧会话页登记必须清掉')
  assert.equal((instance as { page?: unknown }).page, undefined, '锚点页指针要跟着失效')
  assert.equal(collected[0], '[DSH] 恢复 · 网页标签被关掉了，正在重新打开标签页（第 1/2 次）')
  assert.equal(collected.at(-1), '[DSH] 恢复 · 浏览器已就绪，正在重新打开网页并重发本轮消息')
  assert.ok(collected.length >= 2, '至少要有"开始恢复"和"已就绪"两条提示')
}

// 2c. 浏览器整个没了：放掉连接并重新拉起
{
  const { collected, calls, instance, request } = fakeChannel({ connected: false })
  await proto.recoverBrowser.call(instance, request, 2, 2, new Error('Target browser has been closed'), 'session-1')
  assert.deepEqual(calls, ['ensureReady'], '应调用一次 ensureReady 重启')
  assert.equal((instance as { browser?: unknown }).browser, undefined, '死连接必须放掉')
  assert.equal((instance as { context?: unknown }).context, undefined, '死 context 必须放掉')
  assert.equal((instance as { managedConnection?: unknown }).managedConnection, undefined)
  assert.equal(collected[0], '[DSH] 恢复 · 浏览器被关掉了，正在重新启动浏览器（第 2/2 次）')
}

// 2d. 提示可关：关掉过程提示后自愈照常发生，只是不出声
{
  const { collected, calls, instance, request } = fakeChannel({ connected: false })
  ;(instance as { options: { config: { notify: Record<string, boolean> } } })
    .options.config.notify.enabled = false
  await proto.recoverBrowser.call(instance, request, 1, 2, new Error('Target browser has been closed'), 'session-1')
  assert.equal(collected.length, 0, '关掉总开关后不该再发提示')
  assert.deepEqual(calls, ['ensureReady'], '自愈本身不受提示开关影响')
}

await rm(tempDir, { recursive: true, force: true }).catch(() => {})

console.log('OK: 关闭类报错识别、标签页补页、浏览器重启与提示开关均正确')
