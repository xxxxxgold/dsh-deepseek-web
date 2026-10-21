# 频控全链路：当网页说「消息发送过于频繁，请稍后重试」

> 适用版本：`dsh-deepseek-web-littlecar30` 0.3.2（工作树 `D:/dsh/ds-web`）+ DSH 桌面端 `app.asar` 现装版本。
> 文中行号：插件侧指 `src/*.ts`（工作树），宿主侧指 `app.asar/dsh/node_modules/@deepseek-ai/*`（下称 `$H`）。
> 证据分两类：**代码路径**（可复现阅读）与**实测证据**（本机会话落盘、可用命令复跑）。未实测的部分在末尾单列。

---

## 0. 一句话答案

DSH 收到的是一个**普通模型调用失败**：`LlmError`，`message` 是插件写的中文句子，`code` 是 `WEB_RATE_LIMITED`，`status`/`providerRetryAfterMs` 都不存在。

宿主不认识这个 code，**不重试、不兜底、不改写**，原样写进 `turn/end` 事件的 `reason.error`，通过 WebSocket 推给网页端。

网页端（DSH Web GUI）渲染成消息流末尾的一行错误：**红点 + 「本轮运行失败」+ 插件那句中文原文 + 右侧灰色标签 `WEB_RATE_LIMITED`**，**没有重试按钮**；会话立刻回到空闲，可以直接再发。

「重试」这件事完全发生在插件内部，而且发生在**宿主看到错误之前**：插件自己在浏览器里按指数退避重发同一条（默认 60s → 120s → 240s → 300s，最多 4 次，合计约 12 分钟），用尽才抛错。等待期间对话里会有一条 `[DSH] 频控等待 · 剩余 Xs` 的提示块，浏览器右下角同时显示倒计时浮层。

---

## 1. 这句话是谁说的、在哪一层出现

它不是一个错误码，是 **DeepSeek 网页前端页面的提示文案**，出现在 `chat.deepseek.com` 页面自己的 DOM 里。触发条件至少有三类：

| 来源 | 形态 | 插件怎么认 |
| --- | --- | --- |
| 网页 toast | 页面上的浮层文本「消息发送过于频繁，请稍后重试」 | 每 800ms 扫一次页面 DOM，命中正则即判频控 |
| 服务端拒绝 | HTTP 429，或 200 + 业务错误体 | 检查响应 `status === 429` 或响应体前 2000 字含关键词 |
| 请求被前端吞掉 | 回车后页面既不报错也不发请求 | 180 秒等不到响应，收尾前再扫一次 toast |

识别正则（`src/browser-shared.ts:32`，工作树未改动）：

```
/过于频繁|太频繁|发送太快|发送太快了|请.{0,4}稍后.{0,4}(重试|再试)|稍后再试|操作频繁|请求过于|too\s+(many|frequent)|rate[._\s-]?limit(?:ed)?|try\s+again\s+(later|soon)/i
```

`looksLikeRateLimitText` 只做 `.test`（`src/browser-shared.ts:35-37`），**不区分这条文本是错误提示还是正常对话内容**。

页面扫描的取词范围（`src/browser-shared.ts:45-63`）：只取 `div/span/p/section/aside`，排除输入框区域，跳过不可见元素、超过 120 字的元素、子元素超过 2 个的容器。

---

## 2. 插件侧：识别 → 等待 → 重发 → 用尽抛错

主循环在 `src/playwright-channel.ts:863-925`（`turnOnPage`）：

```ts
const rateLimit = this.options.config.rateLimit
const maxRetries = rateLimit?.enabled === false ? 0 : rateLimit?.maxRetries ?? 4
let waitedMs = 0
for (let attempt = 0; ; attempt++) {
  const outcome = await this.sendAndWait(page, request)
  if (outcome.kind === 'completed') { /* 解析正文，正常返回 */ }
  if (attempt >= maxRetries) {
    throw new LlmError(
      `deepseek-web: 网页提示发送过于频繁，已自动重发 ${maxRetries} 次仍未成功`
      + `（累计等待 ${formatDuration(waitedMs)}）。请稍后在网页端手动发送，或稍后重试本任务。`,
      'WEB_RATE_LIMITED',
    )
  }
  const waitMs = rateLimitDelayMs(rateLimit, attempt) // fixed 或 exponential，带抖动与封顶
  waitedMs += waitMs
  this.emitNotice(request, 'wait', `网页提示发送过于频繁，${formatDuration(waitMs)} 后自动重发（第 ${attempt + 1}/${maxRetries} 次）`)
  await this.markPageStatus(page, `[dsh 频控：${formatDuration(waitMs)} 后自动重发]`)
  await this.waitWithCountdown(page, request, waitMs, attempt + 1, maxRetries)
  this.emitNotice(request, 'retry', `正在第 ${attempt + 1}/${maxRetries} 次重发同一条消息`)
}
```

