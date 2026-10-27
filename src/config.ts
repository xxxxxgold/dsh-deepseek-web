/**
 * 插件配置。字段均可通过 cordis.yml 或（后续）用户设置覆盖。
 *
 * @module dsh-deepseek-web/config
 */

import z from '@deepseek-ai/schemastery'
import type { NotifyConfig } from './notify.ts'
import {
  WEB_MODEL_CAPABILITIES,
  WEB_MODEL_DEFAULT_REASONING_EFFORT,
  WEB_MODEL_IDS,
  WEB_MODEL_REASONING_EFFORTS,
  type GlmWebModelId,
  type GlmWebReasoningEffortId,
  type WebModelId,
  type WebModelReasoningEffortId,
} from './web-models.ts'

export const PROVIDER = 'deepseek-web'

export {
  WEB_MODEL_CAPABILITIES,
  WEB_MODEL_DEFAULT_REASONING_EFFORT,
  WEB_MODEL_IDS,
  WEB_MODEL_REASONING_EFFORTS,
}
export type { WebModelId, WebModelReasoningEffortId }

/** 历史模型 id：旧会话仍可能引用，解析时映射回单一入口。 */
export const LEGACY_WEB_MODEL_IDS = [
  'deepseek-web-chat',
  'deepseek-web-reasoner',
  'deepseek-web-search',
] as const

/** 把任意历史模型 id 归一到当前唯一入口；不认识时返回 undefined。 */
export function normalizeWebModel(model: string): WebModelId | undefined {
  if ((WEB_MODEL_IDS as readonly string[]).includes(model)) return model as WebModelId
  if ((LEGACY_WEB_MODEL_IDS as readonly string[]).includes(model)) return 'deepseek-web'
  return undefined
}

/**
 * 发送模式：
 * - `manual`：驱动把消息填入输入框并聚焦浏览器窗口，由用户点击发送（默认，最稳妥）
 * - `approved`：由 Harness 审批流确认后程序化点击发送（后续实现）
 */
export type SendMode = 'manual' | 'approved'

/** 可选的审核通道配置；默认关闭，关闭时行为与只用 DeepSeek 完全一致。 */
export type ReviewProvider = 'kimi' | 'deepseek-web' | 'glm'

/**
 * Kimi 审核窗口的两种模式（互斥，不是一个开关的两种写法）：
 * - `normal`：普通对话页。每次审核开一个普通对话，落在「最近对话」里。
 * - `project`：项目页内的对话。每次审核在该项目里新开一个对话，对话归档到项目下。
 *
 * 实机核对（2026-10）：项目页发消息后地址会变成 `/chat/<uuid>`（Kimi 的对话页统一形态），
 * 但对话确实归属该项目——项目页侧边栏和历史里都能看到，带 `project` 查询参数。
 */
export type KimiReviewMode = 'normal' | 'project'

export interface ReviewConfig {
  /** 是否启用审核（审核器由 provider 决定）。 */
  enabled: boolean
  /**
   * 审核器：
   * - `kimi`：独立第三方审核（Kimi 窗口、独立上下文）
   * - `glm`：独立第三方审核（chat.z.ai 窗口、独立上下文）
   * - `deepseek-web`：在同一个 DeepSeek 对话里自审（不开新窗口、不复制文件内容，更快但独立性弱）
   */
  provider: ReviewProvider
  /**
   * 审核请求的自动化程度（全自动 / 半自动，二选一）：
   * - `true`（**全自动**，默认）：填入后自动回车发送，并确认真的发出去了；
   *   发不出去会当场报错，不会悄悄停在输入框里。
   * - `false`（**半自动**）：只填入并聚焦审核窗口，由你点发送；等待超会明确报错。
   *
   * 审核是自动化流程，默认全自动：每次都要人工点一下，等于把整轮自动审核
   * 拖成人工值守，忘了点就会空等到超时。
   */
  autoSend: boolean
  /**
   * 每次审核要不要新开对话：
   * - `fresh`（默认）：每次审核前新开一个对话，上下文干净。
   * - `reuse`：复用同一个对话（旧行为）。审核 prompt 自带全部证据，复用并不会更准，
   *   反而会让审核窗口的上下文越积越长、越审越慢，还容易被上一轮的结论带偏。
   */
  conversationMode: 'fresh' | 'reuse'
  /** 自动发送后确认“已发出”的等待窗口（毫秒）；窗口内没等到信号才视为没发出去。 */
  sendVerifyMs: number
  /** 自动发送未确认时的重试轮数（每轮 = 回车 + 点发送按钮兜底）。 */
  sendRetries: number
  /**
   * 获取回复失败后的自动重试次数（0 = 不重试）。
   *
   * 覆盖“等回复超时 / 拿到空响应 / 页面或连接断开 / 发送没被确认”这几类环境抖动；
   * 每次重试前都会丢弃旧连接并重新连浏览器，不会复用已经死掉的页面。
   */
  fetchRetries: number
  /**
   * Kimi 审核窗口打开方式（二选一）：
   * - `normal`（默认）：普通对话页。
   * - `project`：项目页里的对话，审核结果归档到该项目下。
   *
   * 选 `project` 时使用下面的 `projectUrl`，选 `normal` 时使用 `url`；
   * 两者不会互相兜底——选项目模式却没填项目链接会直接报错，避免悄悄退回普通对话。
   */
  kimiMode: KimiReviewMode
  /**
   * 正常模式的入口链接（默认已带 `?chat_enter_method=new_chat`，打开即是新对话）。
   * 可改成任意同源地址：企业版域名、带自己查询参数的地址。
   * 通道只保证“打开这个链接”，不会篡改路径；缺建新参数时会被自动补上。
   */
  url: string
  /**
   * 项目模式的目标项目：**只填项目 ID 就行**（形如 `1a15bef4-b7a2-894f-8000-0e7143648841`），
   * 通道会拼成 `<域名>/project/<ID>?chat_enter_method=new_chat` 再打开，域名取自上面的 `url`，
   * 所以企业版域名也能跟着走。
   *
   * 填完整项目页链接同样认（老配置里存的就是整条地址），此时原样使用、不再拼接。
   * 留空时选项目模式会直接报错，避免悄悄退回普通对话。
   */
  projectUrl: string
  /** 常驻 Kimi 审核浏览器的 CDP 端口。 */
  debugPort: number
  /** Kimi 审核独立 profile 目录；留空使用 %LOCALAPPDATA%\DshDeepSeekWeb\kimi-profile。 */
  profileDir?: string
  /** 审核轮次的等待超时。 */
  streamIdleTimeoutMs: number
  /** 送入审核的代码/产物证据最大字符数。 */
  maxEvidenceChars: number
  /** 单次任务最多审核多少轮，避免来回审核停不下来。 */
  maxRounds: number
  /** GLM 审核网页版地址。 */
  glmUrl: string
  /** 常驻 GLM 审核浏览器的 CDP 端口。 */
  glmDebugPort: number
  /** GLM 审核独立 profile 目录；留空使用 %LOCALAPPDATA%\DshDeepSeekWeb\glm-profile。 */
  glmProfileDir?: string
  /** GLM 审核使用的模型（GLM-5.3 / GLM-5.3-Flash）。 */
  glmModel: GlmWebModelId
  /** GLM 审核使用的思考强度（low / high / max）。 */
  glmEffort: GlmWebReasoningEffortId
}

