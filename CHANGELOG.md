# 更新记录

## 0.7.1

- **修复 0.7.0 发布产物缺少 `withTimeout` 定义导致的整轮崩溃**。0.7.0 给 deepseek 网页回合补流式超时兜底时，`src/playwright-channel.ts` 调用了 `withTimeout(...)`，但 import 块里只引入了 `setBrowserWindowTopmost` / `launchManagedBrowser` / `sendEditorMessage`，漏了 `withTimeout`。tsdown/rolldown 打包不做类型检查，产物里只剩 `function withTimeout$1(...)` 的定义、调用点仍写 `withTimeout(...)`，于是**任何 deepseek-web 回合一收到响应就抛 `ReferenceError: withTimeout is not defined`**，用户侧表现为「已收到网页完整回复，正在解析…」之后立即失败。发布包 `dsh-deepseek-web-xxxxxgold-0.7.0.tgz` 与 npm 上的 0.7.0 都带着这个缺陷，已确认（解包后 `lib/index.js:5110` 引用 `withTimeout`，定义只有 `withTimeout$1`）。本版补上 import 并重新打包，产物中调用点与定义同名一致。同时把 `Config` 接口补齐 `longTextAsFile` / `longTextFileThreshold` 两个字段（schema 早就有，接口漏声明，配置页与类型检查都对不上），修掉 `recordLedger` 的 `TS1064`（`async` 方法返回类型写成 `void`），并补 `tsconfig.json` + `@types/node` 让 `npx tsc --noEmit` 能跑起来——这类「产物能打包但类型对不上」的洞，靠 esbuild 是拦不住的。

- **实时思考流不再因打包器注入的 `__name` 整段失效**。0.7.0 的页面网络镜像（`ensureCapture`）是把闭包 `toString()` 序列化后送进页面执行的，而 rolldown/tsdown 默认开 `keepNames`，会把闭包里的函数表达式改写成 `__name(fn, "…")`——页面上下文里没有 `__name`，注入整段抛 `ReferenceError: __name is not defined`，表现为最终回复正常但 `reasoning` 全程空白（真机 `tools/manual/probe-send.ts` 复现）。现在注入前先用**字符串形式**（不经序列化改写）补一个同语义垫片 `window.__name = window.__name || ((fn) => fn)`，思考流恢复逐字回传。新增 `tools/capture-shim-check.ts` 并入 `npm run test:parsers`：断言垫片存在于 `ensureCapture` 且在镜像闭包之前、必须是字符串形式、且构建产物 `lib/index.js` 里逐字保留。


## 0.7.0

- **长正文不再硬塞进输入框：超过 12 万字改走文件附件**。网页输入框填字代价随文本长度接近二次方增长（实测 30 万字符约 13 秒、60 万约 77 秒、110 万字符能把主线程拖死数分钟），一轮二十几万字的任务光填字就要十几秒，还容易把首响应等待窗口吃掉。现在 `longTextAsFile`（默认开）在正文达到 `longTextFileThreshold`（默认 120 000 字）时，把完整正文写成 `dsh-turn-<时间戳>.md`，走同一个 `input[type=file]` 上传，输入框只填一段摘要：首行写明字数与附件名、保留开头 3000 字、中间省略、结尾要求模型先读附件再执行。网页端 `accept` 实测支持 `.txt/.md/.csv/.json/.log` 等文本格式。文件没挂上时（找不到输入框、解析失败）通道回退为直接填完整正文，不会把这一轮变成空发：`BrowserTurnRequest.fallbackText` 承载这份兜底正文，`BrowserImageAttachment.kind` 区分图片与文件附件，幂等判断对文件卡片改看容器文本而不是 `img[alt]`。新增 `tools/long-text-check.ts`：摘要形状、140k 字触发文件、3k 字不触发、关闭开关不触发四组断言。
- **网页回合不再全程静默，也不会无限挂在「深度求索中」**。三个缺陷叠在一起：① `sendAndWait` 拿到 `POST /chat/completion` 后裸 `await response.finished()` / `response.body()`，SSE 连接半开时永远不落定，只能等外层 `turnTimeoutMs`（15 分钟），而报错文案还是「10 分钟内没有等到网页的响应流」；现在两处各套 `streamIdleTimeoutMs` 超时，超时抛 `WEB_STREAM_STALLED` 并列入可重试集合（与 `kimi-channel.ts:572` / `glm-channel.ts:193` 的既有写法一致）。② 完成信号原来只认 HTTP 层，现在页面注入的镜像流一报 `done` 就判本轮完成，与 HTTP waiter 一起进 `Promise.race`，不必再等 body 落地；配 2 秒稳定窗，避免「done 早于末帧补丁」。③ 正文要等整轮结束才由 `replyChunks` 统一产出，中途界面零输出；现在每 2 秒发一条「网页正文已生成 N 字」提示（累计 60 字起报），长回复期间能看到在动。没有把正文写进 reasoning 块：那会撞内容块水位，并被 `tools/adapter-output-check.ts` 判成污染。
- **同一张图不再重复上传：网页端对重复 `ref_file_ids` 是整轮拒绝**。`renderNewWebMessages` 每轮都把增量消息里的 image 块收进 `collectedImages`，历史回放、压缩后重现都会让同一张图再次出现，而网页端一旦收到重复的 `ref_file_ids` 就整轮失败，且该会话此后每轮都失败。现在 `WebChatState.uploadedImageIds` 记录当前网页对话里已经挂上去的附件 id（`SessionRegistry` 读取时按字符串过滤并去重），增量轮跳过这些 id，`replay`（重建对话）不跳过、要全量重传；通道在 `BrowserTurnResult.uploadedImageIds` 回报本轮真正挂上去的 id，适配层据此合并——`initialize` 轮直接覆盖为本轮集合，普通轮并入。`driveTurnAuto` 的 `contextLengthExceeded` 分支重建对话时同时清空，保证重试轮的附件会重新上传。
- **managed 启动不再被 Edge 自己的启动页抢走导航**。`launchManagedBrowser` 启动 Edge 时原来没把目标地址传进去，浏览器打开默认的 `ntp.msn.cn/edge/ntp` 启动页并写进会话文件；进程被强杀后再启动，Edge 按崩溃恢复把这个标签重新拉起来，插件又恰好取 `pages[0]` 对它 `page.goto`，就被它自己的重定向顶掉，报 `Navigation ... is interrupted by another navigation`。Playwright 原始错误没有错误码，`retryability()` 判为 unknown，宿主不会重试，用户直接看到「本轮运行失败」。现在启动参数带上目标 URL（与 attach 模式的 `tools/browser-keeper.mjs` 一致），`ensureReadyCore` 选页优先目标 origin、没有就新开标签，`ensureChatPage` 对导航竞争按 0.5s / 1.5s 退避重试，仍失败抛 `BROWSER_NAVIGATION_INTERRUPTED` 并列入可重试集合，宿主会再给一轮。
- **分段标记改回中文，括号换成全角【】**。0.6.0 为了让标记不被网页输入框那一步 markdown 序列化转义，把标记全换成了 `DSHWEB-*-V1` 纯字母，实际用起来在网页端和会话记录里都认不出是什么。现在标记是 `【宿主系统指令】` / `【宿主上下文：kind】` / `【历史助手回复】` / `【用户消息】` / `【当前用户任务】` / `【任务接续】`：全角括号不参与 markdown 语法，不会被转义成 `\[…\]`，文字仍是中文，一眼能看出这是宿主注入的分段而不是用户说的话。`DSHWEB-*` 和 0.5.x 的半角方括号标记都留在 `LEGACY_MARKERS` 里继续识别，已有会话不需要重放。新增 `tools/marker-shape-check.ts` 并入 `npm run test:parsers`：断言七种标记形状都是全角且不含半角方括号，并逐条验证新标记、0.6.0 纯字母标记、0.5.x 方括号标记三类的正文归类（系统指令/任务锚点/接续提示不算正文，历史/用户消息/宿主上下文算正文）。
- **网页回复解析去掉一处 O(n²)：正文里堆代码块不再拖慢解析**。`extractJsonObject`（`src/response.ts`）原来对每个 `{` 起点都重扫到文本结尾，模型在回答里塞大段代码或未闭合花括号时，16 KB 输入要 169–205 ms；现在先做一次 `}` 存在性预检，候选起点超过 64 个时只取首尾各 32 个（工具调用通常在最前面或最末尾），同一输入降到 0.1 ms 级，20 KB 散文 + 末尾 actions 的常见形态保持 0.02 ms。语义不变：每个候选仍从干净的括号/字符串状态起算，落单引号不会污染后续候选。新增 `tools/json-extract-check.ts` 并入 `npm run test:parsers`：11 条固定形态 + 5000 条随机文本与旧实现逐条比对，并断言病态输入 < 50 ms、常见输入 < 5 ms。
- **模型改用 XML 标签包工具调用时，不再被当成最终回答吞掉**。网页端偶尔不按协议输出 `{"actions":[…]}`，而是 `<tool_call>{"name":"read","arguments":{…}}</tool_call>`（本机会话 `ddb4d8e2` 的真实输出）。旧解析器不认这个标签：`parseWebReply` 判 `hasActions: false`，`looksLikeIntendedToolReply` 也判 false，于是既不解析、也不触发纠错，整段 XML 直接当回答交给用户——任务实际没执行，用户只能重说一遍，白烧一整轮网页往返（实测单轮中位 15.5 秒、p90 80.8 秒）。现在 `parseWebReply` 在 DSML 之后、`extractJsonObject` 之前新增 `parseXmlToolCall`：认 `tool_calls` / `tool_call` / `function_calls` / `function_call` 四种标签，工具名取 `name` 或 `tool`，参数取 `arguments` / `params` / `parameters`（`arguments` 是 JSON 字符串时二次解析），支持单对象与数组两种形态，`xml` / `json` 围栏会先剥掉；**要求整条回复就是这个标签**，散文里提到标签不算，避免误吞正文。标签内 JSON 坏了或没有工具名时不解析，但 `looksLikeIntendedToolReply` 新增了标签识别，让它走纠错重问，不会再静默当答案。新增 `tools/xml-toolcall-check.ts` 并入 `npm run test:parsers`（18 项断言）；拿 57 条真实历史回复回放，只多解析出这一条，其余判定完全不变。

