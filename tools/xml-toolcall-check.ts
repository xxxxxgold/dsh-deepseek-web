/**
 * 网页回复解析回归：XML 标签包裹的动作调用。
 *
 * 背景：网页模型偶尔不走 JSON 协议，而是输出 OpenAI function-call 的文本投影
 * `<tool_call>{"name":"read","arguments":{...}}</tool_call>`。2026-10-23 的真实
 * 会话样本里出现过一次，旧解析器既不认这个标签、也不触发纠错，整坨 XML 被当成
 * 最终回答交给用户，任务实际没执行，用户只能重说一遍——白费一整轮网页往返。
 *
 * 这里固定住三条契约：
 * 1. 整条回复就是一个调用块 → 解析成动作，直接执行，不浪费往返；
 * 2. 标签内 JSON 坏了、或标签夹在散文中间 → 不解析，但必须触发纠错；
 * 3. 正文里只是「提到」标签名 → 不解析也不误判成动作。
 *
 * 运行：npx tsx tools/xml-toolcall-check.ts
 */
import {
  looksLikeIntendedToolReply,
  parseWebReply,
} from '../src/response.ts'

let failures = 0
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
}

console.log('XML 标签动作解析')

// 真实样本（来自本机会话落盘，原样保留换行）
const real = '<tool_call>\n{"name": "read", "arguments": {"file_path": "D:/dsh/def/2026-10-23/H3分镜修订/H3提示词定稿.md", "offset": 13, "limit": 4}}\n</tool_call>'
const realParsed = parseWebReply(real)
check('真实样本解析出动作', realParsed.hasActions)
check('真实样本工具名', realParsed.actions[0]?.tool === 'read', realParsed.actions[0]?.tool)
check(
  '真实样本参数完整',
  (realParsed.actions[0]?.params as Record<string, unknown> | undefined)?.file_path
    === 'D:/dsh/def/2026-10-23/H3分镜修订/H3提示词定稿.md'
  && (realParsed.actions[0]?.params as Record<string, unknown> | undefined)?.offset === 13,
  realParsed.actions[0]?.params,
)

// 多动作数组
const multi = parseWebReply('<tool_calls>[{"name":"bash","arguments":{"command":"ls"}},{"name":"read","arguments":{"path":"a.txt"}}]</tool_calls>')
check('数组形态动作数', multi.actions.length === 2, multi.actions.length)
check('数组形态首项工具名', multi.actions[0]?.tool === 'bash', multi.actions[0]?.tool)
check('数组形态保留原参数名', (multi.actions[1]?.params as Record<string, unknown> | undefined)?.path === 'a.txt')

// OpenAI 风格的 arguments 是 JSON 字符串
const stringArgs = parseWebReply('<function_call>{"name":"write","arguments":"{\\"file_path\\":\\"b.md\\",\\"content\\":\\"hi\\"}"}</function_call>')
check('字符串参数解析', stringArgs.hasActions)
check('字符串参数已展开', (stringArgs.actions[0]?.params as Record<string, unknown> | undefined)?.content === 'hi', stringArgs.actions[0]?.params)

// 围栏包裹
check('围栏包裹可解析', parseWebReply('```xml\n<tool_call>{"name":"read","arguments":{"file_path":"x"}}</tool_call>\n```').hasActions)

// 边界：散文夹带 / 坏 JSON / 缺工具名 / 仅提及
const prose = '我先看看这个文件。\n<tool_call>{"name":"read","arguments":{"file_path":"x"}}</tool_call>\n然后再说。'
check('散文夹带不解析', !parseWebReply(prose).hasActions)
check('散文夹带触发纠错', looksLikeIntendedToolReply(prose))

const broken = '<tool_call>{"name":"read","arguments":{</tool_call>'
check('坏 JSON 不解析', !parseWebReply(broken).hasActions)
check('坏 JSON 触发纠错', looksLikeIntendedToolReply(broken))

check('缺工具名不解析', !parseWebReply('<tool_call>{"arguments":{"a":1}}</tool_call>').hasActions)
check('仅提及标签不解析', !parseWebReply('协议里写的 <tool_call> 标签不能用').hasActions)

// 既有契约不能回退
check('普通正文不解析', !parseWebReply('主人，活儿干完了。').hasActions)
check('裸 actions JSON 仍可解析', parseWebReply('{"actions":[{"tool":"read","arguments":{"file_path":"a"}}]}').hasActions)
check('DSML 仍可解析', parseWebReply('<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read"><｜｜DSML｜｜ parameter name="file_path" string="true">a</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>').hasActions)

if (failures > 0) {
  console.log(`\nFAIL: ${failures} 项未通过`)
  process.exit(1)
}
console.log('\nXML 标签动作解析：全部通过')
