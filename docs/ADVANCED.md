# 配置与进阶使用

[返回项目首页](../README.md) · [中文安装速查](../INSTALL.md)

## 命令行 / 手动 profile（进阶）

已配置 dsh CLI 时，可以用官方插件管理命令安装同一个包：

```bash
dsh plugin --profile desktop add https://github.com/LittleCar30/dsh-deepseek-web/releases/download/v0.6.0/dsh-deepseek-web-littlecar30-0.6.0.tgz
```

仅在需要手工管理 profile 时，把以下字段合并到现有清单，保留原有依赖和 bundles：

```json
{
  "dependencies": {
    "dsh-deepseek-web-littlecar30": "https://github.com/LittleCar30/dsh-deepseek-web/releases/download/v0.6.0/dsh-deepseek-web-littlecar30-0.6.0.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-deepseek-web-littlecar30"]
    }
  }
}
```

之后在该 profile 目录执行宿主使用的包管理器安装命令，再重启。
本地文件使用 `file:` 绝对路径。包内的 `dsh.bundle.patch` 会自动加载 host/client。
手动 patch 启动和源码开发可用 `dsh web --patch node_modules/dsh-deepseek-web-littlecar30/dsh.patch.yml`；
普通桌面版安装不需要这一步。

## 首次使用

默认配置是 `browser: managed`。第一次使用时，插件会直接启动一个独立的真实 Edge 窗口，
并在该窗口中打开 DeepSeek；登录状态保存在插件专用 profile 中：

启动桌面版并第一次选择该模型时，插件会自动打开这个窗口；完成登录后即可继续任务。

如果选择 `browser: attach`，才需要先启动带 CDP 端口的外部浏览器：

```bash
node node_modules/dsh-deepseek-web-littlecar30/tools/browser-keeper.mjs \
  --profile "%LOCALAPPDATA%\DshDeepSeekWeb\edge-profile" \
  --port 9333 --url https://chat.deepseek.com
```

启动桌面版后，在插件列表中确认 `llm-deepseek-web` 已注册，模型选择
`deepseek-web`。第一次发送时，插件会把消息填入网页输入框并聚焦浏览器；
默认需要用户在网页中点击“发送”。

### dsh 新对话与网页窗口

dsh 创建新对话时，插件会在已经打开的 DeepSeek 浏览器窗口和当前标签页中点击网页的
“新对话”入口。普通任务复用当前工作标签，上下文过长需要轮换时同样复用当前页面。
从 0.2.12 起，dsh 内部摘要和标题生成会临时打开独立标签，共享登录态，结束、失败或取消后关闭；
不会向工作标签发送摘要指令。切换已有 dsh 会话或重启后首次使用时，会根据宿主历史重建上下文。

### 浏览器启动方式与网页可见特征

`managed` 模式直接启动系统已安装的 Edge/Chrome 可执行文件，再通过本地 CDP
连接；它不再使用 Playwright 的 `launchPersistentContext` 启动器，也不设置自定义
User-Agent 或额外 HTTP 请求头。网页看到的 UA、Client Hints、Cookie 和登录态来自
真实浏览器及插件专用 profile。

仍然需要说明：浏览器启用了本地远程调试端口，且页面操作由自动化协议驱动，网站不能被
保证为“绝对不可检测”。新实现去掉了旧的 `--disable-blink-features=AutomationControlled`
启动参数，行为更接近普通可见浏览器，但网络环境、账号行为、操作节奏和站点自身检测仍
可能影响风控结果。

## 配置

