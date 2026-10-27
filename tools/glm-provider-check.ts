/**
 * GLM provider 适配器契约检查。
 *
 * 不启动浏览器：用真实 `DeepSeekWebAdapter` + `createGlmWebProfile()` 验证：
 *   - 模型清单只有 GLM-5.3 / GLM-5.3-Flash；
 *   - resolveModel 公布三档思考强度（快速/深度/极致，默认深度）；
 *   - 默认 DeepSeek profile 仍是两个模型 + 审核三档（回归）。
 *
 * 用法：tsx tools/glm-provider-check.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { DeepSeekWebAdapter, defaultDeepSeekProfile } from '../src/adapter.ts'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from '../src/browser-channel.ts'
import { Config } from '../src/config.ts'
import { FIELDS, GROUPS } from '../src/client/config-fields.ts'
import { createGlmWebProfile } from '../src/glm-provider.ts'
import { liveConfig } from '../src/live-config.ts'

let failed = 0
function check(ok: boolean, label: string, detail: string): void {
  if (ok) {
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}：${detail}`)
  }
}

class NoopChannel implements BrowserChannel {
  async ensureReady(): Promise<void> {}
  resetConversationGate(): void {}
  async status(): Promise<{ ready: boolean }> { return { ready: true } }
  async focusBrowser(): Promise<void> {}
  async focusHarness(): Promise<void> {}
  async dispose(): Promise<void> {}
  async turn(_request: BrowserTurnRequest): Promise<BrowserTurnResult> { return { text: 'ok' } }
}

class RecordingChannel extends NoopChannel {
  readonly requests: BrowserTurnRequest[] = []
  override async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    this.requests.push(request)
    return { text: '最终回答' }
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'glm-provider-check-'))
try {
  const config = liveConfig(Config({
    stateFile: path.join(dir, 'session-state.json'),
    focus: { enabled: false },
    glmWeb: { autoSend: true },
  }))
  check(config.glmWeb.url === 'https://chatglm.cn/', 'GLM 主通道默认地址 chatglm.cn', config.glmWeb.url)
  check(config.glmWeb.autoSend === true, 'GLM 主通道默认自动发送', String(config.glmWeb.autoSend))
  check(config.review.glmModel === 'glm-5.3', 'GLM 审核默认模型 GLM-5.3', config.review.glmModel)
  check(config.review.glmEffort === 'high', 'GLM 审核默认强度深度', config.review.glmEffort)

  const glmGroup = GROUPS.find(group => group.id === 'glmweb')
  check(glmGroup !== undefined, '设置页存在 GLM 网页分组', String(glmGroup?.id))
  const glmPaths = FIELDS.filter(field => field.path[0] === 'glmWeb').map(field => field.path.join('.'))
  check(
    ['glmWeb.url', 'glmWeb.debugPort', 'glmWeb.profileDir', 'glmWeb.autoSend'].every(item => glmPaths.includes(item)),
    '设置页包含 GLM 四个字段',
    JSON.stringify(glmPaths),
  )
  const reviewGlmPaths = FIELDS.filter(field => field.path[0] === 'review' && String(field.path[1]).startsWith('glm'))
    .map(field => field.path.join('.'))
  check(
    ['review.glmUrl', 'review.glmModel', 'review.glmEffort'].every(item => reviewGlmPaths.includes(item)),
    '设置页包含 GLM 审核模型与强度',
    JSON.stringify(reviewGlmPaths),
  )
  const glmAdapter = new DeepSeekWebAdapter(
    config,
    new NoopChannel(),
    undefined,
    undefined,
    undefined,
    createGlmWebProfile({ autoSend: true, stateFile: path.join(dir, 'glm-session-state.json') }),
  )
  const glmModels = await glmAdapter.listModels('glm-web')
  check(
    glmModels.length === 2 && glmModels.map(item => item.id).join(',') === 'glm-5.3,glm-5.3-flash',
    'GLM 模型清单为两个模型',
    JSON.stringify(glmModels.map(item => item.id)),
  )
  check(glmAdapter.providerInfo('glm-web').name === 'GLM 网页版', 'GLM provider 展示名', glmAdapter.providerInfo('glm-web').name)
  const resolved = await glmAdapter.resolveModel('glm-web', 'glm-5.3')
  check(
    resolved.reasoning?.efforts.map(item => item.name).join('/') === '快速/深度/极致',
    'GLM 公布三档思考强度',
    JSON.stringify(resolved.reasoning),
  )
  check(resolved.reasoning?.defaultEffort === 'high', 'GLM 默认档位深度', String(resolved.reasoning?.defaultEffort))

  const recording = new RecordingChannel()
  const streamAdapter = new DeepSeekWebAdapter(
    config,
    recording,
    undefined,
    undefined,
    undefined,
    createGlmWebProfile({ autoSend: true, stateFile: path.join(dir, 'glm-stream-state.json') }),
  )
  const streamOptions = {
    sessionId: 'glm-check',
    provider: 'glm-web',
    model: 'glm-5.3',
    reasoningEffort: 'max',
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '请给出结果' }] }],
  } as unknown as GenerateOptions
  for await (const _chunk of streamAdapter.stream(streamOptions)) {
    // 只为驱动一轮，不消费内容
  }
  const request = recording.requests[0]
  check(request?.model === 'glm-5.3', 'GLM 通道收到模型 id', String(request?.model))
  check(request?.reasoningEffort === 'max', 'GLM 通道收到思考强度 max', String(request?.reasoningEffort))
  check(request?.autoSend === true, 'GLM 主通道按配置自动发送', String(request?.autoSend))

  const deepseekAdapter = new DeepSeekWebAdapter(config, new NoopChannel(), undefined, undefined, undefined, defaultDeepSeekProfile())
  const deepseekModels = await deepseekAdapter.listModels('deepseek-web')
  check(
    deepseekModels.map(item => item.id).join(',') === 'deepseek-web,deepseek-web-auto',
    'DeepSeek 模型清单回归',
    deepseekModels.map(item => item.id).join(','),
  )
  const deepseekResolved = await deepseekAdapter.resolveModel('deepseek-web', 'deepseek-web-auto')
  check(
    deepseekResolved.reasoning?.efforts.map(item => item.id).join(',') === 'review-off,review-default,review-on',
    'DeepSeek 审核三档回归',
    JSON.stringify(deepseekResolved.reasoning),
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failed === 0) console.log('OK（GLM provider 契约 + DeepSeek 回归）')
process.exit(failed === 0 ? 0 : 1)
