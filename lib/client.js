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
			zh: "交付前用第二个模型复核结果；关闭后行为与只用 DeepSeek 完全一致。",
			en: "A second model reviews the result before delivery; disabling it restores plain DeepSeek behavior."
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
			zh: "提示词更长，但网页端行为更稳。",
			en: "Longer prompts, steadier page-side behavior."
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
			zh: "启用审核",
			en: "Enable review"
		},
		hint: {
			zh: "中间工具轮次不审，只在交付前审最终正文。",
			en: "Intermediate tool turns are not reviewed; only the final text before delivery."
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
/** 中文校验错误文案（插件管理器的行配置页是纯中文界面，设置页另有本地化文案）。 */
function errorMessageZh(field, code) {
	switch (code) {
		case "number": return "请填数字。";
		case "min": return `不能小于 ${String(field.min ?? "")}。`;
		case "max": return `不能大于 ${String(field.max ?? "")}。`;
		case "option": return "请选择列表里的选项。";
		default: return "";
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
//#region src/client/config-page.tsx
/** 本包在 profile 里的 npm 包名。 */
const PACKAGE_NAME = "dsh-deepseek-web-xxxxxgold";
/** 插件入口在包自带 patch 里声明的行 id；与包名一起构成槽位 key，也是宿主的 settings entry id。 */
const ROW_ENTRY_ID = "llm-deepseek-web";
/** 本插件在 Plugin Manager 里的 `plugins.row.config` 槽位 key。 */
const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ROW_ENTRY_ID}`;
const labelStyle = {
	display: "block",
	fontSize: 13,
	lineHeight: "20px",
	marginBottom: 4
};
const hintStyle = {
	fontSize: 12,
	lineHeight: "18px",
	opacity: .7,
	margin: "2px 0 0"
};
const rowStyle = {
	marginBottom: 14,
	maxWidth: 560
};
const inputStyle = {
	font: "inherit",
	padding: "6px 8px",
	width: "100%",
	boxSizing: "border-box"
};
/**
* 判断一个字段是否应当显示。
*
* `visibleWhen` 支持单条件或条件数组：数组要求**全部满足**，
* 这样「provider 是 kimi 且 kimiMode 是 project」才能精确只显示项目链接框。
*/
function isFieldVisible(rule, current) {
	if (rule === void 0) return true;
	if (Array.isArray(rule)) return rule.every((item) => readPath(current, item.path) === item.equals);
	return readPath(current, rule.path) === rule.equals;
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
	if (view === "summary") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: "审核通道、网页版模型入口、工具白名单、频控退避、过程提示、浏览器自愈与窗口聚焦。" });
	const accepted = form?.state.value ?? {};
	const user = form?.state.user ?? {};
	const revision = form?.state.revision;
	const writable = form?.state.writable === true;
	const current = draft ?? accepted;
	const errors = /* @__PURE__ */ new Map();
	for (const field of FIELDS) {
		const code = validateField(field, readPath(current, field.path));
		if (code !== void 0) errors.set(fieldKey(field), code);
	}
	const blocked = errors.size > 0;
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
			setNotice("有非法值，未保存。");
			return;
		}
		const ops = diffOps(draft, accepted, user);
		if (ops.length === 0) {
			setNotice("没有改动。");
			return;
		}
		setBusy(true);
		try {
			const ok = await form.mutate(ops, revision);
			setNotice(ok ? "已保存。" : "保存被宿主拒绝，已恢复宿主值。");
			if (ok) setDraft(null);
		} catch (error) {
			setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setBusy(false);
		}
	};
	if (form === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		style: hintStyle,
		children: "宿主未提供该条目的配置句柄，无法在此编辑。"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
		style: hintStyle,
		children: [
			"宿主的 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "formFor()" }),
			" 只在 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "settings.describe().namespaces" }),
			"含 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", { children: [
				"ns === '",
				ROW_ENTRY_ID,
				"'"
			] }),
			" 时给出表单，而该清单只收录 Config 里标了 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: ".volatile()" }),
			" 的字段所在的条目。 若此提示仍出现，请确认该 entry 的 id、以及其字段是否都标了 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: ".volatile()" }),
			"； 亦可改走 profile 的 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "cordis.patch.yml" }),
			" 覆盖 ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "config" }),
			"。"
		]
	})] });
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
		!writable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			style: {
				...hintStyle,
				marginBottom: 12
			},
			children: "当前部署不接受写入（只读或非 Host 持久化），字段仅供参考；请改用 profile 的 cordis.patch.yml。"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: rowStyle,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: labelStyle,
					children: "风控模式（整体档位）"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						flexWrap: "wrap",
						gap: 8,
						alignItems: "center"
					},
					children: [RISK_PRESETS.map((preset) => {
						const active = matchRiskPreset(current) === preset.id;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							disabled: !writable || busy,
							title: preset.hint.zh,
							style: active ? { fontWeight: 600 } : void 0,
							onClick: () => {
								for (const item of preset.values) edit(item.path, item.value);
							},
							children: active ? `● ${preset.label.zh}` : preset.label.zh
						}, preset.id);
					}), matchRiskPreset(current) === "custom" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: hintStyle,
						children: "当前：自定义"
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: hintStyle,
					children: "点档位会把发送节奏参数成套写进草稿，再按「保存」生效；手动改下面任一项即变成「自定义」。并发上限与标签页上限不受档位影响。"
				})
			]
		}),
		FIELDS.filter((field) => isFieldVisible(field.visibleWhen, current)).map((field) => {
			const value = readPath(current, field.path);
			const id = `dsweb-row-${fieldKey(field)}`;
			const error = errors.get(fieldKey(field));
			const invalid = error !== void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: rowStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						style: labelStyle,
						htmlFor: id,
						children: field.label.zh
					}),
					field.kind === "boolean" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id,
						type: "checkbox",
						disabled: !writable,
						checked: value === true,
						onChange: (event) => edit(field.path, event.target.checked)
					}),
					field.kind === "select" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
						id,
						style: inputStyle,
						disabled: !writable,
						value: typeof value === "string" ? value : "",
						onChange: (event) => edit(field.path, event.target.value),
						children: (field.options ?? []).map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: option,
							children: option
						}, option))
					}),
					field.kind === "number" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id,
						type: "number",
						style: inputStyle,
						disabled: !writable,
						min: field.min,
						max: field.max,
						value: typeof value === "number" ? String(value) : "",
						onChange: (event) => {
							const raw = event.target.value;
							edit(field.path, raw === "" ? void 0 : Number(raw));
						}
					}),
					field.kind === "text" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id,
						type: "text",
						style: inputStyle,
						disabled: !writable,
						value: typeof value === "string" ? value : "",
						onChange: (event) => edit(field.path, event.target.value)
					}),
					field.kind === "list" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						id,
						style: {
							...inputStyle,
							minHeight: 88,
							fontFamily: "monospace"
						},
						disabled: !writable,
						value: Array.isArray(value) ? value.filter((item) => typeof item === "string").join("\n") : "",
						onChange: (event) => edit(field.path, parseList(event.target.value))
					}),
					field.hint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: hintStyle,
						children: field.hint.zh
					}),
					invalid && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							...hintStyle,
							color: "var(--dsw-alias-label-error)"
						},
						children: errorMessageZh(field, error)
					})
				]
			}, id);
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "flex",
				alignItems: "center",
				gap: 12,
				marginTop: 20
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: !writable || busy || draft === null || blocked,
					onClick: () => {
						save();
					},
					children: busy ? "保存中…" : "保存"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: busy || draft === null,
					onClick: () => {
						setDraft(null);
						setNotice(null);
					},
					children: "放弃修改"
				}),
				notice !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: hintStyle,
					children: notice
				})
			]
		})
	] });
}

//#endregion
//#region src/client/settings-styles.ts
/**
* 设置面板的样式表。
*
* DSH 的客户端包在运行时用 `document.createElement('style')` 注入样式（locale、plugin-manager
* 与各 settings-* 包都这么做），本插件沿用同一通路，因此不依赖构建期的 CSS 产物。
*
* 所有颜色、圆角都取宿主主题变量，深浅色主题自动跟随；变量缺失时给同语义回退值。
*
* @module dsh-deepseek-web-xxxxxgold/client/settings-styles
*/
/** 样式元素 id：重复挂载时复用它，避免 HMR 或多次激活堆叠。 */
const STYLE_ELEMENT_ID = "dsh-deepseek-web-settings-style";
/** 设置面板样式。 */
const CSS = `
.dsweb-settings{display:flex;flex-direction:column;gap:14px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-family:inherit}
.dsweb-settings-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.dsweb-settings-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dsweb-settings-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsweb-settings-spacer{flex:1;min-width:0}
.dsweb-badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;font-size:11px;line-height:18px;font-weight:400;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsweb-badge-warn{background:transparent;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsweb-badge-info{background:transparent;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary)}
.dsweb-group{display:flex;flex-direction:column;gap:2px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsweb-group:first-of-type{border-top:none;padding-top:0}
.dsweb-group-title{margin:0;font-size:14px;font-weight:600;line-height:22px}
.dsweb-group-hint{margin:2px 0 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsweb-row{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:11px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsweb-row:last-child{border-bottom:none}
.dsweb-row-wide{flex-direction:column;align-items:stretch;gap:8px}
.dsweb-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsweb-row-label{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;line-height:20px}
.dsweb-row-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsweb-row-error{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-error)}
.dsweb-row-control{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:10px;width:260px;min-width:0}
.dsweb-row-wide .dsweb-row-control{width:100%;justify-content:flex-start;flex-wrap:wrap}
.dsweb-row-wide .dsweb-row-control>.dsweb-input,.dsweb-row-wide .dsweb-row-control>.dsweb-textarea{flex:1 1 auto;width:auto;min-width:0}
.dsweb-input,.dsweb-select,.dsweb-textarea{box-sizing:border-box;width:100%;min-height:32px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background-color:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;transition:border-color .12s ease,box-shadow .12s ease}
.dsweb-input:hover:not(:disabled),.dsweb-select:hover:not(:disabled),.dsweb-textarea:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}
.dsweb-input:focus-visible,.dsweb-select:focus-visible,.dsweb-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px var(--dsw-focus-ring-color,rgba(77,107,254,.25))}
.dsweb-input:disabled,.dsweb-select:disabled,.dsweb-textarea:disabled{opacity:.55;cursor:not-allowed}
.dsweb-input::placeholder,.dsweb-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}
.dsweb-select{appearance:none;-webkit-appearance:none;padding-right:26px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2381858c' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center;cursor:pointer}
.dsweb-select option{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsweb-textarea{min-height:84px;resize:vertical;font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px}
.dsweb-input-invalid,.dsweb-input-invalid:hover{border-color:var(--dsw-alias-label-error)}
.dsweb-switch{appearance:none;-webkit-appearance:none;position:relative;flex:none;box-sizing:border-box;width:38px;height:22px;margin:0;border:none;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .15s ease}
.dsweb-switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .15s ease}
.dsweb-switch:checked{background:var(--dsw-alias-button-primary-fill)}
.dsweb-switch:checked::after{transform:translateX(16px)}
.dsweb-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsweb-switch:disabled{opacity:.5;cursor:not-allowed}
.dsweb-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:32px;padding:0 14px;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;transition:background .12s ease,border-color .12s ease,opacity .12s ease}
.dsweb-button:disabled{opacity:.45;cursor:not-allowed}
.dsweb-button-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsweb-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsweb-button-secondary{background:transparent;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsweb-button-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsweb-link{flex:none;padding:0;border:none;background:none;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-link);cursor:pointer}
.dsweb-link:hover:not(:disabled){text-decoration:underline}
.dsweb-link:disabled{opacity:.5;cursor:not-allowed}
.dsweb-banner{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent);font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsweb-banner-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary)}
.dsweb-banner-error{border-color:var(--dsw-alias-label-error);color:var(--dsw-alias-label-primary)}
.dsweb-banner-success{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}
.dsweb-banner-title{display:block;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsweb-code{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;padding:1px 5px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-markdown-inline-code,rgba(127,127,127,.16))}
.dsweb-skeleton{height:38px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);animation:dsweb-pulse 1.4s ease-in-out infinite}
@keyframes dsweb-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dsweb-skeleton{animation:none}}
.dsweb-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsweb-status{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsweb-status-success{color:var(--dsw-alias-state-success-primary)}
.dsweb-status-error{color:var(--dsw-alias-label-error)}
.dsweb-status-warn{color:var(--dsw-alias-state-warn-primary)}
.dsweb-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.dsweb-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:4px 0}
.dsweb-stat{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent)}
.dsweb-stat-value{font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}
.dsweb-stat-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsweb-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsweb-checks{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px)}
.dsweb-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsweb-check-icon{flex:none;width:12px;text-align:center;font-weight:600}
.dsweb-check-ok .dsweb-check-icon{color:var(--dsw-alias-state-success-primary)}
.dsweb-check-warning .dsweb-check-icon{color:var(--dsw-alias-state-warn-primary)}
.dsweb-check-error .dsweb-check-icon{color:var(--dsw-alias-label-error)}
.dsweb-check-detail{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-all}
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
	const loadLedger = (0, react.useCallback)((signal) => {
		setLedgerState("loading");
		getJson(LEDGER_ROUTE, signal).then((value) => {
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
		const controller = new AbortController();
		setDoctorState("loading");
		getJson(DOCTOR_ROUTE, controller.signal).then((value) => {
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
	const failures = Object.entries(summary?.failures ?? {}).filter(([, count]) => count > 0);
	const tight = (intervals?.minMs ?? 0) > 0 && (intervals?.minMs ?? 0) < 3e4;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: "dsweb-group",
		"aria-labelledby": "dsweb-group-ledger",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
				className: "dsweb-group-title",
				id: "dsweb-group-ledger",
				children: t("ledger.title")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsweb-group-hint",
				children: t("ledger.hint")
			}),
			ledgerState === "unavailable" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsweb-banner dsweb-banner-warn",
				children: t("ledger.unavailable")
			}),
			ledgerState === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsweb-skeleton" }),
			ledgerState === "ready" && summary !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				totals !== void 0 && totals.total === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-banner",
					children: t("ledger.empty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsweb-stats",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
							label: t("ledger.total"),
							value: String(totals?.total ?? 0),
							t
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
							label: t("ledger.chat"),
							value: String(totals?.chat ?? 0),
							t
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
							label: t("ledger.failed"),
							value: String(totals?.failed ?? 0),
							t
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
							label: t("ledger.minGap"),
							value: formatDuration(intervals?.minMs ?? 0, t),
							t
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
							label: t("ledger.medianGap"),
							value: formatDuration(intervals?.medianMs ?? 0, t),
							t
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Stat, {
							label: t("ledger.p90Gap"),
							value: formatDuration(intervals?.p90Ms ?? 0, t),
							t
						})
					]
				}),
				tight && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-banner dsweb-banner-warn",
					children: t("ledger.tight")
				}),
				failures.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsweb-chips",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsweb-row-hint",
						children: t("ledger.failures")
					}), failures.map(([kind, count]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "dsweb-badge dsweb-badge-warn",
						children: [
							FAILURE_LABEL[kind]?.[t("ledger.lang") === "en" ? "en" : "zh"] ?? kind,
							" × ",
							count
						]
					}, kind))]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-row dsweb-row-wide",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsweb-row-text",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsweb-row-label",
							children: t("ledger.days")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsweb-row-hint",
							children: summary.days.length === 0 ? t("ledger.empty") : summary.days.map((day) => `${day.date}：${day.total}${t("ledger.perDay")}`).join(" · ")
						})]
					})
				})
			] }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsweb-row dsweb-row-wide",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsweb-row-text",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsweb-row-label",
						children: t("doctor.title")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dsweb-row-hint",
						children: t("doctor.hint")
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsweb-row-control",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsweb-button dsweb-button-secondary",
						disabled: doctorState === "loading",
						onClick: runDoctor,
						children: doctorState === "loading" ? t("doctor.running") : t("doctor.run")
					})
				})]
			}),
			doctorState === "unavailable" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsweb-banner dsweb-banner-warn",
				children: t("doctor.unavailable")
			}),
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
	});
}
function Stat({ label, value, t }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsweb-stat",
		title: label,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "dsweb-stat-value",
			children: value
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "dsweb-stat-label",
			children: label
		})]
	});
}

