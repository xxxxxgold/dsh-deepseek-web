# 更新记录

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
