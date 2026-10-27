/**
 * 插件配置页（dsh 0.2）。
 *
 * dsh 0.2 的插件配置界面不再是「Config schema 自动投影」，而是由插件客户端半侧
 * 显式注册到 Plugin Manager 声明的 slot 上。本文件注册 `plugins.row.config`，
 * key 为 `<包名>#<行 id>`，即 `dsh-deepseek-web-xxxxxgold#llm-deepseek-web`；侧栏「插件」页
 * → 组合包 `dsh-deepseek-web-xxxxxgold` → 行 `llm-deepseek-web` 上会因此多出「配置」入口。
 *
 * 这是 0.1 时代留下的旧入口，0.2 起改参数的正路是侧栏「设置」→「DeepSeek 网页」。
 * 两处界面共用 `settings-ui.tsx` 的展示层与 `i18n.ts` 的字典，所以外观与语言完全一致；
 * 区别只有：这里不渲染调用台账与归档清理卡（避免同一条只读路由被两个入口重复请求）。
 *
 * 读写全部走宿主传入的 `form`（`ConfigPageForm`）：
 * - `form.state` 是 `ConfigFormSnapshot`，含解析后的 `value`、`revision`、`writable`；
 * - `form.mutate(ops, revision)` 用路径操作原子提交多字段修改。
 *
 * 表单是暂存式的：只有点「保存」才写入，离开页面丢弃草稿。
 *
 * @module dsh-deepseek-web-xxxxxgold/client/config-page
 */

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {
  FIELDS,
  GROUPS,
  RISK_PRESETS,
  diffOps,
  fieldDomId,
  fieldKey,
  matchRiskPreset,
  parseList,
  readPath,
  validateField,
  type FieldErrorCode,
  type FieldPath,
  type FieldSpec,
} from './config-fields.ts'
import { resolveUiLanguage, translatorFor, type Translate } from './i18n.ts'
import { Badge, Card, FieldControl, FieldRow, Rail, SettingsPage, type Tone } from './settings-ui.tsx'

/** 本包在 profile 里的 npm 包名。 */
export const PACKAGE_NAME = 'dsh-deepseek-web-xxxxxgold'

/** 插件入口在包自带 patch 里声明的行 id；与包名一起构成槽位 key，也是宿主的 settings entry id。 */
export const ROW_ENTRY_ID = 'llm-deepseek-web'

