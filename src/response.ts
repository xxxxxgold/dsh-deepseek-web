/**
 * 网页版回答解析：把模型的自由文本还原成 Harness 的 content block。
 *
 * 模型在网页端没有原生 tool-call 通道，因此协议要求：
 * - 要调用工具：输出包含 `actions` 的 JSON（可带 ```json 围栏）；
 * - 任务完成：直接输出正文。
 *
 * @module dsh-deepseek-web/response
 */

import type { ContentBlock, StreamChunk, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'

export interface WebToolAction {
  /** Harness 工具名。 */
  tool?: string
  /** 兼容用户方案里的 action 命名。 */
  action?: string
  params?: Record<string, unknown>
  arguments?: Record<string, unknown>
}

export interface ParsedWebReply {
  /** 是否解析出可执行动作。 */
  hasActions: boolean
  /** 规范化后的动作列表。 */
  actions: WebToolAction[]
  /** 无动作时作为最终回答的文本。 */
  text: string
}

/** 只拦截明显的未完成交接文本；用户要求摘要/分析时允许正常输出。 */
export function looksLikeUnfinishedHandoff(text: string, task: string): boolean {
  if (!task || /总结|摘要|交接|分析|解释|summari[sz]e|summary|handoff|analy[sz]e|explain/i.test(task)) return false
  const markers = [
    /(?:^|\n)\s*-\s*User asked\b/i,
    /(?:^|\n)\s*-\s*User wants\b/i,
    /(?:^|\n)\s*-\s*Prior assistant\b/i,
    /(?:^|\n)\s*##\s*Primary Request and Intent\b/i,
    /(?:^|\n)\s*##\s*(?:Pending Jobs|Current Work|Next Step)\b/i,
  ].filter(pattern => pattern.test(text)).length
  return markers >= 3 && /NOT yet|not yet|pending|尚未|待办|未完成/i.test(text)
}

/** 本地审查发现的一条动作问题。 */
export interface ActionProblem {
  /** 动作在 actions 数组中的序号。 */
  index: number
  /** 涉及的工具名（若可识别）。 */
  tool?: string
  /** 人类可读的问题说明。 */
  problem: string
}

const DESTRUCTIVE_COMMAND_PATTERNS: Array<[RegExp, string]> = [
  [/(?:^|[;&|]\s*)rm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(?:\/|~|\$HOME)/i, '疑似递归删除根目录/家目录'],
  [/Remove-Item\b[^\n]*-Recurse[^\n]*(?:[A-Za-z]:\\|\$env:USERPROFILE|\$HOME|~)[^\n]*$/im, '疑似递归删除系统盘/家目录'],
  [/\b(?:mkfs(?:\.[a-z0-9]+)?|diskpart)\b/i, '疑似磁盘格式化操作'],
  [/\bformat\s+[A-Za-z]:/i, '疑似磁盘格式化操作'],
  [/\bshutdown\s+\/[sr]\b/i, '疑似关机/重启操作'],
]

/** 常见参数别名：模型有时用 path/text/cmd 等写法，执行前归一为 schema 的规范名。 */
const PARAM_ALIASES: Record<string, readonly string[]> = {
  file_path: ['file_path', 'filepath', 'filePath', 'file', 'path', 'filename', 'target', 'target_path'],
  content: ['content', 'contents', 'text', 'code', 'body', 'data', 'source'],
  command: ['command', 'cmd', 'script', 'shell', 'command_line'],
  description: ['description', 'desc', 'summary', 'reason', 'note', 'purpose'],
  pattern: ['pattern', 'glob', 'glob_pattern', 'query'],
  old_str: ['old_str', 'old_string', 'old', 'oldText'],
  new_str: ['new_str', 'new_string', 'new', 'newText'],
}

/** 按 schema 必填名做别名替换，返回修复后的参数对象。 */
function repairParams(
  params: Record<string, unknown>,
  schema: ToolSchema,
): Record<string, unknown> {
  const required = Array.isArray(schema.parameters?.required)
    ? schema.parameters.required.filter((item): item is string => typeof item === 'string')
    : []
  const repaired: Record<string, unknown> = { ...params }
  for (const name of required) {
    if (name in repaired) continue
    for (const alias of PARAM_ALIASES[name] ?? [name]) {
      if (alias === name || !(alias in repaired)) continue
      repaired[name] = repaired[alias]
      delete repaired[alias]
      break
    }
  }
  return repaired
}

/**
 * 参数别名修复 + 校验。返回可直接执行的动作列表与剩余问题。
 */
export function repairAndValidateActions(
  actions: readonly WebToolAction[],
  allowedToolNames: ReadonlySet<string>,
  toolSchemas?: ReadonlyMap<string, ToolSchema>,
): { actions: WebToolAction[]; problems: ActionProblem[] } {
  const repairedActions = actions.map((action) => {
    const tool = action.tool ?? action.action
    const schema = tool ? toolSchemas?.get(tool) : undefined
    const params = action.params ?? action.arguments
    if (!schema || !params || typeof params !== 'object' || Array.isArray(params)) return action
    return {
      ...action,
      params: repairParams(params as Record<string, unknown>, schema),
    }
  })
  return { actions: repairedActions, problems: validateActions(repairedActions, allowedToolNames, toolSchemas) }
}

/**
 * 执行前的确定性审查：工具必须在本轮可见清单里、参数必须是对象、
 * 明显破坏性的命令直接拒绝。返回空数组表示通过。
 */
export function validateActions(
  actions: readonly WebToolAction[],
  allowedToolNames: ReadonlySet<string>,
  toolSchemas?: ReadonlyMap<string, ToolSchema>,
): ActionProblem[] {
  const problems: ActionProblem[] = []
  actions.forEach((action, index) => {
    const tool = action.tool ?? action.action
    if (!tool) {
      problems.push({ index, problem: '缺少 tool 字段' })
      return
    }
    if (!allowedToolNames.has(tool)) {
      problems.push({ index, tool, problem: `工具 "${tool}" 不在本轮可用工具清单中` })
    }
    const params = action.params ?? action.arguments
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
      problems.push({ index, tool, problem: 'arguments 必须是 JSON 对象' })
      return
    }
    const schema = tool ? toolSchemas?.get(tool) : undefined
    if (schema) {
      const parameters = schema.parameters ?? {}
      const required = Array.isArray(parameters.required)
        ? parameters.required.filter((item): item is string => typeof item === 'string')
        : []
      const present = (params ?? {}) as Record<string, unknown>
      const missing = required.filter(name => !(name in present))
      if (missing.length > 0) {
        problems.push({
          index,
          tool,
          problem: `缺少必填参数 ${missing.map(name => `"${name}"`).join('、')}`,
        })
      }
      const properties = parameters.properties
      if (properties && typeof properties === 'object') {
        for (const [name, rawSpec] of Object.entries(properties as Record<string, unknown>)) {
          if (!(name in present)) continue
          const expected = rawSpec && typeof rawSpec === 'object'
            ? (rawSpec as { type?: unknown }).type
            : undefined
          if (typeof expected !== 'string') continue
          const value = present[name]
          const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
          const accepted = expected === 'integer'
            ? actual === 'number' && Number.isInteger(value)
            : actual === expected
          if (!accepted) {
            problems.push({ index, tool, problem: `参数 "${name}" 类型应为 ${expected}，实际是 ${actual}` })
          }
        }
      }
    }
    const text = JSON.stringify(params ?? {})
    for (const [pattern, reason] of DESTRUCTIVE_COMMAND_PATTERNS) {
      if (pattern.test(text)) {
        problems.push({ index, tool, problem: reason })
        break
      }
    }
  })
  return problems
}

