/**
 * 设置页里的「调用台账 / 安装自检」只读卡片。
 *
 * 数据来自宿主半侧注册的两条只读路由（见 `src/ledger-route.ts`）：
 * - `GET /api/dsh-deepseek-web/ledger` → 近 7 天的调用密度与失败分布；
 * - `GET /api/dsh-deepseek-web/doctor` → 安装自检报告（默认只跑静态检查）。
 *
 * 卡片是**纯只读**的：不写配置、不触发保存、不影响草稿。取不到数据时只显示
 * 一行说明（老宿主没有 `webServer` 服务，或桌面壳没暴露该端口），绝不弹错。
 *
 * @module dsh-deepseek-web-xxxxxgold/client/ledger-card
 */

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'

/** 台账摘要（与 `src/ledger.ts` 的 LedgerSummary 结构一致；client 侧只做展示，不 import 宿主代码）。 */
interface IntervalStats {
  count: number
  medianMs: number
  p90Ms: number
  minMs: number
}

interface LedgerSummary {
  days: Array<{ date: string; total: number; chat: number; failed: number; intervals: IntervalStats }>
  totals: { total: number; chat: number; failed: number }
  intervals: IntervalStats
  failures: Record<string, number>
}

interface DoctorCheck {
  id: string
  status: 'ok' | 'warning' | 'error'
  message: string
  detail?: string
}

interface DoctorReport {
  ok: boolean
  build: string
  checks: DoctorCheck[]
}

type Translate = (key: string) => string

const LEDGER_ROUTE = '/api/dsh-deepseek-web/ledger'
const DOCTOR_ROUTE = '/api/dsh-deepseek-web/doctor'

/** 失败分类的人话标签；未知分类原样显示。 */
const FAILURE_LABEL: Record<string, { zh: string; en: string }> = {
  'rate-limit': { zh: '限流', en: 'rate limit' },
  'account-blocked': { zh: '账号受限', en: 'account blocked' },
  login: { zh: '登录态', en: 'login' },
  network: { zh: '网络', en: 'network' },
  timeout: { zh: '超时', en: 'timeout' },
  other: { zh: '其它', en: 'other' },
}

const STATUS_ICON: Record<DoctorCheck['status'], string> = { ok: '✓', warning: '!', error: '✗' }

/** 毫秒 → 人话时长（中文/英文共用数字，单位跟随语言）。 */
function formatDuration(ms: number, t: Translate): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  return seconds > 0 ? t('ledger.minutes').replace('{m}', String(minutes)).replace('{s}', String(seconds))
    : t('ledger.minutes').replace('{m}', String(minutes)).replace('{s}', '0')
}