要点：

1. **重发是整条重来**，不是重按发送：`sendAndWait` 每次都会重新聚焦输入框 → `Ctrl+A` → `Backspace` → 清附件 → `attachAttachments` → `insertText` → 随机停 2–4 秒 → 回车（`src/playwright-channel.ts:1137-1157`）。
2. **等待可中断**：`waitWithCountdown` 底层是 `this.sleep`，每 200ms 检查 `signal`，用户点停止会抛 `WEB_TURN_ABORTED`（文案「等待频控重发期间回合被取消」）。
3. **等待期间用户看得见**：进入等待时先报一次「X 后自动重发」，之后每逢整分钟和最后 30 秒各刷一次「还需要 X」——逐秒刷会把 12 分钟变成几百行噪音；网页右下角则逐秒更新倒计时浮层（`#dsh-web-notice`，`pointer-events: none`，不挡点击）。提示走独立的 `onNotice` 通道，不受 `liveThinking` 影响——`liveThinking: false`（本机默认）时 `onProgress` 从不触发，靠它发提示会全部丢失。
4. **提示落成 DSH 里的什么**：一条 reasoning 块，前缀 `[DSH]`（审核流程是 `[DSH·审核]`），在对话里可折叠、不占正文、不会进入模型上下文，也不会污染交付内容。

### 2.1 判定发生在哪三种时刻（`sendAndWait`，:1040-1201）

| 时刻 | 代码位置 | 判据 |
| --- | --- | --- |
| 发送后每 800ms | :1130-1134 | 页面出现命中正则的 toast → 立刻 `rate-limited` |
| 收到响应 | :1174-1176 | `status === 429`，或 `body.slice(0, 2000)` 命中正则 |
| 响应超时（180s） | :1187 | catch 里再查一次 toast，命中就转 `rate-limited` |

超时值：`Math.min(streamIdleTimeoutMs, SEND_ACK_TIMEOUT_MS)`，`SEND_ACK_TIMEOUT_MS = 180_000`（`src/playwright-channel.ts:63`）。所以无论 `streamIdleTimeoutMs` 配多大，单次等待最多 180 秒。

### 2.2 半自动发送（本机现状 `sendMode: manual`）

`autoSend` 由三处决定（`src/playwright-channel.ts:1050-1052`）：

```ts
const autoSend = request.autoSend
  ?? this.autoSendSessions.get(request.sessionId)
  ?? this.options.config.sendMode === 'approved'
```

本机 `cordis.yml:1581` 是 `sendMode: manual`，`autoSendSessions` 里没有该会话记录，所以 `autoSend === false`：**每一轮（包括每次频控重发）都只是把消息填进去、把浏览器窗口置顶、然后等你按回车**，等不到的 180 秒后按 `WEB_MANUAL_SEND_TIMEOUT` 收场。

也就是说，本机配置下「自动重发最多 4 次」实际是「插件等你按 4 次发送」。

---

## 3. 时间账：默认参数下到底会经历什么

默认值（`src/config.ts:359-366`）：`enabled: true`、`retryDelayMs: 60_000`、`maxRetries: 4`、`backoff: exponential`、`retryMaxDelayMs: 300_000`、`jitterRatio: 0.15`。本机未配 `rateLimit` 段，全部走默认，退避序列为 60s → 120s → 240s → 300s。

| 路径 | 每次耗时 | 总时长 | 最终 code | 界面文案 |
| --- | --- | --- | --- | --- |
| A：每次秒回 toast / 429 | 判定 ~0.8s + 退避等待 + 填字 2–4s | 60+120+240+300 + 约 16s ≈ **12.3 分钟** | `WEB_RATE_LIMITED` | 「已自动重发 4 次仍未成功（累计等待 12m）…」 |
| B：每次等满 180s，收尾时 toast 命中 | 180s + 退避等待 | 第 3 轮等待中撞上 900s 上限 → **约 15 分钟** | `WEB_TURN_TIMEOUT` | 「本次网页回合超过单回合上限（900s）…」 |
| C：每次等满 180s，收尾无 toast | 180s | **第 1 轮就结束**（不重发） | `WEB_AUTO_SEND_TIMEOUT` / `WEB_MANUAL_SEND_TIMEOUT` | 「未收到网页响应 / 等待你点击发送超时」 |
| D（本机 manual）：每次都要人点发送 | 人工时间 + 退避等待 | 人工时间 × 5 + 720s | `WEB_RATE_LIMITED` 或 `WEB_MANUAL_SEND_TIMEOUT` | 同上 |

