/**
 * 校验 Kimi 审核的「正常模式 / 项目模式」两种入口，以及重试次数的收敛。
 *
 * 两件事都曾经真出过问题，所以各留一条回归线：
 *
 * 1. **重试次数被污染**：`fetchRetries` 是 volatile 数值字段，读到空格子时会拿到 NaN。
 *    `Math.min(3, NaN)` 还是 NaN，`attempt <= NaN` 恒为 false，重试循环一次都不进，
 *    `lastError` 保持 undefined，最后 `throw undefined` —— 宿主侧只看到一句「回合失败」，
 *    完全看不出真正原因。`sanitizeRetries` 必须把 NaN 收敛成合法整数。
 * 2. **两种模式串门**：项目页发出第一条消息后地址会变成 `/chat/<uuid>`，与普通对话同形，
 *    所以页面归属只能靠「这一页是用哪种模式开出来的」来判断，不能看路径。
 */
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import type { FocusConfig, ReviewConfig } from '../src/config.ts'
import { KimiBrowserChannel } from '../src/kimi-channel.ts'
import { LlmError } from '@deepseek-ai/dsh-llm'

let failures = 0
function check(name: string, pass: boolean, detail = ''): void {
  if (!pass) {
    failures += 1
    console.error(`FAIL: ${name}${detail ? `\n  ${detail}` : ''}`)
  } else {
    console.log(`ok: ${name}`)
  }
}

/* ------------------------------------------------------------------ */
/* 一、重试次数收敛                                                     */
/* ------------------------------------------------------------------ */

const sanitize = (raw: unknown): number =>
  (KimiBrowserChannel as unknown as {
    sanitizeRetries: (raw: unknown, fallback: number, max: number) => number
  }).sanitizeRetries(raw, 1, 3)

const retryCases: ReadonlyArray<readonly [string, unknown, number]> = [
  ['NaN 收敛成回退值', Number.NaN, 1],
  ['undefined 收敛成回退值', undefined, 1],
  ['null 收敛成回退值', null, 1],
  ['0 是合法值（关闭重试）', 0, 0],
  ['负数收敛成 0', -5, 0],
  ['超过上限截到上限', 99, 3],
  ['小数向左取整', 2.7, 2],
  ['数字字符串按数字解析', '2', 2],
  ['非数字字符串回退', 'abc', 1],
  ['Infinity 视为非法值、回退默认', Number.POSITIVE_INFINITY, 1],
  ['负 Infinity 视为非法值、回退默认', Number.NEGATIVE_INFINITY, 1],
  ['空字符串视为未配置、回退默认', '', 1],
]
for (const [label, raw, expected] of retryCases) {
  const actual = sanitize(raw)
  check(`重试次数：${label}`, actual === expected, `期望 ${expected}，实得 ${actual}`)
}
check(
  '重试次数：收敛结果永远是整数',
  retryCases.every(([, raw]) => Number.isInteger(sanitize(raw))),
  '存在非整数结果',
)

/* ------------------------------------------------------------------ */
/* 二、两种模式的入口地址                                               */
/* ------------------------------------------------------------------ */

// 配置里的 volatile 字段是引用对象，必须经 liveConfig 解引用才能读到真值
const baseReview = liveConfig(Config({})).review as ReviewConfig
const focus = liveConfig(Config({})).focus as FocusConfig
const NORMAL_URL = 'https://www.kimi.com/?chat_enter_method=new_chat'
const PROJECT_URL = 'https://www.kimi.com/project/1a15bef4-b7a2-894f-8000-0e7143648841?chat_enter_method=new_chat'

function makeChannel(overrides: Partial<ReviewConfig>): KimiBrowserChannel {
  return new KimiBrowserChannel({
    config: { ...baseReview, ...overrides },
    focus,
  })
}

type Internals = {
  resolveEntryUrl: () => string
  pageMatchesMode: (page: { url: () => string; isClosed: () => boolean }) => boolean
  pageMode?: 'normal' | 'project'
}
const internals = (channel: KimiBrowserChannel): Internals => channel as unknown as Internals
const fakePage = (url: string): { url: () => string; isClosed: () => boolean } => ({
  url: () => url,
  isClosed: () => false,
})

// 入口地址：各用各的，互不兜底
check(
  '入口：正常模式用 url',
  internals(makeChannel({ kimiMode: 'normal', url: NORMAL_URL })).resolveEntryUrl() === NORMAL_URL,
  internals(makeChannel({ kimiMode: 'normal', url: NORMAL_URL })).resolveEntryUrl(),
)
check(
  '入口：项目模式用 projectUrl（且保留项目路径）',
  internals(makeChannel({ kimiMode: 'project', projectUrl: PROJECT_URL })).resolveEntryUrl() === PROJECT_URL,
  internals(makeChannel({ kimiMode: 'project', projectUrl: PROJECT_URL })).resolveEntryUrl(),
)
check(
  '入口：正常模式不会误用 projectUrl',
  internals(makeChannel({ kimiMode: 'normal', url: NORMAL_URL, projectUrl: PROJECT_URL })).resolveEntryUrl()
    === NORMAL_URL,
  '正常模式取到了项目地址',
)

