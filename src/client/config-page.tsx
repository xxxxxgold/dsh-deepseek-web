/**
 * 插件配置页（dsh 0.2）。
 *
 * dsh 0.2 的插件配置界面不再是「Config schema 自动投影」，而是由插件客户端半侧
 * 显式注册到 Plugin Manager 声明的 slot 上。本文件注册 `plugins.row.config`，
 * key 为 `<包名>#<行 id>`，即 `dsh-deepseek-web-xxxxxgold#llm-deepseek-web`；侧栏「插件」页
 * → 组合包 `dsh-deepseek-web-xxxxxgold` → 行 `llm-deepseek-web` 上会因此多出「配置」入口。
 *
 * 读写全部走宿主传入的 `form`（`ConfigPageForm`）：
 * - `form.state` 是 `ConfigFormSnapshot`，含解析后的 `value`、`revision`、`writable`；
 * - `form.mutate(ops, revision)` 用路径操作原子提交多字段修改。
 *
 * 表单是暂存式的：只有点「保存」才写入，离开页面丢弃草稿。这与上游
 * 「只有保存才写入」的契约一致。
 *
 * @module dsh-deepseek-web-xxxxxgold/client/config-page
 */

import { useState } from 'react'
import type { JSX } from 'react'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { FIELDS, RISK_PRESETS, diffOps, errorMessageZh, fieldKey, matchRiskPreset, parseList, readPath, validateField, type FieldErrorCode, type FieldPath } from './config-fields.ts'

/** 本包在 profile 里的 npm 包名。 */
export const PACKAGE_NAME = 'dsh-deepseek-web-xxxxxgold'

/** 插件入口在包自带 patch 里声明的行 id；与包名一起构成槽位 key，也是宿主的 settings entry id。 */
export const ROW_ENTRY_ID = 'llm-deepseek-web'