路径 B 被截断的原因：`turn()` 外层还有一个 `turnTimeoutMs = 900_000` 的定时器（`src/config.ts:352`，`src/playwright-channel.ts:640-695`），到点 `abort`，catch 里 `timedOut` 优先，直接抛 `WEB_TURN_TIMEOUT`，不给第 4 次机会。默认值把「等待总和 720s」压在 900s 以内，就是为了走 A 路径时完整退避能跑完。

对照实测恢复时长（`docs/RISK-CONTROL.md:37-38`）：一般频控几十秒到 5 分钟，多数 **10–15 分钟**，高峰 15–60 分钟。旧默认 `30s × 5 = 150s` 明显短于常见冷却期，等于在冷却期里又硬撞 5 次；现在的 720s 覆盖到了中段。

---

## 4. DSH 收到了什么（宿主侧的精确对象）

### 4.1 抛出的异常对象

插件用两个参数构造（`src/playwright-channel.ts:898-905`）：

```ts
new LlmError('deepseek-web: 网页提示发送过于频繁，已自动重发 4 次仍未成功（累计等待 12m 16s）。请稍后在网页端手动发送，或稍后重试本任务。', 'WEB_RATE_LIMITED')
```

宿主 `LlmError` 的构造（`$H/dsh-llm/lib/index.js:1615-1640`，同 `lib/types/index.js:66-102`）：

```js
this.failure = Object.freeze({
  message, code,
  ...options?.status === undefined ? {} : { status: options.status },
  ...options?.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
  ...options?.requestId === undefined ? {} : { requestId: options.requestId },
  ...options?.offloadImages === undefined ? {} : { offloadImages: options.offloadImages },
});
```

插件只传了前两个参数，所以 DSH 实际拿到：

```json
{
  "name": "LlmError",
  "message": "deepseek-web: 网页提示发送过于频繁，已自动重发 4 次仍未成功（累计等待 12m 16s）。请稍后在网页端手动发送，或稍后重试本任务。",
  "code": "WEB_RATE_LIMITED",
  "failure": { "message": "deepseek-web: 网页提示发送过于频繁，已自动重发 4 次仍未成功（累计等待 12m 16s）。请稍后在网页端手动发送，或稍后重试本任务。", "code": "WEB_RATE_LIMITED" }
}
```

**没有 `status: 429`，没有 `providerRetryAfterMs`，没有 `requestId`** —— 插件没有把这些从浏览器响应转交上来。这意味着即便宿主有退避能力，也拿不到服务端的 Retry-After。

### 4.2 错误怎么落盘、怎么变成事件

插件抛错发生在「流迭代」里，走的不是正常结束路径（`$H/dsh-agent-loop/lib/index.js:1093-1126`）：

```js
} catch (error) {
  if (!started) throw error;
  try {
    if (signal.aborted) { /* 只有取消才写 interrupted 的 assistant/message */ }
    else live.settle("assistant/attempt", () => this.session.append("assistant/attempt", {
      turn, step, stream: live.stream
    }).seq);
  } catch (settlementError) { ... }
  throw error;   // ← 直接抛，不经过 agent/request-error
}
```

然后在回合收尾处（`:1015-1032`）把错误塞进 `turn/end`：

```js
turnEnds = {
  kind: "error",
  error: error instanceof LlmError ? error.failure : { message: errorChain(error), code: "UNKNOWN" }
};
this.throwError(error);
...
this.session.append("turn/end", { turn, reason: turnEnds });
```

会话文件里看到的就是（结构照抄本机实测的另一条插件错误，字段完全同形）：

