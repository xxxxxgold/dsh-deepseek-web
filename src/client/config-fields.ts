/**
 * 设置面板与插件管理页共用的字段规格。
 *
 * 两处界面（侧栏「设置」里的本插件菜单、插件管理器行上的「配置」页）暴露同一组可写字段，
 * 因此字段清单、分组、读写助手、差量与校验都收在这一个模块里，避免两份清单漂移。
 *
 * 这里的字段都必须在 `src/config.ts` 里标了 `.volatile()`，否则宿主的
 * `settings.describe()` 不会把它们投影进可写命名空间。
 *
 * @module dsh-deepseek-web-littlecar30/client/config-fields
 */

/** 一步路径，对应 Host settings 写入操作的 `path`。 */
export type FieldPath = readonly string[]

/** 控件类型。 */
export type FieldKind = 'boolean' | 'number' | 'text' | 'select' | 'list'

/** 一段中英双语文案。 */
export interface FieldText {
  readonly zh: string
  readonly en: string
}

/** 设置页的分组 id。 */
export type FieldGroupId =
  | 'connection'
  | 'model'
  | 'image'
  | 'review'
  | 'ratelimit'
  | 'tools'
  | 'focus'
  | 'compaction'

/** 设置页的一组字段。 */
export interface FieldGroup {
  readonly id: FieldGroupId
  readonly label: FieldText
  readonly hint: FieldText
}

/** 一个可在设置里编辑的配置字段。 */
export interface FieldSpec {
  /** 相对配置根对象的路径；嵌套段逐级展开。 */
  readonly path: FieldPath
  /** 所属分组。 */
  readonly group: FieldGroupId
  /** 控件类型。 */
  readonly kind: FieldKind
  /** 行标签。 */
  readonly label: FieldText
  /** 补充说明。 */
  readonly hint?: FieldText
  /**
   * 改动只在重启 DSH 后才生效（这些字段由通道构造时一次性读取）。
   * 设置页会为这类字段挂一个「重启生效」徽章，避免用户以为即时生效。
   */
  readonly restart?: boolean
  /** `select` 的可选值（按原样展示配置枚举值）。 */
  readonly options?: readonly string[]
  /** `number` 的上下界。 */
  readonly min?: number
  readonly max?: number
}

/** 设置页分组，顺序即渲染顺序。 */
export const GROUPS: readonly FieldGroup[] = [
  {
    id: 'connection',
    label: { zh: '网页连接', en: 'Web connection' },
    hint: {
      zh: '插件如何打开 DeepSeek 网页版。前两项与 profile 目录在重启 DSH 后生效。',
      en: 'How the plugin opens the DeepSeek web app. The first two and the profile directory apply after a DSH restart.',
    },
  },
  {
    id: 'model',
    label: { zh: '网页模型与发送', en: 'Web model and sending' },
    hint: {
      zh: '网页端模型入口、消息如何发出，以及控制协议怎么注入。',
      en: 'Model entry, how messages leave the page, and how the control protocol is injected.',
    },
  },
  {
    id: 'image',
    label: { zh: '图片直传', en: 'Image upload' },
    hint: { zh: '把图片附件真正上传到网页输入框。', en: 'Upload image attachments into the page composer.' },
  },
  {
    id: 'review',
    label: { zh: '审核通道', en: 'Review channel' },
    hint: {
      zh: '交付前用第二个模型复核结果；关闭后行为与只用 DeepSeek 完全一致。',
      en: 'A second model reviews the result before delivery; disabling it restores plain DeepSeek behavior.',
    },
  },
  {
    id: 'ratelimit',
    label: { zh: '频控自动重发', en: 'Rate-limit retry' },
    hint: {
      zh: '网页提示「发送过于频繁」时等待片刻自动重发同一条消息。',
      en: 'When the page reports rate limiting, wait and resend the same message automatically.',
    },
  },
  {
    id: 'tools',
    label: { zh: '工具与委托', en: 'Tools and delegation' },
    hint: {
      zh: '限制哪些工具能进网页模型，以及哪些能力委托给网页端。',
      en: 'Which tools reach the web model, and which capabilities are delegated to the page.',
    },
  },
  {
    id: 'focus',
    label: { zh: '窗口聚焦', en: 'Window focus' },
    hint: {
      zh: '回合开始与结束时把哪个窗口提到最前。',
      en: 'Which window comes to the front when a turn starts or ends.',
    },
  },
  {
    id: 'compaction',
    label: { zh: '压缩摘要', en: 'Compaction' },
    hint: { zh: '只调整官方压缩模板的摘要语言。', en: 'Only changes the summary language of official compaction prompts.' },
  },
]