/** 本插件在 Plugin Manager 里的 `plugins.row.config` 槽位 key。 */
export const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ROW_ENTRY_ID}`

const labelStyle = { display: 'block', fontSize: 13, lineHeight: '20px', marginBottom: 4 } as const
const hintStyle = { fontSize: 12, lineHeight: '18px', opacity: 0.7, margin: '2px 0 0' } as const
const rowStyle = { marginBottom: 14, maxWidth: 560 } as const
const inputStyle = { font: 'inherit', padding: '6px 8px', width: '100%', boxSizing: 'border-box' } as const

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
  if (Array.isArray(rule)) return rule.every(item => readPath(current, item.path) === item.equals)
  return readPath(current, rule.path) === rule.equals
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
  const [notice, setNotice] = useState<string | null>(null)

  if (view === 'summary') {
    return <>审核通道、网页版模型入口、工具白名单、频控退避、过程提示、浏览器自愈与窗口聚焦。</>
  }

  const accepted = (form?.state.value ?? {}) as Record<string, unknown>
  const user = (form?.state.user ?? {}) as Record<string, unknown>
  const revision = form?.state.revision
  // ConfigFormSnapshot 只有 writable（宿主是否接受写入），没有 `mode`；
  // 0.2 的 Host 持久化永远给 true，非 Host 部署给 false。
  const writable = form?.state.writable === true
  const current = draft ?? accepted
  const errors = new Map<string, FieldErrorCode>()
  for (const field of FIELDS) {
    const code = validateField(field, readPath(current, field.path))
    if (code !== undefined) errors.set(fieldKey(field), code)
  }
  const blocked = errors.size > 0

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
      setNotice('有非法值，未保存。')
      return
    }
    const ops = diffOps(draft, accepted, user)
    if (ops.length === 0) {
      setNotice('没有改动。')
      return
    }
    setBusy(true)
    try {
      const ok = await form.mutate(ops, revision)
      setNotice(ok ? '已保存。' : '保存被宿主拒绝，已恢复宿主值。')
      if (ok) setDraft(null)
    } catch (error) {
      setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  if (form === undefined) {
    return (
      <div>
        <p style={hintStyle}>宿主未提供该条目的配置句柄，无法在此编辑。</p>
        <p style={hintStyle}>
          宿主的 <code>formFor()</code> 只在 <code>settings.describe().namespaces</code>
          含 <code>ns === &apos;{ROW_ENTRY_ID}&apos;</code> 时给出表单，而该清单只收录
          Config 里标了 <code>.volatile()</code> 的字段所在的条目。
          若此提示仍出现，请确认该 entry 的 id、以及其字段是否都标了 <code>.volatile()</code>；
          亦可改走 profile 的 <code>cordis.patch.yml</code> 覆盖 <code>config</code>。
        </p>
      </div>
    )
  }

  return (
    <div>
      {!writable && (
        <p style={{ ...hintStyle, marginBottom: 12 }}>
          当前部署不接受写入（只读或非 Host 持久化），字段仅供参考；请改用 profile 的 cordis.patch.yml。
        </p>
      )}

      <div style={rowStyle}>
        <span style={labelStyle}>风控模式（整体档位）</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {RISK_PRESETS.map((preset) => {
            const active = matchRiskPreset(current) === preset.id
            return (
              <button
                key={preset.id}
                type="button"
                disabled={!writable || busy}
                title={preset.hint.zh}
                style={active ? { fontWeight: 600 } : undefined}
                onClick={() => {
                  for (const item of preset.values) edit(item.path, item.value)
                }}
              >
                {active ? `● ${preset.label.zh}` : preset.label.zh}
              </button>
            )
          })}
          {matchRiskPreset(current) === 'custom' && <span style={hintStyle}>当前：自定义</span>}
        </div>
        <p style={hintStyle}>
          点档位会把发送节奏参数成套写进草稿，再按「保存」生效；手动改下面任一项即变成「自定义」。并发上限与标签页上限不受档位影响。
        </p>
      </div>

      {FIELDS.filter((field) => isFieldVisible(field.visibleWhen, current)).map((field) => {
        const value = readPath(current, field.path)
        const id = `dsweb-row-${fieldKey(field)}`
        const error = errors.get(fieldKey(field))
        const invalid = error !== undefined
        return (
          <div key={id} style={rowStyle}>
            <label style={labelStyle} htmlFor={id}>{field.label.zh}</label>
            {field.kind === 'boolean' && (
              <input
                id={id}
                type="checkbox"
                disabled={!writable}
                checked={value === true}
                onChange={event => edit(field.path, event.target.checked)}
              />
            )}
            {field.kind === 'select' && (
              <select
                id={id}
                style={inputStyle}
                disabled={!writable}
                value={typeof value === 'string' ? value : ''}
                onChange={event => edit(field.path, event.target.value)}
              >
                {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            )}
            {field.kind === 'number' && (
              <input
                id={id}
                type="number"
                style={inputStyle}
                disabled={!writable}
                min={field.min}
                max={field.max}
                value={typeof value === 'number' ? String(value) : ''}
                onChange={(event) => {
                  const raw = event.target.value
                  edit(field.path, raw === '' ? undefined : Number(raw))
                }}
              />
            )}
            {field.kind === 'text' && (
              <input
                id={id}
                type="text"
                style={inputStyle}
                disabled={!writable}
                value={typeof value === 'string' ? value : ''}
                onChange={event => edit(field.path, event.target.value)}
              />
            )}
            {field.kind === 'list' && (
              <textarea
                id={id}
                style={{ ...inputStyle, minHeight: 88, fontFamily: 'monospace' }}
                disabled={!writable}
                value={Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : ''}
                onChange={event => edit(field.path, parseList(event.target.value))}
              />
            )}
            {field.hint !== undefined && <p style={hintStyle}>{field.hint.zh}</p>}
            {invalid && <p style={{ ...hintStyle, color: 'var(--dsw-alias-label-error)' }}>{errorMessageZh(field, error as FieldErrorCode)}</p>}
          </div>
        )
      })}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20 }}>
        <button type="button" disabled={!writable || busy || draft === null || blocked} onClick={() => { void save() }}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" disabled={busy || draft === null} onClick={() => { setDraft(null); setNotice(null) }}>
          放弃修改
        </button>
        {notice !== null && <span style={hintStyle}>{notice}</span>}
      </div>
    </div>
  )
}
