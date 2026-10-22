# 「全自动发送后没收到网页响应」根因与修复

现象一句话：deepseek-web 全自动发送之后，网页那边看着一切正常、回复也出来了，dsh 这边却报「未收到网页响应」，本轮直接失败。用户反馈这不是偶发，是一直在发生。

结论一句话：旧链路里「发送」和「收响应」两段都没有证据——回车按了但不确认是否真发出去，等待窗口又是在填字之前就开始计时的，所以**只要填字慢或被页面吞掉，就会稳定误判**，而真实回复在超时之后才到，于是变成「网页有回复、dsh 没收到」。

## 一、取证：真机上把两段拆开看

以下全部在真实 `chat.deepseek.com` 上跑，不是离线桩。

1. **网页侧确实会回，而且回得很快**。在同一浏览器里发一条测试消息，网页 1 秒内开始输出，正文完整出现（人工看页面确认）。
2. **dsh 侧拿不到，是因为它在网页回之前就已经判了死**。旧代码的 `waitForResponse` 超时从进入回合那一刻就开始计时，而填字、等新对话、页面重载都排在这之前。真实测量：30 万字符填字约 13 秒、60 万约 77 秒、110 万字符会把页面主线程拖死数分钟。dsh 回放整段宿主上下文时，单条消息很容易到几十万字符量级，于是一次填字就把 3 分钟的窗口吃掉大半甚至全部。
3. **回车有没有生效，旧代码根本不知道**。旧实现填完字按一次回车就转去等响应，等不到就报超时。实测存在回车被页面忽略、内容仍留在输入框的情况（回车换行模式的页面、输入框尚未完成初始化时）。此时网页当然没有响应，因为消息压根没发出去。
4. **dsh 取回复本身没问题**。一旦发送确实成功，解析链路能正常拿到正文——真机重试实测 11.6 秒取回正文「链路正常」（4 字），`finishReason` 网页未提供时也能正常收尾。

## 二、根因（五条，按影响排序）

### 1. 等待窗口从「填字之前」起算，被填字时间吃光

`src/playwright-channel.ts:1362` 的 `ackTimeoutMs = min(streamIdleTimeoutMs, 180s)` 原本靠 `waitForResponse(..., { timeout: ackTimeoutMs })` 从**进入回合**开始计时。填字、新对话导航、整页重载全部计入这 180 秒。长消息场景下填字本身就可能吃掉数十秒到数分钟，网页刚拿到消息、还没开始答，dsh 这边已经到期报错。这就是「一直出现」的主因：任务越长、上下文回放越多，越必然踩中。

### 2. 发送动作没有确认，静默失败与「回得慢」被混成同一句错误

旧链路回车后不校验：不看输入框是否被清空，不看消息区是否出现本轮文本。回车被页面忽略时，消息留在输入框，网页不产生任何响应，3 分钟后报出来的仍然是「没收到网页响应」——和真正「发出去但回得慢」得到同一条错误，现场无法区分，也就无法根治。

### 3. 全量回放历史不设上限，把填字代价推到失控

`renderNewWebMessages()` 在首次或换新对话时会回放整段宿主上下文，旧实现没有长度预算。网页输入框填字代价随文本长度接近二次方增长，百万字符会把浏览器主线程拖死数分钟，表现就是页面看着卡住、最后判超时。

### 4. 「开启新对话」的确认窗口只有 800ms，频繁回退整页重载

`src/playwright-channel.ts` 的 `startFreshConversation` 点击侧栏入口后固定等 800ms，URL 没变就判定失败并 `goto` 入口页。网页是 SPA，地址栏更新常要 1~3 秒，于是几乎每次新会话都走重载兜底；重载后前端还在初始化，紧接着填字有被前端状态覆盖成空的可能，回车就是空发。

### 5. 同一处错位在 Kimi / GLM 审核通道里也有一份（不是 deepseek 独有）

`src/kimi-channel.ts` 与 `src/glm-channel.ts` 都把「等响应」的超时挂在填字之前（分别是 `min(streamIdleTimeoutMs, 120_000)` 与同一形式），且都只按一次回车、不看发送结果。审核提示词动辄几万字，同样是「填字吃掉窗口 → 消息其实发出去了 → 插件报超时」。只修 deepseek 通道等于只堵了一个口子，所以这次三个通道一起改。

## 三、修复

