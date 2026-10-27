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
import { DoubaoBrowserChannel } from './doubao-channel.ts'
import { DOUBAO_WEB_PROVIDER, GLM_WEB_PROVIDER } from './web-models.ts'
import { createGlmWebProfile } from './glm-provider.ts'
import { createDoubaoWebProfile } from './doubao-provider.ts'
import { DeepSeekSelfReviewer, GlmReviewer, KimiReviewer } from './reviewer.ts'
import { defaultProfileDir } from './browser-shared.ts'
import { runDoctor } from './doctor.ts'
import { registerBridgeRoutes, type BridgeContext } from './ledger-route.ts'
import { registerLoginRoutes } from './login-route.ts'
import { registerDoubaoLoginRoutes } from './doubao-login-route.ts'
import { ArchiveCleanup, type ArchiveRegistryLike } from './archive-cleanup.ts'
import { registerArchiveCleanupRoutes } from './archive-cleanup-route.ts'
import { LoginProbeScheduler, summarizeLoginProbe, type LoginProbeStatus } from './login-probe.ts'
import os from 'node:os'
import path from 'node:path'

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
 * 必须在 `ctx.inject(['attachments'], …)` 的回调里调用：cordis 4 里**没有注入就去读
 * `ctx.attachments` 会直接抛** `cannot get property "attachments" without inject`。
 * 旧实现把这次访问包在 try/catch 里，异常被吞成 undefined，于是图片直传从插件启动
 * 那一刻起就永久降级成文本标记——图片再没进过网页输入框（本机 40+ 会话零个图片上传
 * 记录）。现在由调用方保证时机；这里只负责把拿到的 store 绑成读图函数，两种取法都试，
 * 服务确实不存在时返回 undefined（老宿主 0.1 仍能正常加载，图片退回文本标记）。
 */