/** 病态输入下最多尝试的候选起点数（前 N + 后 N），防止退化成 O(n²)。 */
const MAX_JSON_STARTS = 32

/**
 * 字符串感知的括号配对：从 `start` 的开括号扫到配对的闭括号，返回闭括号下标。
 * 只统计目标括号对，字符串里的括号一律跳过；截断或不配对返回 -1。
 */
function matchBalanced(text: string, start: number, open: '{' | '[', close: '}' | ']'): number {
  if (text[start] !== open) return -1
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 剥掉 ```json ... ``` 以及模型可能带上的前后缀，找到最靠前的可解析 JSON 对象。 */
export function extractJsonObject(text: string): unknown | undefined {
  let candidate = text.trim()
  // 去掉整体围栏
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i)
  if (fenced) candidate = fenced[1]!.trim()

  // 收集所有 `{` 起点；数量过多时只取首尾两批（工具调用通常在开头或末尾）。
  // 旧实现对每个起点都重扫到文本结尾，正文含大量未闭合 `{` 时会退化成 O(n²)。
  if (!candidate.includes('}')) return undefined
  const starts: number[] = []
  for (let i = candidate.indexOf('{'); i >= 0; i = candidate.indexOf('{', i + 1)) starts.push(i)
  if (starts.length === 0) return undefined
  const ordered =
    starts.length <= MAX_JSON_STARTS * 2
      ? starts
      : [...new Set([...starts.slice(0, MAX_JSON_STARTS), ...starts.slice(-MAX_JSON_STARTS)])]

  // 每个起点都从括号/字符串的干净状态起算，保证与旧实现同语义（孤立引号不会污染后续候选）。
  for (const start of ordered) {
    const end = matchBalanced(candidate, start, '{', '}')
    if (end < 0) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      continue
    }
  }
  return undefined
}

