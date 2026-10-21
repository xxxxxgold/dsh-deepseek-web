/**
 * 双模式端到端验证：分别用「正常模式」和「项目模式」走一遍产品代码路径，
 * 确认「按模式选对入口 → 新标签页 → 自动发送 → 拿到回复」，以及项目模式缺链接时必须报错。
 *
 * 用法：npx tsx tmp/verify-modes.ts normal|project|project-empty
 */
import { Config } from '../src/config.ts'
import { KimiBrowserChannel } from '../src/kimi-channel.ts'
import { liveConfig } from '../src/live-config.ts'

const PROJECT_URL =
  'https://www.kimi.com/project/1a15bef4-b7a2-894f-8000-0e7143648841'
const PROMPT = '收到请只回复两个字：收到。'

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'normal'
  const live = Config({})
  const base = { ...liveConfig(live.review), enabled: true, autoSend: true, conversationMode: 'fresh' as const }

  const review: {
    kimiMode: 'normal' | 'project'
    projectUrl: string
    url: string
    [key: string]: unknown
  } = {
    ...base,
    kimiMode: mode === 'project' || mode === 'project-empty' || mode === 'switch' ? 'project' : 'normal',
    projectUrl: mode === 'project-empty' ? '' : PROJECT_URL,
    url: 'https://www.kimi.com/?chat_enter_method=new_chat',
  }

  console.log(`[模式] ${mode}`)
  const channel = new KimiBrowserChannel({ config: review, focus: live.focus })
  const started = Date.now()
  try {
    await channel.ensureReady()
    const pageUrl = (channel as unknown as { page?: { url(): string } }).page?.url() ?? '(无)'
    console.log('[1] 就绪，用时', Date.now() - started, 'ms，当前页:', pageUrl)

    if (mode === 'switch') {
      // 第一段：项目模式开一轮，页面停在项目里（发出消息后变成 /chat/<uuid>）。
      const first = await channel.turn({
        sessionId: 'kimi-review', model: 'kimi-web', text: PROMPT, initialize: true, autoSend: true,
      })
      const projectPage = (channel as unknown as { page?: { url(): string } }).page?.url() ?? '(无)'
      console.log('[A] 项目模式回复:', JSON.stringify(first.text.slice(0, 40)), '页:', projectPage)

      // 第二段：切回正常模式并走复用路径（initialize=false）。
      review.kimiMode = 'normal'
      const second = await channel.turn({
        sessionId: 'kimi-review', model: 'kimi-web', text: PROMPT, initialize: false, autoSend: true,
      })
      const switchedPage = (channel as unknown as { page?: { url(): string } }).page?.url() ?? '(无)'
      console.log('[B] 切模式后回复:', JSON.stringify(second.text.slice(0, 40)), '页:', switchedPage)
      console.log('[C] 换页说明:', projectPage !== switchedPage ? '已按新模式重开' : '没换页（仍在旧页）')
      return
    }

    const result = await channel.turn({
      sessionId: 'kimi-review',
      model: 'kimi-web',
      text: PROMPT,
      initialize: true,
      autoSend: true,
    })
    const afterUrl = (channel as unknown as { page?: { url(): string } }).page?.url() ?? '(无)'
    console.log('[2] turn 完成，总用时', Date.now() - started, 'ms，回合后页:', afterUrl)
    console.log('[3] 回复正文:', JSON.stringify(result.text.slice(0, 80)))
    console.log('[4] 结果:', result.text.trim().length > 0 ? '成功' : '空回复')
    if (mode === 'project-empty') {
      console.error('[预期失败但成功了] 项目模式空链接没有报错')
      process.exitCode = 1
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = (error as { code?: string })?.code ?? '(无 code)'
    console.log('[失败]', code, message.slice(0, 160))
    if (mode === 'project-empty') {
      const expected = code === 'KIMI_PROJECT_URL_MISSING'
      console.log('[5] 空链接报错语义:', expected ? '符合预期' : '不符合预期')
      if (!expected) process.exitCode = 1
    } else {
      process.exitCode = 1
    }
  } finally {
    await channel.dispose().catch(() => {})
  }
}

main().catch(error => { console.error(error); process.exit(1) })
