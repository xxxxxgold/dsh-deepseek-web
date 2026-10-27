/**
 * 侧栏「设置」里的本插件菜单。
 *
 * 注册到设置壳声明的 `settings.section` 列表槽：设置面板导航里多出一项「DeepSeek 网页」，
 * 点开即是本插件的参数表单。读写走宿主的共享表单控制器
 * （`ctx.configForms.get('llm-deepseek-web')`）：
 *
 * - 读：控制器把 `settings.describe()` 的命名空间视图解码成 `{ value, base, user, revision }`，
 *   组件用注入的 `useSettingsForm` 订阅它，宿主侧改动自动回流；
 * - 写：整页改动先落在本地草稿，点「保存」时按字段做差量，一次 `mutate(ops, revision)`
 *   原子提交；版本冲突或校验失败时宿主拒绝，草稿保留、界面回读真实值；
 * - 保存成功后回读命名空间视图，逐字段核对是否真的落盘，再报「已保存」。
 *
 * 界面语言由配置字段 `uiLanguage` 决定（见 `i18n.ts`），两处配置界面共用同一份字典。
 *
 * @module dsh-deepseek-web-xxxxxgold/client/settings-section
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import {
  FIELDS,
  GROUPS,
  RISK_PRESETS,
  applyRiskPreset,
  diffOps,
  fieldDomId,
  fieldKey,
  hasPath,
  matchRiskPreset,
  parseList,
  readPath,
  sameValue,
  validateField,
  withEdit,
  withoutPath,
  type FieldErrorCode,
  type FieldOp,
  type FieldSpec,
  type RiskPreset,
} from './config-fields.ts'
import { ROW_ENTRY_ID } from './config-page.tsx'
import { LedgerCard } from './ledger-card.tsx'
import { LoginCard } from './login-card.tsx'
import { ArchiveCleanupCard } from './archive-cleanup-card.tsx'
import { LOCALE_DICTIONARIES, LOCALE_NAMESPACE, resolveUiLanguage, translatorFor, type Translate } from './i18n.ts'
import {
  Badge,
  Card,
  FieldControl,
  FieldRow,
  Rail,
  SettingsPage,
  Skeleton,
} from './settings-ui.tsx'

/** `settings.section` 里的 section id。 */
const SECTION_ID = 'deepseek-web'

/** 排序：账号 -10 / 通用 0 / 模型 10 / 插件 15 之后。 */
const SECTION_ORDER = 20

/** 宿主设置快照（`ConfigFormController.getSnapshot()` 的结构）。 */
export interface SettingsSnapshot {
  readonly status?: string
  readonly value?: unknown
  readonly base?: unknown
  readonly user?: unknown
  readonly revision?: number
  readonly writable?: boolean
}

/** 宿主共享表单控制器里本页用到的方法。 */
export interface SettingsFormHandle {
  getSnapshot(): SettingsSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly FieldOp[], expectedRevision?: number): Promise<boolean>
}

/** 槽位组件收到的 props（parent kit + inject 面 + owner props）。 */
export interface SettingsSectionProps {
  readonly form?: SettingsFormHandle
  readonly useSettingsForm?: <T>(
    selector: (snapshot: SettingsSnapshot) => T,
    equal?: (left: T, right: T) => boolean,
  ) => T
  readonly t?: Translate
  readonly reload?: () => void
}