/**
 * 可编辑字段集合。
 *
 * 只列真正需要在部署间调整的项；安全不变量（如协议常量）与纯代码常量不在此列。
 * 未在此列出的字段仍可通过 profile 的 `cordis.patch.yml` 覆盖。
 */
export const FIELDS: readonly FieldSpec[] = [
  {
    path: ['url'],
    group: 'connection',
    kind: 'text',
    label: { zh: 'DeepSeek 网页地址', en: 'DeepSeek web address' },
    hint: { zh: '默认 https://chat.deepseek.com。', en: 'Defaults to https://chat.deepseek.com.' },
  },
  {
    path: ['browser'],
    group: 'connection',
    kind: 'select',
    label: { zh: '浏览器连接模式', en: 'Browser mode' },
    options: ['managed', 'attach'],
    restart: true,
    hint: {
      zh: 'managed：插件托管一个带独立 profile 的浏览器窗口；attach：连接已开启 CDP 的浏览器。',
      en: 'managed: the plugin runs its own browser window with a private profile; attach: connect to a browser already started with CDP.',
    },
  },
  {
    path: ['channel'],
    group: 'connection',
    kind: 'select',
    label: { zh: '独立浏览器类型', en: 'Managed browser' },
    options: ['msedge', 'chrome'],
    restart: true,
    hint: { zh: '仅 managed 模式生效，使用已安装的 Edge 或 Chrome。', en: 'managed mode only: the installed Edge or Chrome.' },
  },
  {
    path: ['profileDir'],
    group: 'connection',
    kind: 'text',
    label: { zh: '独立浏览器 profile 目录', en: 'Browser profile directory' },
    restart: true,
    hint: {
      zh: '留空使用 %LOCALAPPDATA%\\DshDeepSeekWeb\\edge-profile。',
      en: 'Empty means %LOCALAPPDATA%\\DshDeepSeekWeb\\edge-profile.',
    },
  },
  {
    path: ['debugPort'],
    group: 'connection',
    kind: 'number',
    label: { zh: 'CDP 调试端口', en: 'CDP debug port' },
    min: 1024,
    max: 65535,
    hint: {
      zh: 'attach 模式连接此端口；managed 模式把它作为首选端口，冲突时自动换空闲端口。',
      en: 'attach mode connects here; managed mode prefers it and falls back to a free port when busy.',
    },
  },

  {
    path: ['model'],
    group: 'model',
    kind: 'select',
    label: { zh: '网页版模型入口', en: 'Web model entry' },
    options: ['deepseek-web', 'deepseek-web-auto'],
    hint: { zh: '供驱动校准网页顶部的模型开关。', en: 'Used to align the model switch at the top of the page.' },
  },
  {
    path: ['sendMode'],
    group: 'model',
    kind: 'select',
    label: { zh: '发送模式', en: 'Send mode' },
    options: ['manual', 'approved'],
    hint: {
      zh: 'manual：填入输入框并聚焦网页窗口，由你点击发送；approved 为预留。',
      en: 'manual: fill the composer and focus the page, you press send; approved is reserved.',
    },
  },
  {
    path: ['liveThinking'],
    group: 'model',
    kind: 'boolean',
    label: { zh: '显示网页思考过程', en: 'Show web reasoning' },
    hint: {
      zh: '开启后展示网页真实思考；不改变网页的思考模式。',
      en: 'Streams the page’s real reasoning; it does not change the page thinking mode.',
    },
  },
  {
    path: ['protocolEveryRequest'],
    group: 'model',
    kind: 'boolean',
    label: { zh: '每轮都注入控制协议', en: 'Inject control protocol every turn' },
    hint: {
      zh: '提示词更长，但网页端行为更稳。',
      en: 'Longer prompts, steadier page-side behavior.',
    },
  },
  {
    path: ['protocolRefreshEvery'],
    group: 'model',
    kind: 'number',
    label: { zh: '协议刷新间隔（轮）', en: 'Protocol refresh interval (turns)' },
    min: 1,
    hint: {
      zh: '未开启「每轮都注入」时，每隔这么多轮重新注入一次协议快照。',
      en: 'When per-turn injection is off, re-inject the protocol snapshot every this many turns.',
    },
  },
  {
    path: ['maxToolResultChars'],
    group: 'model',
    kind: 'number',
    label: { zh: '工具结果输入上限（字符）', en: 'Tool result input limit (characters)' },
    min: 256,
    hint: {
      zh: '只限制送入网页模型的工具结果；最终正文与委托结果完整展示。',
      en: 'Limits only what reaches the web model; final text and delegated output stay complete.',
    },
  },

  {
    path: ['enableImageUpload'],
    group: 'image',
    kind: 'boolean',
    label: { zh: '图片直传', en: 'Upload images' },
    hint: {
      zh: '开启后网页端原生识图；关闭则退回 [附图] 文本标记，模型看不到图片内容。',
      en: 'On: the page sees the image natively. Off: falls back to an [附图] text marker.',
    },
  },
  {
    path: ['maxImagesPerTurn'],
    group: 'image',
    kind: 'number',
    label: { zh: '单轮图片上限（张）', en: 'Images per turn' },
    min: 0,
    max: 32,
    hint: { zh: '0 表示关闭上传。', en: '0 disables uploads.' },
  },
  {
    path: ['uploadTimeoutMs'],
    group: 'image',
    kind: 'number',
    label: { zh: '图片解析超时（毫秒）', en: 'Image parse timeout (ms)' },
    min: 1000,
    hint: {
      zh: '等网页端把图片解析为 SUCCESS 的上限；大图可调大。',
      en: 'How long to wait for the page to parse an image to SUCCESS; raise it for large files.',
    },
  },

  {
    path: ['review', 'enabled'],
    group: 'review',
    kind: 'boolean',
    label: { zh: '启用审核', en: 'Enable review' },
    hint: { zh: '中间工具轮次不审，只在交付前审最终正文。', en: 'Intermediate tool turns are not reviewed; only the final text before delivery.' },
  },
  {
    path: ['review', 'provider'],
    group: 'review',
    kind: 'select',
    label: { zh: '审核器', en: 'Reviewer' },
    options: ['deepseek-web', 'kimi', 'glm'],
    hint: {
      zh: 'kimi / glm 需要对应网页已登录；deepseek-web 在同一对话里自审，更快但独立性弱。',
      en: 'kimi / glm need a signed-in page; deepseek-web self-reviews in the same conversation, faster but less independent.',
    },
  },
  {
    path: ['review', 'maxRounds'],
    group: 'review',
    kind: 'number',
    label: { zh: '单任务审核轮数', en: 'Review rounds per task' },
    min: 0,
    max: 10,
    hint: { zh: '未通过时回注意见修正，最多这么多轮。', en: 'When review fails, send comments back for fixes, up to this many rounds.' },
  },

  {
    path: ['rateLimit', 'enabled'],
    group: 'ratelimit',
    kind: 'boolean',
    label: { zh: '频控自动重发', en: 'Automatic retry' },
    hint: { zh: '关闭后遇到频控会直接报错中断回合。', en: 'Off: rate limiting aborts the turn with an error.' },
  },
  {
    path: ['rateLimit', 'retryDelayMs'],
    group: 'ratelimit',
    kind: 'number',
    label: { zh: '重发等待（毫秒）', en: 'Retry delay (ms)' },
    min: 1000,
  },
  {
    path: ['rateLimit', 'maxRetries'],
    group: 'ratelimit',
    kind: 'number',
    label: { zh: '单轮最大重发次数', en: 'Max retries per turn' },
    min: 0,
    max: 20,
  },

  {
    path: ['toolAllowlist'],
    group: 'tools',
    kind: 'list',
    label: { zh: '工具白名单', en: 'Tool allowlist' },
    hint: {
      zh: '每行一个；支持 mcp__xxx__* 前缀通配。留空表示不限制。',
      en: 'One per line; supports mcp__xxx__* prefix wildcards. Empty means no restriction.',
    },
  },
  {
    path: ['excludeToolNames'],
    group: 'tools',
    kind: 'list',
    label: { zh: '工具排除名单', en: 'Excluded tools' },
    hint: { zh: '每行一个；在白名单之后生效。', en: 'One per line; applied after the allowlist.' },
  },
  {
    path: ['delegatedTools'],
    group: 'tools',
    kind: 'list',
    label: { zh: '委托工具', en: 'Delegated tools' },
    hint: {
      zh: '每行一个；只写进提示词交给网页端自带能力，不在本地执行。',
      en: 'One per line; only written into the prompt for the page’s own abilities, never executed locally.',
    },
  },

  {
    path: ['focus', 'enabled'],
    group: 'focus',
    kind: 'boolean',
    label: { zh: '自动聚焦总开关', en: 'Auto focus' },
  },
  {
    path: ['focus', 'webWindow'],
    group: 'focus',
    kind: 'boolean',
    label: { zh: '填入时聚焦网页窗口', en: 'Focus the web window when filling' },
  },
  {
    path: ['focus', 'dshWindow'],
    group: 'focus',
    kind: 'boolean',
    label: { zh: '回合结束时聚焦 DSH 窗口', en: 'Focus the DSH window when the turn ends' },
  },

  {
    path: ['compactionLanguage'],
    group: 'compaction',
    kind: 'select',
    label: { zh: '压缩摘要语言', en: 'Summary language' },
    options: ['task', 'host', 'zh', 'en'],
    hint: {
      zh: 'task 跟随任务语言；host 保留宿主要求；zh 中文；en 英文。',
      en: 'task follows the task language; host keeps the host request; zh Chinese; en English.',
    },
  },
]

