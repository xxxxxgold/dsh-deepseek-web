/**
 * 真机验证（手动跑，不进 test:parsers：它会真的启动一个 Edge 进程再把它杀掉）。
 *
 *   npx tsx tools/manual/browser-realcheck.ts
 *
 * 离线回归 `tools/browser-recovery-check.ts` 里的 `ensureReady()` 是 stub，
 * 所以只能证明「判定了、调用了、提示了」，证明不了「浏览器真被关了以后还能拉起来」。
 * 这里补的两件事：
 * 1. 真实 Playwright 在浏览器进程被杀之后抛出的报错文本，能否命中
 *    `isBrowserClosedMessage()`——正则写错了就会表现成「关掉浏览器后不恢复」；
 * 2. 用同一个 profile 目录在进程被杀后能否重新拉起（pid 必须变化）——这是
 *    `recoverBrowser()` 重启分支真正依赖的能力，profile 锁残留则说明
 *    `browserRecovery.delayMs` 不能设成 0。
 *
 * 全程使用临时 profile + 独立端口，不碰本机正在用的 Edge profile。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isBrowserClosedMessage, launchManagedBrowser } from '../../src/browser-shared.ts'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const profileDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-realcheck-'))
const channel = (process.env.DSH_REALCHECK_CHANNEL as 'msedge' | 'chrome' | undefined) ?? 'msedge'
const port = Number(process.env.DSH_REALCHECK_PORT ?? 9731)

console.log(`profile: ${profileDir}`)
console.log(`channel: ${channel}  preferredPort: ${port}`)

const first = await launchManagedBrowser({ channel, profileDir, preferredPort: port, url: 'about:blank', label: 'realcheck' })
assert.equal(first.browser.isConnected(), true, '首次启动后浏览器必须处于连接状态')
const firstPid = first.process.pid
console.log(`首次启动 OK：pid=${firstPid} port=${first.port}`)

const page = await first.context.newPage()
await page.goto('about:blank')

// ---- 1. 杀掉浏览器进程，捕获真实报错文本 ----
first.process.kill()
let disconnected = false
for (let index = 0; index < 120; index += 1) {
  if (!first.browser.isConnected()) {
    disconnected = true
    break
  }
  await sleep(100)
}
assert.equal(disconnected, true, '进程被 kill 后 browser.isConnected() 必须变 false')

let message = ''
try {
  await page.evaluate('1 + 1')
} catch (error) {
  message = error instanceof Error ? error.message : String(error)
}
console.log(`真实报错文本：${JSON.stringify(message)}`)
assert.equal(isBrowserClosedMessage(message), true, `真实关闭报错必须被 isBrowserClosedMessage 识别：${message}`)
console.log('OK: 关闭类正则能识别 Playwright 的真实报错')

// ---- 2. 同一 profile 重新拉起 ----
const restartStartedAt = Date.now()
let second
try {
  second = await launchManagedBrowser({ channel, profileDir, preferredPort: port, url: 'about:blank', label: 'realcheck' })
} catch (error) {
  console.error('立即重启失败（说明 delayMs 不能是 0）：', error instanceof Error ? error.message : error)
  await sleep(2_000)
  second = await launchManagedBrowser({ channel, profileDir, preferredPort: port, url: 'about:blank', label: 'realcheck' })
}
const restartMs = Date.now() - restartStartedAt
assert.equal(second.browser.isConnected(), true, '重新拉起后必须连上')
assert.notEqual(second.process.pid, firstPid, '必须是新进程，不是复用死掉的那个')
console.log(`重新拉起 OK：pid=${second.process.pid}（旧 ${firstPid}）耗时 ${restartMs}ms`)
console.log('OK: 浏览器被杀后能用同一 profile 重新拉起')

await second.browser.close().catch(() => {})
if (second.process && !second.process.killed) second.process.kill()
await sleep(500)

// ---- 3. 真通道自愈：直接调 recoverBrowser()，ensureReady 用真实现 ----
// url 用 about:blank 是为了绕开 chat.deepseek.com 的登录检查（临时 profile 没有登录态），
// 自愈循环本身与站点无关。
{
  const { Config } = await import('../../src/config.ts')
  const { liveConfig } = await import('../../src/live-config.ts')
  const { PlaywrightBrowserChannel } = await import('../../src/playwright-channel.ts')
  const profile2 = path.join(profileDir, 'profile2')
  const config = liveConfig(Config({
    stateFile: path.join(profileDir, 'state.json'),
    url: 'about:blank',
    browser: 'managed',
    channel,
    debugPort: port + 1,
    profileDir: profile2,
    autoStartKeeper: false,
    browserRecovery: { enabled: true, maxAttempts: 2, delayMs: 500 },
  })) as never
  const channelImpl = new PlaywrightBrowserChannel({ config, profileDir: profile2 })
  await channelImpl.ensureReady()
  const livePid = channelImpl.managedConnection?.process?.pid
  console.log(`真通道首次 ensureReady OK：pid=${livePid}`)
  channelImpl.managedConnection?.process.kill()
  for (let index = 0; index < 120; index += 1) {
    if (channelImpl.browser?.isConnected() !== true) break
    await sleep(100)
  }
  assert.equal(channelImpl.browser?.isConnected(), false, 'kill 后真通道的 browser 必须已断开')

  const notices: string[] = []
  const request = { sessionId: 'realcheck', onNotice: (notice: { text: string }) => { notices.push(notice.text) } }
  await (channelImpl as unknown as {
    recoverBrowser: (req: unknown, attempt: number, max: number, error: unknown, session: string) => Promise<void>
  }).recoverBrowser(request, 1, 2, new Error('Target browser has been closed'), 'realcheck')

  assert.equal(channelImpl.browser?.isConnected(), true, '自愈后必须重新连上')
  assert.notEqual(channelImpl.managedConnection?.process?.pid, livePid, '自愈必须拉起新进程')
  assert.equal(notices[0], '[DSH] 恢复 · 浏览器被关掉了，正在重新启动浏览器（第 1/2 次）')
  assert.equal(notices.at(-1), '[DSH] 恢复 · 浏览器已就绪，正在重新打开网页并重发本轮消息')
  console.log(`真通道自愈 OK：pid=${channelImpl.managedConnection?.process?.pid}，提示 ${notices.length} 条`)
  console.log(`  ${notices.join(' | ')}`)

  // ---- 4. 只关标签页：必须保留浏览器进程，只补一个新页 ----
  const browserBefore = channelImpl.browser
  const pidBefore = channelImpl.managedConnection?.process?.pid
  await channelImpl.page?.close()
  const notices2: string[] = []
  await (channelImpl as unknown as {
    recoverBrowser: (req: unknown, attempt: number, max: number, error: unknown, session: string) => Promise<void>
  }).recoverBrowser(
    { sessionId: 'realcheck2', onNotice: (notice: { text: string }) => { notices2.push(notice.text) } },
    1, 2, new Error('page.close() 造成的关闭'), 'realcheck2',
  )
  assert.equal(channelImpl.browser, browserBefore, '只关标签页不能换掉浏览器对象')
  assert.equal(channelImpl.managedConnection?.process?.pid, pidBefore, '只关标签页不能重启浏览器进程')
  assert.equal(channelImpl.browser?.isConnected(), true)
  assert.ok(channelImpl.page !== undefined && !channelImpl.page.isClosed(), '必须补出一个可用的标签页')
  assert.equal(notices2[0], '[DSH] 恢复 · 网页标签被关掉了，正在重新打开标签页（第 1/2 次）')
  console.log(`只关标签页 OK：浏览器 pid 未变（${pidBefore}），已补新页`)

  await channelImpl.dispose().catch(() => {})
}

await rm(profileDir, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
  console.warn('临时 profile 清理失败（不影响结论）：', error instanceof Error ? error.message : error)
})

console.log('真机验证完成：识别 + 重启两条路径均成立')
