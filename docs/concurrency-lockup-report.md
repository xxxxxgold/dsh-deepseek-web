# 主会话 + 子代理并发请求卡死：排查结论与修复方案

> 排查对象：`dsh-deepseek-web-littlecar30` v0.2.14（`D:\dsh\ds-web`，HEAD `f5c8b26`）
> 运行时：DSH `app.asar`（`dsh/node_modules/@deepseek-ai/*` 源码随包分发，已解包核对）
> 结论一句话：**问题真实存在，且是可复现的结构性缺陷，不是偶发玄学。**

---

## 0. 结论速览

| 项 | 结论 |
| --- | --- |
| 问题是否存在 | **存在**。DSH 允许父会话与子代理的 `llm.stream` 真并发，而插件把**所有会话的请求串到一把全局锁 + 单一网页标签 + 单一网页对话**上，后到的一方在整轮生成期间零输出。 |
| 是否"经典死锁" | **不是**（不存在 A 等 B、B 等 A 的环）。是**全局锁队头阻塞（head-of-line blocking）**，叠加 3 个可导致**永久**卡死的结构缺陷（锁泄漏 / 孤儿回合 / 无看门狗）。 |
| 何时引入 | **v0.2.13 的回归**：`f78b70b9 fix: isolate auxiliary calls and restore compacted context` 才新增 `src/async-lock.ts` 与 `requestLock`（该提交 15 个文件、+1116/-245）；0.2.14（`d7e7301d`）与 HEAD（`f5c8b26`）从未再改锁。上游 README/CHANGELOG **从未声明"同一时间只能一个请求"**。 |
| 谁会被卡 | **随机**：谁先到谁先跑，所以"有时主子会话卡、有时子代理卡"，与用户描述一致。 |
| 最长能卡多久 | 单次网页回合最坏 ≈ 52 分钟（5×600s 应答等待 + 5×30s 频控退避），而一条 `llm.stream` 会串联多个回合（纠错/委托/自审）→ 后到者可被压住数十分钟到数小时；再叠加锁泄漏则为**永久**。 |
| 修不修得好 | 修得好。根因治理 = **按会话隔离网页通道（每会话独立标签/对话）+ 公平可中断排队 + 锁租约看门狗**。方案见 §4，代码级改动全部列出。 |
| 并发能不能限流 | 能。追加全局并发网关 `maxConcurrentTurns`（默认 2）：会话之间并行，但同时在网页上跑的总数封顶，超出的**先进先出排队**，一条结束放行一条；设 `1` 即全局串行。见 §4.10。 |

---

## 1. 证据链

### 1.1 运行时层：父子请求确实并发（DSH 源码，asar 内路径）

- 插件适配器是进程内**单例**：`src/index.ts:34-78` `apply()` 里只 `new PlaywrightBrowserChannel(...)`、只 `new DeepSeekWebAdapter(...)`，然后 `ctx.llm.registerAdapter([PROVIDER], adapter)`。所有 dsh 会话共用这一个 adapter、这一个浏览器通道。
- 子代理**继承父会话的 provider/model**：`@deepseek-ai/dsh-subagent/lib/index.js:304-331`（`resolveChildAgentOptions`），`dsh-agent/lib/index.js:453-457` 用同一个 `ctx` 创建子 Agent ⇒ 子代理打的是**同一个 adapter 实例**。
- `subagent` 工具**不等待**子代理：`@deepseek-ai/dsh-tool-subagent/lib/index.js:441-482` 执行后返回 `{kind:'activation', subagentId}`，`isConcurrencySafe: () => true`。父 step 执行完工具立刻回到 step 循环，**下一次 `llm.stream` 与子代理的第一条 `llm.stream` 会同时到达插件**。
- LLM 运行时**没有任何排队/锁**：`@deepseek-ai/dsh-llm/lib/index.js:952-957`（`stream` → `streamWithRegistration` → `ctx.waterfall('llm/stream')`）与 `:2309-2381`（`adapterStream` 纯派发）。全仓 `lock|mutex|acquire` 命中均为无关的 `block`/`BlockAssembler`。
- harness **不与 abort 竞速 async iterator**：`@deepseek-ai/dsh-agent-loop/lib/index.js:1088-1092` `for await (const chunk of stream) { signal.throwIfAborted(); ... }` —— 只有收到下一个 chunk 才检查取消。**adapter 不吐 chunk，上层就无从取消，也不会超时**。

> 即：并发语义是 DSH 的正常行为，**插件有义务自己处理多会话并发**。它没有。

### 1.2 插件层：一条全局锁 + 一个页面 + 一个网页对话

| 位置 | 事实 |
| --- | --- |
| `src/adapter.ts:114` | `private readonly requestLock = new AsyncLock()` —— adapter 单例级、**跨所有 dsh 会话**。 |
| `src/adapter.ts:283-303` | `stream()` 第一件事就是 `const release = await this.requestLock.acquire(options.signal)`，**直到整条生成流（多轮网页回合 + 纠错 + 委托 + 自审）结束才 release**。 |
| `src/playwright-channel.ts:333` | `private readonly turnLock = new AsyncLock()`，`page` 是**全通道唯一工作页**，`activeSessionId`、`conversationStarted` 是**通道级全局布尔/字符串**。 |
| `src/playwright-channel.ts:464-483` | `turn()` 拿 `turnLock` 后把请求打进**同一个 `this.page`**；`!request.preserveConversation` 时直接改写 `this.activeSessionId`。 |
| `src/config.ts:220` | `streamIdleTimeoutMs` 默认 **600_000ms（10 分钟）**：`sendAndWait` 里 `page.waitForResponse(..., {timeout: streamIdleTimeoutMs})`，一次网页回合最多干等 10 分钟。 |
| `src/config.ts:223-224` | 频控重发 `retryDelayMs` 默认 30_000、`maxRetries` 默认 5 ⇒ 单个回合最坏 5×600s + 5×30s ≈ **52 分钟**。 |
| `src/config.ts:217` | `sendMode` 默认 **manual**：默认还要等用户去点网页里的"发送"按钮，10 分钟内没人点就超时。 |