/** 字段在草稿、DOM id 与校验表里的稳定键。 */
export function fieldKey(field: FieldSpec): string {
  return field.path.join('.')
}

/** 生成唯一的 DOM id（同一页面里两组界面不会同时挂载，但 id 仍带前缀）。 */
export function fieldDomId(field: FieldSpec): string {
  return `dsweb-field-${fieldKey(field)}`
}

/** 按路径读取嵌套值；任一段缺失返回 undefined。 */
export function readPath(source: unknown, path: FieldPath): unknown {
  let node: unknown = source
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** 路径在对象里是否真的存在（用于区分「未覆盖」与「覆盖成 null」）。 */
export function hasPath(source: unknown, path: FieldPath): boolean {
  let node: unknown = source
  for (const key of path) {
    if (node === null || typeof node !== 'object') return false
    if (!Object.hasOwn(node as Record<string, unknown>, key)) return false
    node = (node as Record<string, unknown>)[key]
  }
  return true
}

/** 把列表字段的文本解析为数组。 */
export function parseList(raw: string): string[] {
  return raw.split('\n').map(line => line.trim()).filter(Boolean)
}

/** 把列表字段的值格式化为文本。 */
export function formatList(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.filter((item): item is string => typeof item === 'string').join('\n')
}

/** 是否相等（配置值都是 JSON 形状，按序列化比较足够）。 */
export function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

/** 深拷贝 JSON 形状的节点。 */
function cloneNode<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => cloneNode(item)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) out[key] = cloneNode(child)
    return out as T
  }
  return value
}

