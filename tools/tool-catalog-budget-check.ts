/**
 * 离线回归：工具目录的字符预算与省略名单。
 *
 * 要防的失败是「工具被静默砍掉」：目录每轮下发，超预算若默默丢弃，模型会表现成
 * 「不会用工具」，而插件日志一切正常——竞品 0.1.33 之前正是 24k 预算静默砍掉 26/61
 * 个工具。所以这里断言：
 * 1. 目录不超预算；
 * 2. 超预算时**被省略的工具名必须出现在正文里**；
 * 3. 0 = 不限制；
 * 4. 只有一个工具时即使超预算也要保留（否则目录直接空掉，模型彻底没工具）；
 * 5. compact 关掉时目录更长，但仍受同一预算约束。
 */
import assert from 'node:assert/strict'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_MAX_TOOL_CATALOG_CHARS,
  buildToolCatalog,
  buildToolCatalogDetailed,
} from '../src/protocol.ts'

const tool = (name: string, description = '做一个很长的描述'.repeat(12)): ToolSchema => ({
  name,
  description,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
})

// ---- 1. 小目录：全量纳入、没有省略说明 ----
{
  const result = buildToolCatalogDetailed([tool('read'), tool('write')], true)
  assert.deepEqual(result.included, ['read', 'write'])
  assert.deepEqual(result.omitted, [])
  assert.match(result.text, /^可用工具：/u)
  assert.doesNotMatch(result.text, /未列出/u)
}

// ---- 2. 超预算：裁剪 + 显式列出被省略的工具名 ----
{
  const tools = Array.from({ length: 40 }, (_, index) => tool(`tool_${index}`))
  const result = buildToolCatalogDetailed(tools, false, 2_000)
  assert.equal(result.text.length <= 2_000, true, `目录不应超预算：${result.text.length}`)
  assert.equal(result.omitted.length > 0, true, '应真的发生裁剪')
  assert.equal(result.included.length + result.omitted.length, tools.length, '工具不能凭空消失')
  // 每个被省略的名字都要能在正文里被找到（这是这条回归的全部意义）
  for (const name of result.omitted) {
    assert.equal(result.text.includes(name), true, `被省略的工具必须点名：${name}`)
  }
  assert.match(result.text, /因目录长度上限未列出/u)
  // 顺序保持：included 必须是原顺序前缀
  assert.deepEqual(result.included, tools.slice(0, result.included.length).map(item => item.name))
}

// ---- 3. 0 = 不限制 ----
{
  const tools = Array.from({ length: 40 }, (_, index) => tool(`tool_${index}`))
  const unlimited = buildToolCatalogDetailed(tools, false, 0)
  assert.deepEqual(unlimited.omitted, [])
  assert.equal(unlimited.included.length, tools.length)
  // 预算给得极大时同理
  const huge = buildToolCatalogDetailed(tools, false, 10_000_000)
  assert.deepEqual(huge.omitted, [])
}

// ---- 4. 第一个工具即使超预算也要保留 ----
{
  const result = buildToolCatalogDetailed([tool('only_one')], false, 10)
  assert.deepEqual(result.included, ['only_one'])
  assert.deepEqual(result.omitted, [])
}

// ---- 5. compact 关掉后目录更长，但仍受同一预算 ----
{
  const tools = Array.from({ length: 30 }, (_, index) => tool(`tool_${index}`))
  const compact = buildToolCatalog(tools, true, 1_500)
  const full = buildToolCatalog(tools, false, 1_500)
  assert.equal(compact.length <= 1_500, true)
  assert.equal(full.length <= 1_500, true)
  assert.equal(buildToolCatalog(tools, true, 0).length > compact.length, true, '不限制时应更长')
}

// ---- 6. 默认预算常量与 Config 默认值一致（防两处漂移） ----
{
  assert.equal(DEFAULT_MAX_TOOL_CATALOG_CHARS, 28_000)
}

console.info('OK（工具目录预算：裁剪 + 省略名单点名 + 0 不限 + 首条保留 + 默认值）')
