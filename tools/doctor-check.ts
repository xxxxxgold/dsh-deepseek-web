/**
 * 离线回归：doctor 的纯函数与静态检查。
 *
 * 这一条要防的失败是「自检自己会崩」——用户装完跑 `npm run doctor`，
 * 结果插件先抛异常，比不查还糟。所以断言四件事：
 * 1. 选择器汇总能区分「全没命中」与「部分命中」，并把未命中的候选列出来；
 * 2. 目录可写性探测返回真实结论（存在可写目录 true、不可能存在的目录 false）；
 * 3. 静态检查在「没有浏览器 / 配置的 channel 没装」时报 error 而不是静默通过；
 * 4. 报告汇总只看 error：warning 不影响 ready，最后一行文案固定。
 *
 * 全程不启动浏览器。
 *
 * 为什么必须注入 readStamp：构建戳默认读的是**用户真实目录**下 loaded-build.json，
 * 开发机上只要插件被宿主加载过，这里就会读到与 dev 不同的构建标识，
 * 让「两个浏览器都在」的用例无端变红。回归测试不允许依赖本机状态。
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { Config } from '../src/config.ts'
import { BUILD } from '../src/build-info.ts'
import { liveConfig } from '../src/live-config.ts'
import {
  collectStaticChecks,
  formatDoctorReport,
  makeReport,
  probeDirWritable,
  summarizeCandidates,
} from '../src/doctor.ts'

// ---- 1. 选择器汇总 ----
{
  const all = summarizeCandidates(['a', 'b', 'c'], [])
  assert.equal(all.hit.length, 0)
  assert.deepEqual(all.miss, ['a', 'b', 'c'])
  assert.match(all.detail, /0\/3 命中/u)
  assert.match(all.detail, /a \| b \| c/u)

  const some = summarizeCandidates(['a', 'b', 'c'], ['b'])
  assert.deepEqual(some.hit, ['b'])
  assert.deepEqual(some.miss, ['a', 'c'])
  assert.match(some.detail, /1\/3 命中/u)
  assert.match(some.detail, /未命中：a \| c/u)

  // 顺序要跟候选表一致，不能跟传入的命中顺序跑
  const ordered = summarizeCandidates(['a', 'b', 'c'], ['c', 'a'])
  assert.deepEqual(ordered.hit, ['a', 'c'])
}

// ---- 2. 目录可写探测 ----
{
  const good = await probeDirWritable(path.join(os.tmpdir(), `dsh-doctor-ok-${process.pid}`))
  assert.equal(good.ok, true, `临时目录应可写：${good.detail}`)

  // Windows 上「Z:\」这种不存在的盘符一定建不出来；Unix 用 /proc 下的只读路径
  const badPath = process.platform === 'win32'
    ? 'Z:\\dsh-doctor-should-not-exist'
    : '/proc/dsh-doctor-should-not-exist'
  const bad = await probeDirWritable(badPath)
  assert.equal(bad.ok, false, `不可写目录应判 false：${bad.detail}`)
}

// ---- 3. 静态检查的判定 ----
const base = liveConfig(Config({
  focus: { enabled: false },
  review: { enabled: false },
}))
const profileDir = path.join(os.tmpdir(), `dsh-doctor-profile-${process.pid}`)
const stateFile = path.join(os.tmpdir(), `dsh-doctor-state-${process.pid}`, 'session-state.json')

{
  // 3a. 两种浏览器都找不到 → error
  const checks = await collectStaticChecks({
    config: base,
    profileDir,
    stateFile,
    readStamp: async () => undefined,
    resolveBrowser: () => undefined,
  })
  const browser = checks.find(check => check.id === 'browser-executable')
  assert.ok(browser, '应有一条 browser-executable')
  assert.equal(browser!.status, 'error')
  assert.equal(checks.some(check => check.status === 'error'), true)
}

{
  // 3b. 配置 msedge 但本机只有 chrome → 额外一条 browser-channel-missing
  const checks = await collectStaticChecks({
    config: { ...base, channel: 'msedge' as const },
    profileDir,
    stateFile,
    readStamp: async () => undefined,
    resolveBrowser: channel => channel === 'chrome' ? 'C:\\chrome.exe' : undefined,
  })
  const missing = checks.find(check => check.id === 'browser-channel-missing')
  assert.ok(missing, '应有一条 browser-channel-missing')
  assert.equal(missing!.status, 'error')
  assert.match(missing!.detail ?? '', /chrome/u)
}

{
  // 3c. 两个都在、配置命中 → 没有 error，且 profile / state-file 都是 ok
  const checks = await collectStaticChecks({
    config: base,
    profileDir,
    stateFile,
    readStamp: async () => undefined,
    resolveBrowser: channel => channel === 'msedge' ? 'C:\\msedge.exe' : 'C:\\chrome.exe',
  })
  assert.equal(checks.some(check => check.status === 'error'), false)
  assert.equal(checks.find(check => check.id === 'profile')?.status, 'ok')
  assert.equal(checks.find(check => check.id === 'state-file')?.status, 'ok')
}

{
  // 3d. attach 模式不检查插件自己的 profile 目录（它复用外部浏览器）
  const checks = await collectStaticChecks({
    config: { ...base, browser: 'attach' as const },
    profileDir,
    stateFile,
    readStamp: async () => undefined,
    resolveBrowser: () => 'C:\\msedge.exe',
  })
  const profile = checks.find(check => check.id === 'profile')
  assert.equal(profile?.status, 'ok')
  assert.match(profile?.message ?? '', /attach/u)
}

// ---- 3e. 构建加载戳的三种判定（纯注入，不读本机） ----
{
  const common = {
    config: base,
    profileDir,
    stateFile,
    resolveBrowser: () => 'C:\\msedge.exe',
  }

  // 没读到戳 → warning，不阻断 ready
  const none = await collectStaticChecks({ ...common, readStamp: async () => undefined })
  const noneCheck = none.find(check => check.id === 'build')
  assert.equal(noneCheck?.status, 'warning')
  assert.match(noneCheck?.message ?? '', /没有读到构建加载戳/u)

  // 戳与当前构建一致 → ok
  const same = await collectStaticChecks({
    ...common,
    readStamp: async () => ({ build: BUILD, module: 'C:\\lib\\index.js', pid: 42, at: '2026-01-01T00:00:00.000Z' }),
  })
  const sameCheck = same.find(check => check.id === 'build')
  assert.equal(sameCheck?.status, 'ok')
  assert.match(sameCheck?.detail ?? '', /pid 42/u)

  // 戳指向别的构建 → 只有构建产物里才是 error；源码直跑（dev）只提示
  const other = await collectStaticChecks({
    ...common,
    readStamp: async () => ({ build: 'stale-build-xyz' }),
  })
  const otherCheck = other.find(check => check.id === 'build')
  assert.equal(otherCheck?.status, BUILD === 'dev' ? 'warning' : 'error')
  assert.match(otherCheck?.detail ?? '', /stale-build-xyz/u)
}

// ---- 4. 报告汇总与文案 ----
{
  const warningOnly = makeReport([{ id: 'x', status: 'warning', message: 'warn' }], 'test-build')
  assert.equal(warningOnly.ok, true, 'warning 不应让报告变成 not ready')
  const text = formatDoctorReport(warningOnly)
  assert.match(text, /deepseek-web doctor · build test-build/u)
  assert.match(text, /^! x: warn$/mu)
  assert.match(text, /Doctor result: ready$/u)

  const withError = makeReport([
    { id: 'a', status: 'ok', message: 'fine', detail: 'line1\nline2' },
    { id: 'b', status: 'error', message: 'broken' },
  ])
  assert.equal(withError.ok, false)
  const errorText = formatDoctorReport(withError)
  assert.match(errorText, /✓ a: fine/u)
  assert.match(errorText, /    line1/u)
  assert.match(errorText, /    line2/u)
  assert.match(errorText, /✗ b: broken/u)
  assert.match(errorText, /Doctor result: not ready$/u)
}

console.info('OK（doctor 选择器汇总 + 目录探测 + 静态检查 + 构建戳判定 + 报告文案）')