/** GLM 主通道（第二个主模型 provider）的配置。 */
export interface GlmWebConfig {
  /** GLM 对话页地址；支持 chatglm.cn 与 chat.z.ai（按域名识别选择器）。 */
  url: string
  /** 常驻 GLM 主通道浏览器的 CDP 端口。 */
  debugPort: number
  /** 独立 profile 目录；留空使用 %LOCALAPPDATA%\DshDeepSeekWeb\glm-web-profile。 */
  profileDir?: string
  /**
   * 主通道是否自动发送。
   *
   * 默认 true：GLM 主通道是 agent 链路，每轮都要人工点发送会让工具循环不可用。
   * 想沿用 DeepSeek 的半自动节奏时改 false。
   */
  autoSend: boolean
  /**
   * 主通道发送确认后等待网页响应头的上限（毫秒）。
   * GLM 极致档位长任务可能十几分钟才开始吐流，默认 15 分钟。
   */
  ackTimeoutMs: number
}

/**
 * 豆包网页通道配置。
 *
 * 与主配置分开是刻意的：豆包有自己的浏览器窗口、登录 profile 和 CDP 端口，
 * 与 DeepSeek 通道互不污染；`enabled=false` 时整个通道不注册、不启动浏览器。
 */
export interface DoubaoConfig {
  /** 是否启用豆包 provider。默认关闭，避免新增功能影响现有用户。 */
  enabled: boolean
  /** 豆包对话页地址。 */
  url: string
  /** 独立 profile 目录；留空使用 %LOCALAPPDATA%\DshDeepSeekWeb\doubao-profile。 */
  profileDir?: string
  /** 常驻豆包浏览器的 CDP 端口。 */
  debugPort: number
  /** 等响应头的上限（毫秒）。 */
  ackTimeoutMs: number
  /** 等完整响应体的上限（毫秒）。 */
  replyTimeoutMs: number
  /** 最多保留多少个会话标签页。 */
  maxSessionPages: number
  /** 浏览器未启动时是否自动拉起常驻进程。 */
  autoStartKeeper: boolean
}