```json
{"type":"assistant/attempt","seq":24,"data":{"turn":1,"step":2,"stream":[{"type":"chunk","chunk":{"type":"finish","reason":{"kind":"error","failure":{"message":"deepseek-web: 网页提示发送过于频繁，已自动重发 4 次仍未成功（累计等待 12m 16s）。请稍后在网页端手动发送，或稍后重试本任务。","code":"WEB_RATE_LIMITED"}}}}]}}
{"type":"turn/end","seq":26,"data":{"turn":1,"reason":{"kind":"error","error":{"message":"deepseek-web: 网页提示发送过于频繁，已自动重发 4 次仍未成功（累计等待 12m 16s）。请稍后在网页端手动发送，或稍后重试本任务。","code":"WEB_RATE_LIMITED"}}}}
```

### 4.3 宿主为什么不自动重试

这是本链路最容易误解的一点，两层原因都成立：

1. **走错了扩展点**。宿主的模型请求重试挂在 `agent/request-error` 瀑布（`$H/dsh-agent-loop/lib/index.js:1130-1146`），**只有流正常结束且 `finish.kind === "error"` 时才会触发**。插件是直接 `throw`，从流迭代的 catch 里逃出去，这条瀑布根本不会跑 → 宿主重试 **0 次**。
2. **就算跑了也不会重试**。默认可重试码是 `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`（`$H/dsh-llm/lib/index.js:247-257`），精确匹配，`WEB_RATE_LIMITED` 不在里面；`dsh-llm-retry` 插件的判定是 `policy.retryableCodes.includes(failure.code)`，不命中就 `return next()`（`$H/dsh-llm-retry/lib/index.js`）。而插件 adapter 也没注册 `retryPolicy`（`src/adapter.ts:237` 只实现 `providerInfo`），`policy` 是 `undefined`，`recover()` 第一行 `if (policy === void 0) return next();` 直接放行。

旁证：全 `app.asar` 里 `WEB_RATE_LIMITED` 出现 **0 次**（`grep -a -o` 实测）。宿主对这个码零特判、零熔断、零冷却。

### 4.4 传输形态

会话事件不走 SSE，全部复用一条 WebSocket：`/api/remote.mux`（`$H/dsh-api-gateway/lib/index.js:133`），事件流逻辑名 `$events`（:135），帧结构 `{ event, args }`（:1446-1452）。

HTTP 侧只有一个 `/api/file` 注册路由（`$H/dsh-api-session-controller/lib/index.js:2482-2483`）；`/` 与 `/api` 未带 token 时实测返回 `401 Unauthorized`（`text/plain`）。所以「网页端返回什么」在协议层**没有 HTTP 错误码可看**，错误只存在于事件流里的 `turn/end`。

### 4.5 日志

DSH 不写 LLM 日志文件（`C:/Users/29060/.dsh/logs` 只有 memory hook 和灵枢的三个文件）。唯一持久记录是：

```
C:/Users/29060/.dsh/sessions/<workspace-key>/<sessionId>/session.v4.jsonl.zstd
```

注意是 **zstd 多帧**：每个事件一帧，一个 2MB 的文件里有一千多个魔数 `28 B5 2F FD`。`zlib.zstdDecompressSync` 整文件只解第一帧，要按魔数切分逐帧解。

---

## 5. 网页端（DSH Web GUI）显示什么

前端消费 `turn/end` 的方式在 `$H/dsh-client-ui-chat/lib/client.js:10516-10556`（`turnErrorDefinition`）：只有 `reason.kind === "error"` 才生成 `turn-error` 节点，字段 `{ seq, time, turn, step, message, code }`。

渲染在 `:5344-5370`（`TurnErrorItem`），三段：

| 位置 | 内容 | 来源 |
| --- | --- | --- |
| 左侧状态点 | 红色 `StateDot`，`state="error"` | :5347-5350 |
| 标题 | **「本轮运行失败」** | `message.turnError`，:5358；`ACCOUNT_SIGNED_OUT`/`INTERRUPTED` 才显示「任务已停止」 |
| 正文 | **插件那句中文原文**，一字不改 | `failureMessage(node.message, node.code, t)`，:5361 |
| 右侧灰色 code 标签 | **`WEB_RATE_LIMITED`** | :5364-5367，`code !== undefined && code !== "INTERRUPTED"` 就显示 |

`failureMessage` 只对五类码换文案：`ACCOUNT_SIGNED_OUT` / `INTERRUPTED` / `ACCOUNT_SIGN_IN_REQUIRED` / `QUOTA`·`ACCOUNT_QUOTA` / `AUTH`。`WEB_RATE_LIMITED` 不在其中，所以**原样透出**。`displayFailure` 也只对 `AUTH` 清空 message。

