/**
 * dsh-deepseek-web-littlecar30 插件的浏览器半侧。
 *
 * 这里注册两处界面与一个兜底：
 *
 * 1. `settings.section`：侧栏「设置」里新增「DeepSeek 网页」菜单，配置本插件全部可写参数
 *    （见 settings-section.tsx；这是 0.2 起用户在设置里直接改插件参数的正路）。
 * 2. `plugins.row.config`：插件管理器里本插件行上的「配置」入口，保留旧入口不失效
 *    （见 config-page.tsx）。
 * 3. 对话视图空白自愈（见 conversation-recovery.ts）。
 *
 * 0.1 时代的 `ctx.settingsScope` / `SettingsScope` / `settings.plugin.item` 在 0.2 中已全部移除，
 * 由上面两处取代。
 *
 * @module dsh-deepseek-web-littlecar30/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型-only：拉起 ctx.slots / ctx.sessions / ctx.uiConversation / ctx.configForms / ctx.locale
// 的声明合并，以及 plugins.row.config 的槽位契约。client bundle 纯度门禁禁止值导入。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DeepSeekWebConfigPage, ROW_CONFIG_KEY } from './config-page.tsx'
import { ensureSettingsStyles } from './settings-styles.ts'
import { registerSettingsSection, type SettingsSectionContext } from './settings-section.tsx'
import { monitorConversationBlank } from './conversation-recovery.ts'

/** Services this client module needs from the page's client context. */
export const inject = ['slots', 'sessions', 'uiConversation']

/**
 * Register the plugin's settings menu, its Plugin Manager config page, and the
 * conversation-view safeguard.
 * @param ctx - the client context.
 */
export function apply(ctx: ClientContext): void {
  // 设置面板样式（运行时注入，幂等）
  ensureSettingsStyles()

  // 侧栏「设置」→「DeepSeek 网页」：配置本插件的全部可写参数。
  // 单独挂在 `configForms` + `locale` 两个服务上：老版本 DSH（没有这两个服务）里这段
  // 永远不激活，插件其余部分照常工作，不会因为多了个菜单而整块失效。
  ctx.inject(['configForms', 'locale'], (sub: ClientContext) => {
    registerSettingsSection(sub as unknown as SettingsSectionContext)
  })

  // 配置页：侧栏「插件」页 → 组合包 dsh-deepseek-web-littlecar30 → 行 llm-deepseek-web 上多出「配置」入口
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: ROW_CONFIG_KEY,
  }, DeepSeekWebConfigPage))

  // 历史对话空白自愈（上游 Discussion #6091 的兜底，见 conversation-recovery.ts）
  monitorConversationBlank(ctx)
}