配置入口有两个：**设置 → DeepSeek 网页**（12 组 59 项常用参数，保存即写回 profile 的
`cordis.patch.yml`），以及桌面版“插件”页面 → `dsh-deepseek-web-littlecar30` →
`llm-deepseek-web` → “配置”（同一份表单）。下表的进阶字段（回合/流超时、锁租约等）
仍没有表单入口，直接在 patch 的 `config` 中写入；**并发上限、标签页上限、防风控停顿、
账号冷却、工具目录预算、登录探活** 已并入表单，其中防风控相关项集中在「风控模式」分组，
并带「关闭 / 均衡 / 严格」一键档位。

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `url` | `https://chat.deepseek.com` | DeepSeek 网页地址 |
| `browser` | `managed` | `managed` 启动独立浏览器，`attach` 连接外部 CDP |
| `channel` | `msedge` | managed 模式使用 `msedge` 或 `chrome` |
| `debugPort` | `9333` | attach 模式端口；managed 模式的首选端口，冲突时自动选择空闲端口 |
| `sendMode` | `manual` | 人工点击发送；`approved` 预留给宿主审批流 |
| `model` | `deepseek-web` | 网页模型开关校准目标 |
| `liveThinking` | `false` | 是否展示网页真实思考；正文不混入思考块，不改变网页思考模式 |
| `compactionLanguage` | `task` | 官方压缩摘要跟随用户任务语言；`host` 保留宿主要求，`zh` / `en` 固定中英文 |
| `maxToolResultChars` | `6000` | 工具结果送入网页模型的字符上限，按头尾截断；不截断最终正文或网页委托结果 |
| `streamIdleTimeoutMs` | `600000` | 网页流空闲超时（毫秒），默认 10 分钟。自动发送时「回车 → 看到响应头」这一段另由 `SEND_ACK_TIMEOUT_MS`（3 分钟）封顶，所以实际不会等满 10 分钟；人工发送（`sendMode: manual`）不吃这个值，固定给 3 分钟等你点发送。`review.streamIdleTimeoutMs` 同默认 `600000`（10 分钟），审核首响应另封顶 2 分钟 |
| `maxSessionPages` | `3` | 同时保留的会话标签页上限（每个并发会话独占一页）；超出按“最久未用且当前没在跑”的页回收，`1`–`8` |
| `maxConcurrentTurns` | `1` | 全局并发上限：同一时刻最多几条请求真在网页上跑（主会话/子代理/辅助请求一起算）；超出的按先进先出排队，`0` 表示不限制。默认 `1` 是因为网页端的频控与临时封禁按**账号**结算，不是按标签页——多会话仍各自占一个标签页，但同一时刻只有一个在真正打网页 |
| `sendPauseMinMs` / `sendPauseMaxMs` | `2000` / `4000` | 全自动发送时，消息填入输入框之后、按回车之前的随机停留区间（毫秒）；真人不会打完字立刻回车，固定延迟方差≈0 反而是机器特征。两者为 `0` 即关闭 |
| `turnGapMinMs` / `turnGapMaxMs` | `2000` / `4000` | **回合间隔**：上一轮网页回合结束到下一轮真正发请求之间的随机等待区间（毫秒）。与 `sendPause*` 的区别是计时起点——那个只管「填字完成 → 回车」，这个管回合与回合之间。长任务连续续跑时，旧行为是上一轮结束立刻发下一条（0 间隔），最像脚本。两者为 `0` 即关闭 |
| `longRunAfterSends` | `15` | 连续发满多少轮后强制静默一段（防风控），`0` 关闭；10 分钟内无请求即视为断开、重新计数 |
| `longRunPauseMinMs` / `longRunPauseMaxMs` | `30000` / `60000` | 上面那次强制静默的随机区间（毫秒），默认 30–60 秒 |
| `turnTimeoutMs` | `900000` | 单个网页回合上限，超时中止并报错，`0` 表示不限制 |
| `lockLeaseMs` | `4500000` | 会话锁租约，持有者泄漏时到点强制回收；必须大于“最大合法整轮” |
| `maxStreamMs` | `3600000` | 单次请求（整条流，含纠错/委托/多轮审核）上限，超时主动取消网页回合，`0` 表示不限制 |
| `rateLimit.enabled` | `true` | 是否自动处理“发送过于频繁” |
| `rateLimit.retryDelayMs` | `60000` | 首次重发等待（毫秒），也是指数退避的基数 |
| `rateLimit.maxRetries` | `4` | 单轮频控重发次数；配合默认退避合计约 12 分钟，覆盖实测 10–15 分钟冷却 |
| `rateLimit.backoff` | `exponential` | 退避曲线：`exponential` 每次翻倍；`fixed` 每次都等 `retryDelayMs` |
| `rateLimit.retryMaxDelayMs` | `300000` | 单次等待封顶（毫秒），防止退避越滚越长把回合拖死 |
| `rateLimit.jitterRatio` | `0.15` | 每次等待在基准值上随机浮动 ±15%，避免多实例同一秒重撞 |
| `rateLimit.accountCooldownMs` | `600000` | 自动重发用尽后，给**整个账号**上一把冷却锁（毫秒）：冷却期内所有会话都不再向网页发请求，直接报 `WEB_ACCOUNT_COOLDOWN`。`0` 关闭——但那意味着一个会话被限流后别的会话照打网页，正是最容易触发 1 天封禁的形态 |
| `notify.enabled` | `true` | 过程提示总开关（关掉后对话里和浏览器里都不再有提示） |
| `notify.session` | `true` | 主对话提示（前缀 `[DSH]`）：发送、接收、完成、频控等待/重发、失败 |
| `notify.review` | `true` | 审核提示（前缀 `[DSH·审核]`），与会话提示分开显示 |
| `notify.send` | `true` | 发送侧提示：已发送 / 已填入等待你点发送 |
| `notify.receive` | `true` | 接收侧提示：网页已响应、开始生成、本轮完成、频控倒计时 |
| `notify.errors` | `true` | 失败提示：把错误码翻成一句人话加处理建议（表外错误回退原文） |
| `notify.browser` | `true` | 网页右下角的浮层提示（频控倒计时、等待重发），不挡点击 |
| `browserRecovery.enabled` | `true` | 浏览器或网页标签被关掉时是否自动恢复并重发本轮；关掉后只报 `WEB_PAGE_CLOSED` |
| `browserRecovery.maxAttempts` | `2` | 单轮最多恢复几次；连续被关超过这个次数通常意味着有东西在反复杀进程，此时抛原始错误更有用 |
| `browserRecovery.delayMs` | `2000` | 重新拉起浏览器前的等待（毫秒），给系统回收窗口句柄 |
| `toolAllowlist` | 常用文件/终端工具 | 暴露给网页模型的工具白名单 |
| `excludeToolNames` | `['web_search']` | 强制隐藏的工具名 |
| `maxToolCatalogChars` | `28000` | 单次下发给网页模型的工具目录字符预算。超预算时先逐条退让、只留能装下的工具，并在末尾**点名列出被省略的工具**（静默砍工具会让模型表现成「不会用工具」）；`0` 不限制 |
| `maxReplayChars` | `400000` | 全量回放历史时单条消息的字符上限。网页输入框填字代价接近二次方增长（30 万字符约 13 秒、60 万约 77 秒、110 万会拖死主线程），超预算按消息粒度丢弃最早的历史并留一行省略说明；系统指令与协议清单不计入预算；`0` 关闭 |
| `loginProbe.enabled` | `true` | 是否在后台只读检查网页登录态（不发送、不消耗额度）。失效时只提醒，不拦发送 |
| `loginProbe.initialDelayMs` | `20000` | 启动后多久做第一次探活（毫秒） |
| `loginProbe.intervalMs` | `1800000` | 之后每隔多久探一次（毫秒，默认 30 分钟）；`0` 只探一次 |
| `review.enabled` | `false` | 是否启用交付审核 |
| `review.provider` | 发行 patch 为 `deepseek-web`；schema 为 `kimi` | `deepseek-web`、`kimi` 或 `glm` |
| `review.debugPort` | `9334` | Kimi 审核浏览器 CDP 端口 |
| `review.glmDebugPort` | `9335` | GLM 审核浏览器 CDP 端口 |
| `review.autoSend` | `true` | 审核自动化程度：`true` = 全自动（填入后自动发送并确认真的发出，发不出去当场报错）；`false` = 半自动（只填入并聚焦窗口，等你点发送） |
| `review.kimiMode` | `normal` | Kimi 审核模式：`normal` = 正常模式，每轮开一个普通对话；`project` = 项目模式，每轮在指定项目里开对话 |
| `review.url` | `https://www.kimi.com/?chat_enter_method=new_chat` | 正常模式下审核窗口打开的链接。缺 `chat_enter_method` 时自动补上，已有则原样使用；可填企业版域名或带自有查询参数的地址 |
| `review.projectUrl` | 空 | 项目模式要用的 Kimi 项目，**只填项目 ID**（形如 `1a15bef4-b7a2-894f-8000-0e7143648841`）；插件拼成 `<正常模式链接的域名>/project/<ID>?chat_enter_method=new_chat`，填完整项目页链接也认。留空或填了非 ID 内容会明确报错，不会静默退回普通对话 |
| `review.glmUrl` | `https://chat.z.ai/` | GLM 审核窗口打开的链接，规则同上 |
| `review.sendVerifyMs` | `1500` | 自动发送后确认“已发出”的等待窗口（毫秒）；窗口内没等到信号才视为没发出去 |
| `review.sendRetries` | `2` | 发送未被确认时的重试轮数（每轮 = 回车 + 点发送按钮兜底） |
| `review.fetchRetries` | `1` | 获取回复失败后的自动重试次数（`0` 关闭）；每次重试前都会丢弃旧连接并重新连浏览器 |

