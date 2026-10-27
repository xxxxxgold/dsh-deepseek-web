/**
 * 安装自检（doctor）：把「插件到底卡在哪一步」变成一条条可核对的结论。
 *
 * 设计参照竞品 `@wlv-zedd/dsh-chatgpt-web` 的 doctor：**只报事实与 detail，
 * 不做修复**；本机无法证明的项目一律标 `warning`，绝不用 `ok` 假装全绿。
 *
 * 两类检查分开，是为了让其中一半能离线跑：
 * - 静态检查（配置 / 浏览器可执行文件 / profile 可写 / 状态文件目录 / 构建标识）
 *   不启动浏览器，几十毫秒出结果，`tools/doctor.ts --offline` 与离线回归都能用；
 * - 在线检查（CDP 端口 / 登录态 / 选择器命中）需要真实页面，只在真机跑。
 *
 * @module dsh-deepseek-web/doctor
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import type { Config } from './config.ts'
import { BUILD } from './build-info.ts'
import { Ledger } from './ledger.ts'
import {
  EDITOR_CANDIDATES,
  SEND_BUTTON_CANDIDATES,
  defaultProfileDir,
  launchManagedBrowser,
  looksLoggedOut,
  looksLoginWall,
  resolveBrowserExecutable,
} from './browser-shared.ts'

export type CheckStatus = 'ok' | 'warning' | 'error'

export interface DoctorCheck {
  /** 稳定 id，便于日志里 grep（页面改版排查时按它定位）。 */
  id: string
  status: CheckStatus
  /** 一句话结论。 */
  message: string
  /** 证据：路径、版本、命中项、原始报错。 */
  detail?: string
}

export interface DoctorReport {
  ok: boolean
  build: string
  checks: DoctorCheck[]
}

/** 选择器诊断结果：哪些候选真的命中了，哪些一条都没命中。 */
export interface SelectorSummary {
  hit: string[]
  miss: string[]
  detail: string
}

/**
 * 汇总选择器命中情况（纯函数，便于离线断言）。
 *
 * 页面改版时最有用的信息不是「没找到输入框」，而是「5 个候选里 0 个命中」——
 * 这说明站点结构整体变了，而不是某一条选择器写错。
 */
export function summarizeCandidates(
  candidates: readonly string[],
  hits: readonly string[],
): SelectorSummary {
  const hitSet = new Set(hits)
  const hit = candidates.filter(candidate => hitSet.has(candidate))
  const miss = candidates.filter(candidate => !hitSet.has(candidate))
  const detail = hit.length === 0
    ? `0/${candidates.length} 命中：${miss.join(' | ')}`
    : `${hit.length}/${candidates.length} 命中：${hit.join(' | ')}`
      + `${miss.length > 0 ? `；未命中：${miss.join(' | ')}` : ''}`
  return { hit, miss, detail }
}

