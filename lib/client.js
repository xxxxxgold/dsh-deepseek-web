window.__ModuleLoader__.load({ id: "dsh-deepseek-web-xxxxxgold", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/client/config-fields.ts
/** 设置页分组，顺序即渲染顺序。 */
const GROUPS = [
	{
		id: "ui",
		label: {
			zh: "界面",
			en: "Appearance"
		},
		hint: {
			zh: "界面语言对本插件的两个配置界面同时生效；「跟随系统」按浏览器/系统语言判定，中文显示中文，其余显示英文。",
			en: "The interface language applies to both configuration pages of this plugin. “Follow system” reads the browser/OS language: Chinese shows Chinese, everything else shows English."
		}
	},
	{
		id: "connection",
		label: {
			zh: "网页连接",
			en: "Web connection"
		},
		hint: {
			zh: "插件如何打开 DeepSeek 网页版。前两项与 profile 目录在重启 DSH 后生效。",
			en: "How the plugin opens the DeepSeek web app. The first two and the profile directory apply after a DSH restart."
		}
	},
	{
		id: "glmweb",
		label: {
			zh: "GLM 网页",
			en: "GLM web"
		},
		hint: {
			zh: "第二个主模型通道：支持 chatglm.cn 与 chat.z.ai。模型（GLM-5.3 / GLM-5.3-Flash）与思考强度（快速/深度/极致）在 DSH 模型菜单里选；这里只配浏览器入口。",
			en: "A second main-model channel for chatglm.cn and chat.z.ai. Pick the model (GLM-5.3 / GLM-5.3-Flash) and thinking effort (fast / deep / ultra) in the DSH model menu; this section only configures the browser entry."
		}
	},
	{
		id: "doubao",
		label: {
			zh: "豆包网页",
			en: "Doubao web"
		},
		hint: {
			zh: "第二个网页模型通道，与现有 DeepSeek 通道并存：使用独立浏览器 profile，登录豆包账号后可用。快速/专家模式请在豆包网页端自行设置，插件不干预。关闭时不影响 DeepSeek 通道。",
			en: "A second web-model channel coexisting with DeepSeek: its own browser profile, sign in to Doubao once. Set Fast/Expert in the Doubao web app yourself; the plugin does not change it. Turning it off leaves DeepSeek untouched."
		}
	},
	{
		id: "model",
		label: {
			zh: "网页模型与发送",
			en: "Web model and sending"
		},
		hint: {
			zh: "网页端模型入口、消息如何发出，以及控制协议怎么注入。",
			en: "Model entry, how messages leave the page, and how the control protocol is injected."
		}
	},
	{
		id: "risk",
		label: {
			zh: "风控模式",
			en: "Risk control"
		},
		hint: {
			zh: "整体防封档位 + 细粒度参数。一键套用档位会把下面几个值成套写入；选「自定义」才逐项手调。",
			en: "Overall anti-ban profile plus fine-grained knobs. Picking a profile writes the values below in one shot; choose “Custom” to tune them by hand."
		}
	},
	{
		id: "image",
		label: {
			zh: "图片与长正文",
			en: "Images & long text"
		},
		hint: {
			zh: "把图片附件真正上传到网页输入框；超长正文改走文件附件，避免输入框卡顿。",
			en: "Upload image attachments into the page composer; long prompts go as a file attachment to avoid a frozen composer."
		}
	},
	{
		id: "review",
		label: {
			zh: "审核通道",
			en: "Review channel"
		},
		hint: {
			zh: "交付前用第二个模型复核结果。网页模型可在模型菜单的「推理等级」里选审核关 / 跟随设置 / 审核开；`review.enabled` 是「跟随设置」的默认值，显式选了「审核开」的会话仍会审核。",
			en: "A second model reviews the result before delivery. For web models, switch Review off / Follow settings / Review on under “Effort” in the model menu; `review.enabled` is the default for “Follow settings”, while sessions explicitly set to Review on still review."
		}
	},
	{
		id: "ratelimit",
		label: {
			zh: "频控自动重发",
			en: "Rate-limit retry"
		},
		hint: {
			zh: "网页提示「发送过于频繁」时按退避策略等待后自动重发同一条消息。默认指数退避：60s → 120s → 240s → 300s 封顶，合计约 12 分钟，覆盖实测 10~15 分钟的冷却窗口。",
			en: "When the page reports rate limiting, wait per the backoff policy then resend the same message. Default exponential: 60s → 120s → 240s → 300s cap, about 12 minutes total, matching the observed 10–15 minute cooldown."
		}
	},
	{
		id: "notify",
		label: {
			zh: "过程提示",
			en: "Progress notices"
		},
		hint: {
			zh: "把「发出消息 / 收到回复 / 频控等待 / 本轮失败」做成对话里一行可见提示（过程中以可折叠块呈现）。会话消息与审核消息分开开关，避免内部审核把主对话刷满。",
			en: "Show one-line notices for send / receive / rate-limit wait / failures (rendered as a collapsible block). Session and review notices have separate switches so internal review does not flood the main conversation."
		}
	},
	{
		id: "browserrecovery",
		label: {
			zh: "浏览器自愈",
			en: "Browser recovery"
		},
		hint: {
			zh: "浏览器或网页标签被关掉时先提示、再自动重启（重连）并重发本轮消息。只处理「被关掉」这类事故；频控、超时、手动取消不走这里。",
			en: "When the browser or the tab is closed, notify first, then restart (or reconnect) and resend the turn automatically. Only closure accidents are handled here; rate limits, timeouts and cancellations are not."
		}
	},
	{
		id: "probe",
		label: {
			zh: "登录探活",
			en: "Login probe"
		},
		hint: {
			zh: "后台只读检查网页登录态（不发送、不消耗额度）。失效时只提醒，绝不拦住发送——探活判断错了不该拦人。浏览器没启动时只记「无法判断」，不会为了探活把浏览器拉起来。",
			en: "Background read-only check of the page login state (nothing is sent, no quota used). A failure only warns and never blocks a send. When the browser is not running it reports “unknown” instead of starting it."
		}
	},
	{
		id: "archivecleanup",
		label: {
			zh: "归档清理",
			en: "Archive cleanup"
		},
		hint: {
			zh: "DSH 会话归档时，是否把它在 DeepSeek 网页端产生过的对话一起删掉。只影响归档动作之后新产生的绑定；历史会话没有网页对话 id，只能在下方统计里看到「无绑定」。",
			en: "Whether archiving a DSH session also deletes the DeepSeek web chats it produced. Only bindings recorded after this feature ships are affected; older sessions have no chat ids and only show up as “unbound” in the stats below."
		}
	},
	{
		id: "tools",
		label: {
			zh: "工具与委托",
			en: "Tools and delegation"
		},
		hint: {
			zh: "限制哪些工具能进网页模型，以及哪些能力委托给网页端。",
			en: "Which tools reach the web model, and which capabilities are delegated to the page."
		}
	},
	{
		id: "focus",
		label: {
			zh: "窗口聚焦",
			en: "Window focus"
		},
		hint: {
			zh: "回合开始与结束时把哪个窗口提到最前。",
			en: "Which window comes to the front when a turn starts or ends."
		}
	},
	{
		id: "compaction",
		label: {
			zh: "压缩摘要",
			en: "Compaction"
		},
		hint: {
			zh: "只调整官方压缩模板的摘要语言。",
			en: "Only changes the summary language of official compaction prompts."
		}
	}
];
/**
* 可编辑字段集合。
*
* 只列真正需要在部署间调整的项；安全不变量（如协议常量）与纯代码常量不在此列。
* 未在此列出的字段仍可通过 profile 的 `cordis.patch.yml` 覆盖。
*/
const FIELDS = [
	{
		path: ["uiLanguage"],
		group: "ui",
		kind: "select",
		label: {
			zh: "界面语言",
			en: "Interface language"
		},
		options: [
			"auto",
			"zh",
			"en"
		],
		optionLabels: {
			auto: {
				zh: "跟随系统",
				en: "Follow system"
			},
			zh: {
				zh: "中文",
				en: "Chinese"
			},
			en: {
				zh: "English",
				en: "English"
			}
		},
		hint: {
			zh: "auto 跟随系统语言；手动选定后以设置为准，两个配置界面同时切换。",
			en: "auto follows the system language. Once you pick one, that choice wins and both configuration pages switch together."
		}
	},
	{
		path: ["url"],
		group: "connection",
		kind: "text",
		label: {
			zh: "DeepSeek 网页地址",
			en: "DeepSeek web address"
		},
		hint: {
			zh: "默认 https://chat.deepseek.com。",
			en: "Defaults to https://chat.deepseek.com."
		}
	},
	{
		path: ["browser"],
		group: "connection",
		kind: "select",
		label: {
			zh: "浏览器连接模式",
			en: "Browser mode"
		},
		options: ["managed", "attach"],
		restart: true,
		hint: {
			zh: "managed：插件托管一个带独立 profile 的浏览器窗口；attach：连接已开启 CDP 的浏览器。",
			en: "managed: the plugin runs its own browser window with a private profile; attach: connect to a browser already started with CDP."
		}
	},
	{
		path: ["channel"],
		group: "connection",
		kind: "select",
		label: {
			zh: "独立浏览器类型",
			en: "Managed browser"
		},
		options: ["msedge", "chrome"],
		restart: true,
		hint: {
			zh: "仅 managed 模式生效，使用已安装的 Edge 或 Chrome。",
			en: "managed mode only: the installed Edge or Chrome."
		}
	},
	{
		path: ["profileDir"],
		group: "connection",
		kind: "text",
		label: {
			zh: "独立浏览器 profile 目录",
			en: "Browser profile directory"
		},
		restart: true,
		hint: {
			zh: "留空使用 %LOCALAPPDATA%\\DshDeepSeekWeb\\edge-profile。",
			en: "Empty means %LOCALAPPDATA%\\DshDeepSeekWeb\\edge-profile."
		}
	},
	{
		path: ["debugPort"],
		group: "connection",
		kind: "number",
		label: {
			zh: "CDP 调试端口",
			en: "CDP debug port"
		},
		min: 1024,
		max: 65535,
		hint: {
			zh: "attach 模式连接此端口；managed 模式把它作为首选端口，冲突时自动换空闲端口。",
			en: "attach mode connects here; managed mode prefers it and falls back to a free port when busy."
		}
	},
	{
		path: ["model"],
		group: "model",
		kind: "select",
		label: {
			zh: "网页版模型入口",
			en: "Web model entry"
		},
		options: ["deepseek-web", "deepseek-web-auto"],
		hint: {
			zh: "供驱动校准网页顶部的模型开关。",
			en: "Used to align the model switch at the top of the page."
		}
	},
	{
		path: ["sendMode"],
		group: "model",
		kind: "select",
		label: {
			zh: "发送模式",
			en: "Send mode"
		},
		options: ["manual", "approved"],
		hint: {
			zh: "manual：填入输入框并聚焦网页窗口，由你点击发送；approved 为预留。",
			en: "manual: fill the composer and focus the page, you press send; approved is reserved."
		}
	},
	{
		path: ["liveThinking"],
		group: "model",
		kind: "boolean",
		label: {
			zh: "显示网页思考过程",
			en: "Show web reasoning"
		},
		hint: {
			zh: "开启后展示网页真实思考；不改变网页的思考模式。",
			en: "Streams the page’s real reasoning; it does not change the page thinking mode."
		}
	},
	{
		path: ["protocolEveryRequest"],
		group: "model",
		kind: "boolean",
		label: {
			zh: "每轮都注入控制协议",
			en: "Inject control protocol every turn"
		},
		hint: {
			zh: "默认开启。每轮都重发协议与工具清单，网页端不容易在长任务里忘记动作格式；代价是每轮多带约 1 千字符（精简目录）。关掉后按下面的间隔刷新。",
			en: "On by default. Re-sends the protocol and tool list every turn so the page does not forget the action format on long tasks; costs about 1k extra characters per turn (compact catalog). Turn it off to fall back to the refresh interval below."
		}
	},
	{
		path: ["protocolRefreshEvery"],
		group: "model",
		kind: "number",
		label: {
			zh: "协议刷新间隔（轮）",
			en: "Protocol refresh interval (turns)"
		},
		min: 1,
		hint: {
			zh: "未开启「每轮都注入」时，每隔这么多轮重新注入一次协议快照。",
			en: "When per-turn injection is off, re-inject the protocol snapshot every this many turns."
		}
	},
	{
		path: ["maxToolResultChars"],
		group: "model",
		kind: "number",
		label: {
			zh: "工具结果输入上限（字符）",
			en: "Tool result input limit (characters)"
		},
		min: 256,
		hint: {
			zh: "只限制送入网页模型的工具结果；最终正文与委托结果完整展示。",
			en: "Limits only what reaches the web model; final text and delegated output stay complete."
		}
	},
	{
		path: ["maxToolCatalogChars"],
		group: "model",
		kind: "number",
		label: {
			zh: "工具目录预算（字符）",
			en: "Tool catalog budget (characters)"
		},
		min: 0,
		hint: {
			zh: "工具清单写进提示词的总预算，默认 28000。超预算时先缩描述、装不下就只留名字，并在末尾列出被省略的工具名——不会静默砍掉让模型「不会用工具」。0 = 不限制。",
			en: "Total budget for the tool list in the prompt; default 28000. Over budget, descriptions shrink first, then only names remain, and omitted tool names are listed at the end — never silently dropped. 0 = unlimited."
		}
	},
	{
		path: ["maxReplayChars"],
		group: "model",
		kind: "number",
		label: {
			zh: "历史回放预算（字符）",
			en: "Replay budget (characters)"
		},
		min: 0,
		hint: {
			zh: "新标签页或新会话重建上下文时，允许回放的历史正文字符上限，默认 400000。调大不是「越安全」：网页输入框填字代价接近二次方，30 万字符约 13 秒、60 万约 77 秒。0 = 不限制。",
			en: "Character budget for replaying history when a tab or conversation is rebuilt; default 400000. Bigger is not safer: filling the page composer scales near-quadratically (300k chars ≈ 13s, 600k ≈ 77s). 0 = unlimited."
		}
	},
	{
		path: ["contextWindow"],
		group: "model",
		kind: "number",
		label: {
			zh: "上下文窗口（token）",
			en: "Context window (tokens)"
		},
		min: 8e3,
		max: 4e6,
		hint: {
			zh: "上报给宿主的上下文窗口，默认 1000000。实测附件通道下中文约 154 万字符、英文约 400 万字符可完整读入（约 100 万 token），超限时网页静默丢弃尾部。调大后压缩更晚，长会话更容易踩到网页侧截断。保存后下一轮请求生效。",
			en: "Context window reported to the host; default 1000000. Measured: ~1.54M Chinese or ~4M English characters read in full (~1M tokens); beyond that the page silently drops the tail. Raising it delays compaction, so long sessions more easily hit page-side truncation."
		}
	},
	{
		path: ["maxTokens"],
		group: "model",
		kind: "number",
		label: {
			zh: "单次输出上限（token）",
			en: "Max output tokens"
		},
		min: 256,
		max: 1e6,
		hint: {
			zh: "上报给宿主的单次输出上限，默认 300000。网页实际会自然收尾（实测约 8400 字符），该值主要影响宿主预算与压缩阈值：min(上下文 × 0.8, 上下文 − 本值 − 65536)。必须满足「本值 + 65536 < 上下文窗口」，否则宿主的自动压缩会被拒绝执行。保存后下一轮请求生效。",
			en: "Max output tokens reported to the host; default 300000. The page stops on its own (measured ~8.4k characters), so this mainly drives host budgeting and the compaction threshold: min(context × 0.8, context − this − 65536)."
		}
	},
	{
		path: ["maxConcurrentTurns"],
		group: "risk",
		kind: "number",
		label: {
			zh: "同账号并发上限",
			en: "Concurrent turns per account"
		},
		min: 0,
		max: 64,
		hint: {
			zh: "同一时刻最多几条请求真的在网页上跑。要「一号两并发」填 2；填 1 即完全串行。0 = 不限（不建议，容易撞账号级频控）。",
			en: "How many requests may run on the page at once. Use 2 for two concurrent turns on one account; 1 fully serializes. 0 = unlimited (not recommended)."
		}
	},
	{
		path: ["maxSessionPages"],
		group: "risk",
		kind: "number",
		label: {
			zh: "会话标签页上限",
			en: "Session tab limit"
		},
		min: 1,
		max: 8,
		hint: {
			zh: "同时保留几个网页标签页（每个并发会话独占一个）。开得越多，服务端「同账号多开」的判定风险越高，建议与并发上限持平。",
			en: "How many page tabs stay open (one per concurrent session). More tabs raise the multi-window risk; keep it close to the concurrency limit."
		}
	},
	{
		path: ["sendPauseMinMs"],
		group: "risk",
		kind: "number",
		label: {
			zh: "发送前停顿下限（毫秒）",
			en: "Pre-send pause min (ms)"
		},
		min: 0,
		max: 6e4,
		hint: {
			zh: "消息填进输入框后、按发送前的随机停顿下限。默认 2000；与上限同为 0 则关闭停顿。",
			en: "Lower bound of the random pause between filling the composer and sending. Default 2000; set both bounds to 0 to disable."
		}
	},
	{
		path: ["sendPauseMaxMs"],
		group: "risk",
		kind: "number",
		label: {
			zh: "发送前停顿上限（毫秒）",
			en: "Pre-send pause max (ms)"
		},
		min: 0,
		max: 6e4,
		hint: {
			zh: "停顿上限，默认 4000。必须在下限与上限之间随机取值——固定间隔方差为零，是最明显的机器特征。",
			en: "Upper bound, default 4000. Always pick randomly inside the range: a fixed interval has zero variance and is the clearest bot signature."
		}
	},
	{
		path: ["turnGapMinMs"],
		group: "risk",
		kind: "number",
		label: {
			zh: "回合间隔下限（毫秒）",
			en: "Turn gap min (ms)"
		},
		min: 0,
		max: 6e5,
		hint: {
			zh: "上一轮网页回合结束到下一轮真正发请求之间的随机等待下限，默认 2000。与「发送前停顿」的区别是计时起点：那个只夹在填字→回车之间，这个管的是回合与回合之间，长任务连续续跑时才看得出差别。与上限同为 0 则关闭。",
			en: "Lower bound of the random wait between the end of one web turn and the next request; default 2000. Unlike the pre-send pause (measured between filling and sending), this covers turn-to-turn spacing. Set both bounds to 0 to disable."
		}
	},
	{
		path: ["turnGapMaxMs"],
		group: "risk",
		kind: "number",
		label: {
			zh: "回合间隔上限（毫秒）",
			en: "Turn gap max (ms)"
		},
		min: 0,
		max: 6e5,
		hint: {
			zh: "回合间隔上限，默认 4000，在下限与上限之间随机取值。固定值方差为零是最明显的机器特征。",
			en: "Upper bound of the turn gap; default 4000, randomized inside the range. A fixed value has zero variance and is the clearest bot signature."
		}
	},
	{
		path: ["longRunAfterSends"],
		group: "risk",
		kind: "number",
		label: {
			zh: "连发多少轮后长休",
			en: "Long pause after N sends"
		},
		min: 0,
		max: 1e4,
		hint: {
			zh: "连续发送满这么多轮就强制休息一段，打断「稳定节拍」。默认 15；0 = 关闭。10 分钟没有任何请求会重新计数。",
			en: "After this many consecutive sends, take a long pause to break the metronome rhythm. Default 15; 0 = off. The counter resets after 10 idle minutes."
		}
	},
	{
		path: ["longRunPauseMinMs"],
		group: "risk",
		kind: "number",
		label: {
			zh: "长休下限（毫秒）",
			en: "Long pause min (ms)"
		},
		min: 0,
		max: 36e5,
		hint: {
			zh: "触发长休后的最短休息时长，默认 30000（30 秒）。",
			en: "Minimum long-pause duration; default 30000 (30s)."
		}
	},
	{
		path: ["longRunPauseMaxMs"],
		group: "risk",
		kind: "number",
		label: {
			zh: "长休上限（毫秒）",
			en: "Long pause max (ms)"
		},
		min: 0,
		max: 36e5,
		hint: {
			zh: "长休上限，与下限之间随机，默认 60000（60 秒）。",
			en: "Maximum long-pause duration; randomized with the minimum. Default 60000 (60s)."
		}
	},
	{
		path: ["enableImageUpload"],
		group: "image",
		kind: "boolean",
		label: {
			zh: "图片直传",
			en: "Upload images"
		},
		hint: {
			zh: "开启后网页端原生识图；关闭则退回 [附图] 文本标记，模型看不到图片内容。",
			en: "On: the page sees the image natively. Off: falls back to an [附图] text marker."
		}
	},
	{
		path: ["maxImagesPerTurn"],
		group: "image",
		kind: "number",
		label: {
			zh: "单轮图片上限（张）",
			en: "Images per turn"
		},
		min: 0,
		max: 32,
		hint: {
			zh: "0 表示关闭上传。",
			en: "0 disables uploads."
		}
	},
	{
		path: ["uploadTimeoutMs"],
		group: "image",
		kind: "number",
		label: {
			zh: "图片解析超时（毫秒）",
			en: "Image parse timeout (ms)"
		},
		min: 1e3,
		hint: {
			zh: "等网页端把图片解析为 SUCCESS 的上限；大图可调大。",
			en: "How long to wait for the page to parse an image to SUCCESS; raise it for large files."
		}
	},
	{
		path: ["longTextAsFile"],
		group: "image",
		kind: "boolean",
		label: {
			zh: "长正文转文件",
			en: "Long text as file"
		},
		hint: {
			zh: "正文超过阈值时写成 .md 附件上传，输入框只填摘要；关闭则整段填进输入框。",
			en: "When the prompt exceeds the threshold, upload it as a .md attachment and type only a summary; off types the whole prompt."
		}
	},
	{
		path: ["longTextFileThreshold"],
		group: "image",
		kind: "number",
		label: {
			zh: "长正文阈值（字）",
			en: "Long-text threshold (chars)"
		},
		min: 1e4,
		hint: {
			zh: "默认 120000。网页输入框填字代价随长度接近二次方增长，12 万字约十几秒。",
			en: "Default 120000. Typing cost grows roughly quadratically; 120k chars takes ten-plus seconds."
		}
	},
	{
		path: ["review", "enabled"],
		group: "review",
		kind: "boolean",
		label: {
			zh: "默认开启审核",
			en: "Enable review by default"
		},
		hint: {
			zh: "「跟随设置」档位使用这个值；中间工具轮次不审，只在交付前审最终正文。",
			en: "Used by the “Follow settings” effort level; intermediate tool turns are not reviewed, only the final text before delivery."
		}
	},
	{
		path: ["review", "provider"],
		group: "review",
		kind: "select",
		label: {
			zh: "审核器",
			en: "Reviewer"
		},
		options: [
			"deepseek-web",
			"kimi",
			"glm"
		],
		hint: {
			zh: "kimi / glm 需要对应网页已登录；deepseek-web 在同一对话里自审，更快但独立性弱。",
			en: "kimi / glm need a signed-in page; deepseek-web self-reviews in the same conversation, faster but less independent."
		}
	},
	{
		path: ["review", "kimiMode"],
		group: "review",
		kind: "select",
		options: ["normal", "project"],
		label: {
			zh: "Kimi 审核模式",
			en: "Kimi review mode"
		},
		visibleWhen: {
			path: ["review", "provider"],
			equals: "kimi"
		},
		hint: {
			zh: "normal = 正常模式：开普通对话页审核，对话落在「最近对话」里。project = 项目模式：在指定项目页里新开对话审核，对话归档到该项目下（项目名称由你在 Kimi 里定，比如「审核」）。两种模式各用各的地址，不会互相兜底。",
			en: "normal = plain conversation page; the chat lands in your recent chats. project = open a new chat inside a Kimi project page; the chat is filed under that project (project name is whatever you called it in Kimi). Each mode uses its own URL and they never fall back to each other."
		}
	},
	{
		path: ["review", "url"],
		group: "review",
		kind: "text",
		label: {
			zh: "正常模式链接",
			en: "Normal mode URL"
		},
		visibleWhen: [{
			path: ["review", "provider"],
			equals: "kimi"
		}, {
			path: ["review", "kimiMode"],
			equals: "normal"
		}],
		hint: {
			zh: "正常模式下新标签页要打开的链接。默认带 ?chat_enter_method=new_chat，打开就是空对话；缺这个参数时会自动补上。企业版域名、带自有查询参数的地址同样可用。",
			en: "The link opened in normal mode. The default carries ?chat_enter_method=new_chat so it lands on an empty conversation, and the parameter is added automatically when missing. Enterprise domains and your own query parameters work too."
		}
	},
	{
		path: ["review", "projectUrl"],
		group: "review",
		kind: "text",
		label: {
			zh: "项目 ID",
			en: "Project ID"
		},
		visibleWhen: [{
			path: ["review", "provider"],
			equals: "kimi"
		}, {
			path: ["review", "kimiMode"],
			equals: "project"
		}],
		hint: {
			zh: "只填项目 ID 就行，形如 1a15bef4-b7a2-894f-8000-0e7143648841（项目页地址 /project/ 后面那一段）。插件会自动拼成 <域名>/project/<ID>?chat_enter_method=new_chat，域名取自上面的「正常模式链接」。填完整项目页链接也认。每轮审核都在这个项目里新开对话，对话归档到项目下；留空会直接报错，不会悄悄退回普通对话。",
			en: "Just the project ID, e.g. 1a15bef4-b7a2-894f-8000-0e7143648841 (the segment after /project/ in the project URL). The plugin builds <domain>/project/<id>?chat_enter_method=new_chat using the domain from the normal-mode URL above. A full project link works too. Each round opens a new chat inside that project and files it there; leaving it empty fails loudly instead of silently falling back to a normal chat."
		}
	},
	{
		path: ["review", "glmUrl"],
		group: "review",
		kind: "text",
		label: {
			zh: "GLM 审核窗口地址",
			en: "GLM review window URL"
		},
		visibleWhen: {
			path: ["review", "provider"],
			equals: "glm"
		},
		hint: {
			zh: "GLM 审核新标签页要打开的链接，默认 https://chat.z.ai/。",
			en: "The link opened for GLM review, default https://chat.z.ai/."
		}
	},
	{
		path: ["review", "glmModel"],
		group: "review",
		kind: "select",
		label: {
			zh: "GLM 审核模型",
			en: "GLM review model"
		},
		options: ["glm-5.3", "glm-5.3-flash"],
		optionLabels: {
			"glm-5.3": {
				zh: "GLM-5.3（旗舰）",
				en: "GLM-5.3 (flagship)"
			},
			"glm-5.3-flash": {
				zh: "GLM-5.3-Flash（更快）",
				en: "GLM-5.3-Flash (faster)"
			}
		},
		visibleWhen: {
			path: ["review", "provider"],
			equals: "glm"
		},
		hint: {
			zh: "审核用的 GLM 模型。默认旗舰 GLM-5.3；追求速度可选 Flash。",
			en: "GLM model used for review. Defaults to the flagship GLM-5.3; pick Flash for speed."
		}
	},
	{
		path: ["review", "glmEffort"],
		group: "review",
		kind: "select",
		label: {
			zh: "GLM 审核思考强度",
			en: "GLM review thinking effort"
		},
		options: [
			"low",
			"high",
			"max"
		],
		optionLabels: {
			low: {
				zh: "快速",
				en: "Fast"
			},
			high: {
				zh: "深度",
				en: "Deep"
			},
			max: {
				zh: "极致",
				en: "Ultra"
			}
		},
		visibleWhen: {
			path: ["review", "provider"],
			equals: "glm"
		},
		hint: {
			zh: "每次审核前插件会在 GLM 页面自动切换并校验；极致最慢但审得最深。",
			en: "The plugin switches and verifies this on the GLM page before each review; Ultra is slowest but most thorough."
		}
	},
	{
		path: ["review", "maxRounds"],
		group: "review",
		kind: "number",
		label: {
			zh: "单任务审核轮数",
			en: "Review rounds per task"
		},
		min: 0,
		max: 10,
		hint: {
			zh: "未通过时回注意见修正，最多这么多轮。",
			en: "When review fails, send comments back for fixes, up to this many rounds."
		}
	},
	{
		path: ["review", "autoSend"],
		group: "review",
		kind: "boolean",
		label: {
			zh: "全自动发送审核请求",
			en: "Fully automatic review sending"
		},
		hint: {
			zh: "开（默认）= 全自动：填入后自动发送并确认真的发出，发不出去当场报错。关 = 半自动：只填入并聚焦审核窗口，等你自己点发送，超时同样会明确报错。",
			en: "On (default) = fully automatic: fill, send, and confirm it really went out; failure errors out immediately. Off = semi-automatic: fill and focus the review window, then wait for you to click send."
		}
	},
	{
		path: ["review", "conversationMode"],
		group: "review",
		kind: "select",
		label: {
			zh: "审核对话模式",
			en: "Review conversation mode"
		},
		options: ["fresh", "reuse"],
		hint: {
			zh: "fresh（默认）：每次审核前新开对话，上下文干净、不会越审越慢。reuse：复用同一个对话，历史会累积，可能被上一轮结论带偏。",
			en: "fresh (default): open a new conversation before each review, keeping context clean and speed stable. reuse: keep one conversation, so history accumulates and can bias later rounds."
		}
	},
	{
		path: ["rateLimit", "enabled"],
		group: "ratelimit",
		kind: "boolean",
		label: {
			zh: "频控自动重发",
			en: "Automatic retry"
		},
		hint: {
			zh: "关闭后遇到频控会直接报错中断回合。",
			en: "Off: rate limiting aborts the turn with an error."
		}
	},
	{
		path: ["rateLimit", "retryDelayMs"],
		group: "ratelimit",
		kind: "number",
		label: {
			zh: "首次重发等待（毫秒）",
			en: "First retry delay (ms)"
		},
		min: 1e3,
		hint: {
			zh: "第一次等待多久；指数退避时作为基数。默认 60000（1 分钟）。",
			en: "How long to wait before the first resend; acts as the base for exponential backoff. Default 60000 (1 minute)."
		}
	},
	{
		path: ["rateLimit", "maxRetries"],
		group: "ratelimit",
		kind: "number",
		label: {
			zh: "单轮最大重发次数",
			en: "Max retries per turn"
		},
		min: 0,
		max: 20,
		hint: {
			zh: "默认 4 次：配合指数退避合计约 12 分钟。用尽后才报 WEB_RATE_LIMITED。",
			en: "Default 4: about 12 minutes total with exponential backoff. Exhausted retries raise WEB_RATE_LIMITED."
		}
	},
	{
		path: ["rateLimit", "backoff"],
		group: "ratelimit",
		kind: "select",
		options: ["exponential", "fixed"],
		label: {
			zh: "退避曲线",
			en: "Backoff curve"
		},
		hint: {
			zh: "exponential（默认）：每次等待翻倍；fixed：每次都等「首次重发等待」。",
			en: "exponential (default): double the wait each time; fixed: always wait the first-retry delay."
		}
	},
	{
		path: ["rateLimit", "retryMaxDelayMs"],
		group: "ratelimit",
		kind: "number",
		label: {
			zh: "单次等待上限（毫秒）",
			en: "Max single delay (ms)"
		},
		min: 1e3,
		hint: {
			zh: "指数退避的封顶值，默认 300000（5 分钟），避免越退越长把回合拖死。",
			en: "Cap for exponential backoff, default 300000 (5 minutes), so the turn never stalls on ever-growing delays."
		}
	},
	{
		path: ["rateLimit", "jitterRatio"],
		group: "ratelimit",
		kind: "number",
		label: {
			zh: "抖动比例（0~0.5）",
			en: "Jitter ratio (0–0.5)"
		},
		min: 0,
		max: .5,
		hint: {
			zh: "每次等待在基准值上随机浮动，默认 0.15（±15%）。多实例同时重撞时能错开。",
			en: "Randomise each delay around the base value; default 0.15 (±15%). Keeps multiple instances from hitting the same second."
		}
	},
	{
		path: ["rateLimit", "accountCooldownMs"],
		group: "ratelimit",
		kind: "number",
		label: {
			zh: "账号级冷却（毫秒）",
			en: "Account cooldown (ms)"
		},
		min: 0,
		max: 36e5,
		hint: {
			zh: "自动重发用尽后，整个账号进入冷却多久，默认 600000（10 分钟）。冷却期内所有会话都快速失败、不再向网页发任何请求——同账号其它会话继续打，正是最容易触发 1 天封禁的形态。0 = 关闭。",
			en: "How long the whole account cools down after resends are exhausted; default 600000 (10 min). While cooling, every session fails fast and nothing reaches the page — other sessions hammering the same account is exactly what triggers a one-day ban. 0 = off."
		}
	},
	{
		path: ["serverBusy", "enabled"],
		group: "ratelimit",
		kind: "boolean",
		label: {
			zh: "服务端不可用自动重发",
			en: "Retry on server unavailable"
		},
		hint: {
			zh: "网页提示「服务器暂时不可用」或返回 5xx 时，等一会儿自动重发同一条消息。关闭后这类失败会立刻报错。",
			en: "When the page says the server is temporarily unavailable or returns 5xx, wait and resend automatically. Off: such failures error out immediately."
		}
	},
	{
		path: ["serverBusy", "retryDelayMs"],
		group: "ratelimit",
		kind: "number",
		label: {
			zh: "服务端故障首次等待（毫秒）",
			en: "First delay on server error (ms)"
		},
		min: 1e3,
		hint: {
			zh: "默认 15000（15 秒）。后端抖动通常几十秒内恢复，等太久只是干坐着；指数退避时作为基数。",
			en: "Default 15000 (15s). Backend hiccups usually clear within a minute; acts as the base for exponential backoff."
		}
	},
	{
		path: ["serverBusy", "maxRetries"],
		group: "ratelimit",
		kind: "number",
		label: {
			zh: "服务端故障最大重发次数",
			en: "Max retries on server error"
		},
		min: 0,
		max: 20,
		hint: {
			zh: "默认 4 次（15s + 30s + 60s + 120s ≈ 3.75 分钟）。用尽后才报 WEB_SERVER_BUSY，且不会锁账号冷却。",
			en: "Default 4 (15s + 30s + 60s + 120s ≈ 3.75 min). Exhausted retries raise WEB_SERVER_BUSY and never trigger the account cooldown."
		}
	},
	{
		path: ["serverBusy", "retryMaxDelayMs"],
		group: "ratelimit",
		kind: "number",
		label: {
			zh: "服务端故障单次等待上限（毫秒）",
			en: "Max single delay on server error (ms)"
		},
		min: 1e3,
		hint: {
			zh: "指数退避封顶，默认 120000（2 分钟）。",
			en: "Cap for exponential backoff; default 120000 (2 minutes)."
		}
	},
	{
		path: ["serverBusy", "backoff"],
		group: "ratelimit",
		kind: "select",
		options: ["exponential", "fixed"],
		label: {
			zh: "服务端故障退避曲线",
			en: "Server-error backoff curve"
		},
		hint: {
			zh: "exponential（默认）：每次翻倍；fixed：每次都等「首次等待」。",
			en: "exponential (default): double each time; fixed: always wait the first delay."
		}
	},
	{
		path: ["serverBusy", "jitterRatio"],
		group: "ratelimit",
		kind: "number",
		label: {
			zh: "服务端故障抖动比例（0~0.5）",
			en: "Server-error jitter (0–0.5)"
		},
		min: 0,
		max: .5,
		hint: {
			zh: "默认 0.2（±20%）。",
			en: "Default 0.2 (±20%)."
		}
	},
	{
		path: ["notify", "enabled"],
		group: "notify",
		kind: "boolean",
		label: {
			zh: "过程提示总开关",
			en: "All notices"
		},
		hint: {
			zh: "关闭后所有提示（含浏览器浮层）都不再出现。",
			en: "Off: no notices at all, including the browser overlay."
		}
	},
	{
		path: ["notify", "session"],
		group: "notify",
		kind: "boolean",
		label: {
			zh: "会话消息提示",
			en: "Session notices"
		},
		hint: {
			zh: "主对话的发送/接收/等待/失败提示（前缀 [DSH]）。",
			en: "Send/receive/wait/failure notices for the main conversation (prefix [DSH])."
		}
	},
	{
		path: ["notify", "review"],
		group: "notify",
		kind: "boolean",
		label: {
			zh: "审核消息提示",
			en: "Review notices"
		},
		hint: {
			zh: "内部审核（自审 / Kimi / GLM）的提示（前缀 [DSH·审核]），与会话提示分开。",
			en: "Notices for internal review (self / Kimi / GLM) with prefix [DSH·review], kept separate from session notices."
		}
	},
	{
		path: ["notify", "send"],
		group: "notify",
		kind: "boolean",
		label: {
			zh: "发送侧提示",
			en: "Send notices"
		},
		hint: {
			zh: "消息已发送 / 已填入等待你点发送。",
			en: "Message sent, or filled in and waiting for your click."
		}
	},
	{
		path: ["notify", "receive"],
		group: "notify",
		kind: "boolean",
		label: {
			zh: "接收侧提示",
			en: "Receive notices"
		},
		hint: {
			zh: "网页已响应、开始生成、本轮完成、频控等待与重发。",
			en: "Page responded, generation started, turn finished, plus rate-limit waits and resends."
		}
	},
	{
		path: ["notify", "errors"],
		group: "notify",
		kind: "boolean",
		label: {
			zh: "失败提示",
			en: "Failure notices"
		},
		hint: {
			zh: "任一错误码（频控、超时、浏览器、登录、审核通道等）都会翻译成一句人话加处理建议。",
			en: "Every error code (rate limit, timeout, browser, login, review channel, …) is translated into one plain sentence with a suggested action."
		}
	},
	{
		path: ["notify", "browser"],
		group: "notify",
		kind: "boolean",
		label: {
			zh: "浏览器浮层",
			en: "Browser overlay"
		},
		hint: {
			zh: "在网页窗口右下角显示频控倒计时等浮层（不挡点击）。只作辅助，主通道是对话里的提示块。",
			en: "Show a click-through overlay in the page corner with the rate-limit countdown. Auxiliary only; the main channel is the in-conversation notice block."
		}
	},
	{
		path: ["browserRecovery", "enabled"],
		group: "browserrecovery",
		kind: "boolean",
		label: {
			zh: "浏览器被关后自动恢复",
			en: "Recover a closed browser"
		},
		hint: {
			zh: "关掉浏览器或网页标签后，自动重启（重连）并重发本轮消息，同时在对话里留一条「恢复」提示。关掉后只报错，需手动重试。",
			en: "After the browser or tab is closed, restart (or reconnect) and resend the turn, leaving a recovery notice. When off, it only reports the error and you retry manually."
		}
	},
	{
		path: ["browserRecovery", "maxAttempts"],
		group: "browserrecovery",
		kind: "number",
		min: 0,
		max: 5,
		label: {
			zh: "单轮最多恢复次数",
			en: "Max recoveries per turn"
		},
		hint: {
			zh: "默认 2 次。连续被关超过这个次数，说明不是手滑而是有东西在反复杀进程，此时直接把原始错误抛出来更有用。",
			en: "Defaults to 2. Repeated closures beyond this usually mean something keeps killing the process, so surfacing the original error is more useful."
		}
	},
	{
		path: ["browserRecovery", "delayMs"],
		group: "browserrecovery",
		kind: "number",
		min: 0,
		max: 6e4,
		label: {
			zh: "重启前等待（毫秒）",
			en: "Delay before restart (ms)"
		},
		hint: {
			zh: "默认 2000。给系统一点时间回收窗口句柄，避免刚重启就被残留进程挡住。",
			en: "Defaults to 2000. Gives the OS time to release window handles before relaunching."
		}
	},
	{
		path: ["archiveCleanup", "deleteOnArchive"],
		group: "archivecleanup",
		kind: "boolean",
		label: {
			zh: "归档时删除网页端对话",
			en: "Delete web chats on archive"
		},
		hint: {
			zh: "默认开。归档一个 DSH 会话时，把它在网页端产生过的对话一并删除；关掉后只归档，网页端保留，统计里会记为「待清理」。",
			en: "On by default. Archiving a DSH session also deletes the web chats it produced; when off, the web chats stay and show up as pending in the stats."
		}
	},
	{
		path: ["archiveCleanup", "includeRotatedChats"],
		group: "archivecleanup",
		kind: "boolean",
		label: {
			zh: "连轮换产生的旧对话一起删",
			en: "Include rotated chats"
		},
		hint: {
			zh: "默认开。一个会话可能因上下文超限轮换出多条网页对话；关掉后只删最后一条，旧的会留在网页端。",
			en: "On by default. One session may rotate through several web chats when the context fills up; when off, only the newest is deleted."
		}
	},
	{
		path: ["toolAllowlist"],
		group: "tools",
		kind: "list",
		label: {
			zh: "工具白名单",
			en: "Tool allowlist"
		},
		hint: {
			zh: "每行一个；支持 mcp__xxx__* 前缀通配。留空表示不限制。",
			en: "One per line; supports mcp__xxx__* prefix wildcards. Empty means no restriction."
		}
	},
	{
		path: ["excludeToolNames"],
		group: "tools",
		kind: "list",
		label: {
			zh: "工具排除名单",
			en: "Excluded tools"
		},
		hint: {
			zh: "每行一个；在白名单之后生效。",
			en: "One per line; applied after the allowlist."
		}
	},
	{
		path: ["delegatedTools"],
		group: "tools",
		kind: "list",
		label: {
			zh: "委托工具",
			en: "Delegated tools"
		},
		hint: {
			zh: "每行一个；只写进提示词交给网页端自带能力，不在本地执行。",
			en: "One per line; only written into the prompt for the page’s own abilities, never executed locally."
		}
	},
	{
		path: ["loginProbe", "enabled"],
		group: "probe",
		kind: "boolean",
		label: {
			zh: "启用登录探活",
			en: "Enable login probe"
		},
		hint: {
			zh: "关掉后完全不做后台检查，登录过期仍会在下一次发送时当场报错。",
			en: "Off: no background checks at all; an expired login still fails loudly on the next send."
		}
	},
	{
		path: ["loginProbe", "initialDelayMs"],
		group: "probe",
		kind: "number",
		label: {
			zh: "启动后首次探活延迟（毫秒）",
			en: "First probe delay (ms)"
		},
		min: 0,
		hint: {
			zh: "默认 20000（20 秒）：等网页把登录态渲染完再判断。",
			en: "Default 20000 (20s): let the page finish rendering the login state first."
		}
	},
	{
		path: ["loginProbe", "intervalMs"],
		group: "probe",
		kind: "number",
		label: {
			zh: "探活间隔（毫秒）",
			en: "Probe interval (ms)"
		},
		min: 0,
		hint: {
			zh: "默认 1800000（30 分钟）。填 0 = 只在启动后探一次。",
			en: "Default 1800000 (30 min). 0 = probe once after startup only."
		}
	},
	{
		path: ["focus", "enabled"],
		group: "focus",
		kind: "boolean",
		label: {
			zh: "自动聚焦总开关",
			en: "Auto focus"
		},
		hint: {
			zh: "关掉后：首次拉起浏览器会最小化到任务栏，填字时也不抢前台；只有需要登录时才自动还原窗口。",
			en: "Off: the browser launches minimized and is never raised while filling; it is restored only when you need to log in."
		}
	},
	{
		path: ["focus", "webWindow"],
		group: "focus",
		kind: "boolean",
		label: {
			zh: "填入时聚焦网页窗口",
			en: "Focus the web window when filling"
		}
	},
	{
		path: ["focus", "dshWindow"],
		group: "focus",
		kind: "boolean",
		label: {
			zh: "回合结束时聚焦 DSH 窗口",
			en: "Focus the DSH window when the turn ends"
		}
	},
	{
		path: ["compactionLanguage"],
		group: "compaction",
		kind: "select",
		label: {
			zh: "压缩摘要语言",
			en: "Summary language"
		},
		options: [
			"task",
			"host",
			"zh",
			"en"
		],
		hint: {
			zh: "task 跟随任务语言；host 保留宿主要求；zh 中文；en 英文。",
			en: "task follows the task language; host keeps the host request; zh Chinese; en English."
		}
	},
	{
		path: ["glmWeb", "url"],
		group: "glmweb",
		kind: "text",
		restart: true,
		label: {
			zh: "GLM 入口地址",
			en: "GLM entry URL"
		},
		hint: {
			zh: "支持 chatglm.cn 与 chat.z.ai（含中国站 zchat.z.ai），插件按域名识别站点。改完重启 DSH 生效。",
			en: "chatglm.cn and chat.z.ai (including zchat.z.ai) are supported; the site is detected by hostname. Restart DSH after changing it."
		}
	},
	{
		path: ["glmWeb", "debugPort"],
		group: "glmweb",
		kind: "number",
		restart: true,
		min: 1024,
		max: 65535,
		label: {
			zh: "GLM 浏览器端口",
			en: "GLM browser port"
		},
		hint: {
			zh: "常驻 GLM 主通道浏览器的 CDP 端口，默认 9337（与审核 9335、豆包 9336 错开）。",
			en: "CDP port of the resident GLM main-channel browser; 9337 by default (review uses 9335, Doubao 9336)."
		}
	},
	{
		path: ["glmWeb", "profileDir"],
		group: "glmweb",
		kind: "text",
		restart: true,
		label: {
			zh: "GLM profile 目录",
			en: "GLM profile directory"
		},
		hint: {
			zh: "留空使用 %LOCALAPPDATA%\\DshDeepSeekWeb\\glm-web-profile；首次需在该窗口登录。",
			en: "Empty uses %LOCALAPPDATA%\\DshDeepSeekWeb\\glm-web-profile. Sign in once in that window."
		}
	},
	{
		path: ["glmWeb", "autoSend"],
		group: "glmweb",
		kind: "boolean",
		label: {
			zh: "GLM 自动发送",
			en: "GLM auto-send"
		},
		hint: {
			zh: "开启后填入即回车并确认发送（agent 链路必需）；关闭则每轮等你在网页点发送。",
			en: "On: fill, press Enter and confirm the send (needed for agent loops). Off: wait for you to click Send each turn."
		}
	},
	{
		path: ["glmWeb", "ackTimeoutMs"],
		group: "glmweb",
		kind: "number",
		restart: true,
		min: 1e4,
		max: 18e5,
		label: {
			zh: "首响应等待（毫秒）",
			en: "First-response timeout (ms)"
		},
		hint: {
			zh: "发送确认后等网页响应头的上限，默认 900000（15 分钟）。GLM 极致档位长任务实测可达 9 分钟以上；审核通道不受此值影响。",
			en: "How long to wait for response headers after a confirmed send; defaults to 900000 (15 min). Ultra-effort long tasks can exceed 9 minutes in practice; the review channel is unaffected."
		}
	},
	{
		path: ["doubao", "enabled"],
		group: "doubao",
		kind: "boolean",
		label: {
			zh: "启用豆包网页通道",
			en: "Enable Doubao web channel"
		},
		hint: {
			zh: "开启后模型列表出现 doubao-web / doubao-web-auto；关闭时不注册、不启动豆包浏览器。",
			en: "On: doubao-web and doubao-web-auto appear in the model list. Off: no provider and no Doubao browser."
		}
	},
	{
		path: ["doubao", "url"],
		group: "doubao",
		kind: "text",
		label: {
			zh: "豆包对话页地址",
			en: "Doubao chat URL"
		},
		hint: {
			zh: "默认 https://www.doubao.com/chat。",
			en: "Defaults to https://www.doubao.com/chat."
		}
	},
	{
		path: ["doubao", "profileDir"],
		group: "doubao",
		kind: "text",
		restart: true,
		label: {
			zh: "豆包独立 profile 目录",
			en: "Doubao profile directory"
		},
		hint: {
			zh: "留空使用 %LOCALAPPDATA%\\DshDeepSeekWeb\\doubao-profile。登录态只保存在这个目录。",
			en: "Empty means %LOCALAPPDATA%\\DshDeepSeekWeb\\doubao-profile. The login lives only in this directory."
		}
	},
	{
		path: ["doubao", "debugPort"],
		group: "doubao",
		kind: "number",
		min: 1024,
		max: 65535,
		restart: true,
		label: {
			zh: "豆包浏览器 CDP 端口",
			en: "Doubao CDP port"
		},
		hint: {
			zh: "与 DeepSeek 通道分开，默认 9336。",
			en: "Separate from the DeepSeek channel; default 9336."
		}
	},
	{
		path: ["doubao", "maxSessionPages"],
		group: "doubao",
		kind: "number",
		min: 1,
		max: 16,
		label: {
			zh: "豆包会话标签页上限",
			en: "Doubao session tab limit"
		},
		hint: {
			zh: "默认 4；超出时回收最久未用的会话页。",
			en: "Default 4; the least-recently-used session page is recycled."
		}
	},
	{
		path: ["doubao", "ackTimeoutMs"],
		group: "doubao",
		kind: "number",
		min: 5e3,
		label: {
			zh: "豆包响应头超时（毫秒）",
			en: "Doubao ack timeout (ms)"
		},
		hint: {
			zh: "默认 120000。",
			en: "Default 120000."
		}
	},
	{
		path: ["doubao", "replyTimeoutMs"],
		group: "doubao",
		kind: "number",
		min: 1e4,
		label: {
			zh: "豆包完整回复超时（毫秒）",
			en: "Doubao reply timeout (ms)"
		},
		hint: {
			zh: "默认 600000。",
			en: "Default 600000."
		}
	}
];
/** 字段在草稿、DOM id 与校验表里的稳定键。 */
function fieldKey(field) {
	return field.path.join(".");
}
/** 生成唯一的 DOM id（同一页面里两组界面不会同时挂载，但 id 仍带前缀）。 */
function fieldDomId(field) {
	return `dsweb-field-${fieldKey(field)}`;
}
/** 按路径读取嵌套值；任一段缺失返回 undefined。 */
function readPath(source, path) {
	let node = source;
	for (const key of path) {
		if (node === null || typeof node !== "object") return void 0;
		node = node[key];
	}
	return node;
}
/** 路径在对象里是否真的存在（用于区分「未覆盖」与「覆盖成 null」）。 */
function hasPath(source, path) {
	let node = source;
	for (const key of path) {
		if (node === null || typeof node !== "object") return false;
		if (!Object.hasOwn(node, key)) return false;
		node = node[key];
	}
	return true;
}
/** 把列表字段的文本解析为数组。 */
function parseList(raw) {
	return raw.split("\n").map((line) => line.trim()).filter(Boolean);
}
/** 把列表字段的值格式化为文本。 */
function formatList(value) {
	if (!Array.isArray(value)) return "";
	return value.filter((item) => typeof item === "string").join("\n");
}
/** 是否相等（配置值都是 JSON 形状，按序列化比较足够）。 */
function sameValue(left, right) {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
/** 深拷贝 JSON 形状的节点。 */
function cloneNode(value) {
	if (Array.isArray(value)) return value.map((item) => cloneNode(item));
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [key, child] of Object.entries(value)) out[key] = cloneNode(child);
		return out;
	}
	return value;
}
/** 在草稿上写入一个字段值（逐级复制，不改动 accepted）。 */
function withEdit(draft, accepted, path, value) {
	const next = cloneNode(draft ?? accepted);
	let node = next;
	for (const key of path.slice(0, -1)) {
		const existing = node[key];
		const child = existing !== null && typeof existing === "object" ? cloneNode(existing) : {};
		node[key] = child;
		node = child;
	}
	node[path[path.length - 1]] = value;
	return next;
}
/** 从草稿里删掉一个字段（用于「恢复默认」后不留旧草稿），顺带清掉空对象。 */
function withoutPath(draft, path) {
	if (draft === null) return null;
	const next = cloneNode(draft);
	const parents = [next];
	let node = next;
	for (const key of path.slice(0, -1)) {
		const child = node[key];
		if (child === null || typeof child !== "object") return next;
		node = child;
		parents.push(node);
	}
	delete node[path[path.length - 1]];
	for (let index = parents.length - 1; index > 0; index -= 1) {
		const child = parents[index];
		if (child === void 0 || Object.keys(child).length > 0) break;
		delete parents[index - 1][path[index - 1]];
	}
	return next;
}
/**
* 把草稿与宿主当前值做差量。
*
* - 草稿里没碰过的字段（`undefined`）不产生操作；
* - 明确清空的字段（`null`）在「原本由用户覆盖」时产生 `unset`，否则视为无改动；
* - 其余按值比较，不同才 `set`。
*/
function diffOps(draft, accepted, user) {
	if (draft === null) return [];
	const ops = [];
	for (const field of FIELDS) {
		const next = readPath(draft, field.path);
		if (next === void 0) continue;
		if (next === null) {
			if (hasPath(user, field.path)) ops.push({
				op: "unset",
				path: [...field.path]
			});
			continue;
		}
		if (sameValue(next, readPath(accepted, field.path))) continue;
		ops.push({
			op: "set",
			path: [...field.path],
			value: next
		});
	}
	return ops;
}
/** 校验单个字段的当前值；`null`（已清空）与 `undefined`（未触碰）都视为合法。 */
function validateField(field, value) {
	if (value === void 0 || value === null) return void 0;
	if (field.kind === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) return "number";
		if (field.min !== void 0 && value < field.min) return "min";
		if (field.max !== void 0 && value > field.max) return "max";
		return;
	}
	if (field.kind === "select") {
		if (typeof value !== "string") return "option";
		if ((field.options ?? []).length > 0 && !(field.options ?? []).includes(value)) return "option";
		return;
	}
}
/** 三档风控预设，按「越靠前越宽松」排列。 */
const RISK_PRESETS = [
	{
		id: "off",
		label: {
			zh: "关闭",
			en: "Off"
		},
		hint: {
			zh: "不插入发送前停顿、也不做长休：节奏最像脚本，只在你明确接受风险时用。",
			en: "No pre-send pause and no long pause; the rhythm looks scripted. Use only if you accept the risk."
		},
		values: [
			{
				path: ["sendPauseMinMs"],
				value: 0
			},
			{
				path: ["sendPauseMaxMs"],
				value: 0
			},
			{
				path: ["turnGapMinMs"],
				value: 0
			},
			{
				path: ["turnGapMaxMs"],
				value: 0
			},
			{
				path: ["longRunAfterSends"],
				value: 0
			}
		]
	},
	{
		id: "balanced",
		label: {
			zh: "均衡（推荐）",
			en: "Balanced (recommended)"
		},
		hint: {
			zh: "每轮随机停 2~4 秒，连发 15 轮休 30~60 秒。同源社区项目长期使用、未触发封禁的一组值，也是默认值。",
			en: "Random 2–4s before each send, long pause of 1–3 min after 15 sends. Sourced from a long-lived peer project; also the defaults."
		},
		values: [
			{
				path: ["sendPauseMinMs"],
				value: 2e3
			},
			{
				path: ["sendPauseMaxMs"],
				value: 4e3
			},
			{
				path: ["turnGapMinMs"],
				value: 2e3
			},
			{
				path: ["turnGapMaxMs"],
				value: 4e3
			},
			{
				path: ["longRunAfterSends"],
				value: 15
			},
			{
				path: ["longRunPauseMinMs"],
				value: 3e4
			},
			{
				path: ["longRunPauseMaxMs"],
				value: 6e4
			}
		]
	},
	{
		id: "strict",
		label: {
			zh: "严格",
			en: "Strict"
		},
		hint: {
			zh: "每轮随机停 5~9 秒，连发 10 轮休 2~5 分钟。已经被限流过、或正在跑长链路自动化时用。",
			en: "Random 5–9s before each send, long pause of 2–5 min after 10 sends. Use after a rate-limit hit or for long tool chains."
		},
		values: [
			{
				path: ["sendPauseMinMs"],
				value: 5e3
			},
			{
				path: ["sendPauseMaxMs"],
				value: 9e3
			},
			{
				path: ["turnGapMinMs"],
				value: 5e3
			},
			{
				path: ["turnGapMaxMs"],
				value: 9e3
			},
			{
				path: ["longRunAfterSends"],
				value: 10
			},
			{
				path: ["longRunPauseMinMs"],
				value: 12e4
			},
			{
				path: ["longRunPauseMaxMs"],
				value: 3e5
			}
		]
	}
];
/** 按当前值判断落在哪个档位；任一项不符即算 `custom`。 */
function matchRiskPreset(source) {
	for (const preset of RISK_PRESETS) if (preset.values.every((item) => sameValue(readPath(source, item.path), item.value))) return preset.id;
	return "custom";
}
/** 把某档位的全部值写进草稿，返回新草稿（不改动并发与标签页上限）。 */
function applyRiskPreset(draft, accepted, preset) {
	let next = draft;
	for (const item of preset.values) next = withEdit(next, accepted, item.path, item.value);
	return next ?? accepted;
}

