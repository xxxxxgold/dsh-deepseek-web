/**
 * 网页版模型清单（Host 与 Client 半侧共享的最小事实表）。
 * 独立于 config.ts：客户端 bundle 的纯净度门禁禁止把 schemastery 等配置层依赖打进浏览器产物。
 *
 * @module dsh-deepseek-web/web-models
 */

/**
 * 网页版模型清单。DeepSeek 网页端已把极速/专家/识图合并为一个入口，
 * 模式与联网开关由页面自身管理。两个 id 的差别在发送方式：
 * - deepseek-web：半自动——填入消息后由用户人工点击发送
 * - deepseek-web-auto：全自动——填入消息后模拟回车自动发送
 */
export const WEB_MODEL_IDS = ['deepseek-web', 'deepseek-web-auto'] as const
export type WebModelId = typeof WEB_MODEL_IDS[number]

/** 网页版模型能力说明（模式由页面控制，字段仅用于展示）。 */
export interface WebModelCapability {
  /** 页面默认提供深度思考能力。 */
  thinking: boolean
  /** 页面默认提供联网搜索能力。 */
  search: boolean
  /** 页面展示名。 */
  label: string
}

export const WEB_MODEL_CAPABILITIES: Record<WebModelId, WebModelCapability> = {
  'deepseek-web': { thinking: true, search: true, label: 'DeepSeek 网页版（半自动）' },
  'deepseek-web-auto': { thinking: true, search: true, label: 'DeepSeek 网页版（全自动）' },
}

/**
 * 豆包网页通道的模型清单。
 *
 * 与 DeepSeek 一样，两个 id 的差别只在发送方式：
 * - `doubao-web`：半自动——填入消息后由用户点击发送
 * - `doubao-web-auto`：全自动——填入后模拟回车自动发送
 * 快速/专家模式由用户在豆包网页端自行设置，插件不切换、不校验。
 */
export const DOUBAO_MODEL_IDS = ['doubao-web', 'doubao-web-auto'] as const
export type DoubaoModelId = typeof DOUBAO_MODEL_IDS[number]

/** 豆包 provider id（独立于 DeepSeek，与 GLM 的 glm-web 同级）。 */
export const DOUBAO_WEB_PROVIDER = 'doubao-web'

export const DOUBAO_MODEL_CAPABILITIES: Record<DoubaoModelId, WebModelCapability> = {
  'doubao-web': { thinking: true, search: true, label: '豆包网页版（半自动）' },
  'doubao-web-auto': { thinking: true, search: true, label: '豆包网页版（全自动）' },
}

/**
 * 网页模型在 DSH 模型菜单「推理等级」里公布的审核档位。
 *
 * 这不是真正的思考强度：网页端的思考模式由页面自己控制，这三个 id 只是把
 * DSH 现成的会话级选择器借来当审核开关。`review-default` 表示跟随插件设置里的
 * `review.enabled`，因此默认档不会把开/关固定进会话。
 */
export const WEB_MODEL_REASONING_EFFORTS = [
  { id: 'review-off', name: '审核关' },
  { id: 'review-default', name: '跟随设置' },
  { id: 'review-on', name: '审核开' },
] as const

/** 网页模型审核档位的 id 联合类型。 */
export type WebModelReasoningEffortId = typeof WEB_MODEL_REASONING_EFFORTS[number]['id']

/** 网页模型的默认审核档位：跟随插件设置。 */
export const WEB_MODEL_DEFAULT_REASONING_EFFORT: WebModelReasoningEffortId = 'review-default'

/**
 * GLM 网页版（第二 provider）的模型清单。
 *
 * 与 DeepSeek 的两个 id 不同，这里的差异是**真实模型**，不是发送方式：
 * DSH 模型菜单会把它们列成「GLM 网页版」下的两个模型，每个模型再带三档思考强度。
 */
export const GLM_WEB_PROVIDER = 'glm-web'

export const GLM_WEB_MODEL_IDS = ['glm-5.3', 'glm-5.3-flash'] as const
export type GlmWebModelId = typeof GLM_WEB_MODEL_IDS[number]

/** 站点侧的模型名（chatglm.cn 与 z.ai 文案一致，留成字段便于将来改版）。 */
export const GLM_WEB_MODEL_NAMES: Record<GlmWebModelId, string> = {
  'glm-5.3': 'GLM-5.3',
  'glm-5.3-flash': 'GLM-5.3-Flash',
}

/**
 * GLM-5.3 系列的三档思考强度。
 *
 * `slider` 是 z.ai 滑杆的档位下标（0/1/2）；chatglm.cn 用中文菜单项。
 * 官方 API 对应 `reasoning_effort` 的 low / high / max。
 */
export const GLM_WEB_REASONING_EFFORTS = [
  { id: 'low', name: '快速', slider: 0 },
  { id: 'high', name: '深度', slider: 1 },
  { id: 'max', name: '极致', slider: 2 },
] as const

export type GlmWebReasoningEffortId = typeof GLM_WEB_REASONING_EFFORTS[number]['id']

/** 默认档位：深度（平衡质量与耗时；用户可在模型菜单里改）。 */
export const GLM_WEB_DEFAULT_REASONING_EFFORT: GlmWebReasoningEffortId = 'high'

/** 把任意字符串收敛成合法 GLM 档位；不认识时回退默认值。 */
export function normalizeGlmEffort(effort: string | undefined): GlmWebReasoningEffortId {
  const found = GLM_WEB_REASONING_EFFORTS.find(item => item.id === effort)
  return found ? found.id : GLM_WEB_DEFAULT_REASONING_EFFORT
}
