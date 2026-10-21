/**
 * 校验「审核窗口地址」的归一化逻辑。
 *
 * 用户在设置里填的就是新标签页要打开的链接，默认已经带 ??chat_enter_method=new_chat。
 * 这里要钉死两件事：
 * 1. 旧配置（只有域名）不能退化——照样得补上建新参数，否则一轮审核会沿用上次对话；
 * 2. 用户填的地址不能被篡改——路径、已有参数、企业版域名、项目页都要原样保留。
 */
import { ensureFreshChatUrl } from '../src/browser-shared.ts'
import { liveConfig } from '../src/live-config.ts'
import { Config } from '../src/config.ts'

let failures = 0
function check(name: string, pass: boolean, detail = ''): void {
  if (!pass) {
    failures += 1
    console.error(`FAIL: ${name}${detail ? `\n  ${detail}` : ''}`)
  } else {
    console.log(`ok: ${name}`)
  }
}

function expect(name: string, input: string, expected: string): void {
  const actual = ensureFreshChatUrl(input)
  check(name, actual === expected, `输入：${input}\n  期望：${expected}\n  实际：${actual}`)
}

function main(): void {
  // ---- 1. 旧配置：只有域名，必须补上建新参数 ----
  expect('裸域名补参数', 'https://www.kimi.com/', 'https://www.kimi.com/?chat_enter_method=new_chat')
  expect('裸域名无斜杠补参数', 'https://www.kimi.com', 'https://www.kimi.com/?chat_enter_method=new_chat')

  // ---- 2. 新默认值：已经带了就一个字都不能动 ----
  expect('已带参数原样返回',
    'https://www.kimi.com/?chat_enter_method=new_chat',
    'https://www.kimi.com/?chat_enter_method=new_chat')

  // ---- 3. 项目页：保留路径，补参数 ----
  expect('项目页保留路径并补参数',
    'https://www.kimi.com/project/1a15bef4-b7a2-894f-8000-0e7143648841',
    'https://www.kimi.com/project/1a15bef4-b7a2-894f-8000-0e7143648841?chat_enter_method=new_chat')

  // ---- 4. 用户自己的查询参数不能丢 ----
  expect('保留用户已有参数',
    'https://www.kimi.com/project/abc?foo=bar',
    'https://www.kimi.com/project/abc?foo=bar&chat_enter_method=new_chat')

  // ---- 5. 项目页 + 斜杠 + 已带参数：不重复追加 ----
  expect('项目页已带参数不重复追加',
    'https://www.kimi.com/project/abc/?chat_enter_method=new_chat',
    'https://www.kimi.com/project/abc/?chat_enter_method=new_chat')

  // ---- 6. 企业版域名照用 ----
  expect('企业版域名照用',
    'https://kimi.example.com/chat',
    'https://kimi.example.com/chat?chat_enter_method=new_chat')

  // ---- 7. 空白与非法输入不炸 ----
  check('空字符串返回空', ensureFreshChatUrl('   ') === '', `实际：${JSON.stringify(ensureFreshChatUrl('   '))}`)
  check('非法 URL 原样返回', ensureFreshChatUrl('not a url') === 'not a url',
    `实际：${JSON.stringify(ensureFreshChatUrl('not a url'))}`)
  check('前后空格被去掉',
    ensureFreshChatUrl('  https://www.kimi.com/  ') === 'https://www.kimi.com/?chat_enter_method=new_chat')

  // ---- 8. 配置默认值确实就是「新会话入口」----
  // volatile 字段必须经 liveConfig 解引用后才能拿到真值（Loader 与内部读取都走这条路径）。
  const parsed = liveConfig(Config({})) as {
    review: { url: string; projectUrl: string; kimiMode: string }
  }
  const reviewUrl = parsed.review.url
  check('配置默认值已带建新参数',
    ensureFreshChatUrl(reviewUrl) === reviewUrl && reviewUrl.includes('chat_enter_method=new_chat'),
    `默认值：${reviewUrl}`)

  // ---- 9. 双模式：正常模式 / 项目模式各用各的地址 ----
  check('审核模式默认是正常模式', parsed.review.kimiMode === 'normal', `实际：${parsed.review.kimiMode}`)
  check('项目模式链接默认留空（不替用户猜项目 ID）', parsed.review.projectUrl === '',
    `实际：${JSON.stringify(parsed.review.projectUrl)}`)

  const projectUrl = 'https://www.kimi.com/project/1a15bef4-b7a2-894f-8000-0e7143648841?chat_enter_method=new_chat'
  check('项目模式地址保留 /project/<id> 路径',
    ensureFreshChatUrl(projectUrl) === projectUrl,
    `实际：${ensureFreshChatUrl(projectUrl)}`)
  check('项目模式缺参数时补上且保留路径',
    ensureFreshChatUrl('https://www.kimi.com/project/1a15bef4-b7a2-894f-8000-0e7143648841')
      === projectUrl,
    `实际：${ensureFreshChatUrl('https://www.kimi.com/project/1a15bef4-b7a2-894f-8000-0e7143648841')}`)
  check('两种模式的默认地址不是同一个页面',
    ensureFreshChatUrl(parsed.review.url) !== ensureFreshChatUrl('https://www.kimi.com/project/x?chat_enter_method=new_chat'),
    '正常模式与项目模式必须指向不同入口')

  if (failures > 0) {
    console.error(`\n${failures} 项失败`)
    process.exit(1)
  }
  console.log('\n审核地址校验全部通过')
}

main()