interface Envelope<T> {
  ok?: boolean
  value?: T
  code?: string
  message?: string
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T | undefined> {
  const response = await fetch(url, { method: 'GET', signal, headers: { accept: 'application/json' } })
  const body = await response.json().catch(() => undefined) as Envelope<T> | undefined
  if (!response.ok || body?.ok !== true || body.value === undefined) return undefined
  return body.value
}

interface LedgerCardProps {
  readonly t: Translate
}

/**
 * 台账与自检卡片。
 *
 * @param props.t - 设置页的翻译函数（键集合与 `settings-section.tsx` 的字典一致）。
 */
export function LedgerCard({ t }: LedgerCardProps): JSX.Element {
  const [summary, setSummary] = useState<LedgerSummary | null>(null)
  const [ledgerState, setLedgerState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [doctorState, setDoctorState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')

  const loadLedger = useCallback((signal: AbortSignal) => {
    setLedgerState('loading')
    void getJson<{ summary: LedgerSummary }>(LEDGER_ROUTE, signal)
      .then(value => {
        if (signal.aborted) return
        if (value?.summary === undefined) {
          setLedgerState('unavailable')
          return
        }
        setSummary(value.summary)
        setLedgerState('ready')
      })
      .catch(() => {
        if (!signal.aborted) setLedgerState('unavailable')
      })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    loadLedger(controller.signal)
    return () => controller.abort()
  }, [loadLedger])

  const runDoctor = useCallback(() => {
    const controller = new AbortController()
    setDoctorState('loading')
    void getJson<{ report: DoctorReport }>(DOCTOR_ROUTE, controller.signal)
      .then(value => {
        if (value?.report === undefined) {
          setDoctorState('unavailable')
          return
        }
        setReport(value.report)
        setDoctorState('ready')
      })
      .catch(() => setDoctorState('unavailable'))
  }, [])

  const totals = summary?.totals
  const intervals = summary?.intervals
  const failures = Object.entries(summary?.failures ?? {}).filter(([, count]) => count > 0)
  const tight = (intervals?.minMs ?? 0) > 0 && (intervals?.minMs ?? 0) < 30_000

  return (
    <section className="dsweb-group" aria-labelledby="dsweb-group-ledger">
      <h3 className="dsweb-group-title" id="dsweb-group-ledger">{t('ledger.title')}</h3>
      <p className="dsweb-group-hint">{t('ledger.hint')}</p>

      {ledgerState === 'unavailable' && (
        <div className="dsweb-banner dsweb-banner-warn">{t('ledger.unavailable')}</div>
      )}

      {ledgerState === 'loading' && <div className="dsweb-skeleton" />}

      {ledgerState === 'ready' && summary !== null && (
        <>
          {totals !== undefined && totals.total === 0
            ? <div className="dsweb-banner">{t('ledger.empty')}</div>
            : (
              <div className="dsweb-stats">
                <Stat label={t('ledger.total')} value={String(totals?.total ?? 0)} t={t} />
                <Stat label={t('ledger.chat')} value={String(totals?.chat ?? 0)} t={t} />
                <Stat label={t('ledger.failed')} value={String(totals?.failed ?? 0)} t={t} />
                <Stat label={t('ledger.minGap')} value={formatDuration(intervals?.minMs ?? 0, t)} t={t} />
                <Stat label={t('ledger.medianGap')} value={formatDuration(intervals?.medianMs ?? 0, t)} t={t} />
                <Stat label={t('ledger.p90Gap')} value={formatDuration(intervals?.p90Ms ?? 0, t)} t={t} />
              </div>
            )}

          {tight && <div className="dsweb-banner dsweb-banner-warn">{t('ledger.tight')}</div>}

          {failures.length > 0 && (
            <div className="dsweb-chips">
              <span className="dsweb-row-hint">{t('ledger.failures')}</span>
              {failures.map(([kind, count]) => (
                <span className="dsweb-badge dsweb-badge-warn" key={kind}>
                  {(FAILURE_LABEL[kind]?.[t('ledger.lang') === 'en' ? 'en' : 'zh'] ?? kind)} × {count}
                </span>
              ))}
            </div>
          )}

          <div className="dsweb-row dsweb-row-wide">
            <div className="dsweb-row-text">
              <span className="dsweb-row-label">{t('ledger.days')}</span>
              <p className="dsweb-row-hint">
                {summary.days.length === 0 ? t('ledger.empty')
                  : summary.days.map(day => `${day.date}：${day.total}${t('ledger.perDay')}`).join(' · ')}
              </p>
            </div>
          </div>
        </>
      )}

      <div className="dsweb-row dsweb-row-wide">
        <div className="dsweb-row-text">
          <span className="dsweb-row-label">{t('doctor.title')}</span>
          <p className="dsweb-row-hint">{t('doctor.hint')}</p>
        </div>
        <div className="dsweb-row-control">
          <button
            type="button"
            className="dsweb-button dsweb-button-secondary"
            disabled={doctorState === 'loading'}
            onClick={runDoctor}
          >
            {doctorState === 'loading' ? t('doctor.running') : t('doctor.run')}
          </button>
        </div>
      </div>

      {doctorState === 'unavailable' && (
        <div className="dsweb-banner dsweb-banner-warn">{t('doctor.unavailable')}</div>
      )}

      {doctorState === 'ready' && report !== null && (
        <div className="dsweb-checks">
          {report.checks.map(check => (
            <div className={`dsweb-check dsweb-check-${check.status}`} key={check.id}>
              <span className="dsweb-check-icon">{STATUS_ICON[check.status]}</span>
              <span>
                <strong>{check.id}</strong>：{check.message}
                {check.detail !== undefined && <span className="dsweb-check-detail">{check.detail}</span>}
              </span>
            </div>
          ))}
          <div className={report.ok ? 'dsweb-status dsweb-status-success' : 'dsweb-status dsweb-status-error'}>
            {report.ok ? t('doctor.ready') : t('doctor.notReady')}
          </div>
        </div>
      )}
    </section>
  )
}

function Stat({ label, value, t }: { label: string; value: string; t: Translate }): JSX.Element {
  return (
    <div className="dsweb-stat" title={label}>
      <span className="dsweb-stat-value">{value}</span>
      <span className="dsweb-stat-label">{label}</span>
    </div>
  )
}