//#endregion
//#region src/client/i18n.ts
/** locale 命名空间；字典键与设置页文案一一对应。 */
const LOCALE_NAMESPACE = "dsh-deepseek-web";
/** 静态文案；字段/分组/档位文案由 {@link buildDictionaries} 拼进来。 */
const STATIC_COPY = {
	zh: {
		nav: "DeepSeek 网页",
		title: "DeepSeek 网页通道",
		intro: "本插件把 DeepSeek 网页版接入 DSH。改动保存后立即生效；标「重启生效」的项在重启 DSH 后生效。",
		loading: "正在读取宿主配置…",
		unavailableTitle: "设置暂不可用",
		unavailableBody: "宿主没有暴露本插件的可写配置命名空间（llm-deepseek-web）。通常是插件后端未加载，或当前 DSH 版本未开启设置写入。",
		unavailableHint: "仍可直接编辑 profile 的 cordis.patch.yml 覆盖 config。",
		missingForm: "宿主未提供配置表单句柄，无法在此编辑。",
		missingFormTitle: "无法在此编辑",
		missingFormBody: "宿主没有给出该条目的配置句柄。通常是该 entry 的字段未标 volatile，或当前 DSH 版本未开启设置写入。",
		readonly: "当前部署不接受设置写入，字段仅供参考。",
		riskTier: "风控模式（整体档位）",
		riskTierHint: "点一个档位就把相关的发送节奏参数成套写进草稿，再按「保存」生效；手动改下面任一项即变成「自定义」。",
		riskCustom: "自定义",
		custom: "已自定义",
		restart: "重启生效",
		reset: "恢复默认",
		resetDone: "已恢复默认值。",
		save: "保存",
		saving: "保存中…",
		discard: "放弃修改",
		reload: "重新读取",
		reloadHint: "从宿主重新读取（丢弃草稿）",
		dirty: "有未保存的改动",
		dirtyCount: "有 {n} 项改动待保存",
		clean: "没有未保存的改动",
		saved: "已保存。",
		nochange: "没有改动。",
		rejected: "宿主未接受这次保存（版本冲突或校验失败），已重新读取宿主配置；草稿仍在，可直接再点保存。",
		failed: "保存失败：",
		mismatch: "已提交，但回读到的值与草稿不一致，请点「重新读取」确认。",
		invalid: "有字段取值不合法",
		errNumber: "请填数字",
		errMin: "不能小于",
		errMax: "不能大于",
		errOption: "不是可选值",
		listPlaceholder: "每行一个",
		shortcut: "Ctrl+S 保存",
		unknownError: "未知错误",
		groupsLabel: "配置分组",
		configSummary: "审核通道、网页版模型入口、工具白名单、频控退避、过程提示、浏览器自愈与窗口聚焦。",
		"ledger.lang": "zh",
		"ledger.title": "调用台账（只读）",
		"ledger.hint": "按天记录本机最近的网页调用元信息（不含对话内容与凭证），保留 7 天。相邻间隔只统计真正打过网页的成功对话轮，排队时间不算。",
		"ledger.unavailable": "读不到台账：宿主没有提供 webServer 服务，或当前页面不是本机同源。这只影响这张卡片，不影响发送。",
		"ledger.empty": "还没有记录（要么还没真正发过请求，要么刚装不久）。",
		"ledger.total": "近 7 天调用",
		"ledger.chat": "其中对话轮",
		"ledger.failed": "失败次数",
		"ledger.minGap": "最短间隔",
		"ledger.medianGap": "中位间隔",
		"ledger.p90Gap": "p90 间隔",
		"ledger.tight": "出现过 30 秒以内的连环请求——这正是最容易被判机器行为的形态，建议调大发送间隔或长休轮数。",
		"ledger.failures": "失败分布：",
		"ledger.failuresTitle": "失败分布",
		"ledger.days": "按天",
		"ledger.daysHint": "按天拆开的调用量、对话轮、失败数与当天最短间隔。",
		"ledger.perDay": " 次",
		"ledger.minutes": "{m} 分 {s} 秒",
		"doctor.title": "安装自检",
		"doctor.hint": "只报事实、不做修复。默认只跑静态检查（配置 / 浏览器 / 目录 / 构建标识），不会为了自检启动浏览器。",
		"doctor.run": "运行自检",
		"doctor.running": "自检中…",
		"doctor.unavailable": "自检接口不可用（同上：宿主没有 webServer 服务）。也可以在命令行运行 npm run doctor。",
		"doctor.ready": "Doctor result: ready（有 warning 但无 error）",
		"doctor.notReady": "Doctor result: not ready（存在 error，按上面的条目逐项排查）",
		"archiveCleanup.title": "归档清理",
		"archiveCleanup.hint": "归档 DSH 会话时是否删除它在 DeepSeek 网页端产生过的对话。上方开关控制自动删除；这里显示存量统计与手动清理。",
		"archiveCleanup.unavailable": "读不到归档统计：宿主没有提供 webServer 服务，或当前页面不是本机同源。",
		"archiveCleanup.archived": "已归档",
		"archiveCleanup.cleaned": "已清理",
		"archiveCleanup.pending": "待清理",
		"archiveCleanup.unbound": "无绑定",
		"archiveCleanup.failed": "失败",
		"archiveCleanup.run": "清理待清理项",
		"archiveCleanup.runHint": "删除已归档会话在网页端留下的对话；无绑定会话没有网页对话 id，只能统计。",
		"archiveCleanup.runNow": "立即清理",
		"archiveCleanup.running": "清理中…",
		"archiveCleanup.runDone": "已清理 {n} 条网页对话。",
		"archiveCleanup.runNone": "没有可清理的会话。",
		"archiveCleanup.unboundHint": "无绑定的会话是功能上线前归档的，没有网页对话 id，只能统计、不能删除。",
		"archiveCleanup.purge": "清空网页端所有会话",
		"archiveCleanup.purgeShortHint": "不可恢复；展开后需输入确认词。",
		"archiveCleanup.purgeTitle": "清空网页端所有会话",
		"archiveCleanup.purgeHint": "将删除 DeepSeek 网页端的全部对话，不可恢复；正在使用的会话也会被删，下一轮会重建新对话。",
		"archiveCleanup.purgeCount": "当前网页端共有 {n} 条对话。",
		"archiveCleanup.countFailed": "读取网页端会话数量失败。",
		"archiveCleanup.retry": "重试",
		"archiveCleanup.purgeConfirmLabel": "输入「清空网页端」以确认",
		"archiveCleanup.purgeCancel": "取消",
		"archiveCleanup.purgeSubmit": "确认清空",
		"archiveCleanup.purging": "清空中…",
		"archiveCleanup.purgeDone": "已删除 {n} 条，失败 {m} 条。",
		"archiveCleanup.purgeMismatch": "数量已变化，请重新打开确认框。",
		"archiveCleanup.loading": "正在读取…",
		"login.title": "登录态",
		"login.hint": "显示插件浏览器的登录态，可立即检测、打开登录窗口，或从别处导入登录态。检测只读，不会为了检测拉起浏览器。",
		"doubaoLogin.title": "豆包登录态",
		"doubaoLogin.hint": "显示豆包独立浏览器 profile 的登录态。检测只读，不会为了检测拉起浏览器；需要登录时从这里打开豆包窗口。豆包一期不支持导入/导出登录态。",
		"doubaoLogin.openHint": "会在豆包独立浏览器窗口打开登录页，登录完成后自动复检。",
		"doubaoLogin.disabled": "豆包网页通道尚未启用。请先在上方「豆包网页」分组里打开「启用豆包网页通道」，保存并重启 DSH。",
		"login.status.ok": "登录态正常",
		"login.status.expired": "登录态已失效",
		"login.status.unknown": "无法判断",
		"login.checkedAt": "检测时间",
		"login.never": "还没检测过",
		"login.browser.started": "浏览器已启动",
		"login.browser.stopped": "浏览器未启动",
		"login.probe": "立即检测",
		"login.probing": "检测中…",
		"login.open": "打开浏览器去登录",
		"login.openHint": "会在独立浏览器窗口打开 DeepSeek 登录页，登录完成后自动复检。",
		"login.glm.title": "GLM 登录态",
		"login.glm.hint": "显示 GLM 主通道窗口的登录态。检测只读，不会为了检测拉起浏览器；首次使用先点「打开浏览器去登录」完成一次登录。",
		"login.glm.openHint": "会在独立 GLM 窗口打开 chatglm.cn / chat.z.ai，登录完成后自动复检。",
		"login.opening": "正在打开…",
		"login.opened": "已打开浏览器窗口，请在窗口中完成登录",
		"login.already": "浏览器已处于登录状态",
		"login.openDetail": "（{detail}）",
		"login.polling": "等待登录完成…",
		"login.importLabel": "导入登录态（userToken 或完整 JSON）",
		"login.advanced": "高级：导入 / 导出登录态",
		"login.advancedHint": "换机、token 失效或需要备份时用；导入会刷新网页标签并中断正在生成的回复。",
		"login.importHint": "粘贴 userToken、{\"value\":\"...\"} 或 {\"userToken\":\"...\",\"cookies\":[...]}。导入会刷新网页标签，正在生成的回复会中断。",
		"login.importPlaceholder": "粘贴 userToken 或完整登录态 JSON",
		"login.import": "导入并检测",
		"login.importing": "导入中…",
		"login.importOk": "已导入，登录态正常",
		"login.importWarn": "已写入，但检测仍未登录：请检查 token 是否过期",
		"login.importPend": "已写入，正在等待页面加载并复检…",
		"login.export": "复制登录态",
		"login.exporting": "读取中…",
		"login.copied": "已复制到剪贴板（凭证敏感，勿外传）",
		"login.copyManual": "无法自动复制，请手动全选下面的内容",
		"login.exportWarning": "导出的 token 等同账号凭证，请勿分享。",
		"login.unavailable": "读不到登录态：宿主没有提供 webServer 服务，或当前页面不是本机同源。",
		"login.emptyRaw": "请先粘贴登录态内容",
		"login.exportTitle": "登录态（手动复制）"
	},
	en: {
		nav: "DeepSeek Web",
		title: "DeepSeek Web channel",
		intro: "This plugin connects the DeepSeek web app to DSH. Saved changes apply immediately; items marked “Restart to apply” take effect after a DSH restart.",
		loading: "Reading host settings…",
		unavailableTitle: "Settings unavailable",
		unavailableBody: "The host does not expose this plugin’s writable settings namespace (llm-deepseek-web). Usually the plugin host half is not loaded, or this DSH build does not accept settings writes.",
		unavailableHint: "You can still override config in the profile’s cordis.patch.yml.",
		missingForm: "The host did not provide a settings form handle, so this page cannot edit anything.",
		missingFormTitle: "Cannot edit here",
		missingFormBody: "The host returned no config handle for this entry. Usually the entry’s fields are not marked volatile, or this DSH build does not accept settings writes.",
		readonly: "This deployment does not accept settings writes; fields are read-only.",
		riskTier: "Risk control profile",
		riskTierHint: "Picking a profile writes the related send-pacing values into the draft; press Save to apply. Editing any value by hand shows “Custom”.",
		riskCustom: "Custom",
		custom: "Customized",
		restart: "Restart to apply",
		reset: "Reset to default",
		resetDone: "Reset to the default value.",
		save: "Save",
		saving: "Saving…",
		discard: "Discard changes",
		reload: "Reload from host",
		reloadHint: "Re-read host settings and drop the draft",
		dirty: "Unsaved changes",
		dirtyCount: "{n} unsaved change(s)",
		clean: "No unsaved changes",
		saved: "Saved.",
		nochange: "Nothing to save.",
		rejected: "The host rejected this save (revision conflict or validation failure). Host settings were re-read; your draft is kept — press Save again.",
		failed: "Save failed: ",
		mismatch: "Submitted, but the re-read value differs from the draft. Press “Reload from host” to confirm.",
		invalid: "Some values are invalid",
		errNumber: "Enter a number",
		errMin: "Must be at least",
		errMax: "Must be at most",
		errOption: "Not an allowed value",
		listPlaceholder: "One per line",
		shortcut: "Ctrl+S to save",
		unknownError: "unknown error",
		groupsLabel: "Configuration groups",
		configSummary: "Review channel, web model entry, tool allowlist, rate-limit backoff, progress notices, browser recovery and window focus.",
		"ledger.lang": "en",
		"ledger.title": "Call ledger (read-only)",
		"ledger.hint": "Daily metadata about this machine’s web calls (no message content, no credentials), kept for 7 days. Gaps only count successful chat turns that actually reached the web page; queueing time is excluded.",
		"ledger.unavailable": "Cannot read the ledger: the host exposes no webServer service, or this page is not same-origin. Only this card is affected — sending still works.",
		"ledger.empty": "No entries yet (either nothing was really sent, or the plugin was just installed).",
		"ledger.total": "Calls (7d)",
		"ledger.chat": "Chat turns",
		"ledger.failed": "Failures",
		"ledger.minGap": "Shortest gap",
		"ledger.medianGap": "Median gap",
		"ledger.p90Gap": "p90 gap",
		"ledger.tight": "A back-to-back request under 30 seconds was observed — the clearest machine-behaviour signal. Consider larger send gaps or a longer long-run pause.",
		"ledger.failures": "Failures: ",
		"ledger.failuresTitle": "Failures",
		"ledger.days": "Per day",
		"ledger.daysHint": "Per-day calls, chat turns, failures and the shortest gap of that day.",
		"ledger.perDay": " calls",
		"ledger.minutes": "{m}m {s}s",
		"doctor.title": "Install self-check",
		"doctor.hint": "Reports facts only; it never fixes anything. Only static checks run by default (config / browser / directories / build id) — no browser is started for a self-check.",
		"doctor.run": "Run self-check",
		"doctor.running": "Checking…",
		"doctor.unavailable": "Self-check route unavailable (same reason: no webServer service). You can also run npm run doctor from a shell.",
		"doctor.ready": "Doctor result: ready (warnings allowed, no errors)",
		"doctor.notReady": "Doctor result: not ready (errors found — work through the items above)",
		"archiveCleanup.title": "Archive cleanup",
		"archiveCleanup.hint": "Whether archiving a DSH session also deletes the DeepSeek web chats it produced. The switch above controls automatic deletion; this card shows existing stats and manual cleanup.",
		"archiveCleanup.unavailable": "Cannot read archive stats: the host exposes no webServer service, or this page is not same-origin.",
		"archiveCleanup.archived": "Archived",
		"archiveCleanup.cleaned": "Cleaned",
		"archiveCleanup.pending": "Pending",
		"archiveCleanup.unbound": "Unbound",
		"archiveCleanup.failed": "Failed",
		"archiveCleanup.run": "Clean pending",
		"archiveCleanup.runHint": "Deletes the web chats left by archived sessions. Unbound sessions have no web chat id, so they can only be counted.",
		"archiveCleanup.runNow": "Clean now",
		"archiveCleanup.running": "Cleaning…",
		"archiveCleanup.runDone": "Deleted {n} web chats.",
		"archiveCleanup.runNone": "Nothing to clean.",
		"archiveCleanup.unboundHint": "Unbound sessions were archived before this feature shipped; they have no web chat ids and can only be counted, not deleted.",
		"archiveCleanup.purge": "Delete all web chats",
		"archiveCleanup.purgeShortHint": "Irreversible; expand and type the confirmation phrase.",
		"archiveCleanup.purgeTitle": "Delete all web chats",
		"archiveCleanup.purgeHint": "Deletes every chat on DeepSeek web. This is irreversible; sessions currently in use are included and will start a fresh chat next turn.",
		"archiveCleanup.purgeCount": "There are {n} chats on the web side right now.",
		"archiveCleanup.countFailed": "Could not read the number of web chats.",
		"archiveCleanup.retry": "Retry",
		"archiveCleanup.purgeConfirmLabel": "Type “清空网页端” to confirm",
		"archiveCleanup.purgeCancel": "Cancel",
		"archiveCleanup.purgeSubmit": "Delete everything",
		"archiveCleanup.purging": "Deleting…",
		"archiveCleanup.purgeDone": "Deleted {n}, failed {m}.",
		"archiveCleanup.purgeMismatch": "The count changed. Reopen the dialog and try again.",
		"archiveCleanup.loading": "Reading…",
		"login.title": "Login state",
		"login.hint": "Shows the plugin browser’s login state. Probe it, open the login window, or import a login state from another machine. Probing is read-only and never starts the browser.",
		"doubaoLogin.title": "Doubao login state",
		"doubaoLogin.hint": "Shows the login state of the separate Doubao browser profile. Probing is read-only and never starts the browser; use the button to open the Doubao window when you need to sign in. Import/export is not supported for Doubao in this version.",
		"doubaoLogin.openHint": "Opens the Doubao login page in its own browser window and rechecks after you sign in.",
		"doubaoLogin.disabled": "The Doubao web channel is disabled. Enable it in the Doubao web section above, save, and restart DSH.",
		"login.status.ok": "Logged in",
		"login.status.expired": "Login expired",
		"login.status.unknown": "Unknown",
		"login.checkedAt": "Checked",
		"login.never": "Not checked yet",
		"login.browser.started": "Browser running",
		"login.browser.stopped": "Browser not running",
		"login.probe": "Check now",
		"login.probing": "Checking…",
		"login.open": "Open browser to log in",
		"login.openHint": "Opens the DeepSeek sign-in page in a dedicated browser window and re-checks when you finish.",
		"login.glm.title": "GLM login state",
		"login.glm.hint": "Shows the login state of the GLM main-channel window. Checking is read-only and never starts the browser; sign in once via “Open browser to sign in”.",
		"login.glm.openHint": "Opens chatglm.cn / chat.z.ai in a dedicated GLM window and re-checks when you finish.",
		"login.opening": "Opening…",
		"login.opened": "Browser window opened — please log in there",
		"login.already": "The browser is already logged in",
		"login.openDetail": " ({detail})",
		"login.polling": "Waiting for login…",
		"login.importLabel": "Import login state (userToken or full JSON)",
		"login.advanced": "Advanced: import / export login state",
		"login.advancedHint": "For moving machines, expired tokens or backups. Importing reloads web tabs and interrupts any in-flight reply.",
		"login.importHint": "Paste a userToken, {\"value\":\"...\"} or {\"userToken\":\"...\",\"cookies\":[...]}. Importing reloads web tabs; any in-flight reply is interrupted.",
		"login.importPlaceholder": "Paste a userToken or the full login-state JSON",
		"login.import": "Import and check",
		"login.importing": "Importing…",
		"login.importOk": "Imported; login state is now valid",
		"login.importWarn": "Written, but still not logged in — check whether the token has expired",
		"login.importPend": "Written; waiting for the page to load and re-check…",
		"login.export": "Copy login state",
		"login.exporting": "Reading…",
		"login.copied": "Copied to clipboard (treat it as a credential)",
		"login.copyManual": "Could not copy automatically — select the text below",
		"login.exportWarning": "The exported token is a credential; never share it.",
		"login.unavailable": "Cannot read login state: the host exposes no webServer service, or this page is not same-origin.",
		"login.emptyRaw": "Paste a login state first",
		"login.exportTitle": "Login state (copy manually)"
	}
};
/** 由字段规格派生的分组 / 字段 / 档位 / 下拉选项文案，拼进两份字典。 */
function buildDictionaries() {
	const zh = { ...STATIC_COPY.zh };
	const en = { ...STATIC_COPY.en };
	for (const group of GROUPS) {
		zh[`group.${group.id}`] = group.label.zh;
		en[`group.${group.id}`] = group.label.en;
		zh[`group.${group.id}.hint`] = group.hint.zh;
		en[`group.${group.id}.hint`] = group.hint.en;
	}
	for (const field of FIELDS) {
		const key = fieldKey(field);
		zh[`field.${key}`] = field.label.zh;
		en[`field.${key}`] = field.label.en;
		if (field.hint !== void 0) {
			zh[`field.${key}.hint`] = field.hint.zh;
			en[`field.${key}.hint`] = field.hint.en;
		}
		if (field.optionLabels !== void 0) for (const [value, text] of Object.entries(field.optionLabels)) {
			zh[`field.${key}.opt.${value}`] = text.zh;
			en[`field.${key}.opt.${value}`] = text.en;
		}
	}
	for (const preset of RISK_PRESETS) {
		zh[`risk.${preset.id}`] = preset.label.zh;
		en[`risk.${preset.id}`] = preset.label.en;
		zh[`risk.${preset.id}.hint`] = preset.hint.zh;
		en[`risk.${preset.id}.hint`] = preset.hint.en;
	}
	return {
		zh,
		en
	};
}
/** 两份完整字典；`ctx.locale.register` 要求两边键集合一致。 */
const LOCALE_DICTIONARIES = buildDictionaries();
/**
* 按系统语言判定界面语言。
*
* @param source - 系统语言标签；缺省读 `navigator.language`。
* @returns `zh` 或 `en`；任何非中文标签都落到 `en`。
*/
function detectSystemLanguage(source) {
	const value = source ?? (typeof navigator === "undefined" ? "" : navigator.language);
	return /^zh\b/i.test(value) ? "zh" : "en";
}
/**
* 把配置里的语言取值解析成实际语言。
*
* @param setting - 配置值（`auto` / `zh` / `en`，或任何脏数据）。
* @param systemLanguage - 测试注入的系统语言；生产环境留空。
* @returns 实际生效的界面语言。
*/
function resolveUiLanguage(setting, systemLanguage) {
	if (setting === "zh") return "zh";
	if (setting === "en") return "en";
	return detectSystemLanguage(systemLanguage);
}
/**
* 取文案。
*
* @param language - 已解析的界面语言。
* @param key - 字典键。
* @returns 文案；缺键时返回 key 本身。
*/
function translateBy(language, key) {
	return LOCALE_DICTIONARIES[language][key] ?? key;
}
/**
* 为某个语言生成翻译器。
*
* @param language - 已解析的界面语言。
* @returns 绑定语言的 `t`。
*/
function translatorFor(language) {
	return (key) => translateBy(language, key);
}

