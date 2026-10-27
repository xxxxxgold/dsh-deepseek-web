/**
 * GLM 登录态契约检查（不启动浏览器）。
 *
 * 用法：tsx tools/glm-login-check.ts
 */
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

const channel = new GLMChannel({ config })
check(channel.isBrowserStarted() === false, '未启动时 isBrowserStarted=false', String(channel.isBrowserStarted()))
const probe = await channel.probeLogin()
check(probe.status === 'unknown', '未启动时探活返回 unknown', probe.status)
check(
  (probe.detail ?? '').includes('浏览器还没启动'),
  '未启动时提示不会拉起浏览器',
  probe.detail ?? '',
)
check(typeof channel.openLoginWindow === 'function', 'GLM 通道支持打开登录窗口', typeof channel.openLoginWindow)
await channel.dispose()

if (failed === 0) console.log('OK（GLM 登录态：只读探活 / 打开入口）')
process.exit(failed === 0 ? 0 : 1)
