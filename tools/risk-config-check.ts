/**
 * 校验「风控模式」菜单配置与运行时配置齐平（离线可复现，不需要浏览器）：
 * 1. FIELDS 里每个字段的 path 都能在解析后的默认配置上取到值（否则设置页显示空、保存被宿主拒）；
 * 2. 风控分组恰好 7 个可编辑字段，且都标了 .volatile()（否则不进 settings.describe()，菜单里看不到）；
 * 3. 三档预设的每个 path 都真实存在，且默认配置恰好命中「均衡」档；
 * 4. 套用任一档位后 matchRiskPreset 必须回读为同一档（apply → match 往返一致）。
 */
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import {
  FIELDS,
  GROUPS,
  RISK_PRESETS,
  applyRiskPreset,
  matchRiskPreset,
  readPath,
} from '../src/client/config-fields.ts'

const RISK_FIELD_PATHS = [
  'maxConcurrentTurns',
  'maxSessionPages',
  'sendPauseMinMs',
  'sendPauseMaxMs',
  'longRunAfterSends',
  'longRunPauseMinMs',
  'longRunPauseMaxMs',
] as const

let failed = 0
const fail = (message: string): void => {
  failed += 1
  console.error(`FAIL: ${message}`)
}
const pass = (message: string): void => {
  console.log(`PASS ${message}`)
}

// 原生 .volatile() 字段在 schema 解析后是引用对象（Volatile<T>），
// 要经 liveConfig 的 Proxy 还原成普通值，才是设置页实际拿到的形状。
const defaults = liveConfig(Config({})) as Record<string, unknown>

// 1. 所有字段 path 在默认配置上都有值
for (const field of FIELDS) {
  const value = readPath(defaults, field.path)
  if (value === undefined) fail(`字段 ${field.path.join('.')} 在默认配置里不存在`)
}
for (const preset of RISK_PRESETS) {
  for (const item of preset.values) {
    if (readPath(defaults, item.path) === undefined) fail(`档位 ${preset.id} 的 ${item.path.join('.')} 在默认配置里不存在`)
  }
}
pass(`FIELDS ${FIELDS.length} 个字段与档位引用路径全部存在于配置 schema`)

// 2. 风控分组字段齐全且都在 volatile 条目里
const riskFields = FIELDS.filter(field => field.group === 'risk')
const riskKeys = riskFields.map(field => field.path.join('.'))
for (const path of RISK_FIELD_PATHS) {
  if (!riskKeys.includes(path)) fail(`风控分组缺少字段 ${path}`)
}
if (riskFields.length !== RISK_FIELD_PATHS.length) {
  fail(`风控分组字段数应为 ${RISK_FIELD_PATHS.length}，实际 ${riskFields.length}`)
}
const riskGroup = GROUPS.find(group => group.id === 'risk')
if (riskGroup === undefined) fail('GROUPS 里没有 risk 分组')
pass(`风控分组 ${riskGroup?.label.zh ?? '?'} 含 ${riskFields.length} 个字段`)

// 2b. 这些字段必须带 volatile 标记，否则宿主 settings.describe() 不投影它们 → 菜单里看不到
const shape = (Config as unknown as {
  dict?: Record<string, { meta?: { volatile?: unknown } }>
}).dict ?? {}
for (const path of RISK_FIELD_PATHS) {
  const marked = shape[path]?.meta?.volatile
  if (marked !== true && marked === undefined) fail(`配置字段 ${path} 没有 volatile 标记，不会出现在设置菜单里`)
}
pass('风控字段全部带 volatile 标记，会被 settings.describe() 投影进菜单')

// 3. 默认值应命中「均衡」档
const tier = matchRiskPreset(defaults)
if (tier !== 'balanced') fail(`默认配置应命中 balanced 档，实际 ${tier}`)
else pass('默认配置命中「均衡（推荐）」档')

// 4. 三档 apply → match 往返一致
for (const preset of RISK_PRESETS) {
  const applied = applyRiskPreset(null, defaults, preset)
  const back = matchRiskPreset(applied)
  if (back !== preset.id) fail(`套用 ${preset.id} 后回读为 ${back}`)
  else pass(`档位 ${preset.id}（${preset.label.zh}）套用后回读一致`)
}

// 5. 关掉任一参数后应判定为自定义
const broken = applyRiskPreset(null, defaults, RISK_PRESETS[1]!)
broken.sendPauseMaxMs = 9_999
if (matchRiskPreset(broken) !== 'custom') fail('改掉一个值后应判定为 custom')
else pass('手动改动任一参数判定为「自定义」')

// 6. 档位不碰并发与标签页上限
const before = readPath(defaults, ['maxConcurrentTurns'])
const appliedStrict = applyRiskPreset(null, defaults, RISK_PRESETS[2]!)
if (readPath(appliedStrict, ['maxConcurrentTurns']) !== before) fail('档位不应改动 maxConcurrentTurns')
else pass('档位不影响并发上限（一号两并发保持 2）')

if (failed > 0) {
  console.error(`\n风控模式配置校验失败 ${failed} 项`)
  process.exit(1)
}
console.log('\n风控模式配置校验全部通过 ✅')