## 0.6.0

- **并发默认值从 2 改成 1：网页端的频控按账号结算，不是按标签页**。旧默认允许同账号两条生成同时飞，这正是外部实测「不到 6 分钟触发 1 天临时封禁」的条件。多会话仍然各占自己的浏览器标签页（互不遮挡、各自的锁），只是同一时刻只有一个在真正打网页，其余按先进先出排队。想更并行仍然可以手动调高，代价写在 `docs/ADVANCED.md`。
- **新增账号级冷却阀 `rateLimit.accountCooldownMs`（默认 10 分钟）**。自动重发用尽后，这把锁挂在**账号**而不是通道实例上：冷却期内所有会话都不再向网页发请求，直接报 `WEB_ACCOUNT_COOLDOWN` 并说明剩余时间。以前一个会话被限流后别的会话照打网页，等于在冷却期里继续制造请求密度。锁跨实例存在，改配置或热重载都绕不过去。
- **重试预算从「单回合计数」升级成「30 分钟滚动窗口 3 次」**（`src/retry-policy.ts`）。单回合的 `maxRetries` 都合规、叠起来就是机器密度——竞品记录过 22 分钟 49 次请求导致账号吊销。现在窗口用尽后明确报 `WEB_RATE_LIMITED` 并附原因，不再无限重试。
- **错误码分成四类，只有限流与被限才进冷却**（`src/cooldown.ts`）：`rate-limit` / `account-blocked` / `login` / `network`。断网、超时、5xx 一律不进冷却——一次网络抖动不该锁死账号十分钟。新增 `WEB_ACCOUNT_COOLDOWN` / `WEB_ACCOUNT_BLOCKED` / `WEB_LOGIN_EXPIRED` / `WEB_UI_CHANGED` 四条人话提示。
- **新增 `npm run doctor` 本机体检**（`src/doctor.ts` + `tools/doctor.ts`）。逐项检查浏览器可执行文件、profile 可写性、登录态、输入框与发送按钮选择器、CDP 端口、当前节流参数、以及「磁盘上的构建标识 vs 实际加载的构建标识」。`✓ / ! / ✗` 前缀，末行 `Doctor result: ready|not ready`，退出码 0/1。`--offline` 只跑静态项。设计上只报事实不做修复；本地证明不了的事（比如账号有没有被限流）一律 warning，不假装全绿。
- **新增只读调用台账**（`src/ledger.ts`）。按天记录每次网页调用的时间、用途、结果、失败分类与耗时，滚动保留 7 天，**不记录对话内容与凭证**。两个关键指标：相邻对话间隔（最短 / 中位 / p90，只算成功的 `chat`）与失败分类分布。文件损坏时从空台账开始，绝不影响真实发送。台账文件与状态文件同目录（自定义 `stateFile` 时跟着走），所以离线回归跑出来的数据不会混进用户真实台账。设置页底部新增只读卡片展示这些数字，外加一个「运行自检」按钮。
- **设置页新增「登录探活」分组**：启动 20 秒后、之后每 30 分钟只读检查一次网页登录态，不发送、不消耗额度。失效只提醒不拦发送；浏览器没启动时只记「无法判断」，绝不为了探活把浏览器拉起来。
- **工具目录加了字符预算 `maxToolCatalogChars`（默认 28000）**。超预算时先逐条退让，并在末尾**点名列出被省略的工具**——静默砍工具会让模型表现成「不会用工具」，竞品为此专门吃过 61 个工具被砍掉 26 个的亏。`0` 不限制。
- **补上「回合间隔」：上一轮结束到下一轮开始不再零间隔**（`turnGapMinMs` / `turnGapMaxMs`，默认 2000–4000 毫秒随机）。原来的 `sendPauseMinMs/MaxMs` 只夹在「填字完成 → 回车」之间，长任务连续续跑时上一轮结束立刻发下一条，节拍就是 0 秒一条——那是最像脚本的形态。新逻辑按「上一次真正碰网页的回合结束时刻」起算，已过去的时间会扣掉，首轮不等待；节拍器是进程级单例，热重载不会把间隔抹平。成功与失败都记账（失败的重发同样消耗账号配额）。三档风控预设同步带上这个字段。
- **同一张图本轮只上传一次**：按字节 sha256 去重。网页端对重复的 `ref_file_ids` 会整轮拒绝，且该会话此后每轮都失败——这类事故一旦发生只能换会话。
- **页面改版有专用错误码 `WEB_UI_CHANGED`**：输入框找不到且不是登录墙时，报错直接说明「已尝试的选择器：a | b | c，多半是网页改版，先升级插件」，并记录失效选择器，不再是一句干等 15 秒的「未找到输入框」。
- **网页消息的分段标记改成纯字母数字**（`DSHWEB-SYSTEM-V1` / `-CONTEXT-V1` / `-HISTORY-V1` / `-USER-V1` / `-GOAL-V1` / `-RESUME-V1`）。旧版用 `[宿主上下文]` 这类方括号标记，网页输入框在 markdown 序列化那一步会把方括号转义成 `\[…\]`，模型看到的是畸形标记。旧标记保留识别（`LEGACY_MARKERS`），不破坏已有会话。（后续改回中文全角【】标记，见上面「未发布」一节。）
- **发布面补齐**：`package.json` 增加 `engines.dsh`（`>=0.2.0-rc.2 <0.3.0-0`）、`keywords` 与机器可读的 `disclosure` 隐私声明（网络端点、权限、Jurisdiction、retention）。版本号与 README / INSTALL / RELEASING 三处引用一并对齐到 `0.6.0`。
- **离线回归脚本从 28 段扩到 36 段**：新增 `doctor-check` / `cooldown-check` / `retry-policy-check` / `ledger-check` / `tool-catalog-budget-check` / `ledger-route-check` / `login-probe-check` / `pacing-check`，并补上原先在盘上却没进链的 `ack-clock-check`。