export interface Config {
  /**
   * 界面语言：
   * - `auto`（默认）：跟随系统语言，中文系统显示中文，其余显示英文；
   * - `zh`：强制中文；
   * - `en`：强制英文。
   *
   * 只影响本插件的两处配置界面（设置页与插件管理器配置页），不影响宿主 DSH 自身语言。
   */
  uiLanguage: 'auto' | 'zh' | 'en'
  /** DeepSeek 网页地址。 */
  url: string
  /**
   * 浏览器通道：
   * - `managed`：本插件启动一个带独立 profile 的 Edge/Chrome 窗口，用户在此登录
   * - `attach`：连接用户已用 `--remote-debugging-port` 启动的浏览器
   */
  browser: 'managed' | 'attach'
  /** managed 模式使用的浏览器。 */
  channel: 'msedge' | 'chrome'
  /** attach 模式的调试端口；managed 模式把它作为首选端口，冲突时自动换用空闲端口。 */
  debugPort: number
  /** attach 模式下如果 CDP 端口不可达，是否自动启动/恢复浏览器常驻守护。 */
  autoStartKeeper: boolean
  /** 会话游标持久化文件；缺省写入 %LOCALAPPDATA%\DshDeepSeekWeb\session-state.json。 */
  stateFile?: string
  /** managed 模式的独立 profile 目录；留空使用 $DSH_HOME 下的默认目录。 */
  profileDir?: string
  /** 每轮是否等待人工点击发送。 */
  sendMode: SendMode
  /**
   * 窗口聚焦策略：填入网页输入框时把网页窗口提到最前；
   * 网页对话（含审核）结束、正文交给 Harness 时把 dsh 宿主窗口提到最前。
   */
  focus: {
    /** 总开关。关掉后首次拉起浏览器以最小化启动，页面操作也不再置前。 */
    enabled: boolean
    /** 填入网页输入框 / 首次请求时聚焦网页窗口。 */
    webWindow: boolean
    /** 回合（含审核）结束后聚焦 dsh 窗口。 */
    dshWindow: boolean
    /** dsh 窗口候选进程名（Windows 顶层窗口匹配）。 */
    dshProcessNames: string[]
    /** dsh 窗口标题正则（可选，与进程名任一命中即可）。 */
    dshTitlePattern: string
  }
  /**
   * 登录态主动探活：只读检查（不发送、不消耗额度），默认启动后 20 秒探一次，
   * 之后每 30 分钟一次。浏览器没启动时只报 unknown，绝不为了探活把浏览器拉起来。
   */
  loginProbe: {
    /** 总开关。 */
    enabled: boolean
    /** 启动后首次探活的延迟（毫秒）。 */
    initialDelayMs: number
    /** 之后每次探活的间隔（毫秒）；0 = 只在启动后探一次。 */
    intervalMs: number
  }
  /** 网页版模型在页面上应处于哪个开关状态（供驱动校准）。 */
  model: WebModelId
  /** 页面元素/开关的 CSS 选择器覆盖；为空时使用内置默认并允许运行期“校准”。 */
  selectors?: Record<string, string>
  /**
   * 自动发送时“按下回车 → 看到 HTTP 响应头”的等待上限（毫秒）。
   *
   * 只管首响应，不管生成过程；人工发送（`sendMode: manual`）不吃这个值，
   * 固定给足 3 分钟等你去点发送按钮。默认 600 秒（10 分钟）：网页正常 1~3 秒
   * 就回响应头，这个值只是兜底上限。自动发送时首响应等待另由
   * `SEND_ACK_TIMEOUT_MS`（3 分钟）封顶，所以实际不会真等满 10 分钟。
   */
  streamIdleTimeoutMs: number
  /**
   * 频控自动重试：网页提示“消息发送过于频繁，请稍后重试”时，
   * 等待 retryDelayMs 后自动重发同一条消息，而不是中断回合报错。
   */
  rateLimit: {
    /** 总开关。 */
    enabled: boolean
    /** 检测到频控后第一次等待多久（毫秒）；指数退避时作为基数。 */
    retryDelayMs: number
    /** 单轮最多自动重发次数；用尽后才抛 WEB_RATE_LIMITED。 */
    maxRetries: number
    /** 退避曲线：fixed 每次等 retryDelayMs；exponential 按次数翻倍（默认）。 */
    backoff: 'fixed' | 'exponential'
    /** 指数退避的单次等待上限（毫秒），防止越退越长把回合拖死。 */
    retryMaxDelayMs: number
    /** 抖动比例 0~0.5：每次等待在基准值上随机浮动，避免多实例同一秒重撞。 */
    jitterRatio: number
    /**
     * 账号级冷却：一旦网页判了频控，整个账号在这段时间内不再发任何请求
     * （不只是当前会话在等，其它会话/子代理也一起停）。默认 10 分钟，对齐
     * 实测常见的 10~15 分钟冷却窗口；设 0 关闭（退回「只有本回合退避」的旧行为）。
     */
    accountCooldownMs: number
  }
  /**
   * 服务端故障自动重试：网页返回 5xx，或页面提示「服务器暂时不可用」时，
   * 等一会儿自动重发同一条消息，而不是把这一轮判成「响应格式无法识别」。
   *
   * 与 `rateLimit` 刻意分开：频控是账号被判发得太快，要等分钟级冷却、还可能封号；
   * 服务端故障是 DeepSeek 后端过载/重启，跟账号无关，几十秒到两分钟就恢复，
   * 也不该触发账号冷却（否则一次后端抖动会让所有会话停 10 分钟）。
   */
  serverBusy: {
    /** 总开关。关掉后服务端故障直接报 WEB_SERVER_BUSY，不自动等待重发。 */
    enabled: boolean
    /** 首次等待（毫秒）；指数退避时作为基数。默认 15 秒。 */
    retryDelayMs: number
    /** 单轮最多自动重发次数。默认 4 次（15s + 30s + 60s + 120s ≈ 3.75 分钟）。 */
    maxRetries: number
    /** 退避曲线：fixed 每次等 retryDelayMs；exponential 按次数翻倍（默认）。 */
    backoff: 'fixed' | 'exponential'
    /** 指数退避的单次等待上限（毫秒）。默认 2 分钟。 */
    retryMaxDelayMs: number
    /** 抖动比例 0~0.5，避免多实例同一秒重撞。默认 ±20%。 */
    jitterRatio: number
  }
  /**
   * 提示：把「发出消息 / 收到回复 / 频控等待 / 本轮失败」做成对话里可见的一行提示。
   *
   * 主通道是 reasoning 块（可折叠、不污染正文），浏览器页面浮层只辅助等待场景。
   * 会话消息与审核消息分开开关：内部自审不该把主对话刷满。
   */
  notify: NotifyConfig
  /**
   * 浏览器自愈：网页标签或整个浏览器被关掉后，自动重启/重连并重发本轮。
   *
   * 处理的是「用户手滑关掉浏览器」「系统清理了窗口」这类可恢复事故，
   * 而不是代码 bug：只对关闭类报错生效，频控、超时、取消都不在这里兜。
   */
  browserRecovery: {
    /** 总开关。关掉后浏览器被关只报错，不自动重启。 */
    enabled: boolean
    /** 单轮最多尝试恢复几次；用尽后才把原始错误抛给宿主。 */
    maxAttempts: number
    /** 重启前的等待（毫秒），给系统一点时间回收句柄。 */
    delayMs: number
  }
  /**
   * 归档联动清理：DSH 会话归档后，删除它在 DeepSeek 网页端产生过的对话。
   *
   * 只处理本次运行期间新增的归档；历史存量没有网页对话 id，只在统计里显示为
   * “无绑定”，不做猜测性删除。
   */
  archiveCleanup: {
    /** 归档时是否自动删除网页端对话。 */
    deleteOnArchive: boolean
    /** 是否连上下文轮换产生的旧网页对话一起删；关掉只删最后一条。 */
    includeRotatedChats: boolean
  }
  /**
   * 实时思考流：默认关闭；开启时仅把网页真实思考增量作为 reasoning 块
   * 流式展示在 Harness 对话里，不包含回答正文，也不控制网页思考开关。
   */
  liveThinking: boolean
  /** 最大回复字节数保护。 */
  maxReplyBytes: number
  /**
   * 上报给宿主的上下文窗口（token），设置页可改，默认 1000000。
   *
   * 默认值来自实测而非站点文档：附件通道下中文约 154 万字符、英文约 400 万字符
   * 可被完整读入（折算约 100 万 token），超限时网页静默丢弃尾部且不报错。
   * 它只影响宿主的预算与压缩判断，不改变网页端行为；调大后压缩更晚。
   */
  contextWindow: number
  /**
   * 上报给宿主的单次输出上限（token），设置页可改，默认 300000。
   *
   * 网页会自然收尾（实测约 8400 字符），所以该值主要影响宿主预算与压缩阈值：
   * `min(contextWindow × 0.8, contextWindow − maxTokens − headroomTokens)`。
   * 需满足 `maxTokens + headroomTokens < contextWindow`，否则宿主的自动压缩会被拒绝执行。
   */
  maxTokens: number
  /**
   * 图片直传：把 Harness 的 image 块真正上传到网页输入框，让网页端原生识图。
   * 关闭时退回旧行为（图片降级成 `[附图 N: 文件名]` 文本标记，模型看不到图）。
   */
  enableImageUpload: boolean
  /**
   * 单轮最多上传几张图。网页端实测可收 50 张，但并发上传会同时打满多个
   * `upload_file` 请求、更容易触发账号级频控，默认 4 张。
   */
  maxImagesPerTurn: number
  /**
   * 等待网页端把图片解析到 `SUCCESS` 的超时（毫秒）。
   * 网页端状态机为 PENDING → PARSING → SUCCESS，大图解析可能接近一分钟。
   */
  uploadTimeoutMs: number
  /**
   * 上传失败时的策略：
   * - `fallback-text`：退回文本标记继续本轮（模型知道"有图但没看到"）；
   * - `abort`：直接抛错，宁可停下也不让模型在缺图的情况下猜。
   */
  uploadOnError: 'fallback-text' | 'abort'
  /**
   * 同时保留的网页标签页上限（每个并发会话独占一个标签页）。
   * 主会话与它派生的子代理是两个不同会话，各自拿自己的标签页，互不遮挡；
   * 超出上限时回收最久未使用的会话页（该会话下次请求会重新回放宿主上下文）。
   */
  maxSessionPages: number
  /** 单个网页回合（一次"填入 → 发送 → 等回复"）的硬上限（毫秒）；超时中止并报错，0 表示不限制。 */
  turnTimeoutMs: number
  /**
   * 会话锁租约（毫秒）。持有者超过该时长仍未释放时强制回收，
   * 防止宿主放弃生成器后后续请求永久排队。0 表示不启用。
   */
  lockLeaseMs: number
  /** 单次模型请求（整条流，可能包含多轮网页回合）的硬上限（毫秒）；超时主动取消，0 表示不限制。 */
  maxStreamMs: number
  /**
   * 全局并发上限：同一时刻最多允许多少条请求真正在网页上跑（主会话、子代理、辅助请求一起算）。
   * 超出的请求按先进先出排队，一个一个放行；0 表示不限制（只观测不排队）。
   *
   * 默认 1：网页端的频控与临时封禁按**账号**结算，不是按标签页。竞品实测同账号
   * 两条生成并发不到 6 分钟即触发 1 天封禁，所以默认排队而不是并行；多会话仍然
   * 各占一个标签页，只是同一时刻只有一个在真正打网页。确实要并行时调大。
   */
  maxConcurrentTurns: number
  /**
   * 消息填入输入框后、按下发送之前的随机停留区间（毫秒，取 [min, max] 内随机值）。
   * 真人不会打完字就立刻回车；固定延迟方差≈0 反而是机器特征，所以用区间随机。
   * 两者都为 0 即关闭停顿。
   */
  sendPauseMinMs: number
  sendPauseMaxMs: number
  /**
   * 回合间隔：上一轮网页回合**结束**到下一轮真正发请求之间的随机等待区间（毫秒）。
   * 与 sendPause 的区别是计时起点——sendPause 只夹在「填字完成 → 回车」之间，
   * 上一轮结束到下一轮开始原本是 0 间隔。0 = 关闭。
   */
  turnGapMinMs: number
  turnGapMaxMs: number
  /**
   * 连续发满多少轮后强制长休（0 表示关闭）。真人不会连着几十轮零休息地发消息，
   * 长任务中途插一段静默能明显降低"机器密度"判定。区间见 longRunPauseMinMs/MaxMs。
   * "连续" 按 10 分钟内仍有请求活动判定：超过 10 分钟没有请求即视为断开并重新计数。
   */
  longRunAfterSends: number
  longRunPauseMinMs: number
  longRunPauseMaxMs: number
  /** 多久注入一次控制协议快照（按轮数）。 */
  protocolRefreshEvery: number
  /** 是否每一轮都注入协议与工具清单（默认开，防止网页会话上下文丢失后模型退化成普通聊天）。 */
  protocolEveryRequest: boolean
  /** 免费通道暴露给网页模型的工具白名单；空数组表示不限制。 */
  toolAllowlist: string[]
  /** 免费通道不暴露给网页模型的工具名（需要独立 API key 等）；在白名单之后生效。 */
  excludeToolNames: string[]
  /** 工具目录使用精简描述（名称 + 一句用途 + 必填参数），默认开。 */
  compactToolCatalog: boolean
  /**
   * 工具目录的字符预算（0 表示不限制，默认 28000）。
   *
   * 目录每轮随协议整段下发；工具多、或关掉 compactToolCatalog 时会涨到十几万字符，
   * 既拖慢网页输入框填字，也把真实任务挤掉。超预算时目录末尾会**列出被省略的工具名**
   * ——静默砍掉工具会让模型表现成「不会用工具」，比直接报错更难查。
   */
  maxToolCatalogChars: number
  /** 单个工具结果送入网页模型的最大字符数，超出按头尾截断；不限制最终正文。 */
  maxToolResultChars: number
  /** 任务锚点最大字符数，防止超长任务每轮重复灌入。 */
  maxGoalChars: number
  /**
   * 全量回放历史时单条消息的字符预算（0 表示不限制）。
   *
   * 网页输入框填字代价随文本长度接近二次方增长（实测 30 万字符约 13 秒、60 万约 77 秒、
   * 110 万字符会把浏览器主线程拖死数分钟），而响应等待窗口只有 3 分钟。长任务一旦触发
   * 全量回放就会稳定超时，所以这里给回放文本设上限，超出时丢弃最早的历史并留下省略说明。
   */
  maxReplayChars: number
  /**
   * 长文本转文件附件：单条消息超过 `longTextFileThreshold` 时，把正文写成 .md
   * 文件挂进网页输入框，正文只留摘要与「请读取附件」的说明，规避长文本填字接近
   * 二次方增长的耗时。上传失败时回退为直接填完整正文。
   */
  longTextAsFile: boolean
  /** 触发长文本转文件的字符数（默认 120000，下限 10000）。 */
  longTextFileThreshold: number
  /**
   * 可选审核通道（Kimi / GLM 独立审核，或 DeepSeek 同对话自审）。
   * 网页模型的模型菜单还会公布「审核关 / 跟随设置 / 审核开」三档；
   * `review.enabled` 是「跟随设置」档位读取的默认值。
   */
  review: ReviewConfig
  /**
   * GLM 网页通道（第二个主模型 provider）。
   * 模型 GLM-5.3 / GLM-5.3-Flash，思考强度三档由 DSH 模型菜单控制。
   */
  glmWeb: GlmWebConfig
  /**
   * 豆包网页通道（第二个主模型 provider）。
   * 默认关闭；开启后模型列表出现 `doubao-web` / `doubao-web-auto`。
   */
  doubao: DoubaoConfig
  /** 模型疑似想调工具但输出无法解析时，自动注入纠错并请求重试一次。 */
  autoCorrectMalformed: boolean
  /** 官方压缩模板的摘要语言；host 保留宿主原始要求。 */
  compactionLanguage: 'task' | 'host' | 'zh' | 'en'
  /**
   * 网页委托工具（提示词代执行）：目录里声明给网页模型，调用不本地执行，
   * 而是转成下一轮提示词交给网页端自带能力完成（如 web_search / web_fetch）。
   */
  delegatedTools: string[]
}