/** settings.section 注入所需的客户端能力（结构性类型，避免值导入宿主包）。 */
export interface SettingsSectionContext {
  readonly configForms: {
    get(entryId: string): SettingsFormHandle
    describe(): { load(): Promise<unknown> }
  }
  readonly slots: {
    inject(name: string, create: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  readonly locale: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
    bind(namespace: string): Translate
  }
  effect(create: () => () => void, label: string): unknown
}

/** 空对象占位，保证依赖身份稳定。 */
const EMPTY_OBJECT: Record<string, unknown> = {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessageOf(error: unknown, t: Translate): string {
  if (error instanceof Error) return error.message
  const text = String(error)
  return text === '' ? t('unknownError') : text
}

/**
 * 注册设置菜单与表单。
 *
 * @param ctx - 客户端上下文（已含 configForms / slots / locale 服务）。
 */
export function registerSettingsSection(ctx: SettingsSectionContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, LOCALE_DICTIONARIES), 'dsh-deepseek-web: settings copy')
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  const form = ctx.configForms.get(ROW_ENTRY_ID)
  const reload = (): void => {
    void ctx.configForms.describe().load()
  }
  // 菜单标签每次渲染都按当前配置解析语言：宿主槽位可能缓存 label 函数，
  // 但配置变更后至少下次进入设置页会跟上；页面正文是即时切换的。
  const navLabel = (): string => {
    const snapshot = form.getSnapshot()
    const value = isRecord(snapshot.value) ? snapshot.value : EMPTY_OBJECT
    return translatorFor(resolveUiLanguage(readPath(value, ['uiLanguage'])))('nav')
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: SECTION_ORDER,
    label: navLabel,
    inject: () => ({ form, hooks: { settingsForm: form }, t, reload }),
  }, DeepSeekWebSettingsSection))
}

/**
 * 设置面板里的插件菜单。
 *
 * @param props - 槽位宿主与注入面提供的 props。
 * @returns 设置页内容。
 */
export function DeepSeekWebSettingsSection(props: SettingsSectionProps): JSX.Element {
  if (props.form === undefined || props.useSettingsForm === undefined) {
    const t = translatorFor(resolveUiLanguage(undefined))
    return (
      <SettingsPage
        title={t('title')}
        badges={<Badge tone="warn">{t('missingFormTitle')}</Badge>}
        state="missing"
      >
        <Card variant="aux">
          <div className="dsweb-banner dsweb-banner-warn">{t('missingFormBody')}</div>
        </Card>
      </SettingsPage>
    )
  }
  return <SettingsSectionBody form={props.form} useSettingsForm={props.useSettingsForm} reload={props.reload} />
}

interface BodyProps {
  readonly form: SettingsFormHandle
  readonly useSettingsForm: NonNullable<SettingsSectionProps['useSettingsForm']>
  readonly reload?: (() => void) | undefined
}

type NoticeTone = 'info' | 'success' | 'warn' | 'error' | 'muted'

interface Notice {
  readonly tone: NoticeTone
  readonly text: string
}