| 位置 | 改动 |
| --- | --- |
| `src/browser-shared.ts:395` | 新增 `sendEditorMessage()`：回车 → 校验输入框清空/消息区出现本轮文本 → 未发出则点发送按钮兜底 → 两条都失败返回 `sent: false` 并附每次尝试的记录 |
| `src/playwright-channel.ts:1409` | `waitForResponse` 改 `{ timeout: 0 }`，不再由它计时 |
| `src/playwright-channel.ts:1456` | 新增 `startAckClock()`：超时从**发送确认完成**那一刻启动，仍封顶 `min(streamIdleTimeoutMs, 180s)` |
| `src/playwright-channel.ts:1462` / `:1465` | 超时文案分叉：「消息已发送，但 X 内没有等到响应流」 vs 「已填入输入框，等待你点击发送超时」，各自给出下一步 |
| `src/playwright-channel.ts:1563` / `:1576` / `:1579` | 发送改走 `sendEditorMessage()`；失败抛 `WEB_SEND_NOT_TRIGGERED`；成功日志「全自动：已确认发送（方式：enter｜button）」 |
| `src/config.ts:304` / `:448` | 新增 `maxReplayChars`（默认 `400_000`，0 关闭） |
| `src/protocol.ts:667` / `:679` / `:701` / `:711` | 回放预算：系统指令与协议清单不裁剪，超预算时按消息粒度丢最早的历史并留一行省略说明；单段自身超预算则截断保留尾部 |
| `src/playwright-channel.ts:627-665` | 新对话确认：先识别「已在入口页」直接跳过重载（`:633`，日志 `:635`）；否则 200ms 轮询等 URL 变化、最多 3 秒（`:645-648`），仍不变才回退重载（`:658`） |
| `src/kimi-channel.ts:60` / `:561` / `:591` / `:664` | **同类缺陷一并根治**：Kimi 审核通道原来也是 `waitForResponse(..., { timeout: min(streamIdleTimeoutMs, 120_000) })` 在填字前起计。改为 `{ timeout: 0 }` + `startAckClock()`（新增 `KIMI_ACK_TIMEOUT_MS = 120_000`，只管发送确认之后那一段），发送改用 `sendEditorMessage()`，失败抛 `KIMI_SEND_FAILED` |
| `src/glm-channel.ts:57` / `:183` / `:208` / `:278` | **同类缺陷一并根治**：GLM 审核通道同样错位。改为 `{ timeout: 0 }` + `startAckClock()`（新增 `ACK_TIMEOUT_MS = 120_000`），发送改用 `sendEditorMessage()`，失败抛 `GLM_SEND_NOT_TRIGGERED` |
| `src/notify.ts:211` | 补 `WEB_SEND_NOT_TRIGGERED` 的人话提示与处理建议 |

## 四、验证

- **构建**：`npm run build` 通过（host `lib/index.js` 245,615 字节，构建标识 `0.5.0+20261022T125156`；client `lib/client.js` 82,216 字节）。
- **离线回归**：`npm run test:parsers` 全绿（28 个脚本，退出码 0）；其中新增四件：`tools/send-confirm-check.ts` 16 项跑在真实 Playwright 页面上——回车即发送、回车换行改走按钮兜底、按钮不可用判未发送并记录两轮尝试、网络先发、输入框为空判未发送；`tools/replay-budget-check.ts` 覆盖回放预算的保留 / 省略 / 单段截断 / 关闭 / 系统指令豁免 / 增量轮不受影响六组用例；`tools/ack-clock-check.ts` 逐个通道断言「响应监听不带超时」「发送确认在启动计时之前」「超时纳入竞速」「计时器在 finally 里清除」，并对计时语义做一次实测量化；`tools/entry-url-check.ts` 覆盖新对话态判定（入口页 / 具体会话 / 跨站 / 非法输入 / 自定义入口）。
- **护栏自身的有效性（变异测试）**：把 Kimi 通道的 `{ timeout: 0 }` 临时改回 `{ timeout: 120_000 }`，`ack-clock-check` 立即两项失败、退出码 1；还原后重新全绿。说明这条测试不是摆设，能真的挡住回退。
- **真机重试，连续五轮**（`tools/live-send-retry.ts`，真实 `chat.deepseek.com`，managed/msedge）：

  | 轮次 | 浏览器就绪 | 发送确认 | 收到响应 | 正文 | 退出码 |
  | --- | --- | --- | --- | --- | --- |
  | 第 1 轮 | 3.2s | `方式：enter` | 10.9s | 「链路正常」4 字 | 0 |
  | 第 2 轮 | 3.2s | `方式：enter` | 13.0s | 「链路正常」4 字 | 0 |
  | 第 3 轮 | 3.7s | `方式：enter` | 12.5s | 「链路正常」4 字 | 0 |
  | 第 4 轮 | 3.1s | `方式：enter` | 7.6s | 「链路正常」4 字 | 0 |
  | 第 5 轮（最终构建 `125156`） | 3.2s | `方式：enter` | 8.6s | 「链路正常」4 字 | 0 |

  每轮全程日志都含「全自动：已确认发送」「已收到网页完整回复，正在解析…」，无一次超时。第 4、5 轮还出现「已在入口页（新对话态），无需重载。」——新对话判定修复后不再无谓重载整页。