function normalizeParams(action: WebToolAction): Record<string, unknown> {
  const params = action.params ?? action.arguments ?? {}
  // 保留非法类型，交由校验拒绝，不能伪装成合法对象。
  return params as Record<string, unknown>
}

/** DeepSeek 偶发忽略 JSON 协议，返回原生 DSML；必须完整匹配，禁止执行半截调用。 */
function parseDsml(text: string): WebToolAction[] | undefined {
  const candidate = text.replace(/^```(?:xml|dsml)?\s*([\s\S]*?)```$/i, '$1').trim()
  const calls = candidate.match(/^<｜｜DSML｜｜\s+calls>\s*([\s\S]*?)\s*<\/｜｜DSML｜｜\s+calls>$/)
  if (!calls) return undefined
  let rest = calls[1]!.trim()
  const actions: WebToolAction[] = []
  while (rest) {
    const invoke = rest.match(/^<｜｜DSML｜｜\s+invoke\s+name="([^"]+)">\s*([\s\S]*?)<\/｜｜DSML｜｜\s+invoke>/)
    if (!invoke) return undefined
    let parameters = invoke[2]!.trim()
    const params: Record<string, unknown> = Object.create(null)
    while (parameters) {
      const parameter = parameters.match(/^<｜｜DSML｜｜\s+parameter\s+name="([^"]+)"\s+string="(true|false)">([\s\S]*?)<\/｜｜DSML｜｜\s+parameter>/)
      if (!parameter || Object.hasOwn(params, parameter[1]!)) return undefined
      try {
        params[parameter[1]!] = parameter[2] === 'true' ? parameter[3]! : JSON.parse(parameter[3]!)
      } catch { return undefined }
      parameters = parameters.slice(parameter[0].length).trim()
    }
    actions.push({ tool: invoke[1]!, params })
    rest = rest.slice(invoke[0].length).trim()
  }
  return actions.length ? actions : undefined
}

/**
 * 模型偶尔改用 XML 标签包一个 OpenAI 风格调用：
 * `<tool_call>{"name":"read","arguments":{...}}</tool_call>`。
 *
 * 只认「整条回复就是这一个调用块」：同名标签夹在散文中间时通常是示例代码，
 * 误执行比不执行更糟。标签内 JSON 必须自带工具名，参数可缺省。
 */
const XML_TOOL_CALL_TAGS = ['tool_calls', 'tool_call', 'function_calls', 'function_call'] as const

