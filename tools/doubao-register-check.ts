/** 插件入口注册检查：真调 `apply()`，确认 doubao-web 与 deepseek-web 并存；不启动浏览器。 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.ts'

class FakeLlm extends Service {
  readonly adapters = new Map<string, LlmAdapter>()
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  registerAdapter(providers: readonly string[], adapter: LlmAdapter): () => void {
    for (const provider of providers) this.adapters.set(provider, adapter)
    return () => {
      for (const provider of providers) this.adapters.delete(provider)
    }
  }
}

const base = {
  stateFile: path.join(tmpdir(), 'dsh-doubao-register-check', 'session-state.json'),
  focus: { enabled: false },
  loginProbe: { enabled: false },
}

const enabledCtx = new Context()
enabledCtx.plugin(FakeLlm)
await new Promise(resolve => setTimeout(resolve, 20))
apply(enabledCtx, Config({
  ...base,
  doubao: { enabled: true, profileDir: path.join(tmpdir(), 'dsh-doubao-register-check', 'profile') },
}) as never)
await new Promise(resolve => setTimeout(resolve, 50))
const enabled = enabledCtx.get('llm') as FakeLlm

let failed = 0
function check(ok: boolean, label: string, detail: string): void {
  if (ok) console.log(`PASS  ${label}`)
  else { failed += 1; console.log(`FAIL  ${label}：${detail}`) }
}

const doubao = enabled.adapters.get('doubao-web')
check(doubao !== undefined, 'apply() 注册 doubao-web provider', [...enabled.adapters.keys()].join(','))
if (doubao) {
  const models = await doubao.listModels('doubao-web')
  check(
    models.map(item => item.id).join(',') === 'doubao-web,doubao-web-auto',
    'doubao-web 暴露半自动/全自动两个入口',
    models.map(item => item.id).join(','),
  )
}
const deepseek = enabled.adapters.get('deepseek-web')
check(deepseek !== undefined, 'DeepSeek provider 仍在（并存，不被替换）', [...enabled.adapters.keys()].join(','))
if (deepseek) {
  const models = await deepseek.listModels('deepseek-web')
  check(
    models.map(item => item.id).join(',') === 'deepseek-web,deepseek-web-auto',
    'DeepSeek 两个模型未被豆包替换',
    models.map(item => item.id).join(','),
  )
}

const disabledCtx = new Context()
disabledCtx.plugin(FakeLlm)
await new Promise(resolve => setTimeout(resolve, 20))
apply(disabledCtx, Config({ ...base, doubao: { enabled: false } }) as never)
await new Promise(resolve => setTimeout(resolve, 50))
const disabled = disabledCtx.get('llm') as FakeLlm
check(!disabled.adapters.has('doubao-web'), 'doubao.enabled=false 时不注册 provider', [...disabled.adapters.keys()].join(','))

assert.ok(failed >= 0)
if (failed === 0) console.log('OK（插件入口：doubao-web 与 deepseek-web 并存，关闭时不注册）')
process.exit(failed === 0 ? 0 : 1)
