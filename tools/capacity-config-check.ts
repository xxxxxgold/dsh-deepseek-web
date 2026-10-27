/**
 * 离线契约：容量配置（contextWindow / maxTokens）的默认值、自定义值、越界拒绝与压缩阈值算式。
 *
 * 为什么必须有这条：这两个值直接决定宿主的压缩阈值，配错（maxTokens + 65536 ≥ contextWindow）
 * 会让宿主拒绝自动压缩且只告警一次，长会话静默膨胀。默认值来自附件通道实测，改动须同步本用例。
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { DeepSeekWebAdapter } from '../src/adapter.ts'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'

const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-caps-'))
const stubChannel = {
  ensureReady: async () => {},
  resetConversationGate: () => {},
  status: async () => ({ ready: true }),
  focusBrowser: async () => {},
  focusHarness: async () => {},
  dispose: async () => {},
  turn: async () => { throw new Error('not used') },
} as never

try {
  const make = (overrides: Record<string, unknown> = {}) => new DeepSeekWebAdapter(
    liveConfig(Config({ stateFile: path.join(dir, 'state.json'), ...overrides })),
    stubChannel,
  )

  const defaults = await make().resolveModel('deepseek-web', 'deepseek-web-auto')
  console.log('默认:', JSON.stringify({ contextWindow: defaults.context.contextWindow, defaultMaxTokens: defaults.defaultMaxTokens }))
  assert.equal(defaults.context.contextWindow, 1_000_000, '默认上下文窗口应为 1000000')
  assert.equal(defaults.defaultMaxTokens, 300_000, '默认输出上限应为 300000')

  const custom = await make({ contextWindow: 500_000, maxTokens: 64_000 }).resolveModel('deepseek-web', 'deepseek-web-auto')
  console.log('自定义:', JSON.stringify({ contextWindow: custom.context.contextWindow, defaultMaxTokens: custom.defaultMaxTokens }))
  assert.equal(custom.context.contextWindow, 500_000, '自定义上下文窗口应生效')
  assert.equal(custom.defaultMaxTokens, 64_000, '自定义输出上限应生效')

  // 越界取值由 schema 直接拒绝（不是静默夹取），保证设置页写入非法值时会报错。
  assert.throws(() => Config({ stateFile: path.join(dir, 'state.json'), contextWindow: 1000 }), /contextWindow/, '低于下限应报校验错误')
  assert.throws(() => Config({ stateFile: path.join(dir, 'state.json'), maxTokens: 5_000_000 }), /maxTokens/, '高于上限应报校验错误')
  console.log('边界校验: 越界值被 schema 拒绝（含字段名）')

  // 配反组合必须触发启动告警：宿主 resolveCompactSpec() 会抛 TargetPressureConfigError，
  // step 压缩只 warn 一次后跳过；没有这条提示，用户发现不了自动压缩已经停摆。
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    make({ contextWindow: 8_000, maxTokens: 300_000 })
  } finally {
    console.warn = originalWarn
  }
  const capacityWarning = warnings.find(line => line.includes('[deepseek-web]') && line.includes('contextWindow'))
  assert.ok(capacityWarning, '配反组合必须打印容量告警')
  console.log('告警命中:', capacityWarning!.slice(0, 56), '…')

  // 默认值不应触发告警
  const cleanWarnings: string[] = []
  console.warn = (...args: unknown[]) => { cleanWarnings.push(args.map(String).join(' ')) }
  try {
    make()
  } finally {
    console.warn = originalWarn
  }
  assert.ok(
    !cleanWarnings.some(line => line.includes('contextWindow')),
    '默认 1M/300k 不应触发容量告警',
  )
  console.log('默认值: 无容量告警')

  // 压缩阈值口径（headroomTokens 取 dsh 默认 65536）
  const threshold = (ctx: number, out: number, headroom = 65_536) => Math.min(ctx * 0.8, ctx - out - headroom)
  console.log('默认压缩阈值:', threshold(1_000_000, 300_000))
  assert.equal(threshold(1_000_000, 300_000), 634_464)

  console.log('OK: 容量配置默认值、自定义值、越界拒绝、配反告警与阈值算式均符合预期')
} finally {
  await rm(dir, { recursive: true, force: true })
}
