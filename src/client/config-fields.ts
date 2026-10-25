/**
 * 设置面板与插件管理页共用的字段规格。
 *
 * 两处界面（侧栏「设置」里的本插件菜单、插件管理器行上的「配置」页）暴露同一组可写字段，
 * 因此字段清单、分组、读写助手、差量与校验都收在这一个模块里，避免两份清单漂移。
 *
 * 这里的字段都必须在 `src/config.ts` 里标了 `.volatile()`，否则宿主的
 * `settings.describe()` 不会把它们投影进可写命名空间。
 *
 * @module dsh-deepseek-web-xxxxxgold/client/config-fields
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
  | 'risk'
  | 'image'
  | 'review'
  | 'ratelimit'
  | 'notify'
  | 'browserrecovery'
  | 'probe'
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
  /**
   * 条件显示规则：满足条件才显示，避免把无关字段摆一屏。
   *
   * 单个对象 = 一条条件；数组 = 必须同时满足（用于「provider 是 kimi、且模式是项目模式」
   * 这类组合，否则同一个地址框会在两种模式下同时出现，用户根本分不清该填哪个）。
   */
  readonly visibleWhen?:
    | { readonly path: FieldPath; readonly equals: string }
    | readonly { readonly path: FieldPath; readonly equals: string }[]
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
    id: 'risk',
    label: { zh: '风控模式', en: 'Risk control' },
    hint: {
      zh: '整体防封档位 + 细粒度参数。一键套用档位会把下面几个值成套写入；选「自定义」才逐项手调。',
      en: 'Overall anti-ban profile plus fine-grained knobs. Picking a profile writes the values below in one shot; choose “Custom” to tune them by hand.',
    },
  },
  {
    id: 'image',
    label: { zh: '图片与长正文', en: 'Images & long text' },
    hint: {
      zh: '把图片附件真正上传到网页输入框；超长正文改走文件附件，避免输入框卡顿。',
      en: 'Upload image attachments into the page composer; long prompts go as a file attachment to avoid a frozen composer.',
    },
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
      zh: '网页提示「发送过于频繁」时按退避策略等待后自动重发同一条消息。默认指数退避：60s → 120s → 240s → 300s 封顶，合计约 12 分钟，覆盖实测 10~15 分钟的冷却窗口。',
      en: 'When the page reports rate limiting, wait per the backoff policy then resend the same message. Default exponential: 60s → 120s → 240s → 300s cap, about 12 minutes total, matching the observed 10–15 minute cooldown.',
    },
  },
  {
    id: 'notify',
    label: { zh: '过程提示', en: 'Progress notices' },
    hint: {
      zh: '把「发出消息 / 收到回复 / 频控等待 / 本轮失败」做成对话里一行可见提示（过程中以可折叠块呈现）。会话消息与审核消息分开开关，避免内部审核把主对话刷满。',
      en: 'Show one-line notices for send / receive / rate-limit wait / failures (rendered as a collapsible block). Session and review notices have separate switches so internal review does not flood the main conversation.',
    },
  },
  {
    id: 'browserrecovery',
    label: { zh: '浏览器自愈', en: 'Browser recovery' },
    hint: {
      zh: '浏览器或网页标签被关掉时先提示、再自动重启（重连）并重发本轮消息。只处理「被关掉」这类事故；频控、超时、手动取消不走这里。',
      en: 'When the browser or the tab is closed, notify first, then restart (or reconnect) and resend the turn automatically. Only closure accidents are handled here; rate limits, timeouts and cancellations are not.',
    },
  },
  {
    id: 'probe',
    label: { zh: '登录探活', en: 'Login probe' },
    hint: {
      zh: '后台只读检查网页登录态（不发送、不消耗额度）。失效时只提醒，绝不拦住发送——探活判断错了不该拦人。浏览器没启动时只记「无法判断」，不会为了探活把浏览器拉起来。',
      en: 'Background read-only check of the page login state (nothing is sent, no quota used). A failure only warns and never blocks a send. When the browser is not running it reports “unknown” instead of starting it.',
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
      zh: '默认开启。每轮都重发协议与工具清单，网页端不容易在长任务里忘记动作格式；代价是每轮多带约 1 千字符（精简目录）。关掉后按下面的间隔刷新。',
      en: 'On by default. Re-sends the protocol and tool list every turn so the page does not forget the action format on long tasks; costs about 1k extra characters per turn (compact catalog). Turn it off to fall back to the refresh interval below.',
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
    path: ['maxToolCatalogChars'],
    group: 'model',
    kind: 'number',
    label: { zh: '工具目录预算（字符）', en: 'Tool catalog budget (characters)' },
    min: 0,
    hint: {
      zh: '工具清单写进提示词的总预算，默认 28000。超预算时先缩描述、装不下就只留名字，并在末尾列出被省略的工具名——不会静默砍掉让模型「不会用工具」。0 = 不限制。',
      en: 'Total budget for the tool list in the prompt; default 28000. Over budget, descriptions shrink first, then only names remain, and omitted tool names are listed at the end — never silently dropped. 0 = unlimited.',
    },
  },
  {
    path: ['maxReplayChars'],
    group: 'model',
    kind: 'number',
    label: { zh: '历史回放预算（字符）', en: 'Replay budget (characters)' },
    min: 0,
    hint: {
      zh: '新标签页或新会话重建上下文时，允许回放的历史正文字符上限，默认 400000。调大不是「越安全」：网页输入框填字代价接近二次方，30 万字符约 13 秒、60 万约 77 秒。0 = 不限制。',
      en: 'Character budget for replaying history when a tab or conversation is rebuilt; default 400000. Bigger is not safer: filling the page composer scales near-quadratically (300k chars ≈ 13s, 600k ≈ 77s). 0 = unlimited.',
    },
  },
  {
    path: ['maxConcurrentTurns'],
    group: 'risk',
    kind: 'number',
    label: { zh: '同账号并发上限', en: 'Concurrent turns per account' },
    min: 0,
    max: 64,
    hint: {
      zh: '同一时刻最多几条请求真的在网页上跑。要「一号两并发」填 2；填 1 即完全串行。0 = 不限（不建议，容易撞账号级频控）。',
      en: 'How many requests may run on the page at once. Use 2 for two concurrent turns on one account; 1 fully serializes. 0 = unlimited (not recommended).',
    },
  },
  {
    path: ['maxSessionPages'],
    group: 'risk',
    kind: 'number',
    label: { zh: '会话标签页上限', en: 'Session tab limit' },
    min: 1,
    max: 8,
    hint: {
      zh: '同时保留几个网页标签页（每个并发会话独占一个）。开得越多，服务端「同账号多开」的判定风险越高，建议与并发上限持平。',
      en: 'How many page tabs stay open (one per concurrent session). More tabs raise the multi-window risk; keep it close to the concurrency limit.',
    },
  },
  {
    path: ['sendPauseMinMs'],
    group: 'risk',
    kind: 'number',
    label: { zh: '发送前停顿下限（毫秒）', en: 'Pre-send pause min (ms)' },
    min: 0,
    max: 60_000,
    hint: {
      zh: '消息填进输入框后、按发送前的随机停顿下限。默认 2000；与上限同为 0 则关闭停顿。',
      en: 'Lower bound of the random pause between filling the composer and sending. Default 2000; set both bounds to 0 to disable.',
    },
  },
  {
    path: ['sendPauseMaxMs'],
    group: 'risk',
    kind: 'number',
    label: { zh: '发送前停顿上限（毫秒）', en: 'Pre-send pause max (ms)' },
    min: 0,
    max: 60_000,
    hint: {
      zh: '停顿上限，默认 4000。必须在下限与上限之间随机取值——固定间隔方差为零，是最明显的机器特征。',
      en: 'Upper bound, default 4000. Always pick randomly inside the range: a fixed interval has zero variance and is the clearest bot signature.',
    },
  },
  {
    path: ['turnGapMinMs'],
    group: 'risk',
    kind: 'number',
    label: { zh: '回合间隔下限（毫秒）', en: 'Turn gap min (ms)' },
    min: 0,
    max: 600_000,
    hint: {
      zh: '上一轮网页回合结束到下一轮真正发请求之间的随机等待下限，默认 2000。与「发送前停顿」的区别是计时起点：那个只夹在填字→回车之间，这个管的是回合与回合之间，长任务连续续跑时才看得出差别。与上限同为 0 则关闭。',
      en: 'Lower bound of the random wait between the end of one web turn and the next request; default 2000. Unlike the pre-send pause (measured between filling and sending), this covers turn-to-turn spacing. Set both bounds to 0 to disable.',
    },
  },
  {
    path: ['turnGapMaxMs'],
    group: 'risk',
    kind: 'number',
    label: { zh: '回合间隔上限（毫秒）', en: 'Turn gap max (ms)' },
    min: 0,
    max: 600_000,
    hint: {
      zh: '回合间隔上限，默认 4000，在下限与上限之间随机取值。固定值方差为零是最明显的机器特征。',
      en: 'Upper bound of the turn gap; default 4000, randomized inside the range. A fixed value has zero variance and is the clearest bot signature.',
    },
  },
  {
    path: ['longRunAfterSends'],
    group: 'risk',
    kind: 'number',
    label: { zh: '连发多少轮后长休', en: 'Long pause after N sends' },
    min: 0,
    max: 10_000,
    hint: {
      zh: '连续发送满这么多轮就强制休息一段，打断「稳定节拍」。默认 15；0 = 关闭。10 分钟没有任何请求会重新计数。',
      en: 'After this many consecutive sends, take a long pause to break the metronome rhythm. Default 15; 0 = off. The counter resets after 10 idle minutes.',
    },
  },
  {
    path: ['longRunPauseMinMs'],
    group: 'risk',
    kind: 'number',
    label: { zh: '长休下限（毫秒）', en: 'Long pause min (ms)' },
    min: 0,
    max: 3_600_000,
    hint: { zh: '触发长休后的最短休息时长，默认 30000（30 秒）。', en: 'Minimum long-pause duration; default 30000 (30s).' },
  },
  {
    path: ['longRunPauseMaxMs'],
    group: 'risk',
    kind: 'number',
    label: { zh: '长休上限（毫秒）', en: 'Long pause max (ms)' },
    min: 0,
    max: 3_600_000,
    hint: { zh: '长休上限，与下限之间随机，默认 60000（60 秒）。', en: 'Maximum long-pause duration; randomized with the minimum. Default 60000 (60s).' },
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
    path: ['longTextAsFile'],
    group: 'image',
    kind: 'boolean',
    label: { zh: '长正文转文件', en: 'Long text as file' },
    hint: {
      zh: '正文超过阈值时写成 .md 附件上传，输入框只填摘要；关闭则整段填进输入框。',
      en: 'When the prompt exceeds the threshold, upload it as a .md attachment and type only a summary; off types the whole prompt.',
    },
  },
  {
    path: ['longTextFileThreshold'],
    group: 'image',
    kind: 'number',
    label: { zh: '长正文阈值（字）', en: 'Long-text threshold (chars)' },
    min: 10_000,
    hint: {
      zh: '默认 120000。网页输入框填字代价随长度接近二次方增长，12 万字约十几秒。',
      en: 'Default 120000. Typing cost grows roughly quadratically; 120k chars takes ten-plus seconds.',
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
    path: ['review', 'kimiMode'],
    group: 'review',
    kind: 'select',
    options: ['normal', 'project'],
    label: { zh: 'Kimi 审核模式', en: 'Kimi review mode' },
    visibleWhen: { path: ['review', 'provider'], equals: 'kimi' },
    hint: {
      zh: 'normal = 正常模式：开普通对话页审核，对话落在「最近对话」里。project = 项目模式：在指定项目页里新开对话审核，对话归档到该项目下（项目名称由你在 Kimi 里定，比如「审核」）。两种模式各用各的地址，不会互相兜底。',
      en: 'normal = plain conversation page; the chat lands in your recent chats. project = open a new chat inside a Kimi project page; the chat is filed under that project (project name is whatever you called it in Kimi). Each mode uses its own URL and they never fall back to each other.',
    },
  },
  {
    path: ['review', 'url'],
    group: 'review',
    kind: 'text',
    label: { zh: '正常模式链接', en: 'Normal mode URL' },
    visibleWhen: [
      { path: ['review', 'provider'], equals: 'kimi' },
      { path: ['review', 'kimiMode'], equals: 'normal' },
    ],
    hint: {
      zh: '正常模式下新标签页要打开的链接。默认带 ?chat_enter_method=new_chat，打开就是空对话；缺这个参数时会自动补上。企业版域名、带自有查询参数的地址同样可用。',
      en: 'The link opened in normal mode. The default carries ?chat_enter_method=new_chat so it lands on an empty conversation, and the parameter is added automatically when missing. Enterprise domains and your own query parameters work too.',
    },
  },
  {
    path: ['review', 'projectUrl'],
    group: 'review',
    kind: 'text',
    label: { zh: '项目 ID', en: 'Project ID' },
    visibleWhen: [
      { path: ['review', 'provider'], equals: 'kimi' },
      { path: ['review', 'kimiMode'], equals: 'project' },
    ],
    hint: {
      zh: '只填项目 ID 就行，形如 1a15bef4-b7a2-894f-8000-0e7143648841（项目页地址 /project/ 后面那一段）。插件会自动拼成 <域名>/project/<ID>?chat_enter_method=new_chat，域名取自上面的「正常模式链接」。填完整项目页链接也认。每轮审核都在这个项目里新开对话，对话归档到项目下；留空会直接报错，不会悄悄退回普通对话。',
      en: 'Just the project ID, e.g. 1a15bef4-b7a2-894f-8000-0e7143648841 (the segment after /project/ in the project URL). The plugin builds <domain>/project/<id>?chat_enter_method=new_chat using the domain from the normal-mode URL above. A full project link works too. Each round opens a new chat inside that project and files it there; leaving it empty fails loudly instead of silently falling back to a normal chat.',
    },
  },
  {
    path: ['review', 'glmUrl'],
    group: 'review',
    kind: 'text',
    label: { zh: 'GLM 审核窗口地址', en: 'GLM review window URL' },
    visibleWhen: { path: ['review', 'provider'], equals: 'glm' },
    hint: {
      zh: 'GLM 审核新标签页要打开的链接，默认 https://chat.z.ai/。',
      en: 'The link opened for GLM review, default https://chat.z.ai/.',
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
    path: ['review', 'autoSend'],
    group: 'review',
    kind: 'boolean',
    label: { zh: '全自动发送审核请求', en: 'Fully automatic review sending' },
    hint: {
      zh: '开（默认）= 全自动：填入后自动发送并确认真的发出，发不出去当场报错。关 = 半自动：只填入并聚焦审核窗口，等你自己点发送，超时同样会明确报错。',
      en: 'On (default) = fully automatic: fill, send, and confirm it really went out; failure errors out immediately. Off = semi-automatic: fill and focus the review window, then wait for you to click send.',
    },
  },
  {
    path: ['review', 'conversationMode'],
    group: 'review',
    kind: 'select',
    label: { zh: '审核对话模式', en: 'Review conversation mode' },
    options: ['fresh', 'reuse'],
    hint: {
      zh: 'fresh（默认）：每次审核前新开对话，上下文干净、不会越审越慢。reuse：复用同一个对话，历史会累积，可能被上一轮结论带偏。',
      en: 'fresh (default): open a new conversation before each review, keeping context clean and speed stable. reuse: keep one conversation, so history accumulates and can bias later rounds.',
    },
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
    label: { zh: '首次重发等待（毫秒）', en: 'First retry delay (ms)' },
    min: 1000,
    hint: {
      zh: '第一次等待多久；指数退避时作为基数。默认 60000（1 分钟）。',
      en: 'How long to wait before the first resend; acts as the base for exponential backoff. Default 60000 (1 minute).',
    },
  },
  {
    path: ['rateLimit', 'maxRetries'],
    group: 'ratelimit',
    kind: 'number',
    label: { zh: '单轮最大重发次数', en: 'Max retries per turn' },
    min: 0,
    max: 20,
    hint: {
      zh: '默认 4 次：配合指数退避合计约 12 分钟。用尽后才报 WEB_RATE_LIMITED。',
      en: 'Default 4: about 12 minutes total with exponential backoff. Exhausted retries raise WEB_RATE_LIMITED.',
    },
  },
  {
    path: ['rateLimit', 'backoff'],
    group: 'ratelimit',
    kind: 'select',
    options: ['exponential', 'fixed'],
    label: { zh: '退避曲线', en: 'Backoff curve' },
    hint: {
      zh: 'exponential（默认）：每次等待翻倍；fixed：每次都等「首次重发等待」。',
      en: 'exponential (default): double the wait each time; fixed: always wait the first-retry delay.',
    },
  },
  {
    path: ['rateLimit', 'retryMaxDelayMs'],
    group: 'ratelimit',
    kind: 'number',
    label: { zh: '单次等待上限（毫秒）', en: 'Max single delay (ms)' },
    min: 1000,
    hint: {
      zh: '指数退避的封顶值，默认 300000（5 分钟），避免越退越长把回合拖死。',
      en: 'Cap for exponential backoff, default 300000 (5 minutes), so the turn never stalls on ever-growing delays.',
    },
  },
  {
    path: ['rateLimit', 'jitterRatio'],
    group: 'ratelimit',
    kind: 'number',
    label: { zh: '抖动比例（0~0.5）', en: 'Jitter ratio (0–0.5)' },
    min: 0,
    max: 0.5,
    hint: {
      zh: '每次等待在基准值上随机浮动，默认 0.15（±15%）。多实例同时重撞时能错开。',
      en: 'Randomise each delay around the base value; default 0.15 (±15%). Keeps multiple instances from hitting the same second.',
    },
  },
  {
    path: ['rateLimit', 'accountCooldownMs'],
    group: 'ratelimit',
    kind: 'number',
    label: { zh: '账号级冷却（毫秒）', en: 'Account cooldown (ms)' },
    min: 0,
    max: 3_600_000,
    hint: {
      zh: '自动重发用尽后，整个账号进入冷却多久，默认 600000（10 分钟）。冷却期内所有会话都快速失败、不再向网页发任何请求——同账号其它会话继续打，正是最容易触发 1 天封禁的形态。0 = 关闭。',
      en: 'How long the whole account cools down after resends are exhausted; default 600000 (10 min). While cooling, every session fails fast and nothing reaches the page — other sessions hammering the same account is exactly what triggers a one-day ban. 0 = off.',
    },
  },

  {
    path: ['serverBusy', 'enabled'],
    group: 'ratelimit',
    kind: 'boolean',
    label: { zh: '服务端不可用自动重发', en: 'Retry on server unavailable' },
    hint: {
      zh: '网页提示「服务器暂时不可用」或返回 5xx 时，等一会儿自动重发同一条消息。关闭后这类失败会立刻报错。',
      en: 'When the page says the server is temporarily unavailable or returns 5xx, wait and resend automatically. Off: such failures error out immediately.',
    },
  },
  {
    path: ['serverBusy', 'retryDelayMs'],
    group: 'ratelimit',
    kind: 'number',
    label: { zh: '服务端故障首次等待（毫秒）', en: 'First delay on server error (ms)' },
    min: 1000,
    hint: {
      zh: '默认 15000（15 秒）。后端抖动通常几十秒内恢复，等太久只是干坐着；指数退避时作为基数。',
      en: 'Default 15000 (15s). Backend hiccups usually clear within a minute; acts as the base for exponential backoff.',
    },
  },
  {
    path: ['serverBusy', 'maxRetries'],
    group: 'ratelimit',
    kind: 'number',
    label: { zh: '服务端故障最大重发次数', en: 'Max retries on server error' },
    min: 0,
    max: 20,
    hint: {
      zh: '默认 4 次（15s + 30s + 60s + 120s ≈ 3.75 分钟）。用尽后才报 WEB_SERVER_BUSY，且不会锁账号冷却。',
      en: 'Default 4 (15s + 30s + 60s + 120s ≈ 3.75 min). Exhausted retries raise WEB_SERVER_BUSY and never trigger the account cooldown.',
    },
  },
  {
    path: ['serverBusy', 'retryMaxDelayMs'],
    group: 'ratelimit',
    kind: 'number',
    label: { zh: '服务端故障单次等待上限（毫秒）', en: 'Max single delay on server error (ms)' },
    min: 1000,
    hint: {
      zh: '指数退避封顶，默认 120000（2 分钟）。',
      en: 'Cap for exponential backoff; default 120000 (2 minutes).',
    },
  },
  {
    path: ['serverBusy', 'backoff'],
    group: 'ratelimit',
    kind: 'select',
    options: ['exponential', 'fixed'],
    label: { zh: '服务端故障退避曲线', en: 'Server-error backoff curve' },
    hint: {
      zh: 'exponential（默认）：每次翻倍；fixed：每次都等「首次等待」。',
      en: 'exponential (default): double each time; fixed: always wait the first delay.',
    },
  },
  {
    path: ['serverBusy', 'jitterRatio'],
    group: 'ratelimit',
    kind: 'number',
    label: { zh: '服务端故障抖动比例（0~0.5）', en: 'Server-error jitter (0–0.5)' },
    min: 0,
    max: 0.5,
    hint: {
      zh: '默认 0.2（±20%）。',
      en: 'Default 0.2 (±20%).',
    },
  },

  {
    path: ['notify', 'enabled'],
    group: 'notify',
    kind: 'boolean',
    label: { zh: '过程提示总开关', en: 'All notices' },
    hint: { zh: '关闭后所有提示（含浏览器浮层）都不再出现。', en: 'Off: no notices at all, including the browser overlay.' },
  },
  {
    path: ['notify', 'session'],
    group: 'notify',
    kind: 'boolean',
    label: { zh: '会话消息提示', en: 'Session notices' },
    hint: {
      zh: '主对话的发送/接收/等待/失败提示（前缀 [DSH]）。',
      en: 'Send/receive/wait/failure notices for the main conversation (prefix [DSH]).',
    },
  },
  {
    path: ['notify', 'review'],
    group: 'notify',
    kind: 'boolean',
    label: { zh: '审核消息提示', en: 'Review notices' },
    hint: {
      zh: '内部审核（自审 / Kimi / GLM）的提示（前缀 [DSH·审核]），与会话提示分开。',
      en: 'Notices for internal review (self / Kimi / GLM) with prefix [DSH·review], kept separate from session notices.',
    },
  },
  {
    path: ['notify', 'send'],
    group: 'notify',
    kind: 'boolean',
    label: { zh: '发送侧提示', en: 'Send notices' },
    hint: { zh: '消息已发送 / 已填入等待你点发送。', en: 'Message sent, or filled in and waiting for your click.' },
  },
  {
    path: ['notify', 'receive'],
    group: 'notify',
    kind: 'boolean',
    label: { zh: '接收侧提示', en: 'Receive notices' },
    hint: {
      zh: '网页已响应、开始生成、本轮完成、频控等待与重发。',
      en: 'Page responded, generation started, turn finished, plus rate-limit waits and resends.',
    },
  },
  {
    path: ['notify', 'errors'],
    group: 'notify',
    kind: 'boolean',
    label: { zh: '失败提示', en: 'Failure notices' },
    hint: {
      zh: '任一错误码（频控、超时、浏览器、登录、审核通道等）都会翻译成一句人话加处理建议。',
      en: 'Every error code (rate limit, timeout, browser, login, review channel, …) is translated into one plain sentence with a suggested action.',
    },
  },
  {
    path: ['notify', 'browser'],
    group: 'notify',
    kind: 'boolean',
    label: { zh: '浏览器浮层', en: 'Browser overlay' },
    hint: {
      zh: '在网页窗口右下角显示频控倒计时等浮层（不挡点击）。只作辅助，主通道是对话里的提示块。',
      en: 'Show a click-through overlay in the page corner with the rate-limit countdown. Auxiliary only; the main channel is the in-conversation notice block.',
    },
  },

  {
    path: ['browserRecovery', 'enabled'],
    group: 'browserrecovery',
    kind: 'boolean',
    label: { zh: '浏览器被关后自动恢复', en: 'Recover a closed browser' },
    hint: {
      zh: '关掉浏览器或网页标签后，自动重启（重连）并重发本轮消息，同时在对话里留一条「恢复」提示。关掉后只报错，需手动重试。',
      en: 'After the browser or tab is closed, restart (or reconnect) and resend the turn, leaving a recovery notice. When off, it only reports the error and you retry manually.',
    },
  },
  {
    path: ['browserRecovery', 'maxAttempts'],
    group: 'browserrecovery',
    kind: 'number',
    min: 0,
    max: 5,
    label: { zh: '单轮最多恢复次数', en: 'Max recoveries per turn' },
    hint: {
      zh: '默认 2 次。连续被关超过这个次数，说明不是手滑而是有东西在反复杀进程，此时直接把原始错误抛出来更有用。',
      en: 'Defaults to 2. Repeated closures beyond this usually mean something keeps killing the process, so surfacing the original error is more useful.',
    },
  },
  {
    path: ['browserRecovery', 'delayMs'],
    group: 'browserrecovery',
    kind: 'number',
    min: 0,
    max: 60_000,
    label: { zh: '重启前等待（毫秒）', en: 'Delay before restart (ms)' },
    hint: {
      zh: '默认 2000。给系统一点时间回收窗口句柄，避免刚重启就被残留进程挡住。',
      en: 'Defaults to 2000. Gives the OS time to release window handles before relaunching.',
    },
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
    path: ['loginProbe', 'enabled'],
    group: 'probe',
    kind: 'boolean',
    label: { zh: '启用登录探活', en: 'Enable login probe' },
    hint: {
      zh: '关掉后完全不做后台检查，登录过期仍会在下一次发送时当场报错。',
      en: 'Off: no background checks at all; an expired login still fails loudly on the next send.',
    },
  },
  {
    path: ['loginProbe', 'initialDelayMs'],
    group: 'probe',
    kind: 'number',
    label: { zh: '启动后首次探活延迟（毫秒）', en: 'First probe delay (ms)' },
    min: 0,
    hint: {
      zh: '默认 20000（20 秒）：等网页把登录态渲染完再判断。',
      en: 'Default 20000 (20s): let the page finish rendering the login state first.',
    },
  },
  {
    path: ['loginProbe', 'intervalMs'],
    group: 'probe',
    kind: 'number',
    label: { zh: '探活间隔（毫秒）', en: 'Probe interval (ms)' },
    min: 0,
    hint: {
      zh: '默认 1800000（30 分钟）。填 0 = 只在启动后探一次。',
      en: 'Default 1800000 (30 min). 0 = probe once after startup only.',
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

/** 风控档位的 id。档位只是这几个字段的一组预设值，不是独立的运行时配置。 */
export type RiskPresetId = 'off' | 'balanced' | 'strict'

/** 当前取值命中的档位；与任何档位都不全等时为 `custom`。 */
export type RiskTier = RiskPresetId | 'custom'

/** 一个风控档位：几个字段成套写入的一组值。 */
export interface RiskPreset {
  readonly id: RiskPresetId
  readonly label: FieldText
  readonly hint: FieldText
  /**
   * 套用该档位时写入的字段值。
   * 并发上限与标签页上限不进档位——用户明确要「一号两并发」，属手工决策项。
   */
  readonly values: readonly { readonly path: FieldPath; readonly value: unknown }[]
}

/** 三档风控预设，按「越靠前越宽松」排列。 */
export const RISK_PRESETS: readonly RiskPreset[] = [
  {
    id: 'off',
    label: { zh: '关闭', en: 'Off' },
    hint: {
      zh: '不插入发送前停顿、也不做长休：节奏最像脚本，只在你明确接受风险时用。',
      en: 'No pre-send pause and no long pause; the rhythm looks scripted. Use only if you accept the risk.',
    },
    values: [
      { path: ['sendPauseMinMs'], value: 0 },
      { path: ['sendPauseMaxMs'], value: 0 },
      { path: ['turnGapMinMs'], value: 0 },
      { path: ['turnGapMaxMs'], value: 0 },
      { path: ['longRunAfterSends'], value: 0 },
    ],
  },
  {
    id: 'balanced',
    label: { zh: '均衡（推荐）', en: 'Balanced (recommended)' },
    hint: {
      zh: '每轮随机停 2~4 秒，连发 15 轮休 30~60 秒。同源社区项目长期使用、未触发封禁的一组值，也是默认值。',
      en: 'Random 2–4s before each send, long pause of 1–3 min after 15 sends. Sourced from a long-lived peer project; also the defaults.',
    },
    values: [
      { path: ['sendPauseMinMs'], value: 2_000 },
      { path: ['sendPauseMaxMs'], value: 4_000 },
      { path: ['turnGapMinMs'], value: 2_000 },
      { path: ['turnGapMaxMs'], value: 4_000 },
      { path: ['longRunAfterSends'], value: 15 },
      { path: ['longRunPauseMinMs'], value: 30_000 },
      { path: ['longRunPauseMaxMs'], value: 60_000 },
    ],
  },
  {
    id: 'strict',
    label: { zh: '严格', en: 'Strict' },
    hint: {
      zh: '每轮随机停 5~9 秒，连发 10 轮休 2~5 分钟。已经被限流过、或正在跑长链路自动化时用。',
      en: 'Random 5–9s before each send, long pause of 2–5 min after 10 sends. Use after a rate-limit hit or for long tool chains.',
    },
    values: [
      { path: ['sendPauseMinMs'], value: 5_000 },
      { path: ['sendPauseMaxMs'], value: 9_000 },
      { path: ['turnGapMinMs'], value: 5_000 },
      { path: ['turnGapMaxMs'], value: 9_000 },
      { path: ['longRunAfterSends'], value: 10 },
      { path: ['longRunPauseMinMs'], value: 120_000 },
      { path: ['longRunPauseMaxMs'], value: 300_000 },
    ],
  },
]

/** 按当前值判断落在哪个档位；任一项不符即算 `custom`。 */
export function matchRiskPreset(source: unknown): RiskTier {
  for (const preset of RISK_PRESETS) {
    if (preset.values.every(item => sameValue(readPath(source, item.path), item.value))) return preset.id
  }
  return 'custom'
}

/** 把某档位的全部值写进草稿，返回新草稿（不改动并发与标签页上限）。 */
export function applyRiskPreset(
  draft: Record<string, unknown> | null,
  accepted: Record<string, unknown>,
  preset: RiskPreset,
): Record<string, unknown> {
  let next = draft
  for (const item of preset.values) next = withEdit(next, accepted, item.path, item.value)
  return next ?? accepted
}