## 0.5.0

- **「全自动发送后没收到网页响应」不再是一句糊涂账：回车到底有没有触发，现在有确认**。旧链路按一次回车就开始等响应，等不到 3 分钟报「消息已填入输入框，等待你点击"发送"超时」——这一句把两种完全不同的故障混在一起：消息其实发出去了、网页也答了，只是回来得慢；以及回车根本没生效，消息还躺在输入框里。现在发送改走 `sendEditorMessage()`：先按回车，再读输入框是否被清空、消息区是否出现本轮文本；没发出就点发送按钮兜底；两条路都没成，抛 `WEB_SEND_NOT_TRIGGERED`（提示「回车和发送按钮都没把消息发出去，页面可能改版；需人工检查网页后重试」），并带上每一次尝试的记录（按钮不可用、输入框未清空），不用再靠猜。成功时日志明确写「全自动：已确认发送（方式：enter｜button）」。
- **响应等待窗口从「填字之前」挪到「发送确认之后」**。旧实现的 `waitForResponse` 超时从进回合就开始计时，填字、等新对话、页面重载全算在窗口里；一旦填字变慢，网页还没来得及响应就已经被判超时。现在 `waitForResponse` 挂 `timeout: 0` 无限等，真正的上限由 `startAckClock()` 在发送确认完成那一刻启动，超时文案也分开说：「消息已发送，但 X 内没有等到网页的响应流（HTTP 层未捕获到本轮请求）」与「消息已填入输入框，等待你点击发送超时」。填字慢只会让人等，不会再把成功判成失败，日志里还会提示「响应等待 3 分钟从发送确认完成才开始计」。
- **新增 `maxReplayChars`（默认 400_000）：全量回放历史时给单条消息设上限**。网页输入框填字代价随文本长度接近二次方增长（实测 30 万字符约 13 秒、60 万约 77 秒、110 万字符会把浏览器主线程拖死数分钟），而首响应等待只有 3 分钟——长任务一旦触发全量回放，旧链路就会稳定超时，界面表现正是「网页看着没问题、回复也出来了，dsh 报没收到响应」。现在超出预算时按消息粒度丢弃最早的历史，在原位留一行「[历史过长已省略：…请以当前任务与最近上下文为准继续推进。]」，最新一段自己就超预算时改为截断保留尾部；系统指令与协议清单不计入预算、也永不裁剪。设为 0 关闭该限制。
- **「开启新对话」点击后的确认从固定 800ms 改成轮询 3 秒**。网页是 SPA，点击到地址栏更新常要 1~3 秒，旧逻辑 800ms 没看到 URL 变化就判定失败、回退去整页重载入口页；重载后前端还在初始化，紧接着填字有被前端状态覆盖成空的可能，回车等于空发。现在按 200ms 轮询等地址真正变化，仍不变才回退重载。
- 新增离线回归 `tools/send-confirm-check.ts`（并入 `npm run test:parsers`，16 项，跑在真实 Playwright 页面对象上）：回车即发送、回车换行改走按钮兜底、按钮不可用判未发送并记录两轮尝试、网络先发、输入框为空判未发送。另加真机脚本 `tools/live-send-retry.ts`：在真实 chat.deepseek.com 上跑一遍「填入 → 发送确认 → 等响应 → 取正文」，逐步打时间戳，90 秒硬闹钟防挂死；实测连续五轮均成功（10.9s / 13.0s / 12.5s / 7.6s / 8.6s 收到响应，正文「链路正常」），日志均含「已确认发送（方式：enter）」。
- **Kimi 与 GLM 审核通道有同一处错位，一并根治**：两个通道原先也都是把「等响应」的超时挂在填字之前（`min(streamIdleTimeoutMs, 120_000)`），且同样只按一次回车不看结果。审核提示词动辄几万字，形态与 deepseek 通道完全一致——填字吃掉窗口、消息其实发出去了、插件报超时。现在两个通道都改成 `waitForResponse(..., { timeout: 0 })` + `startAckClock()`（新增 `KIMI_ACK_TIMEOUT_MS` / `ACK_TIMEOUT_MS`，各 120 秒，只覆盖发送确认之后那一段），发送改走 `sendEditorMessage()`，发不出去分别抛 `KIMI_SEND_FAILED` / `GLM_SEND_NOT_TRIGGERED`。只修 deepseek 一个通道等于只堵一个口子。
- 新增离线回归 `tools/ack-clock-check.ts`（并入 `npm run test:parsers`）：对 deepseek / Kimi / GLM 三个通道逐个断言「发送路径的 `waitForResponse` 不带有限超时」「发送确认在启动计时之前」「超时被纳入竞速」「计时器在 finally 里被清除」，外加一条计时语义的实测量化。这条护栏做过变异测试——把 Kimi 的 `{ timeout: 0 }` 改回 `{ timeout: 120_000 }`，测试立刻两项失败、退出码 1，还原后重新全绿，说明它真的能挡住回退。
- **「改了代码、重启了、线上还是老行为」这个坑也一并堵死：部署脚本 + 依赖改指向本地 tgz**。桌面 DSH 加载的是 `~/.dsh/profiles/desktop/node_modules/dsh-deepseek-web-littlecar30/lib/index.js` 这份**已安装副本**，跟仓库 `lib/` 是两个文件，重启只换进程不换代码；更狠的是 profile 里原来写着 `github:xxxxxgold/dsh-deepseek-web`，插件管理器任何一次安装/更新都会触发 pnpm 重算、把这个包整体刷回上游 0.3.4 旧版（实测 19:06:38 发生过：238KB 修复产物被换成 207KB，`startAckClock`、`WEB_SEND_NOT_TRIGGERED`、`maxReplayChars` 全没了）——这才是「同一个错误一直出现」的机制级根因。现在新增 `tools/deploy-local-profile.mjs`（`npm run deploy:local`）：`npm pack` 打成文件名带产物哈希的 tgz → 把 profile 依赖声明改成 `file:` 指向它 → 用 DSH 自带 pnpm 安装 → 逐字节校验装进去的就是仓库产物并打印构建标识。实测部署后再跑一次 `pnpm install`，哈希与构建标识均不变（旧声明下同样的操作会掉回 0.3.4），免疫复发。选 tgz 而非 `link:` 的原因：link 会把包真实路径落在仓库内，Node 解析 `@deepseek-ai/*` 会命中仓库里的旧副本，与宿主那份不是同一模块实例。
- **新增构建标识与加载戳，让「到底加载了哪份代码」可自证**。`src/build-info.ts` 提供 `BUILD`（构建期由 `tsdown.host.config.ts` 注入 `版本号+UTC时间戳`）与 `writeLoadStamp()`：插件注册时在 `%LOCALAPPDATA%\DshDeepSeekWeb\loaded-build.json` 写出 `{build, module, pid, at}` 并打日志。以后再怀疑「是不是没生效」，读这个文件即可——本次已实测宿主启动时确实写出 `{"build":"0.5.0+20261022T114844","module":"...\\profiles\\verify-load\\node_modules\\dsh-deepseek-web-littlecar30\\lib\\index.js"}`，证明加载链路真实可用。当前已部署进桌面 profile 的构建标识是 `0.5.0+20261022T125156`（sha256 `991235E9…`），重启后该文件应写出这个值。
- **防风控「长休」区间默认值收窄到 30–60 秒**。`longRunPauseMinMs` / `longRunPauseMaxMs` 默认从 `60_000` / `180_000` 改为 `30_000` / `60_000`：连发满 `longRunAfterSends`（默认 15）轮后静默 30–60 秒已足以打断稳定节拍，旧默认最长白等 3 分钟，长链路任务代价过高。设置页「均衡」预设同步改为 30–60 秒（否则默认配置不再命中该档），两处字段说明与 `docs/ADVANCED.md` 配置表一并更新。
- **「按下回车 → 看到响应头」的等待上限单独封顶 3 分钟，`streamIdleTimeoutMs` 默认仍是 600 秒（10 分钟）**。`streamIdleTimeoutMs` 语义是网页流空闲超时，默认值保持 `600_000` 不变；真正收紧的是自动发送时这一段首响应等待——现在取 `min(streamIdleTimeoutMs, SEND_ACK_TIMEOUT_MS)`，即最多 3 分钟就报准确定位，而不是一条死流把队头堵满 10 分钟。人工发送（`sendMode: manual`）本来就要等人点按钮，固定给足 `SEND_ACK_TIMEOUT_MS`（3 分钟）。审核通道的 `review.streamIdleTimeoutMs` 同为 `600_000`（10 分钟），只把审核「首响应」额外封顶 2 分钟（`glm-channel.ts` 原本没有上限，这次补上）。`docs/ADVANCED.md` 的配置表同步更新。
- **浏览器或网页标签被关掉时，先提示、再自动恢复、然后把这一轮重发出去**。以前这类事故在 `turn()` 入口就被判死：`state.page.isClosed()` 直接抛 `WEB_PAGE_CLOSED`，你在 DSH 里只看到一句「本轮运行失败」，得自己去翻日志才知道是浏览器没了；回合跑到一半被关更糟——报错来自 Playwright 底层（`Target page, context or browser has been closed`），连错误码都没有。现在 `turn()` 外面套了一层自愈循环：捕获到关闭类错误 → 发一条 `[DSH] 恢复 · …` 提示 → 清掉失效的页与连接 → `ensureReady()` 重新拉起 → 重新取会话页 → **重发本轮消息**（最多 2 次，默认间隔 2 秒）。
- **区分「只关了标签页」和「整个浏览器没了」，不搞一刀切重启**。`recoverBrowser()` 先看 `browser.isConnected()`：还连着就只补标签页、保留浏览器对象（不能因为一个标签页关掉就把你其它窗口一起关掉）；整个浏览器退出了才释放 `browser` / `context` / `managedConnection`，`browser.close()` 与 `process.kill()` 都做了容错，然后重新走 launch/connect。两条路径的提示文案也不同（「正在重新打开标签页」vs「正在重新启动浏览器」），因为它决定了这次恢复要等多久。
- **自愈只认「被关掉」，不吞别的错误**。判定由 `browserClosed()` 三路合成：`WEB_PAGE_CLOSED` 错误码、`isBrowserClosedMessage()` 对报错原文的模式匹配（`Target page/context/browser … closed`、`Browser has been closed`、`has been disconnected`、`Connection closed`、`连接已关闭/断开`）、以及 `browser.isConnected() === false`（连接已死时任何错误都按可自愈处理，在死连接上重试没有意义）。频控、回合超时、手动取消、HTTP 错误一律照原样抛出——否则「一直重启浏览器」会把真正的频控冷却掩盖掉。
- **恢复提示走独立的 `recover` 事件，且不节流**。等待期提示本来有 500ms/1000ms 节流，但恢复只有三条状态（开始、重启前等待、已就绪），每一条都必须能被看到，所以 `recover` 的节流阈值设成 0。提示文案带「第 n/m 次」，连续被关也能看出这是第几次恢复；提示在设置页可关（跟接收侧提示同一组开关），但**关掉提示不影响自愈本身**。
- **回合开始前就被关掉也补提示**。`turn()` 入口先记下 `healthyBefore`（浏览器当时是否连接）和 `closedPageBefore`（锚点页当时是否已关），`ensureReady()` 之后若发现是被自动修好的，补一条「网页标签已被关闭，已自动重新打开」/「浏览器已被关闭，已自动重新启动并打开网页」——否则用户只会看到回合莫名其妙成功了，不知道中间出过事。
- **设置页新增「浏览器自愈」分组**：`browserRecovery.enabled`（默认开）、`maxAttempts`（默认 2，0–5）、`delayMs`（默认 2000ms，0–60000）。`maxAttempts` 的说明写清为什么默认只有 2 次：连续被关超过两次通常不是手滑，而是有东西在反复杀进程，这时候把原始错误抛出来比无限重启有用。
- 新增离线回归 `tools/browser-recovery-check.ts`（并入 `npm run test:parsers`）：6 条关闭类样本必须命中、4 条非关闭样本（频控中文、回合超时、取消、HTTP 500）必须不命中；再用原型实例直接验通道——`WEB_RATE_LIMITED`/`WEB_TURN_TIMEOUT` 不触发自愈、浏览器断连时任意错误都触发；`connected=true` 时 `ensureReady` 恰好调一次、`browser` 必须保留、会话页登记清空、首条提示是「网页标签被关掉了…（第 1/2 次）」、末条是「浏览器已就绪，正在重新打开网页并重发本轮消息」；`connected=false` 时 `browser`/`context`/`managedConnection` 全被放掉、首条提示是「浏览器被关掉了…（第 2/2 次）」；把提示总开关关掉后提示 0 条但 `ensureReady` 照常调用。
- 另加真机脚本 `tools/manual/browser-realcheck.ts`（手动跑，不进 CI，因为它会真的起一个 Edge 再杀掉）：实测 Playwright 的真实关闭报错文本 `page.evaluate: Target page, context or browser has been closed` 能被 `isBrowserClosedMessage()` 识别；被杀的进程能在同一 profile 上重新拉起（约 1.0–1.2 秒，新 pid）；真通道 `recoverBrowser()` 的两条分支都跑通——重启分支换新 pid 并发 3 条恢复提示（「正在重新启动浏览器（第 1/2 次）」→「0.5s 后重新启动浏览器，本轮消息会自动重发」→「浏览器已就绪，正在重新打开网页并重发本轮消息」），补页分支保持同一 pid 只补标签页。顺带确认一个坑：**Chromium 关掉最后一个标签页会连浏览器一起退出**，所以「关了一个标签页」到底走补页还是重启，取决于当时还有没有别的页。

