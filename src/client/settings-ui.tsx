/**
 * 配置界面的共享展示层。
 *
 * 两处界面（侧栏「设置」· 本插件菜单、插件管理器行上的「配置」页）共用这里的组件，
 * 保证同一批字段在两处长一个样：同一套骨架、同一套行布局、同一套控件外观。
 *
 * 设计约束（改动前先读）：
 * - 这层是**纯展示**：不读 `form`、不发请求、不写 storage、不碰 `document` 之外的宿主对象；
 * - 所有类名以 `dsweb-` 开头，样式集中在 `settings-styles.ts`；
 * - 字段的 DOM id 必须由调用方用 `fieldDomId(field)` 生成后传进来，组件不自己造 id，
 *   否则「人工核对 + 结构断言」会失锚。
 *
 * 交互组件（Card / Fold / Rail）只维护自己的展开态与滚动位置，不参与配置草稿。
 *
 * @module dsh-deepseek-web-xxxxxgold/client/settings-ui
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { JSX, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { FieldSpec } from './config-fields.ts'
import { formatList } from './config-fields.ts'

/** 徽标语义；几何形状只有一种，靠颜色区分含义。 */
export type BadgeTone = 'info' | 'warn' | 'success' | 'muted'

/** 状态文字语气；比徽标多一个错误态。 */
export type Tone = BadgeTone | 'error'

/** 统计块语气：数字本身承载语义，颜色只是辅助。 */
export type StatTone = 'neutral' | 'accent' | 'warn' | 'danger'

/** 徽标：一行的补充状态，不抢标题的视觉权重。 */
export function Badge(props: { readonly tone?: BadgeTone; readonly children: ReactNode }): JSX.Element {
  const tone = props.tone ?? 'muted'
  return <span className={`dsweb-badge dsweb-badge-${tone}`}>{props.children}</span>
}

/**
 * 卡片：分组卡与附属卡共用，靠 `variant` 拉开层级。
 *
 * `collapsible` 打开后标题行变成展开按钮：只切本地 state，不卸载内容，动画由 CSS 的
 * `grid-template-rows: 0fr -> 1fr` 负责，所以折叠再展开不会丢输入焦点以外的任何状态。
 */
export function Card(props: {
  readonly groupId?: string
  readonly title?: string
  readonly hint?: string
  readonly index?: number
  readonly variant?: 'config' | 'aux'
  readonly collapsible?: boolean
  readonly defaultOpen?: boolean
  readonly children: ReactNode
}): JSX.Element {
  const variant = props.variant ?? 'config'
  const collapsible = props.collapsible === true
  const [open, setOpen] = useState(props.defaultOpen ?? true)
  const bodyId = useId()
  const titleId = useId()

  const title = props.title === undefined
    ? null
    : (
        <h3 className="dsweb-card-title" id={titleId}>
          {collapsible
            ? (
                <button
                  type="button"
                  className="dsweb-card-toggle"
                  aria-expanded={open}
                  aria-controls={bodyId}
                  onClick={() => setOpen(value => !value)}
                >
                  <span className="dsweb-card-title-text">{props.title}</span>
                  <span className="dsweb-chevron" aria-hidden="true" />
                </button>
              )
            : props.title}
        </h3>
      )

  const heading = title === null
    ? null
    : (
        <div className="dsweb-card-heading">
          {props.index !== undefined && <span className="dsweb-card-index">{String(props.index).padStart(2, '0')}</span>}
          {title}
        </div>
      )
  const hint = props.hint === undefined ? null : <p className="dsweb-card-hint">{props.hint}</p>
  return (
    <section
      className={`dsweb-card dsweb-card-${variant}`}
      data-group={props.groupId}
      data-open={open ? 'true' : 'false'}
      id={props.groupId === undefined ? undefined : `dsweb-group-${props.groupId}`}
      aria-labelledby={props.title === undefined ? undefined : titleId}
    >
      {(heading !== null || hint !== null) && (
        <header className="dsweb-card-head">
          {heading}
          {hint}
        </header>
      )}
      <div className="dsweb-collapse" data-open={open ? 'true' : 'false'} id={bodyId} inert={open ? undefined : true}>
        <div className="dsweb-collapse-inner">
          <div className="dsweb-card-body">{props.children}</div>
        </div>
      </div>
    </section>
  )
}

