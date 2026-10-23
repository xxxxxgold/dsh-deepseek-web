# 插件市场同类软件调研：值得借鉴的 13 条

> 调研日期 2026-10-22 · 对象：DSH 插件市场里与「DeepSeek 网页通道」同赛道或邻接的 19 个已发布插件（另解包 1 个精选列表包）
> 结论口径：**只写能落到本项目（`dsh-deepseek-web-xxxxxgold`）具体位置的做法**，不写泛泛而谈的「要重视体验」。
> 落地状态：调研后按 `§2` 的优先级实施了 S1–S3，成果见 `§5`；本文件保留调研当时的判断，**当前代码以 0.6.0 为准**。

---

## 0. 一句话结论

**同赛道的天花板不在 UI，在「防风控工程」和「失败可解释性」。**

月下载 1.45 万的 `dsh-deepseek-web-login` 靠的不是功能多，而是把「怎么不被封号」写成了可配置、可观测、可复算的参数表；工程化最完整的 `@wlv-zedd/dsh-chatgpt-web` 靠的不是功能多，而是 `doctor.ts` + `classifyError()` + 进程级重试预算这一套「出问题能自己说清是哪一层坏了」。

本项目在**发送可靠性**（`sendEditorMessage` 发送确认、`startAckClock` 首响应窗口、`browserRecovery` 自愈）这条线上做得不浅：在已读的 19 个竞品里，只有我们把「回车之后输入框是否真的清空」当成发送成功的第一判据（其余多数是「按下回车就算发出去了」；`dsh-deepseek-web-login` 不发 DOM 事件，没有这层问题）。调研当时的短板集中在三处，**0.6.0 已全部补齐**：

1. ~~没有账号级冷却与回合间隔~~ → `src/cooldown.ts` + `rateLimit.accountCooldownMs` + 30 分钟重试预算 + `src/pacing.ts` 的回合间隔（`turnGapMinMs/MaxMs`，默认 2–4 秒，从上一轮结束起算）。
2. ~~没有主动探活~~ → `src/login-probe.ts`，启动 20 秒后 + 每 30 分钟只读探活。
3. ~~发布面几乎为零~~ → `engines.dsh` / `keywords` / `disclosure` 已补，CI 已建，版本对齐 0.6.0；**进市场目录仍需人工提 PR**。

---

## 1. 调研怎么做的

| 步骤 | 做法 | 结果 |
|---|---|---|
| 圈定池子 | 读本机市场索引缓存 `~/.dsh/profiles/desktop/.dsh-market/discovery-compatibility-v1.json` | 3298 个包名（每条只有 `{checkedAt, facts{version,enginesDsh,peerDependencies}}`，无描述） |
| 关键词筛 | `web / browser / channel / free / provider / deepseek / chatgpt` 正则匹配包名 | 165 个候选（其中包名含 `deepseek` 的 28 个、含 `chatgpt` 的 4 个），人工收敛到 19 个真正相关 |
| 拉元数据 | `registry.npmjs.org` 取 `dist-tags.latest` 的 `dist.tarball` 再下载 | 19 个包全部解包到 `.tmp-market-research/`（17.6 MB） |
| 读什么 | README（含中英双语、CHANGELOG、已知限制）+ 关键源码（`doctor.ts` / `context-feed.ts` / `errors.ts` / `retry-policy.ts` / `package.json`） | 深读 8 个，扫读 11 个 |
| 看体量 | npm `last-month` 下载量（2026-10 采样） | 见下表 |

### 同类插件一览（按下载量）