完整字段和默认值见 [`src/config.ts`](https://github.com/LittleCar30/dsh-deepseek-web/blob/main/src/config.ts)。配置文件中的 profile、状态和
校准数据默认保存在 `%LOCALAPPDATA%\DshDeepSeekWeb\`，不会写入插件安装目录。

### 会话隔离、并发上限与排队

主会话和它派生的子代理是两个不同的 dsh session。插件会给每个会话分配独立的网页
标签页和独立的会话锁，所以两边可以同时跑、互不遮挡；同一个会话的多个请求仍然串行
（它们共用同一个网页对话）。

但同一个 DeepSeek 账号的网页端并发不是无限的，并发太高会一起触发“发送过于频繁”。
因此插件还有一层全局并发网关：`maxConcurrentTurns`（默认 `1`）。当前正在网页上跑的
请求数达到上限后，新的请求按到达顺序**先进先出排队**，每结束一个就放行下一个：

- 想更并行：把 `maxConcurrentTurns` 调到 3–4，同时把 `maxSessionPages` 调到不小于它；
  这会提高被网页判「同时开多个窗口」的风险，账号重要时不要这么做；
- 默认 `1`：多会话仍各占自己的标签页，但同一时刻只有一个在真打网页；
- `0` 表示完全不限制（只计数、不排队），一般不建议——高并发下所有会话会一起重试退避。

排队超过 3 秒会在日志里打印“会话 xxx 排队中/并发上限已满”，与“卡死”区分开；
关掉窗口或取消生成时，排队中的请求会立即退出队列，不会占住名额。

自动重发用尽后，账号级冷却（`rateLimit.accountCooldownMs`，默认 10 分钟）会把**所有会话**
一起暂停：冷却期内的请求不发往网页，直接报 `WEB_ACCOUNT_COOLDOWN` 并说明剩余时间。
这把锁跨进程内的通道实例存在，改配置或热重载都不会绕过它。

### 只返回结果与长回复

从 0.2.11 起，`liveThinking` 默认关闭，dsh 只输出最终正文或工具调用。
如果旧配置显式保存了 `liveThinking: true`，升级后仍会展示思考，请在插件配置中
关闭“显示网页思考过程”，或在 patch 的 `config` 中设置 `liveThinking: false`。
此设置不会关闭 DeepSeek 网页自身的思考模式，也不会删除已有对话里的思考记录。

手动开启后，思考块仅展示网页真实思考，回答正文和工具调用 JSON 不再混入思考块。
网页委托（如 `web_search` / `web_fetch`）返回的正文会完整展示，不再因超过
6000 字符而丢失末尾结论。`maxToolResultChars` 仍用于限制送入网页模型的工具结果，
审核证据的长度限制也继续生效。网页自身的生成或上下文长度上限仍由站点决定。

## 自检与调用台账

两个能力都只读、只在本机：不发送消息、不消耗网页额度、不上传任何数据。

### `npm run doctor`：本机体检

```bash
npm run doctor                # 全量：静态项 + 需要浏览器的项
npm run doctor -- --offline   # 只跑静态项，完全不碰浏览器
```

退出码 `0` = ready，`1` = not ready。检查项逐条给 `✓ / ! / ✗` 与一行说明：

| 检查 | 内容 |
| --- | --- |
| `browser-executable` | `msedge` / `chrome` 两个通道分别查，命中就打印可执行文件路径 |
| `browser-channel-missing` | 配置里选的通道本机没有，直接把两个通道的查找路径列出来 |
| `profile` | profile 目录能否真正写入（写一个临时文件再删，比 `access(W_OK)` 可信）；`attach` 模式跳过这项 |
| `state-file` | 会话游标文件所在目录是否可写 |
| `build` | 磁盘上的代码构建标识 vs `%LOCALAPPDATA%\DshDeepSeekWeb\loaded-build.json` 里记的加载戳——不一致说明「改代码、重启、线上还是老行为」 |
| `ledger` | 台账里近 7 天的调用次数、失败数、相邻对话间隔的最短/中位/p90；最短间隔 < 30 秒判 warning |
| `cdp` | 已在跑的 CDP 端口是否可连（连着就直接复用，不再二次启动浏览器） |
| `login` | 只读判断登录态：跳登录页 / 登录墙 |
| `editor` / `send-button` | 输入框与发送按钮的选择器命中情况（跑一遍候选表，输出 `n/m 命中：…`）；发送按钮找不到只判 warning，纯回车站点本来就没有 |
| `pacing` | 回显当前的发送间隔、长休、并发上限、标签页上限、回放预算 |
| `account-standing` | **永远是 warning**：本地无法证明账号没被限流，请到网页确认一次 |

设计口径与竞品 `dsh-chatgpt-web` 的 doctor 一致：**只报事实，不做修复**；本地证明不了的事一律
warning，不假装全绿。

### 调用台账

`src/ledger.ts` 把每次网页调用记到 `%LOCALAPPDATA%\DshDeepSeekWeb\call-ledger.json`：

- 每条只有 `{at, purpose, outcome, failure?, code?, durationMs?}` —— **没有对话内容，没有凭证**。
- `purpose` 分 `chat` / `auxiliary` / `review`；`failure` 分 `rate-limit` / `account-blocked` / `login` / `network` / `timeout` / `other`。
- 滚动保留 7 天，按天归档；写盘走临时文件 + `rename` 原子替换，文件损坏时从空台账开始，绝不影响真实发送。
- 统计口径：相邻对话间隔**只算 `purpose === 'chat'` 且成功的记录**——失败重试会把最短间隔压成无意义的 2 秒，辅助请求是高频旁路。

设置页底部（十二组配置之后）是这张卡片的只读视图：六格统计、失败分布、按天列表，
以及一个「运行自检」按钮（点了才会去连浏览器）。数据走同源只读路由
`/api/dsh-deepseek-web/ledger` 与 `/api/dsh-deepseek-web/doctor`，围栏要求 Host 是 loopback、
拒绝 `sec-fetch-site: cross-site`、Origin 必须同源；没有 `webServer` 服务的老宿主上这段自动不注册。

## 审核通道

审核默认关闭。开启后，每轮交付会根据 `review.provider` 选择：

- `deepseek-web`：同一网页对话自审，不需要额外浏览器。
- `kimi`：使用端口 `9334` 的独立 Kimi 窗口，需要先登录。
- `glm`：使用端口 `9335` 的独立 GLM 窗口，需要先登录。

登录和协议检查工具都在 `tools/`：

```bash
node node_modules/dsh-deepseek-web-littlecar30/tools/open-login-kimi.mjs
node node_modules/dsh-deepseek-web-littlecar30/tools/inspect-kimi.mjs
node node_modules/dsh-deepseek-web-littlecar30/tools/open-login-glm.mjs
node node_modules/dsh-deepseek-web-littlecar30/tools/glm-status.mjs --turn
```

审核证据会优先读取工具实际写入的文件，并在达到 `maxEvidenceChars` 时标注截断。
内部摘要和标题请求不进入交付审核，也不会附加“审核通过”等文字。

### 审核消息怎么发出去

`kimi` / `glm` 走的是真实网页，插件把审核内容填进输入框之后必须让页面真正发出这条消息。
`review.autoSend` 把这里明确成两档，没有中间态：

- **全自动（`true`，默认）**：填完自动发送，并且**确认真的发出去了**才继续等回复。确认流程是
  「回车 → 看输入框是否清空 → 没清空就点发送按钮 → 再看」，命中任一信号即算发出
  （输入框清空 / 网络层已看到本轮请求 / 发送按钮转为生成态）。没确认就按
  `review.sendRetries` 重试，仍失败则报 `KIMI_SEND_FAILED` 并把每次尝试写进错误信息。
  只按一次回车是不够的：有的版本回车会换行、有的会被输入法吞掉，这就是「填进去了却没发出去」的来源。
- **半自动（`false`）**：填完停住，把窗口提到最前，等你自己点发送。适合想先看一眼审核内容再发的场景；
  等待超过 `review.streamIdleTimeoutMs` 会明确报超时，不会静默挂住。

### 审核对话开在哪里

Kimi 审核分**两种模式**，在设置页「Kimi 审核」分组里用「审核模式」选择，两者各用各的入口地址，
互不兜底：

| 模式 | 用哪个配置 | 每轮打开什么 |
| --- | --- | --- |
| 正常模式（`normal`，默认） | `review.url` | 一个独立的新对话标签页 |
| 项目模式（`project`） | `review.projectUrl`（**只填项目 ID**） | 项目页，对话归到这个项目下 |

选 `normal` 时设置页只显示「正常模式链接」，选 `project` 时只显示「项目 ID」，
看着不会串。项目模式的「项目 ID」**只填 ID 就行**，形如
`1a15bef4-b7a2-894f-8000-0e7143648841`（项目页地址 `/project/` 后面那一段），
插件会拼成

```
<正常模式链接的域名>/project/<项目ID>?chat_enter_method=new_chat
```

再打开，所以你换企业版域名时域名会跟着走，不用两边都改。填完整项目页链接也认
（老配置里存的就是整条地址），此时原样使用、不再拼接；填了明显不是 ID 的内容会报
`KIMI_PROJECT_ID_INVALID` 并给出填法。没填项目会直接报 `KIMI_PROJECT_URL_MISSING`，
**不会**悄悄退回普通对话——审核结果落错地方比明确失败更难发现。

两种模式都是**每轮新开一个浏览器标签页**，发出后关掉上一轮的审核标签，任何时候只留一个
Kimi 审核页，不会一轮攒一个标签。

正常模式的默认地址是

```
https://www.kimi.com/?chat_enter_method=new_chat
```

`chat_enter_method=new_chat` 是 Kimi 自己的建新参数，带上它新标签打开就是 0 条消息的
干净对话。通道只做一件事：**地址里没有这个参数就补上，已经有就一个字不动**（旧配置只写
了域名照样能用），所以你完全可以接管这个地址，换成企业版域名或加上自己的查询参数。

之所以不用「点侧边栏的新建会话按钮」：那个入口是只有一个图标的 `<a aria-label="新建会话">`，
标签页在后台时 `locator.click()` 点不动；直接 `goto` 首页又会被站点恢复成上一次的对话。
两条路都会静默失败，表现就是"配置了新开对话却还是同一个对话，越审越慢"。

#### 项目模式实测到的行为

在项目页（`/project/<id>`）打开时，输入框提示是「在"审核"中开始对话…」（「审核」是项目名）。
**发出第一条消息后地址会变成 `/chat/<uuid>`，`/project/` 前缀消失**，但对话确实归到了该项目下——
项目页里有 `div.project-chat-list` 这个对话列表容器，刚发出的一轮作为 `a.project-feed-link`
出现在里面，链接带 `chat_enter_method=project`（实测容器链：
`a.project-feed-link ← div.project-feed-item-container ← div.project-chat-list ← main.project-conversation`）。
也就是说：

- 项目页能稳定复用，每轮从项目页发都归到项目里；
- 但发完消息的页面地址已经看不出"属于哪个项目"，所以**页面归属只能靠"这一页是用哪种模式开的"
  来判断，不能看路径**。通道记着每一页的来源模式，切模式后会自动换页，
  不会把正常模式的审核发进项目、也不会把项目的发进普通对话。

### 审核卡住时会发生什么

获取回复阶段的每一段等待都有明确上限，不会无限挂住：

- `response.finished()` / `response.body()` 的超时是 `review.streamIdleTimeoutMs`（默认 10 分钟），
  超时抛 `KIMI_STREAM_STALLED` / `GLM_STREAM_STALLED`，而不是一直等。
- 页面或浏览器已经失效（窗口被关掉、连接断掉）时立刻丢弃旧连接，下次请求重新连，
  不在死页面上反复操作。
- 等回复超时、空响应、页面断开、发送未确认这几类「环境抖动」会自动重试
  `review.fetchRetries` 次（默认 1），重试前先重新连接浏览器。
- 没登录、发送按钮被禁用、找不到输入框、用户取消这些**认得出根因**的失败直接报错，
  不用重试把明确的错误拖成更长的等待。

<a id="context-recovery"></a>
## 0.2.12：上下文压缩与任务接续

dsh 的上下文压缩会发起 `purpose: compaction` 辅助调用。已核查的桌面版
0.2.0-rc.2 官方压缩模板要求使用英文生成交接摘要；这类摘要应供后续模型使用，
不能代替用户要求的中文文件、流程包或其他交付。先前插件将它当成普通任务，
可能覆盖当前任务、清空消息游标，并遗漏压缩后的宿主检查点。

0.2.12 对 `compaction` 和 `session-title` 使用独立的一次性处理流程：

- 在临时网页对话中按此次请求提供的历史范围生成正文，不读取工作标签的隐式历史。
- 不修改正常会话的任务目标、游标、审核状态、最近回复或 token 基线；辅助用量单独计入通道总计。
- 不解析为本地工具动作，不执行网页工具委托，不展示辅助思考，不进入交付审核。
- 保留宿主系统指令、插件上下文和 `compact-checkpoint`（含兼容的 `<compacted-summary>` 格式）。
  检查点变化或旧游标失效时，在工作标签建立新对话，回放摘要、近期助手/工具消息与真实用户任务。
- 首次读取旧状态时同步宿主历史，清除明确的官方压缩指令污染；原任务已被压缩移除时，依据检查点继续。
- 对明确的未完成交接回复尝试一次纠错，仍返回交接摘要则报错；用户明确要求总结、摘要或分析时不拦截。

升级后重启 dsh，继续原任务即可触发状态恢复，无需删除状态文件或已有交付文件。
若旧会话保存了错误摘要且缺少原任务，请重新说明需要完成的工作或开启新对话。
旧版已生成/写入的摘要或文件不会被自动改写，也不能保证从不完整的宿主历史恢复丢失事实。

半自动模型的辅助请求仍需在临时标签人工点击发送；`deepseek-web-auto` 自动发送。
请求串行执行以避免输入和回复混用。临时标签使用同一网站登录态；0.2.14 起，已识别的官方
压缩模板默认跟随用户任务语言，`compactionLanguage: host` 可恢复宿主英文模板。
标题、自定义辅助指令和已有检查点保持原样。浏览器标题和日志会显示辅助请求用途。

网页明确报告输出上限时，辅助请求返回 `max-tokens`，由 dsh 拒绝不完整摘要；
正常任务报 `WEB_REPLY_TRUNCATED`，不作为完整交付提交。网页报告中断或传输失败时会报错。
网站未提供结束原因时，插件不能仅凭最后一个词准确判断是否截断，也无法保证网页严格执行
宿主的 `maxTokens` 参数。摘要历史超过网页上限时，可在 dsh 的 `dsh-compaction-basic` 中配置
独立的 `summarizationProvider` / `summarizationModel`，或缩小压缩范围。

故障排查可对照 dsh 会话日志中的 `compaction/start`、`compaction/summary`、`compaction/end`
与后续普通助手回复，并记录 dsh/插件版本和网页对应回复；不要只凭回复语言判断来源。

## 0.2.14：工具调用恢复与压缩参数

DeepSeek 网页偶发返回 DSML 标签形式的原生工具调用。旧版只解析 JSON，会把这些标签作为
正文返回并结束任务。0.2.14 兼容完整 DSML 调用，多动作全部解析成功后才进入相同的本地
白名单和参数校验。截断、非法参数或纠错后仍无法解析时明确失败，保留原会话游标以便重试。
网页累计用量没有可靠的输入/输出分类，因此只保留通道累计统计，宿主用量面板可能不再显示
这些数值；不能把累计总量当成输出 token。

已核查的 dsh 0.2.0-rc.2 默认压缩预留 `headroomTokens: 65536`，在网页模型 128000 上下文、
16000 输出预留下，实际阈值为 `min(128000 × 0.8, 128000 - 16000 - 65536) = 46464`。
工具 schema 也计入压力。顶部 compaction 插件开关不一定控制 standard 预设的隔离 compaction。

可选配置工具会在实际 agent preset 内写入仅针对 `deepseek-web` 路由的策略：
`thresholdRatio: 0.8`、`headroomTokens: 8192`、摘要 `maxTokens: 4096`。相同预算下阈值为
102400。它保留其他模型策略和已有预设，并先备份 profile patch；不自动修改所有安装者的预设。
源码版本和发行包均可运行：

```powershell
node tools/configure-web-compaction.mjs --profile "$env:USERPROFILE\.dsh\profiles\desktop" --asar "D:\DeepSeek Harness\resources\app.asar"
```

按实际安装路径调整 `--asar`；CLI 安装可用 `--runtime-root <dsh包目录>`，其他预设用
`--preset <预设id>`。重启 dsh 后生效。宿主仍会在需要压缩时生成临时摘要对话，检查点变化后
重建工作网页上下文；这不会新建 dsh 会话。网页是否严格遵循摘要输出预算由站点决定。