//#endregion
//#region src/client/settings-section.tsx
/** locale 命名空间；字典键与设置页文案一一对应。 */
const LOCALE_NAMESPACE = "dsh-deepseek-web";
/** `settings.section` 里的 section id。 */
const SECTION_ID = "deepseek-web";
/** 排序：账号 -10 / 通用 0 / 模型 10 / 插件 15 之后。 */
const SECTION_ORDER = 20;
/** 静态文案。 */
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
		"ledger.days": "按天",
		"ledger.perDay": " 次",
		"ledger.minutes": "{m} 分 {s} 秒",
		"doctor.title": "安装自检",
		"doctor.hint": "只报事实、不做修复。默认只跑静态检查（配置 / 浏览器 / 目录 / 构建标识），不会为了自检启动浏览器。",
		"doctor.run": "运行自检",
		"doctor.running": "自检中…",
		"doctor.unavailable": "自检接口不可用（同上：宿主没有 webServer 服务）。也可以在命令行运行 npm run doctor。",
		"doctor.ready": "Doctor result: ready（有 warning 但无 error）",
		"doctor.notReady": "Doctor result: not ready（存在 error，按上面的条目逐项排查）"
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
		"ledger.days": "Per day",
		"ledger.perDay": " calls",
		"ledger.minutes": "{m}m {s}s",
		"doctor.title": "Install self-check",
		"doctor.hint": "Reports facts only; it never fixes anything. Only static checks run by default (config / browser / directories / build id) — no browser is started for a self-check.",
		"doctor.run": "Run self-check",
		"doctor.running": "Checking…",
		"doctor.unavailable": "Self-check route unavailable (same reason: no webServer service). You can also run npm run doctor from a shell.",
		"doctor.ready": "Doctor result: ready (warnings allowed, no errors)",
		"doctor.notReady": "Doctor result: not ready (errors found — work through the items above)"
	}
};
/** 由字段规格派生的分组文案与字段文案，拼进两份字典。 */
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
/** 两份完整的 zh/en 字典；`ctx.locale.register` 要求两边键集合一致。 */
const LOCALE_DICTIONARIES = buildDictionaries();
const fallbackTranslate = (key) => key;
/** 空对象占位，保证 useMemo 依赖身份稳定。 */
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
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: SECTION_ID,
		order: SECTION_ORDER,
		label: () => t("nav"),
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
	const t = props.t ?? fallbackTranslate;
	if (props.form === void 0 || props.useSettingsForm === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsweb-settings",
		"data-dsweb-settings": "missing",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
			className: "dsweb-settings-title",
			children: t("title")
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "dsweb-banner dsweb-banner-warn",
			children: t("missingForm")
		})]
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsSectionBody, {
		form: props.form,
		useSettingsForm: props.useSettingsForm,
		t,
		reload: props.reload
	});
}
const STATUS_CLASS = {
	info: "dsweb-status",
	success: "dsweb-status dsweb-status-success",
	warn: "dsweb-status dsweb-status-warn",
	error: "dsweb-status dsweb-status-error"
};
/** 设置页主体：订阅宿主快照、维护草稿、原子保存。 */
function SettingsSectionBody({ form, useSettingsForm, t, reload }) {
	const snapshot = useSettingsForm((value) => value);
	const [draft, setDraft] = (0, react.useState)(null);
	const [listText, setListText] = (0, react.useState)({});
	const [busy, setBusy] = (0, react.useState)(false);
	const [notice, setNotice] = (0, react.useState)(null);
	const accepted = isRecord(snapshot.value) ? snapshot.value : EMPTY_OBJECT;
	const user = isRecord(snapshot.user) ? snapshot.user : EMPTY_OBJECT;
	const writable = snapshot.writable === true;
	const ready = snapshot.status === "ready";
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
	/** 草稿优先的「当前生效值」，供档位匹配用（草稿没碰过的字段取宿主值）。 */
	const effective = (0, react.useMemo)(() => {
		let merged = accepted;
		if (draft !== null) {
			for (const field of FIELDS) if (hasPath(draft, field.path)) merged = withEdit(merged, accepted, field.path, readPath(draft, field.path));
		}
		return merged;
	}, [draft, accepted]);
	/** 当前落在哪个风控档位；与任何档位都不全等即「自定义」。 */
	const riskTier = (0, react.useMemo)(() => matchRiskPreset(effective), [effective]);
	const dirty = (0, react.useMemo)(() => diffOps(draft, accepted, user), [
		draft,
		accepted,
		user
	]).length > 0;
	const blocked = errors.size > 0;
	const canSave = writable && !busy && dirty && !blocked;
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
	if (snapshot.status === "unavailable") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsweb-settings",
		"data-dsweb-settings": "unavailable",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
			className: "dsweb-settings-title",
			children: t("title")
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
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
		})]
	});
	if (!ready) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsweb-settings",
		"data-dsweb-settings": "loading",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
				className: "dsweb-settings-title",
				children: t("title")
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsweb-settings-intro",
				children: t("loading")
			})] }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsweb-skeleton" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsweb-skeleton" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsweb-skeleton" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsweb-skeleton" })
		]
	});
	const status = notice ?? (blocked ? {
		tone: "warn",
		text: t("invalid")
	} : dirty ? {
		tone: "info",
		text: t("dirty")
	} : {
		tone: "info",
		text: t("clean")
	});
	const actions = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsweb-actions",
		children: [
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
		]
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsweb-settings",
		"data-dsweb-settings": "ready",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
				className: "dsweb-settings-title",
				children: t("title")
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsweb-settings-intro",
				children: t("intro")
			})] }),
			!writable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsweb-banner dsweb-banner-warn",
				children: t("readonly")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsweb-settings-toolbar",
				children: [
					dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsweb-badge dsweb-badge-warn",
						children: t("dirty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsweb-badge",
						children: t("clean")
					}),
					blocked && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsweb-badge dsweb-badge-warn",
						children: t("invalid")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dsweb-settings-spacer" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsweb-badge",
						children: t("shortcut")
					}),
					actions
				]
			}),
			GROUPS.map((group) => {
				const fields = FIELDS.filter((field) => field.group === group.id);
				if (fields.length === 0) return null;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					className: "dsweb-group",
					"aria-labelledby": `dsweb-group-${group.id}`,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: "dsweb-group-title",
							id: `dsweb-group-${group.id}`,
							children: t(`group.${group.id}`)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsweb-group-hint",
							children: t(`group.${group.id}.hint`)
						}),
						group.id === "risk" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsweb-row dsweb-row-wide",
							"data-field": "risk-tier",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsweb-row-text",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsweb-row-label",
									children: t("riskTier")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsweb-row-hint",
									children: t("riskTierHint")
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsweb-row-control",
								style: {
									display: "flex",
									flexWrap: "wrap",
									gap: 8,
									justifyContent: "flex-end",
									alignItems: "center"
								},
								children: [RISK_PRESETS.map((preset) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: `dsweb-button ${riskTier === preset.id ? "dsweb-button-primary" : "dsweb-button-secondary"}`,
									disabled: !writable || busy,
									title: t(`risk.${preset.id}.hint`),
									onClick: () => applyTier(preset),
									children: t(`risk.${preset.id}`)
								}, preset.id)), riskTier === "custom" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsweb-badge dsweb-badge-warn",
									children: t("riskCustom")
								})]
							})]
						}),
						fields.map((field) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FieldRow, {
							field,
							value: valueOf(field),
							listText: listText[fieldKey(field)],
							error: errors.get(fieldKey(field)),
							overridden: hasPath(user, field.path),
							disabled: !writable || busy,
							t,
							onChange: (next) => edit(field, next),
							onChangeList: (raw) => editList(field, raw),
							onReset: () => {
								resetField(field);
							}
						}, fieldKey(field)))
					]
				}, group.id);
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LedgerCard, { t }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
				className: "dsweb-footer",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: STATUS_CLASS[status.tone],
					role: "status",
					"aria-live": "polite",
					children: status.text
				}), actions]
			})
		]
	});
}
/** 一行字段：左侧标题/说明/错误，右侧控件与「恢复默认」。 */
function FieldRow(props) {
	const { field, value, listText, error, overridden, disabled, t } = props;
	const domId = fieldDomId(field);
	const key = fieldKey(field);
	const wide = field.kind === "list" || field.kind === "text";
	const hint = field.hint === void 0 ? null : t(`field.${key}.hint`);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: `dsweb-row${wide ? " dsweb-row-wide" : ""}`,
		"data-field": key,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "dsweb-row-text",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: "dsweb-row-label",
					htmlFor: domId,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(`field.${key}`) }),
						field.restart === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsweb-badge dsweb-badge-info",
							children: t("restart")
						}),
						overridden && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsweb-badge",
							children: t("custom")
						})
					]
				}),
				hint !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dsweb-row-hint",
					children: hint
				}),
				error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dsweb-row-error",
					children: errorText(field, error, t)
				})
			]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "dsweb-row-control",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FieldControl, {
				field,
				value,
				listText,
				domId,
				invalid: error !== void 0,
				disabled,
				t,
				onChange: props.onChange,
				onChangeList: props.onChangeList
			}), overridden && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dsweb-link",
				disabled,
				onClick: props.onReset,
				children: t("reset")
			})]
		})]
	});
}
/** 按字段类型渲染控件。 */
function FieldControl(props) {
	const { field, value, listText, domId, invalid, disabled, t, onChange, onChangeList } = props;
	if (field.kind === "boolean") {
		const checked = value === true;
		return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
			id: domId,
			className: "dsweb-switch",
			type: "checkbox",
			role: "switch",
			"aria-checked": checked,
			disabled,
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
			disabled,
			value: selected,
			onChange: (event) => onChange(event.target.value === "" ? null : event.target.value),
			children: [selected === "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
				value: "",
				children: "—"
			}), rendered.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
				value: option,
				children: option
			}, option))]
		});
	}
	if (field.kind === "number") {
		const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value : "";
		return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
			id: domId,
			className: `dsweb-input${invalid ? " dsweb-input-invalid" : ""}`,
			type: "number",
			inputMode: "numeric",
			step: 1,
			min: field.min,
			max: field.max,
			disabled,
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
		className: "dsweb-textarea",
		rows: 4,
		spellCheck: false,
		placeholder: t("listPlaceholder"),
		disabled,
		value: listText ?? formatList(value),
		onChange: (event) => onChangeList(event.target.value)
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
		id: domId,
		className: "dsweb-input",
		type: "text",
		spellCheck: false,
		disabled,
		value: typeof value === "string" ? value : "",
		onChange: (event) => onChange(event.target.value)
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
	const timers = /* @__PURE__ */ new Set();
	/** sessionId → 事件源退订函数；只为当前持有 binding 的会话建立。 */
	const watched = /* @__PURE__ */ new Map();
	const conversationOf = (sessionId) => {
		try {
			return ctx.uiConversation.binding(sessionId);
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
			const binding = ctx.sessions.binding(sessionId);
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
		const ids = new Set(ctx.sessions.list.getSnapshot().ids);
		for (const [sessionId, unsubscribe] of [...watched]) {
			if (ids.has(sessionId)) continue;
			unsubscribe();
			watched.delete(sessionId);
		}
		for (const sessionId of ids) {
			if (watched.has(sessionId)) continue;
			const binding = ctx.sessions.binding(sessionId);
			if (binding === void 0) continue;
			watched.set(sessionId, binding.eventSource.subscribe(() => {
				schedule(() => ensureRendered(sessionId), FEED_CHECK_MS);
			}));
		}
	};
	ctx.effect(() => {
		const listUnsubscribe = ctx.sessions.list.subscribe(() => {
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
	ensureSettingsStyles();
	ctx.inject(["configForms", "locale"], (sub) => {
		registerSettingsSection(sub);
	});
	ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
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