/**
 * 兼容垫片：给 schema 打上 volatile 标记。
 *
 * `.volatile()` 需要 schemastery ≥ 3.18.4（`Schema.prototype.volatile` 就是
 * `extra('volatile', true)`）。当模块解析到 3.18.2（本仓库 vendored 副本、
 * 0.1.5 宿主的 node_modules）时该方法不存在，直接链式调用会在模块加载时
 * 抛 `volatile is not a function`，插件整体无法启动。这里按可用性降级：
 *
 * 1. 原生 `.volatile()`（3.18.4+）：完整语义，运行期解析为 `Volatile<T>` 引用，
 *    由 `liveConfig()` 在 `apply()` 边界透明化解引用；
 * 2. `extra('volatile', true)`（3.18.2 也有）：只设置 `meta.volatile` 标记，
 *    值保持普通对象——0.1.5 宿主没有 0.2 的 volatile 投影机制，普通值即正确行为。
 *
 * dsh 0.2 的设置服务用 `volatileForm()` 只保留 `schema.meta.volatile` 的叶子字段，
 * 因此“表单可见的字段必须经本助手标记”这一约定与原生 `.volatile()` 一致。
 */
function markVolatile<T extends { volatile?: () => unknown; extra?: (key: 'volatile', value: boolean) => unknown }>(schema: T): T {
  if (typeof schema.volatile === 'function') return schema.volatile() as T
  if (typeof schema.extra === 'function') return schema.extra('volatile', true) as T
  // schemastery 的 `meta` 是 `Meta<T>`（带泛型参数的接口），不是 `Record<string, unknown>`；
  // 把它写进泛型约束会让所有 `Schema<...>` 入参都不满足约束（71 处 TS2345）。
  // 这里只在赋值点做一次断言，语义不变。
  const target = schema as { meta?: Record<string, unknown> }
  target.meta = { ...target.meta, volatile: true }
  return schema
}

