/**
 * 契约检查：控制协议默认每轮注入。
 *
 * 背景：网页会话在长任务里会丢上下文（模型退化成普通聊天、忘记 JSON 动作格式），
 * 靠 `protocolRefreshEvery` 隔几轮补一次补不回来。默认值从 false 改成 true 之后，
 * 这里把默认值和两条分支钉住，防止以后改 schema 时被悄悄改回去。
 */
import assert from 'node:assert/strict'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { needsProtocolNow } from '../src/protocol.ts'
import type { WebChatState } from '../src/session-state.ts'

function state(roundsSinceProtocol: number): WebChatState {
  return { roundsSinceProtocol, initialized: true } as WebChatState
}

// 1. 不给任何配置时，默认为每轮注入。
{
  const config = liveConfig(Config({ stateFile: 'x.json' }))
  assert.equal(config.protocolEveryRequest, true, 'protocolEveryRequest 默认应为 true')
}

// 2. 每轮注入开启时，轮数再多也要注入。
{
  const config = liveConfig(Config({ stateFile: 'x.json' }))
  assert.equal(needsProtocolNow(state(0), config), true)
  assert.equal(needsProtocolNow(state(99), config), true)
}

// 3. 显式关掉后，退回按间隔刷新。
{
  const config = liveConfig(Config({ stateFile: 'x.json', protocolEveryRequest: false, protocolRefreshEvery: 8 }))
  assert.equal(needsProtocolNow(state(1), config), false)
  assert.equal(needsProtocolNow(state(8), config), true)
}

console.log('ok: 协议默认每轮注入')
