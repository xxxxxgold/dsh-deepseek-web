/**
 * GLM 网页版 provider 的适配器 profile。
 *
 * 与 DeepSeek 的差别：
 * - 模型 id 是真实模型（`glm-5.3` / `glm-5.3-flash`），不是发送方式；
 * - 「推理等级」三档是真实思考强度（快速/深度/极致），不是审核开关；
 * - 一期只支持纯文本：不声明 image、不启用长文本转文件。
 *
 * @module dsh-deepseek-web/glm-provider
 */

import type { AdapterProfile } from './adapter.ts'
import {
  GLM_WEB_DEFAULT_REASONING_EFFORT,
  GLM_WEB_MODEL_IDS,
  GLM_WEB_MODEL_NAMES,
  GLM_WEB_PROVIDER,
  GLM_WEB_REASONING_EFFORTS,
} from './web-models.ts'

export interface GlmWebProfileOptions {
  /** 主通道是否自动发送（设置页 glmWeb.autoSend）。 */
  autoSend: boolean
  /** 独立的会话状态文件，避免与 DeepSeek 互相覆盖。 */
  stateFile: string
  /** 独立的调用台账文件，避免两个适配器同时写同一份 JSON。 */
  ledgerFile?: string
}

export function createGlmWebProfile(options: GlmWebProfileOptions): AdapterProfile {
  return {
    providerId: GLM_WEB_PROVIDER,
    providerName: 'GLM 网页版',
    models: GLM_WEB_MODEL_IDS.map(id => ({
      id,
      label: GLM_WEB_MODEL_NAMES[id],
      autoSend: options.autoSend,
    })),
    normalizeModel: model => (GLM_WEB_MODEL_IDS as readonly string[]).includes(model) ? model : undefined,
    stateFile: options.stateFile,
    ...options.ledgerFile === undefined ? {} : { ledgerFile: options.ledgerFile },
    logPrefix: 'glm',
    imageSupport: 'none',
    reviewTiers: false,
    reasoning: {
      efforts: GLM_WEB_REASONING_EFFORTS.map(effort => ({ id: effort.id, name: effort.name })),
      defaultEffort: GLM_WEB_DEFAULT_REASONING_EFFORT,
    },
    supportsLongTextFile: false,
    modelDescription: '通过你的 GLM 网页账号对话；模型与思考强度由 DSH 模型菜单切换。',
  }
}