两条补充事实（决定了"卡住"是**无界**的）：

- **DSH 对 `llm.stream` 没有任何超时**：`dsh-agent-loop/lib/index.js` 全文件搜 `timeout` 零命中；`dsh-llm` 包内也搜不到 watchdog/`idleTimeout`。即：插件不吐 chunk，上层既不取消也不会超时报错，界面就是永远的"生成中"。**插件里那句 `release?.()` 是全系统唯一的兜底**，生成器一卡就是永久挂死。
- **即使不派子代理也会并发**：`purpose:'session-title'` 的标题请求是 detached 发的（`dsh-session-title/lib/index.js:262-268`，`:432` `defer`），与主请求**真并发**；而 `src/adapter.ts:287` 让辅助请求也抢同一把全局锁 ⇒ 标题请求会排在主请求整轮后面（或者反过来把主请求顶住）。`purpose:'compaction'` 虽然只在自己的 pre-step 触发（`dsh-compaction-basic/lib/index.js:839`，`dsh-agent-loop:956/980/1084`），但也一样抢这把锁。

### 1.3 实测证据 A：两个会话的网页回合零重叠（可复现脚本）

`.tmp-audit/repro2.ts`（真实 `src/adapter.ts` + 假 channel，`npx tsx .tmp-audit/repro2.ts`）：

```
A 启动于 0ms；B 启动于 157ms
turn 记录: A=[10ms → 3011ms] session=main；B=[3019ms → 6033ms] session=child
A: firstChunk=3010ms 结束=3014ms；B: firstChunk=5872ms 结束=5875ms
PASS 2a 两个会话的网页 turn 时间完全不重叠（被全局 requestLock 串行化）— overlap=false
PASS 2b B 必须等 A 完成才能开始 — B 开始于 3019ms，A 结束于 3011ms
PASS 2c B 的 first chunk 出现时刻 = A 结束时（B 全程零输出）
PASS 2d 通道内最大并发 turn 数为 1 — maxActiveTurns=1
```

**这就是"其中一个卡住"的直接机制**：B（子代理或主会话下一步）在 A 结束前**一个 chunk 都拿不到**，DSH 端口看起来就是"卡在生成中"。

### 1.4 实测证据 B：本会话自己在犯病（活体样本）

本次排查期间，本会话（lead，模型 `deepseek-web-auto`）连续 **两次** 出现 `Elapsed since the preceding step context: 10m 30s`。
630s = **600s 网页应答超时 + 30s 频控退避**，正好是一次失败网页回合的完整耗时 —— 说明 lead 的 `llm.stream` 在我派出的 3 个子代理（同 provider、同通道）跑网页回合时，被死等在了**别人一次超时的回合**后面。这不是猜测，是同一进程内同一把锁的直接后果。

### 1.5 三条"会变成永久卡死"的结构缺陷

1. **锁泄漏（永久）**：`stream()` 是 async generator，`release` 写在最外层 `finally` 里。消费方若拿到 `finish` 后不再 `next()`、也不 `return()`，generator 永远停在 `yield` 处，`finally` 永不执行 ⇒ `requestLock` 永久被占，**此后所有会话的所有请求全部挂死**。
   repro2 §3d 实测：看到 `finish` 后停止拉取，另一个 stream 1.5s 后仍零输出（`requestLock` 未释放）；补一次 `iterator.return()` 才恢复。
   `.tmp-audit/exp1-lock.txt` T6 同结论：锁**无租约、无超时**，漏释放即永久挂起。
2. **孤儿回合**：`src/adapter.ts:186-223` `driveTurn` 把 `this.channel.turn(...)` 作为**后台 Promise** 持有；generator 被 `return()` 时只走 `release?.()`，**不会取消那个在飞的网页回合**。该回合继续持 `turnLock`、继续往**共享页面**里打字/等响应 ⇒ 下一个会话拿到 `requestLock` 后卡在 `turnLock` 上（最多 10 分钟），且两轮文本互相覆盖、`waitForResponse` 可能匹配到对方的响应 ⇒ **回复串台 / 等不到响应**。
3. **无看门狗**：锁、回合、页面操作都没有硬超时；`ensureReady()`/`page.goto`/`locator.waitFor` 不可中断（`src/browser-shared.ts:68` 60s、`:296-303`、`:331-337` 各 60s 轮询）。

### 1.6 附带发现：跨会话状态串扰（会放大卡顿）

`conversationStarted`、`activeSessionId`、`resetConversationGate()` 都是**通道级**状态（`src/playwright-channel.ts:336、409-412、414-416、421-426`）。子代理 `initialize:true` 时会 `startFreshConversation` 并重置全局门闩，主会话下一轮就判定 `isConversationActive('main') === false` ⇒ `forceReplay=true`（`src/adapter.ts:369-370`），**整段宿主历史重新回放进网页对话**，更慢、更容易撞上 600s 超时，形成正反馈。

---

### 1.7 上游 / 官方语义溯源（为什么说这是"违背设计语义的回归"）