| 包 | 版本 | 月下载 | 一句话定位 |
|---|---|---|---|
| `dsh-deepseek-web-login` | 1.0.3 | **14 512** | 网页私有接口的非官方客户端（不是 DOM 自动化） |
| `dsh-web-fetch-playwright` | 0.2.12 | 3 419 | Playwright 抓网页，挑战页有界等待 |
| `dsh-plugin-chatgpt` | 0.1.14 | 3 181 | ChatGPT 订阅接进 DSH，SIWC 方案 |
| `@iasiv5/dsh-skip-browser-auth` | 0.4.1 | 2 816 | 按精确版本对跳过 Web 启动 token |
| `@arcaneorion/dsh-model-channel-manager` | 0.4.0 | 2 278 | 渠道轮询 + 配置/运行态分离 |
| `@jaychang1989/dsh-webchat` | 0.7.8 | 2 125 | 把 chat.deepseek.com 嵌进 DSH 中栏 |
| `dsh-free-models-hub` | 0.3.1 | 2 033 | 免费模型榜 + 一键配 provider |
| `dsh-tool-search` | 0.1.8 | 2 030 | 工具目录超预算时的检索式替代（Hermes 式渐进披露） |
| `@wlv-zedd/dsh-chatgpt-web` | 1.0.4 | 2 001 | 免费 ChatGPT 网页 → 本地 Responses API 代理 |
| `kimi-webbridge-dsh` | 1.4.12 | 1 966 | 守护 daemon + 注册上游 skill 包 |
| `dsh-deepseek-vision` | 0.1.7 | 1 954 | 纯文本模型获得贴图能力（provider 网关） |
| `dsh-deepseek-monitor` | 0.1.8 | 1 798 | 余额/用量面板，挂在输入框右侧槽位 |
| `dsh-browser-playwright-codex` | 0.7.2 | 1 607 | 通用浏览器工具，能力门控做得最狠 |
| `@zerorigin-studio/dsh-deepseek-chat` | 0.3.5 | 1 229 | 侧栏入口 + 独立子窗口 |
| `dsh-deepseek-quota-bar` | 0.6.1 | 1 176 | 余额血条悬浮卡 |
| `dsh-web-kimi` | 0.1.0 | 1 009 | Kimi 一把 key 填 `ctx.web` 两个 seam |
| `dsh-browser-use` | 0.1.0 | 1 002 | Browser Use 云桥（反面对照：极薄） |
| `@yichenwilian/dsh-deepseek-web` | 0.1.0 | 223 | 把 chat.deepseek.com 当可编程 Agent |
| `dsh-deepseek-web-free` | 1.0.10 | 136 | y-wi 上游 fork，DSH 0.2.x 适配 |
| **本项目** | 0.5.0（npm 0.2.14） | **28** | 真实 Edge/Chrome + 半自动/全自动 + 可选审核 |

> 上表是**已解包的 19 个竞品 + 本项目**。读过但未解包的邻接项未列入（如 `@norman-else/dsh-claude` 4 168、`dsh-chatgpt-bridge` 1 767、`@ricardochen1996/dsh-browser-use` 1 313）。

> 下载量是量级参考，不是质量排序。`dsh-browser-use` 只有 1 002 且自述「Honest limits: 一个工具转发云 API」——市场能接受小而诚实，但天花板低；反过来 1.45 万的 login 是 73 KB 中文 README + 48 KB 英文 README + 388 KB CHANGELOG 堆出来的。

---

## 2. 值得借鉴的 13 条（按「投入产出比」排序）

### P0-① 医生自检：把「装完能不能用」变成一条命令

**竞品怎么做**

- `@wlv-zedd/dsh-chatgpt-web` 的 `src/doctor.ts`：`DoctorCheck{id,status:ok|warning|error,message,detail}`，逐项体检 config → 浏览器宿主 → 服务 → 代理 → 隧道。具体到「端口归属校验（`body.service` 必须是本插件，否则报『这个端口属于别的服务』）」「`version` 必须与 `config.releaseVersion` 一致」「进程所有权 marker 的 `ownerPid` 还活着且 `health.pid === daemonPid`」。最后一条是**故意保留的 warning**：「本地检查无法证明 ChatGPT connector 已挂上这条 tunnel」——不假装全绿。
- `dsh-browser-playwright-codex` 的 `npm run doctor`：harness 升级后重查插件 import 的每个具名导出是否还存在，用来区分「宿主变了」与「插件坏了」。
- `@iasiv5/dsh-skip-browser-auth`：版本对不匹配就 fail-closed 到 dormant，且激活时打印固定警告行。

**我们的现状**

无。`doctor` 在 `src/` 里 0 命中。用户装完遇到问题的第一反应是「插件没生效」，而我们能做的最多是一行 `console.info`。

**怎么落地**（约 1 天）

```
src/doctor.ts          → checkDshVersion / checkPeerPackages / checkBrowserBinary /
                         checkProfileDir(可写) / checkLoginState(只读) /
                         checkCdpPort(归属校验) / checkProviderRegistered
tools/doctor.mjs       → 终端版，输出 ✓ / ! / ✗
设置页「网页连接」组    → 一个「运行自检」按钮，结果就地展开
```

三条竞品都验证过的细节，直接照抄：**检查项只报事实不自动修**；**「无法证明」的项写 warning 而不是 ok**；**每条 detail 写清楚「接下来怎么办」**。

---

### P0-② 错误码要带「可重试语义」，不只是人话

**竞品怎么做**

- `@wlv-zedd/dsh-chatgpt-web` 的 `src/lib/errors.ts`：`classifyError(status,type,message)` → `{message,type,code}` 的完整映射。三条经验：
  - `499 client_closed` 必须排在 `502` 之前判，但 `upstream HTTP client closed idle connection` 不能被误吞；
  - `503/overloaded` 要专门映射成 `server_is_overloaded`——**因为 Codex 只认这个码才会 backoff**，给通用的 `upstream_server_error` 不会触发重试；
  - `parseRetryAfterFromMessage()` 用三种正则抓 `try again in Ns` / `retry after N` / `retry-after: N`，把秒数补进消息里。