//#endregion
//#region src/client/settings-ui.tsx
/** 徽标：一行的补充状态，不抢标题的视觉权重。 */
function Badge(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		className: `dsweb-badge dsweb-badge-${props.tone ?? "muted"}`,
		children: props.children
	});
}
/**
* 卡片：分组卡与附属卡共用，靠 `variant` 拉开层级。
*
* `collapsible` 打开后标题行变成展开按钮：只切本地 state，不卸载内容，动画由 CSS 的
* `grid-template-rows: 0fr -> 1fr` 负责，所以折叠再展开不会丢输入焦点以外的任何状态。
*/
function Card(props) {
	const variant = props.variant ?? "config";
	const collapsible = props.collapsible === true;
	const [open, setOpen] = (0, react.useState)(props.defaultOpen ?? true);
	const bodyId = (0, react.useId)();
	const titleId = (0, react.useId)();
	const title = props.title === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
		className: "dsweb-card-title",
		id: titleId,
		children: collapsible ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			className: "dsweb-card-toggle",
			"aria-expanded": open,
			"aria-controls": bodyId,
			onClick: () => setOpen((value) => !value),
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsweb-card-title-text",
				children: props.title
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsweb-chevron",
				"aria-hidden": "true"
			})]
		}) : props.title
	});
	const heading = title === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsweb-card-heading",
		children: [props.index !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "dsweb-card-index",
			children: String(props.index).padStart(2, "0")
		}), title]
	});
	const hint = props.hint === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		className: "dsweb-card-hint",
		children: props.hint
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: `dsweb-card dsweb-card-${variant}`,
		"data-group": props.groupId,
		"data-open": open ? "true" : "false",
		id: props.groupId === void 0 ? void 0 : `dsweb-group-${props.groupId}`,
		"aria-labelledby": props.title === void 0 ? void 0 : titleId,
		children: [(heading !== null || hint !== null) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
			className: "dsweb-card-head",
			children: [heading, hint]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "dsweb-collapse",
			"data-open": open ? "true" : "false",
			id: bodyId,
			inert: open ? void 0 : true,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsweb-collapse-inner",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-card-body",
					children: props.children
				})
			})
		})]
	});
}
/**
* 折叠分区：卡片内部的次级内容（按天明细、安装自检、危险操作、导入导出）。
*
* 支持受控（`open` + `onOpenChange`）与非受控（`defaultOpen`）两种用法；受控用于
* 「展开时才去加载待清理数量」这类副作用。
*/
function Fold(props) {
	const [innerOpen, setInnerOpen] = (0, react.useState)(props.defaultOpen ?? false);
	const controlled = props.open !== void 0;
	const open = controlled ? props.open === true : innerOpen;
	const bodyId = (0, react.useId)();
	const toggle = () => {
		const next = !open;
		if (!controlled) setInnerOpen(next);
		props.onOpenChange?.(next);
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: `dsweb-fold${props.tone === "danger" ? " dsweb-fold-danger" : ""}`,
		"data-open": open ? "true" : "false",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsweb-fold-head",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "dsweb-fold-toggle",
					id: props.toggleId,
					"aria-expanded": open,
					"aria-controls": bodyId,
					onClick: toggle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsweb-fold-title",
						children: props.title
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsweb-chevron",
						"aria-hidden": "true"
					})]
				}), props.actions !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-fold-actions",
					children: props.actions
				})]
			}),
			props.hint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsweb-fold-hint",
				children: props.hint
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsweb-collapse",
				"data-open": open ? "true" : "false",
				id: bodyId,
				inert: open ? void 0 : true,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-collapse-inner",
					children: props.children
				})
			})
		]
	});
}
/** 统计块：数字在上、标签在下，色调只表达「要不要注意」。 */
function Stat(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: `dsweb-stat dsweb-stat-${props.tone ?? "neutral"}`,
		title: props.title ?? props.label,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsweb-stat-value",
				children: props.value
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsweb-stat-label",
				children: props.label
			}),
			props.hint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsweb-stat-hint",
				children: props.hint
			})
		]
	});
}
/** 页面骨架：页头 + 左栏索引 + 内容 + 常驻操作栏。 */
function SettingsPage(props) {
	const rail = props.rail ?? null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsweb-page",
		"data-dsweb-settings": props.state ?? "ready",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
				className: "dsweb-head",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsweb-head-main",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "dsweb-title",
						children: props.title
					}), props.subtitle !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dsweb-sub",
						children: props.subtitle
					})]
				}), props.badges !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-head-badges",
					children: props.badges
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: `dsweb-shell${rail === null ? " dsweb-shell-plain" : ""}`,
				children: [rail, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-content",
					children: props.children
				})]
			}),
			props.actions !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionBar, {
				status: props.status,
				tone: props.statusTone,
				actions: props.actions
			})
		]
	});
}
/**
* 分组导航：窄面板是顶部横条，宽面板是左侧竖栏。
*
* 横条支持三种操作，解决「隐藏滚动条 + 鼠标拖不动 = 后面分组到不了」：
* 1. 鼠标按住拖拽（只接管 mouse，触屏保留原生惯性滚动）；
* 2. 滚轮竖向增量转横向滚动；
* 3. 当前分组随页面滚动切换时自动滚到可视区中央。
*/
function Rail(props) {
	const ref = (0, react.useRef)(null);
	const drag = (0, react.useRef)(null);
	const suppressClick = (0, react.useRef)(false);
	const clickTimer = (0, react.useRef)(void 0);
	const [dragging, setDragging] = (0, react.useState)(false);
	(0, react.useEffect)(() => () => {
		if (clickTimer.current !== void 0) window.clearTimeout(clickTimer.current);
	}, []);
	(0, react.useEffect)(() => {
		const node = ref.current;
		if (node === null) return;
		const onWheel = (event) => {
			if (node.scrollWidth <= node.clientWidth + 1) return;
			if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
			node.scrollLeft += event.deltaY;
			event.preventDefault();
		};
		node.addEventListener("wheel", onWheel, { passive: false });
		return () => node.removeEventListener("wheel", onWheel);
	}, []);
	(0, react.useEffect)(() => {
		const node = ref.current;
		if (node === null || props.activeId === void 0) return;
		if (node.scrollWidth <= node.clientWidth + 1) return;
		const item = node.querySelector(`[data-rail-id="${props.activeId}"]`);
		if (item === null) return;
		const left = item.offsetLeft - (node.clientWidth - item.offsetWidth) / 2;
		const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		node.scrollTo({
			left,
			behavior: reduced ? "auto" : "smooth"
		});
	}, [props.activeId]);
	const startDrag = (event) => {
		if (event.pointerType !== "mouse" || event.button !== 0) return;
		const node = ref.current;
		if (node === null || node.scrollWidth <= node.clientWidth + 1) return;
		drag.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startLeft: node.scrollLeft,
			moved: false,
			captured: false
		};
	};
	const moveDrag = (event) => {
		const state = drag.current;
		const node = ref.current;
		if (state === null || node === null || state.pointerId !== event.pointerId) return;
		const delta = event.clientX - state.startX;
		if (!state.captured) {
			if (Math.abs(delta) <= 4) return;
			state.captured = true;
			node.setPointerCapture(event.pointerId);
			setDragging(true);
		}
		state.moved = true;
		node.scrollLeft = state.startLeft - delta;
	};
	const endDrag = (event) => {
		const state = drag.current;
		const node = ref.current;
		if (state === null) return;
		if (state.captured && node !== null && node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
		suppressClick.current = state.moved;
		drag.current = null;
		setDragging(false);
		if (clickTimer.current !== void 0) window.clearTimeout(clickTimer.current);
		clickTimer.current = window.setTimeout(() => {
			suppressClick.current = false;
			clickTimer.current = void 0;
		}, 0);
	};
	const lostPointerCapture = () => {
		if (drag.current === null) return;
		drag.current = null;
		setDragging(false);
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("nav", {
		className: "dsweb-rail",
		"aria-label": props.label,
		ref,
		"data-dragging": dragging ? "true" : "false",
		onPointerDown: startDrag,
		onPointerMove: moveDrag,
		onPointerUp: endDrag,
		onPointerCancel: endDrag,
		onLostPointerCapture: lostPointerCapture,
		onClickCapture: (event) => {
			if (!suppressClick.current) return;
			event.preventDefault();
			event.stopPropagation();
		},
		children: props.items.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			className: "dsweb-rail-item",
			"data-rail-id": item.id,
			"aria-current": item.id === props.activeId ? "true" : void 0,
			onClick: () => props.onSelect(item.id),
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsweb-rail-index",
					children: String(item.index).padStart(2, "0")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsweb-rail-label",
					children: item.label
				}),
				item.dirty === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsweb-rail-dot",
					"aria-hidden": "true"
				})
			]
		}, item.id))
	});
}
/** 一行字段：左标题/徽标/说明/错误，右控件与「恢复默认」。 */
function FieldRow(props) {
	const label = props.domId === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		className: "dsweb-row-label",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.label }), props.badges]
	}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
		className: "dsweb-row-label",
		htmlFor: props.domId,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.label }), props.badges]
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: `dsweb-row${props.wide === true ? " dsweb-row-wide" : ""}`,
		"data-field": props.fieldId,
		"data-invalid": props.error === void 0 ? void 0 : "true",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "dsweb-row-text",
			children: [
				label,
				props.hint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dsweb-row-hint",
					children: props.hint
				}),
				props.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dsweb-row-error",
					children: props.error
				})
			]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "dsweb-row-control",
			children: [props.control, props.reset]
		})]
	});
}
/** 按字段类型渲染控件。 */
function FieldControl(props) {
	const { field, value, domId, listText, invalid, disabled, placeholder, optionLabel, onChange, onChangeList } = props;
	if (field.kind === "boolean") {
		const checked = value === true;
		return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
			id: domId,
			className: "dsweb-switch",
			type: "checkbox",
			role: "switch",
			"aria-checked": checked,
			disabled: disabled === true,
			checked,
			onChange: (event) => onChange(event.target.checked)
		});
	}
	if (field.kind === "select") {
		const options = field.options ?? [];
		const selected = typeof value === "string" ? value : "";
		const rendered = selected !== "" && !options.includes(selected) ? [selected, ...options] : options;
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
			id: domId,
			className: "dsweb-select",
			disabled: disabled === true,
			value: selected,
			onChange: (event) => onChange(event.target.value === "" ? null : event.target.value),
			children: [selected === "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
				value: "",
				children: "—"
			}), rendered.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
				value: option,
				children: optionLabel === void 0 ? option : optionLabel(option)
			}, option))]
		});
	}
	if (field.kind === "number") {
		const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value : "";
		return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
			id: domId,
			className: `dsweb-input${invalid === true ? " dsweb-input-invalid" : ""}`,
			type: "number",
			inputMode: "numeric",
			step: 1,
			min: field.min,
			max: field.max,
			disabled: disabled === true,
			value: text,
			onChange: (event) => {
				const raw = event.target.value;
				if (raw === "") {
					onChange(null);
					return;
				}
				const parsed = Number(raw);
				onChange(Number.isFinite(parsed) ? parsed : raw);
			}
		});
	}
	if (field.kind === "list") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
		id: domId,
		className: `dsweb-textarea${invalid === true ? " dsweb-input-invalid" : ""}`,
		rows: 4,
		spellCheck: false,
		placeholder,
		disabled: disabled === true,
		value: listText ?? formatList(value),
		onChange: (event) => onChangeList(event.target.value)
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
		id: domId,
		className: `dsweb-input${invalid === true ? " dsweb-input-invalid" : ""}`,
		type: "text",
		spellCheck: false,
		disabled: disabled === true,
		value: typeof value === "string" ? value : "",
		onChange: (event) => onChange(event.target.value)
	});
}
/** 底部常驻操作栏：左状态、右按钮。 */
function ActionBar(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsweb-actionbar",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: `dsweb-actionbar-status dsweb-tone-${props.tone ?? "info"}`,
			role: "status",
			"aria-live": "polite",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsweb-status-dot",
				"aria-hidden": "true"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.status })]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "dsweb-actions",
			children: props.actions
		})]
	});
}
/** 加载骨架。 */
function Skeleton(props) {
	const rows = props.rows ?? 3;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: Array.from({ length: rows }, (_, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsweb-skeleton" }, index)) });
}

//#endregion
//#region src/client/config-page.tsx
/** 本包在 profile 里的 npm 包名。 */
const PACKAGE_NAME = "dsh-deepseek-web-xxxxxgold";
/** 插件入口在包自带 patch 里声明的行 id；与包名一起构成槽位 key，也是宿主的 settings entry id。 */
const ROW_ENTRY_ID = "llm-deepseek-web";
/** 本插件在 Plugin Manager 里的 `plugins.row.config` 槽位 key。 */
const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ROW_ENTRY_ID}`;
/**
* 判断一个字段是否应当显示。
*
* `visibleWhen` 支持单条件或条件数组：数组要求**全部满足**，
* 这样「provider 是 kimi 且 kimiMode 是 project」才能精确只显示项目链接框。
*/
function isFieldVisible(rule, current) {
	if (rule === void 0) return true;
	return ("path" in rule ? [rule] : rule).every((item) => readPath(current, item.path) === item.equals);
}
/** 校验错误的人话文案。 */
function errorText$2(field, code, t) {
	switch (code) {
		case "number": return t("errNumber");
		case "min": return `${t("errMin")} ${field.min ?? ""}`.trim();
		case "max": return `${t("errMax")} ${field.max ?? ""}`.trim();
		case "option": return t("errOption");
		default: return "";
	}
}
/**
* 渲染本插件的配置页。
*
* @param props - 槽位宿主传入的 `view` 与页面表单句柄。
* @returns `summary` 为卡片一行说明；`page` 为可编辑表单。
*/
function DeepSeekWebConfigPage({ view, form }) {
	const [draft, setDraft] = (0, react.useState)(null);
	const [busy, setBusy] = (0, react.useState)(false);
	const [notice, setNotice] = (0, react.useState)(null);
	const [activeGroup, setActiveGroup] = (0, react.useState)(GROUPS[0]?.id ?? "");
	(0, react.useEffect)(() => {
		if (view !== "page" || typeof IntersectionObserver === "undefined") return;
		const nodes = GROUPS.map((group) => document.getElementById(`dsweb-group-${group.id}`)).filter((node) => node !== null);
		if (nodes.length === 0) return;
		const observer = new IntersectionObserver((entries) => {
			const hit = entries.filter((entry) => entry.isIntersecting).sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
			if (hit !== void 0) setActiveGroup(hit.target.id.replace("dsweb-group-", ""));
		}, { rootMargin: "-15% 0px -70% 0px" });
		for (const node of nodes) observer.observe(node);
		return () => observer.disconnect();
	}, [view]);
	const accepted = form?.state.value ?? {};
	const t = translatorFor(resolveUiLanguage(readPath(draft ?? accepted, ["uiLanguage"])));
	if (view === "summary") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: t("configSummary") });
	if (form === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsPage, {
		title: t("title"),
		badges: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
			tone: "warn",
			children: t("missingFormTitle")
		}),
		state: "missing",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
			variant: "aux",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsweb-banner dsweb-banner-warn",
				children: t("missingFormBody")
			})
		})
	});
	const user = form.state.user ?? {};
	const revision = form.state.revision;
	const writable = form.state.writable === true;
	const current = draft ?? accepted;
	const errors = /* @__PURE__ */ new Map();
	for (const field of FIELDS) {
		const code = validateField(field, readPath(current, field.path));
		if (code !== void 0) errors.set(fieldKey(field), code);
	}
	const blocked = errors.size > 0;
	const pending = diffOps(draft, accepted, user);
	const dirty = pending.length > 0;
	/** 暂存一次字段修改。 */
	const edit = (path, value) => {
		setNotice(null);
		setDraft((previous) => {
			const next = { ...previous ?? accepted };
			let node = next;
			for (const key of path.slice(0, -1)) {
				const existing = node[key];
				const child = existing !== null && typeof existing === "object" ? { ...existing } : {};
				node[key] = child;
				node = child;
			}
			node[path[path.length - 1]] = value;
			return next;
		});
	};
	/** 提交与本页字段相关的全部改动。 */
	const save = async () => {
		if (!form || draft === null) return;
		if (blocked) {
			setNotice({
				tone: "warn",
				text: t("invalid")
			});
			return;
		}
		const ops = diffOps(draft, accepted, user);
		if (ops.length === 0) {
			setNotice({
				tone: "info",
				text: t("nochange")
			});
			return;
		}
		setBusy(true);
		try {
			const ok = await form.mutate(ops, revision);
			setNotice(ok ? {
				tone: "success",
				text: t("saved")
			} : {
				tone: "error",
				text: t("rejected")
			});
			if (ok) setDraft(null);
		} catch (error) {
			setNotice({
				tone: "error",
				text: `${t("failed")}${error instanceof Error ? error.message : String(error)}`
			});
		} finally {
			setBusy(false);
		}
	};
	const selectGroup = (groupId) => {
		setActiveGroup(groupId);
		const node = document.getElementById(`dsweb-group-${groupId}`);
		if (node !== null) {
			const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			node.scrollIntoView({
				behavior: reduced ? "auto" : "smooth",
				block: "start"
			});
		}
	};
	const status = notice ?? (blocked ? {
		tone: "warn",
		text: t("invalid")
	} : dirty ? {
		tone: "info",
		text: t("dirtyCount").replace("{n}", String(pending.length))
	} : {
		tone: "muted",
		text: t("clean")
	});
	const actions = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		type: "button",
		className: "dsweb-button dsweb-button-secondary",
		disabled: busy || !dirty,
		onClick: () => {
			setDraft(null);
			setNotice(null);
		},
		children: t("discard")
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		type: "button",
		className: "dsweb-button dsweb-button-primary",
		disabled: !writable || busy || !dirty || blocked,
		onClick: () => {
			save();
		},
		children: busy ? t("saving") : t("save")
	})] });
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(SettingsPage, {
		title: t("title"),
		subtitle: t("intro"),
		badges: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
			tone: dirty ? "info" : "muted",
			children: dirty ? t("dirty") : t("clean")
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
			tone: "warn",
			children: t("readonly")
		}), blocked && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
			tone: "warn",
			children: t("invalid")
		})] }),
		rail: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Rail, {
			label: t("groupsLabel"),
			items: GROUPS.map((group, index) => ({
				id: group.id,
				label: t(`group.${group.id}`),
				index: index + 1
			})),
			activeId: activeGroup,
			onSelect: selectGroup
		}),
		actions,
		status: status.text,
		statusTone: status.tone,
		state: "ready",
		children: [!writable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
			variant: "aux",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsweb-banner dsweb-banner-warn",
				children: t("readonly")
			})
		}), GROUPS.map((group, groupIndex) => {
			const fields = FIELDS.filter((field) => field.group === group.id && isFieldVisible(field.visibleWhen, current));
			if (fields.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				groupId: group.id,
				index: groupIndex + 1,
				title: t(`group.${group.id}`),
				hint: t(`group.${group.id}.hint`),
				collapsible: true,
				children: [group.id === "risk" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FieldRow, {
					fieldId: "risk-tier",
					label: t("riskTier"),
					hint: t("riskTierHint"),
					wide: true,
					control: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsweb-tier-buttons",
						children: [RISK_PRESETS.map((preset) => {
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: `dsweb-button ${matchRiskPreset(current) === preset.id ? "dsweb-button-primary" : "dsweb-button-secondary"}`,
								disabled: !writable || busy,
								title: t(`risk.${preset.id}.hint`),
								onClick: () => {
									for (const item of preset.values) edit(item.path, item.value);
								},
								children: t(`risk.${preset.id}`)
							}, preset.id);
						}), matchRiskPreset(current) === "custom" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
							tone: "warn",
							children: t("riskCustom")
						})]
					})
				}), fields.map((field) => {
					const key = fieldKey(field);
					const domId = fieldDomId(field);
					const error = errors.get(key);
					const value = readPath(current, field.path);
					const invalid = error !== void 0;
					const wide = field.kind === "list" || field.kind === "text";
					return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FieldRow, {
						fieldId: key,
						domId,
						label: t(`field.${key}`),
						badges: field.restart === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
							tone: "info",
							children: t("restart")
						}) : void 0,
						hint: field.hint === void 0 ? void 0 : t(`field.${key}.hint`),
						error: error === void 0 ? void 0 : errorText$2(field, error, t),
						wide,
						control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FieldControl, {
							field,
							value,
							domId,
							invalid,
							disabled: !writable || busy,
							placeholder: t("listPlaceholder"),
							optionLabel: field.optionLabels === void 0 ? void 0 : (option) => t(`field.${key}.opt.${option}`),
							onChange: (next) => edit(field.path, next),
							onChangeList: (raw) => edit(field.path, parseList(raw))
						})
					}, key);
				})]
			}, group.id);
		})]
	});
}

//#endregion
//#region src/client/settings-styles.ts
/**
* 配置界面的样式表。
*
* DSH 的客户端包在运行时用 `document.createElement('style')` 注入样式（locale、plugin-manager
* 与各 settings-* 包都这么做），本插件沿用同一通路，因此不依赖构建期的 CSS 产物。
*
* 组织方式按层排列，改动时请放进对应层：
*   L0 tokens     设计令牌（颜色 / 间距 / 圆角 / 阴影 / 字体 / 动效 / 布局尺寸）
*   L1 layout     页面骨架：页头、页身、左栏、内容、操作栏
*   L2 components 卡片、行、控件、按钮、徽标、骨架、统计块、折叠区
*   L3 states     hover / focus-visible / disabled / 非法 / 只读
*   L4 motion     过渡、关键帧、prefers-reduced-motion
*
* 铁律：
* - 所有选择器以 `.dsweb-` 开头，不碰宿主类名，不用 `!important`；
* - 令牌只挂在 `.dsweb-page` 上（它是两处界面的共同根节点），靠继承作用域生效，不写 `:root`；
* - 颜色一律优先取宿主 `--dsw-alias-*`，缺失时用同语义回退值，深浅色主题自动跟随。
*
* 视觉约定（玻璃拟态）：
* - 主 CTA 使用自包含的蓝紫渐变（`--dsweb-brand-*`），**不取宿主品牌色**：某些主题下
*   `--dsw-alias-brand-primary` 是纯白，会让白字按钮变成白块；
* - 卡片 / 导航 / 操作栏是「半透明底 + 渐变描边 + backdrop blur + 内高光」四件套；
* - 不支持 `backdrop-filter` / `color-mix` 时退回不透明底，不能变成全透明。
*
* @module dsh-deepseek-web-xxxxxgold/client/settings-styles
*/
/** 样式元素 id：重复挂载时复用它，避免 HMR 或多次激活堆叠。 */
const STYLE_ELEMENT_ID = "dsh-deepseek-web-settings-style";
/** 设置面板样式。 */
const CSS = `
/* ===== L0 tokens ===== */
.dsweb-page{
  --dsweb-brand-1:#4D6BFE;
  --dsweb-brand-2:#7C5CFF;
  --dsweb-brand-3:#C084FC;
  /* 主 CTA 专用：三段都保证白字 ≥ 4.5:1（品牌色在部分主题下是纯白，不能用） */
  --dsweb-cta-1:#4A5CF0;
  --dsweb-cta-2:#6246EA;
  --dsweb-cta-3:#7C3AED;
  --dsweb-accent:#5B7CFF;
  --dsweb-accent-ink:#5B7CFF;
  --dsweb-accent-weak:rgba(91,124,255,.14);
  --dsweb-accent-line:rgba(91,124,255,.38);
  --dsweb-accent-ring:rgba(91,124,255,.30);
  --dsweb-on-accent:#FFFFFF;
  --dsweb-bg:var(--dsw-alias-bg-layer-1,#0F1117);
  /* 部分主题没有 layer-2；回退到页面底色，避免深色主题里卡片突然变白 */
  --dsweb-bg-raised:var(--dsw-alias-bg-layer-2,var(--dsweb-bg));
  --dsweb-bg-sunken:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));
  --dsweb-line:var(--dsw-alias-border-l2,rgba(127,127,127,.20));
  --dsweb-line-strong:var(--dsw-alias-border-l3,rgba(127,127,127,.34));
  --dsweb-text:var(--dsw-alias-label-primary,#F3F5FA);
  --dsweb-text-2:var(--dsw-alias-label-secondary,#C3C8D4);
  --dsweb-text-3:var(--dsw-alias-label-tertiary,#98A0B0);
  --dsweb-text-4:var(--dsw-alias-label-dimmed,#6E7686);
  --dsweb-danger:var(--dsw-alias-label-error,#FF6B6B);
  --dsweb-warn:var(--dsw-alias-state-warn-primary,#F5A524);
  --dsweb-success:var(--dsw-alias-state-success-primary,#3DDC97);
  /* 玻璃底：先给中性回退；支持 color-mix 的浏览器在 L0 末尾整体升级 */
  --dsweb-glass:rgba(127,127,127,.12);
  --dsweb-glass-strong:rgba(127,127,127,.16);
  --dsweb-glass-line:rgba(127,127,127,.22);
  --dsweb-shine:rgba(255,255,255,.14);
  --dsweb-s1:4px;--dsweb-s2:8px;--dsweb-s3:12px;--dsweb-s4:16px;
  --dsweb-s5:20px;--dsweb-s6:24px;--dsweb-s7:32px;--dsweb-s8:40px;
  --dsweb-r-sm:10px;--dsweb-r-md:14px;--dsweb-r-lg:22px;--dsweb-r-xl:26px;--dsweb-r-pill:999px;
  --dsweb-sh1:0 1px 0 var(--dsweb-shine) inset,0 8px 24px -18px rgba(2,6,23,.55);
  --dsweb-sh2:0 1px 0 var(--dsweb-shine) inset,0 20px 48px -26px rgba(2,6,23,.78);
  --dsweb-sh3:0 1px 0 var(--dsweb-shine) inset,0 30px 72px -32px rgba(2,6,23,.9);
  --dsweb-glow:0 0 0 1px var(--dsweb-accent-line),0 24px 64px -30px rgba(77,107,254,.55);
  --dsweb-d1:120ms;--dsweb-d2:180ms;--dsweb-d3:280ms;
  --dsweb-ease:cubic-bezier(.22,.9,.24,1);
  --dsweb-rail-w:232px;--dsweb-content-max:920px;
  --dsweb-control-w:280px;--dsweb-control-h:36px;--dsweb-page-pad:22px;
  /* 操作栏贴底时留的一点缝，避免圆角顶在面板边界上 */
  --dsweb-action-gap:8px;
}
/* color-mix 只在支持时覆盖：自定义属性没有「无效回退到上一条声明」的语义，
   不能在同一条规则里先写 rgba 再写 color-mix（旧浏览器会整条变成 invalid）。 */
@supports (color: color-mix(in srgb,#000 1%,transparent)){
  .dsweb-page{
    --dsweb-accent-ink:color-mix(in srgb,var(--dsweb-accent) 62%,var(--dsweb-text));
    --dsweb-accent-weak:color-mix(in srgb,var(--dsweb-accent) 14%,transparent);
    --dsweb-accent-line:color-mix(in srgb,var(--dsweb-accent) 38%,transparent);
    --dsweb-accent-ring:color-mix(in srgb,var(--dsweb-accent) 30%,transparent);
    --dsweb-glass:color-mix(in srgb,var(--dsweb-bg-raised) 74%,transparent);
    --dsweb-glass-strong:color-mix(in srgb,var(--dsweb-bg-raised) 88%,transparent);
    --dsweb-glass-line:color-mix(in srgb,var(--dsweb-text) 13%,transparent);
    --dsweb-shine:color-mix(in srgb,#FFFFFF 18%,transparent);
    --dsweb-glow:0 0 0 1px color-mix(in srgb,var(--dsweb-accent) 24%,transparent),
      0 24px 64px -30px color-mix(in srgb,var(--dsweb-accent) 55%,transparent);
  }
}

/* ===== L1 layout ===== */
.dsweb-page{
  position:relative;isolation:isolate;
  display:flex;flex-direction:column;gap:var(--dsweb-s4);
  box-sizing:border-box;padding:var(--dsweb-page-pad);padding-bottom:var(--dsweb-action-gap);
  color:var(--dsweb-text);font-family:inherit;
  /* 关键：按「面板自己的宽度」适配，而不是窗口宽度。
     DSH 设置面板只在窗口里占一条窄栏（实测约 590px），用视口媒体查询永远会误判。 */
  container-type:inline-size;container-name:dsweb;
}
/* 极光底：只铺在 .dsweb-page 自身区域，不碰宿主；卡片/导航的玻璃模糊就采样它 */
.dsweb-page::before{
  content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;border-radius:inherit;
  background:
    radial-gradient(120% 72% at 8% -8%,rgba(77,107,254,.18),transparent 62%),
    radial-gradient(90% 60% at 100% 0%,rgba(192,132,252,.14),transparent 60%),
    radial-gradient(100% 68% at 50% 108%,rgba(34,211,238,.10),transparent 66%);
}
.dsweb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--dsweb-s4);flex-wrap:wrap;
  width:100%;max-width:calc(var(--dsweb-rail-w) + var(--dsweb-s6) + var(--dsweb-content-max));margin:0 auto}
.dsweb-head-main{flex:1;min-width:0}
.dsweb-title{margin:0;font-size:20px;line-height:28px;font-weight:650;letter-spacing:-.015em;color:var(--dsweb-text)}
.dsweb-title::after{content:"";display:block;width:64px;height:3px;margin-top:10px;border-radius:3px;
  background:linear-gradient(90deg,var(--dsweb-brand-1),var(--dsweb-brand-2) 55%,transparent);
  box-shadow:0 0 14px rgba(77,107,254,.55)}
.dsweb-sub{margin:var(--dsweb-s2) 0 0;font-size:13px;line-height:20px;color:var(--dsweb-text-3);max-width:62ch}
.dsweb-head-badges{display:flex;align-items:center;gap:var(--dsweb-s2);flex-wrap:wrap;padding-top:var(--dsweb-s1)}
/* 窄面板用 flex-column：grid 行高只有导航条自身，sticky 没有可粘的行程 */
.dsweb-shell{display:flex;flex-direction:column;gap:var(--dsweb-s3);align-items:stretch;
  width:100%;max-width:calc(var(--dsweb-rail-w) + var(--dsweb-s6) + var(--dsweb-content-max));margin:0 auto}
.dsweb-content{display:flex;flex-direction:column;gap:var(--dsweb-s4);max-width:var(--dsweb-content-max);min-width:0}
.dsweb-rail{
  position:sticky;top:0;z-index:5;
  display:flex;flex-direction:row;gap:4px;overflow-x:auto;overflow-y:hidden;
  padding:6px;border:1px solid var(--dsweb-glass-line);border-radius:18px;
  background:rgba(22,24,33,.84);background:var(--dsweb-glass-strong);
  -webkit-backdrop-filter:blur(24px) saturate(170%);backdrop-filter:blur(24px) saturate(170%);
  box-shadow:0 18px 44px -28px rgba(2,6,23,.85),0 1px 0 var(--dsweb-shine) inset;
  scrollbar-width:none;-ms-overflow-style:none;overscroll-behavior-x:contain;
  cursor:grab;user-select:none;scroll-behavior:smooth;
  -webkit-mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 18px),transparent 100%);
  mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 18px),transparent 100%);
}
.dsweb-rail::-webkit-scrollbar{display:none}
.dsweb-rail[data-dragging="true"]{cursor:grabbing;scroll-behavior:auto}
.dsweb-rail-item{position:relative;display:flex;align-items:center;gap:var(--dsweb-s2);
  box-sizing:border-box;width:auto;flex:none;height:34px;padding:0 12px 0 10px;
  border:1px solid transparent;border-radius:12px;background:transparent;
  color:var(--dsweb-text-2);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;
  transition:background var(--dsweb-d1) var(--dsweb-ease),color var(--dsweb-d1) var(--dsweb-ease),
    box-shadow var(--dsweb-d2) var(--dsweb-ease),transform var(--dsweb-d1) var(--dsweb-ease)}
.dsweb-rail-index{flex:none;width:16px;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;color:var(--dsweb-text-4)}
.dsweb-rail-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsweb-rail-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsweb-warn);
  box-shadow:0 0 8px rgba(245,165,36,.8)}
.dsweb-actionbar{
  position:sticky;bottom:var(--dsweb-action-gap);z-index:6;
  display:flex;align-items:center;gap:var(--dsweb-s3);flex-wrap:wrap;
  box-sizing:border-box;
  width:100%;max-width:calc(var(--dsweb-rail-w) + var(--dsweb-s6) + var(--dsweb-content-max));margin:0 auto;
  padding:10px 12px 10px 16px;border:1px solid var(--dsweb-glass-line);border-radius:18px;
  background:rgba(22,24,33,.88);background:var(--dsweb-glass-strong);
  -webkit-backdrop-filter:blur(26px) saturate(180%);backdrop-filter:blur(26px) saturate(180%);
  box-shadow:0 28px 64px -30px rgba(2,6,23,.92),0 1px 0 var(--dsweb-shine) inset;
}
.dsweb-actionbar-status{display:flex;align-items:center;gap:8px;flex:1;min-width:0;
  font-size:12px;line-height:18px;color:var(--dsweb-text-2)}
.dsweb-status-dot{flex:none;width:8px;height:8px;border-radius:50%;background:currentColor;
  box-shadow:0 0 0 4px rgba(127,127,127,.16),0 0 12px currentColor;
  box-shadow:0 0 0 4px color-mix(in srgb,currentColor 18%,transparent),0 0 12px color-mix(in srgb,currentColor 70%,transparent)}
.dsweb-actions{display:flex;align-items:center;gap:var(--dsweb-s2);margin-left:auto}

/* ===== L2 components ===== */
.dsweb-card{
  position:relative;display:flex;flex-direction:column;box-sizing:border-box;overflow:hidden;
  border:1px solid transparent;border-radius:var(--dsweb-r-lg);
  background:
    linear-gradient(155deg,rgba(255,255,255,.06),rgba(255,255,255,.01) 46%,rgba(255,255,255,0)) padding-box,
    linear-gradient(150deg,rgba(255,255,255,.18),rgba(255,255,255,.04) 40%,rgba(77,107,254,.32)) border-box;
  background-color:var(--dsweb-glass);
  -webkit-backdrop-filter:blur(20px) saturate(150%);backdrop-filter:blur(20px) saturate(150%);
  box-shadow:0 0 0 1px var(--dsweb-glass-line),var(--dsweb-sh2);
  scroll-margin-top:84px;
  transition:box-shadow var(--dsweb-d2) var(--dsweb-ease),border-color var(--dsweb-d2) var(--dsweb-ease),
    transform var(--dsweb-d2) var(--dsweb-ease)}
.dsweb-card-aux{
  background:
    linear-gradient(155deg,rgba(255,255,255,.04),rgba(255,255,255,.01) 46%,rgba(255,255,255,0)) padding-box,
    linear-gradient(150deg,rgba(255,255,255,.20),rgba(255,255,255,.04) 40%,rgba(124,92,255,.30)) border-box;
  background-color:var(--dsweb-glass)}
.dsweb-card-head{display:flex;flex-direction:column;gap:4px;padding:16px 18px 0}
.dsweb-card-heading{display:flex;align-items:center;gap:10px;min-width:0}
.dsweb-card-toggle{display:flex;align-items:center;gap:10px;width:100%;min-width:0;margin:0;padding:0;
  border:0;border-radius:10px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsweb-card-toggle:focus-visible{outline:none;box-shadow:0 0 0 3px var(--dsweb-accent-ring)}
.dsweb-card-index{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:26px;height:26px;border-radius:9px;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;
  color:var(--dsweb-accent);
  background:linear-gradient(140deg,rgba(77,107,254,.22),rgba(124,92,255,.10));
  box-shadow:0 0 0 1px rgba(91,124,255,.22) inset;
  background:linear-gradient(140deg,color-mix(in srgb,var(--dsweb-accent) 22%,transparent),
    color-mix(in srgb,var(--dsweb-brand-2) 10%,transparent))}
.dsweb-card-title{margin:0;flex:1;min-width:0;font-size:15px;line-height:22px;font-weight:650;letter-spacing:-.01em;color:var(--dsweb-text)}
.dsweb-card-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsweb-text-3)}
.dsweb-card-body{display:flex;flex-direction:column;padding:10px 18px 16px}
.dsweb-collapse{display:grid;grid-template-rows:1fr;opacity:1;
  transition:grid-template-rows var(--dsweb-d3) var(--dsweb-ease),opacity var(--dsweb-d2) var(--dsweb-ease)}