- 上游仓库 `LittleCar30/dsh-deepseek-web`：issue 1 个（#1 思考内容截断，已 closed，与并发无关）、PR 0、无并发相关 commit；npm latest = 0.2.14 = 本地版本。**上游没有记录过这个卡死问题**（来源：`.tmp-upstream/report.md`，GitHub API 全量拉取）。
- 锁的来源：`git log --all -- src/async-lock.ts` 只有 `f78b70b9` 一行；`git log -S requestLock -- src/adapter.ts` 同样只有这一条 ⇒ **0.2.13 之前没有这把锁**。也就是说：锁是为"辅助请求隔离"顺带引入的，不是有意的并发设计，而且没有配套的超时/租约/观测。
- 官方 DSH 语义与现实现相反：
  - `subagent.zh.md`：**"The service may call one provider concurrently for distinct children"**（服务可以针对不同子代理并发调用同一个 provider）。
  - 同文档：**"a shared capacity controller may delay an operation but must not couple its settlement or cleanup to a sibling"**（共享容量控制可以延迟某个操作，但**不得把它的结算/清理耦合到兄弟操作**）。—— `requestLock` 正是把兄弟请求的结束耦合在了一起。
  - `dsh-tool-subagent` README：**"It does not wait for the child's result"**（不等待子代理结果）⇒ 父子两条流同时在途是**预期行为**。
- 可借鉴的现成模式（同样跑在 DSH 上的插件）：
  - `dsh-concurrency-guard`：按 `header.parentSession` 解析 rootId 分桶（同一 root 串行、不同 root 并行）+ "会话门 → 全局门"固定顺序 + 排队超时 fail-open + 辅助请求豁免会话门。
  - 官方 `browser-use`：**per-Session 独占 + Session queue**，并且"拒绝另一个 Session 的并发附着"时**快速失败**而不是无限等待。
  - 这正是本方案 §4 的取舍：**能并行就并行（会话之间），不能并行就快速失败或可见排队（同一会话/容量上限）**。

---

## 2. 逐条对账（用户给的硬指标）

| 你提的点 | 结论 | 证据 |
| --- | --- | --- |
| 主会话被请求 | 正常：`adapter.stream()` 拿全局锁跑完整轮 | `HEAD:src/adapter.ts:114,283-303` |
| 主会话创建子代理 | 正常：工具返回 activation，不阻塞父 step | `dsh-tool-subagent:441-482` |
| 主会话再运行 | 会发新 `llm.stream`，**排在全局锁后面** | `HEAD:src/adapter.ts:283-303`；`repro2.ts` 2b |
| 子代理也发请求 | 同 provider 同 adapter，**同一把锁** | `src/index.ts:34-78`；`dsh-subagent:304-331` |
| 某一个可能卡住 | **会**。后到者整轮零输出；极端情况下（锁泄漏）永久卡死 | repro2 2c/3d；本会话 630s×2 |
| 是不是经典死锁 | 不是；是队头阻塞 + 三类结构性缺陷 | §1.5 |

> 本表"证据"列的行号都是**修复前 HEAD `f5c8b26`**，修复后的实现见 §4。

---

## 3. 触发条件（什么时候最容易撞上）

1. 主会话派了子代理 / team，**并且**在子代理干活时主会话继续往下走（最常见：`subagent` 一返回父会话马上要下一轮）。
2. 同时跑多个子代理（并行工具调用、team 多人）—— 串行度 = 会话数。
3. `sendMode: 'manual'`（默认）：每个回合还要等人点"发送"，10 分钟超时，队头阻塞被放大 10 分钟级。
4. 网络/网页端慢、被频控：`maxRetries=5 × retryDelayMs=30s`，单回合干等 52 分钟。
5. 上下文大 / 触发重放（`forceReplay`）或压缩（`purpose:'compaction'` 也走同一把锁）：单条流内部回合数变多。
6. **不派子代理也可能撞**：会话标题请求是 detached 并发发的（`dsh-session-title/lib/index.js:262-268,432`），同样要过这把全局锁。

---

## 4. 修复方案

### 4.0 设计原则

1. **对齐 DSH 并发语义**：不同 dsh 会话 = 不同网页标签 = 不同网页对话，**互不排队**；同一会话内部严格串行。
2. **任何等待都可中断、都有上界**：排队、回合、页面操作、锁持有。
3. **页面通道对"单个坏回合"免疫**：一个回合卡死只能弄死它自己，不能拖垮整个进程；锁必须带租约，防泄漏。
4. **状态按会话隔离**：`conversationStarted/activeSessionId/autoSend` 从通道级全局下沉到会话级。

### 4.1 改动 1：adapter 从"全局锁"改为"按会话锁"（消除跨会话队头阻塞）

`src/adapter.ts`

```ts
// 原（第 114 行）：
// private readonly requestLock = new AsyncLock()
// 改为：
private readonly sessionLocks = new Map<string, AsyncLock>()

private lockFor(key: string): AsyncLock {
  let lock = this.sessionLocks.get(key)
  if (lock === undefined) {
    lock = new AsyncLock()
    this.sessionLocks.set(key, lock)
  }
  return lock
}
```

`stream()`（第 283-303 行）里把取锁改成按会话 + 带租约看门狗：

```ts
const sessionId = options.sessionId ?? 'anonymous'
const lockKey = options.purpose === undefined ? sessionId : `${sessionId}::${options.purpose}`
const release = await this.lockFor(lockKey).acquire(options.signal, {
  maxHoldMs: this.config.lockLeaseMs,
  onLeak: () => {
    console.warn(`[deepseek-web] 会话 ${lockKey} 的通道租约超时，强制回收（防永久卡死）。`)
    void this.channel.cancelTurn?.(sessionId).catch(() => {})
  },
})
```

> 效果：主会话与子代理各自排队（各自网页标签），彼此不再互相等待。同一会话的第二条流仍然串行（网页对话必须串行，语义不变）。

### 4.2 改动 2：锁租约 + 强制回收（根治"永久卡死"）

`src/async-lock.ts` 增加可选参数，不改原有调用语义：