- `dsh-deepseek-vision`：默认 fail-closed，稳定错误码 `AUTH / TIMEOUT / TRANSPORT / IMAGE_TOO_LARGE`，或用 `placeholder` 降级为文字占位继续。
- `dsh-plugin-chatgpt`：`REFUSED_FIELDS` 常量（`lib/convert/request.js:9`）把上游明确拒绝的 18 个字段（`temperature` / `max_output_tokens` / `top_p` / `truncation` / `metadata` / `previous_response_id` / `prompt_cache_*` 等）钉成常量，防止被无意加回。

**我们的现状**

`src/notify.ts:206-240` 的 `FAILURE_HINT` 表有 **33 条**具体文案，另有 `KIMI_` / `GLM_` / `BROWSER_` 三条前缀兜底；`src/` 里实际出现 **52 个**错误码（实跑 `tools/rate-limit-check.ts` 输出「覆盖 52 个错误码」，而 `CHANGELOG` 0.4.0 那条仍写「50 个」——文案过期，顺手该修）。**人话这一层我们做得比多数竞品好**，缺的是机器可用的那一半：没有 `retryable`、没有 `scope`、没有「这个错该冷却谁」。

**怎么落地**（约半天）

给每个码补三字段，`describeFailure` 保持不动：

```ts
type FailureKind = {
  code: string
  retryable: boolean
  scope: 'turn' | 'session' | 'account' | 'browser' | 'config'
  hint: string          // 现有文案
  cooldownMs?: number   // scope=account 时给账号冷却用
}
```

`scope` 是后面的账号级熔断、浏览器自愈、配置门禁三条线共同的判据——现在 `browserClosed()` 是硬编码的模式匹配，改成查表更稳，也更好加新错。

---

### P0-③ 账号级冷却熔断：一个会话被限流，全部会话停下

**竞品怎么做**

- `dsh-deepseek-web-login` 的 `~/.dsh/web-login/gate.json`：
  - 长任务保护：连发 15 次后强制长休 60–180 s，「连续」按「距上次请求 < 10 分钟」判定；
  - 滚动窗口：`rateWindowMs / rateMaxInWindow` 默认 **30 分钟最多 20 次**，超了长休 60–180 s，小间隙洗不掉；
  - 触发这整套的是一场真实事故：22:31→22:53 共 **49 次请求、间隔 8–12 秒**，长休一次没触发 → 会话吊销。
- `@wlv-zedd/dsh-chatgpt-web` 的 `retry-policy.ts`：重试预算活在 adapter 外面（TTL 30 分钟、`MAX_CHATGPT_WEB_TURN_RETRIES=3`），因为 HTTP bridge 每个请求新建 adapter，预算放在里面等于没有。

**我们的现状**

`docs/RISK-CONTROL.md` §3.2 的 R3 只修了一半：0.4.0 把重试改成了指数退避 `60s → 120s → 240s → 300s`（带 ±15% 抖动），这部分**已超过 login 的默认值**。但缺两样：

- **没有回合间隔**：`sendPauseMinMs/MaxMs` 只作用在「填字完成 → 回车」之间（`src/playwright-channel.ts:1553`），上一轮结束到下一轮开始之间是 0 间隔。
- **没有账号级熔断**：`src/` 里 `accountCooldown` / `pausedUntil` / `bannedUntil` 全部 0 命中。A 会话撞了频控，B 会话照打不误。

**怎么落地**（约 1 天）

```
src/cooldown.ts        → 账号级 pausedUntil（跨会话共享，落在 storage-domain）
turn 入口              → 距上次 turn 结束 < minRequestIntervalMs 时随机 sleep
                         （默认 2000–4000 ms，从「上一次调用结束」起算，不是从开始）
```

两个数值别照抄 login 的 15 次 / 30 分钟 20 次——那是它自己账号的实测。我们的 `longRunAfterSends` 默认 15、长休 30–60 s 是 0.5.0 刚定的，先用现成的，只补「回合间隔」和「账号级共享」这两个结构缺口。

---

### P0-④ 主动探活：只读接口、零额度、定期跑

**竞品怎么做**

- `dsh-deepseek-web-login`：`probeIntervalMs` 默认 30 分钟，启动后 20 秒先探一次，只读 `users/current`，零额度。关键补充：**受限状态（`user is muted`）只能从「生成请求被拒」里学到**，只读接口仍返回 200——所以探活不能替代发送时的错误识别。
- `dsh-deepseek-monitor`：余额 chip 每 60 s 轮询宿主缓存，面板按设置间隔（≥60 s）轮询，**只有宿主侧定时器请求上游**（不是每个页面实例各发一份）。