.dsweb-collapse[data-open="false"]{grid-template-rows:0fr;opacity:0}
.dsweb-collapse>.dsweb-collapse-inner{min-height:0;overflow:hidden}
.dsweb-chevron{flex:none;display:grid;place-items:center;width:24px;height:24px;margin-left:auto;
  border-radius:50%;background:var(--dsweb-bg-sunken);color:var(--dsweb-text-3);
  transition:background var(--dsweb-d1) var(--dsweb-ease),color var(--dsweb-d1) var(--dsweb-ease)}
.dsweb-chevron::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;
  border-bottom:1.5px solid currentColor;transform:rotate(45deg) translate(-1px,-1px);
  transition:transform var(--dsweb-d3) var(--dsweb-ease)}
.dsweb-card[data-open="false"] .dsweb-chevron::before,
.dsweb-fold[data-open="false"] .dsweb-chevron::before{transform:rotate(-45deg) translate(-1px,-1px)}
.dsweb-fold{border-top:1px solid var(--dsweb-line);margin-top:10px;padding-top:8px}
.dsweb-fold:first-child{border-top:none;margin-top:0;padding-top:0}
.dsweb-fold-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsweb-fold-toggle{display:flex;align-items:center;gap:8px;flex:1;min-width:0;margin:0;padding:4px 0;
  border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsweb-fold-toggle:focus-visible{outline:none;box-shadow:0 0 0 3px var(--dsweb-accent-ring)}
.dsweb-fold-title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsweb-text)}
.dsweb-fold-actions{display:flex;align-items:center;gap:8px}
.dsweb-fold-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsweb-text-3)}
.dsweb-fold-danger{border-top-color:rgba(255,107,107,.32);
  border-top-color:color-mix(in srgb,var(--dsweb-danger) 32%,transparent)}
