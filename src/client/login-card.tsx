/**
 * 设置页里的「登录态」卡片。
 *
 * 数据来自宿主半侧注册的 5 条同源路由（见 `src/login-route.ts`）：
 * - `GET  /api/dsh-deepseek-web/login`         → 当前状态快照；
 * - `POST /api/dsh-deepseek-web/login/probe`   → 立即探活（只读，不拉起浏览器）；
 * - `POST /api/dsh-deepseek-web/login/open`    → 打开浏览器登录窗口；
 * - `POST /api/dsh-deepseek-web/login/import`  → 写入粘贴的登录态；
 * - `POST /api/dsh-deepseek-web/login/export`  → 导出当前登录态。
 *
 * 卡片只在用户显式点击时产生副作用；打开登录窗口后会限时轮询（5 秒 × 12 次），
 * 登录成功或超时即停。取不到数据时只显示一行说明，绝不弹错。
 *
 * 信息层级：状态 + 检测 + 打开登录常显；导入 / 导出属于低频换机操作，收进「高级」折叠区。
 *
 * @module dsh-deepseek-web-xxxxxgold/client/login-card
 */

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Card, Fold } from './settings-ui.tsx'

type Translate = (key: string) => string

type ProbeStatus = 'ok' | 'expired' | 'unknown'

interface LoginStatus {
  status: ProbeStatus
  detail?: string
  checkedAt?: number
  browserStarted: boolean
  canOpen: boolean
  canImport: boolean
  canExport: boolean
  /** 豆包通道是否启用；DeepSeek 卡片没有这个字段。 */
  enabled?: boolean
}

interface ProbeResult {
  status: ProbeStatus
  detail?: string
  checkedAt: number
}

interface OpenResult {
  opened: boolean
  loggedIn: boolean
  detail?: string
}

interface ImportResult {
  status: ProbeResult
  applied: { token: boolean; cookies: number }
}

interface LoginState {
  token: string
  cookies: unknown[]
}

type LoginChannel = 'deepseek' | 'doubao' | 'glm'

const LOGIN_ROUTE_BASE: Record<LoginChannel, string> = {
  deepseek: '/api/dsh-deepseek-web/login',
  doubao: '/api/dsh-deepseek-web/doubao/login',
  glm: '/api/dsh-deepseek-web/glm-login',
}

/** 打开登录窗口后的复检节奏：登录成功或 60 秒后停。 */
const POLL_INTERVAL_MS = 5_000
const POLL_MAX_ATTEMPTS = 12

/** 三态徽标的语气。 */
const STATUS_TONE: Record<ProbeStatus, 'success' | 'warn' | 'muted'> = {
  ok: 'success',
  expired: 'warn',
  unknown: 'muted',
}

interface Envelope<T> {
  ok?: boolean
  value?: T
  code?: string
  message?: string
}