**我们的现状**

`looksLoginWall()`（`src/browser-shared.ts:481`）是被动判定，只在发送那一刻用。装完插件、打开设置页，用户看不到任何「登录态还在不在」的信息。

**怎么落地**（约 1 天）

```
设置页「网页连接」组顶部 → 状态行：「登录态：有效 · 3 分钟前检测」
                          + 「立即检测」按钮
触发时机                  → 插件加载后 20 s 一次；之后每 30 分钟
实现                      → 复用现有 looksLoginWall() + 读账号菜单昵称
失败语义                  → 探活失败只降级显示，绝不阻断发送（断网也会探活失败）
```

---

### P1-⑤ 工具目录要有预算，超预算要**点名**被省略的工具

**竞品怎么做**

- `dsh-deepseek-web-login`：工具定义按 5.6 万字符预算整段下发，**超预算时列出被省略的工具名**，并要求模型「不要猜参数」。它点名的历史事故是 0.1.33 之前只有 2.4 万字符预算，61 个工具被静默砍掉 26 个。
- `dsh-browser-playwright-codex`：`browser_evaluate` / `browser_cdp` **根本不注册**（不是注册了再返回 disabled），理由是它们的 schema 常驻系统提示、纯提示成本；`npm run cost` 量测实时工具面——表里写得很清楚：16 个工具 11 179 字符 ≈ 3 105 token/轮，全开 21 个 15 782 字符 ≈ 4 384 token/轮。
- `dsh-tool-search`：四级渐进披露，预算 = `min(thresholdPct% × contextWindow, listingMaxTokens)`，每轮重算。

**我们的现状**

`buildToolCatalog()`（`src/protocol.ts:109-112`）就是一句 `tools.map(...).join('\n')`——**没有任何预算**，也没有省略提示。`compactToolCatalog` 只控制单个工具的详略（首句 + 必填参数），不控制总量。

**怎么落地**（约半天）

```ts
// config.ts 新增
maxToolCatalogChars: number   // 默认 56_000，对齐 login 的实测值
```

超预算时按工具顺序保留，尾部删掉的部分换成一行：

```
[另有 12 个工具未列出：browser_click、browser_type、…（共 12 个）
 需要它们时请先说明要做什么，不要凭空猜参数名。]
```

---

### P1-⑥ 台账：只记元信息，指标要能看出「机器密度」

**竞品怎么做**

`dsh-deepseek-web-login` 的 `~/.dsh/web-login/gate.json`：按天记近 7 天，**只留元信息、无对话内容与凭证**。两个指标：

- 相邻对话间隔的 **中位数 / p90 / 最短**——「最短」直接对应有没有连环请求，中位数看不出问题；
- 失败分类：限流 / 账号被限制 / 登录态 / 网络。

只统计 `purpose === 'chat'`，排除 session-title 这类旁路。UI 是一张台账卡。

**我们的现状**

我们**已经有 token 台账的雏形**，但只记了一件事：

- `src/adapter.ts:413` 的 `accountUsage()` 按轮算增量，`src/session-state.ts:148` 的 `addChannelTokens()` 跨会话累计，写进 session-state 文件的 `__channel_totals__` 键（`session-state.ts:129`）——**已经落盘了**；
- 输出只有一行 `console.info`（`src/adapter.ts:968` 与 `src/index.ts:107`），设置页看不到。

缺的是 login 那张表的另一半：**回合间隔分布**（中位 / p90 / 最短）与**失败分类**。这两样才是「最近老是被限流」这类问题的判据——token 总量回答不了「我是不是发得太密」。

**怎么落地**（约 1 天）

```
~/.dsh/deepseek-web/ledger.json
{ "days": { "2026-10-22": { "turns": 47, "gapsMs": { "median": 41000, "p90": 190000, "min": 3100 },
                            "failures": { "rate_limited": 2, "login": 0, "network": 1 } } } }
```

保留 7 天，按天滚动删除。设置页「防风控」组底部一张卡。**`min` 是这张卡唯一真正有用的数字**：只要它掉到 3 秒以下，就说明有东西在抢跑。

---

### P1-⑦ 失效账号在发请求**之前**就拦下

**竞品怎么做**

`dsh-deepseek-web-login`：已被判失效的账号，发请求前先拦。**只认授权类失败**——`Authorization Failed`、`invalid token`、`401/403`、中文「登录态已失效」；断网、超时、5xx、429 一律放行。理由写得很直白：网络抖动不该把健康账号锁死。