```ts
export interface AcquireOptions {
  /** 持锁上限；超时强制释放并回调 onLeak（防生成器被遗弃导致永久占锁）。 */
  maxHoldMs?: number
  /** 租约超时的回收动作。 */
  onLeak?: () => void
}

async acquire(signal?: AbortSignal, options: AcquireOptions = {}): Promise<() => void> {
  // ...原有排队逻辑不变，release 改为幂等：
  let settled = false
  const settle = (): void => {
    if (settled) return
    settled = true
    if (lease !== undefined) clearTimeout(lease)
    release()
  }
  let lease: NodeJS.Timeout | undefined
  if (options.maxHoldMs !== undefined && options.maxHoldMs > 0) {
    lease = setTimeout(() => {
      try { options.onLeak?.() } catch { /* 回收动作失败不影响解锁 */ }
      settle()
    }, options.maxHoldMs)
    lease.unref?.()
  }
  return settle
}
```

> **为什么必须这么做**：repro2 §3d 证明"消费方拿到 `finish` 后松手"会让 `requestLock` 永久不释放；`exp1` T6 证明锁没有任何超时。租约是唯一能保证"进程内通道永不永久瘫痪"的机制。
> `lockLeaseMs` 建议默认 `streamIdleTimeoutMs * 6 + 120_000`（覆盖单条流串联多个回合的现实上限），并非每回合都超时，只在**异常遗留**时兜底。

### 4.3 改动 3：取消孤儿回合（生成器被 return 后不再有回合改页面）

`src/adapter.ts` `stream()` 的 `finally`：

```ts
} finally {
  if (!completed) {
    this.replaySessions.add(sessionId)
  }
  // 生成器被上层提前 return() 时，后台 turn 可能还在打字/等响应，必须取消，
  // 否则它会继续持有 channel 的回合锁并污染共享页面。
  await this.channel.cancelTurn?.(sessionId).catch(() => {})
  releaseOnce()
}
```

`src/playwright-channel.ts` 新增（配合改动 4 的会话态）：

```ts
/** 会话级取消：中止该会话在飞的网页回合（幂等）。 */
async cancelTurn(sessionId: string): Promise<void> {
  const state = this.sessionPages.get(sessionId)
  state?.abort.abort()
  state?.abort = new AbortController()
}
```

`turnOnPage`/`sendAndWait` 里把 `request.signal` 与该会话的 `state.abort.signal` 合成一个内部 signal（`AbortSignal.any([...])`，Node 20+ 可用；或手写 200ms 轮询的 sleeper 已具备），保证取消立刻生效。

### 4.4 改动 4：channel 从"单页"改为"每会话一页"（根因治理）

`src/playwright-channel.ts`：把 `page`、`conversationStarted`、`activeSessionId` 从类字段下沉为会话态，把 `turnLock` 拆成每会话锁：

```ts
interface SessionPageState {
  /** 该会话专属标签页。 */
  page: Page
  /** 该页当前网页对话是否已开始（原全局 conversationStarted）。 */
  started: boolean
  /** 该会话自己的回合锁（原全局 turnLock）。 */
  lock: AsyncLock
  /** 取消在飞回合用（改动 3）。 */
  abort: AbortController
  /** LRU 依据。 */
  lastUsedAt: number
}

private readonly sessionPages = new Map<string, SessionPageState>()
private readyPromise?: Promise<void>()
```

关键方法（完整实现）：

```ts
private async ensureReadyOnce(): Promise<void> {
  // 原 ensureReady 逻辑（350-407 行）原样搬入；外层负责单飞
}

/** 单飞：两个会话同时首轮时只启动/连接一次浏览器。 */
private async ensureReady(): Promise<void> {
  if (this.browser !== undefined && this.page !== undefined && !this.page.isClosed()) return
  this.readyPromise ??= this.ensureReadyOnce().finally(() => { this.readyPromise = undefined })
  await this.readyPromise
}

private async stateFor(sessionId: string, signal?: AbortSignal): Promise<SessionPageState> {
  await this.ensureReady()
  const existing = this.sessionPages.get(sessionId)
  if (existing !== undefined && !existing.page.isClosed()) return existing
  if (existing !== undefined) this.sessionPages.delete(sessionId)
  const page = await this.context!.newPage()
  try {
    await ensureChatPage(page, this.entryUrl())
  } catch (error) {
    await page.close().catch(() => {})
    throw error
  }
  const state: SessionPageState = {
    page,
    started: false,
    lock: new AsyncLock(),
    abort: new AbortController(),
    lastUsedAt: Date.now(),
  }
  this.sessionPages.set(sessionId, state)
  await this.evictIdlePages(sessionId)
  return state
}

/** 超过 maxSessionPages 时按 LRU 关掉最久未用的空闲标签。 */
private async evictIdlePages(exceptSessionId: string): Promise<void> {
  const cap = Math.max(1, this.options.config.maxSessionPages)
  while (this.sessionPages.size > cap) {
    let victim: [string, SessionPageState] | undefined
    for (const entry of this.sessionPages) {
      if (entry[0] === exceptSessionId) continue
      if (victim === undefined || entry[1].lastUsedAt < victim[1].lastUsedAt) victim = entry
    }
    if (victim === undefined) return
    this.sessionPages.delete(victim[0])
    await victim[1].page.close().catch(() => {})
  }
}

async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
  const state = await this.stateFor(request.sessionId, request.signal)
  const release = await state.lock.acquire(request.signal, {
    maxHoldMs: this.options.config.turnLeaseMs,
    onLeak: () => { state.abort.abort() },
  })
  try {
    if (request.initialize === true && !state.started) {
      await startFreshConversation(state.page, this.options.config.entryUrl)
      state.started = true
    }
    return await this.turnOnPage(state.page, request)
  } finally {
    state.lastUsedAt = Date.now()
    release()
  }
}

isConversationActive(sessionId: string): boolean {
  const state = this.sessionPages.get(sessionId)
  return state !== undefined && state.started && !state.page.isClosed()
}

resetConversationGate(sessionId?: string): void {
  if (sessionId === undefined) {
    for (const state of this.sessionPages.values()) state.started = false
    return
  }
  const state = this.sessionPages.get(sessionId)
  if (state !== undefined) state.started = false
}

async dispose(): Promise<void> {
  // 原有浏览��关闭逻辑保留，另加：
  for (const state of this.sessionPages.values()) await state.page.close().catch(() => {})
  this.sessionPages.clear()
  this.conversationStarted = false
  this.activeSessionId = undefined
}
```