/** 在草稿上写入一个字段值（逐级复制，不改动 accepted）。 */
export function withEdit(
  draft: Record<string, unknown> | null,
  accepted: Record<string, unknown>,
  path: FieldPath,
  value: unknown,
): Record<string, unknown> {
  const next = cloneNode(draft ?? accepted)
  let node = next
  for (const key of path.slice(0, -1)) {
    const existing = node[key]
    const child = existing !== null && typeof existing === 'object' ? cloneNode(existing as Record<string, unknown>) : {}
    node[key] = child
    node = child as Record<string, unknown>
  }
  node[path[path.length - 1]!] = value
  return next
}

/** 从草稿里删掉一个字段（用于「恢复默认」后不留旧草稿），顺带清掉空对象。 */
export function withoutPath(
  draft: Record<string, unknown> | null,
  path: FieldPath,
): Record<string, unknown> | null {
  if (draft === null) return null
  const next = cloneNode(draft)
  const parents: Record<string, unknown>[] = [next]
  let node: Record<string, unknown> = next
  for (const key of path.slice(0, -1)) {
    const child = node[key]
    if (child === null || typeof child !== 'object') return next
    node = child as Record<string, unknown>
    parents.push(node)
  }
  delete node[path[path.length - 1]!]
  for (let index = parents.length - 1; index > 0; index -= 1) {
    const child = parents[index]
    if (child === undefined || Object.keys(child).length > 0) break
    delete (parents[index - 1] as Record<string, unknown>)[path[index - 1]!]
  }
  return next
}

