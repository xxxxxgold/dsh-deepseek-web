/**
 * 界面文案的唯一来源 + 界面语言解析。
 *
 * 两处配置界面（侧栏「设置」里的本插件菜单、插件管理器行上的「配置」页）共用这一份字典，
 * 避免同一句话在两处写成两个版本。
 *
 * 语言判定规则（写死，避免歧义）：
 * 1. 配置 `uiLanguage` 为 `zh` → 中文；为 `en` → 英文；
 * 2. 为 `auto` 或非法值 → 看系统语言（缺省取 `navigator.language`）：
 *    以 `zh` 开头算中文，其余一律英文；
 * 3. 英文是兜底：任何未知语言都落到英文，不会意外落回中文。
 *
 * 这里的字典同时注册给宿主 locale（`ctx.locale.register`），但页面渲染走
 * {@link translateBy}，这样"设置界面里选的语言"才能真正生效——宿主的 locale
 * 只认它自己的语言设置，插件配置覆盖不了它。
 *
 * @module dsh-deepseek-web-xxxxxgold/client/i18n
 */

import { FIELDS, GROUPS, RISK_PRESETS, fieldKey } from './config-fields.ts'

/** locale 命名空间；字典键与设置页文案一一对应。 */
export const LOCALE_NAMESPACE = 'dsh-deepseek-web'

/** 实际生效的界面语言。 */
export type UiLanguage = 'zh' | 'en'

/** 配置里可选的语言取值。 */
export const UI_LANGUAGE_OPTIONS = ['auto', 'zh', 'en'] as const

/** 配置里可选的语言取值（联合类型）。 */
export type UiLanguageSetting = (typeof UI_LANGUAGE_OPTIONS)[number]

/** 文案翻译函数。 */
export type Translate = (key: string) => string

