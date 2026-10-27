/**
 * 插件入口注册检查：真调 `apply()`，确认 `glm-web` provider 被注册。
 *
 * 不启动浏览器：`apply()` 只构造通道对象，真正连接发生在第一次发送时。
 * 用法：tsx tools/glm-register-check.ts
 */
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

const ctx = new Context()
ctx.plugin(FakeLlm)
await new Promise(resolve => setTimeout(resolve, 20))
const llm = ctx.get('llm') as FakeLlm

apply(ctx, Config({
  stateFile: path.join(tmpdir(), 'dsh-glm-register-check', 'session-state.json'),
  focus: { enabled: false },
  loginProbe: { enabled: false },
}) as never)
await new Promise(resolve => setTimeout(resolve, 50))

let failed = 0
function check(ok: boolean, label: string, detail: string): void {
  if (ok) {
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}：${detail}`)
  }
}

const glm = llm.adapters.get('glm-web')
check(glm !== undefined, 'apply() 注册 glm-web provider', [...llm.adapters.keys()].join(','))
if (glm) {
  const models = await glm.listModels('glm-web')
  check(
    models.map(item => item.id).join(',') === 'glm-5.3,glm-5.3-flash',
    'glm-web 暴露两个模型',
    models.map(item => item.id).join(','),
  )
  const resolved = await glm.resolveModel('glm-web', 'glm-5.3')
  check(
    resolved.reasoning?.efforts.map(item => item.name).join('/') === '快速/深度/极致',
    'glm-web 暴露三档思考强度',
    JSON.stringify(resolved.reasoning),
  )
}
check(llm.adapters.has('deepseek-web'), 'DeepSeek provider 仍在', [...llm.adapters.keys()].join(','))
const deepseek = llm.adapters.get('deepseek-web')
if (deepseek) {
  const models = await deepseek.listModels('deepseek-web')
  check(
    models.map(item => item.id).join(',') === 'deepseek-web,deepseek-web-auto',
    'DeepSeek 两个模型未被 GLM 替换',
    models.map(item => item.id).join(','),
  )
}

if (failed === 0) console.log('OK（插件入口：glm-web 已注册且元数据正确）')
process.exit(failed === 0 ? 0 : 1)