配套的账号库能力：多账号并存 / 一键切换 / 分组（组只影响显示，删组不删号）/ 导出导入 / 「校验全部」只读探活。cookie 过期构成记成「5 项 · 1 会话级 · 4 持久级 · smidV2 还剩 399 天」，但明说这不是登录态寿命——真正鉴权靠 token，只发 cookie 会被拒 `40002 Missing Token`。

**我们的现状**

单账号，`looksLoginWall()` 在发送时才判。这一条**不必抄账号库**（多账号对我们是负收益，见 §3），但「失效先拦 + 只认授权类失败」这个判据值得抄进 `looksLoginWall()` 的调用点：现在登录墙判定混在发送流程里，错误会以 `WEB_SEND_NOT_TRIGGERED` 的形式出现，指向性不够。

---

### P1-⑧ 会话复用与「链式投喂」的判据纯函数化

**竞品怎么做**

`dsh-deepseek-web-login` 的 `contextMode`：`full`（默认，每轮全量重发，`parent_message_id=null`）vs `chained`（只发增量 + parent 指向上一条回答）。chained 有 5 种强制回退全量的判据：新会话 / 换号、固定头（系统提示 + 工具目录）变了、历史非严格追加（压缩 / 改写 / 回退）、增量为空或超预算、上一轮失败 / 取消 / 没拿到 `message_id`。

**关键不是 chained 本身，是「判定写成纯函数 + 单独测试」**：`src/context-feed.ts` + `tests/check-context-feed.mjs` + `tests/check-context-chain.mjs`。五种回退条件每一条都能单测。

**我们的现状**

每轮全量回放（`maxReplayChars` 400 000 兜底）。这条对我们是**短期不抄**：chained 依赖拿到网页端的 `message_id`，而我们走的是 DOM 自动化，拿不到稳定 id；硬做会引入「父消息挂错」这种比慢更糟的故障。

**值得抄的是形式**：我们 `protocol.ts` 里 `renderNewWebMessages` / 回放预算 / 协议刷新这三段的分支条件现在是混在 700 行文件里的，抽成 `src/context-feed.ts` 形态的纯函数，才能像 `tools/compaction-check.ts` 那样逐条断言。

---

### P1-⑨ 长任务检查点：marker 必须是纯字母数字

**竞品怎么做**

`@wlv-zedd/dsh-chatgpt-web` 的 `rolling-checkpoint.ts`：marker 是 `CODEXLUNAPRIVATECHECKPOINTV1A7F3C9D2`——**纯字母数字**，注释写明原因：「ChatGPT 的 DOM→Markdown 序列化器会转义 `_` `*` 和方括号」。zod discriminatedUnion 分 v1（结构化五段）/ v2（纯文本 ≤24 000），最多存 512 条、TTL 30 天。

**我们的现状**

已有「压缩后检查点 + 近期消息」的接续机制（README 有写）。但我们的检查点标记用的是普通文本标记，**网页端富文本渲染同样会改写字符**——这是同一类坑，只是我们还没踩到。

**怎么落地**（约半天）

把检查点 marker 改成纯字母数字常量 + 版本号，并在 `tools/handoff-check.ts` 里加一条断言：marker 必须匹配 `/^[A-Z0-9]+$/`。

---

### P1-⑩ 页面改版要「快速失败」，不要退化成超时

**竞品怎么做**

`dsh-browser-playwright-codex`：refs 带**每次快照的 nonce**，客户端重渲染后旧 ref 匹配不到任何元素，`browser_click` 直接报 `REF_NOT_FOUND`，而不是静默点到别的元素。另一条：`browser_snapshot` 撞上 JS 导航时，等新文档并重试，而不是把 `Execution context was destroyed` 原样抛给模型。

**我们的现状**

页面改版的典型表现是「元素找不到 → 等到超时 → 报 `WEB_TURN_TIMEOUT`」，用户看到的是「超时」，实际是「选择器失效」。这是本项目最容易误诊的一类故障（CHANGELOG 里 `WEB-SEND-NO-RESPONSE-ROOTCAUSE.md` 就是在拆这类糊涂账）。

**怎么落地**（约 1 天）

给关键选择器（输入框、发送按钮、消息气泡、新对话按钮）加一个「页面指纹」预检：进回合前一次性取齐 4 个锚点，缺任何一个立刻抛 `WEB_PAGE_LAYOUT_CHANGED`，并在 `describeFailure()` 里写「网页可能改版了，请把这一条反馈给作者：缺 <锚点名>」。

---

### P2-⑪ 设置页：常驻反馈条 + 编辑基线核对 + 降级说明

三个竞品各有一招，都能直接补到设置页（0.6.0 已扩到十二组）：