所以用户在网页端看到的完整一行是：

> ● 本轮运行失败　deepseek-web: 网页提示发送过于频繁，已自动重发 4 次仍未成功（累计等待 12m 16s）。请稍后在网页端手动发送，或稍后重试本任务。　`WEB_RATE_LIMITED`

其余行为：

- **没有重试按钮**。`TurnErrorItem` 是纯展示（`role="status"`），全前端带「重试」的交互只有上传重试和宿主自动重试的倒计时行（`message.retry.*`）。
- **半截正文不保留**。非取消失败只写 `assistant/attempt`，前端对 `assistant/attempt` 直接返回不可见（`:10645`），所以已流出的文字不会变成正式消息；只有用户手动取消才写 `assistant/message`（带 `interrupted: true`）。
- **该轮过程面板强制展开**（`:4159`，`reason === "error"` 时 `alwaysOpen`），失败前的工具调用/思考仍可查。
- **会话立刻回空闲**：`$H/dsh-api-session-controller/lib/index.js:2991-2993` 按 `agent.status === "running"` 广播状态，错误后回 idle；turn 在 `turn/end` 后 `status: "closed"`。输入框可用，可以直接发下一条。
- **重试期间不再是空界面**：0.3.4 起，频控等待与重发都会通过 `onNotice` 变成一条 reasoning 提示块（`[DSH] 频控等待 · …`、`[DSH] 重发 · …`），每 15 秒刷新剩余时间；网页右下角同时有倒计时浮层，标签标题也写着 `[dsh 频控：… 后自动重发]`。这三条都属于「过程展示」，不会进入正文、不会喂给模型、宿主那边也照旧只有一个 `turn/end` 错误。

---

## 6. 之后怎么操作

### 6.1 插件自己做了什么（自动）

1. 识别到频控 → 对话里出现一条 `[DSH] 频控等待 · 网页提示发送过于频繁，1m 后自动重发（第 1/4 次）`，标签标题改 `[dsh 频控：1m 后自动重发]`，网页右下角出现倒计时浮层；
2. 等 60 秒（可被停止打断）：浮层逐秒倒计时，提示块在整分钟与最后 30 秒报进度；
3. 提示切到 `[DSH] 重发 · 正在第 1/4 次重发同一条消息`，然后重新填字、回车、再等；
4. 等待按 60s → 120s → 240s → 300s 递增，最多 4 次；用尽抛 `WEB_RATE_LIMITED`（文案带累计等待时长）。

审核提示由适配层统一发（`[DSH·审核] 审核：开始检查本轮产出…` → `审核通过：…` / `审核失败，已跳过本轮审核：…`），Kimi/GLM 窗口内部的每一次发送与接收不重复播报，避免审核一轮刷出十几行噪音。

### 6.2 宿主做了什么（不动作）

不重试、不降级、不切换 provider、不熔断、不改文案。只把 `failure` 写进 `turn/end`，推给前端，然后回合结束。

### 6.3 用户该做什么

**当下**

1. **别连点**。再点一次发送等于立刻再撞一次，只会加深风控。
2. 打开浏览器（DeepSeek 那个窗口）**亲眼看一眼**：有没有 toast、页面是不是卡在「生成中」。标签标题会告诉你插件在干什么（`[dsh 频控：1m 后自动重发]` / `[dsh 等待你在网页点击发送]` / `[dsh 网页生成中]`），右下角还有倒计时浮层；对话里则是一条 `[DSH] 频控等待` 提示块。
3. 按 `docs/RISK-CONTROL.md` 的实测分布等：**先等 10–15 分钟**；高峰时段按 30–60 分钟算。
4. 恢复后先在网页端手发一条「1」验证；能回再回 DSH 继续。
5. 如果出现的是「操作过于频繁」并且账号被要求验证/封禁（历史上 22:31→22:53 连发 49 次的那次），只能停 24 小时，别换窗口硬试。

**调参（本机 `C:\Users\29060\.dsh\profiles\desktop\cordis.yml` 的 `llm-deepseek-web` 段）**

默认值已经按上面的方向改过（`src/config.ts:359-366`）：`retryDelayMs: 60_000`、`maxRetries: 4`、`backoff: exponential`、`retryMaxDelayMs: 300_000`、`jitterRatio: 0.15`，合计 60 + 120 + 240 + 300 = **720 秒（12 分钟）**，正好覆盖实测最常见的 10–15 分钟冷却，且总时长仍小于 `turnTimeoutMs` 的 900 秒——不用动回合上限。

