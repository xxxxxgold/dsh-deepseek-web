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
 * 菜单只在设置壳在场时出现（`ctx.slots.inject('settings.section', …)`），
 * 文案走 `ctx.locale` 的 zh/en 字典，导航标签只占一个短词。
 *
 * @module dsh-deepseek-web-littlecar30/client/settings-section
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
  formatList,
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

/** locale 命名空间；字典键与设置页文案一一对应。 */
export const LOCALE_NAMESPACE = 'dsh-deepseek-web'

/** `settings.section` 里的 section id。 */
const SECTION_ID = 'deepseek-web'

/** 排序：账号 -10 / 通用 0 / 模型 10 / 插件 15 之后。 */
const SECTION_ORDER = 20

/** 父级传给槽位组件的标准 props 之外，我们自己的注入面。 */
type Translate = (key: string) => string

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

/** 静态文案。 */
const STATIC_COPY = {
  zh: {
    nav: 'DeepSeek 网页',
    title: 'DeepSeek 网页通道',
    intro: '本插件把 DeepSeek 网页版接入 DSH。改动保存后立即生效；标「重启生效」的项在重启 DSH 后生效。',
    loading: '正在读取宿主配置…',
    unavailableTitle: '设置暂不可用',
    unavailableBody:
      '宿主没有暴露本插件的可写配置命名空间（llm-deepseek-web）。通常是插件后端未加载，或当前 DSH 版本未开启设置写入。',
    unavailableHint: '仍可直接编辑 profile 的 cordis.patch.yml 覆盖 config。',
    missingForm: '宿主未提供配置表单句柄，无法在此编辑。',
    readonly: '当前部署不接受设置写入，字段仅供参考。',
    riskTier: '风控模式（整体档位）',
    riskTierHint: '点一个档位就把相关的发送节奏参数成套写进草稿，再按「保存」生效；手动改下面任一项即变成「自定义」。',
    riskCustom: '自定义',
    custom: '已自定义',
    restart: '重启生效',
    reset: '恢复默认',
    resetDone: '已恢复默认值。',
    save: '保存',
    saving: '保存中…',
    discard: '放弃修改',
    reload: '重新读取',
    reloadHint: '从宿主重新读取（丢弃草稿）',
    dirty: '有未保存的改动',
    clean: '没有未保存的改动',
    saved: '已保存。',
    nochange: '没有改动。',
    rejected: '宿主未接受这次保存（版本冲突或校验失败），已重新读取宿主配置；草稿仍在，可直接再点保存。',
    failed: '保存失败：',
    mismatch: '已提交，但回读到的值与草稿不一致，请点「重新读取」确认。',
    invalid: '有字段取值不合法',
    errNumber: '请填数字',
    errMin: '不能小于',
    errMax: '不能大于',
    errOption: '不是可选值',
    listPlaceholder: '每行一个',
    shortcut: 'Ctrl+S 保存',
    unknownError: '未知错误',
    'ledger.lang': 'zh',
    'ledger.title': '调用台账（只读）',
    'ledger.hint': '按天记录本机最近的网页调用元信息（不含对话内容与凭证），保留 7 天。相邻间隔只统计真正打过网页的成功对话轮，排队时间不算。',
    'ledger.unavailable': '读不到台账：宿主没有提供 webServer 服务，或当前页面不是本机同源。这只影响这张卡片，不影响发送。',
    'ledger.empty': '还没有记录（要么还没真正发过请求，要么刚装不久）。',
    'ledger.total': '近 7 天调用',
    'ledger.chat': '其中对话轮',
    'ledger.failed': '失败次数',
    'ledger.minGap': '最短间隔',
    'ledger.medianGap': '中位间隔',
    'ledger.p90Gap': 'p90 间隔',
    'ledger.tight': '出现过 30 秒以内的连环请求——这正是最容易被判机器行为的形态，建议调大发送间隔或长休轮数。',
    'ledger.failures': '失败分布：',
    'ledger.days': '按天',
    'ledger.perDay': ' 次',
    'ledger.minutes': '{m} 分 {s} 秒',
    'doctor.title': '安装自检',
    'doctor.hint': '只报事实、不做修复。默认只跑静态检查（配置 / 浏览器 / 目录 / 构建标识），不会为了自检启动浏览器。',
    'doctor.run': '运行自检',
    'doctor.running': '自检中…',
    'doctor.unavailable': '自检接口不可用（同上：宿主没有 webServer 服务）。也可以在命令行运行 npm run doctor。',
    'doctor.ready': 'Doctor result: ready（有 warning 但无 error）',
    'doctor.notReady': 'Doctor result: not ready（存在 error，按上面的条目逐项排查）',
  },
  en: {
    nav: 'DeepSeek Web',
    title: 'DeepSeek Web channel',
    intro: 'This plugin connects the DeepSeek web app to DSH. Saved changes apply immediately; items marked “Restart to apply” take effect after a DSH restart.',
    loading: 'Reading host settings…',
    unavailableTitle: 'Settings unavailable',
    unavailableBody:
      'The host does not expose this plugin’s writable settings namespace (llm-deepseek-web). Usually the plugin host half is not loaded, or this DSH build does not accept settings writes.',
    unavailableHint: 'You can still override config in the profile’s cordis.patch.yml.',
    missingForm: 'The host did not provide a settings form handle, so this page cannot edit anything.',
    readonly: 'This deployment does not accept settings writes; fields are read-only.',
    riskTier: 'Risk control profile',
    riskTierHint: 'Picking a profile writes the related send-pacing values into the draft; press Save to apply. Editing any value by hand shows “Custom”.',
    riskCustom: 'Custom',
    custom: 'Customized',
    restart: 'Restart to apply',
    reset: 'Reset to default',
    resetDone: 'Reset to the default value.',
    save: 'Save',
    saving: 'Saving…',
    discard: 'Discard changes',
    reload: 'Reload from host',
    reloadHint: 'Re-read host settings and drop the draft',
    dirty: 'Unsaved changes',
    clean: 'No unsaved changes',
    saved: 'Saved.',
    nochange: 'Nothing to save.',
    rejected:
      'The host rejected this save (revision conflict or validation failure). Host settings were re-read; your draft is kept — press Save again.',
    failed: 'Save failed: ',
    mismatch: 'Submitted, but the re-read value differs from the draft. Press “Reload from host” to confirm.',
    invalid: 'Some values are invalid',
    errNumber: 'Enter a number',
    errMin: 'Must be at least',
    errMax: 'Must be at most',
    errOption: 'Not an allowed value',
    listPlaceholder: 'One per line',
    shortcut: 'Ctrl+S to save',
    unknownError: 'unknown error',
    'ledger.lang': 'en',
    'ledger.title': 'Call ledger (read-only)',
    'ledger.hint': 'Daily metadata about this machine’s web calls (no message content, no credentials), kept for 7 days. Gaps only count successful chat turns that actually reached the web page; queueing time is excluded.',
    'ledger.unavailable': 'Cannot read the ledger: the host exposes no webServer service, or this page is not same-origin. Only this card is affected — sending still works.',
    'ledger.empty': 'No entries yet (either nothing was really sent, or the plugin was just installed).',
    'ledger.total': 'Calls (7d)',
    'ledger.chat': 'Chat turns',
    'ledger.failed': 'Failures',
    'ledger.minGap': 'Shortest gap',
    'ledger.medianGap': 'Median gap',
    'ledger.p90Gap': 'p90 gap',
    'ledger.tight': 'A back-to-back request under 30 seconds was observed — the clearest machine-behaviour signal. Consider larger send gaps or a longer long-run pause.',
    'ledger.failures': 'Failures: ',
    'ledger.days': 'Per day',
    'ledger.perDay': ' calls',
    'ledger.minutes': '{m}m {s}s',
    'doctor.title': 'Install self-check',
    'doctor.hint': 'Reports facts only; it never fixes anything. Only static checks run by default (config / browser / directories / build id) — no browser is started for a self-check.',
    'doctor.run': 'Run self-check',
    'doctor.running': 'Checking…',
    'doctor.unavailable': 'Self-check route unavailable (same reason: no webServer service). You can also run npm run doctor from a shell.',
    'doctor.ready': 'Doctor result: ready (warnings allowed, no errors)',
    'doctor.notReady': 'Doctor result: not ready (errors found — work through the items above)',
  },
} as const