.dsweb-fold-danger .dsweb-fold-title{color:var(--dsweb-danger)}
.dsweb-fold-danger .dsweb-chevron{color:var(--dsweb-danger);background:rgba(255,107,107,.12);
  background:color-mix(in srgb,var(--dsweb-danger) 12%,transparent)}
.dsweb-danger-body{display:flex;flex-direction:column;gap:8px;padding-top:8px}
.dsweb-actions-start{justify-content:flex-start;margin-left:0}
.dsweb-row{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--dsweb-s2);
  align-items:start;box-sizing:border-box;padding:var(--dsweb-s3) 10px;margin:0 -10px;
  border-top:1px solid var(--dsweb-line);border-radius:12px;
  transition:background var(--dsweb-d1) var(--dsweb-ease)}
.dsweb-card-body>.dsweb-row:first-child{border-top:none}
.dsweb-row-wide{grid-template-columns:minmax(0,1fr);gap:var(--dsweb-s2)}
.dsweb-row-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsweb-row-label{display:inline-flex;align-items:center;gap:var(--dsweb-s2);flex-wrap:wrap;
  font-size:13px;line-height:20px;font-weight:500;color:var(--dsweb-text);cursor:pointer}
.dsweb-row-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsweb-text-3)}
.dsweb-row-error{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsweb-danger)}
.dsweb-row-control{display:flex;align-items:center;justify-content:flex-end;gap:var(--dsweb-s2);min-width:0}
.dsweb-row-wide .dsweb-row-control{justify-content:flex-start;flex-wrap:wrap}
.dsweb-row-wide .dsweb-row-control>.dsweb-input,
.dsweb-row-wide .dsweb-row-control>.dsweb-textarea,
.dsweb-row-wide .dsweb-row-control>.dsweb-select{flex:1 1 auto;width:auto;min-width:0}
.dsweb-input,.dsweb-select,.dsweb-textarea{box-sizing:border-box;width:100%;min-height:var(--dsweb-control-h);
  padding:7px 11px;border:1px solid var(--dsweb-line);border-radius:12px;
  background:rgba(127,127,127,.06);color:var(--dsweb-text);font:inherit;font-size:13px;line-height:20px;
  background:color-mix(in srgb,var(--dsweb-bg) 58%,transparent);
  transition:border-color var(--dsweb-d1) var(--dsweb-ease),box-shadow var(--dsweb-d1) var(--dsweb-ease),
    background var(--dsweb-d1) var(--dsweb-ease)}
