/**
 * 设置页里的「归档清理」卡片：存量统计 + 手动清理 + 清空全部。
 *
 * 数据来自宿主半侧注册的三条路由（见 `src/archive-cleanup-route.ts`）：
 * - `GET  /api/dsh-deepseek-web/archive-cleanup`            统计四个数字；
 * - `POST /api/dsh-deepseek-web/archive-cleanup/run`        清理“待清理项”；
 * - `GET  /api/dsh-deepseek-web/archive-cleanup/web-chats`  清空前统计网页端总数；
 * - `POST /api/dsh-deepseek-web/archive-cleanup/purge-all`  清空全部（确认词 + 数量双校验）。
 *
 * 与 `ledger-card.tsx` 同属受控桥：取不到数据只显示一行说明，不弹错、不影响发送。
 *
 * 危险操作**不用 fixed 模态**：`.dsweb-page` 的 `container-type` 会建立 fixed 包含块，
 * 遮罩会按整页高度定位、滚动到中部时对话框可能跑到视口外。这里改成卡片内展开的
 * 确认面板，输入确认词后才允许提交。
 *
 * @module dsh-deepseek-web-xxxxxgold/client/archive-cleanup-card
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Card, Fold, Stat } from './settings-ui.tsx'

type Translate = (key: string) => string

const STATS_ROUTE = '/api/dsh-deepseek-web/archive-cleanup'
const RUN_ROUTE = '/api/dsh-deepseek-web/archive-cleanup/run'
const WEB_CHATS_ROUTE = '/api/dsh-deepseek-web/archive-cleanup/web-chats'
const PURGE_ROUTE = '/api/dsh-deepseek-web/archive-cleanup/purge-all'

/** 与宿主侧 `PURGE_CONFIRM_WORD` 保持一致。 */
const PURGE_CONFIRM_WORD = 'DELETE_ALL_WEB_CHATS'
/** 用户需要手动输入的确认文字。 */
const PURGE_CONFIRM_TEXT = '清空网页端'

interface ArchiveStats {
  archivedTotal: number
  cleaned: number
  pending: number
  unbound: number
  failed: number
}

interface CleanupResult {
  attempted: number
  deleted: number
  failed: number
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

async function postJson<T>(url: string, payload: unknown): Promise<{ ok: boolean; value?: T; message?: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => undefined) as Envelope<T> | undefined
  if (!response.ok || body?.ok !== true) {
    return { ok: false, message: body?.message ?? `HTTP ${response.status}` }
  }
  return { ok: true, value: body.value }
}

interface ArchiveCleanupCardProps {
  readonly t: Translate
}

/**
 * 归档清理卡片。
 *
 * @param props.t - 设置页的翻译函数。
 */