/** 设置页主体：订阅宿主快照、维护草稿、原子保存。 */
function SettingsSectionBody({ form, useSettingsForm, reload }: BodyProps): JSX.Element {
  const snapshot = useSettingsForm(value => value)
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [listText, setListText] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [activeGroup, setActiveGroup] = useState<string>(GROUPS[0]?.id ?? '')

  const accepted = isRecord(snapshot.value) ? snapshot.value : EMPTY_OBJECT
  const user = isRecord(snapshot.user) ? snapshot.user : EMPTY_OBJECT
  const writable = snapshot.writable === true
  const ready = snapshot.status === 'ready'

  /** 草稿优先的「当前生效值」，供档位匹配与语言预览用。 */
  const effective = useMemo(() => {
    let merged = accepted
    if (draft !== null) {
      for (const field of FIELDS) {
        if (hasPath(draft, field.path)) merged = withEdit(merged, accepted, field.path, readPath(draft, field.path))
      }
    }
    return merged
  }, [draft, accepted])

  // 语言走草稿值：下拉一改就换语言，不用等保存（保存仍走原子的 mutate）。
  const language = resolveUiLanguage(readPath(effective, ['uiLanguage']))
  const t = useMemo(() => translatorFor(language), [language])

  /** 字段当前展示值：草稿优先，草稿未触碰过的取宿主当前值。 */
  const valueOf = useCallback((field: FieldSpec): unknown => {
    if (draft !== null && hasPath(draft, field.path)) return readPath(draft, field.path)
    return readPath(accepted, field.path)
  }, [draft, accepted])

  const errors = useMemo(() => {
    const found = new Map<string, FieldErrorCode>()
    for (const field of FIELDS) {
      const code = validateField(field, valueOf(field))
      if (code !== undefined) found.set(fieldKey(field), code)
    }
    return found
  }, [valueOf])

  /** 当前落在哪个风控档位；与任何档位都不全等即「自定义」。 */
  const riskTier = useMemo(() => matchRiskPreset(effective), [effective])

  const pendingOps = useMemo(() => diffOps(draft, accepted, user), [draft, accepted, user])
  const dirty = pendingOps.length > 0
  const blocked = errors.size > 0
  const canSave = writable && !busy && dirty && !blocked

  /** 哪些分组里有未保存的改动——左栏据此点一个小圆点。 */
  const dirtyGroups = useMemo(() => {
    const touched = new Set(pendingOps.map(op => op.path.join('.')))
    const groups = new Set<string>()
    for (const field of FIELDS) {
      if (touched.has(fieldKey(field))) groups.add(field.group)
    }
    return groups
  }, [pendingOps])

  const edit = useCallback((field: FieldSpec, value: unknown): void => {
    setNotice(null)
    setDraft(previous => withEdit(previous, accepted, field.path, value))
  }, [accepted])

  const editList = useCallback((field: FieldSpec, raw: string): void => {
    edit(field, parseList(raw))
    setListText(previous => ({ ...previous, [fieldKey(field)]: raw }))
  }, [edit])

  /** 套用某个风控档位：把该档位的值成套写进草稿（仍要按「保存」才落盘）。 */
  const applyTier = useCallback((preset: RiskPreset): void => {
    setNotice(null)
    setDraft(previous => applyRiskPreset(previous, accepted, preset))
  }, [accepted])

  const discard = useCallback((): void => {
    setDraft(null)
    setListText({})
    setNotice(null)
  }, [])

  const reloadFromHost = useCallback((): void => {
    setDraft(null)
    setListText({})
    setNotice(null)
    reload?.()
  }, [reload])

  const submit = useCallback(async (): Promise<void> => {
    if (!writable || busy) return
    const live = form.getSnapshot()
    const liveAccepted = isRecord(live.value) ? live.value : EMPTY_OBJECT
    const liveUser = isRecord(live.user) ? live.user : EMPTY_OBJECT
    const ops = diffOps(draft, liveAccepted, liveUser)
    if (ops.length === 0) {
      setNotice({ tone: 'info', text: t('nochange') })
      return
    }
    setBusy(true)
    try {
      const ok = await form.mutate(ops, live.revision)
      if (!ok) {
        setNotice({ tone: 'error', text: t('rejected') })
        return
      }
      const after = isRecord(form.getSnapshot().value) ? form.getSnapshot().value as Record<string, unknown> : EMPTY_OBJECT
      const mismatched = ops.some(op => op.op === 'set' && !sameValue(readPath(after, op.path), op.value))
      if (mismatched) {
        setNotice({ tone: 'warn', text: t('mismatch') })
        return
      }
      setDraft(null)
      setListText({})
      setNotice({ tone: 'success', text: t('saved') })
    } catch (error) {
      setNotice({ tone: 'error', text: `${t('failed')}${errorMessageOf(error, t)}` })
    } finally {
      setBusy(false)
    }
  }, [busy, draft, form, t, writable])

  const resetField = useCallback(async (field: FieldSpec): Promise<void> => {
    if (!writable || busy) return
    const live = form.getSnapshot()
    setBusy(true)
    try {
      const ok = await form.mutate([{ op: 'unset', path: [...field.path] }], live.revision)
      if (!ok) {
        setNotice({ tone: 'error', text: t('rejected') })
        return
      }
      setDraft(previous => withoutPath(previous, field.path))
      setListText((previous) => {
        const next = { ...previous }
        delete next[fieldKey(field)]
        return next
      })
      setNotice({ tone: 'success', text: t('resetDone') })
    } catch (error) {
      setNotice({ tone: 'error', text: `${t('failed')}${errorMessageOf(error, t)}` })
    } finally {
      setBusy(false)
    }
  }, [busy, form, t, writable])

  /** 跳到某个分组并把左栏高亮对上。 */
  const selectGroup = useCallback((groupId: string): void => {
    setActiveGroup(groupId)
    const node = document.getElementById(`dsweb-group-${groupId}`)
    if (node !== null) {
      const reduced = typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      node.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    }
  }, [])

  // 滚动时让左栏高亮跟着走；只在设置页挂载期间生效，卸载时断开。
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const nodes = GROUPS
      .map(group => document.getElementById(`dsweb-group-${group.id}`))
      .filter((node): node is HTMLElement => node !== null)
    if (nodes.length === 0) return
    const observer = new IntersectionObserver((entries) => {
      const hit = entries
        .filter(entry => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0]
      if (hit !== undefined) setActiveGroup(hit.target.id.replace('dsweb-group-', ''))
    }, { rootMargin: '-15% 0px -70% 0px' })
    for (const node of nodes) observer.observe(node)
    return () => observer.disconnect()
  }, [snapshot.status])

  // Ctrl+S / ⌘S 保存；只在设置页挂载期间生效。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey)) return
      if (event.key !== 's' && event.key !== 'S') return
      event.preventDefault()
      void submit()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [submit])

  if (snapshot.status === 'unavailable') {
    return (
      <SettingsPage
        title={t('title')}
        badges={<Badge tone="warn">{t('unavailableTitle')}</Badge>}
        state="unavailable"
      >
        <Card variant="aux">
          <div className="dsweb-banner dsweb-banner-warn">
            <span>
              <span className="dsweb-banner-title">{t('unavailableTitle')}</span>
              {t('unavailableBody')}
              <br />
              {t('unavailableHint')} <code className="dsweb-code">llm-deepseek-web</code>
            </span>
          </div>
        </Card>
      </SettingsPage>
    )
  }

  if (!ready) {
    return (
      <SettingsPage title={t('title')} subtitle={t('loading')} state="loading">
        <Card variant="aux">
          <Skeleton rows={4} />
        </Card>
      </SettingsPage>
    )
  }

  const status: Notice = notice ?? (blocked
    ? { tone: 'warn', text: t('invalid') }
    : dirty
      ? { tone: 'info', text: t('dirtyCount').replace('{n}', String(pendingOps.length)) }
      : { tone: 'muted', text: t('clean') })

  const actions = (
    <>
      <button
        type="button"
        className="dsweb-button dsweb-button-secondary"
        disabled={busy}
        title={t('reloadHint')}
        onClick={reloadFromHost}
      >
        {t('reload')}
      </button>
      <button type="button" className="dsweb-button dsweb-button-secondary" disabled={busy || !dirty} onClick={discard}>
        {t('discard')}
      </button>
      <button
        type="button"
        className="dsweb-button dsweb-button-primary"
        disabled={!canSave}
        onClick={() => { void submit() }}
      >
        {busy ? t('saving') : t('save')}
      </button>
    </>
  )

  const badges = (
    <>
      {writable
        ? <Badge tone={dirty ? 'info' : 'muted'}>{dirty ? t('dirty') : t('clean')}</Badge>
        : <Badge tone="warn">{t('readonly')}</Badge>}
      {blocked && <Badge tone="warn">{t('invalid')}</Badge>}
      <Badge tone="muted">{t('shortcut')}</Badge>
    </>
  )

  const rail = (
    <Rail
      label={t('groupsLabel')}
      items={GROUPS.map((group, index) => ({
        id: group.id,
        label: t(`group.${group.id}`),
        index: index + 1,
        dirty: dirtyGroups.has(group.id),
      }))}
      activeId={activeGroup}
      onSelect={selectGroup}
    />
  )

  return (
    <SettingsPage
      title={t('title')}
      subtitle={t('intro')}
      badges={badges}
      rail={rail}
      actions={actions}
      status={status.text}
      statusTone={status.tone}
      state="ready"
    >
      {!writable && (
        <Card variant="aux">
          <div className="dsweb-banner dsweb-banner-warn">{t('readonly')}</div>
        </Card>
      )}

      {GROUPS.map((group, groupIndex) => {
        const fields = FIELDS.filter(field => field.group === group.id)
        if (fields.length === 0) return null
        return (
          <Card
            key={group.id}
            groupId={group.id}
            index={groupIndex + 1}
            title={t(`group.${group.id}`)}
            hint={t(`group.${group.id}.hint`)}
            collapsible
          >
            {group.id === 'risk' && (
              <FieldRow
                fieldId="risk-tier"
                label={t('riskTier')}
                hint={t('riskTierHint')}
                wide
                control={(
                  <div className="dsweb-tier-buttons">
                    {RISK_PRESETS.map(preset => (
                      <button
                        key={preset.id}
                        type="button"
                        className={`dsweb-button ${riskTier === preset.id ? 'dsweb-button-primary' : 'dsweb-button-secondary'}`}
                        disabled={!writable || busy}
                        title={t(`risk.${preset.id}.hint`)}
                        onClick={() => applyTier(preset)}
                      >
                        {t(`risk.${preset.id}`)}
                      </button>
                    ))}
                    {riskTier === 'custom' && <Badge tone="warn">{t('riskCustom')}</Badge>}
                  </div>
                )}
              />
            )}
            {fields.map((field) => {
              const key = fieldKey(field)
              const domId = fieldDomId(field)
              const error = errors.get(key)
              const overridden = hasPath(user, field.path)
              const wide = field.kind === 'list' || field.kind === 'text'
              return (
                <FieldRow
                  key={key}
                  fieldId={key}
                  domId={domId}
                  label={t(`field.${key}`)}
                  badges={(
                    <>
                      {field.restart === true && <Badge tone="info">{t('restart')}</Badge>}
                      {overridden && <Badge tone="muted">{t('custom')}</Badge>}
                    </>
                  )}
                  hint={field.hint === undefined ? undefined : t(`field.${key}.hint`)}
                  error={error === undefined ? undefined : errorText(field, error, t)}
                  wide={wide}
                  control={(
                    <FieldControl
                      field={field}
                      value={valueOf(field)}
                      domId={domId}
                      listText={listText[key]}
                      invalid={error !== undefined}
                      disabled={!writable || busy}
                      placeholder={t('listPlaceholder')}
                      optionLabel={field.optionLabels === undefined
                        ? undefined
                        : option => t(`field.${key}.opt.${option}`)}
                      onChange={next => edit(field, next)}
                      onChangeList={raw => editList(field, raw)}
                    />
                  )}
                  reset={overridden
                    ? (
                        <button
                          type="button"
                          className="dsweb-link"
                          disabled={!writable || busy}
                          onClick={() => { void resetField(field) }}
                        >
                          {t('reset')}
                        </button>
                      )
                    : undefined}
                />
              )
            })}
          </Card>
        )
      })}

      <LoginCard t={t} />
      <LoginCard t={t} channel="glm" />
      <LoginCard t={t} channel="doubao" />
      <LedgerCard t={t} />
      <ArchiveCleanupCard t={t} />
    </SettingsPage>
  )
}

/** 校验错误的人话文案。 */
function errorText(field: FieldSpec, code: FieldErrorCode, t: Translate): string {
  switch (code) {
    case 'number':
      return t('errNumber')
    case 'min':
      return `${t('errMin')} ${field.min ?? ''}`.trim()
    case 'max':
      return `${t('errMax')} ${field.max ?? ''}`.trim()
    case 'option':
      return t('errOption')
    default:
      return ''
  }
}
