/**
 * 窗口激活策略：把设置页的「聚焦开关」翻译成两条具体动作。
 *
 * 单独成文件是为了可测：真值表不该为了一个纯函数把 playwright-core 整套拉进来。
 *
 * @module dsh-deepseek-web/window-policy
 */

/** 与 `config.focus` 对齐的最小形状；测试不必构造完整 Config。 */
export interface FocusPolicyInput {
  readonly enabled?: boolean | undefined
  readonly webWindow?: boolean | undefined
}

export interface WindowPolicy {
  /** 首次拉起浏览器时是否以最小化方式启动（不进前台）。 */
  readonly minimizeOnLaunch: boolean
  /** 页面操作（锚点页、补页、新会话页、manual 填字）是否允许 `page.bringToFront()`。 */
  readonly activatePage: boolean
}

/**
 * 开关 → 动作。
 *
 * - 总开关关：完全不打扰——最小化启动，任何页面操作都不激活窗口；
 * - 只关「填入时聚焦网页窗口」：正常启动（窗口该出现就出现），但填字不抢前台；
 * - 全开：保持原有行为（manual 模式填字时置前 + 置顶）。
 */
export function resolveWindowPolicy(focus: FocusPolicyInput | undefined): WindowPolicy {
  const enabled = focus?.enabled !== false
  const webWindow = focus?.webWindow !== false
  return {
    minimizeOnLaunch: !enabled,
    activatePage: enabled && webWindow,
  }
}
