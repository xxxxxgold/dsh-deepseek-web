/**
 * 豆包网页版 provider 的适配器 profile。
 *
 * 与 DeepSeek 的差别：
 * - 两个模型 id 的差别是发送方式（半自动 / 全自动），不是不同模型；
 * - 快速/专家模式由用户在豆包网页端自行设置，插件不切换、不校验；
 * - 一期只支持纯文本与工具调用：不声明 image、不启用长文本转文件、不公布审核三档。
 *
 * @module dsh-deepseek-web/doubao-provider
 */

import type { AdapterProfile } from './adapter.ts'
import { DOUBAO_MODEL_CAPABILITIES, DOUBAO_MODEL_IDS, DOUBAO_WEB_PROVIDER } from './web-models.ts'
import path from 'node:path'

export interface DoubaoWebProfileOptions {
  /** 独立的会话状态文件，避免与 DeepSeek 的会话游标互相覆盖。 */
  stateFile: string
}

export function createDoubaoWebProfile(options: DoubaoWebProfileOptions): AdapterProfile {
  return {
    providerId: DOUBAO_WEB_PROVIDER,
    providerName: '豆包网页版',
    models: DOUBAO_MODEL_IDS.map(id => ({
      id,
      label: DOUBAO_MODEL_CAPABILITIES[id].label,
      autoSend: id === 'doubao-web-auto',
    })),
    normalizeModel: model => (DOUBAO_MODEL_IDS as readonly string[]).includes(model) ? model : undefined,
    stateFile: options.stateFile,
    ledgerFile: path.join(path.dirname(options.stateFile), 'doubao-call-ledger.json'),
    logPrefix: 'doubao',
    imageSupport: 'none',
    reviewTiers: false,
    supportsLongTextFile: false,
    modelDescription: '通过你的豆包网页账号对话；快速/专家模式由网页端自行设置。一期仅支持文本与工具调用。',
  }
}
