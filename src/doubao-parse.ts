/**
 * 豆包网页版（doubao.com/chat）SSE 解析器。
 *
 * 只做纯文本解析，不碰浏览器：输入是 `/chat/completion` 的完整响应体，
 * 输出正文、思考、结束原因、会话 id 与服务端回执的模式字段。
 *
 * 实测样本（2026-10-26，豆包 3.42.5）：
 * - `CHUNK_DELTA` 携带 `{"text":"..."}` 增量正文；
 * - `STREAM_MSG_NOTIFY` 的 `content.content_block[].content.text_block.text`
 *   是首包正文（短回复只有这一条通道）；
 * - `STREAM_CHUNK` 的 `patch_op[].patch_value.content_block[]` 继续补正文；
 *   `patch_object=111` 是 TTS 镜像，必须忽略，否则正文会重复；
 * - `block_type=10000` 是正文，`10040` 是思考；
 * - `SSE_REPLY_END` 的 `end_type=1/2` 表示消息/回答结束，`3` 是建议列表结束。
 *
 * 字符串编码：豆包 SSE 里的中文是「CP1252 视角的 UTF-8 字节」，
 * 直接按 UTF-8 读会得到 `ä½ å¥½` 一类乱码；`decodeDoubaoCp1252()` 负责反解。
 *
 * @module dsh-deepseek-web/doubao-parse
 */

