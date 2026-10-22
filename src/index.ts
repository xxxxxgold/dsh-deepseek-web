/**
 * dsh-deepseek-web 插件入口。
 *
 * dsh 0.2 的插件配置界面由客户端半侧注册 `plugins.row.config` 槽位提供；
 * 而字段能被设置服务投影进表单的前提，是它们在 `Config` schema 里标了 `.volatile()`
 * （详见 `config.ts` 顶部的说明）。volatile 字段在运行期是引用对象，
 * 因此这里先用 `liveConfig()` 把配置透明化成普通值视图再交给下游 ——
 * 内部代码照旧按普通值读取，同时保留 Loader 的原地热更新语义。
 *
 * @module dsh-deepseek-web
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { Config as ConfigSchema, PROVIDER } from './config.ts'
import { BUILD, writeLoadStamp } from './build-info.ts'
import { liveConfig } from './live-config.ts'
import { DeepSeekWebAdapter, type ReadImageAttachment } from './adapter.ts'
import { PlaywrightBrowserChannel } from './playwright-channel.ts'
import { KimiBrowserChannel } from './kimi-channel.ts'
import { GLMChannel } from './glm-channel.ts'
import { DeepSeekSelfReviewer, GlmReviewer, KimiReviewer } from './reviewer.ts'

export const name = 'llm-deepseek-web'
export const inject = ['llm']

/** 宿主附件服务的最小形状（只用到读图）；不去依赖 dsh-attachment 的类型导出。 */
interface AttachmentStoreLike {
  readImage(ref: unknown): Promise<{ data: Uint8Array }>
}

/** MIME → 扩展名，仅用于给没有原文件名的图片起个可读名字。 */
function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

/**
 * 把宿主的 AttachmentStore 绑成适配层要的读图函数。
 *
 * 不写进 `inject`：老宿主（0.1）没有 attachments 服务，加进必需依赖会让整个插件
 * 不加载；改成运行时探测，拿不到就返回 undefined，图片直传自动退回文本标记。
 */
function bindImageReader(ctx: Context): ReadImageAttachment | undefined {
  let store: AttachmentStoreLike | undefined
  try {
    store = (ctx as unknown as { attachments?: AttachmentStoreLike }).attachments
  } catch {
    return undefined
  }
  if (!store || typeof store.readImage !== 'function') {
    console.info('[llm-deepseek-web] 宿主未提供附件服务，图片将退回文本标记。')
    return undefined
  }
  const resolved = store
  return async (ref) => {
    const stored = await resolved.readImage(ref)
    return {
      name: ref.name ?? `image.${extensionForMediaType(ref.mediaType)}`,
      mimeType: ref.mediaType,
      data: stored.data,
    }
  }
}

export { ConfigSchema as Config }

/**
 * 装配免费网页版主通道与可选审核通道。
 *
 * @param ctx - 插件上下文；`llm` 由 `inject` 保证就绪。
 * @param config - Loader 传入的配置；标 `.volatile()` 的字段此时是引用对象。
 */
export function apply(ctx: Context, config: Config): void {
  const live = liveConfig(config)
  const channel = new PlaywrightBrowserChannel({ config: live })
  const kimiChannel = new KimiBrowserChannel({ config: live.review, focus: live.focus })
  const glmChannel = new GLMChannel({ config: live.review, focus: live.focus })
  const kimiReviewer = new KimiReviewer(kimiChannel, live.review)
  const glmReviewer = new GlmReviewer(glmChannel, live.review)
  const selfReviewer = new DeepSeekSelfReviewer(channel)

  // 审核器按当前配置选择：kimi/glm = 独立窗口审核，deepseek-web = 同对话自审
  const reviewer = {
    get needsEvidence(): boolean {
      return live.review.provider !== 'deepseek-web'
    },
    // 必须把第二个参数原样转发：同对话自审靠它把文本写回发起审阅的那个网页对话，
    // 这里吞掉会导致多会话并行时自审写进子代理的页（表现为“审的内容对不上”）。
    review: (
      evidence: { task: string; artifact: string; files: string[] },
      options?: { conversationSessionId?: string },
    ) => {
      switch (live.review.provider) {
        case 'kimi': return kimiReviewer.review(evidence, options)
        case 'glm': return glmReviewer.review(evidence, options)
        default: return selfReviewer.review(evidence, options)
      }
    },
  }

  const adapter = new DeepSeekWebAdapter(live, channel, reviewer, (totals) => {
    console.info(
      `[llm-deepseek-web] 通道 token 累计：${totals.totalTokens} tokens / ${totals.usageTurns} 轮`,
    )
  }, bindImageReader(ctx))

  ctx.effect(() => {
    const unregister = ctx.llm.registerAdapter([PROVIDER], adapter)
    return () => {
      unregister()
      void channel.dispose().catch(() => {})
      void kimiChannel.dispose().catch(() => {})
      void glmChannel.dispose().catch(() => {})
    }
  }, 'llm-deepseek-web')

  ctx.logger.info(
    `[llm-deepseek-web] provider "${PROVIDER}" registered`
    + ` (browser=${live.browser}, sendMode=${live.sendMode},`
    + ` review=${live.review.enabled ? live.review.provider : 'off'},`
    + ` imageUpload=${live.enableImageUpload ? 'on' : 'off'})`,
  )

  // 构建身份：重启后据此确认宿主加载的是哪一份产物，而不是靠「我重启过了」猜。
  const stamp = writeLoadStamp()
  ctx.logger.info(
    `[llm-deepseek-web] 构建标识 ${BUILD}（加载文件：${stamp ?? '加载戳写入失败'}）`,
  )
}