export function ArchiveCleanupCard({ t }: ArchiveCleanupCardProps): JSX.Element {
  const [stats, setStats] = useState<ArchiveStats | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [purgeOpen, setPurgeOpen] = useState(false)
  const [purgeCount, setPurgeCount] = useState<number | null>(null)
  const [purgeCountState, setPurgeCountState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [purgeRetry, setPurgeRetry] = useState(0)
  const [purgeWord, setPurgeWord] = useState('')
  const [purgeBusy, setPurgeBusy] = useState(false)
  const wasPurgeOpen = useRef(false)

  const load = useCallback((signal: AbortSignal) => {
    setState('loading')
    void getJson<ArchiveStats>(STATS_ROUTE, signal)
      .then(value => {
        if (signal.aborted) return
        if (value === undefined) {
          setState('unavailable')
          return
        }
        setStats(value)
        setState('ready')
      })
      .catch(() => {
        if (!signal.aborted) setState('unavailable')
      })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  // 展开危险区时才去数网页端会话；收起 / 卸载 / 重试时中止上一条请求。
  useEffect(() => {
    if (!purgeOpen) return
    const controller = new AbortController()
    setPurgeCount(null)
    setPurgeCountState('loading')
    setPurgeWord('')
    setMessage(null)
    void getJson<{ total: number }>(WEB_CHATS_ROUTE, controller.signal)
      .then(value => {
        if (controller.signal.aborted) return
        if (value === undefined) {
          setPurgeCountState('error')
          return
        }
        setPurgeCount(value.total)
        setPurgeCountState('ready')
      })
      .catch(() => {
        if (!controller.signal.aborted) setPurgeCountState('error')
      })
    return () => controller.abort()
  }, [purgeOpen, purgeRetry])

  // 关闭危险区后把焦点还给入口，别让键盘用户掉回 body。
  useEffect(() => {
    if (wasPurgeOpen.current && !purgeOpen) {
      document.getElementById('dsweb-purge-toggle')?.focus()
    }
    wasPurgeOpen.current = purgeOpen
  }, [purgeOpen])

  // Esc 收起危险区（提交中不响应）。
  useEffect(() => {
    if (!purgeOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !purgeBusy) setPurgeOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [purgeOpen, purgeBusy])

  const refresh = useCallback(() => {
    const controller = new AbortController()
    load(controller.signal)
  }, [load])

  const runPending = useCallback(() => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    void postJson<CleanupResult>(RUN_ROUTE, {})
      .then(result => {
        if (!result.ok) {
          setMessage(result.message ?? t('archiveCleanup.unavailable'))
          return
        }
        const deleted = result.value?.deleted ?? 0
        setMessage(deleted === 0 ? t('archiveCleanup.runNone') : t('archiveCleanup.runDone').replace('{n}', String(deleted)))
        refresh()
      })
      .catch(() => setMessage(t('archiveCleanup.unavailable')))
      .finally(() => setBusy(false))
  }, [busy, refresh, t])

  const submitPurge = useCallback(() => {
    if (purgeBusy || purgeCountState !== 'ready' || purgeCount === null) return
    if (purgeWord.trim() !== PURGE_CONFIRM_TEXT) return
    setPurgeBusy(true)
    setMessage(null)
    void postJson<{ total: number; deleted: number; failed: number }>(PURGE_ROUTE, {
      confirm: PURGE_CONFIRM_WORD,
      expectedCount: purgeCount,
    })
      .then(result => {
        if (!result.ok) {
          setMessage(result.message ?? t('archiveCleanup.purgeMismatch'))
          return
        }
        const deleted = result.value?.deleted ?? 0
        const failed = result.value?.failed ?? 0
        setMessage(t('archiveCleanup.purgeDone').replace('{n}', String(deleted)).replace('{m}', String(failed)))
        setPurgeOpen(false)
        refresh()
      })
      .catch(() => setMessage(t('archiveCleanup.unavailable')))
      .finally(() => setPurgeBusy(false))
  }, [purgeBusy, purgeCount, purgeCountState, purgeWord, refresh, t])

  return (
    <Card variant="aux" title={t('archiveCleanup.title')} hint={t('archiveCleanup.hint')} collapsible>

      {state === 'unavailable' && (
        <div className="dsweb-banner dsweb-banner-warn">{t('archiveCleanup.unavailable')}</div>
      )}
      {state === 'loading' && <div className="dsweb-skeleton" />}

      {state === 'ready' && stats !== null && (
        <>
          <div className="dsweb-stats">
            <Stat
              label={t('archiveCleanup.pending')}
              value={String(stats.pending)}
              tone="accent"
            />
            <Stat
              label={t('archiveCleanup.failed')}
              value={String(stats.failed)}
              tone={stats.failed > 0 ? 'danger' : 'neutral'}
            />
            <Stat
              label={t('archiveCleanup.unbound')}
              value={String(stats.unbound)}
              tone={stats.unbound > 0 ? 'warn' : 'neutral'}
            />
            <Stat label={t('archiveCleanup.archived')} value={String(stats.archivedTotal)} />
            <Stat label={t('archiveCleanup.cleaned')} value={String(stats.cleaned)} />
          </div>
          {stats.unbound > 0 && (
            <div className="dsweb-banner dsweb-banner-warn">{t('archiveCleanup.unboundHint')}</div>
          )}
        </>
      )}

      <div className="dsweb-row dsweb-row-wide">
        <div className="dsweb-row-text">
          <span className="dsweb-row-label">{t('archiveCleanup.run')}</span>
          <p className="dsweb-row-hint">{t('archiveCleanup.runHint')}</p>
        </div>
        <div className="dsweb-row-control">
          <button
            type="button"
            className="dsweb-button dsweb-button-secondary"
            disabled={busy || state !== 'ready'}
            onClick={runPending}
          >
            {busy ? t('archiveCleanup.running') : t('archiveCleanup.runNow')}
          </button>
        </div>
      </div>

      <Fold
        title={t('archiveCleanup.purge')}
        hint={t('archiveCleanup.purgeShortHint')}
        tone="danger"
        open={purgeOpen}
        onOpenChange={setPurgeOpen}
        toggleId="dsweb-purge-toggle"
      >
        <div className="dsweb-danger-body">
          <div className="dsweb-banner dsweb-banner-error">{t('archiveCleanup.purgeHint')}</div>
          {purgeCountState === 'loading' && (
            <p className="dsweb-row-hint">{t('archiveCleanup.loading')}</p>
          )}
          {purgeCountState === 'error' && (
            <div className="dsweb-banner dsweb-banner-warn">
              {t('archiveCleanup.countFailed')}
              <button
                type="button"
                className="dsweb-link"
                onClick={() => setPurgeRetry(value => value + 1)}
              >
                {t('archiveCleanup.retry')}
              </button>
            </div>
          )}
          {purgeCountState === 'ready' && purgeCount !== null && (
            <p className="dsweb-row-hint">
              {t('archiveCleanup.purgeCount').replace('{n}', String(purgeCount))}
            </p>
          )}
          <label className="dsweb-row-label" htmlFor="dsweb-purge-confirm">
            {t('archiveCleanup.purgeConfirmLabel')}
          </label>
          <input
            id="dsweb-purge-confirm"
            className="dsweb-input"
            type="text"
            value={purgeWord}
            placeholder={PURGE_CONFIRM_TEXT}
            onChange={event => setPurgeWord(event.target.value)}
          />
          <div className="dsweb-actions dsweb-actions-start">
            <button
              type="button"
              className="dsweb-button dsweb-button-secondary"
              disabled={purgeBusy}
              onClick={() => setPurgeOpen(false)}
            >
              {t('archiveCleanup.purgeCancel')}
            </button>
            <button
              type="button"
              className="dsweb-button dsweb-button-danger"
              disabled={purgeBusy || purgeCountState !== 'ready' || purgeCount === null || purgeWord.trim() !== PURGE_CONFIRM_TEXT}
              onClick={submitPurge}
            >
              {purgeBusy ? t('archiveCleanup.purging') : t('archiveCleanup.purgeSubmit')}
            </button>
          </div>
        </div>
      </Fold>

      {message !== null && <div className="dsweb-banner">{message}</div>}
    </Card>
  )
}