.dsweb-input::placeholder,.dsweb-textarea::placeholder{color:var(--dsweb-text-4)}
.dsweb-select{appearance:none;-webkit-appearance:none;padding-right:26px;cursor:pointer;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2381858c' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 9px center}
.dsweb-select option{background:var(--dsweb-bg-raised);color:var(--dsweb-text)}
.dsweb-textarea{min-height:84px;resize:vertical;
  font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:12px;line-height:18px}
.dsweb-input-invalid,.dsweb-input-invalid:hover{border-color:var(--dsweb-danger)}
.dsweb-switch{appearance:none;-webkit-appearance:none;position:relative;flex:none;box-sizing:border-box;
  width:42px;height:24px;margin:0;border:1px solid var(--dsweb-line);border-radius:var(--dsweb-r-pill);
  background:var(--dsweb-bg-sunken);cursor:pointer;
  transition:background var(--dsweb-d2) var(--dsweb-ease),border-color var(--dsweb-d2) var(--dsweb-ease),
    box-shadow var(--dsweb-d2) var(--dsweb-ease)}
.dsweb-switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;
  background:#FFF;box-shadow:0 1px 3px rgba(0,0,0,.35);
  transition:transform var(--dsweb-d2) var(--dsweb-ease)}
.dsweb-switch:checked{border-color:transparent;
  background:linear-gradient(135deg,var(--dsweb-cta-1),var(--dsweb-cta-2));
  box-shadow:0 6px 18px -8px rgba(77,107,254,.9)}
.dsweb-switch:checked::after{transform:translateX(18px)}
.dsweb-button{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  box-sizing:border-box;height:var(--dsweb-control-h);padding:0 15px;border:1px solid transparent;border-radius:12px;
  font:inherit;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;cursor:pointer;
  transition:background var(--dsweb-d1) var(--dsweb-ease),border-color var(--dsweb-d1) var(--dsweb-ease),
    opacity var(--dsweb-d1) var(--dsweb-ease),transform var(--dsweb-d1) var(--dsweb-ease),
    box-shadow var(--dsweb-d2) var(--dsweb-ease)}
.dsweb-button-primary{overflow:hidden;isolation:isolate;color:#FFF;
  border-color:rgba(255,255,255,.18);
  background:linear-gradient(135deg,var(--dsweb-cta-1),var(--dsweb-cta-2) 58%,var(--dsweb-cta-3));
  box-shadow:0 12px 28px -14px rgba(77,107,254,.95),0 1px 0 rgba(255,255,255,.28) inset}
.dsweb-button-primary::after{content:"";position:absolute;inset:-1px;z-index:0;pointer-events:none;
  background:linear-gradient(110deg,transparent 18%,rgba(255,255,255,.38) 48%,transparent 72%);
  transform:translateX(-130%);transition:transform .62s var(--dsweb-ease)}
.dsweb-button-secondary{background:rgba(127,127,127,.10);border-color:var(--dsweb-line);color:var(--dsweb-text);
  background:color-mix(in srgb,var(--dsweb-text) 6%,transparent);
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.dsweb-button-ghost{background:transparent;border-color:transparent;color:var(--dsweb-text-2)}
.dsweb-button-danger{background:rgba(255,107,107,.12);border-color:rgba(255,107,107,.5);color:var(--dsweb-danger);
  background:color-mix(in srgb,var(--dsweb-danger) 12%,transparent);
  border-color:color-mix(in srgb,var(--dsweb-danger) 50%,transparent)}
.dsweb-link{flex:none;padding:0;border:none;background:none;font:inherit;font-size:12px;line-height:18px;
  color:var(--dsweb-accent-ink);cursor:pointer;border-radius:var(--dsweb-r-sm)}
.dsweb-badge{display:inline-flex;align-items:center;box-sizing:border-box;height:20px;padding:0 8px;
  border:1px solid transparent;border-radius:var(--dsweb-r-pill);
  font-size:11px;line-height:16px;font-weight:500;white-space:nowrap}
.dsweb-badge-muted{background:rgba(127,127,127,.12);color:var(--dsweb-text-2);
  background:color-mix(in srgb,var(--dsweb-text) 8%,transparent)}
.dsweb-badge-info{background:var(--dsweb-accent-weak);color:var(--dsweb-accent-ink);
  box-shadow:0 0 0 1px var(--dsweb-accent-line) inset}
.dsweb-badge-warn{background:rgba(245,165,36,.10);border-color:rgba(245,165,36,.55);color:var(--dsweb-warn);
  background:color-mix(in srgb,var(--dsweb-warn) 10%,transparent);
  border-color:color-mix(in srgb,var(--dsweb-warn) 55%,transparent)}
.dsweb-badge-success{background:rgba(61,220,151,.10);border-color:rgba(61,220,151,.55);color:var(--dsweb-success);
  background:color-mix(in srgb,var(--dsweb-success) 10%,transparent);
  border-color:color-mix(in srgb,var(--dsweb-success) 55%,transparent)}
.dsweb-banner{display:flex;gap:var(--dsweb-s2);align-items:flex-start;box-sizing:border-box;
  margin:6px 0;padding:10px 12px;border:1px solid var(--dsweb-line);border-radius:14px;
  background:rgba(127,127,127,.06);font-size:13px;line-height:20px;color:var(--dsweb-text-2);
  background:color-mix(in srgb,var(--dsweb-text) 4%,transparent)}
.dsweb-banner-warn{border-color:rgba(245,165,36,.5);color:var(--dsweb-text);
  background:rgba(245,165,36,.07);
  border-color:color-mix(in srgb,var(--dsweb-warn) 50%,transparent);
  background:color-mix(in srgb,var(--dsweb-warn) 7%,transparent)}
.dsweb-banner-error{border-color:rgba(255,107,107,.5);color:var(--dsweb-text);
  background:rgba(255,107,107,.07);
  border-color:color-mix(in srgb,var(--dsweb-danger) 50%,transparent);
  background:color-mix(in srgb,var(--dsweb-danger) 7%,transparent)}
.dsweb-banner-success{border-color:rgba(61,220,151,.5);color:var(--dsweb-text);
  background:rgba(61,220,151,.07);
  border-color:color-mix(in srgb,var(--dsweb-success) 50%,transparent);
  background:color-mix(in srgb,var(--dsweb-success) 7%,transparent)}
.dsweb-banner-title{display:block;font-weight:600;color:var(--dsweb-text)}
.dsweb-code{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:12px;padding:1px 5px;border-radius:var(--dsweb-r-sm);
  background:var(--dsw-alias-markdown-inline-code,rgba(127,127,127,.16))}
.dsweb-skeleton{height:38px;border-radius:12px;
  background:linear-gradient(90deg,var(--dsweb-bg-sunken) 25%,var(--dsweb-line) 37%,var(--dsweb-bg-sunken) 63%);
  background-size:400% 100%;animation:dsweb-shimmer 1.4s ease-in-out infinite}
.dsweb-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:2px 0 6px}
.dsweb-stat{position:relative;overflow:hidden;display:flex;flex-direction:column;gap:2px;
  padding:10px 12px;border:1px solid var(--dsweb-line);border-radius:16px;
  background:linear-gradient(160deg,rgba(255,255,255,.07),rgba(255,255,255,0) 58%),
    rgba(127,127,127,.05);
  box-shadow:0 1px 0 rgba(255,255,255,.06) inset;
  transition:transform var(--dsweb-d2) var(--dsweb-ease),border-color var(--dsweb-d2) var(--dsweb-ease),
    box-shadow var(--dsweb-d2) var(--dsweb-ease)}
.dsweb-stat::after{content:"";position:absolute;right:-34px;bottom:-46px;width:96px;height:96px;border-radius:50%;
  background:radial-gradient(circle,rgba(91,124,255,.28),transparent 70%);
  pointer-events:none;opacity:.7}
.dsweb-stat-value{position:relative;z-index:1;font-size:19px;line-height:25px;font-weight:650;
  letter-spacing:-.01em;font-variant-numeric:tabular-nums;color:var(--dsweb-text);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsweb-stat-label{position:relative;z-index:1;font-size:11px;line-height:16px;color:var(--dsweb-text-3);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsweb-stat-hint{position:relative;z-index:1;font-size:10px;line-height:14px;color:var(--dsweb-text-4)}
.dsweb-stat-accent{border-color:var(--dsweb-accent-line);
  background:linear-gradient(150deg,rgba(77,107,254,.18),rgba(124,92,255,.06) 60%,transparent)}
.dsweb-stat-accent .dsweb-stat-value{color:var(--dsweb-accent)}
.dsweb-stat-warn{border-color:rgba(245,165,36,.42);
  background:linear-gradient(150deg,rgba(245,165,36,.14),transparent 62%);
  border-color:color-mix(in srgb,var(--dsweb-warn) 42%,transparent);
  background:linear-gradient(150deg,color-mix(in srgb,var(--dsweb-warn) 14%,transparent),transparent 62%)}
.dsweb-stat-warn .dsweb-stat-value{color:var(--dsweb-warn)}
.dsweb-stat-danger{border-color:rgba(255,107,107,.42);
  background:linear-gradient(150deg,rgba(255,107,107,.14),transparent 62%);
  border-color:color-mix(in srgb,var(--dsweb-danger) 42%,transparent);
  background:linear-gradient(150deg,color-mix(in srgb,var(--dsweb-danger) 14%,transparent),transparent 62%)}
.dsweb-stat-danger .dsweb-stat-value{color:var(--dsweb-danger)}
.dsweb-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:4px 0}
.dsweb-days{display:flex;flex-direction:column;gap:2px;margin-top:6px}
.dsweb-day{display:grid;grid-template-columns:56px minmax(0,1fr) auto;gap:10px;align-items:center;
  padding:7px 10px;border-radius:10px;font-size:12px;line-height:18px;color:var(--dsweb-text-2)}
.dsweb-day:nth-child(odd){background:rgba(127,127,127,.06);
  background:color-mix(in srgb,var(--dsweb-text) 4%,transparent)}
.dsweb-day-date{font-variant-numeric:tabular-nums;color:var(--dsweb-text-3)}
.dsweb-day-meta{display:flex;gap:10px;flex-wrap:wrap}
.dsweb-day-gap{font-variant-numeric:tabular-nums;color:var(--dsweb-text-3);white-space:nowrap}
.dsweb-day-fail{color:var(--dsweb-danger)}
.dsweb-checks{display:flex;flex-direction:column;gap:6px;padding:8px 10px;
  border:1px solid var(--dsweb-line);border-radius:14px;background:rgba(127,127,127,.05);
  background:color-mix(in srgb,var(--dsweb-text) 3%,transparent)}
.dsweb-check{display:flex;align-items:flex-start;gap:var(--dsweb-s2);font-size:12px;line-height:18px;color:var(--dsweb-text-2)}
.dsweb-check-icon{flex:none;width:12px;text-align:center;font-weight:600}
.dsweb-check-ok .dsweb-check-icon{color:var(--dsweb-success)}
.dsweb-check-warning .dsweb-check-icon{color:var(--dsweb-warn)}
.dsweb-check-error .dsweb-check-icon{color:var(--dsweb-danger)}
.dsweb-check-detail{display:block;margin-top:2px;color:var(--dsweb-text-3);white-space:pre-wrap;word-break:break-all}
.dsweb-status{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsweb-text-2)}
.dsweb-status-success{color:var(--dsweb-success)}
.dsweb-status-error{color:var(--dsweb-danger)}
.dsweb-status-warn{color:var(--dsweb-warn)}
.dsweb-tone-info{color:var(--dsweb-accent-ink)}
.dsweb-tone-warn{color:var(--dsweb-warn)}
.dsweb-tone-success{color:var(--dsweb-success)}
.dsweb-tone-error{color:var(--dsweb-danger)}
.dsweb-tone-muted{color:var(--dsweb-text-3)}

/* ===== L3 states ===== */
.dsweb-rail-item:hover{background:rgba(127,127,127,.12);color:var(--dsweb-text);
  background:color-mix(in srgb,var(--dsweb-text) 8%,transparent)}
.dsweb-rail-item:focus-visible{outline:none;box-shadow:0 0 0 3px var(--dsweb-accent-ring)}
.dsweb-rail-item[aria-current="true"]{
  color:#FFF;font-weight:600;
  background:linear-gradient(135deg,var(--dsweb-cta-1),var(--dsweb-cta-2) 68%,var(--dsweb-cta-3));
  box-shadow:0 10px 26px -14px rgba(77,107,254,.95),0 1px 0 rgba(255,255,255,.30) inset}
.dsweb-rail-item[aria-current="true"] .dsweb-rail-index{color:rgba(255,255,255,.78)}
.dsweb-rail-item[aria-current="true"]:hover{color:#FFF}
.dsweb-card:hover{box-shadow:var(--dsweb-glow);transform:translateY(-1px)}
.dsweb-card-aux:hover{box-shadow:var(--dsweb-sh2);transform:translateY(-1px)}
.dsweb-row:hover{background:rgba(91,124,255,.07);background:color-mix(in srgb,var(--dsweb-accent) 7%,transparent)}
.dsweb-stat:hover{transform:translateY(-1px);box-shadow:0 14px 30px -22px rgba(2,6,23,.9)}
.dsweb-input:hover:not(:disabled),.dsweb-select:hover:not(:disabled),.dsweb-textarea:hover:not(:disabled){border-color:var(--dsweb-line-strong)}
.dsweb-input:focus-visible,.dsweb-select:focus-visible,.dsweb-textarea:focus-visible{
  outline:none;border-color:var(--dsweb-accent);box-shadow:0 0 0 3px var(--dsweb-accent-ring)}
.dsweb-input:disabled,.dsweb-select:disabled,.dsweb-textarea:disabled{opacity:.55;cursor:not-allowed}
.dsweb-switch:focus-visible{outline:2px solid var(--dsweb-accent);outline-offset:2px}
.dsweb-switch:disabled{opacity:.5;cursor:not-allowed}
.dsweb-button:hover:not(:disabled){transform:translateY(-1px)}
.dsweb-button:active:not(:disabled){transform:translateY(0)}
.dsweb-button:focus-visible{outline:none;box-shadow:0 0 0 3px var(--dsweb-accent-ring)}
.dsweb-button:disabled{opacity:.5;cursor:not-allowed;transform:none;filter:saturate(.55)}
.dsweb-button-primary:disabled{opacity:1;filter:none;color:var(--dsweb-text-3);
  background:rgba(91,124,255,.14);border-color:var(--dsweb-line);box-shadow:none;
  background:color-mix(in srgb,var(--dsweb-accent) 14%,transparent)}
.dsweb-button-primary:hover:not(:disabled){box-shadow:0 18px 34px -14px rgba(77,107,254,1),0 1px 0 rgba(255,255,255,.32) inset}
.dsweb-button-primary:hover:not(:disabled)::after{transform:translateX(130%)}
.dsweb-button-secondary:hover:not(:disabled){border-color:var(--dsweb-line-strong);
  background:rgba(127,127,127,.16);background:color-mix(in srgb,var(--dsweb-text) 10%,transparent)}
.dsweb-button-ghost:hover:not(:disabled){background:var(--dsweb-bg-sunken);color:var(--dsweb-text)}
.dsweb-button-danger:hover:not(:disabled){background:rgba(255,107,107,.2);
  background:color-mix(in srgb,var(--dsweb-danger) 20%,transparent);
  box-shadow:0 12px 26px -16px rgba(255,107,107,.9)}
.dsweb-link:hover:not(:disabled){text-decoration:underline}
.dsweb-link:disabled{opacity:.5;cursor:not-allowed}
.dsweb-page[data-dsweb-settings="loading"] .dsweb-card{opacity:.6}
.dsweb-page .dsweb-row[data-invalid="true"] .dsweb-row-label{color:var(--dsweb-danger)}
.dsweb-tier-buttons{display:flex;flex-wrap:wrap;gap:var(--dsweb-s2);align-items:center;justify-content:flex-end}

/* ===== L4 motion ===== */
@keyframes dsweb-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}
@keyframes dsweb-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes dsweb-breathe{from{opacity:.72}to{opacity:1}}
.dsweb-card{animation:dsweb-rise var(--dsweb-d3) var(--dsweb-ease)}
.dsweb-page::before{animation:dsweb-breathe 16s ease-in-out infinite alternate}

@media (prefers-reduced-motion:reduce){
  .dsweb-page *,.dsweb-page::before{transition:none;animation:none;scroll-behavior:auto}
}

/* ===== 兼容回退 ===== */
@supports not (backdrop-filter:blur(1px)){
  .dsweb-rail,.dsweb-actionbar{background:var(--dsweb-bg-raised)}
  .dsweb-card,.dsweb-card-aux{background:var(--dsweb-bg-raised)}
}

