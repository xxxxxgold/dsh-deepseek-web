/**
 * 设置面板的样式表。
 *
 * DSH 的客户端包在运行时用 `document.createElement('style')` 注入样式（locale、plugin-manager
 * 与各 settings-* 包都这么做），本插件沿用同一通路，因此不依赖构建期的 CSS 产物。
 *
 * 所有颜色、圆角都取宿主主题变量，深浅色主题自动跟随；变量缺失时给同语义回退值。
 *
 * @module dsh-deepseek-web-xxxxxgold/client/settings-styles
 */

/** 样式元素 id：重复挂载时复用它，避免 HMR 或多次激活堆叠。 */
const STYLE_ELEMENT_ID = 'dsh-deepseek-web-settings-style'

/** 设置面板样式。 */
const CSS = `
.dsweb-settings{display:flex;flex-direction:column;gap:14px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-family:inherit}
.dsweb-settings-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.dsweb-settings-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dsweb-settings-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsweb-settings-spacer{flex:1;min-width:0}
.dsweb-badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;font-size:11px;line-height:18px;font-weight:400;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsweb-badge-warn{background:transparent;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsweb-badge-info{background:transparent;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary)}
.dsweb-group{display:flex;flex-direction:column;gap:2px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsweb-group:first-of-type{border-top:none;padding-top:0}
.dsweb-group-title{margin:0;font-size:14px;font-weight:600;line-height:22px}
.dsweb-group-hint{margin:2px 0 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsweb-row{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:11px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsweb-row:last-child{border-bottom:none}
.dsweb-row-wide{flex-direction:column;align-items:stretch;gap:8px}
.dsweb-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsweb-row-label{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;line-height:20px}
.dsweb-row-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsweb-row-error{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-error)}
.dsweb-row-control{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:10px;width:260px;min-width:0}
.dsweb-row-wide .dsweb-row-control{width:100%;justify-content:flex-start;flex-wrap:wrap}
.dsweb-row-wide .dsweb-row-control>.dsweb-input,.dsweb-row-wide .dsweb-row-control>.dsweb-textarea{flex:1 1 auto;width:auto;min-width:0}
.dsweb-input,.dsweb-select,.dsweb-textarea{box-sizing:border-box;width:100%;min-height:32px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background-color:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;transition:border-color .12s ease,box-shadow .12s ease}
.dsweb-input:hover:not(:disabled),.dsweb-select:hover:not(:disabled),.dsweb-textarea:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}
.dsweb-input:focus-visible,.dsweb-select:focus-visible,.dsweb-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px var(--dsw-focus-ring-color,rgba(77,107,254,.25))}
.dsweb-input:disabled,.dsweb-select:disabled,.dsweb-textarea:disabled{opacity:.55;cursor:not-allowed}
.dsweb-input::placeholder,.dsweb-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}
.dsweb-select{appearance:none;-webkit-appearance:none;padding-right:26px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2381858c' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center;cursor:pointer}
.dsweb-select option{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsweb-textarea{min-height:84px;resize:vertical;font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px}
.dsweb-input-invalid,.dsweb-input-invalid:hover{border-color:var(--dsw-alias-label-error)}
.dsweb-switch{appearance:none;-webkit-appearance:none;position:relative;flex:none;box-sizing:border-box;width:38px;height:22px;margin:0;border:none;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .15s ease}
.dsweb-switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .15s ease}
.dsweb-switch:checked{background:var(--dsw-alias-button-primary-fill)}
.dsweb-switch:checked::after{transform:translateX(16px)}
.dsweb-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsweb-switch:disabled{opacity:.5;cursor:not-allowed}
.dsweb-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:32px;padding:0 14px;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;transition:background .12s ease,border-color .12s ease,opacity .12s ease}
.dsweb-button:disabled{opacity:.45;cursor:not-allowed}
.dsweb-button-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsweb-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsweb-button-secondary{background:transparent;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsweb-button-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsweb-link{flex:none;padding:0;border:none;background:none;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-link);cursor:pointer}
.dsweb-link:hover:not(:disabled){text-decoration:underline}
.dsweb-link:disabled{opacity:.5;cursor:not-allowed}
.dsweb-banner{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent);font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsweb-banner-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary)}
.dsweb-banner-error{border-color:var(--dsw-alias-label-error);color:var(--dsw-alias-label-primary)}
.dsweb-banner-success{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}
.dsweb-banner-title{display:block;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsweb-code{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;padding:1px 5px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-markdown-inline-code,rgba(127,127,127,.16))}
.dsweb-skeleton{height:38px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);animation:dsweb-pulse 1.4s ease-in-out infinite}
@keyframes dsweb-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dsweb-skeleton{animation:none}}
.dsweb-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsweb-status{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsweb-status-success{color:var(--dsw-alias-state-success-primary)}
.dsweb-status-error{color:var(--dsw-alias-label-error)}
.dsweb-status-warn{color:var(--dsw-alias-state-warn-primary)}
.dsweb-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.dsweb-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:4px 0}
.dsweb-stat{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent)}
.dsweb-stat-value{font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}
.dsweb-stat-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsweb-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsweb-checks{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px)}
.dsweb-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsweb-check-icon{flex:none;width:12px;text-align:center;font-weight:600}
.dsweb-check-ok .dsweb-check-icon{color:var(--dsw-alias-state-success-primary)}
.dsweb-check-warning .dsweb-check-icon{color:var(--dsw-alias-state-warn-primary)}
.dsweb-check-error .dsweb-check-icon{color:var(--dsw-alias-label-error)}
.dsweb-check-detail{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-all}
`

/**
 * 确保样式已注入（幂等）。
 *
 * 只在浏览器环境调用；SSR / 非 DOM 环境直接跳过。
 */
export function ensureSettingsStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = CSS
  document.head.appendChild(style)
}
