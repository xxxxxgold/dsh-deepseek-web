/**
 * 离线回归：网页模型的「审核关 / 跟随设置 / 审核开」三档是否真的映射到审核门禁。
 *
 * 这一条防止两种退化：
 * 1. 档位只画在菜单里、适配器仍只看全局 `review.enabled`；
 * 2. 「跟随设置」被误实现成第三级强度，或者被固定进会话后不再跟随全局。
 *
 * 用法：tsx tools/review-switch-check.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { DeepSeekWebAdapter, reviewEnabledByEffort } from '../src/adapter.ts'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from '../src/browser-channel.ts'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import {
  WEB_MODEL_DEFAULT_REASONING_EFFORT,
  WEB_MODEL_IDS,
  WEB_MODEL_REASONING_EFFORTS,
} from '../src/web-models.ts'

const cases: ReadonlyArray<readonly [string, string | undefined, boolean, boolean]> = [
  ['未选择 + 全局关', undefined, false, false],
  ['未选择 + 全局开', undefined, true, true],
  ['review-off + 全局开', 'review-off', true, false],
  ['review-on + 全局关', 'review-on', false, true],
  ['review-off + 全局关', 'review-off', false, false],
  ['review-on + 全局开', 'review-on', true, true],
  ['review-default + 全局开', 'review-default', true, true],
  ['review-default + 全局关', 'review-default', false, false],
]

for (const [label, effort, fallback, expected] of cases) {
  const actual = reviewEnabledByEffort(effort, fallback)
  assert.equal(actual, expected, `${label}: effort=${String(effort)} fallback=${fallback}`)
  console.log(`PASS  ${label}`)
}

const ids = WEB_MODEL_REASONING_EFFORTS.map(effort => effort.id)
assert.deepEqual(ids, ['review-off', 'review-default', 'review-on'], '三档 id 顺序固定')
assert.equal(WEB_MODEL_DEFAULT_REASONING_EFFORT, 'review-default', '默认档必须是跟随设置')
assert.ok(
  WEB_MODEL_REASONING_EFFORTS.every(effort => effort.name.trim().length > 0),
  '每个档位必须有展示名',
)
console.log('PASS  三档常量与默认档位')

class EchoChannel implements BrowserChannel {
  async ensureReady(): Promise<void> {}
  resetConversationGate(): void {}
  async status(): Promise<{ ready: boolean }> { return { ready: true } }
  async focusBrowser(): Promise<void> {}
  async focusHarness(): Promise<void> {}
  async dispose(): Promise<void> {}
  async turn(_request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    return { text: '最终回答' }
  }
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-review-switch-'))
try {
  const config = liveConfig(Config({
    stateFile: path.join(tempDir, 'state.json'),
    focus: { enabled: false },
    autoCorrectMalformed: false,
  }))
  const adapter = new DeepSeekWebAdapter(config, {} as unknown as BrowserChannel)
  for (const model of WEB_MODEL_IDS) {
    const info = await adapter.resolveModel('deepseek-web', model)
    assert.deepEqual(
      info.reasoning?.efforts.map(effort => [effort.id, effort.name]),
      [
        ['review-off', '审核关'],
        ['review-default', '跟随设置'],
        ['review-on', '审核开'],
      ],
      `${model} 的三档档位`,
    )
    assert.equal(info.reasoning?.defaultEffort, 'review-default', `${model} 的默认档位`)
    console.log(`PASS  ${model} resolveModel 公布三档审核档位`)
  }

  // 真实适配器 + 假审核器：确认 streamTask 真的按 options.reasoningEffort 调用审核，
  // 而不只是常量表或纯函数对。
  const streamCases: ReadonlyArray<readonly [string, boolean, string | undefined, number, number]> = [
    ['全局开 + review-off', true, 'review-off', 1, 0],
    ['全局开 + review-on', true, 'review-on', 1, 1],
    ['全局关 + review-on', false, 'review-on', 1, 1],
    ['全局开 + review-default', true, 'review-default', 1, 1],
    ['全局关 + review-default', false, 'review-default', 1, 0],
    ['全局开 + 未提供', true, undefined, 1, 1],
    ['全局关 + 未提供', false, undefined, 1, 0],
    ['全局关 + review-off', false, 'review-off', 1, 0],
    ['全局开 + review-on + maxRounds=0', true, 'review-on', 0, 0],
  ]
  for (const [label, globalOn, effort, maxRounds, expected] of streamCases) {
    const caseConfig = liveConfig(Config({
      stateFile: path.join(tempDir, `stream-${label.replaceAll(/[^\w]+/gu, '-')}.json`),
      review: { enabled: globalOn, maxRounds },
      focus: { enabled: false },
      autoCorrectMalformed: false,
    }))
    let reviews = 0
    const reviewer = {
      needsEvidence: false,
      review: async () => {
        reviews += 1
        return { ok: true, issues: [], suggestions: [], raw: '{}' }
      },
    }
    const adapter = new DeepSeekWebAdapter(caseConfig, new EchoChannel(), reviewer)
    const options = {
      sessionId: `stream-${label}`,
      provider: 'deepseek-web',
      model: 'deepseek-web-auto',
      messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '请给出结果' }] }],
      reasoningEffort: effort,
    } as unknown as GenerateOptions
    for await (const _chunk of adapter.stream(options)) { /* drain */ }
    assert.equal(reviews, expected, `${label}: reviewer 调用次数`)
    console.log(`PASS  ${label} -> reviewer ${reviews} 次`)
  }
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

console.log('OK（审核开关：8 种组合 + 三档常量 + 两个模型的 resolveModel + 真实 streamTask 门禁）')