async function call<T>(
  url: string,
  method: 'GET' | 'POST',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const response = await fetch(url, {
    method,
    ...signal === undefined ? {} : { signal },
    headers: {
      accept: 'application/json',
      ...body === undefined ? {} : { 'content-type': 'application/json' },
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const payload = await response.json().catch(() => undefined) as Envelope<T> | undefined
  if (!response.ok || payload?.ok !== true || payload.value === undefined) {
    throw new Error(payload?.message ?? `HTTP ${response.status}`)
  }
  return payload.value
}

function errorText(error: unknown, t: Translate): string {
  return error instanceof Error ? error.message : t('unknownError')
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return String(timestamp)
  return date.toLocaleTimeString()
}

interface LoginCardProps {
  readonly t: Translate
  /** 数据源通道；默认 DeepSeek，豆包传 `doubao`。 */
  readonly channel?: LoginChannel
}

/**
 * 登录态卡片。
 *
 * @param props.t - 设置页的翻译函数（键集合与 `i18n.ts` 的字典一致）。
 * @param props.channel - `deepseek`（默认）或 `doubao`；两者共用同一套渲染。
 */
export function LoginCard({ t, channel = 'deepseek' }: LoginCardProps): JSX.Element {
  const base = LOGIN_ROUTE_BASE[channel]
  const probeRoute = `${base}/probe`
  const openRoute = `${base}/open`
  const importRoute = `${base}/import`
  const exportRoute = `${base}/export`
  const isDoubao = channel === 'doubao'
  const isGlm = channel === 'glm'
  // 只有 DeepSeek 通道支持导入/导出登录态；GLM 与豆包只做状态 + 打开登录。
  const supportsAdvanced = channel === 'deepseek'
  const [status, setStatus] = useState<LoginStatus | undefined>()
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [busy, setBusy] = useState<'probe' | 'open' | 'import' | 'export' | undefined>()
  const [message, setMessage] = useState<{ tone: 'success' | 'warn' | 'error'; text: string } | undefined>()
  const [raw, setRaw] = useState('')
  const [exportText, setExportText] = useState<string | undefined>()
  const [polling, setPolling] = useState(false)

  const load = useCallback((signal?: AbortSignal) => {
    setState('loading')
    void call<LoginStatus>(base, 'GET', undefined, signal)
      .then((value) => {
        if (signal?.aborted === true) return
        if (value === undefined) {
          setState('unavailable')
          return
        }
        setStatus(value)
        setState('ready')
      })
      .catch(() => {
        if (signal?.aborted !== true) setState('unavailable')
      })
  }, [base])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  const applyProbe = useCallback((value: ProbeResult) => {
    setStatus(previous => ({
      status: value.status,
      ...value.detail !== undefined ? { detail: value.detail } : {},
      checkedAt: value.checkedAt,
      browserStarted: previous?.browserStarted ?? false,
      canOpen: previous?.canOpen ?? true,
      canImport: previous?.canImport ?? true,
      canExport: previous?.canExport ?? true,
      ...previous?.enabled !== undefined ? { enabled: previous.enabled } : {},
    }))
  }, [])

  /** 打开登录 / 导入成功后浏览器必然已启动，立刻把状态改对，不必等整页重载。 */
  const markBrowserStarted = useCallback(() => {
    setStatus(previous => previous === undefined ? previous : { ...previous, browserStarted: true })
  }, [])

  // 打开登录窗口后限时轮询：登录成功或 60 秒后停，不把页面当成探活靶子长期打。
  useEffect(() => {
    if (!polling) return
    let attempts = 0
    let cancelled = false
    let inFlight = false
    const tick = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      attempts += 1
      try {
        const value = await call<ProbeResult>(probeRoute, 'POST')
        if (cancelled || value === undefined) return
        applyProbe(value)
        if (value.status === 'ok' || attempts >= POLL_MAX_ATTEMPTS) {
          cancelled = true
          setPolling(false)
        }
      } catch {
        if (!cancelled && attempts >= POLL_MAX_ATTEMPTS) {
          cancelled = true
          setPolling(false)
        }
      } finally {
        inFlight = false
      }
    }
    // 先立即探一次，用户点完「去登录」回来不用等满一个间隔才看到结果。
    void tick()
    const timer = setInterval(() => { void tick() }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [polling, applyProbe])

  const runProbe = useCallback(async (): Promise<void> => {
    setBusy('probe')
    setMessage(undefined)
    try {
      const value = await call<ProbeResult>(probeRoute, 'POST')
      if (value !== undefined) applyProbe(value)
    } catch (error) {
      setMessage({ tone: 'error', text: errorText(error, t) })
    } finally {
      setBusy(undefined)
    }
  }, [applyProbe, t])

  const openLogin = useCallback(async (): Promise<void> => {
    setBusy('open')
    setMessage(undefined)
    try {
      const value = await call<OpenResult>(openRoute, 'POST')
      if (value === undefined) return
      if (!value.opened) {
        setMessage({ tone: 'warn', text: value.detail ?? t('login.unavailable') })
        return
      }
      markBrowserStarted()
      if (value.loggedIn) {
        setMessage({ tone: 'success', text: t('login.already') })
        void runProbe()
        return
      }
      setMessage({
        tone: 'warn',
        text: t('login.opened') + (value.detail === undefined ? '' : t('login.openDetail').replace('{detail}', value.detail)),
      })
      setPolling(true)
    } catch (error) {
      setMessage({ tone: 'error', text: errorText(error, t) })
    } finally {
      setBusy(undefined)
    }
  }, [markBrowserStarted, runProbe, t])

  const importLogin = useCallback(async (): Promise<void> => {
    if (raw.trim() === '') {
      setMessage({ tone: 'warn', text: t('login.emptyRaw') })
      return
    }
    setBusy('import')
    setMessage(undefined)
    try {
      const value = await call<ImportResult>(importRoute, 'POST', { raw })
      if (value === undefined) return
      applyProbe(value.status)
      markBrowserStarted()
      if (value.status.status === 'ok') {
        setMessage({ tone: 'success', text: t('login.importOk') })
        setRaw('')
      } else if (value.status.status === 'unknown') {
        // 页面刚刷新完可能还没渲染出登录态：别当成 token 失效，交给轮询继续确认。
        setMessage({ tone: 'warn', text: t('login.importPend') })
        setPolling(true)
      } else {
        setMessage({ tone: 'warn', text: t('login.importWarn') })
      }
    } catch (error) {
      setMessage({ tone: 'error', text: errorText(error, t) })
    } finally {
      setBusy(undefined)
    }
  }, [applyProbe, markBrowserStarted, raw, t])

  const exportLogin = useCallback(async (): Promise<void> => {
    setBusy('export')
    setMessage(undefined)
    try {
      const value = await call<LoginState>(exportRoute, 'POST')
      if (value === undefined) return
      const text = JSON.stringify({ userToken: value.token, cookies: value.cookies }, null, 2)
      try {
        await navigator.clipboard.writeText(text)
        setExportText(undefined)
        setMessage({ tone: 'success', text: t('login.copied') })
      } catch {
        setExportText(text)
        setMessage({ tone: 'warn', text: t('login.copyManual') })
      }
    } catch (error) {
      setMessage({ tone: 'error', text: errorText(error, t) })
    } finally {
      setBusy(undefined)
    }
  }, [t])

  return (
    <Card
      variant="aux"
      title={t(isDoubao ? 'doubaoLogin.title' : isGlm ? 'login.glm.title' : 'login.title')}
      hint={t(isDoubao ? 'doubaoLogin.hint' : isGlm ? 'login.glm.hint' : 'login.hint')}
      collapsible
    >
      {state === 'unavailable' && (
        <div className="dsweb-banner dsweb-banner-warn">{t('login.unavailable')}</div>
      )}
      {state === 'loading' && <div className="dsweb-skeleton" />}

      {state === 'ready' && status !== undefined && (
        <>
          {status.enabled === false && (
            <div className="dsweb-banner dsweb-banner-warn">{t('doubaoLogin.disabled')}</div>
          )}
          <div className="dsweb-row dsweb-row-wide">
            <div className="dsweb-row-text">
              <span className="dsweb-row-label">
                <Badge tone={STATUS_TONE[status.status]}>{t(`login.status.${status.status}`)}</Badge>
                {status.detail === undefined ? null : ` ${status.detail}`}
              </span>
              <p className="dsweb-row-hint">
                {status.checkedAt === undefined
                  ? t('login.never')
                  : `${t('login.checkedAt')}: ${formatTime(status.checkedAt)}`}
                {' · '}
                {status.browserStarted ? t('login.browser.started') : t('login.browser.stopped')}
              </p>
            </div>
            <div className="dsweb-row-control">
              <button
                type="button"
                className="dsweb-button dsweb-button-secondary"
                disabled={busy !== undefined}
                onClick={() => { void runProbe() }}
              >
                {busy === 'probe' ? t('login.probing') : t('login.probe')}
              </button>
            </div>
          </div>

          <div className="dsweb-row dsweb-row-wide">
            <div className="dsweb-row-text">
              <span className="dsweb-row-label">{t('login.open')}</span>
              <p className="dsweb-row-hint">{t(isDoubao ? 'doubaoLogin.openHint' : isGlm ? 'login.glm.openHint' : 'login.openHint')}</p>
            </div>
            <div className="dsweb-row-control">
              <button
                type="button"
                className="dsweb-button dsweb-button-secondary"
                disabled={!status.canOpen || busy !== undefined || polling}
                onClick={() => { void openLogin() }}
              >
                {busy === 'open' ? t('login.opening') : polling ? t('login.polling') : t('login.open')}
              </button>
            </div>
          </div>

          {message !== undefined && (
            <div className={`dsweb-banner dsweb-banner-${message.tone}`}>{message.text}</div>
          )}

          {supportsAdvanced && (
          <Fold title={t('login.advanced')} hint={t('login.advancedHint')} defaultOpen={false}>
            <div className="dsweb-row dsweb-row-wide">
              <div className="dsweb-row-text">
                <label className="dsweb-row-label" htmlFor="dsweb-login-import">{t('login.importLabel')}</label>
                <p className="dsweb-row-hint">{t('login.importHint')}</p>
              </div>
              <div className="dsweb-row-control">
                <textarea
                  id="dsweb-login-import"
                  className="dsweb-textarea"
                  value={raw}
                  placeholder={t('login.importPlaceholder')}
                  disabled={!status.canImport || busy !== undefined}
                  onChange={event => setRaw(event.target.value)}
                />
                <button
                  type="button"
                  className="dsweb-button dsweb-button-secondary"
                  disabled={!status.canImport || busy !== undefined || raw.trim() === ''}
                  onClick={() => { void importLogin() }}
                >
                  {busy === 'import' ? t('login.importing') : t('login.import')}
                </button>
              </div>
            </div>

            <div className="dsweb-row dsweb-row-wide">
              <div className="dsweb-row-text">
                <span className="dsweb-row-label">{t('login.export')}</span>
                <p className="dsweb-row-hint">{t('login.exportWarning')}</p>
              </div>
              <div className="dsweb-row-control">
                <button
                  type="button"
                  className="dsweb-button dsweb-button-secondary"
                  disabled={!status.canExport || busy !== undefined}
                  onClick={() => { void exportLogin() }}
                >
                  {busy === 'export' ? t('login.exporting') : t('login.export')}
                </button>
              </div>
            </div>

            {exportText !== undefined && (
              <div className="dsweb-row dsweb-row-wide">
                <div className="dsweb-row-text">
                  <label className="dsweb-row-label" htmlFor="dsweb-login-export">{t('login.exportTitle')}</label>
                </div>
                <div className="dsweb-row-control">
                  <textarea
                    id="dsweb-login-export"
                    className="dsweb-textarea"
                    readOnly
                    value={exportText}
                    onFocus={event => event.currentTarget.select()}
                  />
                </div>
              </div>
            )}
          </Fold>
          )}
        </>
      )}
    </Card>
  )
}