/** 一条原子写入操作。 */
export type FieldOp =
  | { readonly op: 'set'; readonly path: string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: string[] }

/**
 * 把草稿与宿主当前值做差量。
 *
 * - 草稿里没碰过的字段（`undefined`）不产生操作；
 * - 明确清空的字段（`null`）在「原本由用户覆盖」时产生 `unset`，否则视为无改动；
 * - 其余按值比较，不同才 `set`。
 */
export function diffOps(
  draft: Record<string, unknown> | null,
  accepted: Record<string, unknown>,
  user: Record<string, unknown>,
): FieldOp[] {
  if (draft === null) return []
  const ops: FieldOp[] = []
  for (const field of FIELDS) {
    const next = readPath(draft, field.path)
    if (next === undefined) continue
    if (next === null) {
      if (hasPath(user, field.path)) ops.push({ op: 'unset', path: [...field.path] })
      continue
    }
    if (sameValue(next, readPath(accepted, field.path))) continue
    ops.push({ op: 'set', path: [...field.path], value: next })
  }
  return ops
}

/** 字段校验失败的原因。 */
export type FieldErrorCode = 'number' | 'min' | 'max' | 'option'

/** 校验单个字段的当前值；`null`（已清空）与 `undefined`（未触碰）都视为合法。 */
export function validateField(field: FieldSpec, value: unknown): FieldErrorCode | undefined {
  if (value === undefined || value === null) return undefined
  if (field.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'number'
    if (field.min !== undefined && value < field.min) return 'min'
    if (field.max !== undefined && value > field.max) return 'max'
    return undefined
  }
  if (field.kind === 'select') {
    if (typeof value !== 'string') return 'option'
    if ((field.options ?? []).length > 0 && !(field.options ?? []).includes(value)) return 'option'
    return undefined
  }
  return undefined
}

/** 中文校验错误文案（插件管理器的行配置页是纯中文界面，设置页另有本地化文案）。 */
export function errorMessageZh(field: FieldSpec, code: FieldErrorCode): string {
  switch (code) {
    case 'number':
      return '请填数字。'
    case 'min':
      return `不能小于 ${String(field.min ?? '')}。`
    case 'max':
      return `不能大于 ${String(field.max ?? '')}。`
    case 'option':
      return '请选择列表里的选项。'
    default:
      return ''
  }
}