/** 静态文案；字段/分组/档位文案由 {@link buildDictionaries} 拼进来。 */
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
    missingFormTitle: '无法在此编辑',
    missingFormBody: '宿主没有给出该条目的配置句柄。通常是该 entry 的字段未标 volatile，或当前 DSH 版本未开启设置写入。',
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
    dirtyCount: '有 {n} 项改动待保存',
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
    groupsLabel: '配置分组',
    configSummary: '审核通道、网页版模型入口、工具白名单、频控退避、过程提示、浏览器自愈与窗口聚焦。',
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
    'ledger.failuresTitle': '失败分布',
    'ledger.days': '按天',
    'ledger.daysHint': '按天拆开的调用量、对话轮、失败数与当天最短间隔。',
    'ledger.perDay': ' 次',
    'ledger.minutes': '{m} 分 {s} 秒',
    'doctor.title': '安装自检',
    'doctor.hint': '只报事实、不做修复。默认只跑静态检查（配置 / 浏览器 / 目录 / 构建标识），不会为了自检启动浏览器。',
    'doctor.run': '运行自检',
    'doctor.running': '自检中…',
    'doctor.unavailable': '自检接口不可用（同上：宿主没有 webServer 服务）。也可以在命令行运行 npm run doctor。',
    'doctor.ready': 'Doctor result: ready（有 warning 但无 error）',
    'doctor.notReady': 'Doctor result: not ready（存在 error，按上面的条目逐项排查）',
    'archiveCleanup.title': '归档清理',
    'archiveCleanup.hint': '归档 DSH 会话时是否删除它在 DeepSeek 网页端产生过的对话。上方开关控制自动删除；这里显示存量统计与手动清理。',
    'archiveCleanup.unavailable': '读不到归档统计：宿主没有提供 webServer 服务，或当前页面不是本机同源。',
    'archiveCleanup.archived': '已归档',
    'archiveCleanup.cleaned': '已清理',
    'archiveCleanup.pending': '待清理',
    'archiveCleanup.unbound': '无绑定',
    'archiveCleanup.failed': '失败',
    'archiveCleanup.run': '清理待清理项',
    'archiveCleanup.runHint': '删除已归档会话在网页端留下的对话；无绑定会话没有网页对话 id，只能统计。',
    'archiveCleanup.runNow': '立即清理',
    'archiveCleanup.running': '清理中…',
    'archiveCleanup.runDone': '已清理 {n} 条网页对话。',
    'archiveCleanup.runNone': '没有可清理的会话。',
    'archiveCleanup.unboundHint': '无绑定的会话是功能上线前归档的，没有网页对话 id，只能统计、不能删除。',
    'archiveCleanup.purge': '清空网页端所有会话',
    'archiveCleanup.purgeShortHint': '不可恢复；展开后需输入确认词。',
    'archiveCleanup.purgeTitle': '清空网页端所有会话',
    'archiveCleanup.purgeHint': '将删除 DeepSeek 网页端的全部对话，不可恢复；正在使用的会话也会被删，下一轮会重建新对话。',
    'archiveCleanup.purgeCount': '当前网页端共有 {n} 条对话。',
    'archiveCleanup.countFailed': '读取网页端会话数量失败。',
    'archiveCleanup.retry': '重试',
    'archiveCleanup.purgeConfirmLabel': '输入「清空网页端」以确认',
    'archiveCleanup.purgeCancel': '取消',
    'archiveCleanup.purgeSubmit': '确认清空',
    'archiveCleanup.purging': '清空中…',
    'archiveCleanup.purgeDone': '已删除 {n} 条，失败 {m} 条。',
    'archiveCleanup.purgeMismatch': '数量已变化，请重新打开确认框。',
    'archiveCleanup.loading': '正在读取…',
    'login.title': '登录态',
    'login.hint': '显示插件浏览器的登录态，可立即检测、打开登录窗口，或从别处导入登录态。检测只读，不会为了检测拉起浏览器。',
    'doubaoLogin.title': '豆包登录态',
    'doubaoLogin.hint': '显示豆包独立浏览器 profile 的登录态。检测只读，不会为了检测拉起浏览器；需要登录时从这里打开豆包窗口。豆包一期不支持导入/导出登录态。',
    'doubaoLogin.openHint': '会在豆包独立浏览器窗口打开登录页，登录完成后自动复检。',
    'doubaoLogin.disabled': '豆包网页通道尚未启用。请先在上方「豆包网页」分组里打开「启用豆包网页通道」，保存并重启 DSH。',
    'login.status.ok': '登录态正常',
    'login.status.expired': '登录态已失效',
    'login.status.unknown': '无法判断',
    'login.checkedAt': '检测时间',
    'login.never': '还没检测过',
    'login.browser.started': '浏览器已启动',
    'login.browser.stopped': '浏览器未启动',
    'login.probe': '立即检测',
    'login.probing': '检测中…',
    'login.open': '打开浏览器去登录',
    'login.openHint': '会在独立浏览器窗口打开 DeepSeek 登录页，登录完成后自动复检。',
    'login.glm.title': 'GLM 登录态',
    'login.glm.hint': '显示 GLM 主通道窗口的登录态。检测只读，不会为了检测拉起浏览器；首次使用先点「打开浏览器去登录」完成一次登录。',
    'login.glm.openHint': '会在独立 GLM 窗口打开 chatglm.cn / chat.z.ai，登录完成后自动复检。',
    'login.opening': '正在打开…',
    'login.opened': '已打开浏览器窗口，请在窗口中完成登录',
    'login.already': '浏览器已处于登录状态',
    'login.openDetail': '（{detail}）',
    'login.polling': '等待登录完成…',
    'login.importLabel': '导入登录态（userToken 或完整 JSON）',
    'login.advanced': '高级：导入 / 导出登录态',
    'login.advancedHint': '换机、token 失效或需要备份时用；导入会刷新网页标签并中断正在生成的回复。',
    'login.importHint': '粘贴 userToken、{"value":"..."} 或 {"userToken":"...","cookies":[...]}。导入会刷新网页标签，正在生成的回复会中断。',
    'login.importPlaceholder': '粘贴 userToken 或完整登录态 JSON',
    'login.import': '导入并检测',
    'login.importing': '导入中…',
    'login.importOk': '已导入，登录态正常',
    'login.importWarn': '已写入，但检测仍未登录：请检查 token 是否过期',
    'login.importPend': '已写入，正在等待页面加载并复检…',
    'login.export': '复制登录态',
    'login.exporting': '读取中…',
    'login.copied': '已复制到剪贴板（凭证敏感，勿外传）',
    'login.copyManual': '无法自动复制，请手动全选下面的内容',
    'login.exportWarning': '导出的 token 等同账号凭证，请勿分享。',
    'login.unavailable': '读不到登录态：宿主没有提供 webServer 服务，或当前页面不是本机同源。',
    'login.emptyRaw': '请先粘贴登录态内容',
    'login.exportTitle': '登录态（手动复制）',
  },
  en: {
    nav: 'DeepSeek Web',
    title: 'DeepSeek Web channel',
    intro:
      'This plugin connects the DeepSeek web app to DSH. Saved changes apply immediately; items marked “Restart to apply” take effect after a DSH restart.',
    loading: 'Reading host settings…',
    unavailableTitle: 'Settings unavailable',
    unavailableBody:
      'The host does not expose this plugin’s writable settings namespace (llm-deepseek-web). Usually the plugin host half is not loaded, or this DSH build does not accept settings writes.',
    unavailableHint: 'You can still override config in the profile’s cordis.patch.yml.',
    missingForm: 'The host did not provide a settings form handle, so this page cannot edit anything.',
    missingFormTitle: 'Cannot edit here',
    missingFormBody:
      'The host returned no config handle for this entry. Usually the entry’s fields are not marked volatile, or this DSH build does not accept settings writes.',
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
    dirtyCount: '{n} unsaved change(s)',
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
    groupsLabel: 'Configuration groups',
    configSummary: 'Review channel, web model entry, tool allowlist, rate-limit backoff, progress notices, browser recovery and window focus.',
    'ledger.lang': 'en',
    'ledger.title': 'Call ledger (read-only)',
    'ledger.hint':
      'Daily metadata about this machine’s web calls (no message content, no credentials), kept for 7 days. Gaps only count successful chat turns that actually reached the web page; queueing time is excluded.',
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
    'ledger.failuresTitle': 'Failures',
    'ledger.days': 'Per day',
    'ledger.daysHint': 'Per-day calls, chat turns, failures and the shortest gap of that day.',
    'ledger.perDay': ' calls',
    'ledger.minutes': '{m}m {s}s',
    'doctor.title': 'Install self-check',
    'doctor.hint': 'Reports facts only; it never fixes anything. Only static checks run by default (config / browser / directories / build id) — no browser is started for a self-check.',
    'doctor.run': 'Run self-check',
    'doctor.running': 'Checking…',
    'doctor.unavailable': 'Self-check route unavailable (same reason: no webServer service). You can also run npm run doctor from a shell.',
    'doctor.ready': 'Doctor result: ready (warnings allowed, no errors)',
    'doctor.notReady': 'Doctor result: not ready (errors found — work through the items above)',
    'archiveCleanup.title': 'Archive cleanup',
    'archiveCleanup.hint': 'Whether archiving a DSH session also deletes the DeepSeek web chats it produced. The switch above controls automatic deletion; this card shows existing stats and manual cleanup.',
    'archiveCleanup.unavailable': 'Cannot read archive stats: the host exposes no webServer service, or this page is not same-origin.',
    'archiveCleanup.archived': 'Archived',
    'archiveCleanup.cleaned': 'Cleaned',
    'archiveCleanup.pending': 'Pending',
    'archiveCleanup.unbound': 'Unbound',
    'archiveCleanup.failed': 'Failed',
    'archiveCleanup.run': 'Clean pending',
    'archiveCleanup.runHint': 'Deletes the web chats left by archived sessions. Unbound sessions have no web chat id, so they can only be counted.',
    'archiveCleanup.runNow': 'Clean now',
    'archiveCleanup.running': 'Cleaning…',
    'archiveCleanup.runDone': 'Deleted {n} web chats.',
    'archiveCleanup.runNone': 'Nothing to clean.',
    'archiveCleanup.unboundHint': 'Unbound sessions were archived before this feature shipped; they have no web chat ids and can only be counted, not deleted.',
    'archiveCleanup.purge': 'Delete all web chats',
    'archiveCleanup.purgeShortHint': 'Irreversible; expand and type the confirmation phrase.',
    'archiveCleanup.purgeTitle': 'Delete all web chats',
    'archiveCleanup.purgeHint': 'Deletes every chat on DeepSeek web. This is irreversible; sessions currently in use are included and will start a fresh chat next turn.',
    'archiveCleanup.purgeCount': 'There are {n} chats on the web side right now.',
    'archiveCleanup.countFailed': 'Could not read the number of web chats.',
    'archiveCleanup.retry': 'Retry',
    'archiveCleanup.purgeConfirmLabel': 'Type “清空网页端” to confirm',
    'archiveCleanup.purgeCancel': 'Cancel',
    'archiveCleanup.purgeSubmit': 'Delete everything',
    'archiveCleanup.purging': 'Deleting…',
    'archiveCleanup.purgeDone': 'Deleted {n}, failed {m}.',
    'archiveCleanup.purgeMismatch': 'The count changed. Reopen the dialog and try again.',
    'archiveCleanup.loading': 'Reading…',
    'login.title': 'Login state',
    'login.hint': 'Shows the plugin browser’s login state. Probe it, open the login window, or import a login state from another machine. Probing is read-only and never starts the browser.',
    'doubaoLogin.title': 'Doubao login state',
    'doubaoLogin.hint': 'Shows the login state of the separate Doubao browser profile. Probing is read-only and never starts the browser; use the button to open the Doubao window when you need to sign in. Import/export is not supported for Doubao in this version.',
    'doubaoLogin.openHint': 'Opens the Doubao login page in its own browser window and rechecks after you sign in.',
    'doubaoLogin.disabled': 'The Doubao web channel is disabled. Enable it in the Doubao web section above, save, and restart DSH.',
    'login.status.ok': 'Logged in',
    'login.status.expired': 'Login expired',
    'login.status.unknown': 'Unknown',
    'login.checkedAt': 'Checked',
    'login.never': 'Not checked yet',
    'login.browser.started': 'Browser running',
    'login.browser.stopped': 'Browser not running',
    'login.probe': 'Check now',
    'login.probing': 'Checking…',
    'login.open': 'Open browser to log in',
    'login.openHint': 'Opens the DeepSeek sign-in page in a dedicated browser window and re-checks when you finish.',
    'login.glm.title': 'GLM login state',
    'login.glm.hint': 'Shows the login state of the GLM main-channel window. Checking is read-only and never starts the browser; sign in once via “Open browser to sign in”.',
    'login.glm.openHint': 'Opens chatglm.cn / chat.z.ai in a dedicated GLM window and re-checks when you finish.',
    'login.opening': 'Opening…',
    'login.opened': 'Browser window opened — please log in there',
    'login.already': 'The browser is already logged in',
    'login.openDetail': ' ({detail})',
    'login.polling': 'Waiting for login…',
    'login.importLabel': 'Import login state (userToken or full JSON)',
    'login.advanced': 'Advanced: import / export login state',
    'login.advancedHint': 'For moving machines, expired tokens or backups. Importing reloads web tabs and interrupts any in-flight reply.',
    'login.importHint': 'Paste a userToken, {"value":"..."} or {"userToken":"...","cookies":[...]}. Importing reloads web tabs; any in-flight reply is interrupted.',
    'login.importPlaceholder': 'Paste a userToken or the full login-state JSON',
    'login.import': 'Import and check',
    'login.importing': 'Importing…',
    'login.importOk': 'Imported; login state is now valid',
    'login.importWarn': 'Written, but still not logged in — check whether the token has expired',
    'login.importPend': 'Written; waiting for the page to load and re-check…',
    'login.export': 'Copy login state',
    'login.exporting': 'Reading…',
    'login.copied': 'Copied to clipboard (treat it as a credential)',
    'login.copyManual': 'Could not copy automatically — select the text below',
    'login.exportWarning': 'The exported token is a credential; never share it.',
    'login.unavailable': 'Cannot read login state: the host exposes no webServer service, or this page is not same-origin.',
    'login.emptyRaw': 'Paste a login state first',
    'login.exportTitle': 'Login state (copy manually)',
  },
} as const