function xmlPayloadToActions(payload: unknown): WebToolAction[] | undefined {
  const items = Array.isArray(payload) ? payload : [payload]
  const actions: WebToolAction[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined
    const obj = item as Record<string, unknown>
    const name = typeof obj.name === 'string' && obj.name.trim()
      ? obj.name.trim()
      : typeof obj.tool === 'string' && obj.tool.trim() ? obj.tool.trim() : undefined
    if (!name) return undefined
    let rawParams: unknown = obj.arguments ?? obj.params ?? obj.parameters ?? {}
    // OpenAI 的 arguments 常是「JSON 字符串」而不是对象。
    if (typeof rawParams === 'string') {
      try {
        rawParams = JSON.parse(rawParams) as unknown
      } catch {
        return undefined
      }
    }
    if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) return undefined
    actions.push({ tool: name, params: rawParams as Record<string, unknown> })
  }
  return actions.length > 0 ? actions : undefined
}

function parseXmlToolCall(text: string): WebToolAction[] | undefined {
  const candidate = text.replace(/^```(?:xml|json)?\s*([\s\S]*?)```$/i, '$1').trim()
  for (const tag of XML_TOOL_CALL_TAGS) {
    const matched = candidate.match(
      new RegExp(`^<\\s*${tag}\\s*>\\s*([\\s\\S]*?)\\s*<\\s*/\\s*${tag}\\s*>$`, 'i'),
    )
    if (!matched) continue
    let payload: unknown
    try {
      payload = JSON.parse(matched[1]!)
    } catch {
      return undefined
    }
    return xmlPayloadToActions(payload)
  }
  return undefined
}

/** 围栏块；`atTail` 表示这段围栏后面已经没有正文，可用于区分“末尾工具信封”与文档示例。 */
interface FencedBlock {
  content: string
  atTail: boolean
}

/**
 * 按行切围栏块。
 *
 * 不能用「``` 到 ```」的非贪婪正则：正文里常出现行内反引号（例如「末尾多带了
 * 围栏符号 ```，去掉后…」），正则会把它当成开栏，后面的真围栏整体错位
 * （2026-10-25 会话 session-a8a05f7a 的真实样本，动作信封因此漏判）。
 *
 * `atTail` 表示这段围栏之后再没有正文，用来区分「末尾工具信封」与文档示例。
 * 未闭合的围栏按“延伸到结尾”处理，坏信封才可能被判成“想调工具”。
 */