/** 由字段规格派生的分组文案与字段文案，拼进两份字典。 */
function buildDictionaries(): { zh: Record<string, string>; en: Record<string, string> } {
  const zh: Record<string, string> = { ...STATIC_COPY.zh }
  const en: Record<string, string> = { ...STATIC_COPY.en }
  for (const group of GROUPS) {
    zh[`group.${group.id}`] = group.label.zh
    en[`group.${group.id}`] = group.label.en
    zh[`group.${group.id}.hint`] = group.hint.zh
    en[`group.${group.id}.hint`] = group.hint.en
  }
  for (const field of FIELDS) {
    const key = fieldKey(field)
    zh[`field.${key}`] = field.label.zh
    en[`field.${key}`] = field.label.en
    if (field.hint !== undefined) {
      zh[`field.${key}.hint`] = field.hint.zh
      en[`field.${key}.hint`] = field.hint.en
    }
  }
  for (const preset of RISK_PRESETS) {
    zh[`risk.${preset.id}`] = preset.label.zh
    en[`risk.${preset.id}`] = preset.label.en
    zh[`risk.${preset.id}.hint`] = preset.hint.zh
    en[`risk.${preset.id}.hint`] = preset.hint.en
  }
  return { zh, en }
}

/** 两份完整的 zh/en 字典；`ctx.locale.register` 要求两边键集合一致。 */
export const LOCALE_DICTIONARIES = buildDictionaries()

