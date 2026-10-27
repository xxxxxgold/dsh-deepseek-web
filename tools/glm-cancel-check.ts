/**
 * GLM 通道取消语义检查。
 *
 * 覆盖复审指出的竞态：
 *   1. cancelTurn 必须能中止「还没有页面」的控制器；
 *   2. pageFor 期间取消，返回后必须补关页面并抛 GLM_CANCELLED；
 *   3. already-aborted signal 在进入 runTurn 前就结束。
 *
 * 用假 Page 对象，不启动浏览器。
 * 用法：tsx tools/glm-cancel-check.ts
 */
import type { Page } from 'playwright-core'
import type { BrowserTurnRequest } from '../src/browser-channel.ts'
import type { ReviewConfig } from '../src/config.ts'
import { GLMChannel } from '../src/glm-channel.ts'

let failed = 0
function check(ok: boolean, label: string, detail: string): void {
  if (ok) {
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}：${detail}`)
  }
}

const config = {
  glmUrl: 'https://chatglm.cn/',
  glmDebugPort: 9337,
  streamIdleTimeoutMs: 600_000,
} as unknown as ReviewConfig

function makePage(url = 'https://chatglm.cn/'): { page: Page; closed: () => boolean } {
  let closed = false
  const page = {
    close: async () => { closed = true },
    isClosed: () => closed,
    url: () => url,
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    bringToFront: async () => undefined,
    evaluate: async () => false,
  } as unknown as Page
  return { page, closed: () => closed }
}

function channelWith(): {
  channel: GLMChannel
  maps: { pages: Map<string, Page>; controllers: Map<string, AbortController>; needsFresh: Set<string> }
} {
  const channel = new GLMChannel({ config })
  const maps = {
    pages: (channel as unknown as { pages: Map<string, Page> }).pages,
    controllers: (channel as unknown as { controllers: Map<string, AbortController> }).controllers,
    needsFresh: (channel as unknown as { needsFresh: Set<string> }).needsFresh,
  }
  return { channel, maps }
}

// 1) 只有控制器、没有页面：cancelTurn 也必须 abort。
{
  const { channel, maps } = channelWith()
  const controller = new AbortController()
  maps.controllers.set('s1', controller)
  await channel.cancelTurn('s1')
  check(controller.signal.aborted, 'cancelTurn 中止无页面的控制器', String(controller.signal.aborted))
}

// 2) 有页面：cancelTurn 保留页面、标记下次开新对话（不关页，避免标签抖动）。
{
  const { channel, maps } = channelWith()
  const { page, closed } = makePage()
  maps.pages.set('s2', page)
  maps.controllers.set('s2', new AbortController())
  await channel.cancelTurn('s2')
  check(
    !closed() && maps.pages.has('s2') && !maps.controllers.has('s2') && maps.needsFresh.has('s2'),
    'cancelTurn 保留页面并标记新对话',
    `closed=${closed()} pages=${maps.pages.has('s2')} fresh=${maps.needsFresh.has('s2')}`,
  )
  check(channel.isConversationActive('s2') === false, '取消后 isConversationActive=false', 'true')
}

// 3) pageFor 期间取消：保留页面、标记新对话，错误码必须是 GLM_CANCELLED。
{
  const { channel, maps } = channelWith()
  const { page, closed } = makePage()
  ;(channel as unknown as { pageFor: (id: string) => Promise<Page> }).pageFor = async () => {
    await new Promise(resolve => setTimeout(resolve, 60))
    return page
  }
  const request = {
    sessionId: 's3',
    model: 'glm-5.3',
    text: 'hello',
    initialize: false,
    autoSend: true,
  } as BrowserTurnRequest
  const running = channel.turn(request).catch((error: unknown) => error)
  await new Promise(resolve => setTimeout(resolve, 10))
  await channel.cancelTurn('s3')
  const error = await running
  check((error as { code?: string }).code === 'GLM_CANCELLED', 'pageFor 期间取消抛 GLM_CANCELLED', String((error as { code?: string }).code))
  check(!closed(), 'pageFor 期间取消保留页面（不关标签）', String(closed()))
  check(maps.needsFresh.has('s3'), 'pageFor 期间取消标记下次新对话', String(maps.needsFresh.has('s3')))
}

// 4) 传入 already-aborted signal：不触碰浏览器直接取消。
{
  const { channel } = channelWith()
  const controller = new AbortController()
  controller.abort()
  const error = await channel.turn({
    sessionId: 's4',
    model: 'glm-5.3',
    text: 'hello',
    initialize: false,
    autoSend: true,
    signal: controller.signal,
  }).catch((reason: unknown) => reason)
  check((error as { code?: string }).code === 'GLM_CANCELLED', '已取消 signal 直接抛 GLM_CANCELLED', String((error as { code?: string }).code))
}

// 5) 浏览器启动自带的同源空白页要被复用，不能再 newPage 一个。
{
  const { channel } = channelWith()
  const { page: initial, closed } = makePage()
  let created = 0
  ;(channel as unknown as { browser: unknown }).browser = { isConnected: () => true }
  ;(channel as unknown as { context: unknown }).context = {
    pages: () => [initial],
    newPage: async () => {
      created += 1
      return makePage('https://chatglm.cn/other').page
    },
  }
  const page = await (channel as unknown as { pageFor: (id: string) => Promise<Page> }).pageFor('reuse')
  check(page === initial && created === 0 && !closed(), 'pageFor 复用启动自带同源页', `created=${created}`)
}

// 6) 「打开浏览器去登录」不能把页面占成登录专用页；下一次聊天应能接管它。
{
  const { channel, maps } = channelWith()
  const { page } = makePage()
  ;(channel as unknown as { browser: unknown }).browser = { isConnected: () => true }
  ;(channel as unknown as { context: unknown }).context = {
    pages: () => [page],
    newPage: async () => makePage('https://chatglm.cn/other').page,
  }
  const opened = await channel.openLoginWindow()
  check(opened.opened === true && maps.pages.size === 0, '登录窗口不占用会话页', `assigned=${maps.pages.size}`)
  const reused = await (channel as unknown as { pageFor: (id: string) => Promise<Page> }).pageFor('after-login')
  check(reused === page && maps.pages.get('after-login') === page, '登录后的首个会话复用登录页', 'new tab created')
}

if (failed === 0) console.log('OK（GLM 取消语义：控制器 / 页面 / pageFor 竞态）')
process.exit(failed === 0 ? 0 : 1)