// 项目模式没填链接：必须明确报错，不能静默退回普通对话
let projectUrlError: unknown
try {
  internals(makeChannel({ kimiMode: 'project', projectUrl: '' })).resolveEntryUrl()
} catch (error) {
  projectUrlError = error
}
check(
  '入口：项目模式缺链接时抛 KIMI_PROJECT_URL_MISSING',
  projectUrlError instanceof LlmError && projectUrlError.code === 'KIMI_PROJECT_URL_MISSING',
  `实得 ${String(projectUrlError)}`,
)
check(
  '入口：项目模式缺链接的报错带排查指引',
  projectUrlError instanceof Error && projectUrlError.message.includes('项目模式链接'),
  '报错里没提该填哪个字段',
)
check(
  '入口：正常模式缺 url 时回退到默认新会话入口',
  (() => {
    const resolved = internals(makeChannel({ kimiMode: 'normal', url: '' })).resolveEntryUrl()
    return resolved.includes('chat_enter_method=new_chat')
  })(),
  '空 url 没有回退到新会话入口',
)

// 页面归属：靠「这页是哪种模式开的」，不看路径
{
  // 项目页发完消息后变成 /chat/<uuid>，与普通对话同形——路径看不出归属
  const chatAfterProject = 'https://www.kimi.com/chat/1a15c4a0-4702-83d5-8000-09712cee9ac7?chat_enter_method=new_chat'
  const ch = makeChannel({ kimiMode: 'normal', url: NORMAL_URL })
  internals(ch).pageMode = 'project'
  check(
    '归属：项目模式开的页，切到正常模式后判为不符（即使地址是 /chat/uuid）',
    internals(ch).pageMatchesMode(fakePage(chatAfterProject)) === false,
    '被判为符合，会继续在旧页发消息',
  )

  const ch2 = makeChannel({ kimiMode: 'project', projectUrl: PROJECT_URL })
  internals(ch2).pageMode = 'project'
  check(
    '归属：项目模式开的页，仍在项目模式时判为符合',
    internals(ch2).pageMatchesMode(fakePage(chatAfterProject)) === true,
    '同模式被误判为不符，会导致每轮都重开',
  )

  const ch3 = makeChannel({ kimiMode: 'normal', url: NORMAL_URL })
  internals(ch3).pageMode = 'normal'
  check(
    '归属：正常模式开的普通对话页判为符合',
    internals(ch3).pageMatchesMode(fakePage(chatAfterProject)) === true,
    '同模式被误判为不符',
  )

  const ch4 = makeChannel({ kimiMode: 'normal', url: NORMAL_URL })
  internals(ch4).pageMode = 'normal'
  check(
    '归属：页面被导航到别的站点时判为不符',
    internals(ch4).pageMatchesMode(fakePage('https://example.com/chat/1')) === false,
    '跨站页面没被识别出来',
  )

  const ch5 = makeChannel({ kimiMode: 'normal', url: NORMAL_URL })
  check(
    '归属：本实例没开过页（来源未知）时不主动重开',
    internals(ch5).pageMatchesMode(fakePage(chatAfterProject)) === true,
    '来源未知时多开了一个标签页',
  )
}

/* ------------------------------------------------------------------ */
/* 三、配置默认值                                                       */
/* ------------------------------------------------------------------ */

const defaults = liveConfig(Config({})).review as ReviewConfig
check('配置：审核模式默认「正常模式」', defaults.kimiMode === 'normal', `实得 ${defaults.kimiMode}`)
check('配置：项目链接默认空', defaults.projectUrl === '', `实得 ${JSON.stringify(defaults.projectUrl)}`)
check(
  '配置：能显式选「项目模式」',
  (liveConfig(Config({ review: { kimiMode: 'project' } })).review as ReviewConfig).kimiMode === 'project',
  '项目模式配置不生效',
)
check(
  '配置：项目链接可写入',
  (liveConfig(Config({ review: { projectUrl: PROJECT_URL } })).review as ReviewConfig).projectUrl === PROJECT_URL,
  '项目链接写不进去',
)
check(
  '配置：重试配置默认 1（不重试）',
  defaults.fetchRetries === 1,
  `实得 ${String(defaults.fetchRetries)}`,
)

if (failures > 0) {
  console.error(`\n${failures} 项未通过`)
  process.exit(1)
}
console.log('\n全部通过')