同时：

- `turnIsolated`（485-501 行）**保持不变**（临时页，用于 compaction 等辅助请求），但仍需 `ensureReady()` 单飞保护。
- `sendAndWait` 里 `if (page === this.page) this.conversationStarted = true` 改为 `this.sessionPages.get(request.sessionId)!.started = true`（按会话记账）。
- `activeSessionId` 语义由"通道唯一"变为"每个会话页自己的身份"，`forceReplay` 判定只需 `isConversationActive(sessionId)` —— 子代理翻页不再导致主会话整段重放。

### 4.5 改动 5：回合 + 流级看门狗（有界失败，报错而不是干等）

- `turnOnPage` 外包一层总时长上限（`config.turnTimeoutMs`，默认 15 分钟）：
  ```ts
  const deadline = setTimeout(() => { state.abort.abort() }, this.options.config.turnTimeoutMs)
  ```
  超时抛 `WEB_TURN_TIMEOUT`（提网页被卡住，而不是静默），并在下一次 `stateFor` 时重建标签页（`page.isClosed()` 或健康检查失败即重建）。
- `adapter.stream()` 外层再加 `maxStreamMs`（默认 60 分钟）：超过则中止并 yield 一个 `finish(stop)` + 错误日志，保证 session 能继续往下走，而不是永远"生成中"。

### 4.6 改动 6：可观测性（用户能区分"排队"和"卡死"）

### 4.6 改动 6：可观测性（用户能区分"排队"和"卡死"）

落地实现里加的是**异常/归属变化才打印**的低噪日志（不用轮询心跳），已实测输出如下：

| 日志 | 触发时机 | 含义 |
| --- | --- | --- |
| `[deepseek-web] 会话工作页就绪 session=… 会话页=n/max（复用锚点页\|新开标签页）` | 某会话第一次要网页页 | 该会话有了自己的标签页 |
| `[deepseek-web] turn 入口 session=… initialize=… 页面会话=… started=… 会话页=n` | 每次网页回合 | 谁在哪个页上跑、是否重建对话 |
| `[deepseek-web] 取消会话回合 session=…：宿主已放弃本次生成…` | 宿主 abort / 弃迭代器 | 旧回合被主动取消（不再泄漏） |
| `[deepseek-web] 会话页达到上限 n，回收最久未用的工作页 session=…` | 超过 `maxSessionPages` | 页池 LRU 回收 |
| `[deepseek-web] 会话锁超过租约被强制回收：key=… 已持有 …s，仍有 … 个请求在排队` | 30 分钟租约到期 | **只会在锁真的泄漏时出现**，出现即说明旧代码那类永久卡死被兜住 |
| `[async-lock] 锁租约到点强制释放：已持有 …s，排队 n 个请求` | 同上（锁内部） | 同上 |
| `[deepseek-web] 本次请求超过 N 分钟仍未结束，主动取消网页回合` | 超过 `maxStreamMs` | 整条流的有界失败 |
| `[deepseek-web] 会话排队…`（取锁等待） | 等待超过 3 秒 | 同会话前一个网页回合还没结束（预期串行），并非跨会话阻塞 |

`channel.status()` 除就绪状态外，追加 `并行会话页 n/max`，便于一眼看出当前开了几个会话页。
- 关键路径已有 `console.info/warn` 前缀，保持不变，便于 `dsh` 日志抓取。

### 4.7 配置新增（`src/config.ts`）

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `maxSessionPages` | `3` | 最多同时开几个会话标签（受网页端账号并发承受力约束；1 即回到完全串行） |
| `maxConcurrentTurns` | `2` | 全局并发名额：同一时刻最多几条请求真在网页上跑（主会话/子代理/辅助请求一起算），超出的按到达顺序先进先出排队；`0` 关闭（只计数不排队） |
| `turnTimeoutMs` | `900_000`（15 分钟） | 单个网页回合总时长上限，超时抛 `WEB_TURN_TIMEOUT`；0 关闭 |
| `lockLeaseMs` | `4_500_000`（75 分钟） | 会话锁租约（防永久占锁，仅泄漏时触发）；**必须 ≥ `maxStreamMs + turnTimeoutMs`**（默认恰好相等） |
| `maxStreamMs` | `3_600_000`（60 分钟） | 单条 `llm.stream` 上限，到点主动取消网页回合；0 关闭 |

