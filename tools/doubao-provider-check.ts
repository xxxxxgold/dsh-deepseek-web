/** 豆包 provider 注册回归：模型清单、provider 身份、与 DeepSeek 并存。 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { DeepSeekWebAdapter, defaultDeepSeekProfile } from '../src/adapter.ts'
import { createDoubaoWebProfile } from '../src/doubao-provider.ts'
import { collectStaticChecks } from '../src/doctor.ts'
import type { BrowserChannel } from '../src/browser-channel.ts'

const stub: BrowserChannel = {
  ensureReady: async () => {},
  resetConversationGate: () => {},
  turn: async () => { throw new Error('stub') },
  status: async () => ({ ready: false }),
  focusBrowser: async () => {},
  focusHarness: async () => {},
  dispose: async () => {},
}

const config = liveConfig(Config({ doubao: { enabled: true } }))

const doubao = new DeepSeekWebAdapter(config, stub, undefined, undefined, undefined, createDoubaoWebProfile({ stateFile: 'doubao-session-state.json' }))
assert.equal(doubao.providerInfo('doubao-web').name, '豆包网页版')
const doubaoModels = await doubao.listModels('doubao-web')
assert.deepEqual(doubaoModels.map(model => model.id), ['doubao-web', 'doubao-web-auto'])
assert.ok(doubaoModels.every(model => model.provider === 'doubao-web'))
assert.ok(doubaoModels.every(model => model.inputModalities?.join(',') === 'text'), '豆包一期不应声明图片能力')
const resolved = await doubao.resolveModel('doubao-web', 'doubao-web-auto')
assert.equal(resolved.id, 'doubao-web-auto')
assert.equal(resolved.reasoning, undefined, '豆包一期不应公布审核三档')

const deepseek = new DeepSeekWebAdapter(config, stub, undefined, undefined, undefined, defaultDeepSeekProfile())
assert.equal(deepseek.providerInfo('deepseek-web').name, 'DeepSeek Web（免费网页版）')
const deepseekModels = await deepseek.listModels('deepseek-web')
assert.deepEqual(deepseekModels.map(model => model.id), ['deepseek-web', 'deepseek-web-auto'])
assert.ok(deepseekModels.every(model => model.provider === 'deepseek-web'))

// doctor：启用豆包时出现 profile 检查；关闭时不出现。
const doctorBase = {
  config,
  profileDir: path.join(os.tmpdir(), 'dsh-doubao-doctor-profile'),
  stateFile: path.join(os.tmpdir(), 'dsh-doubao-doctor-state.json'),
  resolveBrowser: () => 'C:\\fake\\msedge.exe',
  readStamp: async () => undefined,
}
const enabledChecks = await collectStaticChecks(doctorBase)
assert.ok(enabledChecks.some(check => check.id === 'doubao-profile'), '启用豆包时应出现 doubao-profile 检查')
const disabledChecks = await collectStaticChecks({
  ...doctorBase,
  config: liveConfig(Config({ doubao: { enabled: false } })),
})
assert.ok(!disabledChecks.some(check => check.id === 'doubao-profile'), '关闭豆包时不应出现 doubao-profile 检查')

console.log('doubao-provider-check: OK')
console.log(JSON.stringify({
  doubao: doubaoModels.map(model => ({ id: model.id, name: model.name, modalities: model.inputModalities })),
  deepseek: deepseekModels.map(model => ({ id: model.id, name: model.name })),
}, null, 2))