## 0.4.0

- **频控重发从「30 秒硬撞 5 次」改成指数退避，默认覆盖真实冷却期**。旧默认 `retryDelayMs=30_000`、`maxRetries=5` 一共只等 150 秒，而实测「发送过于频繁」多数要 10–15 分钟才恢复——等于在冷却期里又连撞 5 次，撞完报错，下次请求继续撞。新默认 `retryDelayMs=60_000`、`maxRetries=4`、`backoff=exponential`、`retryMaxDelayMs=300_000`、`jitterRatio=0.15`：等待序列 60s → 120s → 240s → 300s，合计 720 秒，正好落在常见冷却期中段，且总时长仍小于 `turnTimeoutMs` 的 900 秒，不会被回合上限提前截断成「超时」这种误导性错误。不同实例的等待还带 ±15% 抖动，避免同一账号多标签在同一秒一起重撞。
- **等待期间终于有提示了，而且提示走的是能真正送到 DSH 的通道**。以前 `liveThinking: false`（默认）下 `onProgress` 根本不触发，等待期间界面一片静默，提示只有浏览器标签标题。现在新增独立的 `onNotice` 通道：频控等待、重发、发送、接收、完成、失败都会变成一条 reasoning 提示块，前缀 `[DSH]`（审核流程是 `[DSH·审核]`），可折叠、不进正文、不进模型上下文。频控等待期间，进入等待报一次「X 后自动重发」，之后每逢整分钟和最后 30 秒各报一次「还需要 X」（逐秒刷会把 12 分钟变成几百行噪音）；浏览器右下角则逐秒更新一个 `pointer-events: none` 的倒计时浮层（`#dsh-web-notice`，不挡点击），标签标题继续写 `[dsh 频控：1m 后自动重发]`。
- **全部错误都翻成人话加处理建议**。`src/notify.ts` 的 `describeFailure()` 覆盖 50 个错误码（`WEB_*`、`BROWSER_*`、`KIMI_*`、`GLM_*`、`UNKNOWN_MODEL` 等），每条都写「接下来怎么办」而不是把 code 再念一遍；表外错误回退到原文（截 120 字），宿主气泡里的完整原文不受影响。
- **会话提示与审核提示分开**。审核（自审 / Kimi / GLM）在正文之后单独成块，前缀 `[DSH·审核]`，不再和主对话的发送/接收提示混在一条里；审核通道自身失败也会留下一条说明（「审核失败，已跳过本轮审核」），而不是静默跳过。
- **提示可在设置页逐层关闭**。新增 `notify` 配置段：总开关 `enabled`、分类开关 `session` / `review`、事件开关 `send` / `receive` / `errors`、浏览器浮层 `browser`；`rateLimit` 段从 3 个字段扩到 6 个（新增 `backoff`、`retryMaxDelayMs`、`jitterRatio`）。两个分组在设置页都有中英说明。
- `tools/rate-limit-check.ts` 从「只验证频控文案识别」扩到「识别 + 退避序列 + 提示文案」：断言默认序列恰好是 `60000/120000/240000/300000/300000`、`fixed` 曲线恒为基数、抖动边界 8000/12000、下限 1000ms、会话与审核前缀必须不同且不相等、7 个开关逐层生效、`formatDuration(60000)='1m'`，并扫描 `src/*.ts` 抓出全部错误码逐个要求 `describeFailure` 给出人话——新增错误码却忘了写提示会直接失败。当前覆盖 50 个码。
- 新增 `tools/notice-check.ts` 守提示链路本身：用脚本化假通道跑完整 `adapter.stream()`，断言 `liveThinking=false`（默认）时提示照样成为一个 reasoning 块、按到达顺序换行拼接、正文块里不含 `[DSH]`、提示块排在正文之前；再借原型直接验通道层——同一事件连发被节流、`session=false` 时会话静默而审核照发、`send=false` 只留接收、总开关关闭一条都不发。