/** 由字段规格派生的分组 / 字段 / 档位 / 下拉选项文案，拼进两份字典。 */
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
    if (field.optionLabels !== undefined) {
      for (const [value, text] of Object.entries(field.optionLabels)) {
        zh[`field.${key}.opt.${value}`] = text.zh
        en[`field.${key}.opt.${value}`] = text.en
      }
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

/** 两份完整字典；`ctx.locale.register` 要求两边键集合一致。 */
export const LOCALE_DICTIONARIES = buildDictionaries()

/** 默认翻译器：找不到 key 时原样返回，便于发现漏键。 */
export const fallbackTranslate: Translate = key => key

/**
 * 按系统语言判定界面语言。
 *
 * @param source - 系统语言标签；缺省读 `navigator.language`。
 * @returns `zh` 或 `en`；任何非中文标签都落到 `en`。
 */
export function detectSystemLanguage(source?: string): UiLanguage {
  const value = source ?? (typeof navigator === 'undefined' ? '' : navigator.language)
  return /^zh\b/i.test(value) ? 'zh' : 'en'
}

/**
 * 把配置里的语言取值解析成实际语言。
 *
 * @param setting - 配置值（`auto` / `zh` / `en`，或任何脏数据）。
 * @param systemLanguage - 测试注入的系统语言；生产环境留空。
 * @returns 实际生效的界面语言。
 */
export function resolveUiLanguage(setting: unknown, systemLanguage?: string): UiLanguage {
  if (setting === 'zh') return 'zh'
  if (setting === 'en') return 'en'
  return detectSystemLanguage(systemLanguage)
}

/**
 * 取文案。
 *
 * @param language - 已解析的界面语言。
 * @param key - 字典键。
 * @returns 文案；缺键时返回 key 本身。
 */
export function translateBy(language: UiLanguage, key: string): string {
  return LOCALE_DICTIONARIES[language][key] ?? key
}

/**
 * 为某个语言生成翻译器。
 *
 * @param language - 已解析的界面语言。
 * @returns 绑定语言的 `t`。
 */
export function translatorFor(language: UiLanguage): Translate {
  return key => translateBy(language, key)
}