export function bindImageReader(ctx: Context): ReadImageAttachment | undefined {
  let store: AttachmentStoreLike | undefined
  try {
    store = (ctx as unknown as { attachments?: AttachmentStoreLike }).attachments
  } catch {
    store = undefined
  }
  if (!store) {
    // 已 inject 时属性访问就是正路；`ctx.get` 兜住"服务存在但本层没声明注入"的场景。
    store = (ctx as unknown as { get?: (name: string) => unknown }).get?.('attachments') as
      AttachmentStoreLike | undefined
  }
  if (!store || typeof store.readImage !== 'function') {
    console.warn('[llm-deepseek-web] 附件服务缺少 readImage，图片将退回文本标记。')
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
  const glmChannel = new GLMChannel({ config: live.review, focus: live.focus, notify: live.notify })
  const kimiReviewer = new KimiReviewer(kimiChannel, live.review)
  const glmReviewer = new GlmReviewer(glmChannel, live.review)
  const selfReviewer = new DeepSeekSelfReviewer(channel)

  // 豆包是第二个独立 provider：只有 enabled 时才构造/注册，默认零副作用。
  const doubaoChannel = live.doubao.enabled
    ? new DoubaoBrowserChannel({ config: live })
    : undefined
  const doubaoProfile = doubaoChannel
    ? createDoubaoWebProfile({
        stateFile: path.join(
          path.dirname(live.stateFile || path.join(
            process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
            'DshDeepSeekWeb',
            'session-state.json',
          )),
          'doubao-session-state.json',
        ),
      })
    : undefined
  const doubaoAdapter = doubaoChannel && doubaoProfile
    ? new DeepSeekWebAdapter(live, doubaoChannel, undefined, undefined, undefined, doubaoProfile)
    : undefined

  // GLM 主通道：与审核通道分开的浏览器实例（不同 URL/端口/profile），
  // 模型与思考强度由 DSH 模型菜单的 reasoningEffort 驱动。
  const glmChatChannel = new GLMChannel({
    config: live.review,
    focus: live.focus,
    url: live.glmWeb.url,
    debugPort: live.glmWeb.debugPort,
    profileDir: live.glmWeb.profileDir || defaultProfileDir('glm-web-profile'),
    label: 'glm-web',
    maxPages: live.maxSessionPages,
    notify: live.notify,
    // 主通道放宽首响应等待：极致档位 + 长任务可能十几分钟才吐响应头。
    ackTimeoutMs: live.glmWeb.ackTimeoutMs,
  })
  const glmProfile = createGlmWebProfile({
    autoSend: live.glmWeb.autoSend,
    stateFile: path.join(
      path.dirname(live.stateFile || path.join(
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
        'DshDeepSeekWeb',
        'session-state.json',
      )),
      'glm-session-state.json',
    ),
    ledgerFile: path.join(
      path.dirname(live.stateFile || path.join(
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
        'DshDeepSeekWeb',
        'session-state.json',
      )),
      'glm-call-ledger.json',
    ),
  })
  const glmAdapter = new DeepSeekWebAdapter(live, glmChatChannel, undefined, undefined, undefined, glmProfile)

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

  /*
   * 图片直传的读图函数必须等宿主 `attachments` 服务就绪后再绑。
   *
   * cordis 4 里未注入直接读 `ctx.attachments` 会抛错；旧实现 try/catch 吞掉后读图函数
   * 永远是 undefined，`renderNewWebMessages` 于是一张图都不收集、界面也没提示——表现
   * 就是「多轮之后贴图没上传到网页版」。改成 `ctx.inject` 后：服务就绪才回调，服务卸载
   * 时回调重跑并把 reader 清空，adapter 每轮按实时状态判断能不能上传。
   */
  const imageReader: { current?: ReadImageAttachment } = {}
  ctx.inject(['attachments'], (sub) => {
    sub.effect(() => {
      const reader = bindImageReader(sub)
      imageReader.current = reader
      if (reader) console.info('[llm-deepseek-web] 已接上宿主附件服务，图片直传可用。')
      return () => {
        imageReader.current = undefined
      }
    }, 'llm-deepseek-web: image reader')
  })

  const adapter = new DeepSeekWebAdapter(live, channel, reviewer, (totals) => {
    console.info(
      `[llm-deepseek-web] 通道 token 累计：${totals.totalTokens} tokens / ${totals.usageTurns} 轮`,
    )
  }, () => imageReader.current)

  ctx.effect(() => {
    const unregister = ctx.llm.registerAdapter([PROVIDER], adapter)
    const unregisterDoubao = doubaoAdapter
      ? ctx.llm.registerAdapter([DOUBAO_WEB_PROVIDER], doubaoAdapter)
      : () => {}
    const unregisterGlm = ctx.llm.registerAdapter([GLM_WEB_PROVIDER], glmAdapter)
    return () => {
      unregister()
      unregisterDoubao()
      unregisterGlm()
      void channel.dispose().catch(() => {})
      void kimiChannel.dispose().catch(() => {})
      void glmChannel.dispose().catch(() => {})
      void glmChatChannel.dispose().catch(() => {})
      void doubaoChannel?.dispose().catch(() => {})
    }
  }, 'llm-deepseek-web')

  // 登录态主动探活：只读判断，不发送、不消耗额度。默认启动后 20 秒探一次、
  // 之后每 30 分钟一次；浏览器没起来时只记 unknown，绝不为了探活拉起浏览器。
  // 失效时走提示通道提醒一次——但**不阻塞发送**：探活是旁路，判断错了不该拦住用户。
  //
  // 调度器总是创建：设置页的「立即检测」走 probe.probeNow()，不受后台开关影响；
  // 只有 loginProbe.enabled 时才按间隔自动跑。
  // 探活本身只读；只有「从正常/未知变成过期」的那一刻才把登录页拉到前台，
  // 避免每 30 分钟重复抢焦点。首次探活就是过期时也会弹一次。
  let previousProbeStatus: LoginProbeStatus | undefined
  // 置前失败后允许下一次探活重试；成功或恢复非过期后清掉。
  let loginRevealFailed = false
  // attach 模式与 Windows 之外的平台不支持抢前台，不做“置前失败”误报。
  const canRevealLoginWindow = live.browser === 'managed' && process.platform === 'win32'
  const probe = new LoginProbeScheduler({
    target: channel,
    initialDelayMs: live.loginProbe.initialDelayMs,
    intervalMs: live.loginProbe.intervalMs,
    onResult: (result) => {
      const previous = previousProbeStatus
      previousProbeStatus = result.status
      if (result.status === 'expired') {
        ctx.logger.warn(`[llm-deepseek-web] ${summarizeLoginProbe(result)}；请在网页窗口重新登录。`)
        if (canRevealLoginWindow && (previous !== 'expired' || loginRevealFailed)) {
          loginRevealFailed = false
          void channel.revealLoginWindow().then((ok) => {
            if (!ok) {
              loginRevealFailed = true
              ctx.logger.warn('[llm-deepseek-web] 登录页置前失败：未找到窗口或未抢到前台焦点。')
            }
          }).catch((error: unknown) => {
            loginRevealFailed = true
            ctx.logger.warn(
              '[llm-deepseek-web] 登录页置前异常：'
              + (error instanceof Error ? error.message : String(error)),
            )
          })
        }
      } else {
        loginRevealFailed = false
        ctx.logger.info(`[llm-deepseek-web] ${summarizeLoginProbe(result)}`)
      }
    },
  })
  // GLM 主通道登录探活：只读，且不会为了探活拉起浏览器；结果供设置页的 GLM 卡片使用。
  const glmProbe = new LoginProbeScheduler({
    target: glmChatChannel,
    initialDelayMs: live.loginProbe.initialDelayMs,
    intervalMs: live.loginProbe.intervalMs,
    onResult: (result) => {
      if (result.status === 'expired') {
        ctx.logger.warn(`[llm-deepseek-web] GLM：${summarizeLoginProbe(result)}；请在 GLM 窗口重新登录。`)
      } else {
        ctx.logger.info(`[llm-deepseek-web] GLM：${summarizeLoginProbe(result)}`)
      }
    },
  })
  if (live.loginProbe.enabled) {
    ctx.effect(() => {
      probe.start()
      glmProbe.start()
      return () => {
        probe.stop()
        glmProbe.stop()
      }
    }, 'llm-deepseek-web: login probe')
  }

  // 设置页的「调用台账 / 自检」需要一个只读数据通道：台账落在本地文件里，
  // 浏览器半侧读不到文件系统。`webServer` 是可选的（headless / TUI 宿主没有），
  // 所以不写进 `inject`，改用可选注入——没有它时插件照常工作，只是看不到那张卡片。
  ctx.inject(['webServer'], (sub) => {
    const appDataRoot = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    const stateFile = live.stateFile || path.join(appDataRoot, 'DshDeepSeekWeb', 'session-state.json')
    // 台账和状态文件同目录（与 adapter 的取法一致），自定义 stateFile 时卡片才指得对。
    const ledgerFile = path.join(path.dirname(stateFile), 'call-ledger.json')
    const profileDir = live.profileDir || defaultProfileDir('edge-profile')
    sub.effect(
      () => registerBridgeRoutes(sub as unknown as BridgeContext, {
        readLedger: () => adapter.ledgerSummary(),
        readDoctor: wantLive => runDoctor({ config: live, profileDir, stateFile, live: wantLive }),
        ledgerFile,
        build: BUILD,
      }),
      'llm-deepseek-web: readonly bridge',
    )
    // 登录态卡片：状态、手动探活、打开登录窗口、导入/导出。
    // token 只在这个桥的请求体里出现，不落盘、不进日志。
    sub.effect(
      () => registerLoginRoutes(sub as unknown as BridgeContext, {
        current: () => {
          const last = probe.last()
          return {
            status: last?.status ?? 'unknown',
            ...last?.detail !== undefined ? { detail: last.detail } : {},
            ...last?.checkedAt !== undefined ? { checkedAt: last.checkedAt } : {},
            browserStarted: channel.isBrowserStarted?.() === true,
            canOpen: typeof channel.openLoginWindow === 'function',
            canImport: typeof channel.importLoginState === 'function',
            canExport: typeof channel.exportLoginState === 'function',
          }
        },
        probe: () => probe.probeNow(),
        open: async () => {
          if (typeof channel.openLoginWindow !== 'function') {
            throw new Error('当前浏览器通道不支持打开登录窗口')
          }
          return await channel.openLoginWindow()
        },
        importLogin: async (bundle) => {
          if (typeof channel.importLoginState !== 'function') {
            throw new Error('当前浏览器通道不支持导入登录态')
          }
          const applied = await channel.importLoginState(bundle)
          // 写完立即复检：让卡片直接显示「导入后到底登没登上」。
          const status = await probe.probeNow()
          return { status, applied }
        },
        exportLogin: async () => {
          if (typeof channel.exportLoginState !== 'function') {
            throw new Error('当前浏览器通道不支持导出登录态')
          }
          return await channel.exportLoginState()
        },
      }),
      'llm-deepseek-web: login routes',
    )
    // GLM 主通道的登录态卡片：同一套路由契约，独立前缀与独立探活器。
    sub.effect(
      () => registerLoginRoutes(
        sub as unknown as BridgeContext,
        {
          current: () => {
            const last = glmProbe.last()
            return {
              status: last?.status ?? 'unknown',
              ...last?.detail !== undefined ? { detail: last.detail } : {},
              ...last?.checkedAt !== undefined ? { checkedAt: last.checkedAt } : {},
              browserStarted: glmChatChannel.isBrowserStarted(),
              canOpen: true,
              canImport: false,
              canExport: false,
            }
          },
          probe: () => glmProbe.probeNow(),
          open: () => glmChatChannel.openLoginWindow(),
          importLogin: async () => {
            throw new Error('GLM 通道暂不支持导入登录态')
          },
          exportLogin: async () => {
            throw new Error('GLM 通道暂不支持导出登录态')
          },
        },
        { basePath: '/api/dsh-deepseek-web/glm-login' },
      ),
      'llm-deepseek-web: glm login routes',
    )
    // 豆包登录态卡片：只读状态 / 手动探活 / 打开登录窗口；一期不做导入导出。
    sub.effect(
      () => registerDoubaoLoginRoutes(sub as unknown as BridgeContext, {
        enabled: live.doubao.enabled && doubaoChannel !== undefined,
        status: async () => {
          if (!doubaoChannel) return { ready: false, message: '豆包网页通道未启用' }
          return await doubaoChannel.status()
        },
        browserStarted: () => doubaoChannel?.isBrowserStarted?.() === true,
        open: async () => {
          if (!doubaoChannel) throw new Error('豆包网页通道未启用')
          return await doubaoChannel.openLoginWindow()
        },
      }),
      'llm-deepseek-web: doubao login routes',
    )
  })

  // 归档联动清理：DSH 会话归档后，删除它在网页端产生过的对话。
  // 需要 workspaceRegistry（归档集合）与 webServer（统计/清理路由）；缺任一个就整块跳过，
  // 老宿主上插件其余部分照常工作。
  ctx.inject(['workspaceRegistry', 'webServer'], (sub) => {
    const cleanup = new ArchiveCleanup({
      registry: (sub as unknown as { workspaceRegistry: ArchiveRegistryLike }).workspaceRegistry,
      sessions: adapter.sessionRegistry,
      channel,
      config: live,
      log: message => sub.logger.info(message),
    })
    sub.effect(() => {
      cleanup.start()
      return () => cleanup.stop()
    }, 'llm-deepseek-web: archive cleanup')
    sub.effect(
      () => registerArchiveCleanupRoutes(sub as unknown as BridgeContext, {
        stats: () => cleanup.stats(),
        runPending: () => cleanup.runPending(),
        listWebChatIds: () => channel.listWebChatIds(),
        purgeWebChats: ids => channel.purgeWebChats(ids),
      }),
      'llm-deepseek-web: archive cleanup routes',
    )
  })

  ctx.logger.info(
    `[llm-deepseek-web] provider "${PROVIDER}" registered`
    + ` (browser=${live.browser}, sendMode=${live.sendMode},`
    + ` review=${live.review.enabled ? live.review.provider : 'off'},`
    + ` glm=${live.glmWeb.url}, imageUpload=${live.enableImageUpload ? 'on' : 'off'})`,
  )

  // 构建身份：重启后据此确认宿主加载的是哪一份产物，而不是靠「我重启过了」猜。
  const stamp = writeLoadStamp()
  ctx.logger.info(
    `[llm-deepseek-web] 构建标识 ${BUILD}（加载文件：${stamp ?? '加载戳写入失败'}）`,
  )
}