## 0.3.4

- **项目模式改成「只填项目 ID」**。上一版要求填一整条项目页地址（`https://www.kimi.com/project/<ID>?chat_enter_method=new_chat`），抄起来容易错、还容易把项目名当成地址、换个域名要改两处。现在设置页那一栏就叫「项目 ID」，只填 `/project/` 后面那一段（形如 `1a15bef4-b7a2-894f-8000-0e7143648841`），插件用「正常模式链接」的域名拼成完整项目页地址再打开——企业版域名跟着正常模式走，不用两边都改。
  三种输入都有明确归宿：只填 ID → 自动拼接；填完整链接（以 `http(s)://` 开头）→ 原样使用，老配置不用改；明显不是 ID 的内容（带空格、中文说明、多段路径）→ 抛 `KIMI_PROJECT_ID_INVALID` 并写明该填哪一段，而不是拼进路径里打开一个 404。留空仍是 `KIMI_PROJECT_URL_MISSING`。
- 真机验证「只填 ID」的完整链路：解析出的入口是 `https://www.kimi.com/project/1a15bef4-…?chat_enter_method=new_chat`；回合结束后拿 chat id 回项目页查，这条对话以 `a.project-feed-link` 出现在 `div.project-chat-list` 里，href 带 `chat_enter_method=project`——确实归档到该项目下。
- `tools/kimi-mode-check.ts` 从 11 项扩到 16 项：新增只填 ID 自动拼接、域名跟随正常模式链接（企业版域名）、ID 带前导斜杠/首尾空白也能拼对、非 ID 输入抛 `KIMI_PROJECT_ID_INVALID` 且带填法、正常模式不会误用项目字段。

## 0.3.3

- **Kimi 审核支持「正常模式 / 项目模式」两种入口，在设置页可选**。项目模式不是"换个入口地址"而已：实测从项目页发出的对话会作为 `a.project-feed-link` 出现在项目页的 `div.project-chat-list` 里，链接带 `chat_enter_method=project`，确实归档到该项目下。之前只有一个 `review.url`，把项目页填进去能用、但和普通对话是同一套语义，配置里也看不出区别。现在新增 `review.kimiMode`（`normal` 默认 / `project`）与 `review.projectUrl`：正常模式走 `review.url` 开独立新对话，项目模式走 `review.projectUrl` 开项目页、对话归到该项目下。两者**各用各的地址、互不兜底**——选了项目模式却没填链接会直接抛 `KIMI_PROJECT_URL_MISSING` 并写明该填什么，不会静默退回普通对话（审核记录落错地方比明确失败更难发现）。设置页按所选模式联动显示对应那条地址输入框。
- **修复一个会让整轮审核莫名失败的隐蔽 bug**：`turn()` 的重试次数取自 volatile 数值字段 `review.fetchRetries`。该字段在 Loader 尚未提交值时读到的是 `NaN`，而 `NaN ?? 1` 仍是 `NaN`，`Math.max(0, Math.min(3, NaN))` 也还是 `NaN`；于是 `attempt <= retries` 恒为 false，重试循环一次都不进，`lastError` 保持 `undefined`，最后 `throw undefined`——宿主只看到「回合失败」，完全看不出真正原因。现在统一由 `sanitizeRetries()` 收敛：`NaN`/`Infinity`/空串/`null` 回退默认值，负数夹到 0，超过上限截断，小数取整，保证循环次数永远是合法整数。
- **跨模式切换不再发错地方**。实测项目页发出第一条消息后地址会变成 `/chat/<uuid>`、`/project/` 前缀消失，路径上再也分不出归属。所以页面归属改为记「这一页是用哪种模式开出来的」：复用模式（`conversationMode: 'reuse'`）下若发现当前页与所选模式不符，自动按新模式重开一个标签页并打日志说明，不会把正常模式的审核发进项目、也不会把项目的发进普通对话。
- 新增离线回归 `tools/kimi-mode-check.ts`：11 项覆盖重试次数收敛（`NaN`/`null`/空串/负数/超限/小数/字符串/`Infinity`）、两种模式入口各取各的地址且不互相兜底、项目模式缺链接抛 `KIMI_PROJECT_URL_MISSING` 且带排查指引、页面归属的四种判定（跨模式不符 / 同模式相符 / 跨站页面 / 来源未知不重开）、以及配置默认值本身，并入 `npm run test:parsers`。

