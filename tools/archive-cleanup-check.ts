/**
 * 离线回归：归档联动清理的纯逻辑。
 *
 * 覆盖点：
 * 1. 网页对话 URL → 对话 id 的解析（含入口页、查询串、非法地址）；
 * 2. `SessionRegistry` 的 `webChatKeys` 去重与清理记账；
 * 3. `ArchiveCleanup` 的统计口径（cleaned / pending / unbound）；
 * 4. 单条删除成功与失败两条路径，失败会重试一次并记账。
 *
 * 不访问浏览器、不访问网络，全部用替身。
 */
import assert from 'node:assert/strict'
import { chatIdFromUrl } from '../src/playwright-channel.ts'
import { SessionRegistry } from '../src/session-state.ts'
import type { Config } from '../src/config.ts'
import { ArchiveCleanup } from '../src/archive-cleanup.ts'
import type { PlaywrightBrowserChannel } from '../src/playwright-channel.ts'

// ---- 1. URL 解析 ----
{
  assert.equal(chatIdFromUrl('https://chat.deepseek.com/a/chat/s/abc-123'), 'abc-123')
  assert.equal(chatIdFromUrl('https://chat.deepseek.com/a/chat/s/abc-123?x=1#top'), 'abc-123')
  assert.equal(chatIdFromUrl('https://chat.deepseek.com/'), undefined)
  assert.equal(chatIdFromUrl('https://chat.deepseek.com/a/chat'), undefined)
  assert.equal(chatIdFromUrl('not a url'), undefined)
}

// ---- 2. 绑定去重与清理记账 ----
{
  const sessions = new SessionRegistry({})
  assert.deepEqual(sessions.webChatKeysFor('s1'), [])
  assert.equal(sessions.recordWebChatKey('s1', 'c1'), true)
  assert.equal(sessions.recordWebChatKey('s1', 'c1'), false, '重复 id 不应新增')
  assert.equal(sessions.recordWebChatKey('s1', 'c2'), true)
  assert.deepEqual(sessions.webChatKeysFor('s1'), ['c1', 'c2'])
  assert.equal(sessions.isCleaned('s1'), false)
  sessions.markCleaned('s1')
  assert.equal(sessions.isCleaned('s1'), true)
  assert.deepEqual(sessions.cleanupSnapshot().cleaned, ['s1'])
  sessions.markCleanupFailed('s2', 'boom')
  assert.equal(sessions.cleanupSnapshot().failed.s2?.error, 'boom')
}

// ---- 3. 统计口径 ----
const config = {
  archiveCleanup: { deleteOnArchive: true, includeRotatedChats: true },
} as unknown as Config

function fakeChannel(result: { ok: boolean; error?: string }): {
  channel: PlaywrightBrowserChannel
  calls: string[]
} {
  const calls: string[] = []
  const channel = {
    deleteWebChat: async (chatId: string) => {
      calls.push(chatId)
      return result
    },
  } as unknown as PlaywrightBrowserChannel
  return { channel, calls }
}

{
  const sessions = new SessionRegistry({})
  sessions.recordWebChatKey('s1', 'c1')
  sessions.recordWebChatKey('s1', 'c2')
  sessions.recordWebChatKey('s2', 'c3')
  sessions.markCleaned('s2')
  const { channel } = fakeChannel({ ok: true })
  const cleanup = new ArchiveCleanup({
    registry: { archivedSessionIds: ['s1', 's2', 's3'] },
    sessions,
    channel,
    config,
  })
  assert.deepEqual(cleanup.stats(), { archivedTotal: 3, cleaned: 1, pending: 1, unbound: 1, failed: 0 })
}

// ---- 4. 删除成功 / 失败 ----
{
  const sessions = new SessionRegistry({})
  sessions.recordWebChatKey('s1', 'c1')
  sessions.recordWebChatKey('s1', 'c2')
  const { channel, calls } = fakeChannel({ ok: true })
  const cleanup = new ArchiveCleanup({
    registry: { archivedSessionIds: ['s1'] },
    sessions,
    channel,
    config,
  })
  const result = await cleanup.cleanSession('s1')
  assert.equal(result.attempted, 2)
  assert.equal(result.deleted, 2)
  assert.deepEqual(calls, ['c1', 'c2'])
  assert.equal(sessions.isCleaned('s1'), true)
}

{
  const sessions = new SessionRegistry({})
  sessions.recordWebChatKey('s1', 'c1')
  const { channel, calls } = fakeChannel({ ok: false, error: 'HTTP 500' })
  const cleanup = new ArchiveCleanup({
    registry: { archivedSessionIds: ['s1'] },
    sessions,
    channel,
    config,
  })
  const result = await cleanup.cleanSession('s1')
  assert.equal(result.failed, 1)
  assert.equal(calls.length, 2, '失败应重试一次')
  assert.equal(sessions.isCleaned('s1'), false)
  assert.equal(sessions.cleanupSnapshot().failed.s1?.error, 'HTTP 500')
}

console.log('archive-cleanup-check: ok')