/* ===== responsive：按「面板宽度」而不是「窗口宽度」适配 ===== */
@container dsweb (min-width:420px){
  .dsweb-stats{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@container dsweb (min-width:640px){
  .dsweb-row{grid-template-columns:minmax(0,1fr) minmax(180px,var(--dsweb-control-w));gap:var(--dsweb-s4)}
  .dsweb-row-wide{grid-template-columns:minmax(0,1fr);gap:var(--dsweb-s2)}
  .dsweb-row-control{justify-content:flex-end}
  .dsweb-row-wide .dsweb-row-control{justify-content:flex-start}
  .dsweb-tier-buttons{justify-content:flex-end}
}
@container dsweb (min-width:760px){
  .dsweb-shell{display:grid;grid-template-columns:var(--dsweb-rail-w) minmax(0,1fr);gap:var(--dsweb-s6);align-items:start}
  .dsweb-rail{top:16px;flex-direction:column;max-height:calc(100vh - 120px);overflow:auto;
    padding:10px;cursor:default;-webkit-mask-image:none;mask-image:none}
  .dsweb-rail-item{width:100%}
  .dsweb-rail-item[aria-current="true"]{box-shadow:0 10px 24px -16px rgba(77,107,254,.9),0 1px 0 rgba(255,255,255,.28) inset}
  .dsweb-card{scroll-margin-top:24px}
}
@container dsweb (max-width:480px){
  .dsweb-title{font-size:18px;line-height:26px}
  .dsweb-head{flex-direction:column;align-items:flex-start}
  .dsweb-head-badges{padding-top:0}
  .dsweb-card-head{padding:14px 14px 0}
  .dsweb-card-body{padding:8px 14px 14px}
  .dsweb-actionbar{flex-direction:column;align-items:stretch;gap:8px;padding:10px 12px}
  .dsweb-actionbar .dsweb-actions{width:100%;margin-left:0}
  .dsweb-actionbar .dsweb-actions>*{flex:1}
  .dsweb-stat{min-width:0}
}
@media (max-width:520px){
  .dsweb-page{padding:14px;padding-bottom:var(--dsweb-action-gap)}
}
`;
/**
* 确保样式已注入（幂等）。
*
* 只在浏览器环境调用；SSR / 非 DOM 环境直接跳过。
*/
function ensureSettingsStyles() {
	if (typeof document === "undefined") return;
	if (document.getElementById(STYLE_ELEMENT_ID) !== null) return;
	const style = document.createElement("style");
	style.id = STYLE_ELEMENT_ID;
	style.textContent = CSS;
	document.head.appendChild(style);
}

//#endregion
//#region src/client/ledger-card.tsx
const LEDGER_ROUTE = "/api/dsh-deepseek-web/ledger";
const DOCTOR_ROUTE = "/api/dsh-deepseek-web/doctor";
/** 失败分类的人话标签；未知分类原样显示。 */
const FAILURE_LABEL = {
	"rate-limit": {
		zh: "限流",
		en: "rate limit"
	},
	"account-blocked": {
		zh: "账号受限",
		en: "account blocked"
	},
	login: {
		zh: "登录态",
		en: "login"
	},
	network: {
		zh: "网络",
		en: "network"
	},
	timeout: {
		zh: "超时",
		en: "timeout"
	},
	other: {
		zh: "其它",
		en: "other"
	}
};
const STATUS_ICON = {
	ok: "✓",
	warning: "!",
	error: "✗"
};
/** 毫秒 → 人话时长（中文/英文共用数字，单位跟随语言）。 */
function formatDuration(ms, t) {
	if (!Number.isFinite(ms) || ms <= 0) return "—";
	if (ms < 1e3) return `${Math.round(ms)}ms`;
	if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
	const minutes = Math.floor(ms / 6e4);
	const seconds = Math.round(ms % 6e4 / 1e3);
	return seconds > 0 ? t("ledger.minutes").replace("{m}", String(minutes)).replace("{s}", String(seconds)) : t("ledger.minutes").replace("{m}", String(minutes)).replace("{s}", "0");
}
async function getJson$1(url, signal) {
	const response = await fetch(url, {
		method: "GET",
		signal,
		headers: { accept: "application/json" }
	});
	const body = await response.json().catch(() => void 0);
	if (!response.ok || body?.ok !== true || body.value === void 0) return void 0;
	return body.value;
}
/**
* 台账与自检卡片。
*
* @param props.t - 设置页的翻译函数（键集合与 `settings-section.tsx` 的字典一致）。
*/
function LedgerCard({ t }) {
	const [summary, setSummary] = (0, react.useState)(null);
	const [ledgerState, setLedgerState] = (0, react.useState)("idle");
	const [report, setReport] = (0, react.useState)(null);
	const [doctorState, setDoctorState] = (0, react.useState)("idle");
	const [doctorOpen, setDoctorOpen] = (0, react.useState)(false);
	const loadLedger = (0, react.useCallback)((signal) => {
		setLedgerState("loading");
		getJson$1(LEDGER_ROUTE, signal).then((value) => {
			if (signal.aborted) return;
			if (value?.summary === void 0) {
				setLedgerState("unavailable");
				return;
			}
			setSummary(value.summary);
			setLedgerState("ready");
		}).catch(() => {
			if (!signal.aborted) setLedgerState("unavailable");
		});
	}, []);
	(0, react.useEffect)(() => {
		const controller = new AbortController();
		loadLedger(controller.signal);
		return () => controller.abort();
	}, [loadLedger]);
	const runDoctor = (0, react.useCallback)(() => {
		setDoctorOpen(true);
		const controller = new AbortController();
		setDoctorState("loading");
		getJson$1(DOCTOR_ROUTE, controller.signal).then((value) => {
			if (value?.report === void 0) {
				setDoctorState("unavailable");
				return;
			}
			setReport(value.report);
			setDoctorState("ready");
		}).catch(() => setDoctorState("unavailable"));
	}, []);
	const totals = summary?.totals;
	const intervals = summary?.intervals;
	const failures = Object.entries(summary?.failures ?? {}).filter(([, count]) => count > 0).sort((left, right) => right[1] - left[1]);
	const tight = (intervals?.minMs ?? 0) > 0 && (intervals?.minMs ?? 0) < 3e4;
	const language = t("ledger.lang") === "en" ? "en" : "zh";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
		variant: "aux",
		title: t("ledger.title"),
		hint: t("ledger.hint"),
		collapsible: true,
		children: [
			ledgerState === "unavailable" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsweb-banner dsweb-banner-warn",
				children: t("ledger.unavailable")
			}),
			ledgerState === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsweb-skeleton" }),
			ledgerState === "ready" && summary !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				totals === void 0 || totals.total === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-banner",
					children: t("ledger.empty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsweb-stats",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
							label: t("ledger.minGap"),
							value: formatDuration(intervals?.minMs ?? 0, t),
							tone: tight ? "warn" : "accent"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
							label: t("ledger.total"),
							value: String(totals.total)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
							label: t("ledger.failed"),
							value: String(totals.failed),
							tone: totals.failed > 0 ? "danger" : "neutral"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
							label: t("ledger.chat"),
							value: String(totals.chat)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
							label: t("ledger.medianGap"),
							value: formatDuration(intervals?.medianMs ?? 0, t)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
							label: t("ledger.p90Gap"),
							value: formatDuration(intervals?.p90Ms ?? 0, t)
						})
					]
				}),
				tight && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-banner dsweb-banner-warn",
					children: t("ledger.tight")
				}),
				failures.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Fold, {
					title: t("ledger.failuresTitle"),
					defaultOpen: true,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsweb-chips",
						children: failures.map(([kind, count]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsweb-badge dsweb-badge-warn",
							children: [
								FAILURE_LABEL[kind]?.[language] ?? kind,
								" × ",
								count
							]
						}, kind))
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Fold, {
					title: t("ledger.days"),
					hint: t("ledger.daysHint"),
					defaultOpen: false,
					children: summary.days.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsweb-row-hint",
						children: t("ledger.empty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsweb-days",
						children: summary.days.map((day) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsweb-day",
							title: day.date,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsweb-day-date",
									children: day.date.slice(5)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dsweb-day-meta",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [day.total, t("ledger.perDay")] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
											t("ledger.chat"),
											" ",
											day.chat
										] }),
										day.failed > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsweb-day-fail",
											children: [
												t("ledger.failed"),
												" ",
												day.failed
											]
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsweb-day-gap",
									children: formatDuration(day.intervals.minMs, t)
								})
							]
						}, day.date))
					})
				})
			] }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Fold, {
				title: t("doctor.title"),
				hint: t("doctor.hint"),
				open: doctorOpen,
				onOpenChange: setDoctorOpen,
				actions: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dsweb-button dsweb-button-secondary",
					disabled: doctorState === "loading",
					onClick: runDoctor,
					children: doctorState === "loading" ? t("doctor.running") : t("doctor.run")
				}),
				children: [
					doctorState === "unavailable" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsweb-banner dsweb-banner-warn",
						children: t("doctor.unavailable")
					}),
					doctorState === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsweb-skeleton" }),
					doctorState === "ready" && report !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsweb-checks",
						children: [report.checks.map((check) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: `dsweb-check dsweb-check-${check.status}`,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsweb-check-icon",
								children: STATUS_ICON[check.status]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: check.id }),
								"：",
								check.message,
								check.detail !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsweb-check-detail",
									children: check.detail
								})
							] })]
						}, check.id)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: report.ok ? "dsweb-status dsweb-status-success" : "dsweb-status dsweb-status-error",
							children: report.ok ? t("doctor.ready") : t("doctor.notReady")
						})]
					})
				]
			})
		]
	});
}

//#endregion
//#region src/client/login-card.tsx
const LOGIN_ROUTE_BASE = {
	deepseek: "/api/dsh-deepseek-web/login",
	doubao: "/api/dsh-deepseek-web/doubao/login",
	glm: "/api/dsh-deepseek-web/glm-login"
};
/** 打开登录窗口后的复检节奏：登录成功或 60 秒后停。 */
const POLL_INTERVAL_MS = 5e3;
const POLL_MAX_ATTEMPTS = 12;
/** 三态徽标的语气。 */
const STATUS_TONE = {
	ok: "success",
	expired: "warn",
	unknown: "muted"
};
async function call(url, method, body, signal) {
	const response = await fetch(url, {
		method,
		...signal === void 0 ? {} : { signal },
		headers: {
			accept: "application/json",
			...body === void 0 ? {} : { "content-type": "application/json" }
		},
		...body === void 0 ? {} : { body: JSON.stringify(body) }
	});
	const payload = await response.json().catch(() => void 0);
	if (!response.ok || payload?.ok !== true || payload.value === void 0) throw new Error(payload?.message ?? `HTTP ${response.status}`);
	return payload.value;
}
function errorText$1(error, t) {
	return error instanceof Error ? error.message : t("unknownError");
}
function formatTime(timestamp) {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return String(timestamp);
	return date.toLocaleTimeString();
}
/**
* 登录态卡片。
*
* @param props.t - 设置页的翻译函数（键集合与 `i18n.ts` 的字典一致）。
* @param props.channel - `deepseek`（默认）或 `doubao`；两者共用同一套渲染。
*/
function LoginCard({ t, channel = "deepseek" }) {
	const base = LOGIN_ROUTE_BASE[channel];
	const probeRoute = `${base}/probe`;
	const openRoute = `${base}/open`;
	const importRoute = `${base}/import`;
	const exportRoute = `${base}/export`;
	const isDoubao = channel === "doubao";
	const isGlm = channel === "glm";
	const supportsAdvanced = channel === "deepseek";
	const [status, setStatus] = (0, react.useState)();
	const [state, setState] = (0, react.useState)("loading");
	const [busy, setBusy] = (0, react.useState)();
	const [message, setMessage] = (0, react.useState)();
	const [raw, setRaw] = (0, react.useState)("");
	const [exportText, setExportText] = (0, react.useState)();
	const [polling, setPolling] = (0, react.useState)(false);
	const load = (0, react.useCallback)((signal) => {
		setState("loading");
		call(base, "GET", void 0, signal).then((value) => {
			if (signal?.aborted === true) return;
			if (value === void 0) {
				setState("unavailable");
				return;
			}
			setStatus(value);
			setState("ready");
		}).catch(() => {
			if (signal?.aborted !== true) setState("unavailable");
		});
	}, [base]);
	(0, react.useEffect)(() => {
		const controller = new AbortController();
		load(controller.signal);
		return () => controller.abort();
	}, [load]);
	const applyProbe = (0, react.useCallback)((value) => {
		setStatus((previous) => ({
			status: value.status,
			...value.detail !== void 0 ? { detail: value.detail } : {},
			checkedAt: value.checkedAt,
			browserStarted: previous?.browserStarted ?? false,
			canOpen: previous?.canOpen ?? true,
			canImport: previous?.canImport ?? true,
			canExport: previous?.canExport ?? true,
			...previous?.enabled !== void 0 ? { enabled: previous.enabled } : {}
		}));
	}, []);
	/** 打开登录 / 导入成功后浏览器必然已启动，立刻把状态改对，不必等整页重载。 */
	const markBrowserStarted = (0, react.useCallback)(() => {
		setStatus((previous) => previous === void 0 ? previous : {
			...previous,
			browserStarted: true
		});
	}, []);
	(0, react.useEffect)(() => {
		if (!polling) return;
		let attempts = 0;
		let cancelled = false;
		let inFlight = false;
		const tick = async () => {
			if (inFlight) return;
			inFlight = true;
			attempts += 1;
			try {
				const value = await call(probeRoute, "POST");
				if (cancelled || value === void 0) return;
				applyProbe(value);
				if (value.status === "ok" || attempts >= POLL_MAX_ATTEMPTS) {
					cancelled = true;
					setPolling(false);
				}
			} catch {
				if (!cancelled && attempts >= POLL_MAX_ATTEMPTS) {
					cancelled = true;
					setPolling(false);
				}
			} finally {
				inFlight = false;
			}
		};
		tick();
		const timer = setInterval(() => {
			tick();
		}, POLL_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [polling, applyProbe]);
	const runProbe = (0, react.useCallback)(async () => {
		setBusy("probe");
		setMessage(void 0);
		try {
			const value = await call(probeRoute, "POST");
			if (value !== void 0) applyProbe(value);
		} catch (error) {
			setMessage({
				tone: "error",
				text: errorText$1(error, t)
			});
		} finally {
			setBusy(void 0);
		}
	}, [applyProbe, t]);
	const openLogin = (0, react.useCallback)(async () => {
		setBusy("open");
		setMessage(void 0);
		try {
			const value = await call(openRoute, "POST");
			if (value === void 0) return;
			if (!value.opened) {
				setMessage({
					tone: "warn",
					text: value.detail ?? t("login.unavailable")
				});
				return;
			}
			markBrowserStarted();
			if (value.loggedIn) {
				setMessage({
					tone: "success",
					text: t("login.already")
				});
				runProbe();
				return;
			}
			setMessage({
				tone: "warn",
				text: t("login.opened") + (value.detail === void 0 ? "" : t("login.openDetail").replace("{detail}", value.detail))
			});
			setPolling(true);
		} catch (error) {
			setMessage({
				tone: "error",
				text: errorText$1(error, t)
			});
		} finally {
			setBusy(void 0);
		}
	}, [
		markBrowserStarted,
		runProbe,
		t
	]);
	const importLogin = (0, react.useCallback)(async () => {
		if (raw.trim() === "") {
			setMessage({
				tone: "warn",
				text: t("login.emptyRaw")
			});
			return;
		}
		setBusy("import");
		setMessage(void 0);
		try {
			const value = await call(importRoute, "POST", { raw });
			if (value === void 0) return;
			applyProbe(value.status);
			markBrowserStarted();
			if (value.status.status === "ok") {
				setMessage({
					tone: "success",
					text: t("login.importOk")
				});
				setRaw("");
			} else if (value.status.status === "unknown") {
				setMessage({
					tone: "warn",
					text: t("login.importPend")
				});
				setPolling(true);
			} else setMessage({
				tone: "warn",
				text: t("login.importWarn")
			});
		} catch (error) {
			setMessage({
				tone: "error",
				text: errorText$1(error, t)
			});
		} finally {
			setBusy(void 0);
		}
	}, [
		applyProbe,
		markBrowserStarted,
		raw,
		t
	]);
	const exportLogin = (0, react.useCallback)(async () => {
		setBusy("export");
		setMessage(void 0);
		try {
			const value = await call(exportRoute, "POST");
			if (value === void 0) return;
			const text = JSON.stringify({
				userToken: value.token,
				cookies: value.cookies
			}, null, 2);
			try {
				await navigator.clipboard.writeText(text);
				setExportText(void 0);
				setMessage({
					tone: "success",
					text: t("login.copied")
				});
			} catch {
				setExportText(text);
				setMessage({
					tone: "warn",
					text: t("login.copyManual")
				});
			}
		} catch (error) {
			setMessage({
				tone: "error",
				text: errorText$1(error, t)
			});
		} finally {
			setBusy(void 0);
		}
	}, [t]);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
		variant: "aux",
		title: t(isDoubao ? "doubaoLogin.title" : isGlm ? "login.glm.title" : "login.title"),
		hint: t(isDoubao ? "doubaoLogin.hint" : isGlm ? "login.glm.hint" : "login.hint"),
		collapsible: true,
		children: [
			state === "unavailable" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsweb-banner dsweb-banner-warn",
				children: t("login.unavailable")
			}),
			state === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsweb-skeleton" }),
			state === "ready" && status !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				status.enabled === false && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-banner dsweb-banner-warn",
					children: t("doubaoLogin.disabled")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsweb-row dsweb-row-wide",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsweb-row-text",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsweb-row-label",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
								tone: STATUS_TONE[status.status],
								children: t(`login.status.${status.status}`)
							}), status.detail === void 0 ? null : ` ${status.detail}`]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "dsweb-row-hint",
							children: [
								status.checkedAt === void 0 ? t("login.never") : `${t("login.checkedAt")}: ${formatTime(status.checkedAt)}`,
								" · ",
								status.browserStarted ? t("login.browser.started") : t("login.browser.stopped")
							]
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsweb-row-control",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsweb-button dsweb-button-secondary",
							disabled: busy !== void 0,
							onClick: () => {
								runProbe();
							},
							children: busy === "probe" ? t("login.probing") : t("login.probe")
						})
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsweb-row dsweb-row-wide",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsweb-row-text",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsweb-row-label",
							children: t("login.open")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsweb-row-hint",
							children: t(isDoubao ? "doubaoLogin.openHint" : isGlm ? "login.glm.openHint" : "login.openHint")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsweb-row-control",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsweb-button dsweb-button-secondary",
							disabled: !status.canOpen || busy !== void 0 || polling,
							onClick: () => {
								openLogin();
							},
							children: busy === "open" ? t("login.opening") : polling ? t("login.polling") : t("login.open")
						})
					})]
				}),
				message !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: `dsweb-banner dsweb-banner-${message.tone}`,
					children: message.text
				}),
				supportsAdvanced && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Fold, {
					title: t("login.advanced"),
					hint: t("login.advancedHint"),
					defaultOpen: false,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsweb-row dsweb-row-wide",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsweb-row-text",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: "dsweb-row-label",
									htmlFor: "dsweb-login-import",
									children: t("login.importLabel")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsweb-row-hint",
									children: t("login.importHint")
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsweb-row-control",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									id: "dsweb-login-import",
									className: "dsweb-textarea",
									value: raw,
									placeholder: t("login.importPlaceholder"),
									disabled: !status.canImport || busy !== void 0,
									onChange: (event) => setRaw(event.target.value)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsweb-button dsweb-button-secondary",
									disabled: !status.canImport || busy !== void 0 || raw.trim() === "",
									onClick: () => {
										importLogin();
									},
									children: busy === "import" ? t("login.importing") : t("login.import")
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsweb-row dsweb-row-wide",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsweb-row-text",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsweb-row-label",
									children: t("login.export")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsweb-row-hint",
									children: t("login.exportWarning")
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsweb-row-control",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsweb-button dsweb-button-secondary",
									disabled: !status.canExport || busy !== void 0,
									onClick: () => {
										exportLogin();
									},
									children: busy === "export" ? t("login.exporting") : t("login.export")
								})
							})]
						}),
						exportText !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsweb-row dsweb-row-wide",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsweb-row-text",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: "dsweb-row-label",
									htmlFor: "dsweb-login-export",
									children: t("login.exportTitle")
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsweb-row-control",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									id: "dsweb-login-export",
									className: "dsweb-textarea",
									readOnly: true,
									value: exportText,
									onFocus: (event) => event.currentTarget.select()
								})
							})]
						})
					]
				})
			] })
		]
	});
}

//#endregion
//#region src/client/archive-cleanup-card.tsx
const STATS_ROUTE = "/api/dsh-deepseek-web/archive-cleanup";
const RUN_ROUTE = "/api/dsh-deepseek-web/archive-cleanup/run";
const WEB_CHATS_ROUTE = "/api/dsh-deepseek-web/archive-cleanup/web-chats";
const PURGE_ROUTE = "/api/dsh-deepseek-web/archive-cleanup/purge-all";
/** 与宿主侧 `PURGE_CONFIRM_WORD` 保持一致。 */
const PURGE_CONFIRM_WORD = "DELETE_ALL_WEB_CHATS";
/** 用户需要手动输入的确认文字。 */
const PURGE_CONFIRM_TEXT = "清空网页端";
async function getJson(url, signal) {
	const response = await fetch(url, {
		method: "GET",
		signal,
		headers: { accept: "application/json" }
	});
	const body = await response.json().catch(() => void 0);
	if (!response.ok || body?.ok !== true || body.value === void 0) return void 0;
	return body.value;
}
async function postJson(url, payload) {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json"
		},
		body: JSON.stringify(payload)
	});
	const body = await response.json().catch(() => void 0);
	if (!response.ok || body?.ok !== true) return {
		ok: false,
		message: body?.message ?? `HTTP ${response.status}`
	};
	return {
		ok: true,
		value: body.value
	};
}
/**
* 归档清理卡片。
*
* @param props.t - 设置页的翻译函数。
*/
function ArchiveCleanupCard({ t }) {
	const [stats, setStats] = (0, react.useState)(null);
	const [state, setState] = (0, react.useState)("idle");
	const [busy, setBusy] = (0, react.useState)(false);
	const [message, setMessage] = (0, react.useState)(null);
	const [purgeOpen, setPurgeOpen] = (0, react.useState)(false);
	const [purgeCount, setPurgeCount] = (0, react.useState)(null);
	const [purgeCountState, setPurgeCountState] = (0, react.useState)("idle");
	const [purgeRetry, setPurgeRetry] = (0, react.useState)(0);
	const [purgeWord, setPurgeWord] = (0, react.useState)("");
	const [purgeBusy, setPurgeBusy] = (0, react.useState)(false);
	const wasPurgeOpen = (0, react.useRef)(false);
	const load = (0, react.useCallback)((signal) => {
		setState("loading");
		getJson(STATS_ROUTE, signal).then((value) => {
			if (signal.aborted) return;
			if (value === void 0) {
				setState("unavailable");
				return;
			}
			setStats(value);
			setState("ready");
		}).catch(() => {
			if (!signal.aborted) setState("unavailable");
		});
	}, []);
	(0, react.useEffect)(() => {
		const controller = new AbortController();
		load(controller.signal);
		return () => controller.abort();
	}, [load]);
	(0, react.useEffect)(() => {
		if (!purgeOpen) return;
		const controller = new AbortController();
		setPurgeCount(null);
		setPurgeCountState("loading");
		setPurgeWord("");
		setMessage(null);
		getJson(WEB_CHATS_ROUTE, controller.signal).then((value) => {
			if (controller.signal.aborted) return;
			if (value === void 0) {
				setPurgeCountState("error");
				return;
			}
			setPurgeCount(value.total);
			setPurgeCountState("ready");
		}).catch(() => {
			if (!controller.signal.aborted) setPurgeCountState("error");
		});
		return () => controller.abort();
	}, [purgeOpen, purgeRetry]);
	(0, react.useEffect)(() => {
		if (wasPurgeOpen.current && !purgeOpen) document.getElementById("dsweb-purge-toggle")?.focus();
		wasPurgeOpen.current = purgeOpen;
	}, [purgeOpen]);
	(0, react.useEffect)(() => {
		if (!purgeOpen) return;
		const onKeyDown = (event) => {
			if (event.key === "Escape" && !purgeBusy) setPurgeOpen(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [purgeOpen, purgeBusy]);
	const refresh = (0, react.useCallback)(() => {
		load(new AbortController().signal);
	}, [load]);
	const runPending = (0, react.useCallback)(() => {
		if (busy) return;
		setBusy(true);
		setMessage(null);
		postJson(RUN_ROUTE, {}).then((result) => {
			if (!result.ok) {
				setMessage(result.message ?? t("archiveCleanup.unavailable"));
				return;
			}
			const deleted = result.value?.deleted ?? 0;
			setMessage(deleted === 0 ? t("archiveCleanup.runNone") : t("archiveCleanup.runDone").replace("{n}", String(deleted)));
			refresh();
		}).catch(() => setMessage(t("archiveCleanup.unavailable"))).finally(() => setBusy(false));
	}, [
		busy,
		refresh,
		t
	]);
	const submitPurge = (0, react.useCallback)(() => {
		if (purgeBusy || purgeCountState !== "ready" || purgeCount === null) return;
		if (purgeWord.trim() !== PURGE_CONFIRM_TEXT) return;
		setPurgeBusy(true);
		setMessage(null);
		postJson(PURGE_ROUTE, {
			confirm: PURGE_CONFIRM_WORD,
			expectedCount: purgeCount
		}).then((result) => {
			if (!result.ok) {
				setMessage(result.message ?? t("archiveCleanup.purgeMismatch"));
				return;
			}
			const deleted = result.value?.deleted ?? 0;
			const failed = result.value?.failed ?? 0;
			setMessage(t("archiveCleanup.purgeDone").replace("{n}", String(deleted)).replace("{m}", String(failed)));
			setPurgeOpen(false);
			refresh();
		}).catch(() => setMessage(t("archiveCleanup.unavailable"))).finally(() => setPurgeBusy(false));
	}, [
		purgeBusy,
		purgeCount,
		purgeCountState,
		purgeWord,
		refresh,
		t
	]);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
		variant: "aux",
		title: t("archiveCleanup.title"),
		hint: t("archiveCleanup.hint"),
		collapsible: true,
		children: [
			state === "unavailable" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsweb-banner dsweb-banner-warn",
				children: t("archiveCleanup.unavailable")
			}),
			state === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsweb-skeleton" }),
			state === "ready" && stats !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsweb-stats",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
						label: t("archiveCleanup.pending"),
						value: String(stats.pending),
						tone: "accent"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
						label: t("archiveCleanup.failed"),
						value: String(stats.failed),
						tone: stats.failed > 0 ? "danger" : "neutral"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
						label: t("archiveCleanup.unbound"),
						value: String(stats.unbound),
						tone: stats.unbound > 0 ? "warn" : "neutral"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
						label: t("archiveCleanup.archived"),
						value: String(stats.archivedTotal)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
						label: t("archiveCleanup.cleaned"),
						value: String(stats.cleaned)
					})
				]
			}), stats.unbound > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsweb-banner dsweb-banner-warn",
				children: t("archiveCleanup.unboundHint")
			})] }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsweb-row dsweb-row-wide",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsweb-row-text",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsweb-row-label",
						children: t("archiveCleanup.run")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dsweb-row-hint",
						children: t("archiveCleanup.runHint")
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-row-control",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsweb-button dsweb-button-secondary",
						disabled: busy || state !== "ready",
						onClick: runPending,
						children: busy ? t("archiveCleanup.running") : t("archiveCleanup.runNow")
					})
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Fold, {
				title: t("archiveCleanup.purge"),
				hint: t("archiveCleanup.purgeShortHint"),
				tone: "danger",
				open: purgeOpen,
				onOpenChange: setPurgeOpen,
				toggleId: "dsweb-purge-toggle",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsweb-danger-body",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsweb-banner dsweb-banner-error",
							children: t("archiveCleanup.purgeHint")
						}),
						purgeCountState === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsweb-row-hint",
							children: t("archiveCleanup.loading")
						}),
						purgeCountState === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsweb-banner dsweb-banner-warn",
							children: [t("archiveCleanup.countFailed"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsweb-link",
								onClick: () => setPurgeRetry((value) => value + 1),
								children: t("archiveCleanup.retry")
							})]
						}),
						purgeCountState === "ready" && purgeCount !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsweb-row-hint",
							children: t("archiveCleanup.purgeCount").replace("{n}", String(purgeCount))
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "dsweb-row-label",
							htmlFor: "dsweb-purge-confirm",
							children: t("archiveCleanup.purgeConfirmLabel")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: "dsweb-purge-confirm",
							className: "dsweb-input",
							type: "text",
							value: purgeWord,
							placeholder: PURGE_CONFIRM_TEXT,
							onChange: (event) => setPurgeWord(event.target.value)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsweb-actions dsweb-actions-start",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsweb-button dsweb-button-secondary",
								disabled: purgeBusy,
								onClick: () => setPurgeOpen(false),
								children: t("archiveCleanup.purgeCancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsweb-button dsweb-button-danger",
								disabled: purgeBusy || purgeCountState !== "ready" || purgeCount === null || purgeWord.trim() !== PURGE_CONFIRM_TEXT,
								onClick: submitPurge,
								children: purgeBusy ? t("archiveCleanup.purging") : t("archiveCleanup.purgeSubmit")
							})]
						})
					]
				})
			}),
			message !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsweb-banner",
				children: message
			})
		]
	});
}

//#endregion
//#region src/client/settings-section.tsx
/** `settings.section` 里的 section id。 */
const SECTION_ID = "deepseek-web";
/** 排序：账号 -10 / 通用 0 / 模型 10 / 插件 15 之后。 */
const SECTION_ORDER = 20;
/** 空对象占位，保证依赖身份稳定。 */
const EMPTY_OBJECT = {};
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function errorMessageOf(error, t) {
	if (error instanceof Error) return error.message;
	const text = String(error);
	return text === "" ? t("unknownError") : text;
}
/**
* 注册设置菜单与表单。
*
* @param ctx - 客户端上下文（已含 configForms / slots / locale 服务）。
*/
function registerSettingsSection(ctx) {
	ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, LOCALE_DICTIONARIES), "dsh-deepseek-web: settings copy");
	const t = ctx.locale.bind(LOCALE_NAMESPACE);
	const form = ctx.configForms.get(ROW_ENTRY_ID);
	const reload = () => {
		ctx.configForms.describe().load();
	};
	const navLabel = () => {
		const snapshot = form.getSnapshot();
		return translatorFor(resolveUiLanguage(readPath(isRecord(snapshot.value) ? snapshot.value : EMPTY_OBJECT, ["uiLanguage"])))("nav");
	};
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: SECTION_ID,
		order: SECTION_ORDER,
		label: navLabel,
		inject: () => ({
			form,
			hooks: { settingsForm: form },
			t,
			reload
		})
	}, DeepSeekWebSettingsSection));
}
/**
* 设置面板里的插件菜单。
*
* @param props - 槽位宿主与注入面提供的 props。
* @returns 设置页内容。
*/
function DeepSeekWebSettingsSection(props) {
	if (props.form === void 0 || props.useSettingsForm === void 0) {
		const t = translatorFor(resolveUiLanguage(void 0));
		return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsPage, {
			title: t("title"),
			badges: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
				tone: "warn",
				children: t("missingFormTitle")
			}),
			state: "missing",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
				variant: "aux",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-banner dsweb-banner-warn",
					children: t("missingFormBody")
				})
			})
		});
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsSectionBody, {
		form: props.form,
		useSettingsForm: props.useSettingsForm,
		reload: props.reload
	});
}
/** 设置页主体：订阅宿主快照、维护草稿、原子保存。 */
function SettingsSectionBody({ form, useSettingsForm, reload }) {
	const snapshot = useSettingsForm((value) => value);
	const [draft, setDraft] = (0, react.useState)(null);
	const [listText, setListText] = (0, react.useState)({});
	const [busy, setBusy] = (0, react.useState)(false);
	const [notice, setNotice] = (0, react.useState)(null);
	const [activeGroup, setActiveGroup] = (0, react.useState)(GROUPS[0]?.id ?? "");
	const accepted = isRecord(snapshot.value) ? snapshot.value : EMPTY_OBJECT;
	const user = isRecord(snapshot.user) ? snapshot.user : EMPTY_OBJECT;
	const writable = snapshot.writable === true;
	const ready = snapshot.status === "ready";
	/** 草稿优先的「当前生效值」，供档位匹配与语言预览用。 */
	const effective = (0, react.useMemo)(() => {
		let merged = accepted;
		if (draft !== null) {
			for (const field of FIELDS) if (hasPath(draft, field.path)) merged = withEdit(merged, accepted, field.path, readPath(draft, field.path));
		}
		return merged;
	}, [draft, accepted]);
	const language = resolveUiLanguage(readPath(effective, ["uiLanguage"]));
	const t = (0, react.useMemo)(() => translatorFor(language), [language]);
	/** 字段当前展示值：草稿优先，草稿未触碰过的取宿主当前值。 */
	const valueOf = (0, react.useCallback)((field) => {
		if (draft !== null && hasPath(draft, field.path)) return readPath(draft, field.path);
		return readPath(accepted, field.path);
	}, [draft, accepted]);
	const errors = (0, react.useMemo)(() => {
		const found = /* @__PURE__ */ new Map();
		for (const field of FIELDS) {
			const code = validateField(field, valueOf(field));
			if (code !== void 0) found.set(fieldKey(field), code);
		}
		return found;
	}, [valueOf]);
	/** 当前落在哪个风控档位；与任何档位都不全等即「自定义」。 */
	const riskTier = (0, react.useMemo)(() => matchRiskPreset(effective), [effective]);
	const pendingOps = (0, react.useMemo)(() => diffOps(draft, accepted, user), [
		draft,
		accepted,
		user
	]);
	const dirty = pendingOps.length > 0;
	const blocked = errors.size > 0;
	const canSave = writable && !busy && dirty && !blocked;
	/** 哪些分组里有未保存的改动——左栏据此点一个小圆点。 */
	const dirtyGroups = (0, react.useMemo)(() => {
		const touched = new Set(pendingOps.map((op) => op.path.join(".")));
		const groups = /* @__PURE__ */ new Set();
		for (const field of FIELDS) if (touched.has(fieldKey(field))) groups.add(field.group);
		return groups;
	}, [pendingOps]);
	const edit = (0, react.useCallback)((field, value) => {
		setNotice(null);
		setDraft((previous) => withEdit(previous, accepted, field.path, value));
	}, [accepted]);
	const editList = (0, react.useCallback)((field, raw) => {
		edit(field, parseList(raw));
		setListText((previous) => ({
			...previous,
			[fieldKey(field)]: raw
		}));
	}, [edit]);
	/** 套用某个风控档位：把该档位的值成套写进草稿（仍要按「保存」才落盘）。 */
	const applyTier = (0, react.useCallback)((preset) => {
		setNotice(null);
		setDraft((previous) => applyRiskPreset(previous, accepted, preset));
	}, [accepted]);
	const discard = (0, react.useCallback)(() => {
		setDraft(null);
		setListText({});
		setNotice(null);
	}, []);
	const reloadFromHost = (0, react.useCallback)(() => {
		setDraft(null);
		setListText({});
		setNotice(null);
		reload?.();
	}, [reload]);
	const submit = (0, react.useCallback)(async () => {
		if (!writable || busy) return;
		const live = form.getSnapshot();
		const ops = diffOps(draft, isRecord(live.value) ? live.value : EMPTY_OBJECT, isRecord(live.user) ? live.user : EMPTY_OBJECT);
		if (ops.length === 0) {
			setNotice({
				tone: "info",
				text: t("nochange")
			});
			return;
		}
		setBusy(true);
		try {
			if (!await form.mutate(ops, live.revision)) {
				setNotice({
					tone: "error",
					text: t("rejected")
				});
				return;
			}
			const after = isRecord(form.getSnapshot().value) ? form.getSnapshot().value : EMPTY_OBJECT;
			if (ops.some((op) => op.op === "set" && !sameValue(readPath(after, op.path), op.value))) {
				setNotice({
					tone: "warn",
					text: t("mismatch")
				});
				return;
			}
			setDraft(null);
			setListText({});
			setNotice({
				tone: "success",
				text: t("saved")
			});
		} catch (error) {
			setNotice({
				tone: "error",
				text: `${t("failed")}${errorMessageOf(error, t)}`
			});
		} finally {
			setBusy(false);
		}
	}, [
		busy,
		draft,
		form,
		t,
		writable
	]);
	const resetField = (0, react.useCallback)(async (field) => {
		if (!writable || busy) return;
		const live = form.getSnapshot();
		setBusy(true);
		try {
			if (!await form.mutate([{
				op: "unset",
				path: [...field.path]
			}], live.revision)) {
				setNotice({
					tone: "error",
					text: t("rejected")
				});
				return;
			}
			setDraft((previous) => withoutPath(previous, field.path));
			setListText((previous) => {
				const next = { ...previous };
				delete next[fieldKey(field)];
				return next;
			});
			setNotice({
				tone: "success",
				text: t("resetDone")
			});
		} catch (error) {
			setNotice({
				tone: "error",
				text: `${t("failed")}${errorMessageOf(error, t)}`
			});
		} finally {
			setBusy(false);
		}
	}, [
		busy,
		form,
		t,
		writable
	]);
	/** 跳到某个分组并把左栏高亮对上。 */
	const selectGroup = (0, react.useCallback)((groupId) => {
		setActiveGroup(groupId);
		const node = document.getElementById(`dsweb-group-${groupId}`);
		if (node !== null) {
			const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			node.scrollIntoView({
				behavior: reduced ? "auto" : "smooth",
				block: "start"
			});
		}
	}, []);
	(0, react.useEffect)(() => {
		if (typeof IntersectionObserver === "undefined") return;
		const nodes = GROUPS.map((group) => document.getElementById(`dsweb-group-${group.id}`)).filter((node) => node !== null);
		if (nodes.length === 0) return;
		const observer = new IntersectionObserver((entries) => {
			const hit = entries.filter((entry) => entry.isIntersecting).sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
			if (hit !== void 0) setActiveGroup(hit.target.id.replace("dsweb-group-", ""));
		}, { rootMargin: "-15% 0px -70% 0px" });
		for (const node of nodes) observer.observe(node);
		return () => observer.disconnect();
	}, [snapshot.status]);
	(0, react.useEffect)(() => {
		const onKeyDown = (event) => {
			if (event.defaultPrevented || !(event.ctrlKey || event.metaKey)) return;
			if (event.key !== "s" && event.key !== "S") return;
			event.preventDefault();
			submit();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [submit]);
	if (snapshot.status === "unavailable") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsPage, {
		title: t("title"),
		badges: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
			tone: "warn",
			children: t("unavailableTitle")
		}),
		state: "unavailable",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
			variant: "aux",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsweb-banner dsweb-banner-warn",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsweb-banner-title",
						children: t("unavailableTitle")
					}),
					t("unavailableBody"),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}),
					t("unavailableHint"),
					" ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
						className: "dsweb-code",
						children: "llm-deepseek-web"
					})
				] })
			})
		})
	});
	if (!ready) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsPage, {
		title: t("title"),
		subtitle: t("loading"),
		state: "loading",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
			variant: "aux",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Skeleton, { rows: 4 })
		})
	});
	const status = notice ?? (blocked ? {
		tone: "warn",
		text: t("invalid")
	} : dirty ? {
		tone: "info",
		text: t("dirtyCount").replace("{n}", String(pendingOps.length))
	} : {
		tone: "muted",
		text: t("clean")
	});
	const actions = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			className: "dsweb-button dsweb-button-secondary",
			disabled: busy,
			title: t("reloadHint"),
			onClick: reloadFromHost,
			children: t("reload")
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			className: "dsweb-button dsweb-button-secondary",
			disabled: busy || !dirty,
			onClick: discard,
			children: t("discard")
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			className: "dsweb-button dsweb-button-primary",
			disabled: !canSave,
			onClick: () => {
				submit();
			},
			children: busy ? t("saving") : t("save")
		})
	] });
	const badges = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
			tone: dirty ? "info" : "muted",
			children: dirty ? t("dirty") : t("clean")
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
			tone: "warn",
			children: t("readonly")
		}),
		blocked && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
			tone: "warn",
			children: t("invalid")
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
			tone: "muted",
			children: t("shortcut")
		})
	] });
	const rail = /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Rail, {
		label: t("groupsLabel"),
		items: GROUPS.map((group, index) => ({
			id: group.id,
			label: t(`group.${group.id}`),
			index: index + 1,
			dirty: dirtyGroups.has(group.id)
		})),
		activeId: activeGroup,
		onSelect: selectGroup
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(SettingsPage, {
		title: t("title"),
		subtitle: t("intro"),
		badges,
		rail,
		actions,
		status: status.text,
		statusTone: status.tone,
		state: "ready",
		children: [
			!writable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
				variant: "aux",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-banner dsweb-banner-warn",
					children: t("readonly")
				})
			}),
			GROUPS.map((group, groupIndex) => {
				const fields = FIELDS.filter((field) => field.group === group.id);
				if (fields.length === 0) return null;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
					groupId: group.id,
					index: groupIndex + 1,
					title: t(`group.${group.id}`),
					hint: t(`group.${group.id}.hint`),
					collapsible: true,
					children: [group.id === "risk" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FieldRow, {
						fieldId: "risk-tier",
						label: t("riskTier"),
						hint: t("riskTierHint"),
						wide: true,
						control: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsweb-tier-buttons",
							children: [RISK_PRESETS.map((preset) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: `dsweb-button ${riskTier === preset.id ? "dsweb-button-primary" : "dsweb-button-secondary"}`,
								disabled: !writable || busy,
								title: t(`risk.${preset.id}.hint`),
								onClick: () => applyTier(preset),
								children: t(`risk.${preset.id}`)
							}, preset.id)), riskTier === "custom" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
								tone: "warn",
								children: t("riskCustom")
							})]
						})
					}), fields.map((field) => {
						const key = fieldKey(field);
						const domId = fieldDomId(field);
						const error = errors.get(key);
						const overridden = hasPath(user, field.path);
						const wide = field.kind === "list" || field.kind === "text";
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FieldRow, {
							fieldId: key,
							domId,
							label: t(`field.${key}`),
							badges: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [field.restart === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
								tone: "info",
								children: t("restart")
							}), overridden && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
								tone: "muted",
								children: t("custom")
							})] }),
							hint: field.hint === void 0 ? void 0 : t(`field.${key}.hint`),
							error: error === void 0 ? void 0 : errorText(field, error, t),
							wide,
							control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FieldControl, {
								field,
								value: valueOf(field),
								domId,
								listText: listText[key],
								invalid: error !== void 0,
								disabled: !writable || busy,
								placeholder: t("listPlaceholder"),
								optionLabel: field.optionLabels === void 0 ? void 0 : (option) => t(`field.${key}.opt.${option}`),
								onChange: (next) => edit(field, next),
								onChangeList: (raw) => editList(field, raw)
							}),
							reset: overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsweb-link",
								disabled: !writable || busy,
								onClick: () => {
									resetField(field);
								},
								children: t("reset")
							}) : void 0
						}, key);
					})]
				}, group.id);
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoginCard, { t }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoginCard, {
				t,
				channel: "glm"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoginCard, {
				t,
				channel: "doubao"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LedgerCard, { t }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ArchiveCleanupCard, { t })
		]
	});
}
/** 校验错误的人话文案。 */
function errorText(field, code, t) {
	switch (code) {
		case "number": return t("errNumber");
		case "min": return `${t("errMin")} ${field.min ?? ""}`.trim();
		case "max": return `${t("errMax")} ${field.max ?? ""}`.trim();
		case "option": return t("errOption");
		default: return "";
	}
}

//#endregion
//#region src/client/conversation-recovery.ts
/** 会话列表变化后第一次自检的延迟。 */
const FIRST_CHECK_MS = 600;
/** 事件落地后自检的延迟。 */
const FEED_CHECK_MS = 400;
/** 激活后复查的延迟。 */
const RETRY_CHECK_MS = 2e3;
function monitorConversationBlank(ctx) {
	const host = ctx;
	const timers = /* @__PURE__ */ new Set();
	/** sessionId → 事件源退订函数；只为当前持有 binding 的会话建立。 */
	const watched = /* @__PURE__ */ new Map();
	const conversationOf = (sessionId) => {
		try {
			return host.uiConversation.binding(sessionId);
		} catch {
			return;
		}
	};
	const schedule = (fn, delay) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			fn();
		}, delay);
		timers.add(timer);
	};
	/** chat 视图快照；undefined = 目标从未构建。 */
	const chatSnapshotOf = (sessionId) => {
		const conversation = conversationOf(sessionId);
		if (conversation === void 0) return void 0;
		try {
			return conversation.snapshot.getSnapshot().views.get("chat");
		} catch {
			return;
		}
	};
	const isRendered = (sessionId) => {
		const chat = chatSnapshotOf(sessionId);
		return chat !== void 0 && (chat.order?.length ?? 0) > 0;
	};
	/**
	* 核心自愈：会话确有内容、不是从未使用的空会话、而 chat 视图未渲染时，
	* 补激活 chat 目标；激活后仍未渲染（快照构建了但内容为空）再 rebuild 一次。
	* activate 幂等：视图已正常时是无害空操作；非活动会话在建 binding 前就返回。
	*/
	const ensureRendered = (sessionId) => {
		try {
			const binding = host.sessions.binding(sessionId);
			if (binding === void 0) return;
			if (binding.eventSource.getSnapshot().entries.length === 0) return;
			if (binding.session.getSnapshot().blank === true) return;
			if (isRendered(sessionId)) return;
			const conversation = conversationOf(sessionId);
			if (conversation === void 0) return;
			conversation.activate("chat");
			try {
				conversation.flush();
			} catch (error) {
				console.warn("[deepseek-web] 强制 flush 失败：", error);
			}
			schedule(() => {
				if (isRendered(sessionId)) return;
				console.info("[deepseek-web] 激活后仍未渲染，重建对话视图快照…");
				try {
					conversation.rebuild();
					conversation.flush();
				} catch (error) {
					console.warn("[deepseek-web] 重建失败：", error);
				}
			}, RETRY_CHECK_MS);
		} catch (error) {
			console.warn("[deepseek-web] 对话视图自检失败：", error);
		}
	};
	/**
	* 把订阅集合对齐到“列表里可见且已持有 Session binding”的会话：
	* 新增订阅，消失的退订。没有当前会话信号，就用“有 binding”近似“可能正在显示”。
	*/
	const syncWatches = () => {
		const ids = new Set(host.sessions.list.getSnapshot().ids);
		for (const [sessionId, unsubscribe] of [...watched]) {
			if (ids.has(sessionId)) continue;
			unsubscribe();
			watched.delete(sessionId);
		}
		for (const sessionId of ids) {
			if (watched.has(sessionId)) continue;
			const binding = host.sessions.binding(sessionId);
			if (binding === void 0) continue;
			watched.set(sessionId, binding.eventSource.subscribe(() => {
				schedule(() => ensureRendered(sessionId), FEED_CHECK_MS);
			}));
		}
	};
	ctx.effect(() => {
		const listUnsubscribe = host.sessions.list.subscribe(() => {
			syncWatches();
			for (const sessionId of [...watched.keys()]) schedule(() => ensureRendered(sessionId), FIRST_CHECK_MS);
		});
		syncWatches();
		for (const sessionId of [...watched.keys()]) schedule(() => ensureRendered(sessionId), FIRST_CHECK_MS);
		return () => {
			listUnsubscribe();
			for (const unsubscribe of watched.values()) unsubscribe();
			watched.clear();
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
		};
	}, "dsh-deepseek-web: conversation blank recovery");
}

//#endregion
//#region src/client/index.ts
/** Services this client module needs from the page's client context. */
const inject = [
	"slots",
	"sessions",
	"uiConversation"
];
/**
* Register the plugin's settings menu, its Plugin Manager config page, and the
* conversation-view safeguard.
* @param ctx - the client context.
*/
function apply(ctx) {
	const host = ctx;
	ensureSettingsStyles();
	ctx.inject(["configForms", "locale"], (sub) => {
		registerSettingsSection(sub);
	});
	host.slots.inject("plugins.row.config", () => host.slots.register({
		name: "plugins.row.config",
		key: ROW_CONFIG_KEY
	}, DeepSeekWebConfigPage));
	monitorConversationBlank(ctx);
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map