function fencedBlocks(text: string): FencedBlock[] {
  const lines = text.split(/\r?\n/)
  const blocks: FencedBlock[] = []
  let openAt: number | undefined
  let contentFrom = 0
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*```/.test(lines[index]!)) continue
    if (openAt === undefined) {
      openAt = index
      contentFrom = index + 1
      continue
    }
    const atTail = lines.slice(index + 1).join('\n').trim() === ''
    blocks.push({ content: lines.slice(contentFrom, index).join('\n'), atTail })
    openAt = undefined
  }
  if (openAt !== undefined) {
    blocks.push({ content: lines.slice(contentFrom).join('\n'), atTail: true })
  }
  return blocks
}

/** 回复（或围栏内容）开头是否直接就是动作信封。 */
function startsWithActionEnvelope(text: string): boolean {
  return /^\{\s*["']?(?:actions|action|tool)["']?\s*:/i.test(text.trim())
}

/** 文本里出现的动作工具名，用来判断信封指向的是不是本轮真实工具。 */
function actionNamesIn(text: string): string[] {
  const names: string[] = []
  const re = /["'](?:tool|action)["']\s*:\s*["']([^"'\\]+)["']/g
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const name = match[1]!.trim()
    if (name) names.push(name)
  }
  return names
}

const ACTIONS_KEY = /["']actions["']\s*:\s*\[/i
const NEXT_ACTION = /{\s*["'](?:tool|action)["']\s*:\s*["']/g
const ARGUMENTS_KEY = /["'](?:arguments|params)["']\s*:\s*\{/g

/** JSON 合法转义字符；其余转义（典型是 Windows 路径里的 `\d`）视为模型漏写反斜杠。 */
const VALID_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'])

/**
 * 保守修复模型写坏的 JSON 字面量：只动字符串内部，不改结构、不改值。
 * - 字符串里的裸换行 / 回车 / 制表符 → 转义；
 * - 非法转义（`\d`、`\P`…）→ 补一个反斜杠。
 *
 * 修不好时由调用方按“坏信封”处理（纠错或报错），绝不把半截动作拿去执行。
 */
export function repairJsonEscapes(text: string): string {
  let out = ''
  let inString = false
  let escape = false
  for (const ch of text) {
    if (inString) {
      if (escape) {
        if (VALID_JSON_ESCAPES.has(ch)) {
          out += ch
        } else {
          out += `\\${ch}`
        }
        escape = false
        continue
      }
      if (ch === '\\') {
        out += ch
        escape = true
        continue
      }
      if (ch === '"') {
        out += ch
        inString = false
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') {
        out += '\\r'
        continue
      }
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') {
      out += ch
      inString = true
      continue
    }
    out += ch
  }
  return out
}

/**
 * 按结构逐条还原 `{"actions":[ ... ]}` 里的动作，不要求外层信封是合法 JSON。
 *
 * 模型偶尔少写一个右花括号（2026-10-25 真实样本），严格解析会失败；但每个动作的
 * `arguments` 对象本身是完整的，可以单独取出并 `JSON.parse`。这里只认**末尾信封**，
 * 且要求每个工具名都在本轮清单内、每个参数都能解析；任一动作不可信就整体放弃——
 * 半个计划执行比不执行更危险。
 */
export function salvageToolEnvelope(
  text: string,
  allowedToolNames: ReadonlySet<string>,
): WebToolAction[] | undefined {
  const trimmed = text.trim()
  const blocks = [
    ...fencedBlocks(text).filter(block => block.atTail).map(block => block.content),
    ...(trimmed.startsWith('{') ? [trimmed] : []),
  ]
  for (const block of blocks) {
    const actions = scanActionArray(block, allowedToolNames)
    if (actions) return actions
  }
  return undefined
}

function scanActionArray(block: string, allowedToolNames: ReadonlySet<string>): WebToolAction[] | undefined {
  const head = ACTIONS_KEY.exec(block)
  if (!head) return undefined
  const arrayStart = head.index + head[0].length - 1
  const arrayEnd = matchBalanced(block, arrayStart, '[', ']')
  // 数组没闭合说明回复被截断，剩余动作数量未知：不抢救，交给纠错。
  if (arrayEnd < 0) return undefined
  const limit = arrayEnd

  const actions: WebToolAction[] = []
  let cursor = arrayStart + 1
  while (cursor < limit) {
    NEXT_ACTION.lastIndex = cursor
    const next = NEXT_ACTION.exec(block)
    if (!next || next.index >= limit) break
    const actionStart = next.index
    const name = /^{\s*["'](?:tool|action)["']\s*:\s*["']([^"'\\]+)["']/
      .exec(block.slice(actionStart, actionStart + 200))?.[1]?.trim()
    if (!name || !allowedToolNames.has(name)) return undefined

    ARGUMENTS_KEY.lastIndex = actionStart
    const argsMatch = ARGUMENTS_KEY.exec(block)
    if (!argsMatch || argsMatch.index >= limit) return undefined
    // arguments 必须属于当前动作，不能抢下一个动作的参数。
    NEXT_ACTION.lastIndex = actionStart + 1
    const following = NEXT_ACTION.exec(block)
    if (following && following.index < argsMatch.index) return undefined

    const argsStart = argsMatch.index + argsMatch[0].length - 1
    const argsEnd = matchBalanced(block, argsStart, '{', '}')
    if (argsEnd < 0 || argsEnd > limit) return undefined
    let params: unknown
    const rawArgs = block.slice(argsStart, argsEnd + 1)
    try {
      params = JSON.parse(rawArgs)
    } catch {
      // 模型偶尔把 Windows 路径写成 `D:\dsh`（`\d` 不是合法转义）或塞入裸换行：
      // 只修转义再试一次，仍失败就整体放弃，交给纠错。
      try {
        params = JSON.parse(repairJsonEscapes(rawArgs))
      } catch {
        return undefined
      }
    }
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined
    actions.push({ tool: name, params: params as Record<string, unknown> })
    cursor = argsEnd + 1
  }
  return actions.length > 0 ? actions : undefined
}

export function parseWebReply(
  text: string,
  options: { allowedToolNames?: ReadonlySet<string> } = {},
): ParsedWebReply {
  const trimmed = text.trim()
  // 严格解析失败后的统一出口：能结构抢救就抢救，否则按“无动作”返回。
  const unresolved = (): ParsedWebReply => {
    const allowed = options.allowedToolNames
    const salvaged = allowed ? salvageToolEnvelope(trimmed, allowed) : undefined
    if (salvaged) {
      return {
        hasActions: true,
        actions: salvaged.map(action => ({ ...action, params: normalizeParams(action) })),
        text: trimmed,
      }
    }
    return { hasActions: false, actions: [], text: trimmed }
  }
  if (/<\/?[｜|]{2}DSML[｜|]{2}/.test(trimmed)) {
    const actions = parseDsml(trimmed)
    // DSML 中的 JSON 参数不能被误解析成另一个顶层动作。
    return { hasActions: !!actions, actions: actions ?? [], text: trimmed }
  }
  const xmlActions = parseXmlToolCall(trimmed)
  if (xmlActions) {
    return {
      hasActions: true,
      actions: xmlActions.map(action => ({ ...action, params: normalizeParams(action) })),
      text: trimmed,
    }
  }
  const parsed = extractJsonObject(trimmed)
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    const rawActions = obj.actions ?? obj.action
    const actions: WebToolAction[] = []
    if (Array.isArray(rawActions)) {
      for (const item of rawActions) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          return unresolved()
        }
        actions.push(item as WebToolAction)
      }
    } else if (typeof rawActions === 'object' && rawActions !== null) {
      actions.push(rawActions as WebToolAction)
    }
    if (actions.length > 0) {
      return {
        hasActions: true,
        actions: actions.map(a => ({
          ...a,
          tool: a.tool ?? a.action,
          params: normalizeParams(a),
        })),
        text: trimmed,
      }
    }
    // 文本明确是动作信封但外层没解析出来时，内层对象不能冒充单动作执行。
    if (/["']actions["']\s*:/.test(trimmed)) return unresolved()
    // 兼容 {"action": "read_file", "params": {...}} 的单动作形态
    if (typeof obj.action === 'string' || typeof obj.tool === 'string') {
      const single = obj as unknown as WebToolAction
      return {
        hasActions: true,
        actions: [{ ...single, tool: single.tool ?? single.action, params: normalizeParams(single) }],
        text: trimmed,
      }
    }
  }
  return unresolved()
}

/**
 * 判断一段“没有解析出动作”的回复是否明显是想调用工具但格式坏了：
 * 空回复、动作信封（含散文前缀 + 围栏）、原生 DSML 标签。
 *
 * 传入本轮工具清单时，围栏信封里至少要有一个工具名在清单内才算“想调工具”，
 * 避免把文档里的动作示例误判成工具调用。
 */
export function looksLikeIntendedToolReply(
  text: string,
  allowedToolNames?: ReadonlySet<string>,
): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  if (/<\/?[｜|]{2}DSML[｜|]{2}/.test(trimmed)) return true
  // 标签形态能解析时 parseWebReply 已经接手；走到这里说明标签内 JSON 坏了，
  // 此时必须纠错——否则一坨 <tool_call> 会被当成最终回答交给用户。
  if (/<\s*\/?\s*(?:tool_calls?|function_calls?|invoke)\b/i.test(trimmed)) return true
  // 整条回复就是动作信封。
  if (startsWithActionEnvelope(trimmed)) return true
  // 散文 + ```json 围栏 + 信封：网页模型最常见的补刀形态。
  // 空 actions / 只有示例字段的围栏不算调用（文档示例），必须至少出现一个工具名。
  for (const block of fencedBlocks(trimmed)) {
    if (!startsWithActionEnvelope(block.content)) continue
    const names = actionNamesIn(block.content)
    if (names.length === 0) continue
    if (!allowedToolNames || names.some(name => allowedToolNames.has(name))) return true
  }
  return false
}