> 全部走 `markVolatile(...)`，与现有配置风格一致，可在插件配置面板里改。
> 启动时 `DeepSeekWebAdapter.warnAboutTimeoutConfig()` 会做交叉校验并在控制台告警：
> `lockLeaseMs < maxStreamMs + turnTimeoutMs`（多回合合法请求可能被租约强拆）、
> `maxStreamMs === 0 && lockLeaseMs > 0`（整轮无上限但租约有限）、`turnTimeoutMs > maxStreamMs`（单回合上限永不触发）、
> `lockLeaseMs === 0`（关闭泄漏兜底）、`turnTimeoutMs === 0 && sendMode === manual`（人工等待无上限）。
> 默认值满足 `turnTimeoutMs(15min) ≤ maxStreamMs(60min)` 且 `lockLeaseMs(75min) = maxStreamMs + turnTimeoutMs`，不告警。
> 为什么租约要这么长：一条 `llm.stream` 会串联多个网页回合，人工模式下每回合都可能等满 600s，
> `review.maxRounds=3` 时合法总时长可达 ~31 分钟——租约短于这个值就会在正常回合中途强拆锁，
> 让同一会话的两条流交替写同一个网页对话（审计给出的具体反例：`manual` + `review.maxRounds=3` ≈ 1860s > 旧的 1800s）。

### 4.8 兼容 / 回滚 / 风险

- **行为变化**：不同 dsh 会话不再串行 ⇒ 会同时向网页端发多条消息（同账号多标签）。若网页端频控严厉，可能更容易吃 429；已内置 `retryDelayMs/maxRetries` 重发，默认 `maxSessionPages=3`（主会话 + 子代理 + 自审各一页），吃 429 就降到 2 观察。
- **manual 模式**（默认）多标签会抢前台焦点：只有"当前需要点击发送"的会话置顶；别的会话在后台排队。若不希望多标签，把 `maxSessionPages` 设为 `1` 即回到"串行 + 排队"的旧行为（但仍有租约/看门狗/取消，不会永久卡死）。
- **回滚**：本次改动只在 `src/{adapter,playwright-channel,async-lock,config}.ts`；`git checkout -- src` 即回滚。**没有改协议、没有改构建产物、没有动 `lib/`**。
- **不能替你验证的部分**：真实 DeepSeek 网页端在多标签并发下的表现需要真机跑；本方案只保证 DSH 侧不排队不卡死、失败有界可报。

### 4.9 落地实现与上面设计稿的差异（以 `src/` 实际代码为准）

设计稿是"该怎么改"，落地时有几处按实测/审计结论做了调整，读代码时请以此为准：

1. **默认值**：`maxSessionPages=3`（设计稿 2），`turnTimeoutMs=900_000`、`maxStreamMs=3_600_000`、`lockLeaseMs=4_500_000`。理由：DSH 主请求**零超时**（`dsh-agent-loop` 全文搜不到 timeout），插件是唯一兜底；一条流可串联多个网页回合，人工模式每回合合法时长可达 `streamIdleTimeoutMs` 600s + 频控 5×30s ≈ 12.5 分钟，`review.maxRounds=3` 时整轮合法时长 ≈31 分钟，因此租约取 75 分钟 = 整轮上限 60 分钟 + 单回合上限 15 分钟。审计建议的 2–5 分钟**会误杀**正常的人工等待回合，不采纳；改为"租约 ≥ 整轮上限 + 单回合上限"并在启动时交叉校验告警。
2. **锚点页复用判据**：`createState()` 用 `!this.assignedPage(anchor)` 而不是设计稿的 `ownedPage`。`ownedPage` 对 `this.page` 恒真 ⇒ "复用锚点页"是死代码，首个会话总新开标签、锚点页闲置（审计 S6：上限 3 却存活 4 个标签；修后 3 个）。
3. **`pendingPages` 集合**：新建标签页到登记进 `sessionPages` 之间有个窗口，期间 `startFreshConversation()` 会关闭"点击新对话产生的新标签"，可能误关并发会话刚建的页；用 `pendingPages` 把这些页标记为"已拥有"来避开。
4. **自审落位**：`preserveConversation`（同对话自审）优先用请求里显式携带的 `conversationSessionId`（`adapter` 调用 `reviewer.review(evidence, { conversationSessionId: sessionId })` 传入），其次才回落 `focusSessionId`（`adapter.streamTask` 打点），最后才是"最近用过的页"。只有 `focusSessionId` 不够：它是全局单字段，子代理在主会话"审阅阶段"启动会把它覆盖，自审就会写进子代理的网页对话并抢子代理的会话锁（审计 L2 反向断言）。
5. **单回合超时位置**：`turnTimeoutMs` 的 timer 在 `channel.turn()` 内部，而不是设计稿说的"`turnOnPage` 外包"。因为生成器被 `return()` 后 `channel.turn` 仍在后台跑，超时只能由 channel 自己持有；超时走内部 `AbortController`，抛 `WEB_TURN_TIMEOUT`。
6. **`maxStreamMs` 到点的动作**：不是"yield 一个 finish(stop)"，而是 `channel.cancelTurn(sessionId)` ⇒ 回合抛 `WEB_TURN_ABORTED`，宿主拿到明确错误。在持锁的生成器里伪造 finish 会破坏游标语义（`advanceAndSave` 才是提交点）。
7. **回收页时锚点失效**：`makeRoomForPage()` 关掉的可能是复用过锚点页的会话，必须同时 `this.page = undefined`，否则后续 `ensureReady` 会落在已关闭页上。
8. **排队可观测**：取锁等待超过 3 秒打印 `[deepseek-web] 会话 … 排队中`（同会话预期串行），不刷屏。
9. **明确不做**：空闲会话页 TTL 回收（`maxSessionPages` 已封顶，收益低）；通用 Page 池（贵的是"重建网页对话 + 全量回放"，不是页对象本身——实测热复用 1ms、冷重建 1825ms）；把租约降到 2–5 分钟（同上，会误杀合法长回合）。

### 4.10 追加：全局并发名额与 FIFO 排队（`maxConcurrentTurns`）

会话锁解决"不同会话不该互相等"，但它不限制**总量**：10 个子代理同时发请求就是 10 个标签页一起打同一个账号，结果是一起吃 429、一起退避重试。所以再加一层全局名额池：