## 0.3.2

- **审核窗口地址变成可配置项，并且默认带建新参数**。原来 `review.url` 只有代码里的默认值 `https://www.kimi.com/`，设置页看不到也改不了，通道拿到它之后自己拼 `/?chat_enter_method=new_chat`——等于"链接"这件事对用户是隐形的，想换域名、换查询参数、换项目页都无从下手。
  现在设置页在「Kimi 审核」分组里直接给出「Kimi 审核窗口地址」（选中 GLM 时对应显示「GLM 审核窗口地址」），默认值就是带参数的 `https://www.kimi.com/?chat_enter_method=new_chat`；通道不再自行拼串，而是**你填什么就打开什么**，只用一个 `ensureFreshChatUrl()` 兜底：地址里没有 `chat_enter_method` 时补上，已有就一个字不动。这样旧配置（只写了域名）照样能开新对话，而企业版域名、带自有查询参数的地址、项目页都能直接生效。
- **顺带证实并支持了「在 Kimi 项目里跑审核」**。之前担心项目页发消息会掉回普通对话，实测结论相反：`goto` 项目页（`/project/<id>`）后页面停在项目路由，输入框是「在"审核"中开始对话…」，从项目页发出的对话会归到该项目下（项目会话列表里出现对应 chat id，带 `chat_enter_method=project`）。所以把审核地址填成项目页，每轮审核就是"在项目里开一个新对话"。
- 设置页字段新增 `visibleWhen` 联动能力（`src/client/config-fields.ts` 的 `FieldSpec`），只在该字段相关时才渲染，避免"选 Kimi 却摆着 GLM 地址"这类干扰。
- 新增离线回归 `tools/review-url-check.ts`：覆盖裸域名补参数、已带参数原样返回、项目页保留路径、用户自定义查询参数不丢、企业版域名、空串/非法输入不炸、以及配置默认值本身必须已带建新参数，并入 `npm run test:parsers`。

## 0.3.1

- **修复「每轮审核其实还在同一个对话里」**。上一版给 `review.conversationMode` 加了 `fresh`（每次新开对话），但实测没生效：Kimi 的「新建会话」入口是只有一个图标的 `<a aria-label="新建会话">`，标签页在后台时 `locator.click()` 点不动；直接 `goto` 首页又会被站点恢复成上一次的对话。两条路都会静默失败，表现就是"配置了 fresh 却还是同一个对话，越审越慢"。
  现在改为**直接开一个新标签页**，并带上 Kimi 自己的建新参数 `?chat_enter_method=new_chat`——实测新标签打开就是 0 条消息的干净对话（约 3 秒）。旧审核标签在新标签就绪后关闭，任何时候只保留一个 Kimi 审核页，不会一轮攒一个标签（已实测两轮后标签数恒为 1）。关标签失败不会影响本轮审核，但会打警告留痕，避免静默泄漏。
  同时给 `bestEffortNewChat()` 加了 `selectors` / `labels` 自定义候选（选择器优先、文本其次），并明确它返回 `true` 只代表"点到了入口"、不代表新对话真的建起来了——调用方必须自己验证。
- **新增端到端验证脚本 `tools/kimi-live-verify.ts`**：连真实 Kimi 网页跑两轮，用**页面 URL 里的 chat id** 判定是否真的换了对话。不能用"让模型记住某个数字"来判定——Kimi 有账号级长期记忆，换了新对话它照样能答出来（实测思考里写着"memory 中已有一个 id 7 也是记住 47"），用回答判定会得到假阳性。

## 未发布

