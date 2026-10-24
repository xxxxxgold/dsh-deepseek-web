/**
 * 真机发送探针（手动运行，不做自动断言）。
 *
 * 用途：验证「网页回合」这条**真实链路**能否跑通——连上已登录的 Edge、把一句话
 * 填进 deepseek 输入框、回车发送、拿到网页完整回复并解析。
 * 离线回归（`npm run test:parsers`）覆盖的是纯函数与静态契约；这条链路上的
 * 打包器注入问题（`__name`）、超时包装（`withTimeout`）只有真跑才会暴露。
 *
 * 用法：
 *   npx tsx tools/manual/probe-send.ts
 *
 * 前置：本机已装 Edge、DSH 网页端已登录（attach 模式连 9333 端口）。
 * 注意：会**真实发送一条消息**，消耗一次账号额度。失败时打印错误名/码/栈，
 * 并以退出码 1 结束，便于脚本化判定。
 */
import { Config } from '../../src/config.ts'
import { liveConfig } from '../../src/live-config.ts'
import { PlaywrightBrowserChannel } from '../../src/playwright-channel.ts'

const config = liveConfig(Config({
  sendMode: 'approved',
  model: 'deepseek-web',
  browser: 'attach',
  channel: 'msedge',
  debugPort: 9333,
  focus: { enabled: false },
  review: { enabled: false },
}))

const channel = new PlaywrightBrowserChannel({ config })
await channel.ensureReady()
console.log('ready')

const controller = new AbortController()
try {
  const result = await channel.turn({
    sessionId: 'dsh-probe',
    model: 'deepseek-web',
    initialize: false,
    text: '这是自检，请只回复四个字：链路正常',
    autoSend: true,
    signal: controller.signal,
  })
  console.log('OK', JSON.stringify(result).slice(0, 800))
} catch (error) {
  const failure = error as { constructor?: { name?: string }; code?: string; message?: string; stack?: string }
  console.error('ERR_NAME', failure.constructor?.name)
  console.error('ERR_CODE', failure.code)
  console.error('ERR_MSG', failure.message)
  console.error('ERR_STACK', failure.stack?.split('\n').slice(0, 12).join('\n'))
  process.exitCode = 1
}