/** 豆包对话完成接口的 URL 判定。 */
export function matchesDoubaoCompletion(url: string): boolean {
  return /\/chat\/completion(?:[?#]|$)/i.test(url)
}

/**
 * 把 HTTP/JSON 响应映射成稳定的错误码。
 *
 * 豆包登录过期/频控不一定走 SSE：实测可能是 `application/json` 的 401/429
 * 或 200 + `{"code":710012001,"msg":"登录已过期"}`。先按状态码判，再看 body 文案，
 * 避免把明确的登录/频控错误拖成首响应超时。
 */
export function classifyDoubaoResponse(
  status: number,
  contentType: string,
  body: string,
): { code: string; message: string } | undefined {
  const text = body.slice(0, 500)
  const login = (): { code: string; message: string } => ({
    code: 'DOUBAO_LOGIN_REQUIRED',
    message: '豆包登录态已过期，请重新登录。',
  })
  const rate = (): { code: string; message: string } => ({
    code: 'WEB_RATE_LIMITED',
    message: '豆包触发频控，请稍后再试。',
  })
  if (status === 401 || status === 403) return login()
  if (status === 429) return rate()
  if (status !== 200) {
    if (/710012001|登录|login/i.test(text)) return login()
    if (/过于频繁|太频繁|稍后再试|rate/i.test(text)) return rate()
    return { code: 'DOUBAO_HTTP_ERROR', message: `豆包返回 HTTP ${status}，请稍后重试。` }
  }
  if (!/event-stream/i.test(contentType)) {
    if (/710012001|登录|login/i.test(text)) return login()
    if (/过于频繁|太频繁|稍后再试|rate/i.test(text)) return rate()
    return { code: 'DOUBAO_HTTP_ERROR', message: '豆包返回了非流式响应，无法解析。' }
  }
  return undefined
}

/** CP1252 的 0x80–0x9F 区间到字节的反查表（Node 的 latin1 不认这些字符）。 */
const CP1252_TO_BYTE: Readonly<Record<number, number>> = {
  0x20AC: 0x80,
  0x201A: 0x82,
  0x0192: 0x83,
  0x201E: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02C6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8A,
  0x2039: 0x8B,
  0x0152: 0x8C,
  0x017D: 0x8E,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201C: 0x93,
  0x201D: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02DC: 0x98,
  0x2122: 0x99,
  0x0161: 0x9A,
  0x203A: 0x9B,
  0x0153: 0x9C,
  0x017E: 0x9E,
  0x0178: 0x9F,
}

/**
 * 把豆包 SSE 的 CP1252 字符串还原成正常 UTF-8。
 *
 * 已经是正常文本（中文/英文）的字符串不满足特征，原样返回；
 * 反解出现 U+FFFD 时也原样返回，避免把真实内容弄坏。
 */
export function decodeDoubaoCp1252(value: string): string {
  if (!/[\u0080-\u00FF\u0152-\u0178\u2013-\u203A\u20AC\u2122]/u.test(value)) return value
  const bytes: number[] = []
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    bytes.push(CP1252_TO_BYTE[code] ?? (code < 256 ? code : 0x3F))
  }
  const decoded = Buffer.from(bytes).toString('utf8')
  return decoded.includes('\uFFFD') ? value : decoded
}

export interface DoubaoCompletionMode {
  /** 0 = 快速，3 = 专家（实测值；其它值按原样保留）。 */
  modelItemKey?: string
  /** 0 = 快速，3 = 专家。 */
  replyMode?: string
  modeId?: string
  reasoningEffort?: string
}

export interface DoubaoCompletion {
  /** 模型可见正文（不含思考）。 */
  text: string
  /** 思考过程（block_type=10040）。 */
  reasoning?: string
  /** 结束原因；没有看到结束哨兵时按 interrupted 处理。 */
  finishReason: 'stop' | 'max-tokens' | 'interrupted'
  /** 网页端会话 id（SSE_ACK 回执）。 */
  conversationId?: string
  /** 网页端 section id（SSE_ACK 回执）。 */
  sectionId?: string
  /** 服务端回执的模式字段；仅作诊断，不用于拦截回合。 */
  mode?: DoubaoCompletionMode
  /** 服务端明确返回的错误。 */
  error?: { code: string; message: string }
  /** 网页提示对话长度达到上限。 */
  contextLengthExceeded?: boolean
  /** 是否看到 SSE_REPLY_END(end_type=1/2)。 */
  ended: boolean
}

interface ParsedBlock {
  event: string
  data: string
}

/** 把 SSE 文本切成事件块；容忍 \r\n 与 `data:` 后的单个空格。 */
function splitSseBlocks(raw: string): ParsedBlock[] {
  const normalized = raw.replace(/\r\n/g, '\n')
  const blocks: ParsedBlock[] = []
  for (const chunk of normalized.split('\n\n')) {
    if (!chunk.trim()) continue
    let event = ''
    const dataLines: string[] = []
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (dataLines.length > 0) blocks.push({ event, data: dataLines.join('\n') })
  }
  return blocks
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 解析 `conversation_info.extra`（JSON 字符串）里的模式字段。 */
function parseMode(extra: unknown): DoubaoCompletionMode | undefined {
  const raw = asString(extra)
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeDoubaoCp1252(raw))
  } catch {
    return undefined
  }
  const record = asRecord(parsed)
  if (!record) return undefined
  const mode: DoubaoCompletionMode = {
    ...asString(record.model_item_key) !== undefined ? { modelItemKey: asString(record.model_item_key) } : {},
    ...asString(record.reply_mode) !== undefined ? { replyMode: asString(record.reply_mode) } : {},
    ...asString(record.mode_id) !== undefined ? { modeId: asString(record.mode_id) } : {},
    ...asString(record.reasoning_effort) !== undefined ? { reasoningEffort: asString(record.reasoning_effort) } : {},
  }
  return Object.keys(mode).length > 0 ? mode : undefined
}

/** 正文/思考文本块的合并器：豆包 3.42.5 的块更新是增量片段，直接追加。 */
class TextAccumulator {
  private readonly parts: string[] = []

  /** 追加 `text_block.text` 形式的块更新（增量片段，不能按累计快照去重）。 */
  appendBlock(raw: string, _blockId = ''): void {
    const decoded = decodeDoubaoCp1252(raw)
    if (decoded) this.parts.push(decoded)
  }

  /** 追加 `CHUNK_DELTA.text` 形式的增量。 */
  appendDelta(raw: string): void {
    this.parts.push(decodeDoubaoCp1252(raw))
  }

  get text(): string {
    return this.parts.join('')
  }
}

/**
 * 解析豆包 `/chat/completion` 的完整 SSE 响应体。
 *
 * 纯函数，不依赖浏览器；对未知事件与不可解析的 JSON 静默跳过，
 * 由调用方根据 `text`/`ended` 判断是否为空响应。
 */