- **修复 Kimi 审核「文字填进去了、但没发送，必须人工点一下」**。根因是结构性的：`KimiBrowserChannel.turn()` 在 `insertText` 之后只做 `bringToFront` + 改标题 + 打一行日志，**没有任何发送动作**；`ReviewConfig` 里也没有发送方式这一项，`reviewer.ts` 调用 `turn()` 时同样不传 `autoSend`——整条链路按「等人来点」的语义写死。现在补齐三点：`review.autoSend`（默认全自动）决定是自动发送还是只填入等人点，`KimiReviewer`/`GlmReviewer` 据此传 `autoSend`；Kimi 通道实现 `setSessionAutoSend`/`cancelTurn`，发送优先级为「显式请求 > 会话级设置 > 审核默认值」；新增通用能力 `sendEditorMessage()`（`browser-shared.ts`），流程是**回车 → 观察输入框是否清空 → 没清空就点发送按钮 → 再观察**，命中任一信号才算发出（输入框清空 / 外部网络信号 / 按钮转生成态），未确认则按 `sendRetries` 重试并把每次尝试写进错误信息。只按一次回车不够——不同站点/版本对回车的处理不同（发送、换行、被输入法吃掉），这正是「填进去了却没发出去」的另一半原因。
- **修复「开了展示思考，思考到一半就停住，而网页一直在输出到结束」**。根因在实时增量轮询 `startProgressPolling()`：它每拍只取 `window.__dshWebCapture.entries` 的**最后一条**（`.at(-1)`）。一轮生成里网页可能产生多条对话流（断线重连、思考流与正文流分成两条连接），取最后一条会让已结束的那条（通常是思考）整段消失，界面就停在第一拍的增量上而网页继续输出。改为取**全部候选流**并按时间顺序用新增的 `mergeMonotonic()` 合并（超集替换、前缀去重、互不重叠则追加），再由 `takeDelta()` 取后缀增量，非单调增长时只对齐基线、不发负增量。同时在 `adapter.ts` 的 `driveTurn` 补一层兜底：回合结束时用通道返回的完整 `reasoning` 补齐流式阶段漏掉的尾巴——`Kimi`/`GLM` 通道不支持流式思考，以前即使开了「展示思考」也一个块都没有。
- **修复「获取回复时卡住、不会重新获取」**。三处会无限等待的地方都加了边界：Kimi 通道的 `response.finished()`/`response.body()` 本来没有超时参数，流一卡就永远挂着，现在包上 `withTimeout()`（`browser-shared.ts`，超时抛带稳定错误码的 `LlmError`）并**并行**等待两者（原来串行 await，等于把「等流结束」做两遍）；`ensureReady()` 原来只判 `this.browser && this.page` 就返回，页面已被关闭时所有操作都打在一个死页面上，现在改为 `isPageUsable()`（浏览器仍连着 + 页面未关闭），失效即 `dropConnection()` 重建；`turn()` 外层新增重试（`review.fetchRetries`，默认 1 次），只对「环境抖动」类失败重试（等回复超时、空响应、页面/连接断开、发送未确认、流卡住），重试前一律丢弃旧连接并重新 `ensureReady()`，认得出根因的失败（未登录、发送被禁用、找不到输入框、用户取消）直接上抛，不用重试把明确错误拖成更长等待。GLM 通道同步加上流超时。
- **提速**：实时增量轮询从固定 `800ms` 压到 `250ms`（它只读页面里的一个 JS 对象、不发网络请求、不碰 DOM 计算样式，可以跑得比频控检测快一个量级），频控 toast 检测独立保留 `800ms`（要遍历大量 DOM 并逐个读 computed style）；`connectBrowser()` 拉起守护后的探测从「固定 1 秒一跳 × 60」改为「前 3 秒 150ms 一跳、之后 500ms」，常见情况（1~2 秒就绪）能快 3~6 倍，总上限仍是 60 秒；Kimi `ensureReady()` 的固定 `waitForTimeout(1_500)` 改为等输入框可见即返回（`waitEditorReady`），新建对话后的固定 `800ms` 也改成 `settleAfterNewChat`（等输入框 + 120ms 收尾）；主通道 `waitForResponse` 从吃完 `streamIdleTimeoutMs`（默认 600 秒）改为 `min(streamIdleTimeoutMs, 180 秒)`——发送后 3 分钟拿不到响应头一定是没发出去或页面异常，用户不必再等十分钟。
- **审核自动化程度明确成两档**：`review.autoSend` 取代原来的 `review.sendMode` 枚举——`true`（**全自动**，默认）= 填入后自动发送并确认真的发出，发不出去当场报 `KIMI_SEND_FAILED`；`false`（**半自动**）= 只填入并聚焦审核窗口，等你点发送。布尔值比 `approved`/`manual` 这种带审批语境的枚举更直白，设置页直接渲染成一个开关。
- **新增 `review.conversationMode`（默认 `fresh`）**：每次审核前新开一个对话。原因见下一条。
- **（行为变更）Kimi 审核不再永远复用同一个对话**。原来的行为是「填进当前对话框就发」，`initialize` 恒为 `false`，而 `KimiBrowserChannel` 的 `conversationStarted` 一旦置位就再也不新建对话——等于一次会话里所有审核轮次都堆在同一个 Kimi 对话里。这在语义上是「正常」的（审核 prompt 自带协议、任务目标、产出全文和文件清单，本来就不需要历史上下文），但实际有害：上下文越积越长会让审核**越审越慢**（正好放大「响应慢」的体感），长任务上还可能被上一轮的结论带偏。现在默认每轮新开对话，干净上下文、速度稳定；想保留历史把 `review.conversationMode` 设为 `reuse` 即可。实现上补了 `resetConversationGate()` 的正确语义：它只清「已初始化」标记、不动会话级发送设置，`fresh` 模式每轮先清再带 `initialize: true`。
- 新增配置：`review.sendVerifyMs`（自动发送后确认「已发出」的窗口，默认 1500ms）、`review.sendRetries`（发送未确认时的重试轮数，默认 2）、`review.fetchRetries`（获取失败自动重试次数，默认 1，0 关闭）。
- 新增离线回归 `tools/live-delta-check.ts`（`mergeMonotonic` 的超集/前缀/多流拼接、`takeDelta` 的单调与非单调、多拍增量拼回等于累计值，并直接复现「只取最后一条流会丢掉思考」的故障形态）、`tools/watchdog-check.ts`（超时看门狗：正常返回不拖延、超时抛指定错误码的 `LlmError`、内部失败原样冒泡、先完成者不受超时影响、`ms<=0` 关闭超时）与 `tools/send-confirm-check.ts`（用本机 Edge headless 加载假页面，覆盖「回车即发送」「回车只换行须点按钮」「回车无效+按钮禁用」「网络先发但输入框未清空」「空输入框不误触」五种形态，并核对页面内计数器确认真的发出去了），，均并入 `npm run test:parsers`。另新增 `tools/review-config-check.ts`：用假审核通道录下 `turn()` 的真实入参和调用顺序，断言「全自动/半自动确实透传到 `autoSend`」「fresh 会先清会话门控再带 `initialize: true`」「reuse 两步都不做」「旧配置缺这两个键时按全自动 + fresh 处理」「GLM 通道语义一致」「审核提示词里任务/产出/文件三段都在」，防止出现「配置加了但没接线」。
- 超时定时器不使用 `unref()`：`unref` 后若事件循环只剩这个定时器，进程会直接退出、超时永远等不到（独立脚本里表现为 `await` 悬空）。改为普通定时器 + promise 落定时 `clearTimeout`，保证超时一定触发且不留悬挂定时器。