- **宿主真实加载**（决定性证据，不是推理）：在隔离 profile `verify-load` 里用同一份 tgz 装好后启动宿主，`%LOCALAPPDATA%\DshDeepSeekWeb\loaded-build.json` 实际写出
  `{"build":"0.5.0+20261022T114844","module":"C:\\Users\\29060\\.dsh\\profiles\\verify-load\\node_modules\\dsh-deepseek-web-littlecar30\\lib\\index.js","pid":37440,...}`
  ——证明宿主启动时确实会加载并执行这份产物、且构建标识与仓库一致。桌面 profile 现已是同一份字节（sha256 `991235E9…`，构建标识 `0.5.0+20261022T125156`）。
- **未验证**：百万字符级回放只做了耗时规律测量与预算拦截，没有在宿主里跑完整长任务；桌面宿主需重启一次才会加载新产物（重启后 `loaded-build.json` 应写出 `module` 指向 `profiles\desktop\...`，这是可自证的验收点）。

## 五、部署链路：改了代码、重启了，为什么还是不生效

这次真机验证踩到两个坑，都在「修了却没效果」这条线上，必须一起记下来。

### 坑一：重启只换了进程，没换代码

- 桌面 DSH 加载的是**已安装副本** `C:\Users\29060\.dsh\profiles\desktop\node_modules\dsh-deepseek-web-littlecar30\lib\index.js`。
- 开发目录 `D:\dsh\ds-web\lib\index.js` 是**另一个文件**，两者没有链接关系。
- 所以「改完代码 → 重启 dsh」这一步**只重启了宿主，没有换掉它加载的代码**，行为必然还是旧的。这一条与宿主进程启动时间对照后是硬证据：上次重启（17:28:32）比修复产物落盘（17:33:24）早 4.9 分钟，那次重启注定跑旧代码。

### 坑二：pnpm 每一次安装都会把本地构建覆盖回上游旧版（这才是「一直出现」的机制级根因）

profile 里该包原来声明成 `"github:xxxxxgold/dsh-deepseek-web"`，`pnpm-lock.yaml` 锁的是上游 tarball `75fcab1c…`、版本 0.3.4。插件管理器任何一次安装/更新（哪怕装的是别的插件）都会触发 pnpm 重算，把这个包整体刷回 0.3.4——实测 19:06:38 就发生过一次，238KB 的修复产物被换成 207KB 旧包，`startAckClock`、`WEB_SEND_NOT_TRIGGERED`、`maxReplayChars` 全部消失。**只改 `lib/` 是治不好的**：改多少次都会被下一次安装抹掉，用户看到的就是同一个错误反复出现。

### 修法：把依赖声明改成指向仓库产物的本地 tgz，让 pnpm 只能装回这份字节

```powershell
npm run deploy:local                                # 构建 + 打包 + 装进所有已装该包的 profile
node tools/deploy-local-profile.mjs --dry-run       # 先看会做什么
node tools/deploy-local-profile.mjs --profile desktop
```

脚本 `tools/deploy-local-profile.mjs` 的行为：

1. `npm pack` 把仓库打成 tgz，放进 `~/.dsh/profiles/_local-pkgs/`，文件名带产物 sha256 前 12 位（内容一变文件名就变，杜绝 pnpm 按路径复用 store 里的旧解包结果）。
2. 把 profile 的 `package.json` 依赖声明改成 `file:../_local-pkgs/<那个 tgz>`（改前备份成 `package.json.bak-<时间戳>`）。
3. 跑 pnpm 安装（优先用 DSH 自带的 pnpm，保证 store 与宿主一致）。
4. 校验装进去的 `lib/index.js` 与仓库产物逐字节同哈希、并打印包内构建标识；不一致就非零退出。

为什么是 tgz 而不是 `link:`：link 会让包的真实路径落在仓库内，Node 解析 `@deepseek-ai/*` 时会命中仓库 `node_modules` 里的旧副本，与宿主自带的那份不是同一个模块实例（类继承 / instanceof 会失效）。tgz 装出来的是 profile 内的**实体目录**（实测 `LinkType` 为空、非重解析点），依赖解析形状和一直正常工作的原始安装完全一致。

