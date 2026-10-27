/**
 * 配置界面的样式表。
 *
 * DSH 的客户端包在运行时用 `document.createElement('style')` 注入样式（locale、plugin-manager
 * 与各 settings-* 包都这么做），本插件沿用同一通路，因此不依赖构建期的 CSS 产物。
 *
 * 组织方式按层排列，改动时请放进对应层：
 *   L0 tokens     设计令牌（颜色 / 间距 / 圆角 / 阴影 / 字体 / 动效 / 布局尺寸）
 *   L1 layout     页面骨架：页头、页身、左栏、内容、操作栏
 *   L2 components 卡片、行、控件、按钮、徽标、骨架、统计块、折叠区
 *   L3 states     hover / focus-visible / disabled / 非法 / 只读
 *   L4 motion     过渡、关键帧、prefers-reduced-motion
 *
 * 铁律：
 * - 所有选择器以 `.dsweb-` 开头，不碰宿主类名，不用 `!important`；
 * - 令牌只挂在 `.dsweb-page` 上（它是两处界面的共同根节点），靠继承作用域生效，不写 `:root`；
 * - 颜色一律优先取宿主 `--dsw-alias-*`，缺失时用同语义回退值，深浅色主题自动跟随。
 *
 * 视觉约定（玻璃拟态）：
 * - 主 CTA 使用自包含的蓝紫渐变（`--dsweb-brand-*`），**不取宿主品牌色**：某些主题下
 *   `--dsw-alias-brand-primary` 是纯白，会让白字按钮变成白块；
 * - 卡片 / 导航 / 操作栏是「半透明底 + 渐变描边 + backdrop blur + 内高光」四件套；
 * - 不支持 `backdrop-filter` / `color-mix` 时退回不透明底，不能变成全透明。
 *
 * @module dsh-deepseek-web-xxxxxgold/client/settings-styles
 */

/** 样式元素 id：重复挂载时复用它，避免 HMR 或多次激活堆叠。 */
const STYLE_ELEMENT_ID = 'dsh-deepseek-web-settings-style'