/** 模型明明有工具可用，却声称“没有工具/无法访问本地”时视为拒绝型漂移。 */
export function looksLikeToolDenial(text: string): boolean {
  return /无法访问|不能访问|无权访问|无法读取|没有(?:任何)?(?:本地)?(?:文件)?工具|工具(?:不可用|不存在)|没有实际工具|I (?:can't|cannot|do not|don't) (?:access|read)|no (?:local )?(?:file )?access|no tools (?:available|provided)/i.test(text)
}

/** 模型反问“请提供任务”时视为会话上下文丢失，需要一次性恢复协议与任务锚点。 */
export function looksLikeTaskRequest(text: string): boolean {
  return /请(?:提供|告诉|说明|发送|描述).{0,12}(?:任务|需求|要求|要做什么)|没有(?:收到|看到|收到具体的).{0,8}任务|未(?:提供|收到).{0,8}任务|what (?:task|would you like|do you want)|provide .{0,20}task|please (?:tell|provide|send).{0,20}task/i.test(text)
}

/**
 * 把解析结果转成 Harness StreamChunk 序列。
 * 顺序：文本块 → 若干 tool-call 块 → finish。
 *
 * `startIndex` 是本条助手消息内第一个空闲内容块序号：同一消息里若已经
 * 流式输出过 reasoning（实时思考流）块，正文块要从更高的序号开始，
 * 避免与已有块冲突。
 *
 * `callIdPrefix` 决定工具调用 id 的前缀。DSH 的会话节点键是
 * `conversationContextKey('tool-call', id)`（只含 kind + id，见
 * dsh-client-ui-conversation/lib/client.js:1745/2871），所以 id 必须
 * **跨消息唯一**：每条消息都从 `web-1` 重新计数，会让后发生的调用复用前面
 * 那张卡——表现为乱序、或前面的卡片被覆盖消失（2026-10-25 实测：本机 8 天
 * 3203 次网页工具调用里有 2518 次 id 重复）。默认生成一次性前缀，测试可固定。
 */
