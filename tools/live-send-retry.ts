/**
 * 真实重试：在真实 chat.deepseek.com 页面跑一轮「全自动发送 → 等响应 → 解析」，
 * 验证三件事同时成立：
 *   1. 发送动作确实触发（sendEditorMessage 确认，而不是填完就等）；
 *   2. 网页确实回了；
 *   3. dsh 这边确实取到了正文。
 * 任一不成立就以非零退出，并打印每一步的时间戳，方便对照网页实际表现。
 */
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { PlaywrightBrowserChannel } from '../src/playwright-channel.ts'

const config = liveConfig(Config({
  sendMode: 'approved',
  model: 'deepseek-web',
  // 允许复用已在跑的调试浏览器（残留实例占用端口时不必重启）：
  // LIVE_RETRY_BROWSER=attach LIVE_RETRY_PORT=9333 LIVE_RETRY_CHANNEL=chrome
  browser: (process.env.LIVE_RETRY_BROWSER as 'managed' | 'attach' | undefined) ?? 'managed',
  channel: (process.env.LIVE_RETRY_CHANNEL as 'msedge' | 'chrome' | undefined) ?? 'msedge',
  debugPort: Number(process.env.LIVE_RETRY_PORT ?? 9333),
  // 自检不抢窗口焦点，避免把用户正在用的窗口顶掉
  focus: { enabled: false },
  // 审核通道与本检查无关，关掉免得它去开 Kimi/GLM 页面
  review: { enabled: false },
}))

const started = Date.now()
const steps: string[] = []
const mark = (label: string): void => {
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  steps.push(`${seconds}s  ${label}`)
  console.info(`[live-retry ${seconds}s] ${label}`)
}

const channel = new PlaywrightBrowserChannel({ config })
const text = '这是 dsh 自动发送链路的自检消息，请只回复四个字：链路正常'

// 硬闹钟：卡死在接收环节时也要把现场留下来（否则只能看到进程不结束）。
const watchdog = setTimeout(() => {
  console.error(`[live-retry] 90 秒仍未返回，卡在最后一步：${steps.at(-1) ?? '(未记录)'}`)
  console.info(`[live-retry] 步骤时间线：\n${steps.map(line => `  - ${line}`).join('\n')}`)
  process.exit(2)
}, 90_000)
watchdog.unref?.()

try {
  mark('ensureReady：打开/连接浏览器')
  await channel.ensureReady()
  mark('浏览器就绪（已登录 chat.deepseek.com）')

  mark('turn：填入 + 全自动发送 + 等响应')
  const result = await channel.turn({
    sessionId: 'dsh-live-retry',
    model: 'deepseek-web',
    text,
    initialize: true,
    autoSend: true,
  })
  mark('收到响应')

  const body = result.text.trim()
  console.info('[live-retry] 结果：成功')
  console.info(`[live-retry] 正文（前 120 字）：${JSON.stringify(body.slice(0, 120))}`)
  console.info(`[live-retry] 正文长度：${body.length} 字`)
  console.info(`[live-retry] finishReason：${result.finishReason ?? '(网页未提供)'}`)
  console.info(`[live-retry] meta：${JSON.stringify(result.meta ?? {})}`)
  if (body.length === 0) {
    console.error('[live-retry] 失败：dsh 取到的正文为空')
    process.exitCode = 1
  }
} catch (error) {
  mark('异常退出')
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  console.error(`[live-retry] 失败：${detail}`)
  process.exitCode = 1
} finally {
  console.info(`[live-retry] 步骤时间线：\n${steps.map(line => `  - ${line}`).join('\n')}`)
  clearTimeout(watchdog)
  await channel.dispose().catch(() => {})
  // 被连接的调试浏览器会让 Node 保持事件循环：检查完直接结束进程，避免测量脚本自身挂住。
  process.exit(process.exitCode ?? 0)
}
