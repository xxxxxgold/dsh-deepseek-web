/**
 * `npm run doctor`：跑一遍安装自检并打印报告。
 *
 * 两种模式：
 *   npm run doctor            完整自检（会打开/复用浏览器，检查登录态与选择器）
 *   npm run doctor -- --offline  只跑静态检查（配置 / 浏览器 / 目录 / 构建标识），不启动浏览器
 *
 * 退出码：0 = ready，1 = not ready。CI 与用户排障都用得到。
 *
 * @module dsh-deepseek-web/tools/doctor
 */

import path from 'node:path'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { defaultProfileDir } from '../src/browser-shared.ts'
import { formatDoctorReport, runDoctor } from '../src/doctor.ts'

const offline = process.argv.includes('--offline')

const config = liveConfig(Config({
  sendMode: 'approved',
  model: 'deepseek-web',
  // 自检不抢窗口焦点，也不该去开 Kimi/GLM 的审核窗口
  focus: { enabled: false },
  review: { enabled: false },
}))

const appDataRoot = process.env.LOCALAPPDATA ?? path.join(process.env.HOME ?? '.', 'AppData', 'Local')
const profileDir = config.browser === 'attach'
  ? defaultProfileDir('edge-profile')
  : (config.profileDir || defaultProfileDir('edge-profile'))
const stateFile = config.stateFile ?? path.join(appDataRoot, 'DshDeepSeekWeb', 'session-state.json')

const report = await runDoctor({
  config,
  profileDir,
  stateFile,
  live: !offline,
})
console.info(formatDoctorReport(report))
process.exit(report.ok ? 0 : 1)