export function* replyChunks(
  reply: ParsedWebReply,
  options: { startIndex?: number; nextCallId?: number; callIdPrefix?: string } = {},
): Generator<StreamChunk> {
  const startIndex = options.startIndex ?? 0
  let nextCallId = options.nextCallId ?? 1
  const callIdPrefix = options.callIdPrefix
    ?? `web-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const blocks: ContentBlock[] = []
  let textBlock: ContentBlock | undefined
  if (!reply.hasActions && reply.text.length > 0) {
    textBlock = { type: 'text', text: reply.text }
    blocks.push(textBlock)
  }

  let index = startIndex
  if (textBlock) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text: reply.text }
    yield { type: 'block-end', index, block: textBlock }
    index++
  }

  const toolCalls: ContentBlock[] = []
  for (const action of reply.actions) {
    if (!action.tool) continue
    // ToolCallId is a branded string at type level; no runtime wrapper is needed.
    const id = `${callIdPrefix}-${nextCallId++}` as ToolCallId
    const argumentsJson = JSON.stringify(action.params ?? {})
    const block: ContentBlock = { type: 'tool-call', id, name: action.tool, arguments: argumentsJson }
    toolCalls.push(block)
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta',
      index,
      id,
      name: action.tool,
      argumentsDelta: argumentsJson,
    }
    yield { type: 'block-end', index, block }
    index++
  }

  if (reply.hasActions && toolCalls.length > 0) {
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } else if (textBlock) {
    yield { type: 'finish', reason: { kind: 'stop' } }
  } else if (reply.hasActions) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: '模型请求了工具但缺少可识别的工具名',
          code: 'MALFORMED_TOOL_CALL',
        },
      },
    }
  } else {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