/** 本插件在 Plugin Manager 里的 `plugins.row.config` 槽位 key。 */
export const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ROW_ENTRY_ID}`

/**
 * 判断一个字段是否应当显示。
 *
 * `visibleWhen` 支持单条件或条件数组：数组要求**全部满足**，
 * 这样「provider 是 kimi 且 kimiMode 是 project」才能精确只显示项目链接框。
 */
function isFieldVisible(
  rule: { readonly path: FieldPath; readonly equals: string } | readonly { readonly path: FieldPath; readonly equals: string }[] | undefined,
  current: unknown,
): boolean {
  if (rule === undefined) return true
  // `Array.isArray` 的守卫签名是 `arg is any[]`，对 `readonly T[]` 不窄化；
  // 用 `in` 判断单条件，才能把联合类型正确拆成「一条」与「一组」。
  const rules = 'path' in rule ? [rule] : rule
  return rules.every(item => readPath(current, item.path) === item.equals)
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

/**
 * 渲染本插件的配置页。
 *
 * @param props - 槽位宿主传入的 `view` 与页面表单句柄。
 * @returns `summary` 为卡片一行说明；`page` 为可编辑表单。
 */
export function DeepSeekWebConfigPage({ view, form }: PluginConfigViewProps): JSX.Element {
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null)
  const [activeGroup, setActiveGroup] = useState<string>(GROUPS[0]?.id ?? '')

  // 只驱动视觉，不参与数据流：分组标题出现后才开始观察。
  useEffect(() => {
    if (view !== 'page' || typeof IntersectionObserver === 'undefined') return
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
  }, [view])

  const accepted = (form?.state.value ?? {}) as Record<string, unknown>
  const language = resolveUiLanguage(readPath(draft ?? accepted, ['uiLanguage']))
  const t = translatorFor(language)

  if (view === 'summary') {
    return <>{t('configSummary')}</>
  }

  if (form === undefined) {
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

  const user = (form.state.user ?? {}) as Record<string, unknown>
  const revision = form.state.revision
  // ConfigFormSnapshot 只有 writable（宿主是否接受写入），没有 `mode`；
  // 0.2 的 Host 持久化永远给 true，非 Host 部署给 false。
  const writable = form.state.writable === true
  const current = draft ?? accepted
  const errors = new Map<string, FieldErrorCode>()
  for (const field of FIELDS) {
    const code = validateField(field, readPath(current, field.path))
    if (code !== undefined) errors.set(fieldKey(field), code)
  }
  const blocked = errors.size > 0
  const pending = diffOps(draft, accepted, user)
  const dirty = pending.length > 0

  /** 暂存一次字段修改。 */
  const edit = (path: FieldPath, value: unknown): void => {
    setNotice(null)
    setDraft(previous => {
      const next: Record<string, unknown> = { ...(previous ?? accepted) }
      let node = next
      for (const key of path.slice(0, -1)) {
        const existing = node[key]
        const child = existing !== null && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {}
        node[key] = child
        node = child
      }
      node[path[path.length - 1]!] = value
      return next
    })
  }

  /** 提交与本页字段相关的全部改动。 */
  const save = async (): Promise<void> => {
    if (!form || draft === null) return
    if (blocked) {
      setNotice({ tone: 'warn', text: t('invalid') })
      return
    }
    const ops = diffOps(draft, accepted, user)
    if (ops.length === 0) {
      setNotice({ tone: 'info', text: t('nochange') })
      return
    }
    setBusy(true)
    try {
      const ok = await form.mutate(ops, revision)
      setNotice(ok ? { tone: 'success', text: t('saved') } : { tone: 'error', text: t('rejected') })
      if (ok) setDraft(null)
    } catch (error) {
      setNotice({ tone: 'error', text: `${t('failed')}${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setBusy(false)
    }
  }

  const selectGroup = (groupId: string): void => {
    setActiveGroup(groupId)
    const node = document.getElementById(`dsweb-group-${groupId}`)
    if (node !== null) {
      const reduced = typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      node.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    }
  }

  const status = notice ?? (blocked
    ? { tone: 'warn' as Tone, text: t('invalid') }
    : dirty
      ? { tone: 'info' as Tone, text: t('dirtyCount').replace('{n}', String(pending.length)) }
      : { tone: 'muted' as Tone, text: t('clean') })

  const actions = (
    <>
      <button
        type="button"
        className="dsweb-button dsweb-button-secondary"
        disabled={busy || !dirty}
        onClick={() => { setDraft(null); setNotice(null) }}
      >
        {t('discard')}
      </button>
      <button
        type="button"
        className="dsweb-button dsweb-button-primary"
        disabled={!writable || busy || !dirty || blocked}
        onClick={() => { void save() }}
      >
        {busy ? t('saving') : t('save')}
      </button>
    </>
  )

  return (
    <SettingsPage
      title={t('title')}
      subtitle={t('intro')}
      badges={(
        <>
          {writable
            ? <Badge tone={dirty ? 'info' : 'muted'}>{dirty ? t('dirty') : t('clean')}</Badge>
            : <Badge tone="warn">{t('readonly')}</Badge>}
          {blocked && <Badge tone="warn">{t('invalid')}</Badge>}
        </>
      )}
      rail={(
        <Rail
          label={t('groupsLabel')}
          items={GROUPS.map((group, index) => ({
            id: group.id,
            label: t(`group.${group.id}`),
            index: index + 1,
          }))}
          activeId={activeGroup}
          onSelect={selectGroup}
        />
      )}
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
        const fields = FIELDS.filter(field => field.group === group.id && isFieldVisible(field.visibleWhen, current))
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
                    {RISK_PRESETS.map(preset => {
                      const active = matchRiskPreset(current) === preset.id
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          className={`dsweb-button ${active ? 'dsweb-button-primary' : 'dsweb-button-secondary'}`}
                          disabled={!writable || busy}
                          title={t(`risk.${preset.id}.hint`)}
                          onClick={() => {
                            for (const item of preset.values) edit(item.path, item.value)
                          }}
                        >
                          {t(`risk.${preset.id}`)}
                        </button>
                      )
                    })}
                    {matchRiskPreset(current) === 'custom' && <Badge tone="warn">{t('riskCustom')}</Badge>}
                  </div>
                )}
              />
            )}
            {fields.map((field) => {
              const key = fieldKey(field)
              const domId = fieldDomId(field)
              const error = errors.get(key)
              const value = readPath(current, field.path)
              const invalid = error !== undefined
              const wide = field.kind === 'list' || field.kind === 'text'
              return (
                <FieldRow
                  key={key}
                  fieldId={key}
                  domId={domId}
                  label={t(`field.${key}`)}
                  badges={field.restart === true ? <Badge tone="info">{t('restart')}</Badge> : undefined}
                  hint={field.hint === undefined ? undefined : t(`field.${key}.hint`)}
                  error={error === undefined ? undefined : errorText(field, error, t)}
                  wide={wide}
                  control={(
                    <FieldControl
                      field={field}
                      value={value}
                      domId={domId}
                      invalid={invalid}
                      disabled={!writable || busy}
                      placeholder={t('listPlaceholder')}
                      optionLabel={field.optionLabels === undefined
                        ? undefined
                        : option => t(`field.${key}.opt.${option}`)}
                      onChange={next => edit(field.path, next)}
                      onChangeList={raw => edit(field.path, parseList(raw))}
                    />
                  )}
                />
              )
            })}
          </Card>
        )
      })}
    </SettingsPage>
  )
}
