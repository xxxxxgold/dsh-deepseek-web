/**
 * 「当前是否已处在新对话态」判定回归。
 *
 * 背景：`startFreshConversation()` 原来只看“点击‘开启新对话’后 URL 有没有变化”，
 * 而 DeepSeek 入口页本身就是新对话态（地址 `https://chat.deepseek.com`，点新对话不变地址），
 * 于是每一轮都被判成“没切成功”，回退整页重载；重载后的前端初始化与随后的填字存在竞态，
 * 填进去的内容可能被清空，回车就成了空发——这是“网页看着没问题、dsh 却说没收到响应”的
 * 一条真实成因。本脚本守住 isEntryUrl() 的判定边界，避免这个兜底再退回去。
 */

import assert from 'node:assert/strict'
import { isEntryUrl } from '../src/playwright-channel.ts'

const ENTRY = 'https://chat.deepseek.com'

// 1. 入口页与站点首页都算新对话态
assert.equal(isEntryUrl('https://chat.deepseek.com', ENTRY), true, '入口根路径应判为新对话态')
assert.equal(isEntryUrl('https://chat.deepseek.com/', ENTRY), true, '入口根路径带斜杠应判为新对话态')
assert.equal(isEntryUrl('https://chat.deepseek.com/a/chat', ENTRY), true, '/a/chat 应判为新对话态')
assert.equal(isEntryUrl('https://chat.deepseek.com/a/chat/', ENTRY), true, '/a/chat 带斜杠应判为新对话态')

// 2. 已经开了具体会话就不算——那里必须真的切新对话
assert.equal(
  isEntryUrl('https://chat.deepseek.com/a/chat/s/90edc951-9e56-4e1a-9fe4-fb741b18fe45', ENTRY),
  false,
  '具体会话页不得判为新对话态',
)
assert.equal(
  isEntryUrl('https://chat.deepseek.com/a/chat/s/90edc951-9e56-4e1a-9fe4-fb741b18fe45?x=1', ENTRY),
  false,
  '带查询参数的具体会话页不得判为新对话态',
)

// 3. 别的站点/别的域名一律不算（否则会跳过切换，把消息发进别人的会话）
assert.equal(isEntryUrl('https://www.kimi.com/', ENTRY), false, '跨站不得判为新对话态')
assert.equal(isEntryUrl('https://chat.deepseek.com.evil.test/', ENTRY), false, '同前缀的其它域名不得判为新对话态')

// 4. 用户把某个具体对话配成入口页时，没有“新对话态”可言
const conversationEntry = 'https://chat.deepseek.com/a/chat/s/abc'
assert.equal(
  isEntryUrl('https://chat.deepseek.com/a/chat/s/abc', conversationEntry),
  false,
  '入口页本身是具体会话时不得判为新对话态',
)

// 5. 非法输入不得抛异常（配置里可能是空串或用户乱填）
assert.equal(isEntryUrl('', ENTRY), false, '空地址不得判为新对话态')
assert.equal(isEntryUrl(ENTRY, ''), false, '空入口配置不得判为新对话态')
assert.equal(isEntryUrl('not a url', ENTRY), false, '非法地址不得抛异常')

// 6. 自定义路径入口：完全一致才算
const customEntry = 'https://example.test/chat/new'
assert.equal(isEntryUrl('https://example.test/chat/new', customEntry), true, '自定义入口路径应命中')
assert.equal(isEntryUrl('https://example.test/chat/new/', customEntry), true, '自定义入口路径尾斜杠应命中')
assert.equal(isEntryUrl('https://example.test/chat/newer', customEntry), false, '相近但不相同的路径不得命中')
assert.equal(isEntryUrl('https://example.test/other', customEntry), false, '不同路径不得命中')

console.log('OK: 新对话态判定（入口页 / 具体会话 / 跨站 / 非法输入 / 自定义入口）均符合预期')