const fallbackTranslate: Translate = key => key

/** 空对象占位，保证 useMemo 依赖身份稳定。 */
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
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: SECTION_ORDER,
    label: () => t('nav'),
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
  const t = props.t ?? fallbackTranslate
  if (props.form === undefined || props.useSettingsForm === undefined) {
    return (
      <div className="dsweb-settings" data-dsweb-settings="missing">
        <h2 className="dsweb-settings-title">{t('title')}</h2>
        <div className="dsweb-banner dsweb-banner-warn">{t('missingForm')}</div>
      </div>
    )
  }
  return <SettingsSectionBody form={props.form} useSettingsForm={props.useSettingsForm} t={t} reload={props.reload} />
}

interface BodyProps {
  readonly form: SettingsFormHandle
  readonly useSettingsForm: NonNullable<SettingsSectionProps['useSettingsForm']>
  readonly t: Translate
  readonly reload?: (() => void) | undefined
}

type NoticeTone = 'info' | 'success' | 'warn' | 'error'

interface Notice {
  readonly tone: NoticeTone
  readonly text: string
}

const STATUS_CLASS: Record<NoticeTone, string> = {
  info: 'dsweb-status',
  success: 'dsweb-status dsweb-status-success',
  warn: 'dsweb-status dsweb-status-warn',
  error: 'dsweb-status dsweb-status-error',
}