- 实现：`src/concurrency-gate.ts` 的 `ConcurrencyGate`，构造时传 `() => config.maxConcurrentTurns`（支持热改配置）。
- 语义：名额空→立即放行；名额满→按到达顺序入队，`release` 时队首补位（严格 FIFO，短请求不能插队）；`limit=0`→不限制（只计数）；排队可被 `signal` 取消，取消者立即出队且不占名额；`release` 幂等。
- 接入点：`adapter.stream()` 取到**会话锁之后**再 `gate.acquire(options.signal)`，`finally` 里先 `cancelTurn`（若未完成）再放会话锁，最后放名额。顺序不能反：若先抢名额再等会话锁，同一会话的第 2、3 个请求会抱着全局名额空等，把别的会话饿死。
- 看门狗起点：`maxStreamMs` 的计时从**拿到名额之后**开始，否则在队列里排 10 分钟会被直接判超时。
- 可观测：排队超 3 秒打印 `并发上限 N 已满，会话 xxx 排队中：前面还有 M 条请求，已等 Ks（先进先出逐个放行）`；拿到名额且等待 ≥500ms 或有后续排队时打印 `取得并发名额 … active=x/N`。
- 交叉校验：`maxConcurrentTurns > maxSessionPages` 时启动告警（名额比页面还多，多出的请求要等页面回收）。
- 与 `maxSessionPages` 的关系：前者管"同时在打账号的请求数"，后者管"同时开着的标签页数"；建议 `maxConcurrentTurns ≤ maxSessionPages`，默认 2 ≤ 3。
- 配置含义：`1` = 全局串行（最保守）；`2` = 默认（主会话 + 一个子代理并行）；`3–4` = 激进并行（需确认账号不频繁 429）。

---

## 5. 验证结果（已全部跑过，可复现）

| # | 验证项 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 构建 | `npm run build` | ✅ host + client 均 `Build complete`（`lib/index.js` 154 kB、`lib/client.js` 18.20 kB） |
| 2 | 既有解析回归（13 个） | `npm run test:parsers` | ✅ 全绿（思考隐藏/长委托/工具输入限制、辅助隔离、DSML、压缩配置…） |
| 3 | 新增并发回归（8 条契约） | `npx tsx tools/concurrency-check.ts` | ✅ 8/8 PASS，已并入 `test:parsers` |
| 4 | 类型检查 | `npx tsc -p .tmp-lead/tsc/tsconfig.json` | ✅ 改动前后**同为 44 个既有错误且按文件分布完全一致**；`adapter.ts`/`playwright-channel.ts`/`async-lock.ts`/`browser-channel.ts` **零错误** |
| 5 | 独立黑盒复核（审计者脚本） | `npx tsx .tmp-audit/verify-current.ts` | ✅ **18/18 ALL PASS** |

第 3 项实测数据（`tools/concurrency-check.ts`，假 channel、真实 adapter）：

| 契约 | 期望 | 实测 |
| --- | --- | --- |
| 跨会话并行（主会话 + 子代理） | 两回合重叠、`maxActive=2` | ✅ 总耗时 433ms，开始时间差 <200ms |
| 同会话两次请求 | 仍串行、`maxActivePerSession=1` | ✅ 342ms（不破坏网页对话语义） |
| 放弃生成（拿到 chunk 后 `iterator.return()`） | 旧回合被取消、同会话新请求立刻可跑 | ✅ `cancelTurn` 被调用，新请求 43ms 完成 |
| 辅助请求（`purpose='session-title'`） | 与主请求重叠，不排队 | ✅ 辅助 123ms 完成（主请求仍占用 629ms） |
| 锁租约 | 泄漏的锁到点回收 | ✅ 132ms 后恢复可用、`onLeak` 触发、`pending=0` |
| 并发上限（`maxConcurrentTurns=1`） | 两会话也串行、按到达顺序放行 | ✅ `maxActive=1`、顺序 `['limit-a','limit-b']`、总耗时 541ms |
| 上限放开（`maxConcurrentTurns=0`） | 只计数不排队 | ✅ 3 个会话 `maxActive=3`、总耗时 337ms |
| 名额池单元契约 | FIFO、release 幂等、排队取消不泄露名额 | ✅ c/d 严格按序放行；`a()` 调两次只放行一个；取消的排队者 reject 且 `active` 不变 |

第 5 项 18 条断言里的关键实测（审计者独立写的，未复用我的用例）：V1–V3 主/子回合 `[7→810ms]` 与 `[137→952ms]` **重叠**、总 939–953ms、两流都正常 `finish`；V4 同 sessionId 恰好串行；V5–V7 `return()` 后立即 `cancelTurn`、同会话新请求 39–47ms；V8–V9 辅助隔离与主请求 1516ms 重叠 207ms；V10 租约 306–318ms 回收；V11–V13 排队中/持锁中 abort 均 1ms 内返回且之后新请求正常；V14–V16 两会话各用独立页（`primary`+`tab-1`）并发 152ms、`isConversationActive`/`resetConversationGate(sessionId)` 按会话隔离；V17 `cancelTurn` 中止在飞回合；V18 上限 3 页、LRU 回收，**存活标签 3 个**（修复前同一测试为 4 个）。

审计者随后又补了 5 条**定向断言**（改完全部复核仍 ALL PASS）：L2b 子代理已覆盖 focus 时，自审带 `conversationSessionId='main'` 仍落回主会话页（primary）；L2c 自审占主会话的会话锁、主会话下一回合在自审结束的同一毫秒进入；L2d 子代理回合并行进入不被自审堵；L2e 无目标无 focus 时回落最近使用页（旧行为保留）；L2f `DeepSeekSelfReviewer.review` 把目标透传进 `channel.turn`。