需要微调时只改这几项：

```yaml
- id: llm-deepseek-web
  config:
    rateLimit:
      enabled: true
      retryDelayMs: 60000     # 首次等待，也是指数退避的基数
      maxRetries: 4           # 4 次重发 = 60+120+240+300 = 12 分钟
      backoff: exponential    # 想固定间隔就写 fixed
      retryMaxDelayMs: 300000 # 单次等待封顶
      jitterRatio: 0.15       # ±15% 抖动，多实例错开重撞
```

代价与边界：

- 一次真频控最坏要等 12 分钟才报错，但期间对话里有倒计时提示块（`[DSH] 频控等待 · 剩余 Xs`），网页右下角也有浮层，不会像以前那样干等且毫无提示；实测多数冷却会在中段恢复，第 2 到第 3 次重发就能成功。
- 若把 `maxRetries` 调大，注意「等待总和 + 每次发送耗时」要留在 `turnTimeoutMs`（900 秒）以内，否则会先撞 `WEB_TURN_TIMEOUT`，报错文案会误导成「回合超时」而不是频控。
- `sendMode: manual` 下每轮仍然要你按发送（见 2.2），此时提示块写的是「已填入输入框 N 字…，等待你在网页点击发送」。

**减少请求量（根因方向）**

- 关掉不需要的自动 LLM 请求：会话标题、压缩摘要都是额外请求（本机 `protocolEveryRequest: true` 下每次请求都带完整协议，token 更多、页面更重）。
- `longRunAfterSends: 15` + `longRunPause 60–180s` 已有，但可以降到 8。
- 一个账号只挂一个 DSH 实例（桌面端 + `dsh web` 同时跑会共享同一账号额度）。

### 6.4 浏览器被关掉时（另一条自愈路径）

频控的恢复是「等」，浏览器被关的恢复是「重启 + 重发」，两者都发生在 `turn()` 里但走两条不同的分支：

| | 频控（`WEB_RATE_LIMITED`） | 浏览器被关（`WEB_PAGE_CLOSED` / Playwright closed） |
| --- | --- | --- |
| 触发判定 | `looksLikeRateLimitText` / HTTP 429 / toast | `browserClosed()`：错误码 + 报错原文正则 + `browser.isConnected()` |
| 等待/动作 | 指数退避 60s→120s→240s→300s | 清失效页/连接 → `ensureReady()` 重启或补页 → 立即重发 |
| 上限 | `rateLimit.maxRetries`（默认 4） | `browserRecovery.maxAttempts`（默认 2） |
| 提示事件 | `wait` / `retry` | `recover`（不节流，三条状态都发） |
| 默认开关 | `rateLimit.enabled` | `browserRecovery.enabled` |

判定与动作的分工：

- `browserClosed(error)` 三条判据任一成立即视为可自愈：错误码是 `WEB_PAGE_CLOSED`；报错原文命中 `Target page/context/browser … closed`、`Browser has been closed`、`has been disconnected`、`Connection closed`、`连接已关闭/断开`；或 `this.browser.isConnected() === false`（连接已死时任何错误都按可自愈处理，在死连接上重试没有意义）。
- `recoverBrowser()` 先看浏览器是否还连着：**只关标签页** → 保留 `browser`/`context`，删掉该会话的页登记、关掉旧页、`ensureReady()` 补一个；**整个浏览器退出** → 清空全部页登记与 `managedConnection`，`browser.close()` 与 `process.kill()` 都做了容错，再重新 launch/connect。
- 自愈循环在 `turn()` 内，`release()` 之后再 `recoverBrowser()`，恢复后重新 `stateFor()` 取页、重新 `acquire()` 拿锁再进 `turnOnPage()`。回合超时和手动取消优先于自愈：`if (timedOut || abort.signal.aborted) throw error` 在最前面，不会被自愈循环吞掉。

**真机验证过了**（`npx tsx tools/manual/browser-realcheck.ts`，临时 profile + 独立端口，不碰本机在用的 Edge）：

