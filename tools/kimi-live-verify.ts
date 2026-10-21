/**
 * 端到端验证：连真实 Kimi 网页跑两轮，验证「自动发送」和「每轮一个干净对话」。
 *
 * 判定信号用**页面 URL 里的 chat id**，不用模型回答：
 * Kimi 有账号级长期记忆，问“刚才记的数字”即使换了新对话它也能答上来
 * （实测思考里写着「memory 中已有一个 id 7 也是记住 47」），用回答判定会误判。
 */
import { chromium } from 'playwright-core'
import { KimiBrowserChannel } from '../src/kimi-channel.ts'
import type { ReviewConfig, FocusConfig } from '../src/config.ts'

const PORT = 9334

const review = {
  enabled: true,
  provider: 'kimi',
  autoSend: true,
  conversationMode: 'fresh',
  sendVerifyMs: 1_500,
  sendRetries: 2,
  fetchRetries: 1,
  url: 'https://www.kimi.com/',
  debugPort: PORT,
  streamIdleTimeoutMs: 90_000,
  maxEvidenceChars: 60_000,
  maxRounds: 1,
  glmUrl: 'https://chat.z.ai/',
  glmDebugPort: 9335,
} as ReviewConfig

const focus = {
  enabled: false,
  webWindow: false,
  dshWindow: false,
  dshProcessNames: ['electron', 'dsh', 'DeepSeek Harness'],
  dshTitlePattern: 'DeepSeek Harness|dsh',
} as FocusConfig

/** 列出当前所有 Kimi 标签页的 URL（从外部 CDP 观察，不碰通道内部状态）。 */
async function listKimiTabs(): Promise<string[]> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  try {
    return browser.contexts()[0].pages().map(p => p.url()).filter(u => u.includes('kimi.com'))
  } finally {
    await browser.close().catch(() => {})
  }
}

/** 从 URL 里取 chat id；`/?chat_enter_method=new_chat` 这种还没有 id。 */
function chatIdOf(url: string): string {
  const match = /\/chat\/([0-9a-f-]+)/iu.exec(url)
  return match ? match[1] : '(no-chat-id)'
}

const channel = new KimiBrowserChannel({ config: review, focus })

async function main(): Promise<void> {
  const t0 = Date.now()
  await channel.ensureReady()
  console.log(`就绪耗时 ${Date.now() - t0}ms`)

  const rounds: { url: string; id: string; ms: number; text: string }[] = []

  for (const n of [1, 2]) {
    channel.resetConversationGate('kimi-review')
    const startedAt = Date.now()
    const result = await channel.turn({
      sessionId: 'kimi-review',
      model: 'kimi-web',
      text: n === 1 ? '收到请只回复两个字：好的。' : '收到请只回复两个字：收到。',
      initialize: true,
      autoSend: true,
    })
    const elapsed = Date.now() - startedAt
    const tabs = await listKimiTabs()
    const url = tabs[0] ?? ''
    rounds.push({ url, id: chatIdOf(url), ms: elapsed, text: result.text })
    console.log(`\n第 ${n} 轮：${elapsed}ms | chat=${chatIdOf(url)}`)
    console.log(`  URL：${url}`)
    console.log(`  回复：${JSON.stringify(result.text.slice(0, 80))}`)
  }

  console.log('\n===== 结果 =====')
  console.log(`自动发送：两轮都拿到了网页回复 ✅`)
  const same = rounds[0].id === rounds[1].id
  console.log(`新建对话：第1轮 chat=${rounds[0].id} / 第2轮 chat=${rounds[1].id}`)
  console.log(same
    ? '  → ❌ 两轮落在同一个对话里'
    : '  → ✅ 两轮在两个不同的对话里，每轮都是干净的')
  console.log(`标签页数量：${(await listKimiTabs()).length}（应当始终为 1，旧标签用完会关掉）`)

  await channel.dispose()
  if (same) process.exit(1)
}

await main().catch(async error => {
  console.error('失败：', error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
  try { await channel.dispose() } catch { /* 清理失败不影响结论 */ }
  process.exit(1)
})