| 做法 | 出处 | 我们的现状 | 补法 |
|---|---|---|---|
| 操作反馈条常驻在标签栏之上，切页仍可见 | `dsh-deepseek-web-login`（7 标签） | 有草稿态/Ctrl+S/「重启生效」标识，但反馈是局部的 | 反馈条提到分组容器外层 |
| 保存前核对编辑基线，拒绝覆盖另一页面已改的字段 | `@arcaneorion/dsh-model-channel-manager` | 无并发编辑检测 | 保存时带 `revision`，不一致就提示「另一个窗口改过，请刷新后重试」 |
| 存储缺失时降级「内存模式」并在界面说明 | 同上 | `options()` 已保留 last good configuration 并打日志 | 在设置页把这句日志变成可见提示 |

---

### P2-⑫ 发布工程：我们现在几乎没做

这一条不是「学某个功能」，是**竞品的默认水位线**：

| 项 | 竞品水位 | 我们 |
|---|---|---|
| `engines.dsh`（市场兼容门禁用） | 815 / 3298 条声明了；同赛道 `@wlv-zedd/dsh-chatgpt-web` 声明 `>=0.2.0-rc.2` | **未声明**（只有 `engines.node >=22`） |
| `keywords` | 多数有 `dsh, dsh-plugin, deepseek-harness, llm-provider` | **缺** |
| `disclosure`（机器可读隐私声明） | `dsh-deepseek-web-free` 与 `dsh-web-fetch-playwright` 有完整结构 | **缺** |
| 双语 README | login / chatgpt-web / vision / dshmarket 都有 | 只有中文 |
| CI | chatgpt-web（校验干净安装 + 运行时冒烟 + 无构建路径污染）、vision（111 测试 97% 覆盖）、login（30+ 脚本 111 断言） | **无 `.github/workflows`**，只有 `FUNDING.yml` |
| 进入市场索引 | 竞品基本都在 | **不在 3298 条索引里** |
| 进入精选列表 | `awesome-dsh-plugin`（README 自称 94 个插件，实际列 101 条），`dshmarket` 的目录只从这里取 | **不在** |
| 版本号一致 | — | `package.json` **0.5.0** / npm `latest` **0.2.14**（2026-10-13 发布）/ README 写 **0.2.14**（5 处，含 3 处下载链接） ← **本地与已发布差 4 个小版本** |

`disclosure` 的结构可以直接照抄（`dsh-deepseek-web-free`）：

```json
{
  "cloud": true,
  "network": ["https://chat.deepseek.com"],
  "offlineMode": false,
  "apiKeys": [],
  "permissions": {
    "network": ["chat.deepseek.com"],
    "filesystem": ["plugin-isolated-browser-profile"],
    "env": []
  },
  "jurisdiction": ["PIPL(CN)"],
  "retention": "session"
}
```

> 注：我在宿主 `app.asar` 里 grep `disclosure` 只命中 CSS/DataGrid 的 `disclosure` 列名，**没有找到宿主读取这个字段的代码**——所以它是「社区约定」而非「宿主强制」，价值在于市场页面展示与人工审核，别指望宿主替你校验。

---

### P2-⑬ 分发技巧：给 agent 的「安装提示词」

`@iasiv5/dsh-skip-browser-auth` 在 README 里放了一段「复制给 agent 的安装提示词」，用户直接粘给 agent，agent 自己跑 `dsh plugin add` + 重启 + 验证日志。同作者还维护自己的小市场 `dsh-m` 并给出收录 id。

这条对我们特别合适：我们的安装步骤（装插件 → 重启 → 配 `sendMode` → 登录 Edge → 跑一次真机脚本）比一般插件长，一段可复制的 prompt 能显著降低首次成功率。配合 P0-① 的 `tools/doctor.mjs`，整套是闭环的。

---

## 3. 明确**不抄**的（含竞品自己踩坑的结论）