/** 设置页主体：订阅宿主快照、维护草稿、原子保存。 */
function SettingsSectionBody({ form, useSettingsForm, t, reload }: BodyProps): JSX.Element {
  const snapshot = useSettingsForm(value => value)
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [listText, setListText] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const accepted = isRecord(snapshot.value) ? snapshot.value : EMPTY_OBJECT
  const user = isRecord(snapshot.user) ? snapshot.user : EMPTY_OBJECT
  const writable = snapshot.writable === true
  const ready = snapshot.status === 'ready'

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

  /** 草稿优先的「当前生效值」，供档位匹配用（草稿没碰过的字段取宿主值）。 */
  const effective = useMemo(() => {
    let merged = accepted
    if (draft !== null) {
      for (const field of FIELDS) {
        if (hasPath(draft, field.path)) merged = withEdit(merged, accepted, field.path, readPath(draft, field.path))
      }
    }
    return merged
  }, [draft, accepted])

  /** 当前落在哪个风控档位；与任何档位都不全等即「自定义」。 */
  const riskTier = useMemo(() => matchRiskPreset(effective), [effective])

  const pendingOps = useMemo(() => diffOps(draft, accepted, user), [draft, accepted, user])
  const dirty = pendingOps.length > 0
  const blocked = errors.size > 0
  const canSave = writable && !busy && dirty && !blocked

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
      <div className="dsweb-settings" data-dsweb-settings="unavailable">
        <h2 className="dsweb-settings-title">{t('title')}</h2>
        <div className="dsweb-banner dsweb-banner-warn">
          <span>
            <span className="dsweb-banner-title">{t('unavailableTitle')}</span>
            {t('unavailableBody')}
            <br />
            {t('unavailableHint')} <code className="dsweb-code">llm-deepseek-web</code>
          </span>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="dsweb-settings" data-dsweb-settings="loading">
        <div>
          <h2 className="dsweb-settings-title">{t('title')}</h2>
          <p className="dsweb-settings-intro">{t('loading')}</p>
        </div>
        <div className="dsweb-skeleton" />
        <div className="dsweb-skeleton" />
        <div className="dsweb-skeleton" />
        <div className="dsweb-skeleton" />
      </div>
    )
  }

  const status: Notice = notice ?? (blocked
    ? { tone: 'warn', text: t('invalid') }
    : dirty
      ? { tone: 'info', text: t('dirty') }
      : { tone: 'info', text: t('clean') })

  const actions = (
    <div className="dsweb-actions">
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
    </div>
  )

  return (
    <div className="dsweb-settings" data-dsweb-settings="ready">
      <div>
        <h2 className="dsweb-settings-title">{t('title')}</h2>
        <p className="dsweb-settings-intro">{t('intro')}</p>
      </div>

      {!writable && <div className="dsweb-banner dsweb-banner-warn">{t('readonly')}</div>}

      <div className="dsweb-settings-toolbar">
        {dirty ? <span className="dsweb-badge dsweb-badge-warn">{t('dirty')}</span> : <span className="dsweb-badge">{t('clean')}</span>}
        {blocked && <span className="dsweb-badge dsweb-badge-warn">{t('invalid')}</span>}
        <span className="dsweb-settings-spacer" />
        <span className="dsweb-badge">{t('shortcut')}</span>
        {actions}
      </div>

      {GROUPS.map((group) => {
        const fields = FIELDS.filter(field => field.group === group.id)
        if (fields.length === 0) return null
        return (
          <section className="dsweb-group" key={group.id} aria-labelledby={`dsweb-group-${group.id}`}>
            <h3 className="dsweb-group-title" id={`dsweb-group-${group.id}`}>{t(`group.${group.id}`)}</h3>
            <p className="dsweb-group-hint">{t(`group.${group.id}.hint`)}</p>
            {group.id === 'risk' && (
              <div className="dsweb-row dsweb-row-wide" data-field="risk-tier">
                <div className="dsweb-row-text">
                  <span className="dsweb-row-label">{t('riskTier')}</span>
                  <p className="dsweb-row-hint">{t('riskTierHint')}</p>
                </div>
                <div
                  className="dsweb-row-control"
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}
                >
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
                  {riskTier === 'custom' && <span className="dsweb-badge dsweb-badge-warn">{t('riskCustom')}</span>}
                </div>
              </div>
            )}
            {fields.map(field => (
              <FieldRow
                key={fieldKey(field)}
                field={field}
                value={valueOf(field)}
                listText={listText[fieldKey(field)]}
                error={errors.get(fieldKey(field))}
                overridden={hasPath(user, field.path)}
                disabled={!writable || busy}
                t={t}
                onChange={next => edit(field, next)}
                onChangeList={raw => editList(field, raw)}
                onReset={() => { void resetField(field) }}
              />
            ))}
          </section>
        )
      })}

      <LedgerCard t={t} />

      <footer className="dsweb-footer">
        <span className={STATUS_CLASS[status.tone]} role="status" aria-live="polite">{status.text}</span>
        {actions}
      </footer>
    </div>
  )
}