/** 目录可写性：真写一个临时文件再删掉，比 access(W_OK) 可信（Windows 上后者常年撒谎）。 */
export async function probeDirWritable(dir: string): Promise<{ ok: boolean; detail: string }> {
  const file = join(dir, `.dsh-doctor-${process.pid}-${Date.now()}.tmp`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(file, 'ok', 'utf8')
    await unlink(file)
    return { ok: true, detail: dir }
  } catch (error) {
    return { ok: false, detail: `${dir}：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 读构建加载戳（%LOCALAPPDATA%\DshDeepSeekWeb\loaded-build.json）。 */
export async function readLoadStamp(): Promise<{ build?: string; module?: string; pid?: number; at?: string } | undefined> {
  const base = process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local')
  try {
    const raw = await readFile(join(base, 'DshDeepSeekWeb', 'loaded-build.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    return {
      ...typeof record.build === 'string' ? { build: record.build } : {},
      ...typeof record.module === 'string' ? { module: record.module } : {},
      ...typeof record.pid === 'number' ? { pid: record.pid } : {},
      ...typeof record.at === 'string' ? { at: record.at } : {},
    }
  } catch {
    return undefined
  }
}

/** CDP 端口是否已经有浏览器在监听（也回答「DSH 是不是正占用着这个浏览器」）。 */
export async function probeCdpPort(port: number, timeoutMs = 1_500): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

/** 静态检查：不启动浏览器。 */
export async function collectStaticChecks(options: {
  config: Config
  profileDir: string
  stateFile: string
  /** 浏览器可执行文件解析器；不传就报 warning 跳过（不在这里硬编码平台路径）。 */
  resolveBrowser?: (channel: 'msedge' | 'chrome') => string | undefined
  /**
   * 构建加载戳读取器；默认读用户真实目录。
   *
   * 为什么要能注入：离线回归跑在开发机上，而 readLoadStamp() 读的是**全局用户目录**，
   * 只要用户装过一次插件，测试就会拿到与 dev 不同的构建标识，把「两个浏览器都在」的用例判成 error。
   * 这类「测试依赖本机环境」的问题会让 CI 绿、开发机红，比不测还误导人。
   */
  readStamp?: () => Promise<{ build?: string; module?: string; pid?: number; at?: string } | undefined>
}): Promise<DoctorCheck[]> {
  const { config, profileDir, stateFile } = options
  const checks: DoctorCheck[] = []
  const resolveBrowser = options.resolveBrowser ?? resolveBrowserExecutable
  const readStamp = options.readStamp ?? readLoadStamp

  // 1. 浏览器可执行文件：两个 channel 都查，报告实际命中的那个。
  const edge = resolveBrowser('msedge')
  const chrome = resolveBrowser('chrome')
  if (edge !== undefined || chrome !== undefined) {
    checks.push({
      id: 'browser-executable',
      status: 'ok',
      message: `找到 ${config.channel === 'msedge' ? 'Edge' : 'Chrome'} 可执行文件`,
      detail: [
        edge !== undefined ? `msedge: ${edge}` : 'msedge: 未找到',
        chrome !== undefined ? `chrome: ${chrome}` : 'chrome: 未找到',
        `当前配置使用 ${config.channel}`,
      ].join('\n'),
    })
    if (config.channel === 'msedge' && edge === undefined) {
      checks.push({
        id: 'browser-channel-missing',
        status: 'error',
        message: `配置指定 msedge，但本机没有找到 Edge`,
        detail: chrome !== undefined ? `可改用 chrome：${chrome}` : '两种浏览器都没找到，请先安装 Edge 或 Chrome',
      })
    }
    if (config.channel === 'chrome' && chrome === undefined) {
      checks.push({
        id: 'browser-channel-missing',
        status: 'error',
        message: `配置指定 chrome，但本机没有找到 Chrome`,
        detail: edge !== undefined ? `可改用 msedge：${edge}` : '两种浏览器都没找到，请先安装 Edge 或 Chrome',
      })
    }
  } else {
    checks.push({
      id: 'browser-executable',
      status: 'error',
      message: '本机没有找到 Edge 或 Chrome',
      detail: '插件需要真实浏览器窗口；请安装其中一个后重试',
    })
  }

  // 2. profile 目录可写（登录态存这里，不可写等于每次都要重新登录）。
  if (config.browser === 'attach') {
    checks.push({
      id: 'profile',
      status: 'ok',
      message: 'attach 模式复用外部浏览器 profile，不需要本插件目录',
      detail: `调试端口 ${config.debugPort}`,
    })
  } else {
    const profile = await probeDirWritable(profileDir)
    checks.push({
      id: 'profile',
      status: profile.ok ? 'ok' : 'error',
      message: profile.ok ? 'profile 目录可写' : 'profile 目录不可写，登录态会存不下来',
      detail: profile.detail,
    })
  }

  // 3. 状态文件目录可写（会话游标与 token 台账都写这里）。
  const state = await probeDirWritable(dirname(stateFile))
  checks.push({
    id: 'state-file',
    status: state.ok ? 'ok' : 'warning',
    message: state.ok ? '状态文件目录可写' : '状态文件目录不可写，每次重启都会从头回放上下文',
    detail: stateFile,
  })

  // 3.5 豆包通道：只查 profile 目录，不启动浏览器；关闭时不产生任何检查项。
  if (config.doubao.enabled) {
    const doubaoProfileDir = config.doubao.profileDir || defaultProfileDir('doubao-profile')
    const doubaoProfile = await probeDirWritable(doubaoProfileDir)
    checks.push({
      id: 'doubao-profile',
      status: doubaoProfile.ok ? 'ok' : 'warning',
      message: doubaoProfile.ok ? '豆包 profile 目录可写' : '豆包 profile 目录不可写，登录态会存不下来',
      detail: `${doubaoProfileDir}\n${doubaoProfile.detail}`,
    })
  }

  // 4. 构建标识：确认跑的是哪一份产物，而不是靠「我重启过了」猜。
  const stamp = await readStamp()
  if (stamp === undefined) {
    checks.push({
      id: 'build',
      status: 'warning',
      message: '没有读到构建加载戳（插件可能还没在 DSH 里加载过）',
      detail: `当前代码构建标识：${BUILD}`,
    })
  } else if (stamp.build === BUILD) {
    checks.push({
      id: 'build',
      status: 'ok',
      message: '加载戳与当前构建一致',
      detail: `${stamp.build}\n${stamp.module ?? '(无路径)'}\npid ${stamp.pid ?? '?'} @ ${stamp.at ?? '?'}`,
    })
  } else {
    checks.push({
      id: 'build',
      // 源码直跑（tsx，BUILD=dev）时宿主里装着的必然是别的构建，这不是故障，只提示一下。
      status: BUILD === 'dev' ? 'warning' : 'error',
      message: BUILD === 'dev'
        ? '当前是源码直跑（build=dev），加载戳指向宿主里已装的构建——要验证线上产物请用构建产物运行'
        : '宿主加载的不是当前这份构建（插件被上游包覆盖，或还没重启）',
      detail: `加载的是 ${stamp.build ?? '(未知)'}，当前代码是 ${BUILD}`,
    })
  }

  // 5. 调用台账：把「最近到底发了多少次、最短间隔多少、失败主要是哪类」摆出来。
  //    这是回答「怎么老被限流」的唯一事实来源——没有它只能翻日志数时间戳。
  const ledgerFile = join(baseDirOf(stateFile), 'call-ledger.json')
  const ledger = new Ledger({ file: ledgerFile })
  await ledger.load()
  const summary = ledger.summary()
  const intervals = summary.intervals
  if (summary.totals.total === 0) {
    checks.push({
      id: 'ledger',
      status: 'warning',
      message: '台账里还没有记录（要么还没真正发过请求，要么刚装不久）',
      detail: `台账文件：${ledgerFile}`,
    })
  } else {
    const shortest = intervals.minMs
    // 判据不是「最短间隔小于某个值就报警」，而是把事实摆出来：
    // 竞品实测连环请求（8~12 秒间隔）是账号被判机器行为最直接的证据。
    const dense = shortest > 0 && shortest < 30_000
    checks.push({
      id: 'ledger',
      status: dense ? 'warning' : 'ok',
      message: summary.totals.total === 0
        ? '台账空闲'
        : `近 ${summary.days.length} 天 ${summary.totals.total} 次调用（对话 ${summary.totals.chat}、失败 ${summary.totals.failed}）`,
      detail: [
        intervals.count > 0
          ? `相邻对话间隔：最短 ${formatMs(intervals.minMs)}、中位 ${formatMs(intervals.medianMs)}、p90 ${formatMs(intervals.p90Ms)}`
          : '相邻对话间隔：样本不足（少于 2 次成功对话）',
        dense ? '⚠ 出现过 30 秒以内的连环请求，这正是最容易被判机器行为的形态' : '',
        Object.keys(summary.failures).length > 0
          ? `失败分布：${Object.entries(summary.failures).map(([kind, count]) => `${kind} ${count}`).join('、')}`
          : '',
        `台账文件：${ledgerFile}`,
      ].filter(Boolean).join('\n'),
    })
  }

  return checks
}

/** 状态文件所在目录（台账与它同级，用户只需记一个目录）。 */
function baseDirOf(stateFile: string): string {
  return dirname(stateFile)
}

/** 毫秒转人话（与 notify 的 formatDuration 同口径，但 doctor 不依赖提示模块）。 */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`
}
/** 在线检查需要浏览器；返回的 teardown 负责只清理自己创建的东西。 */
export interface LiveContext {
  page: Page
  /** 由本次检查自己启动的浏览器（需要关掉）；连上别人在跑的就为 undefined。 */
  ownedBrowser?: Browser
  /** 本次检查自己新开的标签页（需要关掉）。 */
  ownedPage?: Page
}

/**
 * 打开（或连上）一个可用的页面。
 *
 * 优先连已经在跑的 CDP 端口：DSH 正占用插件浏览器时，managed 模式二次启动会
 * 因为 user-data-dir 被锁而白等 60 秒。能连上就复用，连不上才自己拉。
 */
export async function openLiveContext(options: {
  config: Config
  profileDir: string
  /** 注入启动器，便于离线测试；默认用 browser-shared 的实现。 */
  launch?: typeof launchManagedBrowser
}): Promise<LiveContext> {
  const { config, profileDir } = options
  const launch = options.launch ?? launchManagedBrowser
  const endpoint = `http://127.0.0.1:${config.debugPort}`
  const origin = new URL(config.url).origin

  if (await probeCdpPort(config.debugPort)) {
    const browser = await chromium.connectOverCDP(endpoint)
    const context = browser.contexts()[0]
    if (!context) throw new Error(`CDP ${config.debugPort} 上没有可用 context`)
    const existing = context.pages().find(page => !page.isClosed() && page.url().startsWith(origin))
    if (existing !== undefined) return { page: existing }
    const page = await context.newPage()
    return { page, ownedPage: page }
  }

  if (config.browser === 'attach' && config.autoStartKeeper !== true) {
    throw new Error(
      `attach 模式下 CDP ${config.debugPort} 不可达。请先以 --remote-debugging-port=${config.debugPort} 启动浏览器。`,
    )
  }

  const connection = await launch({
    channel: config.channel,
    profileDir,
    preferredPort: config.debugPort,
    url: config.url,
    label: 'deepseek-web doctor',
  })
  const existing = connection.context.pages().find(page => !page.isClosed() && page.url().startsWith(origin))
  if (existing !== undefined) return { page: existing, ownedBrowser: connection.browser }
  const page = await connection.context.newPage()
  await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
  return { page, ownedBrowser: connection.browser, ownedPage: page }
}

/** 关闭 openLiveContext 创建的资源；复用别人的页面时什么也不做。 */
export async function closeLiveContext(live: LiveContext): Promise<void> {
  await live.ownedPage?.close().catch(() => {})
  await live.ownedBrowser?.close().catch(() => {})
}

/** 在线检查：CDP / 登录态 / 选择器命中。 */
export async function collectLiveChecks(
  live: LiveContext,
  config: Config,
): Promise<DoctorCheck[]> {
  const { page } = live
  const checks: DoctorCheck[] = []

  checks.push({
    id: 'cdp',
    status: 'ok',
    message: live.ownedBrowser === undefined ? '复用了已在运行的浏览器' : '已启动并连上浏览器',
    detail: `端口 ${config.debugPort}，页面 ${page.url()}`,
  })

  const loggedOut = await looksLoggedOut(page).catch(() => false)
  const loginWall = await looksLoginWall(page).catch(() => false)
  if (loggedOut || loginWall) {
    checks.push({
      id: 'login',
      status: 'error',
      message: '当前浏览器没有登录 chat.deepseek.com',
      detail: '在打开的窗口里登录一次即可；登录态会保存在 profile 目录',
    })
  } else {
    checks.push({
      id: 'login',
      status: 'ok',
      message: '登录态正常（能看到对话输入区）',
      detail: page.url(),
    })
  }

  const editorHits: string[] = []
  for (const candidate of EDITOR_CANDIDATES) {
    const visible = await page.locator(candidate).first().isVisible().catch(() => false)
    if (visible) editorHits.push(candidate)
  }
  const editor = summarizeCandidates(EDITOR_CANDIDATES, editorHits)
  checks.push({
    id: 'editor',
    status: editor.hit.length > 0 ? 'ok' : 'error',
    message: editor.hit.length > 0 ? '找到聊天输入框' : '没找到聊天输入框（页面可能改版或未登录）',
    detail: editor.detail,
  })

  const sendHits: string[] = []
  for (const candidate of SEND_BUTTON_CANDIDATES) {
    const count = await page.locator(candidate).count().catch(() => 0)
    if (count > 0) sendHits.push(candidate)
  }
  const send = summarizeCandidates(SEND_BUTTON_CANDIDATES, sendHits)
  checks.push({
    id: 'send-button',
    status: send.hit.length > 0 ? 'ok' : 'warning',
    message: send.hit.length > 0
      ? '找到发送按钮'
      : '没找到发送按钮（纯回车发送的站点属正常；否则说明页面改版）',
    detail: send.detail,
  })

  // 关键时序参数回显：用户报「老是频控」时，先看这几个值是不是被调成了激进档。
  checks.push({
    id: 'pacing',
    status: 'ok',
    message: '当前节流参数',
    detail: [
      `发送前随机停顿 ${config.sendPauseMinMs}~${config.sendPauseMaxMs}ms`,
      `连发 ${config.longRunAfterSends} 轮后长休 ${config.longRunPauseMinMs}~${config.longRunPauseMaxMs}ms`,
      `同账号并发上限 ${config.maxConcurrentTurns || '不限'}`,
      `并行会话页上限 ${config.maxSessionPages}`,
      `回放预算 ${config.maxReplayChars} 字`,
    ].join('\n'),
  })

  // 诚实的边界：本地无法证明「账号没有被限流」，只能靠真实发送。
  checks.push({
    id: 'account-standing',
    status: 'warning',
    message: '本地检查无法证明账号当前没有被限流或临时封禁',
    detail: '如果怀疑被限，请在网页端手动发一条：能正常回答就是没被限。',
  })

  return checks
}

/** 汇总成报告；`ok` 只看有没有 error（warning 不算失败）。 */
export function makeReport(checks: DoctorCheck[], build: string = BUILD): DoctorReport {
  return { ok: !checks.some(check => check.status === 'error'), build, checks }
}

const STATUS_ICON: Readonly<Record<CheckStatus, string>> = {
  ok: '✓',
  warning: '!',
  error: '✗',
}

/** 人读格式：每条一行，detail 缩进；末行给结论。 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`deepseek-web doctor · build ${report.build}`]
  for (const check of report.checks) {
    lines.push(`${STATUS_ICON[check.status]} ${check.id}: ${check.message}`)
    if (check.detail !== undefined && check.detail !== '') {
      for (const line of check.detail.split('\n')) lines.push(`    ${line}`)
    }
  }
  lines.push(`Doctor result: ${report.ok ? 'ready' : 'not ready'}`)
  return lines.join('\n')
}

/** 跑完整自检。`live: false` 时只跑静态检查（CI / 离线回归用）。 */
export async function runDoctor(options: {
  config: Config
  profileDir: string
  stateFile: string
  live?: boolean
  resolveBrowser?: (channel: 'msedge' | 'chrome') => string | undefined
  launch?: typeof launchManagedBrowser
}): Promise<DoctorReport> {
  const checks = await collectStaticChecks({
    config: options.config,
    profileDir: options.profileDir,
    stateFile: options.stateFile,
    ...options.resolveBrowser === undefined ? {} : { resolveBrowser: options.resolveBrowser },
  })
  if (options.live === false) return makeReport(checks)
  let live: LiveContext | undefined
  try {
    live = await openLiveContext({
      config: options.config,
      profileDir: options.profileDir,
      ...options.launch === undefined ? {} : { launch: options.launch },
    })
    checks.push(...await collectLiveChecks(live, options.config))
  } catch (error) {
    checks.push({
      id: 'live',
      status: 'error',
      message: '在线检查失败：浏览器没连上',
      detail: error instanceof Error ? error.message : String(error),
    })
  } finally {
    if (live !== undefined) await closeLiveContext(live)
  }
  return makeReport(checks)
}