| 不抄 | 出处与理由 |
|---|---|
| 账号池默认开启 | login 自己写「这条和你直觉相反」——默认别用。多账号会把「一个账号被限流」变成「一排账号被限流」，且分组/切换/导入导出的 UI 成本极高 |
| 在 Node 里解 PoW | login：Node 侧 `WebAssembly.instantiate` 被公开列为**封号触发条件**，0.7.0 起强制在真实页面里解，找不到 Edge/Chrome 直接报错、不静默回退 |
| 用 Node/undici 直接发请求 | login 实测 TLS 指纹三方差异：Node `t13d5212h1_…` / Chrome `t13d1517h2_8daaf6152771_cb7bf5808d99` / Electron `t13d1516h2_…`。**Node 在 TLS 层就能被判定非浏览器，调参修不了**。我们「真实浏览器 + 真实网络栈」的路线是对的，别在这个方向上「优化」 |
| 每轮建会话、用完立刻删 | login：这是最强机器特征之一。它自己改成「攒 6~10 个或等 60~120 s 再删」。我们复用工作标签页本来就避开了 |
| 把高危工具打包成默认开启 | `dsh-browser-playwright-codex`：`cordis.patch.yml` 随包分发，里面开什么就是给所有安装者开什么——「A package that shipped them on would be handing every installer a backdoor they never asked for」 |
| 静默截断 | login 的工具目录事故（61 个砍 26 个无声）、free fork 的 SSE `type:"error"` 被当成功（毒化历史，下一轮 invalid message id）。**任何裁剪都要留可见的省略说明** |
| 精确版本钉 peerDeps | free fork：精确钉版会被 DSH 插件兼容性门禁**静默拒绝装载且零日志**。用范围（`>=0.2.0-rc.1`） |
| 硬编码默认模型 | `dsh-plugin-chatgpt`：账号权益不同，硬编码默认会静默错 |
| 把「看起来成功」当成功 | `dsh-plugin-chatgpt`：`response.completed` 是唯一成功终态，没有它的流一律报错——「截断但读起来像完成」比可见失败更糟 |

---

## 4. 现状对照（调研当时的缺口 vs 现在的代码）

调研当时（2026-10-22 上午）`docs/RISK-CONTROL.md` §3.2 列了 R1–R5，但那份文档写在 0.4.0 之前，**行号引用也全部漂移**。本节保留当时的核对记录，并补上 0.6.0 落地后的状态。

### 4.1 当时发现的行号漂移（已在 0.6.0 修好文档）

| 文档写的 | 当时那一行实际是 | 真正的位置 |
|---|---|---|
| `src/config.ts:279`（`maxConcurrentTurns`） | `*/`（注释末尾） | `src/config.ts` 的 `maxConcurrentTurns` |
| `src/config.ts:295`（`maxToolResultChars`） | 「任务锚点最大字符数…」注释 | `src/config.ts` 的 `maxToolResultChars` |
| `src/adapter.ts:381`（锁键） | `buildHandoffBrief(...)` | `src/adapter.ts:429` |
| `src/playwright-channel.ts:658-706`（固定重试） | 新对话确认与**提示节流**函数 | 重试循环在 `turnOnPage` 的 `for` 循环 |
| `src/adapter.ts:464-473`（失败回放） | 并发名额池获取与排队日志 | 回放构建在 `src/protocol.ts:201`（`buildRecoveryPrompt`），预算裁剪在 `src/protocol.ts:667-720` |

### 4.2 R1–R5 的当前状态

| 编号 | 调研当时的结论 | 0.6.0 现状 | 判断 |
|---|---|---|---|
| R1 同账号两条生成同时飞 | 【高】默认 `maxConcurrentTurns=2` | 默认已改 **1**（多会话仍各占标签页，但同一时刻只有一条在真打网页） | ✅ 已修复 |
| R2 辅助请求真并行 | 【高】`${sessionId}::${purpose}` 锁键 | 锁键未改（`src/adapter.ts:429`） | ⬜ 仍成立 |
| R3 无主动节流 + 固定重试 | 【中】固定 30s×5 | 指数退避 + 抖动（0.4.0）；账号级冷却 + 30 分钟重试预算 + 失败四分类 + 回合间隔 2–4 秒随机（0.6.0） | ✅ 已修复 |
| R4 无上下文体量阀门 | 【中】只有 `maxToolResultChars` | `maxReplayChars=400_000`（0.5.0）+ `maxToolCatalogChars=28_000`（0.6.0） | ✅ 已修复 |
| R5 无验证码/挑战路径 | 【低】grep 零命中 | 仍 0 命中；0.6.0 的 `WEB_UI_CHANGED` 只覆盖选择器失效 | ⬜ 仍成立 |

**这条教训值得留在仓库里：文档比代码旧，比没有文档更危险。** 0.6.0 已把 `docs/RISK-CONTROL.md` §3 与 §5 全量重写为「当前状态 + 状态列」，并去掉所有会漂移的行号锚点。

配套值得抄 `dsh-browser-playwright-codex` 的纪律：**每条规则在测试里钉住**——它 README 自述 `tests/tool-descriptions.test.ts` 把每条规则/示例/理由都钉住，「删掉一条就构建失败」（该包的 `files` 白名单不含 `tests/`，所以这一条是白纸黑字的自述，不是我在 tarball 里读到的）。我们 `tools/` 下现在有 35 个 `*-check.ts|mjs`，`npm run test:parsers` 全部串上（0.6.0 补齐了 `ack-clock-check` 等漏项并新增 7 个），钉住了协议解析、压缩、浏览器自愈这些**已发生的故障**，缺的是把 RISK-CONTROL.md 的 R1–R5 也变成 `risk-config-check.ts` 里的断言——现在这些风险是散文，不是测试。