export function parseDoubaoCompletion(input: Buffer | string): DoubaoCompletion {
  const raw = Buffer.isBuffer(input) ? input.toString('utf8') : input
  const text = new TextAccumulator()
  const reasoning = new TextAccumulator()
  let conversationId: string | undefined
  let sectionId: string | undefined
  let mode: DoubaoCompletionMode | undefined
  let error: { code: string; message: string } | undefined
  let ended = false

  for (const block of splitSseBlocks(raw)) {
    let obj: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(block.data)
      const record = asRecord(parsed)
      if (!record) continue
      obj = record
    } catch {
      continue
    }

    // 网关级错误（事件名带连字符，不是 JSON 里的 error_code）
    if (block.event === 'gateway-error') {
      error = {
        code: String(obj.code ?? 'GATEWAY_ERROR'),
        message: String(obj.message ?? block.data).slice(0, 500),
      }
      continue
    }

    if (block.event === 'SSE_ACK') {
      const ack = asRecord(obj.ack_client_meta)
      conversationId = asString(ack?.conversation_id) ?? conversationId
      sectionId = asString(ack?.section_id) ?? sectionId
      const info = asRecord(ack?.conversation_info)
      mode = parseMode(info?.extra) ?? mode
      continue
    }

    if (block.event === 'SSE_REPLY_END') {
      const endType = Number(obj.end_type)
      if (endType === 1 || endType === 2) ended = true
      continue
    }

    if (block.event === 'STREAM_ERROR' || obj.error_code !== undefined) {
      const code = String(obj.error_code ?? obj.code ?? 'STREAM_ERROR')
      const message = String(obj.error_msg ?? obj.message ?? block.data).slice(0, 500)
      if (code && code !== '0' && code !== 'undefined') error = { code, message }
      continue
    }

    if (block.event === 'CHUNK_DELTA') {
      const value = asString(obj.text)
      if (value) text.appendDelta(value)
      continue
    }

    if (block.event === 'STREAM_MSG_NOTIFY') {
      const content = asRecord(obj.content)
      const blocks = Array.isArray(content?.content_block) ? content.content_block : []
      collectBlocks(blocks, text, reasoning)
      continue
    }

    if (block.event === 'STREAM_CHUNK') {
      const patches = Array.isArray(obj.patch_op) ? obj.patch_op : []
      for (const patch of patches) {
        const record = asRecord(patch)
        // 111 = TTS 镜像；跟着它解析会把正文重复一遍。
        if (Number(record?.patch_object) === 111) continue
        const value = asRecord(record?.patch_value)
        const blocks = Array.isArray(value?.content_block) ? value.content_block : []
        collectBlocks(blocks, text, reasoning)
        const rawContent = asString(value?.content)
        if (rawContent) {
          try {
            const parsed: unknown = JSON.parse(rawContent)
            const contentObj = asRecord(parsed)
            const delta = asString(contentObj?.text)
            if (delta) text.appendDelta(delta)
          } catch {
            // 非 JSON 的 content 不是正文通道，忽略。
          }
        }
      }
    }
  }

  const lowerMessage = error?.message.toLowerCase() ?? ''
  const contextLengthExceeded = /上下文|长度|过长|context|too long|context_length/i.test(lowerMessage)

  return {
    text: text.text,
    ...reasoning.text ? { reasoning: reasoning.text } : {},
    finishReason: error ? 'interrupted' : ended ? 'stop' : 'interrupted',
    ...conversationId ? { conversationId } : {},
    ...sectionId ? { sectionId } : {},
    ...mode ? { mode } : {},
    ...error ? { error } : {},
    ...contextLengthExceeded ? { contextLengthExceeded: true } : {},
    ended,
  }
}

/** 处理 content_block 数组里的正文/思考块。 */
function collectBlocks(blocks: unknown[], text: TextAccumulator, reasoning: TextAccumulator): void {
  for (const item of blocks) {
    const block = asRecord(item)
    if (!block) continue
    const blockType = Number(block.block_type)
    const blockId = asString(block.block_id) ?? ''
    const content = asRecord(block.content)
    const textValue = asString(asRecord(content?.text_block)?.text)
    if (typeof textValue === 'string' && textValue) {
      if (blockType === 10040) reasoning.appendBlock(textValue, blockId)
      else if (blockType === 10000) text.appendBlock(textValue, blockId)
      continue
    }
    // 少数版本把思考放在 think_block.text
    if (blockType === 10040) {
      const thinkValue = asString(asRecord(content?.think_block)?.text)
      if (thinkValue) reasoning.appendBlock(thinkValue, blockId)
    }
  }
}