- **新增「风控模式」菜单**：把防风控参数整组搬进设置页，共 7 项可写——`maxConcurrentTurns`（同账号并发上限）、`maxSessionPages`（会话标签页上限）、`sendPauseMinMs`/`sendPauseMaxMs`（发送前随机停顿）、`longRunAfterSends`/`longRunPauseMinMs`/`longRunPauseMaxMs`（连续多轮后的长休）。顶部另有**一键档位**：关闭 / 均衡（推荐）/ 严格——点一下就把相关参数成套写进草稿，手动改其中任一项即显示「自定义」，当前命中的档位会高亮。并发与标签页上限不受档位影响，保持「一号两并发」。插件管理器的行配置页同步支持档位切换。
- 新增离线回归 `tools/risk-config-check.ts`（字段路径与配置 schema 齐平、volatile 标记齐全、三档 apply→match 往返一致、档位不碰并发上限），并入 `npm run test:parsers`。
- **防风控：填入消息后随机停顿再发送**。全自动发送路径在 `insertText` 之后、回车之前插入一段随机停留（`sendPauseMinMs` 默认 2000、`sendPauseMaxMs` 默认 4000，两者为 0 即关闭），页面标题同步显示"已填入，X.Xs 后发送"。固定延迟的方差≈0 本身就是机器特征，所以取区间随机值。
- **防风控：连续请求满 N 轮强制长休**。`longRunAfterSends`（默认 15，0 关闭）配合 `longRunPauseMinMs`/`longRunPauseMaxMs`（默认 60~180 秒）：同一通道连续发满 N 轮后静默一段再继续，模拟"真人不会连轴转几十轮"；连续计数在 10 分钟无请求后自动断开重算，不会让隔天的零散请求累计触发。
- 新增「设置 → DeepSeek 网页」菜单：9 组 34 个可写参数一页配置，走宿主 `configForms` 的原子提交写回 profile 的 `cordis.patch.yml`；草稿态（保存／放弃修改／重新读取）、`Ctrl+S`／`⌘+S`、逐字段校验、逐字段「恢复默认」、保存后回读核对与冲突报错俱全；导航项顺序排在「内置插件」之后。
- 插件管理器的行配置页与设置菜单共用同一份字段规格（`src/client/config-fields.ts`），差量提交与校验逻辑统一：清空的字段用 `unset` 回落默认值，非法值直接拦在页面内。
- 修复插件管理器行配置页误判「当前部署不接受写入」并把全部控件置灰的问题：`ConfigFormSnapshot` 没有 `mode` 字段，原判据 `state.writable === true && state.mode === 'host'` 恒为假；改为只看 `state.writable`。
- `browser`、`channel`、`profileDir` 补标 `volatile`，三者在设置菜单里可改（前两项与 profile 目录重启后生效）；`profileDir` 留空串时回落到运行时默认目录。
- 设置页对老版本 DSH 做了降级：没有 `configForms`／`locale` 服务的宿主里，菜单不出现，插件其余功能照常工作。
- **新增图片直传**：消息里的图片不再被压成 `[图片附件 sha256:…]` 文本标记，而是真正放进网页输入框，由 DeepSeek 网页端自己完成上传并随消息带 `ref_file_ids`，模型直接看到原图。默认开启（`enableImageUpload`），关掉即退回文本标记。
- 系统协议第 8 条随开关切换：开启时告诉模型「附图随本条消息到达、可以直接查看」；关闭时明确「看不到图片内容、需要时调工具、不要猜」，避免模型凭文件名编造内容。
- 上传实现：总字节 ≤45MB 走 Playwright `setInputFiles` 内联传输，更大则落临时文件走 CDP `DOM.setFileInputFiles`（Playwright 跨进程内联有 50MB 硬上限）；等网页端把 `fetch_files` 解析到 `SUCCESS` 才输入文字并发送；同名附件幂等跳过，频控重发不会重复上传；半自动模式下附件在窗口置顶前挂好，避免用户看到输入框就回车导致本轮丢图。
- 附件收集在渲染层完成：本轮增量消息里的 image 块去重后随 prompt 一起返回，replay 全量回放时只取最近若干张，避免重建对话时重传一大堆旧图。
- 新增配置：`enableImageUpload`（默认开）、`maxImagesPerTurn`（默认 4）、`uploadTimeoutMs`（默认 60 秒）、`uploadOnError`（`fallback-text` 默认／`abort`），配置页可直接改。
- 适配器 `listModels` 按开关声明 `inputModalities`（开启时含 `image`），宿主据此放行 ImageBlock；宿主没有附件服务时自动退回文本标记，不影响插件加载。
- 新增离线回归 `tools/image-upload-check.ts`（占位文本、协议分支、收集去重与上限、增量/replay 选择），并入 `npm run test:parsers`。
- 修复主会话与子代理并发请求时互相卡住：请求锁从"全进程一把"改为按 dsh 会话隔离，不同会话（主会话与它派生的子代理）各自使用独立网页标签页，可以真正并行；同一会话的多个网页回合仍然串行，保持共用一个网页对话的语义（回归自 0.2.13 的 `requestLock`）。
- 修复三类会导致**永久**卡住的结构缺陷：宿主放弃生成（取消/切换会话/丢弃迭代器）后主动取消仍挂在网页上的回合（`channel.cancelTurn`）；锁增加租约看门狗（`lockLeaseMs`），泄漏的锁到点强制回收并告警；新增单回合上限（`turnTimeoutMs`）与整条流上限（`maxStreamMs`），超时以 `WEB_TURN_TIMEOUT`/`WEB_TURN_ABORTED` 明确失败，不再无限"生成中"。
- 修复网页对话被"每轮重建 + 全量上下文回放"的问题：`conversationStarted`/`activeSessionId` 由全局改为每会话页记账，子代理切换标签页不再让主会话下一轮强制重建网页对话并重放检查点。
- 内部辅助请求（压缩摘要、会话标题）改用一次性临时标签页且不再排队等待主请求整轮生成，标题请求可与主请求并行。
- 同对话自审显式落在发起审阅的会话网页页上（`BrowserTurnRequest.conversationSessionId`），不再依赖"最近用过的页"或全局 focus（多会话并行时会写进子代理的网页对话）。
- 新增配置：`maxSessionPages`（默认 3）、`turnTimeoutMs`（默认 15 分钟）、`maxStreamMs`（默认 60 分钟）、`lockLeaseMs`（默认 75 分钟）；启动时对超时/租约做交叉校验告警（租约须 ≥ 整轮上限 + 单回合上限，否则多回合请求可能被强拆）。
- 新增全局并发网关 `maxConcurrentTurns`（默认 2）：同一时刻最多允许 N 条请求真正在网页上跑，超出的请求按到达顺序先进先出排队，每结束一条放行一条；`0` 表示不限制。名额池实现为 `src/concurrency-gate.ts`，排队可被取消且不泄露名额，`release` 幂等；先拿会话锁再抢名额，避免同一会话的排队请求白占全局名额。
- 新增可观测日志：会话页建立/回收、`turn` 入口（会话、`initialize`、页面归属）、同会话排队超过 3 秒、并发上限排队与取得名额、锁租约回收、取消在飞回合。
- 新增离线并发回归 `tools/concurrency-check.ts`（8 条契约：跨会话并行、同会话串行、放弃生成回收、辅助请求并行、锁租约、并发上限 FIFO 排队、上限放开、名额池单元契约），并入 `npm run test:parsers`。

## 0.2.14 — 2026-10-13

- 默认工具白名单仅包含通用本地工具，移除个人 MCP 工具预设。
- 兼容 DeepSeek 网页返回的完整 DSML 工具调用：多动作、字符串与 JSON 参数保真，执行前仍校验工具白名单和参数类型。
- 截断、畸形、纠错后仍无效的工具调用明确报错，不再显示为最终正文或推进会话游标；修复审核后无效动作可能绕过最终校验的问题。
- 压缩摘要默认跟随真实用户任务语言；可选择保留宿主要求、中文或英文，只修改已识别的官方压缩模板。
- 内部辅助请求的浏览器标题和日志标注用途；上下文重建日志明确说明继续原 dsh 会话。
- 新增可选的压缩配置工具，按实际 agent preset 更新网页模型策略，保留其他模型和个人预设，生成修改前备份。
- 网页累计 token 总量仅计入通道统计，不再全部冒充宿主的输出 token。

## 0.2.13 — 2026-10-13

- npm 官方源已发布 0.2.13，`latest` 指向该版本；桌面版「添加插件」可直接输入 `dsh-deepseek-web-littlecar30@0.2.13`。

- 发行包改名为 `dsh-deepseek-web-littlecar30`。npm 的 `dsh-deepseek-web` 属于另一位作者，不能用于安装本项目；GitHub 仓库地址不变。
- 同步客户端模块 ID 和配置页注册键，确保新包名下仍能加载客户端和打开中文配置页。
- 安装说明优先使用桌面版「插件 → 添加插件」，直接粘贴 Release 安装包链接；无需编译、手改 profile 或手动加载 patch。
- 补充旧版迁移、安装源选择、首次登录、升级和卸载说明，以及发行包的仓库与许可证信息。
- 包含 0.2.11、0.2.12 的全部修复；网页委托正文完整返回，默认隐藏网页思考，内部摘要/标题请求隔离，压缩后恢复正常任务。

## 0.2.12

- 内部摘要与标题请求使用独立临时页面，不进入正常任务的工具执行和交付审核。
- 转发宿主上下文与压缩检查点，压缩、会话迁移和历史游标失效后完整回放任务上下文。
- 清理旧版明确的摘要指令污染，保守识别未完成的交接摘要，并检查网页响应中断与截断。
- 补充取消、隔离、压缩接续和旧状态恢复的离线回归检查。

## 0.2.11

- 默认只展示最终正文和工具调用，不再默认转发网页思考过程。
- 移除网页委托结果的 6000 字符截断；本地工具结果送入网页的长度限制保留。