---

## 5. 落地顺序与实际完成情况

| 冲刺 | 内容 | 状态 |
|---|---|---|
| **S1** | doctor 自检 + 错误码语义化 + 账号级冷却 + 回合间隔 | ✅ 已完成（0.6.0）：`src/doctor.ts` + `tools/doctor.ts`、`src/cooldown.ts`、`src/retry-policy.ts`、`src/pacing.ts`；`maxConcurrentTurns` 默认改 1 |
| **S2** | 登录探活 + 工具目录预算 + 调用台账 | ✅ 已完成（0.6.0）：`src/login-probe.ts`、`buildToolCatalogDetailed`、`src/ledger.ts` + `src/ledger-route.ts` + 设置页只读卡片 |
| **S3** | 发布工程（版本对齐、`engines.dsh`、keywords、disclosure、CI） | ✅ 已完成（0.6.0）：`package.json` 补全四个字段、`.github/workflows/ci.yml`、README/INSTALL/RELEASING/CHANGELOG 版本统一 |
| **S3 后半** | 提交 awesome-dsh-plugin 收录 | ⬜ 待人工操作：需要到 `awesome-dsh-plugin` 仓库开 PR，加一条 list entry |
| 持续 | 检查点 marker、页面指纹预检、设置页细节 | ✅ 部分：`WEB_UI_CHANGED` + 纯字母数字标记已做；CAPTCHA 识别仍开放 |

**关于「先发布」这件事**：调研时 `package.json` 是 0.5.0、npm 上是 0.2.14（发布于 2026-10-13），中间 0.3.x–0.5.x 一整段改进市场上一份都没有。0.6.0 已把源码版本、README / INSTALL / RELEASING 引用、`package-lock.json` 根版本全部对齐；**npm 发布与 GitHub Release 仍需人工执行**，步骤见 `RELEASING.md`。

---

## 6. 证据与边界

**已核实（读源码或跑命令）**

- 本项目：`src/config.ts` / `src/protocol.ts` / `src/adapter.ts` / `src/playwright-channel.ts` / `src/browser-shared.ts` 的行号引用均已逐条重读核对（`RISK-CONTROL.md` 里漂移的行号已在 §4 标出）；`package.json` 版本 0.5.0；`npm view` 得 0.2.14；`src/` 内 `doctor` / `accountCooldown` / `pausedUntil` / `bannedUntil` / `rateWindow` / `circuitBreaker` / `ledger` / `probeInterval` / `captcha|人机|滑块|验证码|cloudflare|waf|challenge` 均 0 命中；本包不在市场索引缓存的 3298 条内；不在 `awesome-dsh-plugin` 清单内。
- 竞品：全部 19 个包已解包在 `.tmp-market-research/`；`@wlv-zedd/dsh-chatgpt-web` 的 `doctor.ts`、`errors.ts`、`retry-policy.ts` 读过原文；`dsh-deepseek-web-login` 的 `context-feed.ts` 回退判据与其测试文件读过；`dsh-deepseek-web-free` 与 `dsh-web-fetch-playwright` 的 `disclosure` 读的是 `package.json` 原文。

**未核实（竞品自述，未复跑）**

- 所有「实测」数字（TLS 指纹值、49 次请求、6 分钟封禁、5.6 万字符预算、11 179 字符 schema）来自竞品 README / CHANGELOG，**我没有在真实账号上复现**。引用时请保留「竞品自述」这个前缀。
- 下载量是 npm `last-month` 单次采样，不是稳定排名。

**渠道限制**

- `awesome-dsh-plugin.com/plugins.json` 在本机网络下连不上（`curl` 退出码 28：连接超时 21.8 s，`Invoke-WebRequest` 25 s 超时，`web_fetch` 30 s 超时，三次均失败）。改读该项目的 npm 包 `awesome-dsh-plugin@0.1.0`（2026-08-13 发布，npm 上只有这一个版本，包内只有 `package.json` + `README.md` + `README.zh.md`）里的两个 README。**清单可能落后于站点两个月**，所以「不在精选列表」这个结论只对 2026-08-13 的快照成立。
- `dshmarket` README 自称目录 4200+ 插件、`awesome-dsh-plugin` README 自称 94 个插件但实际列了 101 条链接——两个数字都对不上，说明这些计数是人工维护、会漂移的。引用时以条数为准并注明来源日期。
- 宿主 `app.asar` 只能全文 grep，无法按目录遍历（`resources/app.asar` 是单文件），所以「宿主是否读取 `disclosure`」的结论只到「grep 未见读取代码」这一层。