/**
 * 折叠分区：卡片内部的次级内容（按天明细、安装自检、危险操作、导入导出）。
 *
 * 支持受控（`open` + `onOpenChange`）与非受控（`defaultOpen`）两种用法；受控用于
 * 「展开时才去加载待清理数量」这类副作用。
 */
export function Fold(props: {
  readonly title: string
  readonly hint?: string
  readonly defaultOpen?: boolean
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly tone?: 'neutral' | 'danger'
  readonly actions?: ReactNode
  readonly toggleId?: string
  readonly children: ReactNode
}): JSX.Element {
  const [innerOpen, setInnerOpen] = useState(props.defaultOpen ?? false)
  const controlled = props.open !== undefined
  const open = controlled ? props.open === true : innerOpen
  const bodyId = useId()
  const toggle = (): void => {
    const next = !open
    if (!controlled) setInnerOpen(next)
    props.onOpenChange?.(next)
  }
  return (
    <section className={`dsweb-fold${props.tone === 'danger' ? ' dsweb-fold-danger' : ''}`} data-open={open ? 'true' : 'false'}>
      <div className="dsweb-fold-head">
        <button
          type="button"
          className="dsweb-fold-toggle"
          id={props.toggleId}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <span className="dsweb-fold-title">{props.title}</span>
          <span className="dsweb-chevron" aria-hidden="true" />
        </button>
        {props.actions !== undefined && <div className="dsweb-fold-actions">{props.actions}</div>}
      </div>
      {props.hint !== undefined && <p className="dsweb-fold-hint">{props.hint}</p>}
      <div className="dsweb-collapse" data-open={open ? 'true' : 'false'} id={bodyId} inert={open ? undefined : true}>
        <div className="dsweb-collapse-inner">{props.children}</div>
      </div>
    </section>
  )
}

/** 统计块：数字在上、标签在下，色调只表达「要不要注意」。 */
export function Stat(props: {
  readonly label: string
  readonly value: string
  readonly tone?: StatTone
  readonly hint?: string
  readonly title?: string
}): JSX.Element {
  const tone = props.tone ?? 'neutral'
  return (
    <div className={`dsweb-stat dsweb-stat-${tone}`} title={props.title ?? props.label}>
      <span className="dsweb-stat-value">{props.value}</span>
      <span className="dsweb-stat-label">{props.label}</span>
      {props.hint !== undefined && <span className="dsweb-stat-hint">{props.hint}</span>}
    </div>
  )
}

/** 页面骨架：页头 + 左栏索引 + 内容 + 常驻操作栏。 */
export function SettingsPage(props: {
  readonly title: string
  readonly subtitle?: string
  readonly badges?: ReactNode
  readonly rail?: ReactNode
  readonly actions?: ReactNode
  readonly status?: ReactNode
  readonly statusTone?: Tone
  readonly state?: 'ready' | 'loading' | 'unavailable' | 'missing'
  readonly children: ReactNode
}): JSX.Element {
  const rail = props.rail ?? null
  return (
    <div className="dsweb-page" data-dsweb-settings={props.state ?? 'ready'}>
      <header className="dsweb-head">
        <div className="dsweb-head-main">
          <h2 className="dsweb-title">{props.title}</h2>
          {props.subtitle !== undefined && <p className="dsweb-sub">{props.subtitle}</p>}
        </div>
        {props.badges !== undefined && <div className="dsweb-head-badges">{props.badges}</div>}
      </header>
      <div className={`dsweb-shell${rail === null ? ' dsweb-shell-plain' : ''}`}>
        {rail}
        <div className="dsweb-content">{props.children}</div>
      </div>
      {props.actions !== undefined && (
        <ActionBar status={props.status} tone={props.statusTone} actions={props.actions} />
      )}
    </div>
  )
}

/**
 * 分组导航：窄面板是顶部横条，宽面板是左侧竖栏。
 *
 * 横条支持三种操作，解决「隐藏滚动条 + 鼠标拖不动 = 后面分组到不了」：
 * 1. 鼠标按住拖拽（只接管 mouse，触屏保留原生惯性滚动）；
 * 2. 滚轮竖向增量转横向滚动；
 * 3. 当前分组随页面滚动切换时自动滚到可视区中央。
 */