### 实测：这一步真的免疫了 pnpm 重装

部署完成后**再跑一次 `pnpm install`（模拟插件管理器重算）**，`lib/index.js` 哈希与构建标识均未变化：

| 时点 | sha256 前缀 | 构建标识 | node_modules 顶层条目 |
| --- | --- | --- | --- |
| 部署后 | `991235E9…` | `0.5.0+20261022T125156` | 367 |
| 再跑一次 pnpm install 后 | `991235E9…` | `0.5.0+20261022T125156` | 367 |

对比 19:06 那次（声明还是 github 依赖时）：重装后直接掉回 `207,464` 字节 / 0.3.4 / 标志位全消失。这就是修好与没修好的可测差别。

### 边界

npm 上该包的正式版本目前是 `0.2.14`，本地装的 `0.5.0` 是未发布快照。tgz 方案保证的是**本机这份 profile 不会再被 pnpm 刷回上游旧版**；要正式发布给其他人，得先升版本号、推上游、再 `npm pack`。

## 六、生效与兜底

重启 dsh 宿主后生效（插件在启动时加载 `lib/index.js`）。重启后想确认到底加载了哪份代码，读 `%LOCALAPPDATA%\DshDeepSeekWeb\loaded-build.json`：`module` 必须指向 `profiles\desktop\node_modules\dsh-deepseek-web-littlecar30\lib\index.js`，`build` 必须是 `0.5.0+20261022T125156`。对不上就是没吃到新代码，跑一次 `npm run deploy:local` 再重启。

若再出现同类报错，看错误码即可分流：

- `WEB_SEND_NOT_TRIGGERED`：回车和发送按钮都没把消息发出去（页面改版，或输入框没初始化好），需人工检查网页后重试。
- `WEB_AUTO_SEND_TIMEOUT`（新文案）：消息**已确认发出**，但 3 分钟内没等到响应流；此时网页里若已出现回答，说明响应被页面拦截或网络中断，而不是发送失败。
- 若仍然频繁超时，把 `maxReplayChars` 调小（例如 `200_000`）可进一步压缩填字时间。

## 七、硬指标逐条兑现情况（含额外自查）

| 要求 | 结论 | 证据 |
| --- | --- | --- |
| 现象查清：全自动发送后未收到网页响应 | 现象文字与旧代码 `WEB_AUTO_SEND_TIMEOUT` 文案逐字吻合；该句把「发送失败」「响应来晚了」混成一句 | `git diff` 显示该文案被替换；新文案按两种成因分叉 |
| 发送动作到底有没有触发 | 旧代码**没确认**，只按回车就走；新代码确认，真机五轮均为 `方式：enter` | `src/browser-shared.ts:395` `sendEditorMessage()`；`tools/send-confirm-check.ts` 16 项 |
| 回车没触发 / 输入框为空 / 页面结构变化 | 三种成因分别可判：回车没生效→改走发送按钮；按钮也不可用→抛 `WEB_SEND_NOT_TRIGGERED`；输入框为空→判未发送并记录；页面结构变化→找不到编辑器时先等 15 秒，仍没有则抛 `WEB_EDITOR_NOT_FOUND`（`src/playwright-channel.ts:1485-1501`），不再盲按回车 | `send-confirm-check.ts` 的 A/B/C/D/空输入框五组用例；`locateEditor` 与 `WEB_EDITOR_NOT_FOUND` 分支 |
| 网页有回复但 dsh 没获取到 | 拆分取证：网页侧 0.9s 返回 200 + SSE `FINISHED`；dsh 侧 `waitForResponse` + `body()` 1.4s 完整取回 → **接收环节本身无缺陷**，是 dsh 在网页回答之前就判了超时 | 真机被动监听日志；`tools/live-send-retry.ts` 五轮取回正文 |
| 人工检查网页后重试 | 已做：用 CDP 只读抓取真实会话页，确认页面上确实有回复正文；随后用新代码连续重试五轮，全部成功 | 见第四节真机表格 |
| 「一直出现」的根因 | 三层：①等待窗口从填字前起算，长上下文必然踩中；②发送无确认，吞键/空输入框被误报成「没响应」；③profile 依赖锁回上游旧版，任何一次插件安装都会把修复抹掉 | 填字耗时实测（60 万字符 77s、110 万拖死主线程）；19:06:38 产物被刷回 0.3.4 的日志与哈希对比；`ack-clock-check` 变异测试 |
| 只修一个通道够不够 | 不够：Kimi、GLM 审核通道有同一处错位，已一并改掉并纳入同一份护栏 | `tools/ack-clock-check.ts` 对三个通道逐项断言 |
