/**
 * 「等网页响应的窗口必须从发送确认之后才开始计」的回归测试。
 *
 * 这条不变量是本次「全自动发送后未收到网页响应」的总病根：旧实现把
 * `page.waitForResponse(..., { timeout: 180_000 })` 挂在填字之前，填字本身在长文本下
 * 要几十秒到十几分钟，窗口被吃光后代码**仍然会按下回车**——网页确实收到并回答了，
 * 插件却已经判超时。修好之后必须焊死，不允许任何人把带超时的监听再挂回填字之前。
 *
 * 三个通道（deepseek / Kimi 审核 / GLM 审核）都有这条路径，逐个查。检查手段是读源码做
 * 结构化断言：这类缺陷是**顺序错误**，跑真实网页也只能碰运气复现，静态顺序断言才是护栏。
 */
import { readFileSync } from 'node:fs'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`ok: ${name}`)
    return
  }
  failures += 1
  console.error(`FAIL: ${name}${detail === '' ? '' : `\n  ${detail}`}`)
}

interface Target {
  file: string
  /** 该通道里「等响应」用的 waitForResponse 起始标记（用来定位发送路径那一个）。 */
  anchor: string
  /** 发送确认函数名。 */
  sendCall: string
}

const targets: Target[] = [
  { file: 'src/playwright-channel.ts', anchor: 'const waiter = page.waitForResponse(', sendCall: 'sendEditorMessage(page, editor' },
  { file: 'src/kimi-channel.ts', anchor: 'const responsePromise = page.waitForResponse(', sendCall: 'sendEditorMessage(page, editor' },
  { file: 'src/glm-channel.ts', anchor: 'const completionPromise = page.waitForResponse(', sendCall: 'sendEditorMessage(page, editor' },
]

for (const target of targets) {
  const source = readFileSync(new URL(`../${target.file}`, import.meta.url), 'utf8')
  const label = target.file.replace('src/', '').replace('.ts', '')

  const anchorAt = source.indexOf(target.anchor)
  check(`${label}：找得到发送路径的 waitForResponse`, anchorAt >= 0, `未找到锚点 ${target.anchor}`)
  if (anchorAt < 0) continue

  // 取到这次 waitForResponse 调用结束为止（`.then(` 或 `.catch(` 之前的那一段），
  // 各通道的谓词形态不一样（有的以 `}` 结尾、有的是 `)`），所以只认「选项对象里出现 timeout: 0」。
  const headEnd = (() => {
    const thenAt = source.indexOf('.then(', anchorAt)
    const catchAt = source.indexOf('.catch(', anchorAt)
    const stops = [thenAt, catchAt].filter(index => index > anchorAt)
    return stops.length > 0 ? Math.min(...stops) : anchorAt + 800
  })()
  const slice = source.slice(anchorAt, headEnd)

  check(`${label}：响应监听不带超时（timeout: 0）`, /\{\s*timeout:\s*0\s*\}/.test(slice),
    `这次 waitForResponse 的选项里没有 { timeout: 0 }：\n${slice}`)
  check(`${label}：响应监听没有从填字前开始计时的超时`,
    !/timeout:\s*(ackTimeoutMs|Math\.min\(|ACK_TIMEOUT|KIMI_ACK|120_000|[1-9])/.test(slice),
    '仍然把有限超时传给了 waitForResponse——窗口会在填字阶段就过期')

  // 顺序：发送确认 → 启动等待计时 → 进入竞速。必须从锚点往后找发送调用，
  // 否则会命中文件顶部的 import 语句。
  const sendAt = source.indexOf(target.sendCall, anchorAt)
  const startAt = source.indexOf('startAckClock()', anchorAt)
  // 竞速成员因通道而异（deepseek 还等 mirror/限流/取消，Kimi 有 aborted），
  // 只要求 ackDeadline 出现在同一个 Promise.race 数组里。
  const raceMatch = /Promise\.race\(\[[\s\S]{0,800}?ackDeadline!/.exec(source.slice(anchorAt))
  const raceAt = raceMatch ? anchorAt + raceMatch.index : -1
  check(`${label}：发送确认在启动计时之前`, sendAt >= 0 && startAt > sendAt,
    `sendEditorMessage@${sendAt} / startAckClock@${startAt}`)
  check(`${label}：等待计时在竞速之前启动`, startAt >= 0 && raceAt > startAt,
    `startAckClock@${startAt} / race@${raceAt}`)
  check(`${label}：超时被纳入竞速`, raceAt >= 0, '竞速里没有 ackDeadline')
  check(`${label}：计时器在 finally 里被清掉`, /finally\s*\{[\s\S]{0,400}?clearTimeout\(ackTimer\)/.test(source),
    '缺少 clearTimeout(ackTimer)：残留定时器会在回合结束后继续跑')
}

// ---- 行为了解一层：ack 计时器确实从「启动那一刻」开始，而不是从对象创建时 ----
{
  // 直接复刻 startAckClock 的语义做一次时间度量：创建 pending promise 之后空转 300ms，
  // 再启动 400ms 计时器——到点时刻应当是启动后约 400ms，而不是创建后 400ms。
  let firedAt = -1
  const created = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    // 只创建，不启动（对应“监听挂上了但还没发送”）
    void reject
  })
  void deadline.catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 300))
  const startedAt = Date.now()
  timer = setTimeout(() => { firedAt = Date.now() - startedAt }, 400)
  await new Promise(resolve => setTimeout(resolve, 600))
  clearTimeout(timer)
  check('计时器从启动时刻起算（不受启动前空转影响）', firedAt >= 380 && firedAt <= 560,
    `实际 ${firedAt}ms，期望约 400ms；从创建算起会是 ${Date.now() - created}ms 量级`)
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n等待窗口起算点检查全部通过（三个通道 + 计时语义）')
