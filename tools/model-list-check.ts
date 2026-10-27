/**
 * 模型清单一致性检查。
 *
 * `src/web-models.ts` 是 Host 与 Client 半侧共享的最小事实表（浏览器产物不能
 * 引入 schemastery，所以模型 id 单独放一份）。三处必须一致，否则用户在配置页
 * 选到的 id 到通道侧认不出来：
 *   1. `WEB_MODEL_IDS`          —— 共享事实表
 *   2. `WEB_MODEL_CAPABILITIES` —— 展示用能力表
 *   3. `Config.model` 的枚举     —— 配置 schema（用户实际能选的值）
 *
 * 用法：tsx tools/model-list-check.ts
 */
import { Config } from '../src/config.ts'
import {
  WEB_MODEL_CAPABILITIES,
  WEB_MODEL_DEFAULT_REASONING_EFFORT,
  WEB_MODEL_IDS,
  WEB_MODEL_REASONING_EFFORTS,
} from '../src/web-models.ts'

/** schemastery 的枚举节点是 const 对象数组，取其 value。 */
function enumValuesOf(schema: unknown): string[] {
  const list = (schema as { list?: Array<{ value?: unknown }> } | undefined)?.list
  if (!Array.isArray(list)) return []
  return list.map(item => (typeof item === 'string' ? item : String(item?.value ?? ''))).filter(Boolean)
}

const fromConfig = enumValuesOf((Config as unknown as { dict?: { model?: unknown } }).dict?.model)
const fromIds = [...WEB_MODEL_IDS] as string[]
const fromCaps = Object.keys(WEB_MODEL_CAPABILITIES)

let failed = 0
function check(ok: boolean, label: string, detail: string): void {
  if (ok) {
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}：${detail}`)
  }
}

check(fromConfig.length > 0, 'Config.model 能取到枚举值', `取到 ${fromConfig.length} 个`)
check(
  fromIds.length === fromConfig.length && fromIds.every(id => fromConfig.includes(id)),
  'WEB_MODEL_IDS 与 Config.model 枚举一致',
  `ids=${JSON.stringify(fromIds)} config=${JSON.stringify(fromConfig)}`,
)
check(
  fromCaps.length === fromIds.length && fromIds.every(id => fromCaps.includes(id)),
  'WEB_MODEL_CAPABILITIES 覆盖每个模型 id',
  `caps=${JSON.stringify(fromCaps)} ids=${JSON.stringify(fromIds)}`,
)
check(fromIds.length >= 1, '至少有一个模型 id', `当前 ${fromIds.length} 个`)

const effortIds = WEB_MODEL_REASONING_EFFORTS.map(effort => effort.id)
check(
  effortIds.length === 3 && new Set(effortIds).size === 3,
  '审核档位恰好三档且 id 不重复',
  `ids=${JSON.stringify(effortIds)}`,
)
check(
  effortIds[0] === 'review-off' && effortIds[1] === 'review-default' && effortIds[2] === 'review-on',
  '审核档位顺序固定为 review-off / review-default / review-on',
  `ids=${JSON.stringify(effortIds)}`,
)
check(
  WEB_MODEL_REASONING_EFFORTS.every(effort => effort.name.trim().length > 0),
  '每个审核档位都有展示名',
  `efforts=${JSON.stringify(WEB_MODEL_REASONING_EFFORTS)}`,
)
check(
  effortIds.includes(WEB_MODEL_DEFAULT_REASONING_EFFORT),
  '默认审核档位在档位表内',
  `default=${WEB_MODEL_DEFAULT_REASONING_EFFORT} ids=${JSON.stringify(effortIds)}`,
)

if (failed === 0) console.log('OK（模型清单：事实表 / 能力表 / 配置枚举 / 审核档位一致）')
process.exit(failed === 0 ? 0 : 1)
