/**
 * GLM 网页模型清单一致性检查。
 *
 * 校验：
 *   1. GLM provider / 模型 id / 展示名 / 三档强度 / 默认档位；
 *   2. GLM 模型 id 不与 DeepSeek 的 WEB_MODEL_IDS 冲突；
 *   3. normalizeGlmEffort 的收敛行为。
 *
 * 用法：tsx tools/glm-model-check.ts
 */
import {
  GLM_WEB_DEFAULT_REASONING_EFFORT,
  GLM_WEB_MODEL_IDS,
  GLM_WEB_MODEL_NAMES,
  GLM_WEB_PROVIDER,
  GLM_WEB_REASONING_EFFORTS,
  WEB_MODEL_IDS,
  normalizeGlmEffort,
} from '../src/web-models.ts'

let failed = 0
function check(ok: boolean, label: string, detail: string): void {
  if (ok) {
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}：${detail}`)
  }
}

check(GLM_WEB_PROVIDER === 'glm-web', 'provider id 固定为 glm-web', GLM_WEB_PROVIDER)
check(
  GLM_WEB_MODEL_IDS.length === 2 && GLM_WEB_MODEL_IDS[0] === 'glm-5.3' && GLM_WEB_MODEL_IDS[1] === 'glm-5.3-flash',
  '模型清单为 glm-5.3 / glm-5.3-flash',
  JSON.stringify(GLM_WEB_MODEL_IDS),
)
check(
  Object.keys(GLM_WEB_MODEL_NAMES).length === GLM_WEB_MODEL_IDS.length
    && GLM_WEB_MODEL_IDS.every(id => GLM_WEB_MODEL_NAMES[id]?.trim().length > 0),
  '每个 GLM 模型都有展示名',
  JSON.stringify(GLM_WEB_MODEL_NAMES),
)
check(
  GLM_WEB_MODEL_IDS.every(id => !(WEB_MODEL_IDS as readonly string[]).includes(id)),
  'GLM 模型 id 不与 DeepSeek 模型冲突',
  `glm=${JSON.stringify(GLM_WEB_MODEL_IDS)} deepseek=${JSON.stringify(WEB_MODEL_IDS)}`,
)

const effortIds = GLM_WEB_REASONING_EFFORTS.map(item => item.id)
check(
  effortIds.length === 3 && new Set(effortIds).size === 3,
  '思考强度恰好三档且 id 不重复',
  JSON.stringify(effortIds),
)
check(
  effortIds[0] === 'low' && effortIds[1] === 'high' && effortIds[2] === 'max',
  '档位顺序固定 low / high / max',
  JSON.stringify(effortIds),
)
check(
  GLM_WEB_REASONING_EFFORTS.map(item => item.name).join('/') === '快速/深度/极致',
  '档位展示名为 快速 / 深度 / 极致',
  GLM_WEB_REASONING_EFFORTS.map(item => item.name).join('/'),
)
check(
  GLM_WEB_REASONING_EFFORTS.map(item => item.slider).join(',') === '0,1,2',
  'z.ai 滑杆下标为 0 / 1 / 2',
  GLM_WEB_REASONING_EFFORTS.map(item => item.slider).join(','),
)
check(
  GLM_WEB_DEFAULT_REASONING_EFFORT === 'high',
  '默认档位为 high（深度）',
  GLM_WEB_DEFAULT_REASONING_EFFORT,
)
check(
  effortIds.includes(GLM_WEB_DEFAULT_REASONING_EFFORT),
  '默认档位在档位表内',
  `default=${GLM_WEB_DEFAULT_REASONING_EFFORT}`,
)
check(normalizeGlmEffort(undefined) === 'high', '未提供档位时回退深度', normalizeGlmEffort(undefined))
check(normalizeGlmEffort('max') === 'max', '合法档位原样返回', normalizeGlmEffort('max'))
check(normalizeGlmEffort('unknown') === 'high', '未知档位回退深度', normalizeGlmEffort('unknown'))

if (failed === 0) console.log('OK（GLM 模型清单：provider / 模型 / 三档强度 / 默认值一致）')
process.exit(failed === 0 ? 0 : 1)
