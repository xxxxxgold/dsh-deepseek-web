/**
 * 分段标记形状检查：中文全角【】标记的渲染形状 + isBodyPiece 归类。
 * 覆盖新标记（全角）、0.6.0 纯字母标记、0.5.x 半角方括号标记三类共存的情形。
 */
import { WEB_MARKERS, isBodyPiece } from '../src/protocol.js'

const cases: Array<[string, boolean, string]> = [
  [`${WEB_MARKERS.system}\n你是一个 Agent 指令引擎`, false, '新：系统指令不算正文'],
  [`${WEB_MARKERS.context}：user】\n你好`, true, '新：宿主上下文(带来源)算正文'],
  [`${WEB_MARKERS.context}】\n压缩检查点`, true, '新：宿主上下文(无来源)算正文'],
  [`${WEB_MARKERS.history}\n上一轮回答`, true, '新：历史助手回复算正文'],
  [`${WEB_MARKERS.user}\n用户消息`, true, '新：用户消息算正文'],
  [`${WEB_MARKERS.goal}\n做点什么`, false, '新：当前用户任务不算正文'],
  [`${WEB_MARKERS.resume}\n继续`, false, '新：任务接续不算正文'],
  [`DSHWEB-CONTEXT-V1 user\n旧格式上下文`, true, '0.6.0：CONTEXT 算正文'],
  [`DSHWEB-HISTORY-V1\n旧格式历史`, true, '0.6.0：HISTORY 算正文'],
  [`DSHWEB-SYSTEM-V1\n旧格式系统`, false, '0.6.0：SYSTEM 不算正文'],
  [`DSHWEB-GOAL-V1\n旧格式任务`, false, '0.6.0：GOAL 不算正文'],
  [`[宿主上下文：user]\n旧方括号`, true, '0.5.x：宿主上下文算正文'],
  [`[历史助手回复]\n旧方括号`, true, '0.5.x：历史回复算正文'],
  [`[宿主系统指令]\n旧方括号`, false, '0.5.x：系统指令不算正文'],
]

let bad = 0
for (const [text, want, label] of cases) {
  const got = isBodyPiece(text)
  const ok = got === want
  if (!ok) bad++
  console.log(`${ok ? 'PASS' : 'FAIL'}  want=${String(want).padEnd(5)} got=${String(got).padEnd(5)} ${label}`)
}

// 标记形状：必须全角【】包裹，且不含半角方括号（否则网页端 markdown 序列化会转义）
const shapes = [
  ['system', WEB_MARKERS.system, true],
  ['history', WEB_MARKERS.history, true],
  ['user', WEB_MARKERS.user, true],
  ['goal', WEB_MARKERS.goal, true],
  ['resume', WEB_MARKERS.resume, true],
  ['context(带来源)', `${WEB_MARKERS.context}：user】`, true],
  ['context(无来源)', `${WEB_MARKERS.context}】`, true],
] as const
for (const [name, text, expectBracket] of shapes) {
  const okShape = text.startsWith('【') && text.endsWith('】') && !text.includes('[') && !text.includes(']')
  const ok = okShape === expectBracket
  if (!ok) bad++
  console.log(`${ok ? 'PASS' : 'FAIL'}  形状 ${name}: ${text}`)
}

console.log(bad === 0 ? 'ALL PASS（分段标记形状 + 正文归类）' : `${bad} 项失败`)
if (bad > 0) process.exit(1)