/**
 * 插件配置 schema。
 *
 * ⚠️ **表单可见的字段必须经 `markVolatile()` 标记（见上）。**
 *
 * dsh 0.2 的设置服务在 `SettingsForms.describe()` 里用 `volatileForm()` 过滤字段
 * （见 `@deepseek-ai/dsh-settings` 的 `lib/index.js`）：
 *
 * ```js
 * function volatileForm(schema) {
 *   if (schema.meta.volatile) return plainSchema(schema);   // 只有 volatile 叶子保留
 *   if (schema.type === 'object') { ...递归... }            // 对象含存活子字段则保留
 *   // 其余标量 / 数组 / union → undefined，被丢弃
 * }
 * ```
 *
 * 被丢弃的字段不会进入表单；若一个 entry 的字段全被丢弃，该 entry 连
 * `settings.describe().namespaces` 都不出现，插件配置页拿到的 `form` 就是 `undefined`。
 *
 * **代价**：原生 `.volatile()` 标记的字段在运行期解析为引用对象（`Volatile<T>`），
 * 真值要 `.get()`。本插件在 `apply()` 边界用 `liveConfig()` 的 Proxy 统一透明化，
 * 因此内部代码仍按普通值读写，同时保留 Loader 的原地热更新语义。
 * 降级路径（`extra` / meta 直标）没有引用对象，`liveConfig()` 原样放行普通值。
 *
 * 未标记的字段保持普通值，只受 fiber 重启影响；它们不出现在配置页里，
 * 需要调整时改 profile 的 `cordis.patch.yml`。
 */