| 验的什么 | 实测结果 |
| --- | --- |
| Playwright 真的报什么 | `page.evaluate: Target page, context or browser has been closed`，`isBrowserClosedMessage()` 命中 |
| 杀进程后能否用同一 profile 重开 | 能，新 pid，耗时约 1.0–1.2 秒（`browserRecovery.delayMs=2000` 有余量） |
| 真通道 `recoverBrowser()` 重启分支 | `browser.isConnected()` 先变 false，自愈后连上新 pid，提示 3 条：`[DSH] 恢复 · 浏览器被关掉了，正在重新启动浏览器（第 1/2 次）` → `[DSH] 恢复 · 0.5s 后重新启动浏览器，本轮消息会自动重发` → `[DSH] 恢复 · 浏览器已就绪，正在重新打开网页并重发本轮消息` |
| 只关标签页分支 | 浏览器对象与 pid 都不变，补出一个新页，提示首条是「网页标签被关掉了，正在重新打开标签页（第 1/2 次）」 |

顺带实测到一个容易被忽略的坑：**Chromium 关掉最后一个标签页时会直接退出整个浏览器进程**。所以「只关了一个标签页」到底走补页还是走重启，取决于当时还有没有别的页——DSH 平时有锚点页 + 会话页，关会话页不会退浏览器；用户把窗口里所有标签都关掉，浏览器就没了，走的是重启分支（更慢，但结论一样：能恢复）。测试脚本必须先留一个页再关目标页，否则验的其实是重启分支。

**要留意的副作用**：如果消息已经填入并回车成功、网页正在生成时才被关掉，自愈后会**重发同一条消息**，网页端可能留下两条内容相同的提问（旧那条已发出）。这是「恢复」换来的代价——不重发就只能让用户手动重说一遍。真在意重复的话：等浏览器恢复后先去网页端把那条重复的删掉，或把 `browserRecovery.enabled` 关掉改成手动处理。

**没覆盖的地方**：`turnIsolated()`（辅助请求，无 `onNotice`）只靠 `ensureReady()` 自己拉起浏览器，不会提示也不会重发；审核通道 Kimi/GLM 的浏览器被关仍按原错误抛出，由适配层转成 `[DSH·审核] …审核失败，已跳过本轮审核`。

---

## 7. 已知误判与真实风险

这几条会让人以为「又频控了」，其实不是：

| 现象 | 机制 | 影响 |
| --- | --- | --- |
| 正常回复被判频控 | 回复正文前 2000 字里出现「过于频繁」「稍后再试」等词，`:1174` 直接判 `rate-limited` | 模型原文被丢弃，转去重发，白等一整轮退避（60s 起） |
| 对话历史被判频控 | toast 扫描不排除历史消息区，≤120 字、子元素 ≤2 的正常气泡命中正则 | 同上 |
| 上一轮残留 toast | 发送前就存在的提示也会被扫到（800ms 轮询从填字前就开始） | 同上 |
| 用户手动停止被当成失败 | 只有 `signal.aborted` 写 `interrupted`；`turn-end` 走 `aborted` 分支且非 signed-out 时不显示错误行 | 属于预期行为，不产生 `WEB_RATE_LIMITED` |

真实风险在另一头：**重发本身就是在冷却期内继续发消息**。现在默认是 60s → 120s → 240s → 300s 的指数退避（合计 720s），比旧的 30 秒 × 5 次（150s）稳得多，但仍不保证绝对安全——`docs/RISK-CONTROL.md` 记录的封号案例是 8–12 秒间隔连发 49 次。连续多个回合都命中频控时，最稳的做法还是停下来等，而不是让插件一直重试。

---

## 8. 证据索引