/** 设置面板样式。 */
const CSS = `
/* ===== L0 tokens ===== */
.dsweb-page{
  --dsweb-brand-1:#4D6BFE;
  --dsweb-brand-2:#7C5CFF;
  --dsweb-brand-3:#C084FC;
  /* 主 CTA 专用：三段都保证白字 ≥ 4.5:1（品牌色在部分主题下是纯白，不能用） */
  --dsweb-cta-1:#4A5CF0;
  --dsweb-cta-2:#6246EA;
  --dsweb-cta-3:#7C3AED;
  --dsweb-accent:#5B7CFF;
  --dsweb-accent-ink:#5B7CFF;
  --dsweb-accent-weak:rgba(91,124,255,.14);
  --dsweb-accent-line:rgba(91,124,255,.38);
  --dsweb-accent-ring:rgba(91,124,255,.30);
  --dsweb-on-accent:#FFFFFF;
  --dsweb-bg:var(--dsw-alias-bg-layer-1,#0F1117);
  /* 部分主题没有 layer-2；回退到页面底色，避免深色主题里卡片突然变白 */
  --dsweb-bg-raised:var(--dsw-alias-bg-layer-2,var(--dsweb-bg));
  --dsweb-bg-sunken:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));
  --dsweb-line:var(--dsw-alias-border-l2,rgba(127,127,127,.20));
  --dsweb-line-strong:var(--dsw-alias-border-l3,rgba(127,127,127,.34));
  --dsweb-text:var(--dsw-alias-label-primary,#F3F5FA);
  --dsweb-text-2:var(--dsw-alias-label-secondary,#C3C8D4);
  --dsweb-text-3:var(--dsw-alias-label-tertiary,#98A0B0);
  --dsweb-text-4:var(--dsw-alias-label-dimmed,#6E7686);
  --dsweb-danger:var(--dsw-alias-label-error,#FF6B6B);
  --dsweb-warn:var(--dsw-alias-state-warn-primary,#F5A524);
  --dsweb-success:var(--dsw-alias-state-success-primary,#3DDC97);
  /* 玻璃底：先给中性回退；支持 color-mix 的浏览器在 L0 末尾整体升级 */
  --dsweb-glass:rgba(127,127,127,.12);
  --dsweb-glass-strong:rgba(127,127,127,.16);
  --dsweb-glass-line:rgba(127,127,127,.22);
  --dsweb-shine:rgba(255,255,255,.14);
  --dsweb-s1:4px;--dsweb-s2:8px;--dsweb-s3:12px;--dsweb-s4:16px;
  --dsweb-s5:20px;--dsweb-s6:24px;--dsweb-s7:32px;--dsweb-s8:40px;
  --dsweb-r-sm:10px;--dsweb-r-md:14px;--dsweb-r-lg:22px;--dsweb-r-xl:26px;--dsweb-r-pill:999px;
  --dsweb-sh1:0 1px 0 var(--dsweb-shine) inset,0 8px 24px -18px rgba(2,6,23,.55);
  --dsweb-sh2:0 1px 0 var(--dsweb-shine) inset,0 20px 48px -26px rgba(2,6,23,.78);
  --dsweb-sh3:0 1px 0 var(--dsweb-shine) inset,0 30px 72px -32px rgba(2,6,23,.9);
  --dsweb-glow:0 0 0 1px var(--dsweb-accent-line),0 24px 64px -30px rgba(77,107,254,.55);
  --dsweb-d1:120ms;--dsweb-d2:180ms;--dsweb-d3:280ms;
  --dsweb-ease:cubic-bezier(.22,.9,.24,1);
  --dsweb-rail-w:232px;--dsweb-content-max:920px;
  --dsweb-control-w:280px;--dsweb-control-h:36px;--dsweb-page-pad:22px;
  /* 操作栏贴底时留的一点缝，避免圆角顶在面板边界上 */
  --dsweb-action-gap:8px;
}
/* color-mix 只在支持时覆盖：自定义属性没有「无效回退到上一条声明」的语义，
   不能在同一条规则里先写 rgba 再写 color-mix（旧浏览器会整条变成 invalid）。 */
@supports (color: color-mix(in srgb,#000 1%,transparent)){
  .dsweb-page{
    --dsweb-accent-ink:color-mix(in srgb,var(--dsweb-accent) 62%,var(--dsweb-text));
    --dsweb-accent-weak:color-mix(in srgb,var(--dsweb-accent) 14%,transparent);
    --dsweb-accent-line:color-mix(in srgb,var(--dsweb-accent) 38%,transparent);
    --dsweb-accent-ring:color-mix(in srgb,var(--dsweb-accent) 30%,transparent);
    --dsweb-glass:color-mix(in srgb,var(--dsweb-bg-raised) 74%,transparent);
    --dsweb-glass-strong:color-mix(in srgb,var(--dsweb-bg-raised) 88%,transparent);
    --dsweb-glass-line:color-mix(in srgb,var(--dsweb-text) 13%,transparent);
    --dsweb-shine:color-mix(in srgb,#FFFFFF 18%,transparent);
    --dsweb-glow:0 0 0 1px color-mix(in srgb,var(--dsweb-accent) 24%,transparent),
      0 24px 64px -30px color-mix(in srgb,var(--dsweb-accent) 55%,transparent);
  }
}

/* ===== L1 layout ===== */
.dsweb-page{
  position:relative;isolation:isolate;
  display:flex;flex-direction:column;gap:var(--dsweb-s4);
  box-sizing:border-box;padding:var(--dsweb-page-pad);padding-bottom:var(--dsweb-action-gap);
  color:var(--dsweb-text);font-family:inherit;
  /* 关键：按「面板自己的宽度」适配，而不是窗口宽度。
     DSH 设置面板只在窗口里占一条窄栏（实测约 590px），用视口媒体查询永远会误判。 */
  container-type:inline-size;container-name:dsweb;
}
/* 极光底：只铺在 .dsweb-page 自身区域，不碰宿主；卡片/导航的玻璃模糊就采样它 */
.dsweb-page::before{
  content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;border-radius:inherit;
  background:
    radial-gradient(120% 72% at 8% -8%,rgba(77,107,254,.18),transparent 62%),
    radial-gradient(90% 60% at 100% 0%,rgba(192,132,252,.14),transparent 60%),
    radial-gradient(100% 68% at 50% 108%,rgba(34,211,238,.10),transparent 66%);
}
.dsweb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--dsweb-s4);flex-wrap:wrap;
  width:100%;max-width:calc(var(--dsweb-rail-w) + var(--dsweb-s6) + var(--dsweb-content-max));margin:0 auto}
.dsweb-head-main{flex:1;min-width:0}
.dsweb-title{margin:0;font-size:20px;line-height:28px;font-weight:650;letter-spacing:-.015em;color:var(--dsweb-text)}
.dsweb-title::after{content:"";display:block;width:64px;height:3px;margin-top:10px;border-radius:3px;
  background:linear-gradient(90deg,var(--dsweb-brand-1),var(--dsweb-brand-2) 55%,transparent);
  box-shadow:0 0 14px rgba(77,107,254,.55)}
.dsweb-sub{margin:var(--dsweb-s2) 0 0;font-size:13px;line-height:20px;color:var(--dsweb-text-3);max-width:62ch}
.dsweb-head-badges{display:flex;align-items:center;gap:var(--dsweb-s2);flex-wrap:wrap;padding-top:var(--dsweb-s1)}
/* 窄面板用 flex-column：grid 行高只有导航条自身，sticky 没有可粘的行程 */
.dsweb-shell{display:flex;flex-direction:column;gap:var(--dsweb-s3);align-items:stretch;
  width:100%;max-width:calc(var(--dsweb-rail-w) + var(--dsweb-s6) + var(--dsweb-content-max));margin:0 auto}
.dsweb-content{display:flex;flex-direction:column;gap:var(--dsweb-s4);max-width:var(--dsweb-content-max);min-width:0}
.dsweb-rail{
  position:sticky;top:0;z-index:5;
  display:flex;flex-direction:row;gap:4px;overflow-x:auto;overflow-y:hidden;
  padding:6px;border:1px solid var(--dsweb-glass-line);border-radius:18px;
  background:rgba(22,24,33,.84);background:var(--dsweb-glass-strong);
  -webkit-backdrop-filter:blur(24px) saturate(170%);backdrop-filter:blur(24px) saturate(170%);
  box-shadow:0 18px 44px -28px rgba(2,6,23,.85),0 1px 0 var(--dsweb-shine) inset;
  scrollbar-width:none;-ms-overflow-style:none;overscroll-behavior-x:contain;
  cursor:grab;user-select:none;scroll-behavior:smooth;
  -webkit-mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 18px),transparent 100%);
  mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 18px),transparent 100%);
}
.dsweb-rail::-webkit-scrollbar{display:none}
.dsweb-rail[data-dragging="true"]{cursor:grabbing;scroll-behavior:auto}
.dsweb-rail-item{position:relative;display:flex;align-items:center;gap:var(--dsweb-s2);
  box-sizing:border-box;width:auto;flex:none;height:34px;padding:0 12px 0 10px;
  border:1px solid transparent;border-radius:12px;background:transparent;
  color:var(--dsweb-text-2);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;
  transition:background var(--dsweb-d1) var(--dsweb-ease),color var(--dsweb-d1) var(--dsweb-ease),
    box-shadow var(--dsweb-d2) var(--dsweb-ease),transform var(--dsweb-d1) var(--dsweb-ease)}
.dsweb-rail-index{flex:none;width:16px;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;color:var(--dsweb-text-4)}
.dsweb-rail-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsweb-rail-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsweb-warn);
  box-shadow:0 0 8px rgba(245,165,36,.8)}
.dsweb-actionbar{
  position:sticky;bottom:var(--dsweb-action-gap);z-index:6;
  display:flex;align-items:center;gap:var(--dsweb-s3);flex-wrap:wrap;
  box-sizing:border-box;
  width:100%;max-width:calc(var(--dsweb-rail-w) + var(--dsweb-s6) + var(--dsweb-content-max));margin:0 auto;
  padding:10px 12px 10px 16px;border:1px solid var(--dsweb-glass-line);border-radius:18px;
  background:rgba(22,24,33,.88);background:var(--dsweb-glass-strong);
  -webkit-backdrop-filter:blur(26px) saturate(180%);backdrop-filter:blur(26px) saturate(180%);
  box-shadow:0 28px 64px -30px rgba(2,6,23,.92),0 1px 0 var(--dsweb-shine) inset;
}
.dsweb-actionbar-status{display:flex;align-items:center;gap:8px;flex:1;min-width:0;
  font-size:12px;line-height:18px;color:var(--dsweb-text-2)}
.dsweb-status-dot{flex:none;width:8px;height:8px;border-radius:50%;background:currentColor;
  box-shadow:0 0 0 4px rgba(127,127,127,.16),0 0 12px currentColor;
  box-shadow:0 0 0 4px color-mix(in srgb,currentColor 18%,transparent),0 0 12px color-mix(in srgb,currentColor 70%,transparent)}
.dsweb-actions{display:flex;align-items:center;gap:var(--dsweb-s2);margin-left:auto}

/* ===== L2 components ===== */
.dsweb-card{
  position:relative;display:flex;flex-direction:column;box-sizing:border-box;overflow:hidden;
  border:1px solid transparent;border-radius:var(--dsweb-r-lg);
  background:
    linear-gradient(155deg,rgba(255,255,255,.06),rgba(255,255,255,.01) 46%,rgba(255,255,255,0)) padding-box,
    linear-gradient(150deg,rgba(255,255,255,.18),rgba(255,255,255,.04) 40%,rgba(77,107,254,.32)) border-box;
  background-color:var(--dsweb-glass);
  -webkit-backdrop-filter:blur(20px) saturate(150%);backdrop-filter:blur(20px) saturate(150%);
  box-shadow:0 0 0 1px var(--dsweb-glass-line),var(--dsweb-sh2);
  scroll-margin-top:84px;
  transition:box-shadow var(--dsweb-d2) var(--dsweb-ease),border-color var(--dsweb-d2) var(--dsweb-ease),
    transform var(--dsweb-d2) var(--dsweb-ease)}
.dsweb-card-aux{
  background:
    linear-gradient(155deg,rgba(255,255,255,.04),rgba(255,255,255,.01) 46%,rgba(255,255,255,0)) padding-box,
    linear-gradient(150deg,rgba(255,255,255,.20),rgba(255,255,255,.04) 40%,rgba(124,92,255,.30)) border-box;
  background-color:var(--dsweb-glass)}
.dsweb-card-head{display:flex;flex-direction:column;gap:4px;padding:16px 18px 0}
.dsweb-card-heading{display:flex;align-items:center;gap:10px;min-width:0}
.dsweb-card-toggle{display:flex;align-items:center;gap:10px;width:100%;min-width:0;margin:0;padding:0;
  border:0;border-radius:10px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsweb-card-toggle:focus-visible{outline:none;box-shadow:0 0 0 3px var(--dsweb-accent-ring)}
.dsweb-card-index{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:26px;height:26px;border-radius:9px;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;
  color:var(--dsweb-accent);
  background:linear-gradient(140deg,rgba(77,107,254,.22),rgba(124,92,255,.10));
  box-shadow:0 0 0 1px rgba(91,124,255,.22) inset;
  background:linear-gradient(140deg,color-mix(in srgb,var(--dsweb-accent) 22%,transparent),
    color-mix(in srgb,var(--dsweb-brand-2) 10%,transparent))}
.dsweb-card-title{margin:0;flex:1;min-width:0;font-size:15px;line-height:22px;font-weight:650;letter-spacing:-.01em;color:var(--dsweb-text)}
.dsweb-card-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsweb-text-3)}
.dsweb-card-body{display:flex;flex-direction:column;padding:10px 18px 16px}
.dsweb-collapse{display:grid;grid-template-rows:1fr;opacity:1;
  transition:grid-template-rows var(--dsweb-d3) var(--dsweb-ease),opacity var(--dsweb-d2) var(--dsweb-ease)}
.dsweb-collapse[data-open="false"]{grid-template-rows:0fr;opacity:0}
.dsweb-collapse>.dsweb-collapse-inner{min-height:0;overflow:hidden}
.dsweb-chevron{flex:none;display:grid;place-items:center;width:24px;height:24px;margin-left:auto;
  border-radius:50%;background:var(--dsweb-bg-sunken);color:var(--dsweb-text-3);
  transition:background var(--dsweb-d1) var(--dsweb-ease),color var(--dsweb-d1) var(--dsweb-ease)}
.dsweb-chevron::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;
  border-bottom:1.5px solid currentColor;transform:rotate(45deg) translate(-1px,-1px);
  transition:transform var(--dsweb-d3) var(--dsweb-ease)}
.dsweb-card[data-open="false"] .dsweb-chevron::before,
.dsweb-fold[data-open="false"] .dsweb-chevron::before{transform:rotate(-45deg) translate(-1px,-1px)}
.dsweb-fold{border-top:1px solid var(--dsweb-line);margin-top:10px;padding-top:8px}
.dsweb-fold:first-child{border-top:none;margin-top:0;padding-top:0}
.dsweb-fold-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsweb-fold-toggle{display:flex;align-items:center;gap:8px;flex:1;min-width:0;margin:0;padding:4px 0;
  border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsweb-fold-toggle:focus-visible{outline:none;box-shadow:0 0 0 3px var(--dsweb-accent-ring)}
.dsweb-fold-title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsweb-text)}
.dsweb-fold-actions{display:flex;align-items:center;gap:8px}
.dsweb-fold-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsweb-text-3)}
.dsweb-fold-danger{border-top-color:rgba(255,107,107,.32);
  border-top-color:color-mix(in srgb,var(--dsweb-danger) 32%,transparent)}
.dsweb-fold-danger .dsweb-fold-title{color:var(--dsweb-danger)}
.dsweb-fold-danger .dsweb-chevron{color:var(--dsweb-danger);background:rgba(255,107,107,.12);
  background:color-mix(in srgb,var(--dsweb-danger) 12%,transparent)}
.dsweb-danger-body{display:flex;flex-direction:column;gap:8px;padding-top:8px}
.dsweb-actions-start{justify-content:flex-start;margin-left:0}
.dsweb-row{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--dsweb-s2);
  align-items:start;box-sizing:border-box;padding:var(--dsweb-s3) 10px;margin:0 -10px;
  border-top:1px solid var(--dsweb-line);border-radius:12px;
  transition:background var(--dsweb-d1) var(--dsweb-ease)}
.dsweb-card-body>.dsweb-row:first-child{border-top:none}
.dsweb-row-wide{grid-template-columns:minmax(0,1fr);gap:var(--dsweb-s2)}
.dsweb-row-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsweb-row-label{display:inline-flex;align-items:center;gap:var(--dsweb-s2);flex-wrap:wrap;
  font-size:13px;line-height:20px;font-weight:500;color:var(--dsweb-text);cursor:pointer}
.dsweb-row-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsweb-text-3)}
.dsweb-row-error{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsweb-danger)}
.dsweb-row-control{display:flex;align-items:center;justify-content:flex-end;gap:var(--dsweb-s2);min-width:0}
.dsweb-row-wide .dsweb-row-control{justify-content:flex-start;flex-wrap:wrap}
.dsweb-row-wide .dsweb-row-control>.dsweb-input,
.dsweb-row-wide .dsweb-row-control>.dsweb-textarea,
.dsweb-row-wide .dsweb-row-control>.dsweb-select{flex:1 1 auto;width:auto;min-width:0}
.dsweb-input,.dsweb-select,.dsweb-textarea{box-sizing:border-box;width:100%;min-height:var(--dsweb-control-h);
  padding:7px 11px;border:1px solid var(--dsweb-line);border-radius:12px;
  background:rgba(127,127,127,.06);color:var(--dsweb-text);font:inherit;font-size:13px;line-height:20px;
  background:color-mix(in srgb,var(--dsweb-bg) 58%,transparent);
  transition:border-color var(--dsweb-d1) var(--dsweb-ease),box-shadow var(--dsweb-d1) var(--dsweb-ease),
    background var(--dsweb-d1) var(--dsweb-ease)}
.dsweb-input::placeholder,.dsweb-textarea::placeholder{color:var(--dsweb-text-4)}
.dsweb-select{appearance:none;-webkit-appearance:none;padding-right:26px;cursor:pointer;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2381858c' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 9px center}
.dsweb-select option{background:var(--dsweb-bg-raised);color:var(--dsweb-text)}
.dsweb-textarea{min-height:84px;resize:vertical;
  font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:12px;line-height:18px}
.dsweb-input-invalid,.dsweb-input-invalid:hover{border-color:var(--dsweb-danger)}
.dsweb-switch{appearance:none;-webkit-appearance:none;position:relative;flex:none;box-sizing:border-box;
  width:42px;height:24px;margin:0;border:1px solid var(--dsweb-line);border-radius:var(--dsweb-r-pill);
  background:var(--dsweb-bg-sunken);cursor:pointer;
  transition:background var(--dsweb-d2) var(--dsweb-ease),border-color var(--dsweb-d2) var(--dsweb-ease),
    box-shadow var(--dsweb-d2) var(--dsweb-ease)}
.dsweb-switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;
  background:#FFF;box-shadow:0 1px 3px rgba(0,0,0,.35);
  transition:transform var(--dsweb-d2) var(--dsweb-ease)}
.dsweb-switch:checked{border-color:transparent;
  background:linear-gradient(135deg,var(--dsweb-cta-1),var(--dsweb-cta-2));
  box-shadow:0 6px 18px -8px rgba(77,107,254,.9)}
.dsweb-switch:checked::after{transform:translateX(18px)}
.dsweb-button{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  box-sizing:border-box;height:var(--dsweb-control-h);padding:0 15px;border:1px solid transparent;border-radius:12px;
  font:inherit;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;cursor:pointer;
  transition:background var(--dsweb-d1) var(--dsweb-ease),border-color var(--dsweb-d1) var(--dsweb-ease),
    opacity var(--dsweb-d1) var(--dsweb-ease),transform var(--dsweb-d1) var(--dsweb-ease),
    box-shadow var(--dsweb-d2) var(--dsweb-ease)}
.dsweb-button-primary{overflow:hidden;isolation:isolate;color:#FFF;
  border-color:rgba(255,255,255,.18);
  background:linear-gradient(135deg,var(--dsweb-cta-1),var(--dsweb-cta-2) 58%,var(--dsweb-cta-3));
  box-shadow:0 12px 28px -14px rgba(77,107,254,.95),0 1px 0 rgba(255,255,255,.28) inset}
.dsweb-button-primary::after{content:"";position:absolute;inset:-1px;z-index:0;pointer-events:none;
  background:linear-gradient(110deg,transparent 18%,rgba(255,255,255,.38) 48%,transparent 72%);
  transform:translateX(-130%);transition:transform .62s var(--dsweb-ease)}
.dsweb-button-secondary{background:rgba(127,127,127,.10);border-color:var(--dsweb-line);color:var(--dsweb-text);
  background:color-mix(in srgb,var(--dsweb-text) 6%,transparent);
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.dsweb-button-ghost{background:transparent;border-color:transparent;color:var(--dsweb-text-2)}
.dsweb-button-danger{background:rgba(255,107,107,.12);border-color:rgba(255,107,107,.5);color:var(--dsweb-danger);
  background:color-mix(in srgb,var(--dsweb-danger) 12%,transparent);
  border-color:color-mix(in srgb,var(--dsweb-danger) 50%,transparent)}
.dsweb-link{flex:none;padding:0;border:none;background:none;font:inherit;font-size:12px;line-height:18px;
  color:var(--dsweb-accent-ink);cursor:pointer;border-radius:var(--dsweb-r-sm)}
.dsweb-badge{display:inline-flex;align-items:center;box-sizing:border-box;height:20px;padding:0 8px;
  border:1px solid transparent;border-radius:var(--dsweb-r-pill);
  font-size:11px;line-height:16px;font-weight:500;white-space:nowrap}
.dsweb-badge-muted{background:rgba(127,127,127,.12);color:var(--dsweb-text-2);
  background:color-mix(in srgb,var(--dsweb-text) 8%,transparent)}
.dsweb-badge-info{background:var(--dsweb-accent-weak);color:var(--dsweb-accent-ink);
  box-shadow:0 0 0 1px var(--dsweb-accent-line) inset}
.dsweb-badge-warn{background:rgba(245,165,36,.10);border-color:rgba(245,165,36,.55);color:var(--dsweb-warn);
  background:color-mix(in srgb,var(--dsweb-warn) 10%,transparent);
  border-color:color-mix(in srgb,var(--dsweb-warn) 55%,transparent)}
.dsweb-badge-success{background:rgba(61,220,151,.10);border-color:rgba(61,220,151,.55);color:var(--dsweb-success);
  background:color-mix(in srgb,var(--dsweb-success) 10%,transparent);
  border-color:color-mix(in srgb,var(--dsweb-success) 55%,transparent)}
.dsweb-banner{display:flex;gap:var(--dsweb-s2);align-items:flex-start;box-sizing:border-box;
  margin:6px 0;padding:10px 12px;border:1px solid var(--dsweb-line);border-radius:14px;
  background:rgba(127,127,127,.06);font-size:13px;line-height:20px;color:var(--dsweb-text-2);
  background:color-mix(in srgb,var(--dsweb-text) 4%,transparent)}
.dsweb-banner-warn{border-color:rgba(245,165,36,.5);color:var(--dsweb-text);
  background:rgba(245,165,36,.07);
  border-color:color-mix(in srgb,var(--dsweb-warn) 50%,transparent);
  background:color-mix(in srgb,var(--dsweb-warn) 7%,transparent)}
.dsweb-banner-error{border-color:rgba(255,107,107,.5);color:var(--dsweb-text);
  background:rgba(255,107,107,.07);
  border-color:color-mix(in srgb,var(--dsweb-danger) 50%,transparent);
  background:color-mix(in srgb,var(--dsweb-danger) 7%,transparent)}
.dsweb-banner-success{border-color:rgba(61,220,151,.5);color:var(--dsweb-text);
  background:rgba(61,220,151,.07);
  border-color:color-mix(in srgb,var(--dsweb-success) 50%,transparent);
  background:color-mix(in srgb,var(--dsweb-success) 7%,transparent)}
.dsweb-banner-title{display:block;font-weight:600;color:var(--dsweb-text)}
.dsweb-code{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:12px;padding:1px 5px;border-radius:var(--dsweb-r-sm);
  background:var(--dsw-alias-markdown-inline-code,rgba(127,127,127,.16))}
.dsweb-skeleton{height:38px;border-radius:12px;
  background:linear-gradient(90deg,var(--dsweb-bg-sunken) 25%,var(--dsweb-line) 37%,var(--dsweb-bg-sunken) 63%);
  background-size:400% 100%;animation:dsweb-shimmer 1.4s ease-in-out infinite}
.dsweb-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:2px 0 6px}
.dsweb-stat{position:relative;overflow:hidden;display:flex;flex-direction:column;gap:2px;
  padding:10px 12px;border:1px solid var(--dsweb-line);border-radius:16px;
  background:linear-gradient(160deg,rgba(255,255,255,.07),rgba(255,255,255,0) 58%),
    rgba(127,127,127,.05);
  box-shadow:0 1px 0 rgba(255,255,255,.06) inset;
  transition:transform var(--dsweb-d2) var(--dsweb-ease),border-color var(--dsweb-d2) var(--dsweb-ease),
    box-shadow var(--dsweb-d2) var(--dsweb-ease)}
.dsweb-stat::after{content:"";position:absolute;right:-34px;bottom:-46px;width:96px;height:96px;border-radius:50%;
  background:radial-gradient(circle,rgba(91,124,255,.28),transparent 70%);
  pointer-events:none;opacity:.7}
.dsweb-stat-value{position:relative;z-index:1;font-size:19px;line-height:25px;font-weight:650;
  letter-spacing:-.01em;font-variant-numeric:tabular-nums;color:var(--dsweb-text);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsweb-stat-label{position:relative;z-index:1;font-size:11px;line-height:16px;color:var(--dsweb-text-3);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsweb-stat-hint{position:relative;z-index:1;font-size:10px;line-height:14px;color:var(--dsweb-text-4)}
.dsweb-stat-accent{border-color:var(--dsweb-accent-line);
  background:linear-gradient(150deg,rgba(77,107,254,.18),rgba(124,92,255,.06) 60%,transparent)}
.dsweb-stat-accent .dsweb-stat-value{color:var(--dsweb-accent)}
.dsweb-stat-warn{border-color:rgba(245,165,36,.42);
  background:linear-gradient(150deg,rgba(245,165,36,.14),transparent 62%);
  border-color:color-mix(in srgb,var(--dsweb-warn) 42%,transparent);
  background:linear-gradient(150deg,color-mix(in srgb,var(--dsweb-warn) 14%,transparent),transparent 62%)}
.dsweb-stat-warn .dsweb-stat-value{color:var(--dsweb-warn)}
.dsweb-stat-danger{border-color:rgba(255,107,107,.42);
  background:linear-gradient(150deg,rgba(255,107,107,.14),transparent 62%);
  border-color:color-mix(in srgb,var(--dsweb-danger) 42%,transparent);
  background:linear-gradient(150deg,color-mix(in srgb,var(--dsweb-danger) 14%,transparent),transparent 62%)}
.dsweb-stat-danger .dsweb-stat-value{color:var(--dsweb-danger)}
.dsweb-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:4px 0}
.dsweb-days{display:flex;flex-direction:column;gap:2px;margin-top:6px}
.dsweb-day{display:grid;grid-template-columns:56px minmax(0,1fr) auto;gap:10px;align-items:center;
  padding:7px 10px;border-radius:10px;font-size:12px;line-height:18px;color:var(--dsweb-text-2)}
.dsweb-day:nth-child(odd){background:rgba(127,127,127,.06);
  background:color-mix(in srgb,var(--dsweb-text) 4%,transparent)}
.dsweb-day-date{font-variant-numeric:tabular-nums;color:var(--dsweb-text-3)}
.dsweb-day-meta{display:flex;gap:10px;flex-wrap:wrap}
.dsweb-day-gap{font-variant-numeric:tabular-nums;color:var(--dsweb-text-3);white-space:nowrap}
.dsweb-day-fail{color:var(--dsweb-danger)}
.dsweb-checks{display:flex;flex-direction:column;gap:6px;padding:8px 10px;
  border:1px solid var(--dsweb-line);border-radius:14px;background:rgba(127,127,127,.05);
  background:color-mix(in srgb,var(--dsweb-text) 3%,transparent)}
.dsweb-check{display:flex;align-items:flex-start;gap:var(--dsweb-s2);font-size:12px;line-height:18px;color:var(--dsweb-text-2)}
.dsweb-check-icon{flex:none;width:12px;text-align:center;font-weight:600}
.dsweb-check-ok .dsweb-check-icon{color:var(--dsweb-success)}
.dsweb-check-warning .dsweb-check-icon{color:var(--dsweb-warn)}
.dsweb-check-error .dsweb-check-icon{color:var(--dsweb-danger)}
.dsweb-check-detail{display:block;margin-top:2px;color:var(--dsweb-text-3);white-space:pre-wrap;word-break:break-all}
.dsweb-status{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsweb-text-2)}
.dsweb-status-success{color:var(--dsweb-success)}
.dsweb-status-error{color:var(--dsweb-danger)}
.dsweb-status-warn{color:var(--dsweb-warn)}
.dsweb-tone-info{color:var(--dsweb-accent-ink)}
.dsweb-tone-warn{color:var(--dsweb-warn)}
.dsweb-tone-success{color:var(--dsweb-success)}
.dsweb-tone-error{color:var(--dsweb-danger)}
.dsweb-tone-muted{color:var(--dsweb-text-3)}

/* ===== L3 states ===== */
.dsweb-rail-item:hover{background:rgba(127,127,127,.12);color:var(--dsweb-text);
  background:color-mix(in srgb,var(--dsweb-text) 8%,transparent)}
.dsweb-rail-item:focus-visible{outline:none;box-shadow:0 0 0 3px var(--dsweb-accent-ring)}
.dsweb-rail-item[aria-current="true"]{
  color:#FFF;font-weight:600;
  background:linear-gradient(135deg,var(--dsweb-cta-1),var(--dsweb-cta-2) 68%,var(--dsweb-cta-3));
  box-shadow:0 10px 26px -14px rgba(77,107,254,.95),0 1px 0 rgba(255,255,255,.30) inset}
.dsweb-rail-item[aria-current="true"] .dsweb-rail-index{color:rgba(255,255,255,.78)}
.dsweb-rail-item[aria-current="true"]:hover{color:#FFF}
.dsweb-card:hover{box-shadow:var(--dsweb-glow);transform:translateY(-1px)}
.dsweb-card-aux:hover{box-shadow:var(--dsweb-sh2);transform:translateY(-1px)}
.dsweb-row:hover{background:rgba(91,124,255,.07);background:color-mix(in srgb,var(--dsweb-accent) 7%,transparent)}
.dsweb-stat:hover{transform:translateY(-1px);box-shadow:0 14px 30px -22px rgba(2,6,23,.9)}
.dsweb-input:hover:not(:disabled),.dsweb-select:hover:not(:disabled),.dsweb-textarea:hover:not(:disabled){border-color:var(--dsweb-line-strong)}
.dsweb-input:focus-visible,.dsweb-select:focus-visible,.dsweb-textarea:focus-visible{
  outline:none;border-color:var(--dsweb-accent);box-shadow:0 0 0 3px var(--dsweb-accent-ring)}
.dsweb-input:disabled,.dsweb-select:disabled,.dsweb-textarea:disabled{opacity:.55;cursor:not-allowed}
.dsweb-switch:focus-visible{outline:2px solid var(--dsweb-accent);outline-offset:2px}
.dsweb-switch:disabled{opacity:.5;cursor:not-allowed}
.dsweb-button:hover:not(:disabled){transform:translateY(-1px)}
.dsweb-button:active:not(:disabled){transform:translateY(0)}
.dsweb-button:focus-visible{outline:none;box-shadow:0 0 0 3px var(--dsweb-accent-ring)}
.dsweb-button:disabled{opacity:.5;cursor:not-allowed;transform:none;filter:saturate(.55)}
.dsweb-button-primary:disabled{opacity:1;filter:none;color:var(--dsweb-text-3);
  background:rgba(91,124,255,.14);border-color:var(--dsweb-line);box-shadow:none;
  background:color-mix(in srgb,var(--dsweb-accent) 14%,transparent)}
.dsweb-button-primary:hover:not(:disabled){box-shadow:0 18px 34px -14px rgba(77,107,254,1),0 1px 0 rgba(255,255,255,.32) inset}
.dsweb-button-primary:hover:not(:disabled)::after{transform:translateX(130%)}
.dsweb-button-secondary:hover:not(:disabled){border-color:var(--dsweb-line-strong);
  background:rgba(127,127,127,.16);background:color-mix(in srgb,var(--dsweb-text) 10%,transparent)}
.dsweb-button-ghost:hover:not(:disabled){background:var(--dsweb-bg-sunken);color:var(--dsweb-text)}
.dsweb-button-danger:hover:not(:disabled){background:rgba(255,107,107,.2);
  background:color-mix(in srgb,var(--dsweb-danger) 20%,transparent);
  box-shadow:0 12px 26px -16px rgba(255,107,107,.9)}
.dsweb-link:hover:not(:disabled){text-decoration:underline}
.dsweb-link:disabled{opacity:.5;cursor:not-allowed}
.dsweb-page[data-dsweb-settings="loading"] .dsweb-card{opacity:.6}
.dsweb-page .dsweb-row[data-invalid="true"] .dsweb-row-label{color:var(--dsweb-danger)}
.dsweb-tier-buttons{display:flex;flex-wrap:wrap;gap:var(--dsweb-s2);align-items:center;justify-content:flex-end}

/* ===== L4 motion ===== */
@keyframes dsweb-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}
@keyframes dsweb-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes dsweb-breathe{from{opacity:.72}to{opacity:1}}
.dsweb-card{animation:dsweb-rise var(--dsweb-d3) var(--dsweb-ease)}
.dsweb-page::before{animation:dsweb-breathe 16s ease-in-out infinite alternate}

@media (prefers-reduced-motion:reduce){
  .dsweb-page *,.dsweb-page::before{transition:none;animation:none;scroll-behavior:auto}
}

/* ===== 兼容回退 ===== */
@supports not (backdrop-filter:blur(1px)){
  .dsweb-rail,.dsweb-actionbar{background:var(--dsweb-bg-raised)}
  .dsweb-card,.dsweb-card-aux{background:var(--dsweb-bg-raised)}
}

/* ===== responsive：按「面板宽度」而不是「窗口宽度」适配 ===== */
@container dsweb (min-width:420px){
  .dsweb-stats{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@container dsweb (min-width:640px){
  .dsweb-row{grid-template-columns:minmax(0,1fr) minmax(180px,var(--dsweb-control-w));gap:var(--dsweb-s4)}
  .dsweb-row-wide{grid-template-columns:minmax(0,1fr);gap:var(--dsweb-s2)}
  .dsweb-row-control{justify-content:flex-end}
  .dsweb-row-wide .dsweb-row-control{justify-content:flex-start}
  .dsweb-tier-buttons{justify-content:flex-end}
}
@container dsweb (min-width:760px){
  .dsweb-shell{display:grid;grid-template-columns:var(--dsweb-rail-w) minmax(0,1fr);gap:var(--dsweb-s6);align-items:start}
  .dsweb-rail{top:16px;flex-direction:column;max-height:calc(100vh - 120px);overflow:auto;
    padding:10px;cursor:default;-webkit-mask-image:none;mask-image:none}
  .dsweb-rail-item{width:100%}
  .dsweb-rail-item[aria-current="true"]{box-shadow:0 10px 24px -16px rgba(77,107,254,.9),0 1px 0 rgba(255,255,255,.28) inset}
  .dsweb-card{scroll-margin-top:24px}
}
@container dsweb (max-width:480px){
  .dsweb-title{font-size:18px;line-height:26px}
  .dsweb-head{flex-direction:column;align-items:flex-start}
  .dsweb-head-badges{padding-top:0}
  .dsweb-card-head{padding:14px 14px 0}
  .dsweb-card-body{padding:8px 14px 14px}
  .dsweb-actionbar{flex-direction:column;align-items:stretch;gap:8px;padding:10px 12px}
  .dsweb-actionbar .dsweb-actions{width:100%;margin-left:0}
  .dsweb-actionbar .dsweb-actions>*{flex:1}
  .dsweb-stat{min-width:0}
}
@media (max-width:520px){
  .dsweb-page{padding:14px;padding-bottom:var(--dsweb-action-gap)}
}
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
