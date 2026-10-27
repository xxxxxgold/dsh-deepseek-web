/**
 * 「聚焦开关 → 窗口动作」真值表回归。
 *
 * 背景：`focus.enabled=false` 时首次拉起 Edge 仍会弹到前台，原因是启动本身和
 * `ensureChatPage()` 的 `bringToFront()` 都不看开关。策略函数把这件事收成两条动作
 * （最小化启动 / 是否允许激活页面），这里守住三种开关组合，避免以后又散回调用点。
 */

import assert from 'node:assert/strict'
import { resolveWindowPolicy } from '../src/window-policy.ts'

// 1. 总开关关：最小化启动，页面操作一律不激活
assert.deepEqual(
  resolveWindowPolicy({ enabled: false, webWindow: true }),
  { minimizeOnLaunch: true, activatePage: false },
  '总开关关掉时必须最小化启动，且不再激活页面',
)
assert.deepEqual(
  resolveWindowPolicy({ enabled: false, webWindow: false }),
  { minimizeOnLaunch: true, activatePage: false },
  '总开关关掉时 webWindow 取任何值都不该改变结论',
)

// 2. 只关「填入时聚焦网页窗口」：正常启动，但不抢前台
assert.deepEqual(
  resolveWindowPolicy({ enabled: true, webWindow: false }),
  { minimizeOnLaunch: false, activatePage: false },
  '只关填字聚焦时应保持正常启动，但不激活页面',
)

// 3. 全开 / 未配置：保持原行为
assert.deepEqual(
  resolveWindowPolicy({ enabled: true, webWindow: true }),
  { minimizeOnLaunch: false, activatePage: true },
  '全开时必须保留原来的置前行为',
)
assert.deepEqual(
  resolveWindowPolicy(undefined),
  { minimizeOnLaunch: false, activatePage: true },
  '没有 focus 配置时应按默认（全开）处理',
)
assert.deepEqual(
  resolveWindowPolicy({}),
  { minimizeOnLaunch: false, activatePage: true },
  '空对象等同于未配置',
)

console.log('OK: 窗口策略真值表（总开关关 / 只关填字聚焦 / 全开 / 未配置）均符合预期')