| 结论 | 证据 |
| --- | --- |
| 频控正则 | `src/browser-shared.ts:32`、:35-37 |
| toast 扫描范围 | `src/browser-shared.ts:45-63` |
| 轮询间隔 800ms | `src/playwright-channel.ts:54`、:1130-1134 |
| 单次等待上限 180s | `src/playwright-channel.ts:63`、:1057-1082 |
| 判定与竞速 | `src/playwright-channel.ts:1170-1176` |
| 超时兜底转频控 | `src/playwright-channel.ts:1187` |
| 重发循环 / 退避 | `src/playwright-channel.ts:863-925`（抛错 :898-905，等待与倒计时 :907-925） |
| 重发重走发送流程 | `src/playwright-channel.ts:1137-1157` |
| 取消可打断等待 | `src/playwright-channel.ts:1204-1211` |
| 单回合上限 900s | `src/config.ts:352`、`src/playwright-channel.ts:640-695` |
| 默认频控参数 | `src/config.ts:359-366`、:171-190 |
| 退避与提示开关的纯逻辑 | `src/notify.ts`（`rateLimitDelayMs`、`formatNotice`、`noticeEnabled`、`describeFailure`） |
| 提示下发（节流、浮层、倒计时） | `src/playwright-channel.ts`（`emitNotice` / `paintPageNotice` / `waitWithCountdown` / `emitFailure`） |
| 提示转成 reasoning 块 | `src/adapter.ts`（`driveTurn` 的 `appendNotice`、审核段 `reviewLines`） |
| 提示配置项 | `src/client/config-fields.ts`（`ratelimit` / `notify` 两个分组） |
| 关闭类报错识别 | `src/browser-shared.ts`（`BROWSER_CLOSED_PATTERN`、`isBrowserClosedMessage`） |
| 浏览器自愈判定与恢复 | `src/playwright-channel.ts`（`browserClosed` / `recoverBrowser` / `turn()` 自愈循环） |
| 自愈回归 | `tools/browser-recovery-check.ts` |
| 自愈配置项 | `src/config.ts`（`browserRecovery`）、`src/client/config-fields.ts`（`browserrecovery` 分组） |
| 半自动判定 | `src/playwright-channel.ts:1050-1052`、`:1434-1439` |
| LlmError 与 failure | `$H/dsh-llm/lib/index.js:1615-1640` |
| 宿主默认可重试码 | `$H/dsh-llm/lib/index.js:247-257` |
| 流迭代直接抛错 | `$H/dsh-agent-loop/lib/index.js:1093-1126` |
| 重试仅在正常 finish.error 时触发 | `$H/dsh-agent-loop/lib/index.js:1130-1146` |
| turn/end 写 failure | `$H/dsh-agent-loop/lib/index.js:1015-1032` |
| 重试插件按码白名单 | `$H/dsh-llm-retry/lib/index.js`（`recover()`） |
| 前端错误节点 | `$H/dsh-client-ui-chat/lib/client.js:10516-10556` |
| 前端错误渲染 | `$H/dsh-client-ui-chat/lib/client.js:5344-5370` |
| 文案「本轮运行失败」 | `$H/dsh-client-ui-chat/lib/client.js`，`message.turnError` |
| 不保留半截正文 | `$H/dsh-client-ui-chat/lib/client.js:10645` |
| 过程面板强制展开 | `$H/dsh-client-ui-chat/lib/client.js:4159` |
| 会话回 idle | `$H/dsh-api-session-controller/lib/index.js:2991-2993` |
| WebSocket 单路传输 | `$H/dsh-api-gateway/lib/index.js:133`、:135、:1446-1452 |
| 本机配置（无 rateLimit 段，sendMode manual） | `C:/Users/29060/.dsh/profiles/desktop/cordis.yml:1566-1592` |
| 实测恢复时长分布 | `docs/RISK-CONTROL.md:37-38`、:57、:67、:74 |

### 未实测的边界

- **没有真实触发过一次 `WEB_RATE_LIMITED` 并观察界面**（全库会话扫描 0 次该码）。UI 结构由同族插件错误（`BROWSER_MANAGED_START_FAILED`、`WEB_UNPARSEABLE_RESPONSE`）的落盘事件 + 前端代码路径确定；文案与 code chip 的渲染逻辑是直读代码，不是截图复现。
- **WebSocket 错误帧的原始 JSON 没抓到**：launch token 进程内随机且不落盘，外部连不上 Web GUI 的本地端口（端口每次启动可能变化）。
- **半截正文在失败后过程面板的最终留存**：代码上 `live` 节点未 settle、错误强制展开，理论上能看到流出的部分；未在真机复现确认。
- **提示块的观感只做过离线校验**：`tools/rate-limit-check.ts` 断言了退避序列、前缀区分、开关逐层生效与 50 个错误码都有提示文案，但没有在真实频控下截图确认 `[DSH] 频控等待` 在 Web GUI 里换行与折叠后的样子。
- **浏览器自愈的真机验证只做到「通道层」**：`tools/manual/browser-realcheck.ts` 已经真的杀了 Edge 进程，验证了真实报错文本命中、同 profile 重新拉起、真通道 `recoverBrowser()` 重启与补页两条分支、以及三条提示文案；没验的是「完整 `turn()` 在网页生成中途被关浏览器 → 重发同一条消息 → 网页端出现两条提问」的实际表现，需要真账号手动关一次窗口确认。离线回归 `tools/browser-recovery-check.ts` 仍然保留（`ensureReady()` 在那里是 stub，跑得快、可在 CI 里跑）。