interface FieldRowProps {
  readonly field: FieldSpec
  readonly value: unknown
  readonly listText: string | undefined
  readonly error: FieldErrorCode | undefined
  readonly overridden: boolean
  readonly disabled: boolean
  readonly t: Translate
  onChange(value: unknown): void
  onChangeList(raw: string): void
  onReset(): void
}

/** 一行字段：左侧标题/说明/错误，右侧控件与「恢复默认」。 */
function FieldRow(props: FieldRowProps): JSX.Element {
  const { field, value, listText, error, overridden, disabled, t } = props
  const domId = fieldDomId(field)
  const key = fieldKey(field)
  // 长文本（URL、目录）和列表用整行宽度，避免输入框被挤成一小条
  const wide = field.kind === 'list' || field.kind === 'text'
  const hint = field.hint === undefined ? null : t(`field.${key}.hint`)
  return (
    <div className={`dsweb-row${wide ? ' dsweb-row-wide' : ''}`} data-field={key}>
      <div className="dsweb-row-text">
        <label className="dsweb-row-label" htmlFor={domId}>
          <span>{t(`field.${key}`)}</span>
          {field.restart === true && <span className="dsweb-badge dsweb-badge-info">{t('restart')}</span>}
          {overridden && <span className="dsweb-badge">{t('custom')}</span>}
        </label>
        {hint !== null && <p className="dsweb-row-hint">{hint}</p>}
        {error !== undefined && <p className="dsweb-row-error">{errorText(field, error, t)}</p>}
      </div>
      <div className="dsweb-row-control">
        <FieldControl
          field={field}
          value={value}
          listText={listText}
          domId={domId}
          invalid={error !== undefined}
          disabled={disabled}
          t={t}
          onChange={props.onChange}
          onChangeList={props.onChangeList}
        />
        {overridden && (
          <button type="button" className="dsweb-link" disabled={disabled} onClick={props.onReset}>
            {t('reset')}
          </button>
        )}
      </div>
    </div>
  )
}

interface FieldControlProps {
  readonly field: FieldSpec
  readonly value: unknown
  readonly listText: string | undefined
  readonly domId: string
  readonly invalid: boolean
  readonly disabled: boolean
  readonly t: Translate
  onChange(value: unknown): void
  onChangeList(raw: string): void
}

/** 按字段类型渲染控件。 */
function FieldControl(props: FieldControlProps): JSX.Element {
  const { field, value, listText, domId, invalid, disabled, t, onChange, onChangeList } = props

  if (field.kind === 'boolean') {
    const checked = value === true
    return (
      <input
        id={domId}
        className="dsweb-switch"
        type="checkbox"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
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
        disabled={disabled}
        value={selected}
        onChange={event => onChange(event.target.value === '' ? null : event.target.value)}
      >
        {selected === '' && <option value="">—</option>}
        {rendered.map(option => <option key={option} value={option}>{option}</option>)}
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
        className={`dsweb-input${invalid ? ' dsweb-input-invalid' : ''}`}
        type="number"
        inputMode="numeric"
        step={1}
        min={field.min}
        max={field.max}
        disabled={disabled}
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
        className="dsweb-textarea"
        rows={4}
        spellCheck={false}
        placeholder={t('listPlaceholder')}
        disabled={disabled}
        value={listText ?? formatList(value)}
        onChange={event => onChangeList(event.target.value)}
      />
    )
  }

  return (
    <input
      id={domId}
      className="dsweb-input"
      type="text"
      spellCheck={false}
      disabled={disabled}
      value={typeof value === 'string' ? value : ''}
      onChange={event => onChange(event.target.value)}
    />
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