export function Rail(props: {
  readonly items: readonly { readonly id: string; readonly label: string; readonly index: number; readonly dirty?: boolean }[]
  readonly activeId?: string
  readonly label?: string
  onSelect(id: string): void
}): JSX.Element {
  const ref = useRef<HTMLElement | null>(null)
  const drag = useRef<{ pointerId: number; startX: number; startLeft: number; moved: boolean; captured: boolean } | null>(null)
  const suppressClick = useRef(false)
  const clickTimer = useRef<number | undefined>(undefined)
  const [dragging, setDragging] = useState(false)

  // 组件卸载时清掉 click 抑制定时器。
  useEffect(() => () => {
    if (clickTimer.current !== undefined) window.clearTimeout(clickTimer.current)
  }, [])

  // 滚轮：把竖向滚动转成横向滚动，否则用户只能拖页面。
  useEffect(() => {
    const node = ref.current
    if (node === null) return
    const onWheel = (event: WheelEvent): void => {
      if (node.scrollWidth <= node.clientWidth + 1) return
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      node.scrollLeft += event.deltaY
      event.preventDefault()
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  // 当前分组跟随：只在横条真的能横向滚动时执行，避免竖栏被无谓滚动。
  useEffect(() => {
    const node = ref.current
    if (node === null || props.activeId === undefined) return
    if (node.scrollWidth <= node.clientWidth + 1) return
    const item = node.querySelector<HTMLElement>(`[data-rail-id="${props.activeId}"]`)
    if (item === null) return
    const left = item.offsetLeft - (node.clientWidth - item.offsetWidth) / 2
    const reduced = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollTo({ left, behavior: reduced ? 'auto' : 'smooth' })
  }, [props.activeId])

  const startDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    const node = ref.current
    if (node === null || node.scrollWidth <= node.clientWidth + 1) return
    // 注意：这里**不能**立刻 setPointerCapture —— 捕获会把后续 click 的 target
    // 重定向到 nav，导致普通点击永远选不中分组。等位移超过阈值再捕获。
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startLeft: node.scrollLeft,
      moved: false,
      captured: false,
    }
  }

  const moveDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const state = drag.current
    const node = ref.current
    if (state === null || node === null || state.pointerId !== event.pointerId) return
    const delta = event.clientX - state.startX
    if (!state.captured) {
      if (Math.abs(delta) <= 4) return
      state.captured = true
      node.setPointerCapture(event.pointerId)
      setDragging(true)
    }
    state.moved = true
    node.scrollLeft = state.startLeft - delta
  }

  const endDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const state = drag.current
    const node = ref.current
    if (state === null) return
    if (state.captured && node !== null && node.hasPointerCapture(event.pointerId)) {
      node.releasePointerCapture(event.pointerId)
    }
    suppressClick.current = state.moved
    drag.current = null
    setDragging(false)
    // click 在 pointerup 之后同步派发；下一轮事件循环再解除抑制，避免吞掉下一次点击。
    if (clickTimer.current !== undefined) window.clearTimeout(clickTimer.current)
    clickTimer.current = window.setTimeout(() => {
      suppressClick.current = false
      clickTimer.current = undefined
    }, 0)
  }

  const lostPointerCapture = (): void => {
    if (drag.current === null) return
    drag.current = null
    setDragging(false)
  }

  return (
    <nav
      className="dsweb-rail"
      aria-label={props.label}
      ref={ref}
      data-dragging={dragging ? 'true' : 'false'}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={lostPointerCapture}
      onClickCapture={(event) => {
        if (!suppressClick.current) return
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {props.items.map(item => (
        <button
          key={item.id}
          type="button"
          className="dsweb-rail-item"
          data-rail-id={item.id}
          aria-current={item.id === props.activeId ? 'true' : undefined}
          onClick={() => props.onSelect(item.id)}
        >
          <span className="dsweb-rail-index">{String(item.index).padStart(2, '0')}</span>
          <span className="dsweb-rail-label">{item.label}</span>
          {item.dirty === true && <span className="dsweb-rail-dot" aria-hidden="true" />}
        </button>
      ))}
    </nav>
  )
}

/** 一行字段：左标题/徽标/说明/错误，右控件与「恢复默认」。 */
export function FieldRow(props: {
  readonly fieldId: string
  readonly domId?: string
  readonly label: string
  readonly badges?: ReactNode
  readonly hint?: string
  readonly error?: string
  readonly wide?: boolean
  readonly control: ReactNode
  readonly reset?: ReactNode
}): JSX.Element {
  const label = props.domId === undefined
    ? (
        <span className="dsweb-row-label">
          <span>{props.label}</span>
          {props.badges}
        </span>
      )
    : (
        <label className="dsweb-row-label" htmlFor={props.domId}>
          <span>{props.label}</span>
          {props.badges}
        </label>
      )
  return (
    <div
      className={`dsweb-row${props.wide === true ? ' dsweb-row-wide' : ''}`}
      data-field={props.fieldId}
      data-invalid={props.error === undefined ? undefined : 'true'}
    >
      <div className="dsweb-row-text">
        {label}
        {props.hint !== undefined && <p className="dsweb-row-hint">{props.hint}</p>}
        {props.error !== undefined && <p className="dsweb-row-error">{props.error}</p>}
      </div>
      <div className="dsweb-row-control">
        {props.control}
        {props.reset}
      </div>
    </div>
  )
}

/** 按字段类型渲染控件。 */
export function FieldControl(props: {
  readonly field: FieldSpec
  readonly value: unknown
  readonly domId: string
  readonly listText?: string
  readonly invalid?: boolean
  readonly disabled?: boolean
  readonly placeholder: string
  readonly optionLabel?: (option: string) => string
  onChange(value: unknown): void
  onChangeList(raw: string): void
}): JSX.Element {
  const { field, value, domId, listText, invalid, disabled, placeholder, optionLabel, onChange, onChangeList } = props

  if (field.kind === 'boolean') {
    const checked = value === true
    return (
      <input
        id={domId}
        className="dsweb-switch"
        type="checkbox"
        role="switch"
        aria-checked={checked}
        disabled={disabled === true}
        checked={checked}
        onChange={event => onChange(event.target.checked)}
      />
    )
  }

  if (field.kind === 'select') {
    const options = field.options ?? []
    const selected = typeof value === 'string' ? value : ''
    const rendered = selected !== '' && !options.includes(selected) ? [selected, ...options] : options
    return (
      <select
        id={domId}
        className="dsweb-select"
        disabled={disabled === true}
        value={selected}
        onChange={event => onChange(event.target.value === '' ? null : event.target.value)}
      >
        {selected === '' && <option value="">—</option>}
        {rendered.map(option => (
          <option key={option} value={option}>{optionLabel === undefined ? option : optionLabel(option)}</option>
        ))}
      </select>
    )
  }

  if (field.kind === 'number') {
    const text = typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value
        : ''
    return (
      <input
        id={domId}
        className={`dsweb-input${invalid === true ? ' dsweb-input-invalid' : ''}`}
        type="number"
        inputMode="numeric"
        step={1}
        min={field.min}
        max={field.max}
        disabled={disabled === true}
        value={text}
        onChange={(event) => {
          const raw = event.target.value
          if (raw === '') {
            onChange(null)
            return
          }
          const parsed = Number(raw)
          onChange(Number.isFinite(parsed) ? parsed : raw)
        }}
      />
    )
  }

  if (field.kind === 'list') {
    return (
      <textarea
        id={domId}
        className={`dsweb-textarea${invalid === true ? ' dsweb-input-invalid' : ''}`}
        rows={4}
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled === true}
        value={listText ?? formatList(value)}
        onChange={event => onChangeList(event.target.value)}
      />
    )
  }

  return (
    <input
      id={domId}
      className={`dsweb-input${invalid === true ? ' dsweb-input-invalid' : ''}`}
      type="text"
      spellCheck={false}
      disabled={disabled === true}
      value={typeof value === 'string' ? value : ''}
      onChange={event => onChange(event.target.value)}
    />
  )
}

/** 底部常驻操作栏：左状态、右按钮。 */
export function ActionBar(props: {
  readonly status?: ReactNode
  readonly tone?: Tone
  readonly actions: ReactNode
}): JSX.Element {
  const tone = props.tone ?? 'info'
  return (
    <div className="dsweb-actionbar">
      <div className={`dsweb-actionbar-status dsweb-tone-${tone}`} role="status" aria-live="polite">
        <span className="dsweb-status-dot" aria-hidden="true" />
        <span>{props.status}</span>
      </div>
      <div className="dsweb-actions">{props.actions}</div>
    </div>
  )
}

/** 加载骨架。 */
export function Skeleton(props: { readonly rows?: number }): JSX.Element {
  const rows = props.rows ?? 3
  return (
    <>
      {Array.from({ length: rows }, (_, index) => <div className="dsweb-skeleton" key={index} />)}
    </>
  )
}