const schema = z.object({
  // 界面语言：只作用于本插件的两处配置界面。
  // 必须标 volatile，否则不会进入宿主可写命名空间，设置页看不到这个下拉框。
  uiLanguage: markVolatile(z.union(['auto', 'zh', 'en']).default('auto')),
  url: markVolatile(z.string().default('https://chat.deepseek.com')),
  // 默认由插件启动独立浏览器；attach 保留给需要复用外部 CDP 浏览器的高级用户。
  // browser/channel/profileDir 在通道构造时读取（见 playwright-channel.ts），
  // 因此设置页改完要重启 DSH 才生效；标 volatile 是为了让它们可写进 profile patch。
  browser: markVolatile(z.union(['managed', 'attach']).default('managed')),
  channel: markVolatile(z.union(['msedge', 'chrome']).default('msedge')),
  debugPort: markVolatile(z.number().step(1).min(1024).max(65535).default(9333)),
  autoStartKeeper: z.boolean().default(true),
  stateFile: z.string(),
  // 空串 = 用运行时默认目录（%LOCALAPPDATA%\DshDeepSeekWeb\edge-profile）。
  // 必须带默认值：设置表单的 schema 里必填字段缺失会让客户端 decode 失败。
  profileDir: markVolatile(z.string().default('')),
  sendMode: markVolatile(z.union(['manual', 'approved']).default('manual')),
  model: markVolatile(z.union([...WEB_MODEL_IDS]).default('deepseek-web')),
  selectors: z.dict(z.string()),
  streamIdleTimeoutMs: z.number().step(1).min(1).default(600_000),
  rateLimit: z.object({
    enabled: markVolatile(z.boolean().default(true)),
    // 默认指数退避：60s → 120s → 240s → 300s（封顶），合计约 12 分钟，
    // 覆盖实测最常见的 10~15 分钟冷却窗口。固定 30s×5 只够 2.5 分钟，
    // 等于在冷却期里再硬撞 5 次（docs/RISK-CONTROL.md）。
    retryDelayMs: markVolatile(z.number().step(1).min(1_000).default(60_000)),
    maxRetries: markVolatile(z.number().step(1).min(0).default(4)),
    backoff: markVolatile(z.union(['fixed', 'exponential']).default('exponential')),
    retryMaxDelayMs: markVolatile(z.number().step(1).min(1_000).default(300_000)),
    jitterRatio: markVolatile(z.number().step(0.01).min(0).max(0.5).default(0.15)),
    // 账号级冷却：网页判频控后整账号停手。默认 10 分钟，对齐实测 10~15 分钟冷却窗口；
    // 0 = 关闭（只有本回合退避，其它会话继续打网页——那正是最容易触发 1 天封禁的形态）。
    accountCooldownMs: markVolatile(z.number().step(1).min(0).max(3_600_000).default(600_000)),
  }).default({}),
  serverBusy: z.object({
    enabled: markVolatile(z.boolean().default(true)),
    // 15s 起、翻倍、120s 封顶：后端抖动通常几十秒到两分钟恢复，等太久只是让用户干坐着。
    retryDelayMs: markVolatile(z.number().step(1).min(1_000).default(15_000)),
    maxRetries: markVolatile(z.number().step(1).min(0).default(4)),
    backoff: markVolatile(z.union(['fixed', 'exponential']).default('exponential')),
    retryMaxDelayMs: markVolatile(z.number().step(1).min(1_000).default(120_000)),
    jitterRatio: markVolatile(z.number().step(0.01).min(0).max(0.5).default(0.2)),
  }).default({}),
  notify: z.object({
    enabled: markVolatile(z.boolean().default(true)),
    session: markVolatile(z.boolean().default(true)),
    review: markVolatile(z.boolean().default(true)),
    send: markVolatile(z.boolean().default(true)),
    receive: markVolatile(z.boolean().default(true)),
    errors: markVolatile(z.boolean().default(true)),
    browser: markVolatile(z.boolean().default(true)),
  }).default({}),
  browserRecovery: z.object({
    enabled: markVolatile(z.boolean().default(true)),
    // 默认 2 次：手滑关窗一次就该恢复；连续两次还关，说明不是事故而是脚本在反复杀进程，
    // 继续兜只会把真正的报错藏掉。
    maxAttempts: markVolatile(z.number().step(1).min(0).max(5).default(2)),
    delayMs: markVolatile(z.number().step(1).min(0).max(60_000).default(2_000)),
  }).default({}),
  archiveCleanup: z.object({
    // 默认开：用户要的就是“归档即删网页端对话”；关掉后只归档，统计里会记为待清理。
    deleteOnArchive: markVolatile(z.boolean().default(true)),
    // 默认开：一个 dsh 会话可能因上下文轮换产生多条网页对话，归档时一起清掉。
    includeRotatedChats: markVolatile(z.boolean().default(true)),
  }).default({}),
  liveThinking: markVolatile(z.boolean().default(false)),
  maxReplyBytes: z.number().step(1).min(1024).default(4 * 1024 * 1024),
  // 容量声明：默认 1M 上下文 / 300k 输出，依据附件通道实测（中文约 154 万字符、
  // 英文约 400 万字符可完整读入，折算约 100 万 token）。设置页可改，影响宿主的
  // 压缩阈值：min(contextWindow × 0.8, contextWindow − maxTokens − 65536)，
  // 且需满足 maxTokens + 65536 < contextWindow，否则宿主拒绝执行自动压缩。
  contextWindow: markVolatile(z.number().step(1).min(8_000).max(4_000_000).default(1_000_000)),
  maxTokens: markVolatile(z.number().step(1).min(256).max(1_000_000).default(300_000)),
  // 图片直传：默认开（本机单人自用，装完即可像网页版一样直接发图）；关闭即退回纯文本标记。
  enableImageUpload: markVolatile(z.boolean().default(true)),
  maxImagesPerTurn: markVolatile(z.number().step(1).min(0).max(32).default(4)),
  uploadTimeoutMs: markVolatile(z.number().step(1).min(1_000).default(60_000)),
  uploadOnError: markVolatile(z.union(['fallback-text', 'abort']).default('fallback-text')),
  /**
   * 长文本转文件附件：单条消息超过阈值时，把正文写成 .md 文件挂进网页输入框，
   * 正文只留摘要与"请读取附件"的说明。
   *
   * 起因是网页输入框填字接近二次方级耗时（实测 30 万字符约 13 秒、60 万约 77 秒、
   * 110 万会把页面主线程拖死数分钟）。网页端 file input 的 accept 列表包含
   * `.txt/.md/.csv/.json/.log` 等文本格式，所以长正文可以走附件通道，让网页端
   * 自己解析成上下文。上传失败时通道会回退为直接填完整正文（慢但内容不丢）。
   */
  longTextAsFile: markVolatile(z.boolean().default(true)),
  /** 触发长文本转文件的字符数。10 万字符填字约 1 秒，12 万起才明显；低于该值不折腾。 */
  longTextFileThreshold: markVolatile(z.number().step(1).min(10_000).default(120_000)),
  maxSessionPages: markVolatile(z.number().step(1).min(1).max(8).default(3)),
  turnTimeoutMs: z.number().step(1).min(0).default(900_000),
  lockLeaseMs: z.number().step(1).min(0).default(4_500_000),
  maxStreamMs: z.number().step(1).min(0).default(3_600_000),
  maxConcurrentTurns: markVolatile(z.number().step(1).min(0).max(64).default(1)),
  sendPauseMinMs: markVolatile(z.number().step(1).min(0).max(60_000).default(2_000)),
  sendPauseMaxMs: markVolatile(z.number().step(1).min(0).max(60_000).default(4_000)),
  // 回合间隔：上一轮网页回合**结束**到下一轮真正发请求之间的随机等待（0 = 关闭）。
  // 与 sendPause 的区别是计时起点：sendPause 只夹在"填字完成 → 回车"之间，
  // 上一轮结束到下一轮开始原本是 0 间隔——长任务连续续跑时，节拍就是 0 秒一条。
  turnGapMinMs: markVolatile(z.number().step(1).min(0).max(600_000).default(2_000)),
  turnGapMaxMs: markVolatile(z.number().step(1).min(0).max(600_000).default(4_000)),
  longRunAfterSends: markVolatile(z.number().step(1).min(0).max(10_000).default(15)),
  // 长休区间默认 30–60 秒（下限 30 秒、上限 60 秒）：连发 N 轮后静默一小段就足以打断节拍，
  // 旧默认 60–180 秒会让长链路任务白等最多 3 分钟。
  longRunPauseMinMs: markVolatile(z.number().step(1).min(0).max(3_600_000).default(30_000)),
  longRunPauseMaxMs: markVolatile(z.number().step(1).min(0).max(3_600_000).default(60_000)),
  protocolRefreshEvery: markVolatile(z.number().step(1).min(1).default(8)),
  // 默认开：网页会话在长时间任务里会丢上下文（模型退化成普通聊天、忘记 JSON 动作格式），
  // 靠“每 N 轮刷新一次”补不回来。每轮多带协议 + 工具目录（默认精简目录约 1k 字符），
  // 换网页端行为稳定；嫌提示词长的可以在设置页关掉，退回按 protocolRefreshEvery 刷新。
  protocolEveryRequest: markVolatile(z.boolean().default(true)),
  toolAllowlist: markVolatile(z.array(z.string()).default([
    'read',
    'write',
    'edit',
    'str_replace_editor',
    'glob',
    'grep',
    'bash',
    'pwsh',
    'todo_write',
  ])),
  excludeToolNames: markVolatile(z.array(z.string()).default(['web_search'])),
  compactToolCatalog: z.boolean().default(true),
  maxToolResultChars: markVolatile(z.number().step(1).min(256).default(6_000)),
  // 工具目录预算：默认 28000 字符（约 8000 token 量级的常驻成本）。
  // 0 = 不限制；超预算时目录末尾会列出被省略的工具名（见 protocol.ts）。
  maxToolCatalogChars: markVolatile(z.number().step(1).min(0).default(28_000)),
  maxGoalChars: z.number().step(1).min(64).default(2_000),
  maxReplayChars: z.number().step(1).min(0).default(400_000),
  // 登录态主动探活：只读检查（不发送、不消耗额度），默认启动后 20 秒探一次，之后每 30 分钟一次。
  // 浏览器没启动时只报 unknown，绝不为了探活把浏览器拉起来。
  loginProbe: z.object({
    enabled: markVolatile(z.boolean().default(true)),
    initialDelayMs: markVolatile(z.number().step(1).min(0).max(600_000).default(20_000)),
    // 0 = 只在启动后探一次。
    intervalMs: markVolatile(z.number().step(1).min(0).max(86_400_000).default(1_800_000)),
  }).default({}),
  focus: z.object({
    enabled: markVolatile(z.boolean().default(true)),
    webWindow: markVolatile(z.boolean().default(true)),
    dshWindow: markVolatile(z.boolean().default(true)),
    dshProcessNames: z.array(z.string()).default(['electron', 'dsh', 'DeepSeek Harness']),
    dshTitlePattern: z.string().default('DeepSeek Harness|dsh'),
  }).default({}),
  glmWeb: z.object({
    url: markVolatile(z.string().default('https://chatglm.cn/')),
    // 9337：避开 GLM 审核的 9335 与豆包的 9336，三个通道可同时常驻。
    debugPort: markVolatile(z.number().step(1).min(1024).max(65535).default(9337)),
    // 空串 = 运行时默认目录（%LOCALAPPDATA%\DshDeepSeekWeb\glm-web-profile）。
    profileDir: markVolatile(z.string().default('')),
    autoSend: markVolatile(z.boolean().default(true)),
    // 15 分钟：极致档位长任务（实测 41k 字 HTML 用了 9 分 16 秒）留足余量。
    ackTimeoutMs: markVolatile(z.number().step(1000).min(10_000).max(1_800_000).default(900_000)),
  }).default({}),
  doubao: z.object({
    // 默认关闭：新增通道不该改变现有 deepseek-web 用户看到的模型列表。
    enabled: markVolatile(z.boolean().default(false)),
    url: markVolatile(z.string().default('https://www.doubao.com/chat')),
    // 空串 = 运行时默认目录（%LOCALAPPDATA%\DshDeepSeekWeb\doubao-profile）。
    profileDir: markVolatile(z.string().default('')),
    debugPort: markVolatile(z.number().step(1).min(1024).max(65535).default(9336)),
    ackTimeoutMs: markVolatile(z.number().step(1).min(5_000).default(120_000)),
    replyTimeoutMs: markVolatile(z.number().step(1).min(10_000).default(600_000)),
    maxSessionPages: markVolatile(z.number().step(1).min(1).max(16).default(4)),
    autoStartKeeper: z.boolean().default(true),
  }).default({}),
  review: z.object({
    enabled: markVolatile(z.boolean().default(false)),
    provider: markVolatile(z.union(['kimi', 'deepseek-web', 'glm']).default('kimi')),
    // 审核默认全自动发送：审核是自动化流程，要求人工点发送会让整轮审核空等。
    autoSend: markVolatile(z.boolean().default(true)),
    // 审核默认每次新开对话：审核 prompt 自带全部证据，复用历史只会越审越慢。
    conversationMode: markVolatile(z.union(['fresh', 'reuse']).default('fresh')),
    sendVerifyMs: markVolatile(z.number().step(1).min(100).default(1_500)),
    sendRetries: markVolatile(z.number().step(1).min(1).max(5).default(2)),
    fetchRetries: markVolatile(z.number().step(1).min(0).max(3).default(1)),
    // 两种模式各用各的地址，互不兜底：选错模式会立刻报错，而不是静默走错页面。
    kimiMode: markVolatile(z.union(['normal', 'project']).default('normal')),
    // 默认就是「新会话入口」：通道会直接打开这个链接当审核窗口。
    url: markVolatile(z.string().default('https://www.kimi.com/?chat_enter_method=new_chat')),
    // 项目模式默认留空：各人的项目 ID 不同，不能替用户猜一个。
    // 只填 ID 即可，完整项目页链接也认；拼接逻辑在 KimiBrowserChannel.toProjectUrl()。
    projectUrl: markVolatile(z.string().default('')),
    debugPort: z.number().step(1).min(1024).max(65535).default(9334),
    profileDir: z.string(),
    // 审核通道（Kimi/GLM）读流的等待上限，保持 10 分钟：审核要输出整段评语，
    // 压到几十秒会把正常审核打成超时。首响应另封顶 2 分钟（见 glm-channel/kimi-channel），
    // 所以“卡住不动”不会白等满 10 分钟。
    streamIdleTimeoutMs: z.number().step(1).min(1).default(600_000),
    maxEvidenceChars: z.number().step(1).min(1_000).default(60_000),
    maxRounds: markVolatile(z.number().step(1).min(0).default(1)),
    glmUrl: markVolatile(z.string().default('https://chat.z.ai/')),
    glmDebugPort: z.number().step(1).min(1024).max(65535).default(9335),
    glmProfileDir: z.string(),
    // GLM 审核的模型与思考强度：默认用旗舰 + 深度，避免 Flash/低强度审得太浅。
    glmModel: markVolatile(z.union(['glm-5.3', 'glm-5.3-flash']).default('glm-5.3')),
    glmEffort: markVolatile(z.union(['low', 'high', 'max']).default('high')),
  }).default({}),
  autoCorrectMalformed: z.boolean().default(true),
  compactionLanguage: markVolatile(z.union(['task', 'host', 'zh', 'en']).default('task')),
  delegatedTools: markVolatile(z.array(z.string()).default(['web_search', 'web_fetch'])),
})

/**
 * Loader 面向的 schema。标了 `.volatile()` 的字段在该类型里其实是 `Volatile<T>`；
 * 这里断言成普通值形状，因为 `apply()` 边界会用 `liveConfig()` 把它还原成普通对象。
 */
export const Config = schema as unknown as z<Config>

// 说明：dsh 0.2 起设置表单由插件自身的 Config schema 自动投影
// （SettingsForms.describe()，条目键为 profile 里的插件 entry id），
// 插件不再注册自定义命名空间。因此审核、模型与工具白名单等偏好
// 统一由本文件的 Config 字段承载，0.1 时代的 REVIEW_SETTINGS_NS /
// GENERAL_SETTINGS_NS / UsageSettingsSchema 已随 installSection 一同移除。