第 5 项之外，审计者还测了"切会话/首轮初始化"开销（`.tmp-audit/measure-overhead.ts`，假 Page、goto 与打字按 0ms，即插件侧下界）：**冷启动首轮 1825ms、同会话热复用 1ms、归属翻转后重建 1825ms、第二会话冷启动 2330ms**。老代码是**每轮**付这 1825ms（父子交替 4 轮重建 4 次）；现在只在首轮/归属变化时付——这正是"不再每轮重放"的量化收益。

**仍需真机验证的部分**（我无法在这里替你跑）：真实 DeepSeek 网页端在多标签并发下的表现。冒烟步骤：`maxSessionPages` 保持默认 3，让主会话派一个子代理，子代理干活时给主会话再发一条消息 → 两个标签页应**同时**在动，日志出现两条不同会话的 `已收到网页完整回复`，而不是一个空等；若网页端吃 429，会走既有频控重发（`retryDelayMs`/`maxRetries`）。

---

## 6. 先止血（不改代码的临时缓解，按收益排序）

1. 把 `streamIdleTimeoutMs` 从 `600000` 调到 **`120000`**：队头最长阻塞从 10 分钟降到 2 分钟。
2. 把 `maxConcurrentTurns` 设为 **`1`**：全局一次只跑一条请求，超出的先进先出排队（升级后立即可用，最省心的止血开关）。
3. `sendMode` 改 **`approved`**（全自动发送）：去掉"等人点发送"这个 10 分钟级的空白等待。
4. `review.enabled=false` 或 `maxRounds=0`：少一整轮网页回合（自审也占会话锁/并发名额）。
5. 一次只派**一个**子代理，且别在子代理干活时给主会话发新消息（等于人工串行）。
6. 关掉 `liveThinking`（省轮询，不解决阻塞）。

---

## 7. 修复落地后"还会慢"的排查清单

修复解决的是**跨会话互相阻塞**与**永久卡死**；下面这些是"同一会话内部的合法等待"，出现时按表排查，不要误判成同一个 bug：

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 同一会话发第二条消息后要等前一轮结束 | 网页对话必须串行（设计如此），日志有 `会话 … 排队中` | 正常；要并行请让它派子代理（子代理是独立会话） |
| 不同会话也要等一会才开始 | 全局并发名额已满（`maxConcurrentTurns`），日志有 `并发上限 N 已满 … 排队中` | 正常排队；调大 `maxConcurrentTurns`（并同步调大 `maxSessionPages`）或保持 1 做全局串行 |
| 每轮都看到 `initialize=true` + 日志"重建工作网页对话并回放检查点" | `isConversationActive` 为假（页被回收/关闭/归属变化） | 属预期重建；若频繁出现说明 `maxSessionPages` 太小或网页被手动关闭 |
| 首轮要等约 1.8 秒才开始出字 | 新建网页对话（点击新对话 800ms + 兜底 goto 1000ms + 编辑器等待） | 正常；同会话热复用仅 1ms |
| 半自动模式（`sendMode=manual`）停住 | 在等人点"发送"（最长 `streamIdleTimeoutMs`，默认 600s） | 点发送；或改 `sendMode=approved` 全自动 |
| 真实卡住超过 `maxStreamMs` | 看门狗会打日志并取消回合，请求以 `WEB_TURN_ABORTED`/`WEB_TURN_TIMEOUT` 结束 | 看日志定位是频控 429、网页未响应还是登录失效（`WEB_LOGIN_REQUIRED`） |

---

## 附录 A：本次排查用到的复现/取证脚本

| 文件 | 作用 |
| --- | --- |
| `tools/concurrency-check.ts` | **已入库的并发回归**（5 条契约：跨会话并行/同会话串行/放弃生成取消/辅助并行/锁租约），`npm run test:parsers` 会跑 |
| `.tmp-audit/verify-current.ts` | 审计者独立黑盒复核（V1–V18，18/18 PASS），不复用我的用例 |
| `.tmp-audit/repro2.ts` | 真实 adapter + 假 channel：父子并发串行化、abort 三阶段、锁泄漏复现（**核心证据**） |
| `.tmp-audit/exp2-adapter-lock.ts` | 旧实现跨会话串行 + 辅助请求排队 + 单页归属翻转三组对照实验 |
| `.tmp-audit/exp3-session-flip.ts` | 旧实现"每轮重建网页对话 + 全量回放"量化（4 轮 4 次重建，回放 1499 字 vs 408 字） |
| `.tmp-audit/exp1-lock.ts` | AsyncLock 属性压测：互斥/公平/abort/漏释放/重入（abort 越权猜想被证伪） |
| `.tmp-audit/measure-overhead.ts` | 冷启动/热复用/第二会话的初始化耗时实测 |
| `.tmp-lead/asar-extract.mjs` | 从 `app.asar` 抽取 DSH 运行时源码 |
| `.tmp-lead/unzstd3.mjs` | 还原多 frame zstd 的 DSH 会话日志 |

## 附录 B：DSH 侧关键行号索引

| 事实 | 位置 |
| --- | --- |
| LLM 运行时无锁、纯派发 | `dsh-llm/lib/index.js:952-957, 2309-2381` |
| abort 只在收到 chunk 后检查 | `dsh-agent-loop/lib/index.js:1088-1092` |
| 子代理 = 同 ctx 子 Agent，继承 provider/model | `dsh-subagent/lib/index.js:304-331, 1809-1824`；`dsh-agent/lib/index.js:453-457` |
| subagent 工具不等待子代理 | `dsh-tool-subagent/lib/index.js:441-482` |
| compaction 走 `purpose:'compaction'` | `dsh-compaction-basic/lib/index.js:320` |
