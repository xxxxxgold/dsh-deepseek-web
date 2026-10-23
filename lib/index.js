import z from "@deepseek-ai/schemastery";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os, { homedir, tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import net from "node:net";
import { gunzipSync } from "node:zlib";

//#region src/web-models.ts
/**
* 网页版模型清单（Host 与 Client 半侧共享的最小事实表）。
* 独立于 config.ts：客户端 bundle 的纯净度门禁禁止把 schemastery 等配置层依赖打进浏览器产物。
*
* @module dsh-deepseek-web/web-models
*/
/**
* 网页版模型清单。DeepSeek 网页端已把极速/专家/识图合并为一个入口，
* 模式与联网开关由页面自身管理。两个 id 的差别在发送方式：
* - deepseek-web：半自动——填入消息后由用户人工点击发送
* - deepseek-web-auto：全自动——填入消息后模拟回车自动发送
*/
const WEB_MODEL_IDS = ["deepseek-web", "deepseek-web-auto"];
const WEB_MODEL_CAPABILITIES = {
	"deepseek-web": {
		thinking: true,
		search: true,
		label: "DeepSeek 网页版（半自动）"
	},
	"deepseek-web-auto": {
		thinking: true,
		search: true,
		label: "DeepSeek 网页版（全自动）"
	}
};

//#endregion
//#region src/config.ts
const PROVIDER = "deepseek-web";
/** 历史模型 id：旧会话仍可能引用，解析时映射回单一入口。 */
const LEGACY_WEB_MODEL_IDS = [
	"deepseek-web-chat",
	"deepseek-web-reasoner",
	"deepseek-web-search"
];
/** 把任意历史模型 id 归一到当前唯一入口；不认识时返回 undefined。 */
function normalizeWebModel(model) {
	if (WEB_MODEL_IDS.includes(model)) return model;
	if (LEGACY_WEB_MODEL_IDS.includes(model)) return "deepseek-web";
}
/**
* 兼容垫片：给 schema 打上 volatile 标记。
*
* `.volatile()` 需要 schemastery ≥ 3.18.4（`Schema.prototype.volatile` 就是
* `extra('volatile', true)`）。当模块解析到 3.18.2（本仓库 vendored 副本、
* 0.1.5 宿主的 node_modules）时该方法不存在，直接链式调用会在模块加载时
* 抛 `volatile is not a function`，插件整体无法启动。这里按可用性降级：
*
* 1. 原生 `.volatile()`（3.18.4+）：完整语义，运行期解析为 `Volatile<T>` 引用，
*    由 `liveConfig()` 在 `apply()` 边界透明化解引用；
* 2. `extra('volatile', true)`（3.18.2 也有）：只设置 `meta.volatile` 标记，
*    值保持普通对象——0.1.5 宿主没有 0.2 的 volatile 投影机制，普通值即正确行为。
*
* dsh 0.2 的设置服务用 `volatileForm()` 只保留 `schema.meta.volatile` 的叶子字段，
* 因此“表单可见的字段必须经本助手标记”这一约定与原生 `.volatile()` 一致。
*/
function markVolatile(schema$1) {
	if (typeof schema$1.volatile === "function") return schema$1.volatile();
	if (typeof schema$1.extra === "function") return schema$1.extra("volatile", true);
	schema$1.meta = {
		...schema$1.meta,
		volatile: true
	};
	return schema$1;
}
/**
* 插件配置 schema。
*
* ⚠️ **表单可见的字段必须经 `markVolatile()` 标记（见上）。**
*
* dsh 0.2 的设置服务在 `SettingsForms.describe()` 里用 `volatileForm()` 过滤字段
* （见 `@deepseek-ai/dsh-settings` 的 `lib/index.js`）：
*
* ```js
* function volatileForm(schema) {
*   if (schema.meta.volatile) return plainSchema(schema);   // 只有 volatile 叶子保留
*   if (schema.type === 'object') { ...递归... }            // 对象含存活子字段则保留
*   // 其余标量 / 数组 / union → undefined，被丢弃
* }
* ```
*
* 被丢弃的字段不会进入表单；若一个 entry 的字段全被丢弃，该 entry 连
* `settings.describe().namespaces` 都不出现，插件配置页拿到的 `form` 就是 `undefined`。
*
* **代价**：原生 `.volatile()` 标记的字段在运行期解析为引用对象（`Volatile<T>`），
* 真值要 `.get()`。本插件在 `apply()` 边界用 `liveConfig()` 的 Proxy 统一透明化，
* 因此内部代码仍按普通值读写，同时保留 Loader 的原地热更新语义。
* 降级路径（`extra` / meta 直标）没有引用对象，`liveConfig()` 原样放行普通值。
*
* 未标记的字段保持普通值，只受 fiber 重启影响；它们不出现在配置页里，
* 需要调整时改 profile 的 `cordis.patch.yml`。
*/
const schema = z.object({
	url: markVolatile(z.string().default("https://chat.deepseek.com")),
	browser: markVolatile(z.union(["managed", "attach"]).default("managed")),
	channel: markVolatile(z.union(["msedge", "chrome"]).default("msedge")),
	debugPort: markVolatile(z.number().step(1).min(1024).max(65535).default(9333)),
	autoStartKeeper: z.boolean().default(true),
	stateFile: z.string(),
	profileDir: markVolatile(z.string().default("")),
	sendMode: markVolatile(z.union(["manual", "approved"]).default("manual")),
	model: markVolatile(z.union([...WEB_MODEL_IDS]).default("deepseek-web")),
	selectors: z.dict(z.string()),
	streamIdleTimeoutMs: z.number().step(1).min(1).default(6e5),
	rateLimit: z.object({
		enabled: markVolatile(z.boolean().default(true)),
		retryDelayMs: markVolatile(z.number().step(1).min(1e3).default(6e4)),
		maxRetries: markVolatile(z.number().step(1).min(0).default(4)),
		backoff: markVolatile(z.union(["fixed", "exponential"]).default("exponential")),
		retryMaxDelayMs: markVolatile(z.number().step(1).min(1e3).default(3e5)),
		jitterRatio: markVolatile(z.number().step(.01).min(0).max(.5).default(.15)),
		accountCooldownMs: markVolatile(z.number().step(1).min(0).max(36e5).default(6e5))
	}).default({}),
	serverBusy: z.object({
		enabled: markVolatile(z.boolean().default(true)),
		retryDelayMs: markVolatile(z.number().step(1).min(1e3).default(15e3)),
		maxRetries: markVolatile(z.number().step(1).min(0).default(4)),
		backoff: markVolatile(z.union(["fixed", "exponential"]).default("exponential")),
		retryMaxDelayMs: markVolatile(z.number().step(1).min(1e3).default(12e4)),
		jitterRatio: markVolatile(z.number().step(.01).min(0).max(.5).default(.2))
	}).default({}),
	notify: z.object({
		enabled: markVolatile(z.boolean().default(true)),
		session: markVolatile(z.boolean().default(true)),
		review: markVolatile(z.boolean().default(true)),
		send: markVolatile(z.boolean().default(true)),
		receive: markVolatile(z.boolean().default(true)),
		errors: markVolatile(z.boolean().default(true)),
		browser: markVolatile(z.boolean().default(true))
	}).default({}),
	browserRecovery: z.object({
		enabled: markVolatile(z.boolean().default(true)),
		maxAttempts: markVolatile(z.number().step(1).min(0).max(5).default(2)),
		delayMs: markVolatile(z.number().step(1).min(0).max(6e4).default(2e3))
	}).default({}),
	liveThinking: markVolatile(z.boolean().default(false)),
	maxReplyBytes: z.number().step(1).min(1024).default(4 * 1024 * 1024),
	enableImageUpload: markVolatile(z.boolean().default(true)),
	maxImagesPerTurn: markVolatile(z.number().step(1).min(0).max(32).default(4)),
	uploadTimeoutMs: markVolatile(z.number().step(1).min(1e3).default(6e4)),
	uploadOnError: markVolatile(z.union(["fallback-text", "abort"]).default("fallback-text")),
	maxSessionPages: markVolatile(z.number().step(1).min(1).max(8).default(3)),
	turnTimeoutMs: z.number().step(1).min(0).default(9e5),
	lockLeaseMs: z.number().step(1).min(0).default(45e5),
	maxStreamMs: z.number().step(1).min(0).default(36e5),
	maxConcurrentTurns: markVolatile(z.number().step(1).min(0).max(64).default(1)),
	sendPauseMinMs: markVolatile(z.number().step(1).min(0).max(6e4).default(2e3)),
	sendPauseMaxMs: markVolatile(z.number().step(1).min(0).max(6e4).default(4e3)),
	turnGapMinMs: markVolatile(z.number().step(1).min(0).max(6e5).default(2e3)),
	turnGapMaxMs: markVolatile(z.number().step(1).min(0).max(6e5).default(4e3)),
	longRunAfterSends: markVolatile(z.number().step(1).min(0).max(1e4).default(15)),
	longRunPauseMinMs: markVolatile(z.number().step(1).min(0).max(36e5).default(3e4)),
	longRunPauseMaxMs: markVolatile(z.number().step(1).min(0).max(36e5).default(6e4)),
	protocolRefreshEvery: markVolatile(z.number().step(1).min(1).default(8)),
	protocolEveryRequest: markVolatile(z.boolean().default(false)),
	toolAllowlist: markVolatile(z.array(z.string()).default([
		"read",
		"write",
		"edit",
		"str_replace_editor",
		"glob",
		"grep",
		"bash",
		"pwsh",
		"todo_write"
	])),
	excludeToolNames: markVolatile(z.array(z.string()).default(["web_search"])),
	compactToolCatalog: z.boolean().default(true),
	maxToolResultChars: markVolatile(z.number().step(1).min(256).default(6e3)),
	maxToolCatalogChars: markVolatile(z.number().step(1).min(0).default(28e3)),
	maxGoalChars: z.number().step(1).min(64).default(2e3),
	maxReplayChars: z.number().step(1).min(0).default(4e5),
	loginProbe: z.object({
		enabled: markVolatile(z.boolean().default(true)),
		initialDelayMs: markVolatile(z.number().step(1).min(0).max(6e5).default(2e4)),
		intervalMs: markVolatile(z.number().step(1).min(0).max(864e5).default(18e5))
	}).default({}),
	focus: z.object({
		enabled: markVolatile(z.boolean().default(true)),
		webWindow: markVolatile(z.boolean().default(true)),
		dshWindow: markVolatile(z.boolean().default(true)),
		dshProcessNames: z.array(z.string()).default([
			"electron",
			"dsh",
			"DeepSeek Harness"
		]),
		dshTitlePattern: z.string().default("DeepSeek Harness|dsh")
	}).default({}),
	review: z.object({
		enabled: markVolatile(z.boolean().default(false)),
		provider: markVolatile(z.union([
			"kimi",
			"deepseek-web",
			"glm"
		]).default("kimi")),
		autoSend: markVolatile(z.boolean().default(true)),
		conversationMode: markVolatile(z.union(["fresh", "reuse"]).default("fresh")),
		sendVerifyMs: markVolatile(z.number().step(1).min(100).default(1500)),
		sendRetries: markVolatile(z.number().step(1).min(1).max(5).default(2)),
		fetchRetries: markVolatile(z.number().step(1).min(0).max(3).default(1)),
		kimiMode: markVolatile(z.union(["normal", "project"]).default("normal")),
		url: markVolatile(z.string().default("https://www.kimi.com/?chat_enter_method=new_chat")),
		projectUrl: markVolatile(z.string().default("")),
		debugPort: z.number().step(1).min(1024).max(65535).default(9334),
		profileDir: z.string(),
		streamIdleTimeoutMs: z.number().step(1).min(1).default(6e5),
		maxEvidenceChars: z.number().step(1).min(1e3).default(6e4),
		maxRounds: markVolatile(z.number().step(1).min(0).default(1)),
		glmUrl: z.string().default("https://chat.z.ai/"),
		glmDebugPort: z.number().step(1).min(1024).max(65535).default(9335),
		glmProfileDir: z.string()
	}).default({}),
	autoCorrectMalformed: z.boolean().default(true),
	compactionLanguage: markVolatile(z.union([
		"task",
		"host",
		"zh",
		"en"
	]).default("task")),
	delegatedTools: markVolatile(z.array(z.string()).default(["web_search", "web_fetch"]))
});
/**
* Loader 面向的 schema。标了 `.volatile()` 的字段在该类型里其实是 `Volatile<T>`；
* 这里断言成普通值形状，因为 `apply()` 边界会用 `liveConfig()` 把它还原成普通对象。
*/
const Config = schema;

//#endregion
//#region src/build-info.ts
const BUILD = "0.6.0+20261023T121553";
/** 本模块自身在磁盘上的绝对路径 —— 也就是宿主真正加载的那份产物。 */
const modulePath = fileURLToPath(import.meta.url);
/** 加载戳文件路径：%LOCALAPPDATA%\DshDeepSeekWeb\loaded-build.json（拿不到就用家目录）。 */
function stampPath() {
	return join(process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"), "DshDeepSeekWeb", "loaded-build.json");
}
/**
* 记录「本次加载」的构建身份，供重启后核对。
*
* @returns 写入的绝对路径；失败时返回 undefined（调用方不需要关心错误）。
*/
function writeLoadStamp() {
	const file = stampPath();
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify({
			build: BUILD,
			module: modulePath,
			pid: process.pid,
			at: (/* @__PURE__ */ new Date()).toISOString()
		}, null, 2)}\n`, "utf8");
		return file;
	} catch {
		return;
	}
}

//#endregion
//#region src/live-config.ts
/** 是否是一个 schemastery volatile 引用。 */
function isVolatileRef(value) {
	return typeof value === "object" && value !== null && typeof value.get === "function";
}
/**
* 返回一个按普通值读取的配置视图。
*
* @param value - Loader 传入的配置（含 volatile 引用）。
* @returns 读取时自动解引用的等价配置。
*/
function liveConfig(value) {
	if (isVolatileRef(value)) return liveConfig(value.get());
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value;
	return new Proxy(value, { get(target, key, receiver) {
		return liveConfig(Reflect.get(target, key, receiver));
	} });
}

//#endregion
//#region src/response.ts
/** 只拦截明显的未完成交接文本；用户要求摘要/分析时允许正常输出。 */
function looksLikeUnfinishedHandoff(text, task) {
	if (!task || /总结|摘要|交接|分析|解释|summari[sz]e|summary|handoff|analy[sz]e|explain/i.test(task)) return false;
	return [
		/(?:^|\n)\s*-\s*User asked\b/i,
		/(?:^|\n)\s*-\s*User wants\b/i,
		/(?:^|\n)\s*-\s*Prior assistant\b/i,
		/(?:^|\n)\s*##\s*Primary Request and Intent\b/i,
		/(?:^|\n)\s*##\s*(?:Pending Jobs|Current Work|Next Step)\b/i
	].filter((pattern) => pattern.test(text)).length >= 3 && /NOT yet|not yet|pending|尚未|待办|未完成/i.test(text);
}
const DESTRUCTIVE_COMMAND_PATTERNS = [
	[/(?:^|[;&|]\s*)rm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(?:\/|~|\$HOME)/i, "疑似递归删除根目录/家目录"],
	[/Remove-Item\b[^\n]*-Recurse[^\n]*(?:[A-Za-z]:\\|\$env:USERPROFILE|\$HOME|~)[^\n]*$/im, "疑似递归删除系统盘/家目录"],
	[/\b(?:mkfs(?:\.[a-z0-9]+)?|diskpart)\b/i, "疑似磁盘格式化操作"],
	[/\bformat\s+[A-Za-z]:/i, "疑似磁盘格式化操作"],
	[/\bshutdown\s+\/[sr]\b/i, "疑似关机/重启操作"]
];
/** 常见参数别名：模型有时用 path/text/cmd 等写法，执行前归一为 schema 的规范名。 */
const PARAM_ALIASES = {
	file_path: [
		"file_path",
		"filepath",
		"filePath",
		"file",
		"path",
		"filename",
		"target",
		"target_path"
	],
	content: [
		"content",
		"contents",
		"text",
		"code",
		"body",
		"data",
		"source"
	],
	command: [
		"command",
		"cmd",
		"script",
		"shell",
		"command_line"
	],
	description: [
		"description",
		"desc",
		"summary",
		"reason",
		"note",
		"purpose"
	],
	pattern: [
		"pattern",
		"glob",
		"glob_pattern",
		"query"
	],
	old_str: [
		"old_str",
		"old_string",
		"old",
		"oldText"
	],
	new_str: [
		"new_str",
		"new_string",
		"new",
		"newText"
	]
};
/** 按 schema 必填名做别名替换，返回修复后的参数对象。 */
function repairParams(params, schema$1) {
	const required = Array.isArray(schema$1.parameters?.required) ? schema$1.parameters.required.filter((item) => typeof item === "string") : [];
	const repaired = { ...params };
	for (const name$1 of required) {
		if (name$1 in repaired) continue;
		for (const alias of PARAM_ALIASES[name$1] ?? [name$1]) {
			if (alias === name$1 || !(alias in repaired)) continue;
			repaired[name$1] = repaired[alias];
			delete repaired[alias];
			break;
		}
	}
	return repaired;
}
/**
* 参数别名修复 + 校验。返回可直接执行的动作列表与剩余问题。
*/
function repairAndValidateActions(actions, allowedToolNames, toolSchemas) {
	const repairedActions = actions.map((action) => {
		const tool = action.tool ?? action.action;
		const schema$1 = tool ? toolSchemas?.get(tool) : void 0;
		const params = action.params ?? action.arguments;
		if (!schema$1 || !params || typeof params !== "object" || Array.isArray(params)) return action;
		return {
			...action,
			params: repairParams(params, schema$1)
		};
	});
	return {
		actions: repairedActions,
		problems: validateActions(repairedActions, allowedToolNames, toolSchemas)
	};
}
/**
* 执行前的确定性审查：工具必须在本轮可见清单里、参数必须是对象、
* 明显破坏性的命令直接拒绝。返回空数组表示通过。
*/
function validateActions(actions, allowedToolNames, toolSchemas) {
	const problems = [];
	actions.forEach((action, index) => {
		const tool = action.tool ?? action.action;
		if (!tool) {
			problems.push({
				index,
				problem: "缺少 tool 字段"
			});
			return;
		}
		if (!allowedToolNames.has(tool)) problems.push({
			index,
			tool,
			problem: `工具 "${tool}" 不在本轮可用工具清单中`
		});
		const params = action.params ?? action.arguments;
		if (params !== void 0 && (typeof params !== "object" || params === null || Array.isArray(params))) {
			problems.push({
				index,
				tool,
				problem: "arguments 必须是 JSON 对象"
			});
			return;
		}
		const schema$1 = tool ? toolSchemas?.get(tool) : void 0;
		if (schema$1) {
			const parameters = schema$1.parameters ?? {};
			const required = Array.isArray(parameters.required) ? parameters.required.filter((item) => typeof item === "string") : [];
			const present = params ?? {};
			const missing = required.filter((name$1) => !(name$1 in present));
			if (missing.length > 0) problems.push({
				index,
				tool,
				problem: `缺少必填参数 ${missing.map((name$1) => `"${name$1}"`).join("、")}`
			});
			const properties = parameters.properties;
			if (properties && typeof properties === "object") for (const [name$1, rawSpec] of Object.entries(properties)) {
				if (!(name$1 in present)) continue;
				const expected = rawSpec && typeof rawSpec === "object" ? rawSpec.type : void 0;
				if (typeof expected !== "string") continue;
				const value = present[name$1];
				const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
				if (!(expected === "integer" ? actual === "number" && Number.isInteger(value) : actual === expected)) problems.push({
					index,
					tool,
					problem: `参数 "${name$1}" 类型应为 ${expected}，实际是 ${actual}`
				});
			}
		}
		const text = JSON.stringify(params ?? {});
		for (const [pattern, reason] of DESTRUCTIVE_COMMAND_PATTERNS) if (pattern.test(text)) {
			problems.push({
				index,
				tool,
				problem: reason
			});
			break;
		}
	});
	return problems;
}
/** 剥掉 ```json ... ``` 以及模型可能带上的前后缀，找到最靠后的 JSON 对象。 */
function extractJsonObject(text) {
	let candidate = text.trim();
	const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
	if (fenced) candidate = fenced[1].trim();
	for (let start = candidate.indexOf("{"); start >= 0; start = candidate.indexOf("{", start + 1)) {
		let depth = 0;
		let inString = false;
		let escape = false;
		for (let i = start; i < candidate.length; i++) {
			const ch = candidate[i];
			if (inString) {
				if (escape) escape = false;
				else if (ch === "\\") escape = true;
				else if (ch === "\"") inString = false;
				continue;
			}
			if (ch === "\"") inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) try {
					return JSON.parse(candidate.slice(start, i + 1));
				} catch {
					break;
				}
			}
		}
	}
}
function normalizeParams(action) {
	return action.params ?? action.arguments ?? {};
}
/** DeepSeek 偶发忽略 JSON 协议，返回原生 DSML；必须完整匹配，禁止执行半截调用。 */
function parseDsml(text) {
	const calls = text.replace(/^```(?:xml|dsml)?\s*([\s\S]*?)```$/i, "$1").trim().match(/^<｜｜DSML｜｜\s+calls>\s*([\s\S]*?)\s*<\/｜｜DSML｜｜\s+calls>$/);
	if (!calls) return void 0;
	let rest = calls[1].trim();
	const actions = [];
	while (rest) {
		const invoke = rest.match(/^<｜｜DSML｜｜\s+invoke\s+name="([^"]+)">\s*([\s\S]*?)<\/｜｜DSML｜｜\s+invoke>/);
		if (!invoke) return void 0;
		let parameters = invoke[2].trim();
		const params = Object.create(null);
		while (parameters) {
			const parameter = parameters.match(/^<｜｜DSML｜｜\s+parameter\s+name="([^"]+)"\s+string="(true|false)">([\s\S]*?)<\/｜｜DSML｜｜\s+parameter>/);
			if (!parameter || Object.hasOwn(params, parameter[1])) return void 0;
			try {
				params[parameter[1]] = parameter[2] === "true" ? parameter[3] : JSON.parse(parameter[3]);
			} catch {
				return;
			}
			parameters = parameters.slice(parameter[0].length).trim();
		}
		actions.push({
			tool: invoke[1],
			params
		});
		rest = rest.slice(invoke[0].length).trim();
	}
	return actions.length ? actions : void 0;
}
function parseWebReply(text) {
	const trimmed = text.trim();
	if (/<\/?[｜|]{2}DSML[｜|]{2}/.test(trimmed)) {
		const actions = parseDsml(trimmed);
		return {
			hasActions: !!actions,
			actions: actions ?? [],
			text: trimmed
		};
	}
	const parsed = extractJsonObject(trimmed);
	if (parsed && typeof parsed === "object") {
		const obj = parsed;
		const rawActions = obj.actions ?? obj.action;
		const actions = [];
		if (Array.isArray(rawActions)) for (const item of rawActions) {
			if (typeof item !== "object" || item === null || Array.isArray(item)) return {
				hasActions: false,
				actions: [],
				text: trimmed
			};
			actions.push(item);
		}
		else if (typeof rawActions === "object" && rawActions !== null) actions.push(rawActions);
		if (actions.length > 0) return {
			hasActions: true,
			actions: actions.map((a) => ({
				...a,
				tool: a.tool ?? a.action,
				params: normalizeParams(a)
			})),
			text: trimmed
		};
		if (typeof obj.action === "string" || typeof obj.tool === "string") {
			const single = obj;
			return {
				hasActions: true,
				actions: [{
					...single,
					tool: single.tool ?? single.action,
					params: normalizeParams(single)
				}],
				text: trimmed
			};
		}
	}
	return {
		hasActions: false,
		actions: [],
		text: trimmed
	};
}
/**
* 判断一段“没有解析出动作”的回复是否明显是想调用工具但格式坏了：
* 空回复、完整回复中的动作信封或原生 DSML 标签。
*/
function looksLikeIntendedToolReply(text) {
	const trimmed = text.trim();
	if (trimmed.length === 0) return true;
	if (/<\/?[｜|]{2}DSML[｜|]{2}/.test(trimmed)) return true;
	const candidate = trimmed.replace(/^```(?:json)?\s*([\s\S]*?)(?:```)?$/i, "$1").trim();
	if (/^\{\s*["']?(?:actions|tool|action)["']?\s*:/i.test(candidate)) return true;
	return false;
}
/** 模型明明有工具可用，却声称“没有工具/无法访问本地”时视为拒绝型漂移。 */
function looksLikeToolDenial(text) {
	return /无法访问|不能访问|无权访问|无法读取|没有(?:任何)?(?:本地)?(?:文件)?工具|工具(?:不可用|不存在)|没有实际工具|I (?:can't|cannot|do not|don't) (?:access|read)|no (?:local )?(?:file )?access|no tools (?:available|provided)/i.test(text);
}
/** 模型反问“请提供任务”时视为会话上下文丢失，需要一次性恢复协议与任务锚点。 */
function looksLikeTaskRequest(text) {
	return /请(?:提供|告诉|说明|发送|描述).{0,12}(?:任务|需求|要求|要做什么)|没有(?:收到|看到|收到具体的).{0,8}任务|未(?:提供|收到).{0,8}任务|what (?:task|would you like|do you want)|provide .{0,20}task|please (?:tell|provide|send).{0,20}task/i.test(text);
}
/**
* 把解析结果转成 Harness StreamChunk 序列。
* 顺序：文本块 → 若干 tool-call 块 → finish。
*
* `startIndex` 是本条助手消息内第一个空闲内容块序号：同一消息里若已经
* 流式输出过 reasoning（实时思考流）块，正文块要从更高的序号开始，
* 避免与已有块冲突。`nextCallId` 控制工具调用 id 的起始编号。
*/
function* replyChunks(reply, options = {}) {
	const startIndex = options.startIndex ?? 0;
	let nextCallId = options.nextCallId ?? 1;
	const blocks = [];
	let textBlock;
	if (!reply.hasActions && reply.text.length > 0) {
		textBlock = {
			type: "text",
			text: reply.text
		};
		blocks.push(textBlock);
	}
	let index = startIndex;
	if (textBlock) {
		yield {
			type: "block-start",
			index,
			blockType: "text"
		};
		yield {
			type: "text-delta",
			index,
			text: reply.text
		};
		yield {
			type: "block-end",
			index,
			block: textBlock
		};
		index++;
	}
	const toolCalls = [];
	for (const action of reply.actions) {
		if (!action.tool) continue;
		const id = `web-${nextCallId++}`;
		const argumentsJson = JSON.stringify(action.params ?? {});
		const block = {
			type: "tool-call",
			id,
			name: action.tool,
			arguments: argumentsJson
		};
		toolCalls.push(block);
		yield {
			type: "block-start",
			index,
			blockType: "tool-call"
		};
		yield {
			type: "tool-call-delta",
			index,
			id,
			name: action.tool,
			argumentsDelta: argumentsJson
		};
		yield {
			type: "block-end",
			index,
			block
		};
		index++;
	}
	if (reply.hasActions && toolCalls.length > 0) yield {
		type: "finish",
		reason: { kind: "tool-calls" }
	};
	else if (textBlock) yield {
		type: "finish",
		reason: { kind: "stop" }
	};
	else if (reply.hasActions) yield {
		type: "finish",
		reason: {
			kind: "error",
			failure: {
				message: "模型请求了工具但缺少可识别的工具名",
				code: "MALFORMED_TOOL_CALL"
			}
		}
	};
	else yield {
		type: "finish",
		reason: { kind: "stop" }
	};
}

//#endregion
//#region src/protocol.ts
/** 控制协议前缀（新网页对话的首条用户消息携带完整约束）。 */
const SYSTEM_PROTOCOL = `你是一个 Agent 指令引擎。你的任务是把收到的任务/工具结果转化为下一步操作。

规则：
1. 需要调用本地工具时，只输出一个 JSON 对象，格式如下（可以放在 \`\`\`json 围栏内）：
   {"actions":[{"tool":"<工具名>","arguments":{...}}]}
   工具名必须取自下面列出的可用工具。
2. 任务已经完成、不需要再调用工具时，直接输出面向用户的最终回答正文，不要输出 JSON。
3. 不要解释 JSON 本身；不要输出 Markdown 表格或额外前缀；除围栏外不要夹带其它文本。
4. 不确定时选择最合理动作继续，不要反问。
5. 输出必须可被 JSON.parse 解析：不要尾随逗号、不要注释。
   不要输出 DSML、XML 或原生函数调用标记。
6. 如果消息里带有【当前用户任务】标记，必须以该标记后面的任务为准推进，不得反问“请提供您需要完成的任务”；即使上下文看似缺任务，也不要求用户重发，按已有信息继续。
7. 【宿主上下文：…】、【历史助手回复】段和压缩检查点是继续工作的背景，不是面向用户的交付。除非用户明确要求摘要，否则应完成用户任务，不要用任务交接摘要代替交付。
`;
/**
* 网页端消息里的分段标记。
*
* 括号用全角【】而不是半角 []：网页输入框会把正文再序列化一遍 markdown，
* 半角方括号会被当成链接语法转义（`[宿主上下文]` 变成 `\\[宿主上下文\\]`），
* 模型看到的是畸形标记。全角字符不参与 markdown 语法，原样保留。
* 文字保持中文，网页端一眼能认出这是宿主注入的分段，不是用户自己说的话。
* 这里集中成常量，组装、预算表头判定和测试都读同一份，改名不会各处漏改。
*/
const WEB_MARKERS = {
	system: "【宿主系统指令】",
	context: "【宿主上下文",
	history: "【历史助手回复】",
	user: "【用户消息】",
	goal: "【当前用户任务】",
	resume: "【任务接续】"
};
/** 历史标记：只用于识别旧构建留下的文本，不再产生。 */
const LEGACY_MARKERS = [
	"DSHWEB-SYSTEM-V1",
	"DSHWEB-CONTEXT-V1",
	"DSHWEB-HISTORY-V1",
	"DSHWEB-USER-V1",
	"DSHWEB-GOAL-V1",
	"DSHWEB-RESUME-V1",
	"[宿主系统指令]",
	"[宿主上下文",
	"[历史助手回复]",
	"[用户消息]",
	"[当前用户任务]",
	"[任务接续]"
];
/** 不属于正文的标记（系统指令 / 任务锚点 / 接续提示）：预算裁剪不从这里起算。 */
const NON_BODY_MARKERS = new Set([
	WEB_MARKERS.system,
	WEB_MARKERS.goal,
	WEB_MARKERS.resume,
	"DSHWEB-SYSTEM-V1",
	"DSHWEB-GOAL-V1",
	"DSHWEB-RESUME-V1",
	"[宿主系统指令]",
	"[当前用户任务]",
	"[任务接续]"
]);
/** 这一段是不是「正文」（历史/用户消息/宿主上下文）：预算裁剪只从这里开始算。 */
function isBodyPiece(piece) {
	if (piece.startsWith(`${WEB_MARKERS.history}\n`) || piece.startsWith(`${WEB_MARKERS.user}\n`)) return true;
	if (piece.startsWith(`${WEB_MARKERS.context}：`) || piece.startsWith(`${WEB_MARKERS.context}】`)) return true;
	return LEGACY_MARKERS.some((marker) => !NON_BODY_MARKERS.has(marker) && piece.startsWith(marker));
}
/** 图片直传开启时追加的第 8 条：附图真的随消息到达，模型可以直接看。 */
const IMAGE_RULE_ENABLED = `8. 消息中的 [附图: 文件名] 表示随本条消息一起发送的真实图片附件，你可以直接查看其内容；
   不要尝试用工具打开它，也不要把文件名当作可访问路径。若图片内容与文本描述冲突，以图片为准。`;
/**
* 图片直传关闭时追加的第 8 条：明确告诉模型看不到图，禁止凭空编造。
* 否则模型看到 `[附图: xxx.png]` 会以为自己能看到，凭文件名瞎猜内容。
*/
const IMAGE_RULE_DISABLED = `8. 消息中的 [附图: 文件名] 只是占位标记：那条消息确实带了图片，但你看不到图片内容。
   需要图片信息时请调用可用工具（OCR/读图）获取；不要凭空描述或猜测图片里有什么。`;
/**
* 按图片直传开关返回本轮实际注入的控制协议。
*
* 第 8 条随开关切换：开启时告诉模型"图真的到了、直接看"，关闭时告诉它
* "图没到、别猜"。两种模式共用同一套渲染逻辑，只有这一句不同。
*/
function systemProtocolFor(imageUploadEnabled) {
	const rule = imageUploadEnabled ? IMAGE_RULE_ENABLED : IMAGE_RULE_DISABLED;
	return SYSTEM_PROTOCOL.replace(/\n$/, `\n${rule}\n`);
}
/**
* 剥掉文本开头的控制协议（含图片规则），供"轮换新对话后重发"时复用正文。
* 三种形态都认：图片直传开启、关闭，以及历史版本里没有图片规则的协议。
*/
function stripProtocolPrefix(text) {
	for (const protocol of [
		systemProtocolFor(true),
		systemProtocolFor(false),
		SYSTEM_PROTOCOL
	]) if (text.startsWith(protocol)) return text.slice(protocol.length).replace(/^(?:\r?\n)+/, "");
	return text;
}
/** 模型上一条输出疑似想调用工具、但无法解析时使用的纠错消息。 */
const FORMAT_CORRECTION_PROMPT = `[系统纠错] 你上一条回复没有给出可解析的动作指令。

如果下一步需要调用本地工具：请只输出一个合法 JSON 对象，格式为 {"actions":[{"tool":"<工具名>","arguments":{...}}]}，不要夹带解释。
如果任务已经完成：请直接输出面向用户的最终回答正文，不要输出 JSON。

重要：本地工具由外部执行引擎提供并真实可用。你不需要真正访问文件系统，
只需用 JSON 描述要调用的工具与参数即可；不要声称“无法访问本地文件”或“没有工具”。

请重新输出。`;
/** 取第一句描述，控制精简目录长度。 */
function firstSentence(text) {
	const sentence = text.split(/(?<=[。！？.!?])\s*/u)[0] ?? text;
	return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}
/** 从 JSON Schema 里取必填参数名。 */
function requiredParamNames(parameters) {
	const required = parameters.required;
	if (!Array.isArray(required)) return [];
	return required.filter((item) => typeof item === "string").slice(0, 8);
}
function toolSchemaText(tool, compact) {
	if (!compact) return `- ${tool.name}${tool.description ? `：${tool.description}` : ""}${tool.parameters ? `\n  参数: ${JSON.stringify(tool.parameters)}` : ""}`;
	const required = requiredParamNames(tool.parameters ?? {});
	return `- ${tool.name}：${firstSentence(tool.description ?? "")}${required.length > 0 ? `（必填: ${required.join(", ")}）` : ""}`;
}
/**
* 工具目录的字符预算（默认 28,000，0 表示不限制）。
*
* 为什么要有这层预算：目录是每轮都随协议整段下发的，工具多、`compactToolCatalog`
* 又关掉时（每工具附完整 JSON Schema）能轻松涨到十几万字符——既吃网页输入框的
* 填字时间（接近二次方增长），也把真实任务挤掉。竞品实测过：0.1.33 之前那版只有
* 2.4 万字符预算，61 个工具被**静默**砍掉 26 个，模型不知道有这些工具，表现成
* 「模型不会用工具」而不是「插件漏了工具」。所以这里超预算时必须报出名字。
*/
const DEFAULT_MAX_TOOL_CATALOG_CHARS = 28e3;
/**
* 按预算构建工具目录，并**显式列出被省略的工具名**。
*
* 取舍顺序是「先保前面的」：`toolAllowlist` 的顺序就是用户的优先级意图，
* 因此不按名字长度重排——重排会让同一份配置在不同轮次产生不同目录，
* 白白破坏网页端的前缀缓存。
*
* 实现上不能边加边算：省略名单本身也会占长度，越砍越长。所以先算出每行的
* 文本，再从「全都要」往下试到第一个放得下的切分点——这样最终长度是真测出来的，
* 不是估出来的（估错就会像上一版那样，收尾时超出预算 188 字符）。
*/
function buildToolCatalogDetailed(tools, compact = true, maxChars = DEFAULT_MAX_TOOL_CATALOG_CHARS) {
	if (!tools || tools.length === 0) return {
		text: "",
		included: [],
		omitted: []
	};
	const header$1 = "可用工具：";
	const lines = tools.map((tool) => toolSchemaText(tool, compact));
	const names = tools.map((tool) => tool.name);
	const noticeFor = (omittedNames) => omittedNames.length === 0 ? "" : `\n（另有 ${omittedNames.length} 个工具因目录长度上限未列出：${omittedNames.join("、")}。需要时请先说明要用的工具名，不要猜参数。）`;
	const build = (keep) => {
		const body = keep === 0 ? header$1 : `${header$1}\n${lines.slice(0, keep).join("\n")}`;
		const omitted = names.slice(keep);
		return {
			text: body + noticeFor(omitted),
			included: names.slice(0, keep),
			omitted
		};
	};
	const limit = maxChars > 0 ? maxChars : Number.POSITIVE_INFINITY;
	for (let keep = names.length; keep >= 1; keep--) {
		const candidate = build(keep);
		if (candidate.text.length <= limit) return candidate;
	}
	return build(1);
}
function buildToolCatalog(tools, compact = true, maxChars = DEFAULT_MAX_TOOL_CATALOG_CHARS) {
	return buildToolCatalogDetailed(tools, compact, maxChars).text;
}
function shouldRefreshProtocol(state, config) {
	return state.roundsSinceProtocol >= config.protocolRefreshEvery;
}
function needsProtocolNow(state, config) {
	return config.protocolEveryRequest || !state.initialized || shouldRefreshProtocol(state, config);
}
/**
* 由 Harness 的一条内容块得到可安全送入网页的文本。
* 图片/文件降级为占位标记：图片直传开启时标记与真实附件并存（附件由
* `renderNewWebMessages` 单独收集），关闭时标记就是模型能看到的全部信息。
*
* 工具结果自 dsh 0.2 起是独立的消息角色（`role: 'tool'`），不再是内容块，
* 因此这里没有 `tool-result` 分支；对未知块保持兜底文本。
*/
function blockToText(block) {
	switch (block.type) {
		case "text":
		case "reasoning": return block.text;
		case "image": return `[附图: ${block.attachment.name ?? `图片-${block.attachment.attachmentId.slice(-8)}`}]`;
		case "file": return `[文件附件 ${block.attachment.attachmentId}: ${block.attachment.name}]`;
		case "tool-call": return `[请求调用工具 ${block.name}]`;
		case "tool-addition": return `[启用工具 ${block.toolName}]`;
		case "tool-removal": return `[停用工具 ${block.toolName}]`;
		default: {
			const nested = block.content;
			if (Array.isArray(nested)) return nested.map((item) => blockToText(item)).join("\n");
			return "[未知内容]";
		}
	}
}
function clampToolResult(text, maxChars) {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * .7);
	const tail = maxChars - head;
	return `${text.slice(0, head)}\n…（工具输出过长，已截断 ${text.length - maxChars} 字符）…\n${text.slice(-tail)}`;
}
/**
* 一条工具结果送入网页模型时的文本形态。
*
* 参数用结构类型而非具体消息类型，因为工具结果在不同 dsh 版本里形状不同：
* 0.2 起是 `role: 'tool'` 的 `ToolResultMessage`，0.1 时是 `role: 'user'`
* 且 `source.kind === 'tool'` 的消息。两者都只有 `content` 与 `isError` 参与渲染。
*
* @param assistantCall - 触发本次结果的上一条 assistant 工具调用块，用于标注工具名与参数。
* @param message - 承载结果的工具结果消息。
* @param maxChars - 送入网页的最大字符数，超出按头尾截断。
* @returns 可直接并入网页提示词的结果段落。
*/
function toolResultToWebMessage(assistantCall, message, maxChars = 6e3) {
	const callName = assistantCall?.type === "tool-call" ? assistantCall.name : void 0;
	const callArgs = assistantCall?.type === "tool-call" ? assistantCall.arguments : void 0;
	const body = clampToolResult(message.content.map((block) => blockToText(block)).join("\n"), maxChars);
	return `${callName ? `工具 ${callName} 的执行结果` : "工具执行结果"}${message.isError === true ? "（执行失败）" : ""}${callArgs ? `（参数: ${callArgs.slice(0, 800)}）` : ""}：\n${body}`;
}
function clampGoal(text, maxChars) {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…（任务描述过长，已截断）`;
}
/**
* 一次性恢复提示：上下文疑似丢失（反问任务、格式漂移、拒绝执行）时，
* 重新注入完整协议 + 精简工具目录 + 任务锚点。
*/
function buildRecoveryPrompt(options, state, config) {
	const catalog = buildToolCatalog(visibleToolsOf(options, config), config.compactToolCatalog, config.maxToolCatalogChars);
	const anchor = state.goalText ? `${WEB_MARKERS.goal}\n${clampGoal(state.goalText, config.maxGoalChars)}` : "";
	return [
		systemProtocolFor(config.enableImageUpload),
		catalog && `当前任务上下文可用的工具：\n${catalog}`,
		anchor,
		FORMAT_CORRECTION_PROMPT
	].filter(Boolean).join("\n\n");
}
/** 按白名单/排除名单筛选网页模型可见的工具；委托工具不进入本地执行集合，只出现在提示词目录里。 */
function visibleToolsOf(options, config) {
	const allow = new Set(config.toolAllowlist);
	const exclude = new Set(config.excludeToolNames);
	const delegated = new Set(config.delegatedTools);
	const matches = (set, name$1) => {
		if (set.size === 0) return false;
		if (set.has(name$1)) return true;
		for (const item of set) if (item.endsWith("*") && name$1.startsWith(item.slice(0, -1))) return true;
		return false;
	};
	return (options.tools ?? []).filter((tool) => (allow.size === 0 || matches(allow, tool.name)) && !matches(exclude, tool.name) && !delegated.has(tool.name));
}
/** 委托工具的目录说明：告诉网页模型调用会被转交它自带能力执行。 */
const DELEGATED_CATALOG_LINES = {
	web_search: "需要最新网络信息时调用；调用后系统会把查询转交你自带的联网搜索，请在下一轮按提示给出带来源的要点。",
	web_fetch: "需要读取指定网页内容时调用；调用后系统会转交你自带的网页浏览能力，请在下一轮给出要点总结。"
};
/** 组装委托工具的目录段；空集合返回空串。 */
function buildDelegatedCatalog(delegated) {
	if (delegated.length === 0) return "";
	return `网页委托工具（声明调用后由你的网页能力代为执行）：\n${delegated.map((name$1) => `- ${name$1}：${DELEGATED_CATALOG_LINES[name$1] ?? "调用后由网页端自带能力代执行，请在下一轮按提示给出结果。"}`).join("\n")}`;
}
function firstString(args, keys) {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
}
/** 任务简报的单节最大字符数（按节截断，防止简报把新对话首轮撑爆）。 */
const HANDOFF_SECTION_MAX = 500;
/** 截断单行文本：超长按省略号收尾。 */
function clampHandoff(text, max = HANDOFF_SECTION_MAX) {
	const trimmed = text.replace(/\s+/gu, " ").trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}
/** 解析 todo_write 最后一次调用的待办清单（兼容常见字段命名）。 */
function parseTodos(argsJson) {
	if (!argsJson) return [];
	try {
		const parsed = JSON.parse(argsJson);
		const list = Array.isArray(parsed.todos) ? parsed.todos : Array.isArray(parsed.items) ? parsed.items : [];
		const todos = [];
		for (const item of list) {
			if (!item || typeof item !== "object") continue;
			const record = item;
			const content = typeof record.content === "string" ? record.content : typeof record.title === "string" ? record.title : typeof record.text === "string" ? record.text : "";
			if (!content) continue;
			const rawStatus = typeof record.status === "string" ? record.status : typeof record.state === "string" ? record.state : "pending";
			const status = /complete|done|finished/i.test(rawStatus) ? "completed" : /progress|active|current|doing/i.test(rawStatus) ? "in_progress" : "pending";
			todos.push({
				content,
				status
			});
		}
		return todos;
	} catch {
		return [];
	}
}
/**
* 构建轮换新对话时的任务简报：从 Harness 会话日志（options.messages）提取
* 原始任务、已完成事项、当前进度与最近工具结果，让接续对话无需用户重新解释。
*/
function buildHandoffBrief(options, state) {
	const messages = options.messages;
	let originalTask = "";
	let latestTask = "";
	let lastAssistantText = "";
	let pendingCall;
	const filesTouched = [];
	const recentResults = [];
	let todos = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "tool-call") {
					pendingCall = block.name;
					if (block.name === "todo_write") todos = parseTodos(block.arguments);
					if (/^(write|edit|str_replace_editor)$/.test(block.name)) try {
						const args = JSON.parse(block.arguments);
						const filePath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : void 0;
						if (filePath && !filesTouched.includes(filePath)) filesTouched.push(filePath);
					} catch {}
				}
				if (block.type === "text" && block.text.trim()) lastAssistantText = block.text.trim();
			}
			continue;
		}
		if (message.role === "tool" || message.role === "user" && message.source?.kind === "tool") {
			const output = clampHandoff(message.content.map((block) => blockToText(block)).join("\n"), 160);
			recentResults.push(`${pendingCall ?? "tool"}: ${output}`);
			if (recentResults.length > 3) recentResults.shift();
			continue;
		}
		if (message.role === "user" && message.source?.kind === "user") {
			const text = message.content.map(blockToText).join("\n").replace(/\s+/gu, " ").trim();
			if (!text) continue;
			if (!originalTask) originalTask = text;
			latestTask = text;
		}
	}
	if (!latestTask && state.goalText) latestTask = state.goalText;
	const completed = todos.filter((item) => item.status === "completed").map((item) => clampHandoff(item.content, 160));
	const inProgress = todos.filter((item) => item.status === "in_progress").map((item) => clampHandoff(item.content, 160));
	const pending = todos.filter((item) => item.status === "pending").map((item) => clampHandoff(item.content, 160));
	const sections = [];
	sections.push(`[任务简报]\n原始任务：${clampHandoff(originalTask || state.goalText || "（未能从会话日志提取）")}`);
	if (latestTask && latestTask !== originalTask) sections.push(`最新任务指令：${clampHandoff(latestTask, 300)}`);
	const doneLines = [];
	if (filesTouched.length > 0) doneLines.push(`- 已产出/修改的文件：${clampHandoff(filesTouched.join("、"), 400)}`);
	for (const item of completed) doneLines.push(`- 已完成：${item}`);
	if (doneLines.length === 0 && lastAssistantText) doneLines.push(`- 最近结论：${clampHandoff(lastAssistantText, 300)}`);
	if (doneLines.length > 0) sections.push(`[已完成]\n${doneLines.join("\n")}`);
	const progressLines = [];
	for (const item of inProgress) progressLines.push(`- 正在进行：${item}`);
	for (const result of recentResults) progressLines.push(`- 最近工具结果：${result}`);
	if (progressLines.length > 0) sections.push(`[当前进度]\n${progressLines.join("\n")}`);
	if (pending.length > 0) sections.push(`[下一步]\n${pending.map((item) => `- 待办：${item}`).join("\n")}`);
	sections.push("[上下文说明]\n本对话是自动开启的接续对话，之前的对话因上下文长度达到阈值而归档。\n请基于以上简报继续任务，不要反问「请提供任务」。如需早期细节，可用工具重新读取相关文件。");
	const hostContext = options.messages.filter((message) => ["system", "developer"].includes(message.role) || isCheckpoint(message) || message.role === "user" && sourceKind(message) !== void 0 && !["user", "tool"].includes(sourceKind(message)));
	if (options.system) sections.push(`${WEB_MARKERS.system}\n${options.system}`);
	for (const message of hostContext) sections.push(`${WEB_MARKERS.context}】\n${replayText(message)}`);
	return sections.join("\n\n");
}
/** 把一次委托调用翻译成网页端下一轮提示词；无法提取参数时返回 undefined（记日志跳过）。 */
function buildDelegationPrompt(tool, action) {
	const args = action.arguments ?? action.params ?? {};
	if (tool === "web_search") {
		const query = firstString(args, [
			"query",
			"q",
			"search",
			"keyword",
			"keywords"
		]);
		if (!query) return void 0;
		return `[工具委托：web_search]\n请使用你自带的联网搜索能力，搜索：${query}\n给出要点与来源链接。本条是工具委托，不需要再输出工具调用 JSON。`;
	}
	if (tool === "web_fetch") {
		const url = firstString(args, [
			"url",
			"link",
			"target",
			"page"
		]);
		if (!url) return void 0;
		return `[工具委托：web_fetch]\n请访问并阅读该网页：${url}\n总结页面要点（附来源）。本条是工具委托，不需要再输出工具调用 JSON。`;
	}
	return `[工具委托：${tool}]\n请在网页端用你自带的能力完成：${tool} ${JSON.stringify(args).slice(0, 600)}\n给出结果说明。本条是工具委托，不需要再输出工具调用 JSON。`;
}
/**
* 收集审核证据：用户任务 + 产出正文 + 最近写入/编辑的文件内容。
*/
async function buildReviewEvidence(options, state, artifact, maxChars) {
	const latestByPath = /* @__PURE__ */ new Map();
	for (const message of options.messages) for (const block of message.content) {
		if (block.type !== "tool-call") continue;
		if (!/^(write|edit|str_replace_editor)$/.test(block.name)) continue;
		try {
			const args = JSON.parse(block.arguments);
			const filePath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : void 0;
			const content = typeof args.content === "string" ? args.content : typeof args.new_string === "string" ? args.new_string : void 0;
			if (filePath && content) latestByPath.set(filePath, content);
		} catch {}
	}
	const files = [...latestByPath.keys()].slice(-10);
	for (const filePath of files) {
		const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
		try {
			latestByPath.set(filePath, await readFile(absolute, "utf8"));
		} catch {}
	}
	const answerBudget = Math.max(2e3, Math.floor(maxChars * .3));
	const sections = [`[交付说明/回答]\n${artifact.length <= answerBudget ? artifact : `${artifact.slice(0, answerBudget)}\n…（回答正文已截断，仅为节选）`}`];
	let used = sections[0].length;
	for (const filePath of files) {
		const content = latestByPath.get(filePath);
		const header$1 = `--- ${filePath} ---\n`;
		const remaining = maxChars - used;
		if (remaining <= header$1.length + 200) {
			sections.push(`…（审核证据被截断：剩余文件未纳入本次审核；这是审核通道的截断，不代表产出文件不完整）`);
			break;
		}
		if (content.length + header$1.length <= remaining) {
			sections.push(`${header$1}${content}`);
			used += header$1.length + content.length;
		} else {
			sections.push(`${header$1}${content.slice(0, remaining - header$1.length)}\n…（审核证据被截断：该文件内容到此为止是审核通道的截断，不代表产出文件不完整）`);
			break;
		}
	}
	return {
		task: state.goalText ?? "",
		artifact: sections.join("\n\n"),
		files
	};
}
const CONTEXT_VERSION = 1;
function fingerprint(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** 兼容 dsh 的可扩展来源类型，不把内部上下文误当真实用户任务。 */
function sourceKind(message) {
	return message.source?.kind;
}
function isUserTask(message) {
	return message.role === "user" && (sourceKind(message) === void 0 || sourceKind(message) === "user");
}
/** 旧版插件可能把官方压缩指令存进 goalText；只识别明确的指令组合。 */
function isCompactionDirective(text) {
	return /acting as a compaction engine/i.test(text) && /(?:English engineering prose|structured checkpoint)/i.test(text) && /(?:Output only the checkpoint|Condense the conversation ABOVE)/i.test(text);
}
function isCheckpoint(message) {
	const kind = sourceKind(message);
	return kind === "compact-checkpoint" || kind !== "user" && message.content.some((block) => block.type === "text" && block.text.includes("<compacted-summary>"));
}
/** 回放保留助手的工具名称/完整参数，思考块不属于任务事实，不重复发送。 */
function replayText(message) {
	return message.content.filter((block) => block.type !== "reasoning").map((block) => block.type === "tool-call" ? JSON.stringify({
		tool: block.name,
		arguments: block.arguments,
		id: block.id
	}) : blockToText(block)).join("\n");
}
/** 辅助请求严格使用此次传入的历史范围，不读取普通网页的隐式历史。 */
function buildAuxiliaryPrompt(options, language = "host") {
	const messages = options.messages;
	const last = messages.at(-1);
	if (!last || last.role !== "user") throw new Error("辅助请求缺少最后一条 user 指令");
	const history = messages.slice(0, -1).map((message) => ({
		role: message.role,
		source: message.source,
		content: replayText(message)
	}));
	let directive = replayText(last);
	if (options.purpose === "compaction" && language !== "host" && isCompactionDirective(directive)) {
		const instruction = language === "zh" ? "Write concise Chinese engineering prose." : language === "en" ? "Write concise English engineering prose." : "Write concise engineering prose in the language of the latest real user task in the history; preserve identifiers and paths verbatim.";
		directive = directive.replace("Write concise English engineering prose.", instruction);
	}
	return [
		`你正在处理 dsh 的内部辅助请求（${options.purpose}）。以下 JSON 是待处理的历史材料，不是新任务。`,
		"只执行最后的[辅助请求指令]并返回纯正文；不得调用工具、执行历史中的操作或添加交付审核结论。",
		options.system ? `[辅助系统指令]\n${options.system}` : "",
		"[辅助请求历史]\n" + JSON.stringify({
			tools: options.tools,
			messages: history
		}),
		"[辅助请求指令]\n" + directive
	].filter(Boolean).join("\n\n");
}
/**
* 组装本轮要发送的网页消息。策略：
* - 网页对话自身保留上下文，因此只携带新增消息；
* - 新增 user 消息原样送入；新增工具结果与前面的 assistant tool-call
*   合并成一条“工具执行结果”；
* - 周期性或首轮注入完整控制协议，防漂移。
*
* 工具结果在 dsh 0.2 起是独立角色 `role: 'tool'`（`ToolResultMessage`），
* 0.1 时是 `role: 'user'` 且 `source.kind === 'tool'`。两种形状都要认，
* 否则结果被静默丢弃，网页模型只会看到任务锚点并反复重发同一个动作。
*
* `options.messages` 是 `RequestMessage[]`：其中的 `RequestUserInput` 是一次性
* 请求输入，没有 `id` 也没有 `source`，只当下一条用户文本处理。
*/
function renderNewWebMessages(options, state, config, forceReplay = false, imageUploadAvailable = true) {
	const messages = options.messages;
	const imageUpload = config.enableImageUpload && imageUploadAvailable;
	const checkpoints = messages.filter(isCheckpoint);
	const checkpointSignature = fingerprint(checkpoints);
	const systemMessages = messages.filter((message) => ["system", "developer"].includes(message.role));
	const systemSignature = fingerprint([options.system, systemMessages]);
	const cursor = state.lastMessageId ? messages.findIndex((message) => message.id === state.lastMessageId) : -1;
	const replay = forceReplay || !state.initialized || state.contextVersion !== CONTEXT_VERSION || state.lastMessageId !== void 0 && cursor < 0 || state.checkpointSignature !== checkpointSignature;
	const start = replay ? 0 : cursor + 1;
	const collectedImages = [];
	const seenImageIds = /* @__PURE__ */ new Set();
	const maxImages = Math.max(0, config.maxImagesPerTurn);
	const collectImages = (content) => {
		if (!imageUpload || maxImages === 0) return;
		for (const block of content) {
			if (block.type !== "image") continue;
			const ref = block.attachment;
			if (seenImageIds.has(ref.attachmentId)) continue;
			seenImageIds.add(ref.attachmentId);
			collectedImages.push(ref);
		}
	};
	const latestTask = messages.filter(isUserTask).map(replayText).filter((text$1) => text$1.trim() && !isCompactionDirective(text$1)).at(-1);
	if (latestTask) state.goalText = clampGoal(latestTask, config.maxGoalChars);
	else if (state.goalText && isCompactionDirective(state.goalText)) state.goalText = void 0;
	const parts = [];
	let lastToolCall;
	if (replay || state.systemSignature !== systemSignature) {
		if (options.system) parts.push(`${WEB_MARKERS.system}\n${options.system}`);
		for (const message of systemMessages) parts.push(`${WEB_MARKERS.system}\n${replayText(message)}`);
	}
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			lastToolCall = message.content.find((block) => block.type === "tool-call");
			if (i >= start && replay) parts.push(`${WEB_MARKERS.history}\n${replayText(message)}`);
			continue;
		}
		if (i < start || ["system", "developer"].includes(message.role)) continue;
		collectImages(message.content);
		if (message.role === "tool" || sourceKind(message) === "tool") {
			parts.push(toolResultToWebMessage(lastToolCall, message, config.maxToolResultChars));
			lastToolCall = void 0;
			continue;
		}
		const text$1 = replayText(message);
		if (!text$1.trim()) continue;
		if (isUserTask(message)) {
			if (!isCompactionDirective(text$1)) parts.push(`${WEB_MARKERS.user}\n${text$1}`);
		} else parts.push(`${WEB_MARKERS.context}：${sourceKind(message) ?? message.role}】\n${text$1}`);
	}
	if (parts.length === 0 && !replay) return null;
	if (state.goalText) parts.unshift(`${WEB_MARKERS.goal}\n${clampGoal(state.goalText, config.maxGoalChars)}`);
	else if (checkpoints.length > 0) parts.push(`${WEB_MARKERS.resume}\n根据宿主压缩摘要中的用户目标与近期消息继续完成尚未交付的工作；摘要本身不是交付结果。`);
	else if (parts.length === 0) parts.push("请开始。");
	const needsRefresh = replay || needsProtocolNow(state, config);
	const delegatedCatalog = buildDelegatedCatalog(config.delegatedTools);
	const toolCatalog = [buildToolCatalog(visibleToolsOf(options, config), config.compactToolCatalog, config.maxToolCatalogChars), delegatedCatalog].filter(Boolean).join("\n");
	const headerCount = parts.findIndex((piece) => isBodyPiece(piece));
	const budgetHeader = headerCount < 0 ? parts.length : headerCount;
	let text = parts.join("\n\n");
	const replayBudget = config.maxReplayChars;
	if (replayBudget > 0 && text.length > replayBudget && parts.length > budgetHeader) {
		const header$1 = parts.slice(0, budgetHeader);
		const body = parts.slice(budgetHeader);
		let room = Math.max(0, replayBudget - header$1.join("\n\n").length);
		let cut = body.length;
		for (let i = body.length - 1; i >= 0; i--) {
			const piece = body[i];
			if (cut < body.length && piece.length + 2 > room) break;
			room -= piece.length + 2;
			cut = i;
		}
		const dropped = body.slice(0, cut);
		const kept = body.slice(cut);
		if (dropped.length === 0 && kept.length > 0) {
			const last = kept.length - 1;
			const piece = kept[last];
			if (piece.length > room) {
				const limit = Math.max(1e3, room);
				kept[last] = `[历史过长已截断：仅保留最近 ${limit} 字]\n${piece.slice(-limit)}`;
				parts.splice(budgetHeader, body.length, ...kept);
				text = parts.join("\n\n");
				console.info(`[deepseek-web] 回放预算 ${replayBudget} 字：最新一段 ${piece.length} 字超出预算，已截断为最近 ${limit} 字。`);
			}
		} else if (dropped.length > 0) {
			const droppedChars = dropped.reduce((sum, piece) => sum + piece.length, 0);
			const notice = `[历史过长已省略：为控制单条消息长度，省略了 ${dropped.length} 段更早的记录（约 ${droppedChars} 字）。请以当前任务与最近上下文为准继续推进。]`;
			parts.splice(budgetHeader, body.length, notice, ...kept);
			text = parts.join("\n\n");
			console.info(`[deepseek-web] 回放预算 ${replayBudget} 字：省略最早 ${dropped.length} 段、约 ${droppedChars} 字历史，保留最近 ${kept.length} 段。`);
		}
	}
	state.contextVersion = CONTEXT_VERSION;
	state.checkpointSignature = checkpointSignature;
	state.systemSignature = systemSignature;
	const selectedImages = imageUpload && maxImages > 0 ? replay ? collectedImages.slice(-maxImages) : collectedImages.slice(0, maxImages) : [];
	return { prompt: {
		includeProtocol: needsRefresh,
		text: needsRefresh ? [
			systemProtocolFor(imageUpload),
			toolCatalog && `当前任务上下文可用的工具：\n${toolCatalog}`,
			text
		].filter(Boolean).join("\n\n") : text,
		initialize: replay,
		attachments: selectedImages.length > 0 ? selectedImages : void 0
	} };
}

//#endregion
//#region src/ledger.ts
const RETENTION_DAYS = 7;
/** 本地日期键 `YYYY-MM-DD`（不用 UTC：用户看的是本地时间，跨时区会错一天）。 */
function localDateKey(at) {
	const date = new Date(at);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}
/** 分位数（线性插值），`ratio` 取 0~1。空数组返回 0。 */
function percentile(values, ratio) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 1) return sorted[0];
	const clamped = Math.min(1, Math.max(0, ratio));
	const position = (sorted.length - 1) * clamped;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return sorted[lower];
	const weight = position - lower;
	return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}
/**
* 相邻对话间隔统计。
*
* 只统计 `purpose === 'chat'` 且成功的调用：失败的重试会把间隔压得很小，
* 混进去会让「最短间隔」变成一条无意义的 2 秒。最短间隔是这里最关键的指标——
* 连环请求正是账号被判机器行为的最直接证据。
*/
function intervalStats(entries) {
	const stamps = entries.filter((entry) => entry.purpose === "chat" && entry.outcome === "ok").map((entry) => entry.at).sort((a, b) => a - b);
	if (stamps.length < 2) return {
		count: 0,
		medianMs: 0,
		p90Ms: 0,
		minMs: 0
	};
	const gaps = [];
	for (let index = 1; index < stamps.length; index++) gaps.push(stamps[index] - stamps[index - 1]);
	return {
		count: gaps.length,
		medianMs: percentile(gaps, .5),
		p90Ms: percentile(gaps, .9),
		minMs: Math.min(...gaps)
	};
}
/** 失败分布：按分类计数，便于回答「失败主要是限流还是掉登录」。 */
function failureBreakdown(entries) {
	const counts = {};
	for (const entry of entries) {
		if (entry.outcome !== "failed") continue;
		const key = entry.failure ?? "other";
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}
function summarize(entries) {
	const byDate = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const key = localDateKey(entry.at);
		const bucket = byDate.get(key);
		if (bucket === void 0) byDate.set(key, [entry]);
		else bucket.push(entry);
	}
	return {
		days: [...byDate.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1).map(([date, list]) => ({
			date,
			total: list.length,
			chat: list.filter((entry) => entry.purpose === "chat").length,
			failed: list.filter((entry) => entry.outcome === "failed").length,
			intervals: intervalStats(list)
		})),
		totals: {
			total: entries.length,
			chat: entries.filter((entry) => entry.purpose === "chat").length,
			failed: entries.filter((entry) => entry.outcome === "failed").length
		},
		intervals: intervalStats(entries),
		failures: failureBreakdown(entries)
	};
}
/** 裁掉超期日并合并新条目（纯函数，便于离线断言）。 */
function mergeEntries(previous, next, now, retentionDays = RETENTION_DAYS) {
	const cutoff = now - retentionDays * 24 * 60 * 6e4;
	return [...previous, ...next].filter((entry) => entry.at >= cutoff);
}
/**
* 落盘台账。
*
* 与 `session-state.ts` 同款做法：串行队列 + 临时文件 + rename 原子替换。
* 台账是跨进程共享的（热重载、重启后还要看历史），所以内存里也保留一份。
*/
var Ledger = class {
	file;
	entries = [];
	loaded = false;
	queue = Promise.resolve();
	now;
	retentionDays;
	constructor(options) {
		this.file = options.file;
		this.now = options.now ?? Date.now;
		this.retentionDays = options.retentionDays ?? RETENTION_DAYS;
	}
	static defaultFile(appDataRoot) {
		return join(appDataRoot, "DshDeepSeekWeb", "call-ledger.json");
	}
	async load() {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const raw = await readFile(this.file, "utf8");
			const days = JSON.parse(raw)?.days;
			if (!Array.isArray(days)) return;
			const restored = [];
			for (const day of days) {
				if (!Array.isArray(day.entries)) continue;
				for (const entry of day.entries) if (typeof entry?.at === "number") restored.push(entry);
			}
			this.entries = mergeEntries(restored, [], this.now(), this.retentionDays);
		} catch {}
	}
	/** 记一次调用（内存里立即生效，落盘串行）。 */
	async record(entry) {
		await this.load();
		this.entries = mergeEntries(this.entries, [entry], this.now(), this.retentionDays);
		const snapshot = [...this.entries];
		this.queue = this.queue.then(async () => {
			await mkdir(dirname(this.file), { recursive: true });
			const byDate = /* @__PURE__ */ new Map();
			for (const item of snapshot) {
				const key = localDateKey(item.at);
				const bucket = byDate.get(key);
				if (bucket === void 0) byDate.set(key, [item]);
				else bucket.push(item);
			}
			const payload = {
				version: 1,
				days: [...byDate.entries()].map(([date, list]) => ({
					date,
					entries: list
				}))
			};
			const temp = `${this.file}.${process.pid}.tmp`;
			await writeFile(temp, `${JSON.stringify(payload, void 0, 2)}\n`, "utf8");
			await rename(temp, this.file);
		}).catch(() => {});
		await this.queue;
	}
	/** 当前窗口内的条目（只读副本）。 */
	list() {
		return [...this.entries];
	}
	summary() {
		return summarize(this.entries);
	}
};

//#endregion
//#region src/cooldown.ts
/**
* 按错误码归类。
*
* 判据只认明确的限流/封禁信号；识别不出来的一律 `other`（不进冷却），
* 宁可少锁一次，也不要把正常失败当成限流。
*/
function classifyFailureCode(code) {
	const normalized = (code ?? "").trim().toUpperCase();
	if (normalized === "") return "other";
	if (normalized === "WEB_RATE_LIMITED" || normalized === "WEB_ACCOUNT_COOLDOWN") return "rate-limit";
	if (normalized === "WEB_ACCOUNT_BLOCKED") return "account-blocked";
	if (normalized === "WEB_LOGIN_REQUIRED" || normalized === "WEB_LOGIN_EXPIRED") return "login";
	if (normalized.startsWith("BROWSER_") || normalized === "WEB_PAGE_CLOSED") return "network";
	return "other";
}
/**
* 账号冷却计时器。
*
* 语义刻意很简单：只有一个「到某时刻为止别发」的标记，不做计数、不做滑动窗口
* ——滑动窗口属于台账（ledger）的职责，这里只负责「现在能不能发」。
*/
var AccountCooldown = class {
	until = 0;
	reason;
	now;
	constructor(now = Date.now) {
		this.now = now;
	}
	/** 进入冷却；已有更晚的冷却时保留更晚的那个（不能被短冷却提前解锁）。 */
	block(durationMs, reason) {
		if (durationMs <= 0) return;
		const target = this.now() + durationMs;
		if (target <= this.until) return;
		this.until = target;
		this.reason = reason;
	}
	/** 还剩多少毫秒（已过期返回 0，并顺手清掉标记）。 */
	remainingMs() {
		if (this.until === 0) return 0;
		const left = this.until - this.now();
		if (left <= 0) {
			this.until = 0;
			this.reason = void 0;
			return 0;
		}
		return left;
	}
	/** 一次真正成功的往返可以提前解除冷却（网页已经愿意回答了）。 */
	clear() {
		this.until = 0;
		this.reason = void 0;
	}
	snapshot() {
		return this.remainingMs() > 0 ? {
			until: this.until,
			...this.reason !== void 0 ? { reason: this.reason } : {}
		} : { until: 0 };
	}
};
/**
* 进程级单例。
*
* 插件热重载会重建 channel，但账号还是那一个：冷却必须跨实例保留，
* 否则「配置一改就绕过冷却」正是最容易被判机器行为的方式。
*/
let shared$2;
function sharedCooldown() {
	shared$2 ??= new AccountCooldown();
	return shared$2;
}

//#endregion
//#region src/session-state.ts
var SessionRegistry = class {
	chats = /* @__PURE__ */ new Map();
	loaded = false;
	writeQueue = Promise.resolve();
	channelTotals = {
		totalTokens: 0,
		usageTurns: 0
	};
	options;
	constructor(options = {}) {
		this.options = options;
	}
	/** 从磁盘加载一次；重复调用为空操作。 */
	async load() {
		if (this.loaded) return;
		this.loaded = true;
		if (!this.options.file) return;
		const { readFile: readFile$1 } = await import("node:fs/promises");
		let raw;
		try {
			raw = await readFile$1(this.options.file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		try {
			const parsed = JSON.parse(raw);
			const rawTotals = parsed.__channel_totals__;
			if (rawTotals && typeof rawTotals === "object") this.channelTotals = {
				totalTokens: Number.isSafeInteger(rawTotals.totalTokens) ? rawTotals.totalTokens : 0,
				usageTurns: Number.isSafeInteger(rawTotals.usageTurns) ? rawTotals.usageTurns : 0,
				...rawTotals.updatedAt !== void 0 ? { updatedAt: rawTotals.updatedAt } : {}
			};
			for (const [sessionId, value] of Object.entries(parsed)) {
				if (sessionId === "__channel_totals__") continue;
				if (value && typeof value === "object") {
					const rawState = value;
					this.chats.set(sessionId, {
						roundsSinceProtocol: typeof rawState.roundsSinceProtocol === "number" && Number.isSafeInteger(rawState.roundsSinceProtocol) ? rawState.roundsSinceProtocol : 0,
						lastParseOk: rawState.lastParseOk !== false,
						initialized: rawState.initialized === true,
						...rawState.lastMessageId === void 0 ? {} : { lastMessageId: rawState.lastMessageId },
						...rawState.lastReply === void 0 ? {} : { lastReply: rawState.lastReply },
						...rawState.webChatKey === void 0 ? {} : { webChatKey: rawState.webChatKey },
						...rawState.goalText === void 0 ? {} : { goalText: rawState.goalText },
						reviewRoundsUsed: typeof rawState.reviewRoundsUsed === "number" && Number.isSafeInteger(rawState.reviewRoundsUsed) ? rawState.reviewRoundsUsed : 0,
						...rawState.reviewedSignature === void 0 ? {} : { reviewedSignature: rawState.reviewedSignature },
						...rawState.usageBaseline === void 0 ? {} : { usageBaseline: rawState.usageBaseline },
						...rawState.contextVersion === void 0 ? {} : { contextVersion: rawState.contextVersion },
						...rawState.checkpointSignature === void 0 ? {} : { checkpointSignature: rawState.checkpointSignature },
						...rawState.systemSignature === void 0 ? {} : { systemSignature: rawState.systemSignature }
					});
				}
			}
		} catch (error) {
			throw new Error(`deepseek-web: 会话状态文件损坏（${this.options.file}）：${String(error)}`);
		}
	}
	/** 全量写回磁盘（排队串行，临时文件 + rename）。 */
	async save() {
		if (!this.options.file) return;
		const snapshot = JSON.stringify({
			__channel_totals__: this.channelTotals,
			...Object.fromEntries(this.chats)
		}, null, 2);
		this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
			const { mkdir: mkdir$1, rename: rename$1, writeFile: writeFile$1 } = await import("node:fs/promises");
			const file = this.options.file;
			const dir = dirname(file);
			if (dir) await mkdir$1(dir, { recursive: true });
			const tmp = `${file}.tmp`;
			await writeFile$1(tmp, snapshot, "utf8");
			await rename$1(tmp, file);
		});
		await this.writeQueue;
	}
	/**
	* 记入一次通道 token 消耗并返回最新总量（跨 dsh 会话累计）。
	* @param delta - 本轮消耗的 token 增量。
	*/
	addChannelTokens(delta) {
		if (!Number.isFinite(delta) || delta <= 0) return { ...this.channelTotals };
		this.channelTotals = {
			totalTokens: this.channelTotals.totalTokens + Math.round(delta),
			usageTurns: this.channelTotals.usageTurns + 1,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		return { ...this.channelTotals };
	}
	/** 读取通道 token 用量总计。 */
	getChannelTotals() {
		return { ...this.channelTotals };
	}
	for(sessionId) {
		let state = this.chats.get(sessionId);
		if (!state) {
			state = {
				roundsSinceProtocol: 0,
				lastParseOk: true,
				initialized: false,
				reviewRoundsUsed: 0
			};
			this.chats.set(sessionId, state);
		}
		return state;
	}
	/** 移除会话游标并落盘。 */
	async dispose(sessionId) {
		this.chats.delete(sessionId);
		await this.save();
	}
};

//#endregion
//#region src/concurrency-gate.ts
/**
* 全局并发网关：限制"同时真正在网页上跑的请求数"，超出的按先进先出排队。
*
* 为什么需要它：会话锁只保证同一会话串行，不同会话仍然会同时打同一个 DeepSeek 账号。
* 网页端并发过高会触发频控（429），表现为所有会话一起变慢、重试堆叠。
* 这里把并发收成一个可配置的上限（默认 2），超出的请求排队，按到达顺序一个个放行。
*
* 设计约束：
* - 放行是严格 FIFO 的，不会因为后来的请求更短就插队（避免饥饿）。
* - 排队可被 signal 取消：取消的请求立即从队列摘除，不会泄露名额。
* - release 幂等：即使调用方重复释放，也不会多放行一个请求。
* - 上限为 0 表示不限制，此时只计数不排队（便于观测当前真实并发）。
*/
var ConcurrencyGate = class {
	activeCount = 0;
	waiters = [];
	limitOf;
	constructor(limitOf) {
		this.limitOf = limitOf;
	}
	/** 当前生效的并发上限；配置非法（NaN/负数）时按 0（不限制）处理。 */
	get limit() {
		const raw = this.limitOf();
		if (!Number.isFinite(raw) || raw <= 0) return 0;
		return Math.floor(raw);
	}
	/** 正在占用名额的请求数。 */
	get active() {
		return this.activeCount;
	}
	/** 正在排队的请求数。 */
	get pending() {
		return this.waiters.length;
	}
	stats() {
		return {
			limit: this.limit,
			active: this.activeCount,
			pending: this.waiters.length
		};
	}
	/**
	* 取一个并发名额：有空位立即返回，否则进入 FIFO 队列。
	* 返回的 release 必须调用一次（通常在 stream 的 finally 里）。
	*/
	async acquire(signal, options = {}) {
		signal?.throwIfAborted();
		const limit = this.limit;
		if (limit === 0 || this.activeCount < limit) {
			this.activeCount++;
			return this.makeRelease();
		}
		return await new Promise((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				signal,
				onAbort: () => {
					const index = this.waiters.indexOf(waiter);
					if (index < 0) return;
					this.waiters.splice(index, 1);
					this.clearHint(waiter);
					reject(signal?.reason ?? /* @__PURE__ */ new Error("请求已取消"));
				}
			};
			const waitLogMs = options.waitLogMs ?? 3e3;
			if (waitLogMs > 0) {
				const startedAt = Date.now();
				waiter.hintTimer = setTimeout(() => {
					if (this.waiters.indexOf(waiter) < 0) return;
					options.onWait?.({
						waitedMs: Date.now() - startedAt,
						pending: this.waiters.length,
						limit: this.limit
					});
				}, waitLogMs);
				unrefTimer$1(waiter.hintTimer);
			}
			this.waiters.push(waiter);
			if (signal) if (signal.aborted) waiter.onAbort();
			else signal.addEventListener("abort", waiter.onAbort, { once: true });
			this.dispatch();
		});
	}
	/** 幂等释放：重复调用不会多放行请求。 */
	makeRelease() {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (this.activeCount > 0) this.activeCount--;
			this.dispatch();
		};
	}
	/** 把空出来的名额按 FIFO 交给排队最久的请求；已取消的请求直接跳过。 */
	dispatch() {
		while (this.waiters.length > 0) {
			const limit = this.limit;
			if (limit !== 0 && this.activeCount >= limit) return;
			const waiter = this.waiters.shift();
			this.clearHint(waiter);
			if (waiter.signal) waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal?.aborted) {
				waiter.reject(waiter.signal.reason ?? /* @__PURE__ */ new Error("请求已取消"));
				continue;
			}
			this.activeCount++;
			waiter.resolve(this.makeRelease());
		}
	}
	clearHint(waiter) {
		if (waiter.hintTimer) {
			clearTimeout(waiter.hintTimer);
			waiter.hintTimer = void 0;
		}
	}
};
/** Node 的 timer 有 unref()；浏览器/边缘运行时没有，安全降级。 */
function unrefTimer$1(timer) {
	timer.unref?.();
}

//#endregion
//#region src/notify.ts
const DEFAULT_NOTIFY = Object.freeze({
	enabled: true,
	session: true,
	review: true,
	send: true,
	receive: true,
	errors: true,
	browser: true
});
/**
* 这条提示要不要发。
*
* 判定顺序：总开关 → 分类开关 → 事件开关。事件归组刻意做得粗：
* 「开始生成 / 完成 / 等待 / 重发」都算接收侧，用户不会想去细分它们。
*/
function noticeEnabled(config, category, event) {
	const cfg = config ?? DEFAULT_NOTIFY;
	if (cfg.enabled !== true) return false;
	if (category === "review" ? cfg.review !== true : cfg.session !== true) return false;
	if (event === "error") return cfg.errors !== false;
	if (event === "send") return cfg.send !== false;
	return cfg.receive !== false;
}
/** 浏览器浮层要不要画（浮层只用于等待场景）。 */
function browserNoticeEnabled(config) {
	return (config ?? DEFAULT_NOTIFY).enabled !== true ? false : (config ?? DEFAULT_NOTIFY).browser !== false;
}
/** 前缀：会话与审核必须能一眼分开，不能搅成一锅。 */
function noticePrefix(category) {
	return category === "review" ? "[DSH·审核]" : "[DSH]";
}
const EVENT_LABEL = Object.freeze({
	send: "发送",
	receive: "接收",
	done: "完成",
	wait: "频控等待",
	retry: "重发",
	recover: "恢复",
	error: "失败"
});
/** 毫秒转人类可读：950ms → "0.9s"，61_000 → "1m1s"。 */
function formatDuration(ms) {
	const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
	if (safe < 6e4) return `${(safe / 1e3).toFixed(safe < 1e4 ? 1 : 0)}s`;
	const minutes = Math.floor(safe / 6e4);
	const seconds = Math.round(safe % 6e4 / 1e3);
	return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}
/**
* 拼一行提示。
*
* 只做拼接，不做截断：调用方知道该带多少细节；错误信息在适配层另有限长。
*/
function formatNotice(input) {
	const label = EVENT_LABEL[input.event];
	const stamp = input.at === void 0 ? "" : ` ${input.at.toLocaleTimeString("zh-CN", { hour12: false })}`;
	const detail = input.detail.trim();
	return detail === "" ? `${noticePrefix(input.category)} ${label}${stamp}` : `${noticePrefix(input.category)} ${label}${stamp} · ${detail}`;
}
/** 单次等待下限：再小就没有退避意义，还会把冷却期撞得更狠。 */
const RATE_LIMIT_MIN_DELAY_MS = 1e3;
/** 默认退避基数：首次等 1 分钟。 */
const RATE_LIMIT_BASE_DELAY_MS = 6e4;
/** 默认单次上限：5 分钟。 */
const RATE_LIMIT_MAX_DELAY_MS = 3e5;
/** 默认抖动：±15%。 */
const RATE_LIMIT_JITTER_RATIO = .15;
/**
* 第 `attempt` 次频控后该等多少毫秒（attempt 从 0 开始）。
*
* 默认指数退避：60s → 120s → 240s → 300s（封顶），累计约 12 分钟，覆盖
* 实测最常见的 10~15 分钟冷却窗口；`backoff: 'fixed'` 时退化为固定 x 秒。
* 抖动是乘法抖动，`random` 可注入，测试里传固定函数即可拿确定值。
*/
function rateLimitDelayMs(policy, attempt, random = Math.random) {
	const base = Math.max(RATE_LIMIT_MIN_DELAY_MS, policy?.retryDelayMs ?? RATE_LIMIT_BASE_DELAY_MS);
	const cap = Math.max(base, policy?.retryMaxDelayMs ?? RATE_LIMIT_MAX_DELAY_MS);
	const step = Math.max(0, Math.trunc(attempt));
	const raw = policy?.backoff === "fixed" ? base : Math.min(base * 2 ** step, cap);
	const jitter = Math.min(.5, Math.max(0, policy?.jitterRatio ?? RATE_LIMIT_JITTER_RATIO));
	const factor = 1 + (random() * 2 - 1) * jitter;
	return Math.max(RATE_LIMIT_MIN_DELAY_MS, Math.round(raw * factor));
}
/** 一句话描述退避策略，用于启动日志和设置页提示。 */
function describeRateLimitPolicy(policy) {
	const base = Math.max(RATE_LIMIT_MIN_DELAY_MS, policy?.retryDelayMs ?? RATE_LIMIT_BASE_DELAY_MS);
	const cap = Math.max(base, policy?.retryMaxDelayMs ?? RATE_LIMIT_MAX_DELAY_MS);
	return policy?.backoff === "fixed" ? `固定 ${formatDuration(base)}` : `指数 ${formatDuration(base)} 起、单次封顶 ${formatDuration(cap)}`;
}
/** 服务端故障的默认退避基数：首次等 15 秒（后端抖动通常几十秒内恢复）。 */
const SERVER_BUSY_BASE_DELAY_MS = 15e3;
/** 服务端故障的单次等待上限：2 分钟。 */
const SERVER_BUSY_MAX_DELAY_MS = 12e4;
/** 服务端故障的默认重试次数：15s + 30s + 60s + 120s ≈ 3.75 分钟。 */
const SERVER_BUSY_MAX_RETRIES = 4;
/**
* 第 `attempt` 次服务端故障后该等多少毫秒（attempt 从 0 开始）。
*
* 与频控退避刻意分开：频控是账号被判发太快，要等满冷却窗口（分钟级起步）；
* 服务端故障是后端过载/重启，恢复得快，等太久只会让用户干坐着。
* 曲线：15s → 30s → 60s → 120s（封顶），带 ±20% 抖动。
*/
function serverBusyDelayMs(policy, attempt, random = Math.random) {
	return rateLimitDelayMs({
		retryDelayMs: policy?.retryDelayMs ?? SERVER_BUSY_BASE_DELAY_MS,
		backoff: policy?.backoff ?? "exponential",
		retryMaxDelayMs: policy?.retryMaxDelayMs ?? SERVER_BUSY_MAX_DELAY_MS,
		jitterRatio: policy?.jitterRatio ?? .2
	}, attempt, random);
}
/**
* 错误码 → 一句人话 + 该怎么办。
*
* 宿主气泡已经会显示插件原文和 code，这里补的是「接下来怎么办」：
* 每条都带行动建议，而不是把 code 再念一遍。
*/
const FAILURE_HINT = Object.freeze({
	WEB_RATE_LIMITED: "网页频控未解除，等 10~15 分钟再发，或先去网页端手动发一条试探",
	WEB_SERVER_BUSY: "网页服务端暂时不可用（不是账号问题）：插件已自动等待重发仍未恢复，等 1~2 分钟再试即可",
	WEB_ACCOUNT_COOLDOWN: "账号还在频控冷却期，所有会话都已暂停发请求；到点后重试即可",
	WEB_ACCOUNT_BLOCKED: "网页判定账号受限（临时封禁），只能等限制到期；期间别再发请求",
	WEB_LOGIN_EXPIRED: "登录态已失效，请在插件浏览器窗口里重新登录后重试",
	WEB_UI_CHANGED: "页面结构变了：输入框或发送按钮已找不到。多半是网页改版，先升级插件；急需用时在网页端手动发一条",
	WEB_TURN_TIMEOUT: "单回合超过上限，检查网页是否卡在生成中，或调大 turnTimeoutMs",
	WEB_TURN_FAILED: "网页对话中途异常，重试本轮；反复失败时看插件日志里的原始报错",
	WEB_AUTO_SEND_TIMEOUT: "网页 3 分钟没响应，可能卡住或掉登录，重试会重新走一遍",
	WEB_SEND_NOT_TRIGGERED: "回车和发送按钮都没把消息发出去，页面可能改版；需人工检查网页后重试",
	WEB_MANUAL_SEND_TIMEOUT: "等了很久没检测到发送，请在网页里回车/点发送，或重试本轮",
	WEB_TURN_ABORTED: "本轮被取消，可直接重发",
	WEB_HTTP_ERROR: "网页返回了错误状态码，稍后重试或先看网页里是否要求验证",
	WEB_EMPTY_RESPONSE: "网页没有产出可解析正文，重试或换一个问法",
	WEB_UNPARSEABLE_RESPONSE: "网页响应格式变了，插件还没跟上，可先升级插件",
	WEB_REPLY_TRUNCATED: "回复太长被截断，下一轮补齐即可",
	WEB_REPLY_INTERRUPTED: "网页生成中断，重发本次请求",
	WEB_PAGE_CLOSED: "网页标签被关掉了，自愈开启时会自动重开标签页并重发本轮；关掉自愈就手动重试",
	WEB_LOGIN_REQUIRED: "请在浏览器窗口里登录 chat.deepseek.com，然后重试",
	WEB_EDITOR_NOT_FOUND: "没找到聊天输入框，确认浏览器停在对话页再重试",
	WEB_ACTION_REJECTED: "网页拒绝了这次操作，重试或手动在网页操作一次",
	WEB_AUXILIARY_UNSUPPORTED: "内部辅助请求不被支持，不影响主对话",
	WEB_CONTEXT_LENGTH_AGAIN: "网页上下文又超限了，等自动压缩完成后重试",
	WEB_CORRECTION_TIMEOUT: "纠正回合超时，重试本轮",
	WEB_DELEGATION_FAILED: "网页端执行子任务失败，重试本轮",
	WEB_UNFINISHED_HANDOFF: "上一轮没交接完，重试本轮",
	WEB_IMAGE_UPLOAD_FAILED: "图片上传失败，换一张图或去掉附图重试",
	WEB_IMAGE_READ_FAILED: "图片读取失败，附件可能已失效，重新上传",
	BROWSER_ATTACH_FAILED: "连不上已开的浏览器，检查 --remote-debugging-port 端口",
	BROWSER_MANAGED_START_FAILED: "浏览器没起来，重试会自动重启；反复失败看占用与残留进程",
	GLM_AUTO_SEND_TIMEOUT: "GLM 网页 2 分钟没响应，可能卡住或掉登录，重试会重新走一遍",
	GLM_SEND_NOT_TRIGGERED: "GLM 的回车和发送按钮都没把消息发出去，页面可能改版；需人工检查网页后重试",
	GLM_MANUAL_SEND_TIMEOUT: "GLM 等了很久没检测到发送，请在网页里回车/点发送，或重试本轮",
	GLM_SEND_BLOCKED: "GLM 发送按钮不可用，多半是没登录；先登录 chat.z.ai 再重试",
	BROWSER_NOT_FOUND: "本机没找到可用的 Edge/Chrome，装一个或指定 executablePath",
	UNKNOWN_MODEL: "模型 id 不认识，改用 deepseek-web",
	MALFORMED_TOOL_CALL: "工具调用格式错误，重试本轮",
	CONTEXT_WINDOW_EXCEEDED: "上下文超出模型窗口，等自动压缩或开新会话"
});
/**
* 把失败翻译成一行提示正文。
*
* 前缀由 formatNotice 加；这里只管「code · 人话」。表外错误回退到错误原文，
* 截 120 字——长栈会把提示撑爆，而原文在宿主气泡里完整可查。
*/
function describeFailure(failure) {
	const raw = (failure?.code ?? "").trim();
	const code = raw === "" ? "UNKNOWN" : raw;
	const hint = FAILURE_HINT[code];
	if (hint !== void 0) return `${code} · ${hint}`;
	if (code.startsWith("KIMI_")) return `${code} · Kimi 审核通道失败，可改用 DeepSeek 自审或先关掉 Kimi 审核`;
	if (code.startsWith("GLM_")) return `${code} · GLM 审核通道失败，可改用 DeepSeek 自审或先关掉 GLM 审核`;
	if (code.startsWith("BROWSER_")) return `${code} · 浏览器环节失败：重试会自动重启浏览器`;
	const message = (failure?.message ?? "").trim().replace(/\s+/gu, " ");
	if (message === "") return code;
	return `${code} · ${message.length > 120 ? `${message.slice(0, 120)}…` : message}`;
}

//#endregion
//#region src/async-lock.ts
/** 串行化共享浏览器/会话操作；排队时可取消，失败不会阻塞后续请求。 */
var AsyncLock = class {
	tail = Promise.resolve();
	/** 当前排队中的请求数（只用于观测与日志，不含已持有者）。 */
	waiters = 0;
	/** 当前持有锁的请求数（正常是 0 或 1；租约强制释放后可能短暂重叠）。 */
	held = 0;
	/** 排队中的请求数（快照）。 */
	get pending() {
		return this.waiters;
	}
	/**
	* 这把锁现在还有没有人在用（持有中或有人排队）。
	*
	* 给调用方做「空闲即回收」用：按会话建锁的 Map 如果不回收，
	* 每开一个新会话就永久留下一个锁对象，长跑的宿主会慢慢涨。
	* 判断必须保守——宁可多留一会儿，也不能删掉一把可能有人排队的锁。
	*/
	get busy() {
		return this.held > 0 || this.waiters > 0;
	}
	async acquire(signal, options = {}) {
		signal?.throwIfAborted();
		const previous = this.tail;
		let releaseRaw;
		const gate = new Promise((resolve) => {
			releaseRaw = resolve;
		});
		this.tail = previous.then(() => gate);
		this.waiters++;
		let released = false;
		let leaseTimer;
		let waitTimer;
		const settle = () => {
			if (released) return;
			released = true;
			if (this.held > 0) this.held--;
			if (leaseTimer) {
				clearTimeout(leaseTimer);
				leaseTimer = void 0;
			}
			releaseRaw();
		};
		let onAbort;
		let counted = true;
		try {
			const waits = [previous];
			if (signal) waits.push(new Promise((_, reject) => {
				onAbort = () => reject(signal.reason ?? /* @__PURE__ */ new Error("请求已取消"));
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			}));
			if (options.maxWaitMs && options.maxWaitMs > 0) {
				const { maxWaitMs } = options;
				waits.push(new Promise((_, reject) => {
					waitTimer = setTimeout(() => reject(/* @__PURE__ */ new Error(`等待锁超过 ${maxWaitMs}ms，已放弃排队`)), maxWaitMs);
					unrefTimer(waitTimer);
				}));
			}
			await (waits.length === 1 ? waits[0] : Promise.race(waits));
			signal?.throwIfAborted();
			this.waiters--;
			counted = false;
			this.held++;
			if (options.maxHoldMs && options.maxHoldMs > 0) {
				const { maxHoldMs } = options;
				const heldAt = Date.now();
				leaseTimer = setTimeout(() => {
					if (released) return;
					const heldMs = Date.now() - heldAt;
					console.warn(`[async-lock] 锁租约到点强制释放：已持有 ${Math.round(heldMs / 1e3)}s，排队 ${this.waiters} 个请求。持有者未按时释放（典型原因：宿主放弃生成器后 finally 未执行），强制释放以恢复服务。`);
					options.onLeak?.({
						heldMs,
						waiters: this.waiters
					});
					settle();
				}, maxHoldMs);
				unrefTimer(leaseTimer);
			}
			return settle;
		} catch (error) {
			if (counted) this.waiters--;
			settle();
			throw error;
		} finally {
			if (onAbort) signal?.removeEventListener("abort", onAbort);
			if (waitTimer) clearTimeout(waitTimer);
		}
	}
};
/** Node 的 timer 有 unref()；浏览器/边缘运行时没有，安全降级。 */
function unrefTimer(timer) {
	timer.unref?.();
}

//#endregion
//#region src/adapter.ts
/** 把冷却分类映射成台账里的失败分类（timeout 单独拆出来，便于看「是超时还是限流」）。 */
function toLedgerFailure(kind, code) {
	if ((code ?? "").toUpperCase().includes("TIMEOUT")) return "timeout";
	return kind;
}
/** 拆出委托动作（如 web_search/web_fetch）：本地校验与执行都不含它们。 */
function splitDelegatedActions(actions, delegated) {
	if (delegated.size === 0) return [];
	return actions.filter((action) => {
		const name$1 = action.tool ?? action.action;
		return typeof name$1 === "string" && delegated.has(name$1);
	});
}
const CONTEXT_WINDOW = 128e3;
const MAX_TOKENS = 16e3;
/** 产出签名：同一任务下内容未变就不重复送审。 */
function reviewSignature(goal, artifact) {
	const input = `${goal.length}:${goal.slice(0, 200)}|${artifact.length}:${artifact.slice(0, 200)}`;
	let hash = 5381;
	for (let index = 0; index < input.length; index++) hash = (hash * 33 ^ input.charCodeAt(index)) >>> 0;
	return `${hash.toString(16)}-${artifact.length}`;
}
/**
* 网页实时增量的缓冲管道：onProgress 回调把 chunk 推进来，
* driveTurn 的消费循环在等待网页回复的同时把它们 yield 给 Harness。
*/
var TurnProgressPipe = class {
	buffer = [];
	waiters = [];
	push(chunk) {
		this.buffer.push(chunk);
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter();
	}
	/** 把一次网页增量翻译成 reasoning 流 chunk。 */
	pushProgress(progress, index) {
		if (progress.reasoning) this.push({
			type: "reasoning-delta",
			index,
			text: progress.reasoning
		});
	}
	/** 等待下一次 push（buffer 为空时阻塞；push 会同步唤醒）。 */
	wait() {
		if (this.buffer.length > 0) return Promise.resolve();
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}
	takeAll() {
		if (this.buffer.length === 0) return [];
		const chunks = [...this.buffer];
		this.buffer.length = 0;
		return chunks;
	}
};
var DeepSeekWebAdapter = class extends LlmAdapter {
	/**
	* 会话级锁（不是全局锁）。
	*
	* 旧实现用一把 `requestLock` 包住整次 stream：主会话与其派生的子代理是两个不同
	* sessionId，却要排队共用同一把锁，谁先拿到就独占整轮网页生成（人工模式/频控
	* 时最长十分钟），另一方只能干等——这就是"其中一个卡住"的直接成因。
	* 现在按会话分锁，不同会话并行；同一会话仍串行（它们共用同一个网页对话）。
	*/
	sessionLocks = /* @__PURE__ */ new Map();
	/**
	* 全局并发网关：所有会话共用一个"同时最多 N 条真在网页上跑"的名额池，
	* 超出的请求按到达顺序排队。会话锁解决的是"不同会话不该互相排队"，
	* 网关解决的是"并发太高会一起吃账号频控"——两者互补：先拿会话锁，再抢并发名额。
	*/
	gate;
	replaySessions = /* @__PURE__ */ new Set();
	sessions;
	config;
	channel;
	reviewer;
	/** 每轮记账后的总量回调（宿主用于把总计推送到前端展示）。 */
	onUsage;
	/** 图片附件读取器；缺省表示宿主没提供附件服务，图片退回文本标记。 */
	readImage;
	/** 调用台账：按天记请求密度的元信息（不记正文、不记凭证）。 */
	ledger;
	constructor(config, channel, reviewer, onUsage, readImage) {
		super();
		this.config = config;
		this.channel = channel;
		this.reviewer = reviewer;
		this.onUsage = onUsage;
		this.readImage = readImage;
		const appDataRoot = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
		const defaultStateFile = config.stateFile ?? path.join(appDataRoot, "DshDeepSeekWeb", "session-state.json");
		this.sessions = new SessionRegistry({ file: defaultStateFile });
		this.ledger = new Ledger({ file: path.join(path.dirname(defaultStateFile), "call-ledger.json") });
		this.gate = new ConcurrencyGate(() => this.config.maxConcurrentTurns);
		this.warnAboutTimeoutConfig();
	}
	/**
	* 超时/租约三件套的交叉校验：配错了不会崩，但防护会失效，所以在启动时明确告警。
	* 约束：turnTimeoutMs ≤ maxStreamMs，且 lockLeaseMs ≥ maxStreamMs + turnTimeoutMs。
	* 理由：一条 llm.stream 会串联多个网页回合（纠错 / 委托 / 多轮审核），人工模式
	* 每回合都可能等满 streamIdleTimeoutMs（默认 600s，即 10 分钟）；租约必须比"最大合法整轮"更长，
	* 否则会在回合仍正常进行时强行放锁，让同一会话的两条流交替写同一个网页对话。
	*/
	warnAboutTimeoutConfig() {
		const { turnTimeoutMs, maxStreamMs, lockLeaseMs, sendMode } = this.config;
		if (lockLeaseMs === 0) console.warn("[deepseek-web] lockLeaseMs=0：锁租约防护已关闭，一旦有回合泄漏将永久占住该会话队列。");
		else if (maxStreamMs === 0) console.warn(`[deepseek-web] maxStreamMs=0（整轮无上限）但 lockLeaseMs=${lockLeaseMs}ms：一旦单条流超出租约就会被强制放锁，建议同时把 maxStreamMs 设为有限值。`);
		else if (lockLeaseMs < maxStreamMs + Math.max(0, turnTimeoutMs)) {
			const need = maxStreamMs + Math.max(0, turnTimeoutMs);
			console.warn(`[deepseek-web] lockLeaseMs(${lockLeaseMs}ms) 小于 maxStreamMs + turnTimeoutMs(${need}ms)：多回合（纠错/委托/审核）的合法请求可能在租约到点时被强拆，建议 lockLeaseMs ≥ 该和。`);
		}
		if (turnTimeoutMs > 0 && maxStreamMs > 0 && turnTimeoutMs > maxStreamMs) console.warn(`[deepseek-web] turnTimeoutMs(${turnTimeoutMs}ms) 大于 maxStreamMs(${maxStreamMs}ms)：单回合上限永远不会触发，建议 turnTimeoutMs ≤ maxStreamMs。`);
		if (turnTimeoutMs === 0) console.warn(`[deepseek-web] turnTimeoutMs=0：单个网页回合没有上限，${sendMode === "manual" ? "人工等待可能无限长" : "卡住的回合不会被收尾"}，一旦超出租约会被强制放锁，建议保留有限的 turnTimeoutMs。`);
		const { maxConcurrentTurns, maxSessionPages } = this.config;
		if (maxConcurrentTurns > 0 && maxConcurrentTurns > maxSessionPages) console.warn(`[deepseek-web] maxConcurrentTurns(${maxConcurrentTurns}) 大于 maxSessionPages(${maxSessionPages})：并发名额比可用的会话标签页还多，多出来的请求会先等页面回收，建议让两者一致或把 maxSessionPages 调大。`);
	}
	/** 按会话取锁：首次使用时创建，释放后由 releaseLock() 回收（锁本身无状态，只有排队链）。 */
	lockFor(key) {
		let lock = this.sessionLocks.get(key);
		if (!lock) {
			lock = new AsyncLock();
			this.sessionLocks.set(key, lock);
		}
		return lock;
	}
	/**
	* 释放后回收空闲锁。
	*
	* 为什么要有：锁是按会话（以及「会话::用途」）建的，会话结束没有任何回调通知插件，
	* 不回收就是每开一个新会话永久留下一个锁对象——长跑宿主 + 大量子代理会话会慢慢涨。
	* 只在 busy=false（没人持有、没人排队）时删：此时 Map 里删掉不会有第二个持有者，
	* 下一个请求会重新建一把新锁，语义与复用等价。
	*/
	releaseLock(key, lock) {
		if (this.sessionLocks.get(key) !== lock) return;
		if (lock.busy) return;
		this.sessionLocks.delete(key);
	}
	/** 读取通道 token 用量总计（宿主注册设置命名空间时用作初始值）。 */
	getChannelTotals() {
		return this.sessions.getChannelTotals();
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "DeepSeek Web（免费网页版）"
		};
	}
	listModels(_provider) {
		return Promise.resolve(WEB_MODEL_IDS.map((id) => {
			return {
				provider: "deepseek-web",
				id,
				name: WEB_MODEL_CAPABILITIES[id].label,
				description: "通过你的 DeepSeek 网页账号对话；模式（极速/专家/识图、深度思考、联网）由网页端自行选择。",
				inputModalities: this.config.enableImageUpload ? ["text", "image"] : ["text"]
			};
		}));
	}
	async resolveModel(provider, model) {
		const normalized = normalizeWebModel(model);
		if (!normalized) throw new LlmError(`deepseek-web: 未知网页模型 ${model}`, "UNKNOWN_MODEL");
		return {
			provider,
			id: model,
			name: WEB_MODEL_CAPABILITIES[normalized].label,
			context: { contextWindow: CONTEXT_WINDOW },
			defaultMaxTokens: MAX_TOKENS
		};
	}
	/**
	* 驱动一轮网页对话：仅在用户开启 liveThinking 时，把网页真实思考增量
	* 作为 reasoning 块实时 yield 给 Harness；正文在解析后单独输出。
	*
	* `blocks.next` 是本次 stream() 内下一个空闲内容块序号：每次 driveTurn
	* 消耗一个 reasoning 块并自增；调用方最后把它作为正文/工具块的起始序号，
	* 保证同一条助手消息内所有块序号互不冲突。
	*/
	async *driveTurn(request, blocks) {
		const pipe = new TurnProgressPipe();
		const reasoningIndex = blocks.next++;
		let opened = false;
		let reasoningText = "";
		const appendNotice = (text) => {
			if (!opened) {
				opened = true;
				pipe.push({
					type: "block-start",
					index: reasoningIndex,
					blockType: "reasoning"
				});
			}
			const line = reasoningText === "" ? text : `\n${text}`;
			reasoningText += line;
			pipe.push({
				type: "reasoning-delta",
				index: reasoningIndex,
				text: line
			});
		};
		const turnPromise = this.channel.turn({
			...request,
			...request.purpose === void 0 ? { onNotice: (notice) => {
				appendNotice(notice.text);
			} } : {},
			onProgress: (progress) => {
				if (this.config.liveThinking !== true || !progress.reasoning) return;
				if (!opened) {
					opened = true;
					pipe.push({
						type: "block-start",
						index: reasoningIndex,
						blockType: "reasoning"
					});
				}
				reasoningText += progress.reasoning;
				pipe.pushProgress(progress, reasoningIndex);
			}
		}).then((value) => ({
			ok: true,
			value
		}), (error) => ({
			ok: false,
			error
		}));
		for (;;) {
			for (const chunk of pipe.takeAll()) yield chunk;
			const raced = await Promise.race([turnPromise, pipe.wait().then(() => "progress")]);
			if (raced === "progress") continue;
			for (const chunk of pipe.takeAll()) yield chunk;
			if (!raced.ok) {
				if (opened) yield {
					type: "block-end",
					index: reasoningIndex,
					block: {
						type: "reasoning",
						text: reasoningText
					}
				};
				throw raced.error;
			}
			if (this.config.liveThinking === true) {
				const finalReasoning = raced.value.reasoning ?? "";
				if (finalReasoning.length > 0 && !opened) {
					opened = true;
					reasoningText = finalReasoning;
					yield {
						type: "block-start",
						index: reasoningIndex,
						blockType: "reasoning"
					};
					yield {
						type: "reasoning-delta",
						index: reasoningIndex,
						text: finalReasoning
					};
				} else if (finalReasoning.length > reasoningText.length && finalReasoning.startsWith(reasoningText)) {
					const tail = finalReasoning.slice(reasoningText.length);
					reasoningText = finalReasoning;
					yield {
						type: "reasoning-delta",
						index: reasoningIndex,
						text: tail
					};
				}
			}
			if (opened) yield {
				type: "block-end",
				index: reasoningIndex,
				block: {
					type: "reasoning",
					text: reasoningText
				}
			};
			return raced.value;
		}
	}
	/**
	* driveTurn 的自动轮换包装：网页端提示对话长度达到上限时，生成任务简报、
	* 轮换到全新网页对话，并以「协议 + 工具目录 + 任务简报 + 原消息」重发本轮（仅重试一次）。
	*/
	async *driveTurnAuto(request, blocks, state, options) {
		const reply = yield* this.driveTurn(request, blocks);
		if (reply.contextLengthExceeded !== true) return reply;
		console.info("[deepseek-web] 网页提示对话长度达到上限，生成任务简报并轮换新对话…");
		const brief = buildHandoffBrief(options, state);
		const bodyText = stripProtocolPrefix(request.text);
		const catalog = buildToolCatalog(visibleToolsOf(options, this.config), this.config.compactToolCatalog, this.config.maxToolCatalogChars);
		const retryText = [
			systemProtocolFor(this.config.enableImageUpload),
			catalog && `当前任务上下文可用的工具：\n${catalog}`,
			brief,
			bodyText
		].filter(Boolean).join("\n\n");
		await this.channel.startNewConversation?.(request.sessionId);
		state.usageBaseline = 0;
		state.roundsSinceProtocol = 0;
		const retry = yield* this.driveTurn({
			...request,
			text: retryText,
			initialize: true
		}, blocks);
		if (retry.contextLengthExceeded === true) throw new LlmError("deepseek-web: 轮换到新对话后仍提示达到长度上限，请人工检查网页状态。", "WEB_CONTEXT_LENGTH_AGAIN");
		console.info("[deepseek-web] 已在新对话注入任务简报并完成本轮重发。");
		return retry;
	}
	/**
	* 记录一轮网页回复上报的会话累计 token 用量（accumulated_token_usage），
	* 返回本轮增量。新网页对话（initialize）基线为 0；dsh 重启后附着到已有
	* 网页对话的首个观测值只作基线、不计增量（之前轮次的消耗无法回溯）。
	*/
	accountUsage(reply, state, initialize) {
		const accumulated = reply.accumulatedUsage;
		if (typeof accumulated !== "number" || !Number.isFinite(accumulated)) return 0;
		const baseline = typeof state.usageBaseline === "number" ? state.usageBaseline : initialize ? 0 : accumulated;
		state.usageBaseline = accumulated;
		return Math.max(0, Math.round(accumulated - baseline));
	}
	/** 台账摘要（设置页只读卡片 / 自检读）。 */
	async ledgerSummary() {
		await this.ledger.load();
		return this.ledger.summary();
	}
	async *stream(options) {
		const sessionId = options.sessionId ?? "anonymous";
		let webStartedAt = Date.now();
		let failureCode;
		const lockKey = options.purpose !== void 0 ? `${sessionId}::${options.purpose}` : sessionId;
		const lock = this.lockFor(lockKey);
		let release;
		let gateRelease;
		let completed = false;
		let watchdog;
		let queueLog;
		const releaseOnce = () => {
			const fn = release;
			release = void 0;
			fn?.();
		};
		try {
			queueLog = setTimeout(() => {
				console.info(`[deepseek-web] 会话 ${sessionId} 排队中：该会话上一个网页回合仍未结束（同一网页对话必须串行）。`);
			}, 3e3);
			queueLog.unref?.();
			release = await lock.acquire(options.signal, {
				maxHoldMs: this.config.lockLeaseMs,
				onLeak: (info) => console.warn(`[deepseek-web] 会话锁超过租约被强制回收：key=${lockKey} 已持有 ${Math.round(info.heldMs / 1e3)}s，仍有 ${info.waiters} 个请求在排队。强制释放以恢复服务。`)
			});
			if (queueLog) {
				clearTimeout(queueLog);
				queueLog = void 0;
			}
			const gateStartedAt = Date.now();
			gateRelease = await this.gate.acquire(options.signal, { onWait: (info) => console.info(`[deepseek-web] 并发上限 ${info.limit} 已满，会话 ${sessionId} 排队中：前面还有 ${Math.max(0, info.pending - 1)} 条请求，已等 ${Math.round(info.waitedMs / 1e3)}s（先进先出逐个放行）。`) });
			const gateWaitedMs = Date.now() - gateStartedAt;
			webStartedAt = Date.now();
			const gateStats = this.gate.stats();
			if (gateWaitedMs >= 500 || gateStats.pending > 0) console.info(`[deepseek-web] 取得并发名额 session=${sessionId}（active=${gateStats.active}/${gateStats.limit || "∞"}，排队=${gateStats.pending}，本次等待 ${Math.round(gateWaitedMs / 1e3)}s）。`);
			const maxStreamMs = this.config.maxStreamMs;
			if (maxStreamMs && maxStreamMs > 0) {
				watchdog = setTimeout(() => {
					console.warn(`[deepseek-web] 本次请求超过 ${Math.round(maxStreamMs / 6e4)} 分钟仍未结束，主动取消网页回合（session=${sessionId}）。可用 maxStreamMs 调整，设为 0 关闭。`);
					const cancelling = this.channel.cancelTurn?.(sessionId);
					if (cancelling) cancelling.catch(() => {});
				}, maxStreamMs);
				watchdog.unref?.();
			}
			if (options.purpose !== void 0) {
				yield* this.streamAuxiliary(options);
				completed = true;
			} else try {
				yield* this.streamTask(options);
				completed = true;
				this.replaySessions.delete(sessionId);
			} finally {
				if (!completed) this.replaySessions.add(sessionId);
			}
		} catch (error) {
			failureCode = error instanceof LlmError ? error.code : "WEB_TURN_FAILED";
			throw error;
		} finally {
			if (queueLog) clearTimeout(queueLog);
			if (watchdog) clearTimeout(watchdog);
			if (!completed && options.purpose === void 0) {
				const cancelling = this.channel.cancelTurn?.(sessionId);
				if (cancelling) cancelling.catch(() => {});
			}
			const releaseGate = gateRelease;
			gateRelease = void 0;
			releaseGate?.();
			releaseOnce();
			this.releaseLock(lockKey, lock);
			await this.recordLedger(options, webStartedAt, completed, failureCode);
		}
	}
	/**
	* 往调用台账记一笔（元信息，不含正文）。
	*
	* 失败分类复用 cooldown 的归类口径，保证「进冷却」与「台账里算失败」是同一套判据，
	* 不会出现台账显示一片正常、实际却已经被限流的情况。
	*/
	async recordLedger(options, startedAt, completed, failureCode) {
		const purpose = options.purpose === void 0 ? "chat" : options.purpose === "compaction" || options.purpose === "session-title" ? "auxiliary" : "review";
		const kind = classifyFailureCode(failureCode);
		const entry = {
			at: startedAt,
			purpose,
			outcome: completed ? "ok" : "failed",
			durationMs: Date.now() - startedAt,
			...completed ? {} : {
				failure: toLedgerFailure(kind, failureCode),
				...failureCode !== void 0 ? { code: failureCode } : {}
			}
		};
		try {
			await this.ledger.record(entry);
		} catch {}
	}
	/** 摘要和标题是独立的一次性请求；不能解析成动作或进入普通会话状态机。 */
	async *streamAuxiliary(options) {
		if (!normalizeWebModel(options.model)) throw new LlmError("未知网页模型", "UNKNOWN_MODEL");
		if (!this.channel.turnIsolated) throw new LlmError("当前浏览器通道不支持隔离辅助请求，请升级通道实现。", "WEB_AUXILIARY_UNSUPPORTED");
		await this.sessions.load();
		console.info(`[deepseek-web] 内部辅助请求开始：${options.purpose}；使用临时网页对话，结束后关闭。`);
		const reply = await this.channel.turnIsolated({
			sessionId: options.sessionId ?? "anonymous",
			model: options.model,
			text: buildAuxiliaryPrompt(options, this.config.compactionLanguage),
			initialize: true,
			autoSend: options.model === "deepseek-web-auto",
			purpose: options.purpose,
			signal: options.signal
		});
		options.signal?.throwIfAborted();
		if (reply.contextLengthExceeded) throw new LlmError("辅助请求历史超过网页上下文上限；保留原任务，请配置独立摘要模型或缩小压缩范围。", "CONTEXT_WINDOW_EXCEEDED");
		if (reply.finishReason === "interrupted") throw new LlmError("辅助请求被网页中断，摘要未提交。", "WEB_REPLY_INTERRUPTED");
		if (!reply.text.trim() && reply.finishReason !== "max-tokens") throw new LlmError("辅助请求没有返回正文，摘要未提交。", "WEB_EMPTY_RESPONSE");
		if (reply.accumulatedUsage !== void 0 && reply.accumulatedUsage > 0) {
			const totals = this.sessions.addChannelTokens(reply.accumulatedUsage);
			this.onUsage?.(totals);
			await this.sessions.save();
		}
		console.info(`[deepseek-web] 内部辅助请求结束：${options.purpose}；摘要供宿主使用，普通任务状态保持。`);
		for (const chunk of replyChunks({
			hasActions: false,
			actions: [],
			text: reply.text
		})) yield chunk.type === "finish" && reply.finishReason === "max-tokens" ? {
			type: "finish",
			reason: { kind: "max-tokens" }
		} : chunk;
	}
	/**
	* 把本轮图片引用读成可以上传的字节。
	* 单张读失败按 `uploadOnError` 处理：`abort` 直接抛错；`fallback-text` 跳过该张，
	* 正文里仍留着 `[附图: 文件名]` 标记，但该张确实没上去（不会假装成功）。
	*
	* 同一张图在**同一轮**里只上传一次：按字节 sha256 去重。网页端对重复的
	* `ref_file_ids` 会整轮拒绝（并让该会话后续每轮都失败），而宿主完全可能把同
	* 一张图以两个 attachmentId 交过来（例如用户重复拖入、或压缩后重现）。去重只影响
	* 上传列表，`[附图: N]` 标记与正文顺序保持不变。
	*/
	async loadAttachments(refs, signal) {
		if (!this.readImage) return void 0;
		const loaded = [];
		const seen = /* @__PURE__ */ new Set();
		for (const ref of refs) {
			signal?.throwIfAborted();
			try {
				const image = await this.readImage(ref);
				if (!image) continue;
				const digest = createHash("sha256").update(image.data).digest("hex");
				if (seen.has(digest)) {
					console.info(`[deepseek-web] 同一张图本轮已上传过，跳过重复附件：${image.name}`);
					continue;
				}
				seen.add(digest);
				loaded.push(image);
			} catch (error) {
				if (this.config.uploadOnError === "abort") throw new LlmError(`deepseek-web: 读取图片附件失败（${ref.attachmentId.slice(0, 24)}）：${error instanceof Error ? error.message : String(error)}`, "WEB_IMAGE_READ_FAILED", { cause: error });
				console.warn(`[deepseek-web] 跳过一张读不出的图片附件：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return loaded.length > 0 ? loaded : void 0;
	}
	checkReplyEnd(reply) {
		if (reply.finishReason === "interrupted") throw new LlmError("网页明确报告回复被中断，请重试当前任务。", "WEB_REPLY_INTERRUPTED");
		if (reply.finishReason === "max-tokens") throw new LlmError("网页回复达到输出上限，未作为完整交付提交，请缩小单次任务后重试。", "WEB_REPLY_TRUNCATED");
	}
	async *streamTask(options) {
		const sessionId = options.sessionId ?? "anonymous";
		await this.sessions.load();
		const model = options.model;
		if (!normalizeWebModel(model)) throw new LlmError(`deepseek-web: 未知网页模型 ${options.model}`, "UNKNOWN_MODEL");
		const autoSend = model === "deepseek-web-auto";
		this.channel.setSessionAutoSend?.(sessionId, autoSend);
		this.channel.setSessionAutoSend?.("deepseek-self-review", autoSend);
		this.channel.setConversationFocus?.(sessionId);
		await this.channel.ensureReady();
		const savedState = this.sessions.for(sessionId);
		const state = { ...savedState };
		const goalBefore = state.goalText;
		const forceReplay = this.replaySessions.has(sessionId) || this.channel.isConversationActive?.(sessionId) === false;
		const rendered = renderNewWebMessages(options, state, this.config, forceReplay, this.readImage !== void 0);
		if (state.goalText !== goalBefore) {
			state.reviewRoundsUsed = 0;
			state.reviewedSignature = void 0;
		}
		if (!rendered) {
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
			return;
		}
		const attachments = rendered.prompt.attachments?.length ? await this.loadAttachments(rendered.prompt.attachments, options.signal) : void 0;
		if (rendered.prompt.initialize) {
			if (savedState.initialized) console.info("[deepseek-web] 宿主上下文或页面归属变化，重建工作网页对话并回放检查点；继续原 dsh 会话。");
			this.channel.resetConversationGate(sessionId);
			state.initialized = true;
			state.usageBaseline = 0;
		}
		const blocks = { next: 0 };
		let usageDeltaSum = 0;
		let usageObserved = false;
		let reply;
		try {
			reply = yield* this.driveTurnAuto({
				sessionId,
				model,
				text: rendered.prompt.text,
				attachments,
				initialize: rendered.prompt.initialize,
				autoSend,
				signal: options.signal
			}, blocks, state, options);
			usageDeltaSum += this.accountUsage(reply, state, rendered.prompt.initialize);
			usageObserved = usageObserved || reply.accumulatedUsage !== void 0;
		} catch (error) {
			if (error instanceof LlmError) throw error;
			throw new LlmError(`deepseek-web: 网页对话失败: ${error instanceof Error ? error.message : String(error)}`, "WEB_TURN_FAILED", { cause: error });
		}
		this.checkReplyEnd(reply);
		let parsed = parseWebReply(reply.text);
		const visibleTools = visibleToolsOf(options, this.config);
		const allowedToolNames = new Set(visibleTools.map((tool) => tool.name));
		const toolSchemas = new Map(visibleTools.map((tool) => [tool.name, tool]));
		const delegatedNames = new Set(this.config.delegatedTools);
		let delegatedActions = splitDelegatedActions(parsed.actions, delegatedNames);
		let problems = [];
		let correctedChars = 0;
		let delegatedChars = 0;
		let delegatedTurns = 0;
		const revalidate = () => {
			delegatedActions = splitDelegatedActions(parsed.actions, delegatedNames);
			const delegatedSet = new Set(delegatedActions);
			const local = parsed.actions.filter((action) => !delegatedSet.has(action));
			const outcome = parsed.hasActions && (local.length > 0 || delegatedActions.length === 0) ? repairAndValidateActions(local, allowedToolNames, toolSchemas) : {
				actions: local,
				problems: []
			};
			parsed = {
				...parsed,
				actions: outcome.actions,
				hasActions: local.length > 0
			};
			problems = outcome.problems;
		};
		revalidate();
		/**
		* 游标只在完整 chunk 流交给上层之后再落盘：
		* 进程若在回合中途被杀，游标不会超前于 Harness 会话日志。
		*/
		const advanceAndSave = async () => {
			options.signal?.throwIfAborted();
			state.lastMessageId = [...options.messages].reverse().find((message) => message.id)?.id;
			state.roundsSinceProtocol = rendered.prompt.includeProtocol ? 0 : state.roundsSinceProtocol + 1;
			state.lastReply = reply.text;
			Object.assign(savedState, state);
			await this.sessions.save();
		};
		if (this.config.autoCorrectMalformed !== false && delegatedActions.length === 0 && (problems.length > 0 || !parsed.hasActions && (looksLikeIntendedToolReply(reply.text) || looksLikeUnfinishedHandoff(reply.text, state.goalText ?? "") || looksLikeTaskRequest(reply.text) || (options.tools?.length ?? 0) > 0 && looksLikeToolDenial(reply.text)))) {
			const reviewNote = problems.length > 0 ? `\n\n本地审查未通过，请修正后重新输出：\n${problems.map((item) => `- actions[${item.index}]${item.tool ? ` (${item.tool})` : ""}: ${item.problem}`).join("\n")}` : "";
			let correctedReply;
			try {
				correctedReply = yield* this.driveTurnAuto({
					sessionId,
					model,
					text: `${buildRecoveryPrompt(options, state, this.config)}${reviewNote}`,
					initialize: false,
					autoSend,
					signal: options.signal
				}, blocks, state, options);
			} catch (error) {
				throw new LlmError("deepseek-web: 已请求模型纠正输出格式，但等待网页发送超时。请在浏览器中点击发送以完成纠错。", "WEB_CORRECTION_TIMEOUT", { cause: error });
			}
			usageDeltaSum += this.accountUsage(correctedReply, state, false);
			usageObserved = usageObserved || correctedReply.accumulatedUsage !== void 0;
			reply = correctedReply;
			this.checkReplyEnd(reply);
			parsed = parseWebReply(correctedReply.text);
			revalidate();
			correctedChars += correctedReply.text.length + reviewNote.length;
		}
		if (problems.length > 0) {
			console.warn("[deepseek-web] 本地审查拒绝执行，模型原始输出：", reply.text.slice(0, 800));
			throw new LlmError(`本地审查拒绝执行：${problems.map((item) => `actions[${item.index}]${item.tool ? ` (${item.tool})` : ""} ${item.problem}`).join("；")}`, "WEB_ACTION_REJECTED");
		}
		if (!parsed.hasActions && delegatedActions.length === 0 && looksLikeIntendedToolReply(reply.text)) throw new LlmError("网页工具调用格式仍无法完整解析，未作为最终交付提交；请重试当前任务。", "MALFORMED_TOOL_CALL");
		if (delegatedActions.length > 0) {
			const sections = [];
			for (const action of delegatedActions) {
				const name$1 = action.tool ?? action.action ?? "";
				const prompt = buildDelegationPrompt(name$1, action);
				if (!prompt) {
					console.warn("[deepseek-web] 委托动作缺少可识别参数，已跳过：", name$1);
					continue;
				}
				let outcome;
				try {
					outcome = yield* this.driveTurnAuto({
						sessionId,
						model,
						text: prompt,
						initialize: false,
						autoSend,
						signal: options.signal
					}, blocks, state, options);
				} catch (error) {
					throw new LlmError(`deepseek-web: 工具委托轮失败（${name$1}）。请在浏览器中点击发送以完成委托。: ${error instanceof Error ? error.message : String(error)}`, "WEB_DELEGATION_FAILED", { cause: error });
				}
				usageDeltaSum += this.accountUsage(outcome, state, false);
				this.checkReplyEnd(outcome);
				usageObserved = usageObserved || outcome.accumulatedUsage !== void 0;
				const outcomeParsed = parseWebReply(outcome.text);
				sections.push(`[${name$1} 委托结果]\n${outcomeParsed.text}`);
				delegatedChars += prompt.length + outcome.text.length;
				delegatedTurns += 1;
			}
			if (sections.length > 0) parsed = {
				...parsed,
				text: sections.join("\n\n")
			};
		}
		const reviewLabel = this.config.review.provider === "kimi" ? "Kimi" : this.config.review.provider === "glm" ? "GLM" : "DeepSeek";
		let reviewSummary;
		let reviewNoticeIndex = -1;
		let reviewNoticeText = "";
		const reviewLines = (event, detail) => {
			if (!noticeEnabled(this.config.notify, "review", event)) return [];
			const text = formatNotice({
				category: "review",
				event,
				detail
			});
			if (reviewNoticeIndex < 0) {
				reviewNoticeIndex = blocks.next++;
				reviewNoticeText = text;
				return [{
					type: "block-start",
					index: reviewNoticeIndex,
					blockType: "reasoning"
				}, {
					type: "reasoning-delta",
					index: reviewNoticeIndex,
					text
				}];
			}
			const line = `\n${text}`;
			reviewNoticeText += line;
			return [{
				type: "reasoning-delta",
				index: reviewNoticeIndex,
				text: line
			}];
		};
		const reviewBlockEnd = () => reviewNoticeIndex < 0 ? [] : [{
			type: "block-end",
			index: reviewNoticeIndex,
			block: {
				type: "reasoning",
				text: reviewNoticeText
			}
		}];
		if (!parsed.hasActions && this.reviewer && this.config.review.enabled && this.config.review.maxRounds > 0 && state.reviewRoundsUsed < this.config.review.maxRounds && state.reviewedSignature !== reviewSignature(state.goalText ?? "", parsed.text)) {
			for (const chunk of reviewLines("send", `${reviewLabel} 审核：开始检查本轮产出…`)) yield chunk;
			let reviewRound = 0;
			while (reviewRound < this.config.review.maxRounds) {
				reviewRound++;
				const signature = reviewSignature(state.goalText ?? "", parsed.text);
				const evidence = this.reviewer.needsEvidence ? await buildReviewEvidence(options, state, parsed.text, this.config.review.maxEvidenceChars) : {
					task: state.goalText ?? "",
					artifact: "",
					files: []
				};
				let verdict;
				try {
					verdict = await this.reviewer.review(evidence, { conversationSessionId: sessionId });
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					console.warn(`[deepseek-web] ${reviewLabel} 审核失败，跳过本轮审核：`, reason);
					for (const chunk of reviewLines("error", `${reviewLabel} 审核失败，已跳过本轮审核：${reason}`)) yield chunk;
					break;
				}
				state.reviewRoundsUsed += 1;
				state.reviewedSignature = signature;
				console.info(`[deepseek-web] ${reviewLabel} 审核结果：ok=${verdict.ok} issues=${verdict.issues.length}`);
				if (verdict.ok) {
					reviewSummary = [`✅ ${reviewLabel} 审核：通过`, verdict.suggestions.length > 0 ? `建议：${verdict.suggestions.slice(0, 3).join("；")}` : ""].filter(Boolean).join("；");
					for (const chunk of reviewLines("receive", reviewSummary)) yield chunk;
					break;
				}
				reviewSummary = [
					`⚠️ ${reviewLabel} 审核（首版）：未通过，已回注修正`,
					verdict.issues.length > 0 ? `问题：${verdict.issues.slice(0, 3).join("；")}` : "",
					verdict.suggestions.length > 0 ? `建议：${verdict.suggestions.slice(0, 3).join("；")}` : ""
				].filter(Boolean).join("；");
				for (const chunk of reviewLines("receive", reviewSummary)) yield chunk;
				const feedback = [
					"[审核反馈] 独立审核员认为当前产出未通过审核，请修正后重新输出。",
					verdict.issues.length > 0 ? `问题：\n${verdict.issues.map((item) => `- ${item}`).join("\n")}` : "",
					verdict.suggestions.length > 0 ? `建议：\n${verdict.suggestions.map((item) => `- ${item}`).join("\n")}` : "",
					state.goalText ? `${WEB_MARKERS.goal}\n${state.goalText}` : "",
					"若需要调用工具，请只输出 JSON 动作；否则输出修正后的最终正文。"
				].filter(Boolean).join("\n\n");
				const revised = yield* this.driveTurnAuto({
					sessionId,
					model,
					text: feedback,
					initialize: false,
					autoSend,
					signal: options.signal
				}, blocks, state, options);
				usageDeltaSum += this.accountUsage(revised, state, false);
				usageObserved = usageObserved || revised.accumulatedUsage !== void 0;
				reply = revised;
				this.checkReplyEnd(reply);
				parsed = parseWebReply(revised.text);
				revalidate();
				correctedChars += revised.text.length + feedback.length;
				if (problems.length > 0) break;
				if (parsed.hasActions) break;
			}
		}
		for (const chunk of reviewBlockEnd()) yield chunk;
		if (!parsed.hasActions && looksLikeUnfinishedHandoff(parsed.text, state.goalText ?? "")) throw new LlmError("网页仍返回未完成的任务交接摘要，未作为最终交付提交；请重试当前任务。", "WEB_UNFINISHED_HANDOFF");
		if (problems.length > 0) throw new LlmError("审核修正后的工具调用未通过本地校验。", "WEB_ACTION_REJECTED");
		if (!parsed.hasActions && looksLikeIntendedToolReply(parsed.text)) throw new LlmError("网页仍返回无法解析的工具调用，未作为最终交付提交。", "MALFORMED_TOOL_CALL");
		if (!parsed.hasActions) if (autoSend) {} else {
			await this.channel.setWebWindowTopmost?.(sessionId, false).catch(() => {});
			if (this.config.focus?.enabled !== false && this.config.focus?.dshWindow !== false) await this.channel.focusHarness().catch(() => {});
		}
		if (parsed.hasActions) state.lastParseOk = true;
		else state.lastParseOk = false;
		if (usageObserved) {
			const totals = usageDeltaSum > 0 ? this.sessions.addChannelTokens(usageDeltaSum) : this.sessions.getChannelTotals();
			this.onUsage?.(totals);
			console.info(`[deepseek-web] 本轮 token 用量：${usageDeltaSum}（网页会话累计 ${String(state.usageBaseline)}），通道总计：${totals.totalTokens} tokens / ${totals.usageTurns} 轮`);
		}
		yield* replyChunks(parsed, {
			startIndex: blocks.next,
			nextCallId: 1
		});
		await advanceAndSave();
	}
};

//#endregion
//#region src/retry-policy.ts
/**
* 重试预算：限制「同一账号在一段时间内最多用几次自动重发」。
*
* 为什么需要它（而不是只靠每回合的 `maxRetries`）：
* `maxRetries` 是**每回合**的上限，宿主一旦连续自动续跑（长任务、子代理、压缩摘要），
* 每个回合都能各自重试 4 次，叠加起来就是竞品记录过的那类事故——22 分钟里 49 次请求、
* 间隔 8~12 秒，随后账号被吊销。单看每个回合都"合规"，合起来是机器密度。
*
* 因此预算必须活在**回合之外**：进程级、按账号、带 TTL 的计数器。
* 这与竞品 `@wlv-zedd/dsh-chatgpt-web` 的 `retry-policy.ts` 同一思路（那边是因为
* HTTP bridge 每个请求新建 adapter，预算只能活在外面），本项目则是为了跨回合封顶。
*
* @module dsh-deepseek-web/retry-policy
*/
/** 一次重试预算的默认参数。 */
const RETRY_BUDGET = Object.freeze({
	ttlMs: 30 * 6e4,
	maxRetriesInWindow: 3
});
/**
* 只在需要时才计数的预算表。
*
* 语义：`take(key)` 在窗口内还有余量时返回 true 并记一次；用尽返回 false。
* 过期的记录在每次 `take` / `remaining` 时顺手清理，不需要定时器。
*/
var TurnRetryBudget = class {
	attempts = /* @__PURE__ */ new Map();
	now;
	ttlMs;
	max;
	constructor(options = {}) {
		this.now = options.now ?? Date.now;
		this.ttlMs = options.ttlMs ?? RETRY_BUDGET.ttlMs;
		this.max = options.max ?? RETRY_BUDGET.maxRetriesInWindow;
	}
	/** 清掉超过窗口的记录（惰性清理）。 */
	prune(key) {
		const cutoff = this.now() - this.ttlMs;
		const kept = (this.attempts.get(key) ?? []).filter((attempt) => attempt.at > cutoff);
		if (kept.length === 0) this.attempts.delete(key);
		else this.attempts.set(key, kept);
		return kept;
	}
	/** 窗口内还剩几次；`max` 为 0 表示不限（返回 Infinity）。 */
	remaining(key) {
		if (this.max <= 0) return Number.POSITIVE_INFINITY;
		return Math.max(0, this.max - this.prune(key).length);
	}
	/** 取一次预算；用尽返回 false（调用方应直接失败，不再重发）。 */
	take(key) {
		if (this.max <= 0) return true;
		const used = this.prune(key);
		if (used.length >= this.max) return false;
		used.push({ at: this.now() });
		this.attempts.set(key, used);
		return true;
	}
	/** 一次真的成功可以清空该键的计数（别让成功后的偶发失败继承旧账）。 */
	reset(key) {
		this.attempts.delete(key);
	}
	/** 仅供诊断/自检：当前窗口内的使用量。 */
	used(key) {
		return this.prune(key).length;
	}
};
/** 进程级单例：所有通道实例共用一份预算（热重载不重置）。 */
let shared$1;
function sharedRetryBudget() {
	shared$1 ??= new TurnRetryBudget();
	return shared$1;
}

//#endregion
//#region src/pacing.ts
/**
* 回合间隔（pacing）：上一轮网页回合**结束**到下一次真正发请求之间要隔多久。
*
* 为什么单独一个模块：这段逻辑要被离线回归直接调用，不能藏在 Playwright 通道里。
*
* 设计口径（来自竞品实测）：
* - 从「上次请求结束」起算，而不是从「上次请求开始」——否则长回合（几分钟）之后
*   下一轮可以立刻发，节拍仍然是 0 间隔；
* - 区间随机而不是固定值——固定延迟的方差≈0 本身就是最明显的机器特征；
* - 第一次请求（`lastEndedAt <= 0`）不等待，否则每次重启都要白等。
*/
/** 夹到 0 以上的安全整数毫秒。 */
function clampMs(value) {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}
/**
* 计算本轮还需要等待多久才能发请求。
*
* @param lastEndedAt 上一次网页回合结束的时间戳（0 / 负数 = 还没有过回合）
* @param now 当前时间戳
* @param min 间隔下限（毫秒）
* @param max 间隔上限（毫秒）；与 min 顺序颠倒也能工作
* @param random 0~1 的随机源，默认 Math.random（测试可注入固定值）
*/
function computeTurnGap(lastEndedAt, now, min, max, random = Math.random) {
	if (!Number.isFinite(lastEndedAt) || lastEndedAt <= 0) return 0;
	const lo = clampMs(Math.min(min, max));
	const hi = clampMs(Math.max(min, max));
	if (hi === 0) return 0;
	const target = lo + Math.min(1, Math.max(0, random())) * (hi - lo);
	const elapsed = Math.max(0, now - lastEndedAt);
	return Math.max(0, Math.round(target - elapsed));
}
/**
* 记录「上一次网页回合结束的时刻」，进程级共享。
*
* 共享而不是放在通道实例上的理由与账号冷却相同：热重载或重建通道不该让节拍归零，
* 否则「改一次配置」就等于把间隔抹平一次。
*/
var TurnPacer = class {
	lastEndedAt = 0;
	/** 上一次回合结束时间戳；0 表示本进程还没跑过回合。 */
	lastEnd() {
		return this.lastEndedAt;
	}
	/** 回合结束时调用（成功失败都算——失败的请求同样消耗了账号配额）。 */
	noteEnded(at = Date.now()) {
		if (Number.isFinite(at) && at > 0) this.lastEndedAt = at;
	}
	/** 仅供测试：把头清零。 */
	reset() {
		this.lastEndedAt = 0;
	}
};
let shared;
/** 进程级单例（账号只有一个，节拍也该只有一条）。 */
function sharedPacer() {
	shared ??= new TurnPacer();
	return shared;
}

//#endregion
//#region src/browser-shared.ts
const KEEPER_FILE = fileURLToPath(new URL("../tools/browser-keeper.mjs", import.meta.url));
/** 输入区候选选择器（textarea / contenteditable / role=textbox）。 */
const EDITOR_CANDIDATES = [
	"textarea",
	"div[contenteditable=\"true\"]",
	"div[contenteditable=\"plaintext-only\"]",
	"div[role=\"textbox\"]",
	"[data-lexical-editor=\"true\"]"
];
function locateEditor(page) {
	return page.locator(EDITOR_CANDIDATES.join(", ")).filter({ visible: true }).last();
}
/** 网页端“发送过于频繁/稍后重试”一类频控提示的匹配模式。 */
const RATE_LIMIT_PATTERN = /过于频繁|太频繁|发送太快|发送太快了|请.{0,4}稍后.{0,4}(重试|再试)|稍后再试|操作频繁|请求过于|too\s+(many|frequent)|rate[._\s-]?limit(?:ed)?|try\s+again\s+(later|soon)/i;
/**
* 网页端「服务器暂时不可用 / 服务繁忙」一类**服务端临时故障**的匹配模式。
*
* 必须与频控严格区分，两者处置方式相反：
* - 频控 = 这个账号发得太快，要等 10~15 分钟冷却，继续发会把临时限流拖成封号；
* - 服务端故障 = DeepSeek 后端自己过载/重启，跟账号无关，等几十秒到几分钟就恢复。
*
* 网页上两者都以 toast 出现，而且服务端故障的文案常常带「请稍后重试」——
* 早期只按频控判，于是后端抖一下就把账号锁进 10 分钟冷却；而如果完全不认它，
* 又会落进 WEB_UNPARSEABLE_RESPONSE（用户看到的正是「本轮运行失败」）。
*/
const SERVER_BUSY_PATTERN = /服务器.{0,10}(不可用|繁忙|开小差|打盹|过载|超时)|服务(暂时|临时)(不可用|繁忙|过载)|服务繁忙|系统繁忙|请求过于繁忙|当前.{0,8}繁忙|暂时无法(提供)?服务|service\s+(is\s+)?(temporarily\s+)?unavailable|server\s+(is\s+)?(busy|overloaded|unavailable)|temporarily\s+unavailable/i;
/** 判断一段文本（toast 文案 / 错误体）是否是服务端临时故障提示。 */
function looksLikeServerBusyText(text) {
	return SERVER_BUSY_PATTERN.test(text);
}
/** 判断一段文本（toast 文案）是否是频控提示。 */
function looksLikeRateLimitText(text) {
	return RATE_LIMIT_PATTERN.test(text);
}
/**
* 频控响应体判定：**只认明确的错误体**。
*
* 正常回复是 SSE 流（`data: {...}`），正文里出现“稍后重试”是模型在正常说话。
* 早期版本直接对前 2000 字跑正则，于是每一条带“稍后再试”的正常回答都会被判成
* 频控：重发同一条消息、再被判、再重发，最后抛 WEB_RATE_LIMITED。
*/
function isRateLimitResponse(status, body) {
	if (status === 429) return true;
	if (isServerBusyResponse(status, body)) return false;
	const head = body.slice(0, 4e3);
	if (/^\s*(data:|event:)/.test(head) || head.includes("\ndata:")) {
		const errorFrame = /"error"\s*:\s*\{[^}]*\}/.exec(head);
		if (errorFrame === null) return false;
		return looksLikeRateLimitText(errorFrame[0]) || errorFrame[0].includes("429");
	}
	const trimmed = body.trim();
	if (trimmed.length === 0 || trimmed.length > 500) return false;
	return looksLikeRateLimitText(trimmed);
}
/**
* 服务端临时故障判定：HTTP 502/503/504，或响应体是明确的「服务器暂时不可用」错误帧。
*
* 只认**明确的错误体**，与频控一样不扫正文：模型正常回答里出现「服务器暂时不可用」
* 这句话（比如在讲运维）不该把整轮判成故障。
*/
function isServerBusyResponse(status, body) {
	if (status === 502 || status === 503 || status === 504) return true;
	const head = body.slice(0, 4e3);
	if (/^\s*(data:|event:)/.test(head) || head.includes("\ndata:")) {
		const errorFrame = /"error"\s*:\s*\{[^}]*\}/.exec(head);
		if (errorFrame !== null) return looksLikeServerBusyText(errorFrame[0]);
		const typeFrame = /"type"\s*:\s*"error"[^\n]{0,300}/.exec(head);
		return typeFrame !== null && looksLikeServerBusyText(typeFrame[0]);
	}
	const trimmed = body.trim();
	if (trimmed.length === 0 || trimmed.length > 500) return false;
	return looksLikeServerBusyText(trimmed.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim());
}
/** 插件自己画在网页右下角的那块浮层的 id（它本身带着频控字眼，必须排除）。 */
const PAGE_NOTICE_ID = "dsh-web-notice";
/**
* 频控 toast 的“已认领”标记属性。
*
* 检测器每 800ms 扫一次全页，而 toast 往往**视觉上消失、节点仍留在 DOM 里**
* （父容器 display:none、淡出后 opacity:0、被移出视口……）。没有这层标记，
* 一条旧提示会让之后每一轮发送都在第一拍被判成频控：重发 5 次、共等 12 分钟、
* 最后报 WEB_RATE_LIMITED——用户看到的是“网页上什么都没有，却一直失败”。
*/
const RATE_LIMIT_SEEN_ATTR = "data-dsh-rate-limit-seen";
/**
* 「服务器暂时不可用」提示的认领标记属性（与频控分开记）。
*
* 为什么不能复用频控那个属性：两类的判据和处置都不同，共用标记会让一个
* 已认领的频控节点顺带把同文案的服务端故障也认领掉，反之亦然。
*/
const SERVER_BUSY_SEEN_ATTR = "data-dsh-server-busy-seen";
/**
* 页面内扫描：是否正显示某一类提示（频控 / 服务端不可用）。
*
* 抽成一个模块级函数，让两类提示共用同一套可见性判据——早期两处各写一份，
* 改了一边忘了另一边，线上就出现「页面上明明有提示，却一律判不出来」。
*
* 判据（都是真实踩过的坑）：
* 1. 可见性沿祖先链判断（`checkVisibility`），父容器 `display:none` / `opacity:0`
*    的残留节点不再算“正在显示”；
* 2. 完全移出视口、零尺寸的节点算已消失；
* 3. 排除插件自己画的浮层（它的文案本身就能命中原正则，会形成自锁）；
* 4. 已被之前某一轮认领过的旧节点不再重复计数——只有**这一轮之后新出现的**才算数。
*
* 注意：函数体会被 `toString()` 后注入页面执行，**不要**在里面写具名函数表达式——
* esbuild 的 keepNames 会把它包成 `__name(...)`，而页面里没有这个 helper，
* 整个回调会抛错并被 `.catch` 吞成 false。
*/
function scanNoticeToasts(params) {
	const pattern = new RegExp(params.patternSource, "i");
	const editors = Array.from(document.querySelectorAll("textarea, [contenteditable=\"true\"], [contenteditable=\"plaintext-only\"], [role=\"textbox\"]"));
	const selfPaint = document.getElementById(params.noticeId);
	const elements = Array.from(document.querySelectorAll("div, span, p, section, aside"));
	for (const element of elements) {
		if (!element.isConnected) continue;
		if (editors.some((editor) => editor.contains(element))) continue;
		if (selfPaint !== null && (element === selfPaint || selfPaint.contains(element))) continue;
		const text = (element.textContent ?? "").trim();
		if (text.length === 0 || text.length > 120) continue;
		if (element.childElementCount > 2) continue;
		if (element.getAttribute(params.seenAttr) === text) continue;
		if (!pattern.test(text)) continue;
		const maybeCheck = element.checkVisibility;
		let shown = true;
		if (typeof maybeCheck === "function") shown = maybeCheck.call(element, {
			checkOpacity: true,
			checkVisibilityCSS: true
		});
		else for (let node = element; node !== null; node = node.parentElement) {
			const style = window.getComputedStyle(node);
			if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || node.hasAttribute("hidden")) {
				shown = false;
				break;
			}
		}
		if (!shown) continue;
		const rect = element.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) continue;
		if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) continue;
		let clipTop = 0;
		let clipLeft = 0;
		let clipRight = window.innerWidth;
		let clipBottom = window.innerHeight;
		let hasClip = false;
		for (let node = element.parentElement; node !== null; node = node.parentElement) {
			const style = window.getComputedStyle(node);
			if (!/hidden|clip/.test(`${style.overflowX} ${style.overflowY}`)) continue;
			const box = node.getBoundingClientRect();
			clipTop = Math.max(clipTop, box.top);
			clipLeft = Math.max(clipLeft, box.left);
			clipRight = Math.min(clipRight, box.right);
			clipBottom = Math.min(clipBottom, box.bottom);
			hasClip = true;
		}
		if (hasClip && (rect.bottom <= clipTop || rect.top >= clipBottom || rect.right <= clipLeft || rect.left >= clipRight)) continue;
		return true;
	}
	return false;
}
/** 页面里是否正显示频控 toast。 */
async function hasRateLimitToast(page) {
	return await page.evaluate(scanNoticeToasts, {
		patternSource: RATE_LIMIT_PATTERN.source,
		seenAttr: RATE_LIMIT_SEEN_ATTR,
		noticeId: PAGE_NOTICE_ID
	}).catch(() => false);
}
/** 页面里是否正显示「服务器暂时不可用」类提示（与频控分开判定，处置方式相反）。 */
async function hasServerBusyToast(page) {
	return await page.evaluate(scanNoticeToasts, {
		patternSource: SERVER_BUSY_PATTERN.source,
		seenAttr: SERVER_BUSY_SEEN_ATTR,
		noticeId: PAGE_NOTICE_ID
	}).catch(() => false);
}
/**
* 页面内认领：给“此刻已经存在的某一类提示节点”打上标记。
*
* 语义：从这一轮发送开始，只有**新冒出来**的提示才算新提示。上一轮留下的、
* 或网页历史上早就挂着的，都不会再把本轮拦下来。返回打标记的节点数，仅用于日志。
*/
function claimNoticeToasts(params) {
	const pattern = new RegExp(params.patternSource, "i");
	const selfPaint = document.getElementById(params.noticeId);
	const elements = Array.from(document.querySelectorAll("div, span, p, section, aside"));
	let marked = 0;
	for (const element of elements) {
		if (!element.isConnected) continue;
		if (selfPaint !== null && (element === selfPaint || selfPaint.contains(element))) continue;
		const text = (element.textContent ?? "").trim();
		if (text.length === 0 || text.length > 120) continue;
		if (element.childElementCount > 2) continue;
		if (!pattern.test(text)) continue;
		element.setAttribute(params.seenAttr, text);
		marked += 1;
		if (marked >= 50) break;
	}
	return marked;
}
/**
* 发送前给“此刻页面上已经存在的频控文案节点”打上认领标记。
*
* 少了这一步，上一轮残留的 toast（视觉上消失、节点仍在 DOM 里）会让每一轮
* 都在第一拍被判死——网页上明明没有提示，却一直失败。
*/
async function markRateLimitToastsSeen(page) {
	return await page.evaluate(claimNoticeToasts, {
		patternSource: RATE_LIMIT_PATTERN.source,
		seenAttr: RATE_LIMIT_SEEN_ATTR,
		noticeId: PAGE_NOTICE_ID
	}).catch(() => 0);
}
/** 发送前认领“服务器暂时不可用”类旧节点，避免上一轮的提示把本轮判死。 */
async function markServerBusyToastsSeen(page) {
	return await page.evaluate(claimNoticeToasts, {
		patternSource: SERVER_BUSY_PATTERN.source,
		seenAttr: SERVER_BUSY_SEEN_ATTR,
		noticeId: PAGE_NOTICE_ID
	}).catch(() => 0);
}
async function ensureChatPage(page, url) {
	if (!page.url().startsWith(new URL(url).origin)) await page.goto(url, {
		waitUntil: "domcontentloaded",
		timeout: 6e4
	});
	else await page.bringToFront();
}
async function looksLoggedOut(page, markers = [
	"sign_in",
	"sign-in",
	"login",
	"auth"
]) {
	const current = new URL(page.url());
	if (await locateEditor(page).isVisible().catch(() => false)) return false;
	return markers.some((marker) => current.pathname.includes(marker) || current.search.includes(marker));
}
/**
* 发送控件是否处于不可用状态。
*
* 登录墙的典型形态之一：输入框可见、也能填入文字，但发送按钮是 disabled
* （chat.z.ai 未登录时正是如此），表现是“填进去了、回车/点发送都没反应”。
* 找不到发送控件时返回 false（例如只认回车的站点），不误判正常页面。
*/
async function looksSendBlocked(page) {
	const control = page.locator([
		"button[class*=\"sendMessage\" i]",
		"button[aria-label*=\"发送\"]",
		"button[aria-label*=\"send\" i]",
		"button[title*=\"发送\"]",
		"button[title*=\"send\" i]",
		"[role=\"button\"][aria-label*=\"发送\"]",
		"[role=\"button\"][aria-label*=\"send\" i]"
	].join(", ")).first();
	if (await control.count().catch(() => 0) === 0) return false;
	if (!await control.isVisible().catch(() => false)) return false;
	return await control.evaluate((element) => element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" || /(^|[\s_-])disabled([\s_-]|$)/i.test(element.className)).catch(() => false);
}
/**
* 给一个 promise 加超时，超时抛出带稳定错误码的 LlmError。
*
* `response.body()` / `response.finished()` 都没有 timeout 参数：网页流一旦卡住，
* 这两个 promise 会一直挂着，整轮就“卡死、不会重新获取”。包一层超时后，
* 卡住会变成一次明确的失败，上层才有机会重连重试。
*/
function withTimeout(promise, ms, code, message) {
	if (!(ms > 0)) return promise;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new LlmError(message, code)), ms);
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
/**
* 「浏览器/标签页已经被关掉」的报错特征。
*
* Playwright 在连接断掉时抛的是纯文本（`Target page, context or browser has been closed`
* / `Browser has been closed`），不给我们错误码；而插件自己的 `WEB_PAGE_CLOSED` 是另一条路。
* 自愈只该被这两类触发，频控、超时、用户取消都不能被当成"重启浏览器"。
*/
const BROWSER_CLOSED_PATTERN = /Target (?:page|context|browser)[^\n]{0,40}closed|Browser has been closed|browser has been closed|has been disconnected|Connection closed|connection closed|连接已关闭|连接已断开/u;
/** 这条报错是不是「浏览器被关了」造成的。 */
function isBrowserClosedMessage(text) {
	return BROWSER_CLOSED_PATTERN.test(text);
}
/**
* 把「审核窗口入口地址」补成「一定会新开对话」的地址。
*
* 用户在设置里填的就是新标签页要打开的链接，所以这里只做一件事：确保带上站点
* 自己的建新参数（Kimi 是 `chat_enter_method=new_chat`）。已经带了就原样返回，
* 让用户能完全接管地址（比如换成企业版域名、加自己的查询参数）。
*
* 注意这是**尽力而为**：Kimi 的项目页（`/project/<id>`）即使带上这个参数，
* 发消息时也会跳到 `/chat/<uuid>` 普通对话（实测），参数只保证「打开时是空的对 话」，
* 不保证「对话归属到那个项目」。
*/
function ensureFreshChatUrl(raw, param = "chat_enter_method=new_chat") {
	const trimmed = (typeof raw === "string" ? raw : "").trim();
	if (!trimmed) return trimmed;
	const [key, value = ""] = param.split("=");
	try {
		const url = new URL(trimmed);
		if (url.searchParams.has(key)) return url.toString();
		url.searchParams.set(key, value);
		return url.toString();
	} catch {
		return trimmed;
	}
}
/** 发送按钮候选选择器（点击发送的兜底路径，与 looksSendBlocked 共用语义）。 */
const SEND_BUTTON_CANDIDATES = [
	"button[class*=\"sendMessage\" i]",
	"button[aria-label*=\"发送\"]",
	"button[aria-label*=\"send\" i]",
	"button[title*=\"发送\"]",
	"button[title*=\"send\" i]",
	"[role=\"button\"][aria-label*=\"发送\"]",
	"[role=\"button\"][aria-label*=\"send\" i]",
	"[data-testid*=\"send\" i]"
];
/** 定位发送按钮（不可用/不存在时返回未命中的 locator）。 */
function locateSendButton(page) {
	return page.locator(SEND_BUTTON_CANDIDATES.join(", ")).first();
}
/**
* 读取输入框当前文本。
*
* textarea/input 走 `inputValue()`；contenteditable 走 `innerText`。
* 两者都要能读到，否则“发送后是否清空”的判断在 Kimi（contenteditable）
* 与部分站点（textarea）上会有一半失效。
*/
async function readEditorText(editor) {
	const tagName = await editor.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
	if (tagName === "textarea" || tagName === "input") return (await editor.inputValue().catch(() => "")).trim();
	return (await editor.innerText().catch(() => "")).trim();
}
/**
* 把输入框里已填好的内容真正发出去，并**确认**它发出去了。
*
* 这是“文字填进去了、但没发送、必须人工点一下”这个问题的根治点：
* 只按一次回车是不够的——不同站点/不同版本对回车键的处理不同（有的发送、
* 有的换行、有的被输入法或焦点吃掉），所以流程是
* `回车 → 观察输入框是否清空 → 没清空就点发送按钮 → 再观察 → 仍不行才报失败`。
*
* 判定“已发送”的信号（任一命中即可）：
* 1. 输入框被清空（绝大多数站点发送后清空输入区）；
* 2. 外部 `hasResponse()` 返回 true（网络层已经看到本轮请求）；
* 3. 发送按钮从“可用”变成“不可用/消失”（生成中按钮态）。
*
* 整个过程受 `isCancelled()` 约束：宿主取消回合时立刻停止尝试，不拖时间。
*/
async function sendEditorMessage(page, editor, options = {}) {
	const finiteInt = (input, fallback, min, max) => {
		const value = Number(input);
		if (!Number.isFinite(value)) return fallback;
		return Math.max(min, Math.min(max, Math.trunc(value)));
	};
	const verifyTimeoutMs = finiteInt(options.verifyTimeoutMs, 1500, 200, 6e4);
	const maxAttempts = finiteInt(options.maxAttempts, 2, 1, 5);
	const pauseMinMs = finiteInt(options.pauseMinMs, 0, 0, 5e3);
	const pauseMaxMs = finiteInt(options.pauseMaxMs, pauseMinMs, pauseMinMs, 5e3);
	const isCancelled = options.isCancelled ?? (() => false);
	const hasResponse = options.hasResponse ?? (() => false);
	const attempts = [];
	const before = await readEditorText(editor);
	if (before.length === 0) return {
		sent: false,
		via: "none",
		attempts: ["输入框为空，没有可发送的内容"]
	};
	/** 等待“已发送”信号；命中返回 true。 */
	const waitSent = async () => {
		const deadline = Date.now() + verifyTimeoutMs;
		while (Date.now() < deadline) {
			if (isCancelled()) return false;
			if (hasResponse()) return true;
			const current = await readEditorText(editor).catch(() => before);
			if (current.length === 0 || current.length < before.length / 2) return true;
			await page.waitForTimeout(80);
		}
		return false;
	};
	const randomPause = async () => {
		if (pauseMaxMs <= 0) return;
		const span = pauseMaxMs - pauseMinMs;
		const delay = pauseMinMs + (span > 0 ? Math.floor(Math.random() * span) : 0);
		await page.waitForTimeout(delay);
	};
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		if (isCancelled()) break;
		await editor.focus().catch(() => {});
		await randomPause();
		if (isCancelled()) break;
		const pressed = await page.keyboard.press("Enter").then(() => true).catch(() => false);
		attempts.push(`第 ${attempt} 轮回车：${pressed ? "已按下" : "按键失败"}`);
		if (pressed && await waitSent()) return {
			sent: true,
			via: "enter",
			attempts
		};
		if (isCancelled()) break;
		const button = locateSendButton(page);
		if (await button.isVisible().catch(() => false)) if (await button.evaluate((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true").catch(() => false)) {
			const clicked = await button.click({ timeout: 3e3 }).then(() => true).catch(() => false);
			attempts.push(`第 ${attempt} 轮点发送按钮：${clicked ? "已点击" : "点击失败"}`);
			if (clicked && await waitSent()) return {
				sent: true,
				via: "button",
				attempts
			};
		} else attempts.push(`第 ${attempt} 轮点发送按钮：按钮不可用`);
		else attempts.push(`第 ${attempt} 轮点发送按钮：未找到发送控件`);
	}
	return {
		sent: false,
		via: "none",
		attempts
	};
}
/**
* 登录墙判定：URL 命中登录标记，或“输入框可见 + 页面有登录入口 + 发送控件被禁用”。
*
* 只按 URL 判断会漏掉 chat.z.ai 这类站点：未登录时停在首页、输入框照样可见，
* 直到用户点发送才发现发不出去。把“发不出去”的信号也纳入判定后，通道可以
* 立刻抛出“请先登录”的明确错误，而不是让用户等满一轮超时。
*/
async function looksLoginWall(page, markers = [
	"sign_in",
	"sign-in",
	"login",
	"auth",
	"passport"
]) {
	const current = new URL(page.url());
	if (markers.some((marker) => current.pathname.includes(marker) || current.search.includes(marker))) return true;
	if (!await locateEditor(page).isVisible().catch(() => false)) return false;
	if (!await page.getByText(/^\s*(登录|登入|立即登录|Sign in|Sign in \/ Sign up|Log in|Login)\s*$/i).first().isVisible().catch(() => false)) return false;
	return await looksSendBlocked(page);
}
/**
* 尝试点击“开启新对话/New chat”入口。返回是否成功触发点击。
*
* 全自动模式下 DeepSeek 标签页常处于后台，`locator.click()` 依赖元素可命中
* （visible/stable/receives events），后台标签页里侧栏可能未布局，点击会静默失败，
* 从而沿用上一次网页对话。因此除定位器点击外，追加页面内原生 DOM 点击兜底：
* 它不要求标签页在前台，也不要求元素可命中。
*
* 注意：返回 true 只代表“点到了某个入口”，不代表新对话真的建起来了。
* 站点是 SPA 时点击可能不产生任何跳转，调用方必须自己验证（见 Kimi 通道的
* `openFreshConversation`，它在点击无效时回退到直接跳首页）。
*/
async function bestEffortNewChat(page, options = {}) {
	for (const selector of options.selectors ?? []) try {
		const element = page.locator(selector).first();
		if (await element.isVisible().catch(() => false)) {
			if (await element.click({ timeout: 3e3 }).then(() => true).catch(() => false)) return true;
		}
	} catch {}
	const labels = [
		...options.labels ?? [],
		"开启新对话",
		"新建对话",
		"新建会话",
		"新对话",
		"新话题",
		"New chat",
		"New Chat",
		"New topic"
	];
	for (const label of labels) {
		const candidate = page.getByText(label, { exact: true }).first();
		if (await candidate.isVisible().catch(() => false)) {
			if (await candidate.click({ timeout: 3e3 }).then(() => true).catch(() => false)) return true;
		}
	}
	const roleButton = page.getByRole("button", { name: /新建对话|新对话|新话题|New chat|New topic/i }).first();
	if (await roleButton.isVisible().catch(() => false)) {
		if (await roleButton.click({ timeout: 3e3 }).then(() => true).catch(() => false)) return true;
	}
	return await page.evaluate((texts) => {
		const norm = (value) => (value ?? "").replace(/\s+/gu, " ").trim();
		const elements = Array.from(document.querySelectorAll("button, a, [role=\"button\"], div, span"));
		for (const label of texts) {
			const exact = elements.find((el) => norm(el.textContent) === label);
			if (exact) {
				exact.click();
				return true;
			}
		}
		for (const label of texts) {
			const partial = elements.find((el) => {
				const aria = norm(el.getAttribute("aria-label"));
				const title = norm(el.getAttribute("title"));
				const text = norm(el.textContent);
				return aria.includes(label) || title.includes(label) || text.includes(label) && text.length <= label.length + 4;
			});
			if (partial) {
				partial.click();
				return true;
			}
		}
		return false;
	}, labels).catch(() => false);
}
/** 用标题前缀提示当前状态（等待人工点击/生成中/需要选择）。 */
async function markPageTitle(page, marker, state) {
	if (state.original === void 0) state.original = await page.title();
	const clean = state.original.replace(/^\[[^\]]*\]\s*/u, "");
	await page.evaluate(({ title, prefix }) => {
		document.title = prefix ? `${prefix} ${title}` : title;
	}, {
		title: clean,
		prefix: marker
	}).catch(() => {});
}
/** 启动/复用脱离本进程的浏览器常驻守护。 */
function spawnKeeper(options) {
	spawn(process.execPath, [
		KEEPER_FILE,
		"--profile",
		options.profileDir,
		"--port",
		String(options.port),
		"--url",
		options.url
	], {
		detached: true,
		stdio: "ignore",
		windowsHide: true
	}).unref();
}
function browserCandidates(channel) {
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA ?? "";
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
		if (channel === "msedge") return [
			path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
			path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
			path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe")
		];
		return [
			path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
			path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
			path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
		];
	}
	if (process.platform === "darwin") return channel === "msedge" ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
	return channel === "msedge" ? ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"] : [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium"
	];
}
/**
* 解析当前平台上的浏览器可执行文件。
*
* 导出给 doctor 用：自检要能回答「本机到底有没有 Edge/Chrome、装在哪」，
* 而不是等启动时才抛 BROWSER_NOT_FOUND。返回 undefined 表示没找到。
*/
function resolveBrowserExecutable(channel) {
	return browserCandidates(channel).find((candidate) => existsSync(candidate));
}
/** 选择 preferredPort；被占用时改用系统分配的本地空闲端口。 */
async function findAvailablePort(preferredPort) {
	const probe = (port) => new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(void 0));
		server.listen(port, "127.0.0.1", () => {
			const address = server.address();
			const selected = typeof address === "object" && address ? address.port : void 0;
			server.close(() => resolve(selected));
		});
	});
	return await probe(preferredPort) ?? await probe(0) ?? preferredPort;
}
/**
* 启动插件自有的真实 Edge/Chrome，再通过 CDP 连接。
*
* 这里刻意不使用 Playwright 的 launchPersistentContext：直接启动用户安装的
* 浏览器可以避免 Playwright 自动注入的启动参数，同时仍保留独立 profile 和
* 可控的浏览器生命周期。
*/
async function launchManagedBrowser(options) {
	const executable = resolveBrowserExecutable(options.channel);
	if (!executable) throw new LlmError(`${options.label}: 找不到 ${options.channel === "msedge" ? "Microsoft Edge" : "Google Chrome"} 可执行文件。`, "BROWSER_NOT_FOUND");
	const port = await findAvailablePort(options.preferredPort);
	const child = spawn(executable, [
		`--user-data-dir=${options.profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--remote-debugging-address=127.0.0.1",
		`--remote-debugging-port=${port}`,
		...options.channel === "msedge" ? ["--disable-features=msEdgeSidebarV2"] : []
	], {
		detached: false,
		stdio: "ignore",
		windowsHide: false
	});
	const endpoint = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 60; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 1e3));
		try {
			const browser = await chromium.connectOverCDP(endpoint);
			const context = browser.contexts()[0];
			if (context) return {
				browser,
				context,
				process: child,
				port
			};
			await browser.close().catch(() => {});
		} catch {}
	}
	child.kill();
	throw new LlmError(`${options.label}: ${options.channel} 已启动，但 CDP ${port} 在 60 秒内未就绪。`, "BROWSER_MANAGED_START_FAILED");
}
/** 连接（必要时拉起守护）CDP 浏览器。 */
async function connectBrowser(options) {
	const endpoint = `http://127.0.0.1:${options.port}`;
	try {
		const browser = await chromium.connectOverCDP(endpoint);
		const context = browser.contexts()[0];
		if (!context) throw new LlmError(`${options.label}: CDP 浏览器没有可用 context`, "BROWSER_ATTACH_FAILED");
		return {
			browser,
			context
		};
	} catch (error) {
		if (!options.autoStartKeeper) throw error;
		spawnKeeper({
			profileDir: options.profileDir,
			port: options.port,
			url: options.url
		});
		const deadline = Date.now() + 6e4;
		let waited = 0;
		while (Date.now() < deadline) {
			const delay = waited < 3e3 ? 150 : 500;
			await new Promise((resolve) => setTimeout(resolve, delay));
			waited += delay;
			try {
				const browser = await chromium.connectOverCDP(endpoint);
				const context = browser.contexts()[0];
				if (context) return {
					browser,
					context
				};
			} catch {}
		}
		throw new LlmError(`${options.label}: 无法连接浏览器常驻进程（CDP ${options.port} 60 秒内未就绪）。`, "BROWSER_ATTACH_FAILED");
	}
}
/** 默认的浏览器 profile 目录（工作区外）。 */
function defaultProfileDir(name$1) {
	const appDataRoot = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
	return path.join(appDataRoot, "DshDeepSeekWeb", name$1);
}
/**
* 把 dsh 宿主窗口提到最前（“放在屏幕最上端”）。
*
* 仅在 Windows 上生效：用 PowerShell 枚举顶层窗口，按进程名或标题正则
* 匹配第一个可见窗口并调用 SetForegroundWindow。找不到匹配时静默返回 false，
* 不抛异常，避免影响主流程。
*/
async function focusDshWindow(options) {
	if (process.platform !== "win32") return false;
	const names = (options.processNames ?? []).map((name$1) => String(name$1).trim()).filter((name$1) => name$1.length > 0);
	const pattern = (options.titlePattern ?? "").trim();
	if (names.length === 0 && !pattern) return false;
	const script = buildFocusScript(names, pattern);
	return await new Promise((resolve) => {
		const child = spawn("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		], {
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		});
		let out = "";
		const timer = setTimeout(() => {
			child.kill();
			console.warn("[deepseek-web] focusDshWindow: 聚焦脚本执行超时（5s），已放弃并继续主流程。");
			resolve(false);
		}, 5e3);
		child.stdout?.on("data", (chunk) => {
			out += String(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			console.warn("[deepseek-web] focusDshWindow: 无法启动 powershell.exe：", error.message);
			resolve(false);
		});
		child.on("close", () => {
			clearTimeout(timer);
			const ok = out.trim() === "1";
			if (!ok) console.warn(`[deepseek-web] focusDshWindow: 未匹配到 dsh 窗口，已静默跳过。 进程名候选=${JSON.stringify(names)} 标题正则=${JSON.stringify(pattern)}`);
			resolve(ok);
		});
	});
}
/**
* 生成聚焦脚本。
*
* 注意：窗口枚举与匹配全部放在 C# 内完成（包括用 .NET 的 Process 取进程名），
* 不依赖 PowerShell 委托回调的 runspace 与 $script: 作用域——后者在
* EnumWindows 回调里写回外层变量并不可靠，会静默失败。
*/
function buildFocusScript(processNames, titlePattern) {
	const namesJson = JSON.stringify(processNames);
	const patternJson = JSON.stringify(titlePattern);
	return [
		"$ErrorActionPreference='SilentlyContinue'",
		"Add-Type @\"",
		"using System;",
		"using System.Text;",
		"using System.Diagnostics;",
		"using System.Runtime.InteropServices;",
		"public class DshFocus {",
		"  [DllImport(\"user32.dll\")] static extern bool SetForegroundWindow(IntPtr h);",
		"  [DllImport(\"user32.dll\")] static extern bool ShowWindow(IntPtr h, int c);",
		"  [DllImport(\"user32.dll\")] static extern bool IsWindowVisible(IntPtr h);",
		"  [DllImport(\"user32.dll\")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);",
		"  [DllImport(\"user32.dll\")] static extern int GetWindowTextLength(IntPtr h);",
		"  [DllImport(\"user32.dll\")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
		"  delegate bool EnumProc(IntPtr h, IntPtr l);",
		"  [DllImport(\"user32.dll\")] static extern bool EnumWindows(EnumProc cb, IntPtr l);",
		"  public static IntPtr Target = IntPtr.Zero;",
		"  static string[] Names = new string[0];",
		"  static string Pattern = \"\";",
		"  public static string Find(string[] names, string pattern) {",
		"    Names = names ?? new string[0];",
		"    Pattern = pattern ?? \"\";",
		"    Target = IntPtr.Zero;",
		"    EnumWindows(delegate(IntPtr h, IntPtr l) {",
		"      if (!IsWindowVisible(h)) return true;",
		"      int len = GetWindowTextLength(h);",
		"      if (len <= 0) return true;",
		"      var sb = new StringBuilder(len + 1);",
		"      GetWindowText(h, sb, sb.Capacity);",
		"      string text = sb.ToString();",
		"      uint pid = 0;",
		"      GetWindowThreadProcessId(h, out pid);",
		"      string pname = \"\";",
		"      try { pname = Process.GetProcessById((int)pid).ProcessName; } catch {}",
		"      bool hit = false;",
		"      foreach (var n in Names) {",
		"        if (!string.IsNullOrEmpty(n) && string.Equals(n, pname, StringComparison.OrdinalIgnoreCase)) { hit = true; break; }",
		"      }",
		"      if (!hit && Pattern.Length > 0) {",
		"        try { if (System.Text.RegularExpressions.Regex.IsMatch(text, Pattern)) hit = true; } catch {}",
		"      }",
		"      if (hit) { Target = h; return false; }",
		"      return true;",
		"    }, IntPtr.Zero);",
		"    return Target.ToString();",
		"  }",
		"  public static void Activate() {",
		"    ShowWindow(Target, 9);",
		"    SetForegroundWindow(Target);",
		"  }",
		"}",
		"\"@",
		`[string[]]$names = @(ConvertFrom-Json '${namesJson}')`,
		`[string]$pattern = [string](ConvertFrom-Json '${patternJson}')`,
		"$found = [DshFocus]::Find($names, $pattern)",
		"if ($found -ne \"0\") {",
		"  [DshFocus]::Activate()",
		"  Write-Output '1'",
		"} else {",
		"  Write-Output '0'",
		"}"
	].join("\n");
}
/**
* 设置插件浏览器窗口是否置顶（屏幕最上方）。
*
* 仅 Windows 生效：按命令行里的 profile 目录特征定位插件专用的 msedge 窗口，
* SetWindowPos(HWND_TOPMOST/NOTOPMOST)，置顶时同时 SetForegroundWindow。
* 进程匹配放在 PowerShell 管道里完成（Get-CimInstance 提供 CommandLine，
* Get-Process 提供 MainWindowHandle），只把句柄交给 P/Invoke。
* 找不到匹配时静默返回 false，不影响主流程。
*/
async function setBrowserWindowTopmost(options) {
	if (process.platform !== "win32") return false;
	const marker = String(options.profileDir ?? "").trim();
	if (!marker) return false;
	const markerJson = JSON.stringify(marker);
	const topmostJson = JSON.stringify(options.topmost === true);
	const script = [
		"$ErrorActionPreference='SilentlyContinue'",
		`[string]$marker = [string](ConvertFrom-Json '${markerJson}')`,
		`[bool]$topmost = [bool](ConvertFrom-Json '${topmostJson}')`,
		`$pattern = '*' + $marker + '*'`,
		`$ids = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like $pattern } | ForEach-Object { $_.ProcessId })`,
		"if ($ids.Count -eq 0) { Write-Output \"0\"; exit }",
		"Add-Type @\"",
		"using System;",
		"using System.Runtime.InteropServices;",
		"public class DshTop {",
		"  [DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);",
		"  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);",
		"  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);",
		"  public static void Apply(IntPtr h, bool topmost) {",
		"    IntPtr after = topmost ? new IntPtr(-1) : new IntPtr(-2);",
		"    SetWindowPos(h, after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);",
		"    if (topmost) SetForegroundWindow(h);",
		"  }",
		"}",
		"\"@",
		"$hit = 0",
		"Get-Process -Name msedge | Where-Object { $ids -contains $_.Id -and $_.MainWindowHandle -ne 0 } | ForEach-Object {",
		"  if ([DshTop]::IsWindowVisible($_.MainWindowHandle)) { [DshTop]::Apply($_.MainWindowHandle, $topmost); $hit++ }",
		"}",
		"if ($hit -gt 0) { Write-Output \"1\" } else { Write-Output \"0\" }"
	].join("\n");
	return await new Promise((resolve) => {
		const child = spawn("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		], {
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		});
		let out = "";
		const timer = setTimeout(() => {
			child.kill();
			console.warn("[deepseek-web] setBrowserWindowTopmost: 脚本执行超时（5s），已放弃并继续主流程。");
			resolve(false);
		}, 5e3);
		child.stdout?.on("data", (chunk) => {
			out += String(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			console.warn("[deepseek-web] setBrowserWindowTopmost: 无法启动 powershell.exe：", error.message);
			resolve(false);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0 && out.trim() === "1");
		});
	});
}

//#endregion
//#region src/playwright-channel.ts
/**
* 实时增量轮询间隔。
*
* 这个轮询只读页面里的 `window.__dshWebCapture`（一次 evaluate、几个字段），
* 不产生任何网络请求，也不碰 DOM 样式计算，所以可以压到 250ms：
* 思考文本几乎跟着网页同步出现，而不是原来 800ms 一跳的“一卡一卡”。
*/
const PROGRESS_POLL_MS = 250;
/**
* 频控 toast 检测间隔。
*
* 它要遍历大量 DOM 元素并逐个读 computed style，开销比增量轮询高一个量级，
* 因此与增量轮询拆开：保持 800ms 低频，避免高频扫描把页面拖慢。
*/
const RATE_LIMIT_POLL_MS = 800;
/**
* 从“按下发送”到“看到 HTTP 响应头”的等待上限。
*
* 网页版正常 1~3 秒就会回响应头；等满 3 分钟还没有，说明消息根本没发出去
*（页面弹了遮挡层）或站点异常。原来这里直接吃 `streamIdleTimeoutMs`
*（默认 600 秒）——用户看到的就是“卡住十分钟、不会重来”。自动发送时取
* `min(streamIdleTimeoutMs, SEND_ACK_TIMEOUT_MS)` 并给出准确定位；人工发送时不压，
* 因为这一段等的是“人去点发送按钮”，3 分钟之外的限制太苛刻（去倒杯水就报超时，
* 频控重发期间每一轮都要点一次，更容易踩到）。
*/
const SEND_ACK_TIMEOUT_MS = 18e4;
/**
* 单条消息长度告警线。
*
* 实测（本机 Edge，chat.deepseek.com 输入框）：10 万字符约 1.1 秒、30 万约 13 秒、
* 60 万约 77 秒，接近二次方增长；110 万字符会把页面主线程拖死到连 CDP 都连不上。
* 超过这条线就在日志和页面标题上显式提示"正在填入 N 字"，避免被当成卡死。
*/
const LONG_TEXT_WARN_CHARS = 2e5;
/** 超过这个长度才在页面状态里显示字数（短文本不打扰）。 */
const LONG_TEXT_STATUS_CHARS = 1e5;
/**
* Playwright `setInputFiles` 单次内联传输的硬上限（50MB）。
* 超过时必须走 CDP `DOM.setFileInputFiles`（浏览器按本地路径读文件），
* 否则会抛 "Cannot transfer files larger than 50Mb to a browser not co-located with the server"。
*/
const INLINE_UPLOAD_LIMIT_BYTES = 45 * 1024 * 1024;
/** 网页端输入框里已挂附件的预览容器。 */
const ATTACHMENT_PREVIEW_SELECTOR = ".ds-animated-size-item";
/** 增量里的原始流特征（SSE 帧 / DeepSeek 网页协议字段），出现即说明捕获错了流。 */
const POLLUTION_PATTERN = /(^|\n)\s*(event:\s*\w+|data:\s*\{)|request_message_id/;
/**
* 把多条网页流的解析结果按时间顺序合并成一条累计文本。
*
* 一轮生成里网页可能产生多条对话流：断线重连、超时重发、思考流与正文流分成
* 两条连接。只取最后一条会让前半段（通常是思考）凭空消失——这正是“思考到一半
* 就没动静、而网页还在输出”的直接原因。简单首尾相接又会把重发的前缀重复一遍，
* 所以这里做单调合并：
* - 新片以已合并内容开头 → 它是超集，直接替换；
* - 新片是已合并内容的前缀 → 重复内容，跳过；
* - 其余情况 → 视为真正的新内容追加。
*/
function mergeMonotonic(pieces) {
	let merged = "";
	for (const piece of pieces) {
		if (!piece) continue;
		if (merged.length === 0) {
			merged = piece;
			continue;
		}
		if (piece.startsWith(merged)) {
			merged = piece;
			continue;
		}
		if (merged.startsWith(piece)) continue;
		merged += piece;
	}
	return merged;
}
/**
* 从“累计文本”里取出相对上一条已发内容的新增量。
*
* 累计文本本应单调增长；一旦不是扩展关系（协议变化、流被截断），说明 diff
* 失去意义，此时返回空串只对齐基线，宁可少发一批增量也不发错的内容。
* 返回空串的另一个含义是“确实没有新内容”，调用方据此直接跳过。
*/
function takeDelta(current, emitted, kind) {
	if (current === emitted) return "";
	if (current.startsWith(emitted)) return current.slice(emitted.length);
	console.warn(`[deepseek-web] 实时${kind === "text" ? "正文" : "思考"}累计文本非单调增长，已对齐基线（本拍不发增量）。`);
	return "";
}
function matchesCompletionUrl(url) {
	return /\/chat\/completion\b/i.test(url) || /\/chat\/completions?$/i.test(url) || /\/conversation\/(chat|completion)/i.test(url);
}
/**
* 判断当前地址是否已经处在“新对话态”（入口页）。
*
* DeepSeek 的对话地址是 `/a/chat/s/<会话id>`，入口页是根路径 `/`（或 `/a/chat`）。
* 在这种页面上点“开启新对话”不会改变 URL，所以不能再用“URL 有没有变”判定成功，
* 否则每轮都会退化成整页重载，把填字撞进前端初始化竞态。
*/
function isEntryUrl(current, entryUrl) {
	let now;
	let entry;
	try {
		now = new URL(current);
		entry = new URL(entryUrl);
	} catch {
		return false;
	}
	if (now.origin !== entry.origin) return false;
	const strip = (path$1) => path$1.replace(/\/+$/u, "");
	const nowPath = strip(now.pathname);
	const entryPath = strip(entry.pathname);
	if (/\/chat\/s\//i.test(entryPath)) return false;
	if (nowPath === entryPath) return true;
	if (entryPath === "" && (nowPath === "" || nowPath === "/a" || nowPath === "/a/chat")) return true;
	return false;
}
/** 临时文件名：只留安全字符，保留扩展名，避免超长路径。 */
function sanitizeFileName(name$1) {
	return name$1.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(-80) || "image";
}
/** 从 SSE / JSON body 里抽取模型可见正文与思考内容。 */
function parseCompletionBody(body) {
	const fragments = [];
	let untrackedText = "";
	let untrackedReasoning = "";
	let lastPatchPath;
	let lastPatchOp = "APPEND";
	let accumulatedUsage;
	let contextLengthExceeded = false;
	let serverBusy = false;
	let finishReason;
	function observeFinish(value) {
		if (typeof value !== "string") return;
		const reason = value.toLowerCase();
		if (reason === "context_length_exceeded") contextLengthExceeded = true;
		else if ([
			"length",
			"max_tokens",
			"max-tokens",
			"max_output_tokens"
		].includes(reason)) finishReason = "max-tokens";
		else if ([
			"interrupted",
			"aborted",
			"cancelled",
			"canceled",
			"content_filter",
			"error"
		].includes(reason)) finishReason = "interrupted";
		else if (["stop", "finished"].includes(reason) && !finishReason) finishReason = "stop";
	}
	/** 记录网页端上报的会话累计 token 用量（只增不减时取最新）。 */
	function observeUsage(value) {
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) accumulatedUsage = value;
	}
	function upsertFragment(fragment, mode) {
		const index = fragment.id === void 0 ? -1 : fragments.findIndex((item) => item.id === fragment.id);
		if (index >= 0) {
			const current = fragments[index];
			current.type = fragment.type || current.type;
			current.content = mode === "replace" ? fragment.content : current.content + fragment.content;
		} else fragments.push({ ...fragment });
	}
	function collectFullResponse(json) {
		const root = json;
		if (root.v?.response?.accumulated_token_usage !== void 0) observeUsage(root.v.response.accumulated_token_usage);
		const fragmentList = root.v?.response?.fragments;
		observeFinish(root.v?.response?.finish_reason);
		if (!Array.isArray(fragmentList)) return;
		for (const fragment of fragmentList) {
			if (typeof fragment.content !== "string") continue;
			upsertFragment({
				id: fragment.id,
				type: String(fragment.type ?? ""),
				content: fragment.content
			}, "replace");
		}
	}
	function lastFragmentIndex() {
		for (let i = fragments.length - 1; i >= 0; i--) if ((fragments[i]?.type ?? "").toUpperCase() !== "THINK") return i;
		return fragments.length - 1;
	}
	function applyPatch(payload) {
		const pointer = typeof payload.p === "string" ? payload.p : lastPatchPath;
		const op = typeof payload.o === "string" ? payload.o : lastPatchOp;
		const value = payload.v;
		if (!pointer) return;
		lastPatchPath = pointer;
		lastPatchOp = op;
		if (pointer === "response/finish_reason") observeFinish(value);
		if (pointer === "response/fragments" && op === "APPEND" && Array.isArray(value)) {
			for (const fragment of value) if (fragment && typeof fragment === "object" && typeof fragment.content === "string") upsertFragment(fragment, "replace");
			return;
		}
		if (pointer === "response/fragments/-1/content") {
			const index = lastFragmentIndex();
			if (index >= 0 && typeof value === "string") {
				const fragment = fragments[index];
				fragment.content += value;
			}
			return;
		}
		if (op === "BATCH" && Array.isArray(value)) {
			for (const item of value) {
				if (item && item.p === "accumulated_token_usage") observeUsage(item.v);
				if (item && item.p === "finish_reason") observeFinish(item.v);
			}
			return;
		}
	}
	function consumeFragments() {
		for (const fragment of fragments) {
			const type = String(fragment.type ?? "").toUpperCase();
			if (type === "RESPONSE" || type === "TEXT" || type === "CONTENT" || type === "") untrackedText += fragment.content;
			else if (type === "THINK" || type === "THINKING" || type === "REASONING" || type === "THOUGHT") untrackedReasoning += fragment.content;
		}
	}
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		const dataIdx = line.indexOf("data:");
		if (dataIdx < 0) continue;
		const payload = line.slice(dataIdx + 5).trim();
		if (!payload || payload === "[DONE]") continue;
		let json;
		try {
			json = JSON.parse(payload);
		} catch {
			continue;
		}
		if (!json || typeof json !== "object") continue;
		observeFinish(json.finish_reason);
		if (json && typeof json === "object" && "p" in json) {
			applyPatch(json);
			continue;
		}
		const errorPayload = json.error;
		if (errorPayload !== void 0 || json.type === "error") {
			const errorText = typeof errorPayload === "string" ? errorPayload : errorPayload !== void 0 ? JSON.stringify(errorPayload) : "";
			if (looksLikeServerBusyText(`${errorText} ${String(json.content ?? "")} ${String(json.message ?? "")}`) || /"code"\s*:\s*(502|503|504)\b/u.test(errorText)) {
				serverBusy = true;
				continue;
			}
		}
		if (json.finish_reason === "context_length_exceeded" || json.type === "error" && String(json.content ?? "").includes("对话长度上限")) {
			contextLengthExceeded = true;
			continue;
		}
		if (json.v && typeof json.v === "object" && json.v.response) {
			collectFullResponse(json);
			continue;
		}
		if (!("p" in json) && Object.keys(json).length <= 1 && "v" in json && lastPatchPath) {
			applyPatch({ ...json });
			continue;
		}
		if (Array.isArray(json.choices)) {
			const choiceJson = json;
			for (const choice of choiceJson.choices ?? []) {
				observeFinish(choice.finish_reason);
				const delta = choice.delta;
				const message = choice.message;
				if (typeof message?.content === "string") untrackedText += message.content;
				if (typeof message?.reasoning_content === "string") untrackedReasoning += message.reasoning_content;
				if (typeof delta?.content === "string") untrackedText += delta.content;
				const think = delta?.reasoning_content ?? delta?.reasoner;
				if (typeof think === "string") untrackedReasoning += think;
			}
		}
	}
	consumeFragments();
	if (untrackedText || untrackedReasoning) return {
		text: untrackedText.trim(),
		...untrackedReasoning.trim() ? { reasoning: untrackedReasoning.trim() } : {},
		reliable: true,
		...finishReason ? { finishReason } : {},
		...accumulatedUsage !== void 0 ? { accumulatedUsage } : {},
		...contextLengthExceeded ? { contextLengthExceeded: true } : {},
		...serverBusy ? { serverBusy: true } : {}
	};
	try {
		const json = JSON.parse(body);
		let fallbackText = "";
		let fallbackReasoning = "";
		observeFinish(json.finish_reason);
		for (const choice of json.choices ?? []) {
			observeFinish(choice.finish_reason);
			if (typeof choice.message?.content === "string") fallbackText += choice.message.content;
			if (typeof choice.message?.reasoning_content === "string") fallbackReasoning += choice.message.reasoning_content;
			if (typeof choice.text === "string") fallbackText += choice.text;
		}
		if (typeof json.content === "string") fallbackText += json.content;
		if (fallbackText.trim() || fallbackReasoning.trim()) return {
			text: fallbackText.trim(),
			...fallbackReasoning.trim() ? { reasoning: fallbackReasoning.trim() } : {},
			reliable: true,
			...finishReason ? { finishReason } : {},
			...accumulatedUsage !== void 0 ? { accumulatedUsage } : {},
			...contextLengthExceeded ? { contextLengthExceeded: true } : {},
			...serverBusy ? { serverBusy: true } : {}
		};
		return {
			text: "",
			reliable: false,
			...finishReason ? { finishReason } : {},
			...accumulatedUsage !== void 0 ? { accumulatedUsage } : {},
			...contextLengthExceeded ? { contextLengthExceeded: true } : {},
			...serverBusy ? { serverBusy: true } : {}
		};
	} catch {
		if (!serverBusy && isServerBusyResponse(200, body)) serverBusy = true;
		return {
			text: serverBusy ? "" : body.trim(),
			reliable: false,
			...finishReason ? { finishReason } : {},
			...accumulatedUsage !== void 0 ? { accumulatedUsage } : {},
			...contextLengthExceeded ? { contextLengthExceeded: true } : {},
			...serverBusy ? { serverBusy: true } : {}
		};
	}
}
var PlaywrightBrowserChannel = class {
	browser;
	context;
	/** 锚点页面：第一个会话直接复用这个已登录的标签页，也供状态展示/聚焦使用。 */
	page;
	/**
	* 每个 dsh 会话独占一个网页标签页 + 一把会话锁。
	*
	* 关键点：主会话和它派生的子代理是两个不同 sessionId，各自拿到自己的标签页，
	* 因此不会再互相等对方那个"最长 10 分钟"的网页回合；同一会话的多个网页回合仍然串行。
	*/
	sessionPages = /* @__PURE__ */ new Map();
	/** 会话工作页创建的单飞（同一会话并发进入时只建一次）。 */
	creatingPages = /* @__PURE__ */ new Map();
	/** 正在创建、尚未登记进 sessionPages 的标签页：清理残留标签时必须避开它们。 */
	pendingPages = /* @__PURE__ */ new Set();
	/** ensureReady 的单飞：并发请求不会重复拉起浏览器。 */
	ensureReadyTask;
	/** 当前正在跑的主 agent 会话（由 adapter 每次 streamTask 开始时打点）。 */
	focusSessionId;
	/** 页面原始标题，用于状态标记前缀的清除/还原。 */
	originalTitles = /* @__PURE__ */ new WeakMap();
	options;
	/** 账号级冷却：进程级共享，热重载/多实例都读同一份（见 cooldown.ts）。 */
	cooldownState;
	/** 跨回合重试预算：同样进程级共享（见 retry-policy.ts）。 */
	retryBudgetState;
	pacerState;
	profileDir;
	managedConnection;
	/** 连续请求计数与最后一次请求时间（防风控长休用，见 maybeTakeLongRunPause）。 */
	consecutiveSends = 0;
	lastSendAt = 0;
	/** 提示节流：key 为「会话::分类::事件」，value 为上次发送时刻（毫秒）。 */
	lastNoticeAt = /* @__PURE__ */ new Map();
	constructor(options) {
		this.options = options;
		this.cooldownState = options.cooldown ?? sharedCooldown();
		this.retryBudgetState = options.retryBudget ?? sharedRetryBudget();
		this.pacerState = options.pacer ?? sharedPacer();
		this.profileDir = options.profileDir || options.config.profileDir || defaultProfileDir("edge-profile");
	}
	/** 打开/连接浏览器并确保已登录；并发进入时只执行一次（单飞）。 */
	async ensureReady() {
		const running = this.ensureReadyTask;
		if (running) return running;
		const task = this.ensureReadyCore().finally(() => {
			if (this.ensureReadyTask === task) this.ensureReadyTask = void 0;
		});
		this.ensureReadyTask = task;
		return task;
	}
	async ensureReadyCore() {
		if (this.browser?.isConnected() && this.context) {
			this.pruneClosedStates();
			if (!this.page || this.page.isClosed()) {
				this.page = this.context.pages().filter((candidate) => !candidate.isClosed()).find((candidate) => candidate.url().startsWith(new URL(this.options.config.url).origin)) ?? await this.context.newPage();
				await ensureChatPage(this.page, this.options.config.url);
			}
			return;
		}
		if (this.options.config.browser === "attach") {
			const { browser, context } = await connectBrowser({
				port: this.options.config.debugPort,
				profileDir: this.profileDir,
				url: this.options.config.url,
				autoStartKeeper: this.options.config.autoStartKeeper,
				label: "deepseek-web"
			});
			this.browser = browser;
			this.context = context;
		} else {
			const { mkdir: mkdir$1 } = await import("node:fs/promises");
			await mkdir$1(this.profileDir, { recursive: true });
			this.managedConnection = await launchManagedBrowser({
				channel: this.options.config.channel,
				profileDir: this.profileDir,
				preferredPort: this.options.config.debugPort,
				url: this.options.config.url,
				label: "deepseek-web"
			});
			this.browser = this.managedConnection.browser;
			this.context = this.managedConnection.context;
		}
		const pages = this.context.pages();
		this.page = pages.find((p) => p.url().startsWith(new URL(this.options.config.url).origin)) ?? pages[0] ?? await this.context.newPage();
		if (this.options.config.browser === "managed") await Promise.all(pages.filter((page) => !page.isClosed() && !this.ownedPage(page)).map((page) => page.close().catch(() => {})));
		await ensureChatPage(this.page, this.options.config.url);
		await this.page.waitForTimeout(1500);
		if (await looksLoggedOut(this.page)) throw new LlmError("deepseek-web: 浏览器窗口已打开，但 chat.deepseek.com 尚未登录。请在窗口中完成登录后重试本轮任务（登录状态会保存在本地 profile）。", "WEB_LOGIN_REQUIRED");
	}
	resetConversationGate(sessionId) {
		if (sessionId === void 0) {
			for (const state$1 of this.sessionPages.values()) state$1.started = false;
			return;
		}
		const state = this.sessionPages.get(sessionId);
		if (state) state.started = false;
	}
	isConversationActive(sessionId) {
		const state = this.sessionPages.get(sessionId);
		if (!state) return false;
		if (state.page.isClosed()) {
			this.sessionPages.delete(sessionId);
			return false;
		}
		return state.started;
	}
	/** 轮换到全新网页对话（上下文长度达到上限时由 adapter 调用）。 */
	async startNewConversation(sessionId) {
		const state = sessionId !== void 0 ? await this.stateFor(sessionId) : this.mostRecentState() ?? await this.stateFor("anonymous");
		this.originalTitles.delete(state.page);
		await this.startFreshConversation(state.page);
		state.started = true;
		state.lastUsedAt = Date.now();
	}
	/**
	* 确保网页端切到一个全新对话。
	*
	* 先尝试点击侧栏入口；若点击失败或 URL 未变化，则回退为重新打开入口页，
	* 强制落到全新对话，避免沿用上一次的网页会话（全自动模式下的典型问题）。
	*/
	async startFreshConversation(page, entryUrl = this.options.config.url) {
		const beforeUrl = page.url();
		if (isEntryUrl(beforeUrl, entryUrl)) {
			if (await bestEffortNewChat(page)) console.info("[deepseek-web] 已在入口页（新对话态），无需重载。");
			await locateEditor(page).waitFor({
				state: "visible",
				timeout: 15e3
			}).catch(() => {});
			return;
		}
		const existingPages = new Set(page.context().pages());
		const clicked = await bestEffortNewChat(page);
		const changeDeadline = Date.now() + 3e3;
		while (clicked && page.url() === beforeUrl && Date.now() < changeDeadline) await page.waitForTimeout(200);
		await Promise.all(page.context().pages().filter((candidate) => candidate !== page && !existingPages.has(candidate) && !this.ownedPage(candidate)).map((candidate) => candidate.close().catch(() => {})));
		if (clicked && page.url() !== beforeUrl) console.info("[deepseek-web] 已切换到新对话。");
		else {
			console.warn("[deepseek-web] 未能确认切换到新对话，回退为重新打开入口页以强制新会话。");
			await page.goto(entryUrl, {
				waitUntil: "domcontentloaded",
				timeout: 6e4
			}).catch(() => {});
			await page.waitForTimeout(1e3);
		}
		await locateEditor(page).waitFor({
			state: "visible",
			timeout: 15e3
		}).catch(() => {});
	}
	async markPageStatus(page, marker) {
		if (!this.originalTitles.has(page)) this.originalTitles.set(page, await page.title());
		const clean = this.originalTitles.get(page).replace(/^\[dsh[^\]]*\]\s*/u, "");
		await page.evaluate(({ title, prefix }) => {
			document.title = prefix ? `${prefix} ${title}` : title;
		}, {
			title: clean,
			prefix: marker
		});
	}
	/** 提示归属：审核请求（reviewer 传 role:'review'）与会话请求分开，绝不混成一锅。 */
	noticeCategory(request) {
		return request.role === "review" ? "review" : "session";
	}
	/**
	* 发一条提示。
	*
	* 节流按「会话 + 分类 + 事件」去重：重发循环里连续调用不会把同一句话刷屏，
	* 但等待 → 重发 → 完成这种真实状态变化一定各有一次。
	*/
	emitNotice(request, event, detail) {
		const onNotice = request.onNotice;
		if (onNotice === void 0) return;
		const category = this.noticeCategory(request);
		if (!noticeEnabled(this.options.config.notify, category, event)) return;
		const key = `${request.sessionId}::${category}::${event}`;
		const now = Date.now();
		const throttleMs = event === "recover" ? 0 : event === "send" || event === "receive" ? 500 : 1e3;
		if (now - (this.lastNoticeAt.get(key) ?? 0) < throttleMs) return;
		if (this.lastNoticeAt.size > 200) this.lastNoticeAt.clear();
		this.lastNoticeAt.set(key, now);
		const text = formatNotice({
			category,
			event,
			detail
		});
		try {
			onNotice({
				category,
				event,
				text
			});
		} catch (error) {
			console.warn("[deepseek-web] 提示回调异常（已忽略）：", error instanceof Error ? error.message : String(error));
		}
	}
	/**
	* 在网页右下角画一块浮层。
	*
	* 只服务「用户正盯着浏览器」的等待场景（频控倒计时、等人工点发送）：
	* pointer-events:none 保证它永远不挡住网页按钮和输入框。
	*/
	async paintPageNotice(page, text) {
		if (!browserNoticeEnabled(this.options.config.notify)) return;
		await page.evaluate((payload) => {
			let box = document.getElementById(payload.id);
			if (box === null) {
				box = document.createElement("div");
				box.id = payload.id;
				box.setAttribute("role", "status");
				box.style.cssText = [
					"position:fixed",
					"right:16px",
					"bottom:16px",
					"z-index:2147483647",
					"max-width:320px",
					"padding:10px 14px",
					"border-radius:10px",
					"background:rgba(28,28,32,.92)",
					"color:#fff",
					"font-size:13px",
					"line-height:1.5",
					"white-space:pre-line",
					"pointer-events:none",
					"box-shadow:0 6px 24px rgba(0,0,0,.28)",
					"font-family:system-ui,sans-serif"
				].join(";");
				document.body.appendChild(box);
			}
			box.textContent = payload.text;
		}, {
			id: PAGE_NOTICE_ID,
			text
		});
	}
	/**
	* 抹掉浮层；网页已关闭时静默跳过。
	*
	* 这里**不**再看 `browserNoticeEnabled`：开关只在“画”的时候判断，清理必须无条件执行。
	* 否则等待中途把「网页内提示」关掉，浮层就永远留在网页右下角；而它的文案
	* （“网页提示发送过于频繁…”）本身能命中频控正则，会把之后每一轮都锁死。
	*/
	async clearPageNotice(page) {
		if (page.isClosed()) return;
		await page.evaluate((id) => document.getElementById(id)?.remove(), PAGE_NOTICE_ID);
	}
	/**
	* 频控等待：按秒刷新浮层倒计时，同时让 sleep 保持可中断。
	*
	* 倒计时只在秒数变化时重画（一次 evaluate），不会因为 200ms 步进而打满页面。
	*/
	async waitWithCountdown(page, request, waitMs, attemptIndex, maxRetries) {
		const canPaint = browserNoticeEnabled(this.options.config.notify) && !page.isClosed();
		let lastSecond = -1;
		let lastNoticeSecond = -1;
		try {
			await this.sleep(waitMs, request.signal, (remainingMs) => {
				const second = Math.ceil(remainingMs / 1e3);
				if (second === lastSecond) return;
				lastSecond = second;
				if (canPaint) this.paintPageNotice(page, `DSH：网页提示发送过于频繁\n${formatDuration(remainingMs)} 后自动重发（第 ${attemptIndex}/${maxRetries} 次）`).catch(() => {});
				if (!(second === 30 || second > 30 && second % 60 === 0) || second === lastNoticeSecond) return;
				lastNoticeSecond = second;
				this.emitNotice(request, "wait", `还需要 ${formatDuration(remainingMs)}（第 ${attemptIndex}/${maxRetries} 次重发）`);
			});
		} finally {
			await this.clearPageNotice(page).catch(() => {});
		}
	}
	/**
	* 本轮失败提示。
	*
	* 放在 turn / turnIsolated 的 catch 里，而不是散落在每个 throw 点：
	* 只要这一轮以错误收场，就一定有一条提示，不会漏。
	*/
	emitFailure(request, error) {
		const failure = error instanceof LlmError ? error.failure : {
			code: "UNKNOWN",
			message: error instanceof Error ? error.message : String(error)
		};
		this.emitNotice(request, "error", describeFailure(failure));
	}
	/**
	* 这条错误是不是「浏览器/标签页被关掉」造成的。
	*
	* 两条证据：插件自己抛的 `WEB_PAGE_CLOSED`，以及 Playwright 断连的纯文本报错；
	* 另外浏览器对象已经明确断开时，任何错误都按可自愈处理——连接都没了，
	* 继续在死对象上重试没有意义。
	*/
	browserClosed(error) {
		if (error instanceof LlmError && error.failure.code === "WEB_PAGE_CLOSED") return true;
		if (isBrowserClosedMessage(error instanceof Error ? error.message : String(error))) return true;
		return this.browser !== void 0 && !this.browser.isConnected();
	}
	/**
	* 浏览器自愈：清掉断掉的连接/页面登记，再重启（或重连）浏览器。
	*
	* 只做「把环境恢复成可用」，新的标签页由调用方的 stateFor 重新创建；
	* 这样自愈和正常的会话页创建走同一条路，不会出现两套补页逻辑。
	*/
	async recoverBrowser(request, attempt, maxAttempts, error, sessionId) {
		const connected = this.browser?.isConnected() === true;
		const reason = error instanceof LlmError ? error.failure.message : error instanceof Error ? error.message : String(error);
		console.info(`[deepseek-web] 浏览器已断开，开始自愈（第 ${attempt}/${maxAttempts} 次）：${connected ? "仅标签页被关，保留浏览器" : "重启浏览器"}；原因：${reason.slice(0, 200)}`);
		this.emitNotice(request, "recover", connected ? `网页标签被关掉了，正在重新打开标签页（第 ${attempt}/${maxAttempts} 次）` : `浏览器被关掉了，正在重新启动浏览器（第 ${attempt}/${maxAttempts} 次）`);
		const stale = this.sessionPages.get(sessionId);
		this.sessionPages.delete(sessionId);
		this.creatingPages.delete(sessionId);
		stale?.page.close().catch(() => {});
		if (this.page === stale?.page) this.page = void 0;
		if (!connected) {
			this.sessionPages.clear();
			this.pendingPages.clear();
			this.page = void 0;
			const managed = this.managedConnection;
			this.managedConnection = void 0;
			this.browser = void 0;
			this.context = void 0;
			await managed?.browser.close().catch(() => {});
			if (managed?.process && !managed.process.killed) managed.process.kill();
		}
		const delayMs = this.options.config.browserRecovery.delayMs;
		if (delayMs > 0) {
			this.emitNotice(request, "recover", `${formatDuration(delayMs)} 后重新${connected ? "打开标签页" : "启动浏览器"}，本轮消息会自动重发`);
			await this.sleep(delayMs, request.signal);
		}
		await this.ensureReady();
		this.emitNotice(request, "recover", "浏览器已就绪，正在重新打开网页并重发本轮消息");
	}
	async turn(request) {
		const healthyBefore = this.browser?.isConnected() === true;
		const closedPageBefore = this.page !== void 0 && this.page.isClosed();
		await this.ensureReady();
		if (this.browser !== void 0 && (!healthyBefore || closedPageBefore)) this.emitNotice(request, "recover", healthyBefore ? "网页标签已被关闭，已自动重新打开" : "浏览器已被关闭，已自动重新启动并打开网页");
		const explicitTarget = request.conversationSessionId ?? (request.preserveConversation ? this.focusSessionId : void 0);
		const targeted = explicitTarget !== void 0 ? this.sessionPages.get(explicitTarget) : void 0;
		let state;
		if (request.preserveConversation) if (targeted !== void 0 && !targeted.page.isClosed()) state = targeted;
		else if (explicitTarget !== void 0) state = await this.stateFor(explicitTarget);
		else state = this.mostRecentState() ?? await this.stateFor(request.sessionId);
		else state = await this.stateFor(request.sessionId);
		const acquire = (target) => target.lock.acquire(request.signal, {
			maxHoldMs: this.options.config.lockLeaseMs,
			onLeak: (info) => console.warn(`[deepseek-web] 会话回合锁被强制回收：session=${target.sessionId} 已持有 ${Math.round(info.heldMs / 1e3)}s。该回合仍在后台收尾，但不会再永久阻塞这个会话的后续请求。`)
		});
		let release = await acquire(state);
		const abort = new AbortController();
		state.abort = abort;
		let relay;
		if (request.signal) {
			relay = () => abort.abort(request.signal?.reason);
			if (request.signal.aborted) relay();
			else request.signal.addEventListener("abort", relay, { once: true });
		}
		let timedOut = false;
		const timeoutMs = this.options.config.turnTimeoutMs;
		const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => {
			timedOut = true;
			abort.abort(/* @__PURE__ */ new Error("turn timeout"));
		}, timeoutMs) : void 0;
		if (timer) timer.unref?.();
		const inner = {
			...request,
			signal: abort.signal
		};
		const recovery = this.options.config.browserRecovery;
		const maxRecoveries = recovery.enabled === false ? 0 : Math.max(0, Math.trunc(recovery.maxAttempts));
		try {
			for (let recovered = 0;; recovered += 1) try {
				console.info(`[deepseek-web] turn 入口 session=${request.sessionId} initialize=${String(request.initialize)} 页面会话=${state.sessionId} started=${String(state.started)} 会话页=${this.sessionPages.size}${recovered > 0 ? ` 自愈第 ${recovered} 次` : ""}`);
				request.signal?.throwIfAborted();
				if (request.initialize && !state.started) {
					await this.startFreshConversation(state.page);
					state.started = true;
				}
				return await this.turnOnPage(state.page, inner);
			} catch (error) {
				if (timedOut || abort.signal.aborted) throw error;
				if (recovered >= maxRecoveries || !this.browserClosed(error)) throw error;
				release();
				await this.recoverBrowser(request, recovered + 1, maxRecoveries, error, request.sessionId);
				state = await this.stateFor(request.sessionId);
				state.abort = abort;
				release = await acquire(state);
			}
		} catch (error) {
			if (timedOut) {
				const timeout = new LlmError(`deepseek-web: 本次网页回合超过单回合上限（${Math.round(timeoutMs / 1e3)}s），已主动中止，避免长期占用网页与会话锁。请检查网页是否卡在生成中，或调大 turnTimeoutMs 后重试。`, "WEB_TURN_TIMEOUT");
				this.emitFailure(request, timeout);
				throw timeout;
			}
			if (abort.signal.aborted && !request.signal?.aborted) {
				const aborted = new LlmError("网页回合已被主动取消（宿主已放弃本次生成）。", "WEB_TURN_ABORTED");
				this.emitFailure(request, aborted);
				throw aborted;
			}
			this.emitFailure(request, error);
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
			if (relay) request.signal?.removeEventListener("abort", relay);
			if (state.abort === abort) state.abort = void 0;
			state.lastUsedAt = Date.now();
			release();
		}
	}
	/** 取消指定会话（不传则全部）当前挂在网页上的回合。 */
	async cancelTurn(sessionId) {
		const targets = sessionId === void 0 ? [...this.sessionPages.values()] : [this.sessionPages.get(sessionId)].filter((state) => state !== void 0);
		for (const state of targets) {
			const abort = state.abort;
			if (!abort || abort.signal.aborted) continue;
			console.info(`[deepseek-web] 取消会话回合 session=${state.sessionId}：宿主已放弃本次生成，立即结束网页回合，避免该会话后续请求排队等待。`);
			abort.abort(/* @__PURE__ */ new Error("cancelled"));
		}
	}
	async turnIsolated(request) {
		await this.ensureReady();
		request.signal?.throwIfAborted();
		let page;
		try {
			page = await this.context.newPage();
			const entryUrl = new URL("/", this.options.config.url).href;
			await page.goto(entryUrl, {
				waitUntil: "domcontentloaded",
				timeout: 6e4
			});
			await this.startFreshConversation(page, entryUrl);
			return await this.turnOnPage(page, request);
		} catch (error) {
			this.emitFailure(request, error);
			throw error;
		} finally {
			await page?.close().catch(() => {});
			await this.setWebWindowTopmost(request.sessionId, false).catch(() => {});
		}
	}
	async turnOnPage(page, request) {
		const startedAt = Date.now();
		let waitedMs = 0;
		const cooldown = this.cooldown();
		const coolingMs = cooldown.remainingMs();
		if (coolingMs > 0) {
			const snapshot = cooldown.snapshot();
			throw new LlmError(`deepseek-web: 账号仍在频控冷却中，还需等待 ${formatDuration(coolingMs)}。${snapshot.reason !== void 0 ? `（上次原因：${snapshot.reason}）` : ""}冷却期内不会再向网页发送任何请求，避免把临时限流拖成封号。`, "WEB_ACCOUNT_COOLDOWN");
		}
		const gapMs = computeTurnGap(this.pacerState.lastEnd(), Date.now(), this.options.config.turnGapMinMs, this.options.config.turnGapMaxMs);
		if (gapMs > 0) {
			console.info(`[deepseek-web] 距上一轮结束不足 ${formatDuration(gapMs)}，先等一会儿再发（回合间隔）。`);
			await this.sleep(gapMs, request.signal);
		}
		const rateLimit = this.options.config.rateLimit;
		const maxRetries = rateLimit?.enabled === false ? 0 : rateLimit?.maxRetries ?? 4;
		const serverBusy = this.options.config.serverBusy;
		const busyMaxRetries = serverBusy?.enabled === false ? 0 : serverBusy?.maxRetries ?? SERVER_BUSY_MAX_RETRIES;
		const budget = this.retryBudget();
		const budgetKey = `deepseek-web:${this.options.config.channel}`;
		let attempt = 0;
		let busyAttempt = 0;
		let busyWaitedMs = 0;
		/**
		* 服务端故障的等待与重发。
		*
		* 用尽时抛 WEB_SERVER_BUSY（**不**锁账号冷却）：这是后端的问题，跟这个账号
		* 有没有被判机器行为毫无关系；锁冷却只会让用户等更久还找不到原因。
		*/
		const waitForServerRecovery = async () => {
			if (busyAttempt >= busyMaxRetries) throw new LlmError(`deepseek-web: 网页服务端暂时不可用，已自动重试 ${busyMaxRetries} 次仍未恢复${busyWaitedMs > 0 ? `（累计等待 ${formatDuration(busyWaitedMs)}）` : ""}。这是 DeepSeek 后端的问题，跟账号和插件都无关：等 1~2 分钟再试即可。`, "WEB_SERVER_BUSY");
			const waitMs = serverBusyDelayMs(serverBusy, busyAttempt);
			busyWaitedMs += waitMs;
			busyAttempt += 1;
			const delayText = formatDuration(waitMs);
			console.info(`[deepseek-web] 网页服务端暂时不可用，${delayText} 后自动重发同一条消息（第 ${busyAttempt}/${busyMaxRetries} 次，${describeRateLimitPolicy(serverBusy)}）…`);
			this.emitNotice(request, "wait", `网页服务器暂时不可用，${delayText} 后自动重发（第 ${busyAttempt}/${busyMaxRetries} 次）`);
			await this.markPageStatus(page, `[dsh 服务端繁忙：${delayText} 后自动重发]`).catch(() => {});
			await this.waitWithCountdown(page, request, waitMs, busyAttempt, busyMaxRetries);
			await this.markPageStatus(page, void 0).catch(() => {});
			this.emitNotice(request, "retry", `正在第 ${busyAttempt}/${busyMaxRetries} 次重发同一条消息`);
		};
		while (true) {
			request.signal?.throwIfAborted();
			const outcome = await this.sendAndWait(page, request);
			if (outcome.kind === "server-busy") {
				await waitForServerRecovery();
				continue;
			}
			if (outcome.kind === "completed") {
				const parsed = parseCompletionBody(outcome.completion.body);
				if (parsed.serverBusy === true) {
					await waitForServerRecovery();
					continue;
				}
				if (outcome.completion.status >= 400) {
					if (isServerBusyResponse(outcome.completion.status, outcome.completion.body)) {
						await waitForServerRecovery();
						continue;
					}
					throw new LlmError(`网页返回 HTTP ${outcome.completion.status}，未作为有效回复提交。`, "WEB_HTTP_ERROR");
				}
				if (!parsed.text && !parsed.reasoning && parsed.contextLengthExceeded !== true && !outcome.completion.interrupted && !["max-tokens", "interrupted"].includes(parsed.finishReason ?? "")) throw new LlmError(`deepseek-web: 网页响应没有可解析正文（HTTP ${outcome.completion.status}，${outcome.completion.url}）`, "WEB_EMPTY_RESPONSE");
				if (!parsed.reliable && !parsed.contextLengthExceeded && !parsed.finishReason && !outcome.completion.interrupted) throw new LlmError("网页响应格式无法识别，原始网络内容未作为正文提交。", "WEB_UNPARSEABLE_RESPONSE");
				const result = {
					text: parsed.text,
					...parsed.reasoning !== void 0 ? { reasoning: parsed.reasoning } : {},
					...parsed.accumulatedUsage !== void 0 ? { accumulatedUsage: parsed.accumulatedUsage } : {},
					...parsed.contextLengthExceeded === true ? { contextLengthExceeded: true } : {},
					...outcome.completion.interrupted ? { finishReason: "interrupted" } : parsed.finishReason ? { finishReason: parsed.finishReason } : {}
				};
				this.emitNotice(request, "done", `用时 ${formatDuration(Date.now() - startedAt)}，收到 ${parsed.text.length} 字${waitedMs > 0 ? `（含频控等待 ${formatDuration(waitedMs)}）` : ""}`);
				cooldown.clear();
				budget.reset(budgetKey);
				return result;
			}
			if (attempt >= maxRetries) {
				const coolMs = rateLimit?.accountCooldownMs ?? 6e5;
				cooldown.block(coolMs, "网页提示发送过于频繁，自动重发已用尽");
				throw new LlmError(`deepseek-web: 网页提示发送过于频繁，已自动重发 ${maxRetries} 次仍未成功${waitedMs > 0 ? `（累计等待 ${formatDuration(waitedMs)}）` : ""}。${coolMs > 0 ? `账号已进入 ${formatDuration(coolMs)} 冷却，期间所有会话都不会再发请求。` : ""}请稍后在网页端手动发送，或稍后重试本任务。`, "WEB_RATE_LIMITED");
			}
			if (!budget.take(budgetKey)) throw new LlmError("deepseek-web: 最近 30 分钟内自动重发次数已用尽，为避免账号被判机器行为，本轮不再重试。请等冷却结束后再试，或先去网页端手动发一条确认账号可用。", "WEB_RATE_LIMITED");
			const waitMs = rateLimitDelayMs(rateLimit, attempt);
			waitedMs += waitMs;
			attempt += 1;
			const delayText = formatDuration(waitMs);
			const jitterPercent = Math.round((rateLimit?.jitterRatio ?? .15) * 100);
			console.info(`[deepseek-web] 网页提示发送频繁，${delayText} 后自动重发同一条消息（第 ${attempt}/${maxRetries} 次，${describeRateLimitPolicy(rateLimit)}，抖动 ±${jitterPercent}%）…`);
			this.emitNotice(request, "wait", `网页提示发送过于频繁，${delayText} 后自动重发（第 ${attempt}/${maxRetries} 次）`);
			await this.markPageStatus(page, `[dsh 频控：${delayText} 后自动重发]`).catch(() => {});
			await this.waitWithCountdown(page, request, waitMs, attempt, maxRetries);
			await this.markPageStatus(page, void 0).catch(() => {});
			this.emitNotice(request, "retry", `正在第 ${attempt}/${maxRetries} 次重发同一条消息`);
		}
	}
	/** 账号冷却计时器（进程级共享；状态接口给设置页/自检读）。 */
	cooldown() {
		return this.cooldownState;
	}
	/** 跨回合重试预算（进程级共享；自检与台账读它）。 */
	retryBudget() {
		return this.retryBudgetState;
	}
	/** 该页面是否由本通配给某个 dsh 会话（清理残留标签页时判断归属）。 */
	ownedPage(page) {
		if (page === this.page) return true;
		return this.assignedPage(page);
	}
	/** 该页面是否已分配给某个会话（不算"锚点页"这一层身份，供复用判断）。 */
	assignedPage(page) {
		if (this.pendingPages.has(page)) return true;
		for (const state of this.sessionPages.values()) if (state.page === page) return true;
		return false;
	}
	markPageStarted(page) {
		for (const state of this.sessionPages.values()) if (state.page === page) {
			state.started = true;
			return;
		}
	}
	mostRecentState() {
		let best;
		for (const state of this.sessionPages.values()) {
			if (state.page.isClosed()) continue;
			if (!best || state.lastUsedAt > best.lastUsedAt) best = state;
		}
		return best;
	}
	/** 取（必要时创建）会话独占的工作页；同一会话并发进入只会创建一次。 */
	stateFor(sessionId) {
		const existing = this.sessionPages.get(sessionId);
		if (existing && !existing.page.isClosed()) return Promise.resolve(existing);
		if (existing) {
			this.sessionPages.delete(sessionId);
			existing.page.close().catch(() => {});
		}
		const running = this.creatingPages.get(sessionId);
		if (running) return running;
		const task = this.createState(sessionId).finally(() => {
			if (this.creatingPages.get(sessionId) === task) this.creatingPages.delete(sessionId);
		});
		this.creatingPages.set(sessionId, task);
		return task;
	}
	async createState(sessionId) {
		await this.ensureReady();
		const anchor = this.page;
		const anchorFree = anchor !== void 0 && !anchor.isClosed() && !this.assignedPage(anchor);
		let page;
		if (anchorFree) page = anchor;
		else {
			await this.makeRoomForPage();
			page = await this.context.newPage();
			this.pendingPages.add(page);
			try {
				const entryUrl = new URL("/", this.options.config.url).href;
				await page.goto(entryUrl, {
					waitUntil: "domcontentloaded",
					timeout: 6e4
				}).catch(() => {});
				await ensureChatPage(page, this.options.config.url).catch(() => {});
				await page.waitForTimeout(500);
			} finally {
				this.pendingPages.delete(page);
			}
		}
		const state = {
			sessionId,
			page,
			started: false,
			lock: new AsyncLock(),
			lastUsedAt: Date.now()
		};
		this.sessionPages.set(sessionId, state);
		console.info(`[deepseek-web] 会话工作页就绪 session=${sessionId} 会话页=${this.sessionPages.size}/${this.options.config.maxSessionPages}${page === anchor ? "（复用锚点页）" : "（新开标签页）"}`);
		return state;
	}
	/** 达到标签页上限时回收最久未用且当前空闲的会话页。 */
	async makeRoomForPage() {
		const max = Math.max(1, this.options.config.maxSessionPages);
		let guard = 0;
		while (this.sessionPages.size >= max && guard++ < 16) {
			let victim;
			for (const state of this.sessionPages.values()) {
				if (state.abort || state.page.isClosed()) continue;
				if (!victim || state.lastUsedAt < victim.lastUsedAt) victim = state;
			}
			if (!victim) break;
			console.info(`[deepseek-web] 会话页达到上限 ${max}，回收最久未用的工作页 session=${victim.sessionId}（该会话下次请求会重新回放宿主上下文）。`);
			this.sessionPages.delete(victim.sessionId);
			await victim.page.close().catch(() => {});
			if (this.page === victim.page) this.page = void 0;
		}
	}
	pruneClosedStates() {
		for (const [sessionId, state] of this.sessionPages) if (state.page.isClosed()) this.sessionPages.delete(sessionId);
	}
	/**
	* 一轮“填入 → 发送 → 等回复”。检测到频控（toast / 429 / 响应体提示）时
	* 返回 rate-limited，由 turn() 的重发循环接手；其余情况返回完整响应。
	* 同时把网页端的流式增量经 onProgress 回调上抛（实时思考流）。
	*/
	/**
	* 清掉输入框里残留的附件预览。
	*
	* 用户取消上一轮、或发送前抛错时，网页输入框里可能还挂着上次的图；不清掉就会
	* 串到本轮（发一条纯文本却带上旧图）。每轮发送前统一清一次，无附件时零开销
	* （找不到预览就直接返回）。
	*/
	async clearAttachments(page) {
		const remove = page.locator(`${ATTACHMENT_PREVIEW_SELECTOR} div:has(> .ds-icon)`);
		for (let guard = 0; guard < 40; guard += 1) {
			if (await remove.count().catch(() => 0) === 0) return;
			if (!await remove.first().click({ timeout: 2e3 }).then(() => true, () => false)) return;
			await this.sleep(150).catch(() => {});
		}
	}
	/**
	* 把本轮的图片挂到网页输入框（由网页端自己完成上传并回填 `ref_file_ids`）。
	*
	* 顺序很重要：必须在键盘输入文本之前完成——半自动模式一把窗口置顶，用户可能
	* 看到输入框就立刻回车；附件没挂上就发出去，本轮图片会静默丢失。
	*
	* 复用的两条上传路径：
	* - 总字节 ≤ 45MB：`setInputFiles` 内联传 buffer；
	* - 超过则先落临时文件，再走 CDP `DOM.setFileInputFiles`（浏览器按本地路径读）。
	*
	* 失败处理遵循 `uploadOnError`：`abort` 抛 `WEB_IMAGE_UPLOAD_FAILED`；
	* `fallback-text` 只告警并继续，正文里的 `[附图: …]` 标记不因此变成"已上传"。
	*/
	async attachAttachments(page, request) {
		const files = request.attachments ?? [];
		const { config } = this.options;
		try {
			if (files.length === 0) {
				await this.clearAttachments(page);
				return;
			}
			const input = page.locator("input[type=\"file\"]").first();
			if (await input.count().catch(() => 0) === 0) {
				this.handleUploadFailure(request, /* @__PURE__ */ new Error("页面上没有找到 input[type=\"file\"]"));
				return;
			}
			const attached = await page.locator(`${ATTACHMENT_PREVIEW_SELECTOR} img`).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("alt") ?? "")).catch(() => []);
			if (files.every((file) => attached.includes(file.name))) {
				console.info("[deepseek-web] 本轮图片已在输入框里，跳过重复上传。");
				return;
			}
			await this.clearAttachments(page);
			const before = await page.locator(ATTACHMENT_PREVIEW_SELECTOR).count().catch(() => 0);
			const parsed = page.waitForResponse(async (response) => {
				if (!response.url().includes("/api/v0/file/fetch_files")) return false;
				const list = (await response.json().catch(() => void 0))?.data?.biz_data?.files;
				return Array.isArray(list) && list.length > 0 && list.every((item) => item.status === "SUCCESS");
			}, { timeout: config.uploadTimeoutMs }).then((response) => response != null, () => false);
			const totalBytes = files.reduce((sum, file) => sum + file.data.byteLength, 0);
			if (totalBytes > INLINE_UPLOAD_LIMIT_BYTES) {
				console.info(`[deepseek-web] 图片总计 ${Math.round(totalBytes / 1024 / 1024)}MB，走 CDP 路径上传。`);
				await this.attachViaCdp(page, files);
			} else await input.setInputFiles(files.map((file) => ({
				name: file.name,
				mimeType: file.mimeType,
				buffer: Buffer.from(file.data)
			})));
			if (!await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length > count, {
				selector: ATTACHMENT_PREVIEW_SELECTOR,
				count: before
			}, { timeout: 15e3 }).then(() => true, () => false)) {
				this.handleUploadFailure(request, /* @__PURE__ */ new Error("上传后 15 秒内没有出现附件预览"));
				return;
			}
			if (!await parsed) {
				this.handleUploadFailure(request, /* @__PURE__ */ new Error(`等待图片解析超时（${config.uploadTimeoutMs}ms）`));
				return;
			}
			console.info(`[deepseek-web] 已上传 ${files.length} 张图片，网页端解析完成。`);
		} catch (error) {
			if (error instanceof LlmError) throw error;
			this.handleUploadFailure(request, error instanceof Error ? error : new Error(String(error)));
		}
	}
	/** 上传失败出口：按配置抛错或降级（降级只告警，不改正文，也不谎报成功）。 */
	handleUploadFailure(request, error) {
		if (this.options.config.uploadOnError === "abort") throw new LlmError(`deepseek-web: 图片上传失败（会话 ${request.sessionId}）：${error.message}`, "WEB_IMAGE_UPLOAD_FAILED", { cause: error });
		console.warn(`[deepseek-web] 图片上传失败，本轮退回文本标记继续：${error.message}`);
	}
	/**
	* >45MB 的图片走 CDP：先落临时文件，再让浏览器按绝对路径读。
	* Playwright 的 `setInputFiles` 不适合大文件（跨进程传 buffer 有 50MB 硬上限）。
	*/
	async attachViaCdp(page, files) {
		const dir = await mkdtemp(path.join(tmpdir(), "dsh-web-upload-"));
		try {
			const absolute = [];
			for (const [index, file] of files.entries()) {
				const target = path.join(dir, `${index}-${sanitizeFileName(file.name)}`);
				await writeFile(target, Buffer.from(file.data));
				absolute.push(target);
			}
			const session = await page.context().newCDPSession(page);
			try {
				const { root } = await session.send("DOM.getDocument");
				const { nodeId } = await session.send("DOM.querySelector", {
					nodeId: root.nodeId,
					selector: "input[type=\"file\"]"
				});
				if (!nodeId) throw new Error("未找到 input[type=\"file\"] 节点");
				await session.send("DOM.setFileInputFiles", {
					files: absolute,
					nodeId
				});
			} finally {
				await session.detach().catch(() => {});
			}
			await this.sleep(3e3);
		} finally {
			await rm(dir, {
				recursive: true,
				force: true
			}).catch(() => {});
		}
	}
	async sendAndWait(page, request) {
		await this.maybeTakeLongRunPause(page, request.signal);
		const autoSend = request.autoSend ?? this.autoSendSessions.get(request.sessionId) ?? this.options.config.sendMode === "approved";
		const ackTimeoutMs = autoSend ? Math.min(this.options.config.streamIdleTimeoutMs, SEND_ACK_TIMEOUT_MS) : SEND_ACK_TIMEOUT_MS;
		let waiterActive = true;
		let sawResponse = false;
		const waiter = page.waitForResponse(async (response) => {
			if (response.request().method() !== "POST") return false;
			if (!matchesCompletionUrl(response.url())) return false;
			sawResponse = true;
			return true;
		}, { timeout: 0 }).then(async (response) => {
			await this.markPageStatus(page, request.purpose ? `[dsh 内部辅助：${request.purpose} 生成中]` : "[dsh 网页生成中]").catch(() => {});
			this.emitNotice(request, "receive", request.purpose ? `网页已响应（内部辅助：${request.purpose}），正在生成…` : "网页已响应，正在生成…");
			const [interrupted, body] = await Promise.all([response.finished().then((error) => error !== null, () => true), response.body().catch(() => Buffer.alloc(0))]);
			if (!waiterActive) return void 0;
			return {
				url: response.url(),
				request: { postData: response.request().postData()?.slice(0, 4e3) },
				status: response.status(),
				body: body.toString(),
				interrupted
			};
		}, (error) => {
			if (!waiterActive) return void 0;
			throw error;
		});
		waiter.catch(() => {});
		let abortListener;
		const aborted = new Promise((_, reject) => {
			if (!request.signal) return;
			abortListener = () => reject(new LlmError("网页回合已取消。", "WEB_TURN_ABORTED"));
			request.signal.addEventListener("abort", abortListener, { once: true });
			if (request.signal.aborted) abortListener();
		});
		aborted.catch(() => {});
		let ackTimer;
		let ackDeadline;
		const startAckClock = () => {
			clearTimeout(ackTimer);
			ackDeadline = new Promise((_, reject) => {
				ackTimer = setTimeout(() => {
					reject(new LlmError(autoSend ? `deepseek-web: 消息已发送，但 ${formatDuration(ackTimeoutMs)} 内没有等到网页的响应流（HTTP 层未捕获到本轮请求）。请人工检查网页：对话里若已出现这条消息并开始回答，说明响应被页面拦截或网络中断；若输入框里还留着内容，说明回车没触发发送。确认后重试本轮任务。` : `deepseek-web: 消息已填入输入框，等待你点击“发送”超时（${formatDuration(ackTimeoutMs)}）。请确认输入框内容后点击页面上的发送按钮重试。`, autoSend ? "WEB_AUTO_SEND_TIMEOUT" : "WEB_MANUAL_SEND_TIMEOUT"));
				}, ackTimeoutMs);
			});
			ackDeadline.catch(() => {});
		};
		let progressTimer;
		let toastTimer;
		try {
			request.signal?.throwIfAborted();
			let rateLimitedNow;
			const rateLimited = new Promise((resolve) => {
				rateLimitedNow = () => resolve({ kind: "rate-limited" });
			});
			let serverBusyNow;
			const serverBusySignal = new Promise((resolve) => {
				serverBusyNow = () => resolve({ kind: "server-busy" });
			});
			const editor = locateEditor(page);
			if (!await editor.isVisible().catch(() => false)) {
				if (!await editor.waitFor({
					state: "visible",
					timeout: 15e3
				}).then(() => true).catch(() => false)) {
					waiterActive = false;
					if (await looksLoggedOut(page)) throw new LlmError("deepseek-web: 浏览器窗口已打开，但 chat.deepseek.com 尚未登录。请在窗口中完成登录后重试本轮任务（登录状态会保存在本地 profile）。", "WEB_LOGIN_REQUIRED");
					throw new LlmError(`deepseek-web: 未找到聊天输入框，页面结构很可能已经改版（登录态正常时才会走到这里）。已尝试的选择器：${EDITOR_CANDIDATES.join(" | ")}。请升级插件；急需用时可在网页端手动发送一条。`, "WEB_UI_CHANGED");
				}
			}
			progressTimer = request.onProgress ? await this.startProgressPolling(page, request) : void 0;
			const claimedBeforeSend = await markRateLimitToastsSeen(page);
			if (claimedBeforeSend > 0) console.info(`[deepseek-web] 发送前认领 ${claimedBeforeSend} 个已存在的频控文案节点（不计入本轮判定）。`);
			const claimedBusy = await markServerBusyToastsSeen(page);
			if (claimedBusy > 0) console.info(`[deepseek-web] 发送前认领 ${claimedBusy} 个已存在的「服务器不可用」文案节点（不计入本轮判定）。`);
			let toastTick = 0;
			toastTimer = setInterval(() => {
				toastTick += 1;
				hasRateLimitToast(page).then((hit) => {
					if (hit) rateLimitedNow?.();
				});
				if (toastTick % 3 === 1) hasServerBusyToast(page).then((hit) => {
					if (hit) serverBusyNow?.();
				});
			}, RATE_LIMIT_POLL_MS);
			request.signal?.throwIfAborted();
			await editor.click();
			await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
			await page.keyboard.press("Backspace");
			await this.attachAttachments(page, request);
			request.signal?.throwIfAborted();
			const textLength = request.text.length;
			if (textLength >= LONG_TEXT_WARN_CHARS) console.warn(`[deepseek-web] 本轮单条消息 ${textLength} 字。网页输入框填字接近二次方级耗时（实测 30 万字符约 13 秒、60 万约 77 秒、110 万会把页面主线程拖死数分钟），填写期间页面可能毫无反应；响应等待 ${formatDuration(ackTimeoutMs)} 从“发送确认完成”才开始计，不会因此误判超时。`);
			if (textLength >= LONG_TEXT_STATUS_CHARS) await this.markPageStatus(page, `[dsh 正在填入 ${textLength} 字，请稍候]`).catch(() => {});
			const fillStartedAt = Date.now();
			await page.keyboard.insertText(request.text);
			const fillMs = Date.now() - fillStartedAt;
			if (fillMs >= 5e3) console.info(`[deepseek-web] 填入 ${textLength} 字耗时 ${formatDuration(fillMs)}（这一步不计入等待网页响应的超时）。`);
			if (page === this.page) this.markPageStarted(page);
			if (autoSend) {
				const pause = this.pickPause(this.options.config.sendPauseMinMs, this.options.config.sendPauseMaxMs);
				if (pause >= 1) {
					await this.markPageStatus(page, `[dsh 已填入，${(pause / 1e3).toFixed(1)}s 后发送]`);
					await this.sleep(pause, request.signal);
				}
				await this.markPageStatus(page, request.purpose ? `[dsh 内部辅助：${request.purpose} 自动发送]` : "[dsh 自动发送中]");
				const outcome = await sendEditorMessage(page, editor, {
					verifyTimeoutMs: Math.max(this.options.config.review.sendVerifyMs, 3e3),
					maxAttempts: 2,
					pauseMinMs: 0,
					pauseMaxMs: 0,
					hasResponse: () => sawResponse,
					isCancelled: () => request.signal?.aborted ?? false
				});
				if (!outcome.sent) throw new LlmError(`deepseek-web: 消息已填入输入框，但没能确认发送出去。尝试记录：${outcome.attempts.join("；")}。页面可能改版导致回车与发送按钮都失效——请人工检查网页后重试。`, "WEB_SEND_NOT_TRIGGERED");
				console.info(`[deepseek-web] 全自动：已确认发送（方式：${outcome.via}）。`);
			} else {
				await page.bringToFront();
				const focus = this.options.config.focus;
				if (focus?.enabled !== false && focus?.webWindow !== false) await setBrowserWindowTopmost({
					profileDir: this.profileDir,
					topmost: true
				}).catch(() => {});
				await editor.focus();
				await this.markPageStatus(page, request.purpose ? `[dsh 内部辅助：${request.purpose} 等待点击发送]` : "[dsh 等待你在网页点击发送]");
				console.info("[deepseek-web] 消息已填入 Edge 并置顶聚焦，请回车或点击“发送”…");
			}
			const attachText = request.attachments !== void 0 && request.attachments.length > 0 ? `，附图 ${request.attachments.length} 张` : "";
			this.emitNotice(request, "send", autoSend ? `已确认发送 ${request.text.length} 字${attachText}` : `已填入输入框 ${request.text.length} 字${attachText}，等待你在网页点击发送`);
			startAckClock();
			const winner = await Promise.race([
				waiter,
				rateLimited,
				serverBusySignal,
				aborted,
				ackDeadline
			]);
			if (winner === void 0) return { kind: "rate-limited" };
			if ("kind" in winner) return winner;
			if (isServerBusyResponse(winner.status, winner.body)) {
				console.warn(`[deepseek-web] 响应判定为服务端暂时不可用（HTTP ${winner.status}）。`);
				return { kind: "server-busy" };
			}
			if (isRateLimitResponse(winner.status, winner.body)) {
				console.warn(`[deepseek-web] 响应判定为频控（HTTP ${winner.status}）。`);
				return { kind: "rate-limited" };
			}
			console.info("[deepseek-web] 已收到网页完整回复，正在解析…");
			return {
				kind: "completed",
				completion: winner
			};
		} catch (error) {
			if (request.signal?.aborted) throw new LlmError("网页回合已取消。", "WEB_TURN_ABORTED");
			if (error instanceof LlmError) throw error;
			if (page.isClosed()) throw new LlmError("deepseek-web: 浏览器页面被关闭", "WEB_PAGE_CLOSED");
			if (await hasServerBusyToast(page)) return { kind: "server-busy" };
			if (await hasRateLimitToast(page)) return { kind: "rate-limited" };
			throw new LlmError(autoSend ? "deepseek-web: 发送流程在确认网页响应之前就中断了（页面被关闭或网络监听失效）。请人工检查网页后重试。" : "deepseek-web: 等待你点击“发送”期间流程中断（页面被关闭或网络监听失效）。请确认输入框内容后重试。", autoSend ? "WEB_AUTO_SEND_TIMEOUT" : "WEB_MANUAL_SEND_TIMEOUT");
		} finally {
			waiterActive = false;
			this.pacerState.noteEnded();
			clearTimeout(ackTimer);
			clearInterval(toastTimer);
			if (progressTimer) clearInterval(progressTimer);
			if (abortListener) request.signal?.removeEventListener("abort", abortListener);
			await this.markPageStatus(page, void 0).catch(() => {});
		}
	}
	/**
	* 可中断的等待（AbortSignal 触发时抛 WEB_TURN_ABORTED）。
	*
	* `onTick` 每满 1 秒回调一次剩余毫秒，用于刷新倒计时；回调是同步的，
	* 内部也别 await——等待期间页面可能已经没了，刷新失败不该影响等待本身。
	*/
	async sleep(ms, signal, onTick) {
		const step = 200;
		for (let waited = 0; waited < ms; waited += step) {
			if (signal?.aborted) throw new LlmError("deepseek-web: 等待频控重发期间回合被取消。", "WEB_TURN_ABORTED");
			if (onTick !== void 0 && waited % 1e3 === 0) onTick(Math.max(0, ms - waited));
			await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
		}
	}
	/** 在 [min, max] 区间内取一个随机毫秒数；任何一端非法就按另一端处理。 */
	pickPause(min, max) {
		const lo = Math.max(0, Math.min(min, max));
		const hi = Math.max(0, Math.max(min, max));
		return lo + Math.random() * (hi - lo);
	}
	/**
	* 连续请求过多时强制长休：真人不会连着几十轮零休息地发消息。
	* 计数按"账号/通道实例"累积，10 分钟内没有新请求即视为断开、重新从 0 数。
	*/
	async maybeTakeLongRunPause(page, signal) {
		const { longRunAfterSends, longRunPauseMinMs, longRunPauseMaxMs } = this.options.config;
		if (!longRunAfterSends || longRunAfterSends <= 0) return;
		const now = Date.now();
		if (now - this.lastSendAt > 10 * 6e4) this.consecutiveSends = 0;
		this.consecutiveSends += 1;
		this.lastSendAt = now;
		if (this.consecutiveSends <= longRunAfterSends) return;
		const pause = this.pickPause(longRunPauseMinMs, longRunPauseMaxMs);
		this.consecutiveSends = 0;
		if (pause < 1) return;
		console.info(`[deepseek-web] 连续 ${longRunAfterSends} 轮请求，按防风控策略静默 ${(pause / 1e3).toFixed(1)}s…`);
		await this.markPageStatus(page, `[dsh 防风控静默 ${(pause / 1e3).toFixed(0)}s]`).catch(() => {});
		await this.sleep(pause, signal);
	}
	/**
	* 注入页面网络镜像（fetch + XHR）：把匹配 chat/completion 的 POST 响应体
	* 累积到 window.__dshWebCapture，供实时思考流轮询。幂等，页面导航后重装。
	*/
	async ensureCapture(page) {
		await page.evaluate(() => {
			const w = window;
			if (w.__dshWebCapture) {
				w.__dshWebCapture.entries = w.__dshWebCapture.entries.slice(-20);
				return;
			}
			const state = { entries: [] };
			w.__dshWebCapture = state;
			const matches = (url, method) => {
				if (method !== void 0 && method.toUpperCase() !== "POST") return false;
				return /\/chat\/completion/i.test(url);
			};
			const keep = (entry) => {
				state.entries.push(entry);
				if (state.entries.length > 20) state.entries.splice(0, state.entries.length - 20);
			};
			const originalFetch = w.fetch.bind(w);
			w.fetch = async (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";
				const method = init?.method ?? (input instanceof Request ? input.method : void 0);
				if (!matches(String(url), method)) return originalFetch(input, init);
				const entry = {
					at: Date.now(),
					body: "",
					done: false
				};
				keep(entry);
				try {
					const response = await originalFetch(input, init);
					const reader = response.clone().body?.getReader();
					if (reader) {
						const decoder = new TextDecoder();
						(async () => {
							for (;;) {
								const { done, value } = await reader.read();
								if (value) entry.body += decoder.decode(value, { stream: true });
								if (done) break;
							}
							entry.done = true;
						})().catch(() => {
							entry.done = true;
						});
					} else entry.done = true;
					return response;
				} catch (error) {
					entry.done = true;
					throw error;
				}
			};
			const originalOpen = XMLHttpRequest.prototype.open;
			const originalSend = XMLHttpRequest.prototype.send;
			XMLHttpRequest.prototype.open = function(method, url, ...rest) {
				this.__dshUrl = String(url);
				this.__dshMethod = String(method);
				return originalOpen.apply(this, [
					method,
					url,
					...rest
				]);
			};
			XMLHttpRequest.prototype.send = function(...args) {
				if (matches(this.__dshUrl ?? "", this.__dshMethod)) {
					const entry = {
						at: Date.now(),
						body: "",
						done: false
					};
					keep(entry);
					this.addEventListener("progress", () => {
						try {
							entry.body = this.responseText ?? "";
						} catch {}
					});
					this.addEventListener("loadend", () => {
						entry.done = true;
					});
				}
				return originalSend.apply(this, args);
			};
		}).catch((error) => {
			console.warn("[deepseek-web] 实时思考流镜像注入失败（不影响最终回复）：", error instanceof Error ? error.message : error);
		});
	}
	/** 启动实时增量轮询；返回要清理的 timer（仅当 liveThinking 开启）。 */
	async startProgressPolling(page, request) {
		if (this.options.config.liveThinking !== true) return void 0;
		await this.ensureCapture(page);
		const startedAt = Date.now() - 1e3;
		const onProgress = request.onProgress;
		let emittedText = "";
		let emittedReasoning = "";
		/** 已结束的流不会再变，缓存解析结果，避免每 250ms 重复解析几十 KB。 */
		const settled = /* @__PURE__ */ new Map();
		let failureStreak = 0;
		let failureWarned = false;
		return setInterval(() => {
			page.evaluate((since) => {
				const state = window.__dshWebCapture;
				if (!state) return void 0;
				const candidates = state.entries.filter((entry) => entry.at >= since && entry.body.length > 0);
				if (candidates.length === 0) return void 0;
				return candidates.map((entry) => ({
					at: entry.at,
					body: entry.body,
					done: entry.done
				}));
			}, startedAt).then((captured) => {
				failureStreak = 0;
				failureWarned = false;
				if (!captured || captured.length === 0) return;
				const texts = [];
				const reasonings = [];
				for (const entry of [...captured].sort((a, b) => a.at - b.at)) {
					let parsed = settled.get(entry.at);
					if (parsed === void 0) {
						const result = parseCompletionBody(entry.body);
						parsed = {
							text: result.text,
							reasoning: result.reasoning ?? "",
							reliable: result.reliable === true
						};
						if (entry.done) settled.set(entry.at, parsed);
					}
					if (!parsed.reliable) continue;
					if (parsed.text) texts.push(parsed.text);
					if (parsed.reasoning) reasonings.push(parsed.reasoning);
				}
				const text = mergeMonotonic(texts);
				const reasoning = mergeMonotonic(reasonings);
				const textDelta = takeDelta(text, emittedText, "text");
				const reasoningDelta = takeDelta(reasoning, emittedReasoning, "reasoning");
				emittedText = text;
				emittedReasoning = reasoning;
				if (textDelta === "" && reasoningDelta === "") return;
				if (POLLUTION_PATTERN.test(textDelta) || POLLUTION_PATTERN.test(reasoningDelta)) {
					console.warn("[deepseek-web] 实时增量里检测到原始流特征，已丢弃本批增量。");
					return;
				}
				if (textDelta.length > 8e3 || reasoningDelta.length > 8e3) {
					console.warn("[deepseek-web] 实时增量异常巨大，已丢弃本批增量。");
					return;
				}
				try {
					onProgress?.({
						text: textDelta,
						reasoning: reasoningDelta
					});
				} catch (error) {
					console.warn("[deepseek-web] 实时思考流回调异常（已忽略）：", error instanceof Error ? error.message : error);
				}
			}).catch((error) => {
				failureStreak += 1;
				if (!failureWarned && failureStreak >= 4) {
					failureWarned = true;
					console.warn("[deepseek-web] 实时增量读取连续失败，页面可能在导航或已失效（最终回复不受影响）：", error instanceof Error ? error.message : error);
				}
			});
		}, PROGRESS_POLL_MS);
	}
	/** 填入消息 / 首次请求：把网页窗口提到最前（受 config.focus 开关控制）。 */
	async focusBrowser() {
		const focus = this.options.config.focus;
		if (focus?.enabled === false || focus?.webWindow === false) return;
		if (!this.page || this.page.isClosed()) return;
		await this.page.bringToFront().catch(() => {});
	}
	/** 回合（含审核）结束、正文交给 Harness：把 dsh 宿主窗口提到最前。 */
	async focusHarness() {
		const focus = this.options.config.focus;
		if (focus?.enabled === false || focus?.dshWindow === false) return;
		await focusDshWindow({
			processNames: focus?.dshProcessNames,
			titlePattern: focus?.dshTitlePattern
		}).catch(() => {});
	}
	autoSendSessions = /* @__PURE__ */ new Map();
	/** 记录会话的发送方式：全自动会话的后续轮次与自审轮次都自动发送。 */
	setSessionAutoSend(sessionId, auto) {
		this.autoSendSessions.set(sessionId, auto);
	}
	/**
	* 记录"当前 agent 会话"。
	* 同对话自审（preserveConversation）用它定位要写入的网页页：
	* 多会话并行时，"最近用过的页"可能是子代理的页，审稿内容就会串进子代理的对话。
	*/
	setConversationFocus(sessionId) {
		this.focusSessionId = sessionId;
	}
	/** 置顶/取消置顶插件专用的 Edge 窗口（按 profile 目录定位）。 */
	async setWebWindowTopmost(_sessionId, topmost) {
		const focus = this.options.config.focus;
		if (focus?.enabled === false || focus?.webWindow === false) return;
		await setBrowserWindowTopmost({
			profileDir: this.profileDir,
			topmost
		}).catch(() => {});
	}
	async status() {
		if (!this.browser || !this.context) return {
			ready: false,
			message: "浏览器尚未启动"
		};
		const anchor = this.page && !this.page.isClosed() ? this.page : this.mostRecentState()?.page;
		const modelLabel = WEB_MODEL_CAPABILITIES[this.options.config.model]?.label;
		const tabs = this.sessionPages.size;
		return {
			ready: anchor !== void 0 && !anchor.isClosed(),
			...anchor ? { url: anchor.url() } : {},
			message: `浏览器已连接${modelLabel ? `，目标模型：${modelLabel}` : ""}${tabs > 0 ? `，并行会话页 ${tabs}/${this.options.config.maxSessionPages}` : ""}`
		};
	}
	/**
	* 只读登录态探活。
	*
	* 刻意**不调用 `ensureReady()`**：探活是后台例行检查，不该因为一次定时检查
	* 就把浏览器拉起来（没有浏览器时返回 `unknown`）。有会话页时优先用它，否则用
	* 锚点页；页面已关就说明浏览器那边已经不在了。
	*/
	async probeLogin() {
		const checkedAt = Date.now();
		if (!this.browser || !this.context) return {
			status: "unknown",
			detail: "浏览器还没启动，无法探活（探活不会主动拉起浏览器）",
			checkedAt
		};
		if (!this.browser.isConnected()) return {
			status: "expired",
			detail: "浏览器连接已断开",
			checkedAt
		};
		const page = this.page && !this.page.isClosed() ? this.page : this.mostRecentState()?.page;
		if (page === void 0 || page.isClosed()) return {
			status: "unknown",
			detail: "还没有可用的会话页",
			checkedAt
		};
		if (await looksLoggedOut(page, [
			"sign_in",
			"sign-in",
			"login",
			"auth"
		])) return {
			status: "expired",
			detail: "页面已跳到登录入口",
			checkedAt
		};
		if (await looksLoginWall(page)) return {
			status: "expired",
			detail: "页面显示登录墙（输入框可用但发送被禁用）",
			checkedAt
		};
		return {
			status: "ok",
			checkedAt
		};
	}
	async dispose() {
		if (this.options.config.browser === "attach") {
			this.sessionPages.clear();
			this.creatingPages.clear();
			this.pendingPages.clear();
			this.autoSendSessions.clear();
			this.page = void 0;
			return;
		}
		await Promise.all([...this.sessionPages.values()].map((state) => state.page.close().catch(() => {})));
		this.sessionPages.clear();
		this.creatingPages.clear();
		this.pendingPages.clear();
		this.autoSendSessions.clear();
		const managed = this.managedConnection;
		this.managedConnection = void 0;
		await managed?.browser.close().catch(() => {});
		if (managed?.process && !managed.process.killed) managed.process.kill();
		this.browser = void 0;
		this.context = void 0;
		this.page = void 0;
		this.focusSessionId = void 0;
	}
};

//#endregion
//#region src/kimi-channel.ts
/** Kimi 对话接口（Connect-RPC，`application/connect+json`）。 */
function matchesKimiCompletion(url) {
	return /ChatService\/Chat/i.test(url);
}
/**
* 发送确认之后等“网页响应流”的上限。
*
* 只管**发送确认完成之后**那一段：正常 1~3 秒就回响应头，卡住时不该让回合白等
* `streamIdleTimeoutMs`（默认 600 秒）。填字与发送确认的耗时不计入这里——早期实现把这个
* 窗口挂在填字之前，长审核提示词必然超时，Kimi 答了插件却报“等待回复超时”。
*/
const KIMI_ACK_TIMEOUT_MS = 12e4;
/**
* 解析 Kimi Connect-RPC 流：5 字节帧头（1 字节 flags + 4 字节大端长度）+ JSON 载荷。
*
* 事件形态（实测样本）：
* - `{"op":"set","mask":"block.text","block":{"id","text":{"content"}}}` 建立正文块
* - `{"op":"append","mask":"block.text.content","block":{"id","text":{"content"}}}` 追加正文
* - `block.think` / `block.think.content` 同理，属于思考内容
* - `{"op":"set","mask":"message.status","message":{"status":"MESSAGE_STATUS_COMPLETED"}}` 结束
* - flags=2 的帧是 Connect 的 end-of-stream 哨兵
*/
function parseKimiCompletion(input) {
	const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, "binary");
	const textBlocks = /* @__PURE__ */ new Map();
	const thinkBlocks = /* @__PURE__ */ new Map();
	const textOrder = [];
	const thinkOrder = [];
	const upsert = (store, order, id, content, append) => {
		if (!store.has(id)) order.push(id);
		store.set(id, append ? `${store.get(id) ?? ""}${content}` : content);
	};
	let offset = 0;
	while (offset + 5 <= buffer.length) {
		const flags = buffer[offset];
		const length = buffer.readUInt32BE(offset + 1);
		if (offset + 5 + length > buffer.length) break;
		let payload = buffer.subarray(offset + 5, offset + 5 + length);
		offset += 5 + length;
		if ((flags & 2) !== 0) break;
		if ((flags & 1) !== 0) try {
			payload = gunzipSync(payload);
		} catch {}
		let event;
		try {
			event = JSON.parse(payload.toString("utf8"));
		} catch {
			continue;
		}
		const append = event.op === "append";
		const mask = event.mask ?? "";
		const blockId = event.block?.id ?? mask;
		if (mask.startsWith("block.text")) {
			const content = event.block?.text?.content;
			if (typeof content === "string") upsert(textBlocks, textOrder, blockId, content, append);
		} else if (mask.startsWith("block.think")) {
			const content = event.block?.think?.content;
			if (typeof content === "string") upsert(thinkBlocks, thinkOrder, blockId, content, append);
		} else if (mask === "message" && event.message?.role === "assistant" && Array.isArray(event.message.blocks)) for (const raw of event.message.blocks) {
			const block = raw;
			const id = block.id ?? `${textOrder.length}`;
			if (typeof block.text?.content === "string") upsert(textBlocks, textOrder, id, block.text.content, false);
			if (typeof block.think?.content === "string") upsert(thinkBlocks, thinkOrder, id, block.think.content, false);
		}
	}
	const collect = (store, order) => order.map((id) => store.get(id) ?? "").join("").trim();
	const text = collect(textBlocks, textOrder);
	const reasoning = collect(thinkBlocks, thinkOrder);
	if (!text && !reasoning) {
		const dir = defaultProfileDir("calibration");
		const file = path.join(dir, `kimi-unparsed-${Date.now()}.bin`);
		import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(file, buffer))).catch(() => {});
		throw new LlmError("kimi: Connect-RPC 流里没有解析出正文", "KIMI_EMPTY_RESPONSE");
	}
	return {
		text,
		...reasoning ? { reasoning } : {}
	};
}
var KimiBrowserChannel = class KimiBrowserChannel {
	browser;
	context;
	page;
	conversationStarted = false;
	titleState = {};
	options;
	profileDir;
	label;
	/** 每个会话当前的取消控制器；cancelTurn 据此打断等待中的回合。 */
	cancels = /* @__PURE__ */ new Map();
	/** 会话级的自动发送设置（来自主配置 sendMode 或 setSessionAutoSend）。 */
	autoSendSessions = /* @__PURE__ */ new Map();
	/**
	* 当前审核页是用哪种模式的入口打开的（undefined = 本实例还没开过，页面来源未知）。
	*
	* 必须记下来而不是看 URL：项目页发出第一条消息后地址会变成 `/chat/<uuid>`，
	* 与普通对话完全同形，靠路径无法分辨“这一页属于项目模式还是正常模式”。
	*/
	pageMode;
	constructor(options) {
		this.options = options;
		this.profileDir = options.profileDir ?? options.config.profileDir ?? defaultProfileDir("kimi-profile");
		this.label = options.label ?? "kimi";
	}
	/** 缓存的页面是否仍然可用：浏览器连着、页面没被关掉。 */
	isPageUsable() {
		return Boolean(this.browser?.isConnected() && this.page && !this.page.isClosed());
	}
	/** 丢掉失效连接，让下一次 ensureReady 重新建连。 */
	dropConnection() {
		this.browser = void 0;
		this.context = void 0;
		this.page = void 0;
		this.pageMode = void 0;
		this.conversationStarted = false;
	}
	async ensureReady() {
		if (this.isPageUsable()) return;
		if (this.browser || this.page) {
			console.info("[kimi] 浏览器或页面已失效，重新建立连接…");
			this.dropConnection();
		}
		const entryUrl = this.resolveEntryUrl();
		const { browser, context } = await connectBrowser({
			port: this.options.config.debugPort,
			profileDir: this.profileDir,
			url: entryUrl,
			autoStartKeeper: true,
			label: this.label
		});
		this.browser = browser;
		this.context = context;
		const pages = context.pages();
		const origin = KimiBrowserChannel.safeOrigin(entryUrl);
		this.page = (origin ? pages.find((item) => item.url().startsWith(origin)) : void 0) ?? pages[0] ?? await context.newPage();
		await ensureChatPage(this.page, entryUrl);
		await this.waitEditorReady(this.page);
		if (await looksLoginWall(this.page)) throw new LlmError("kimi: 浏览器窗口已打开，但尚未登录（发送按钮处于禁用状态）。请先运行 node tools/open-login-kimi.mjs 完成一次登录。", "KIMI_LOGIN_REQUIRED");
	}
	/** 等输入框可见可用；提前就绪就提前返回，不再固定长等待。 */
	async waitEditorReady(page) {
		if (!await locateEditor(page).waitFor({
			state: "visible",
			timeout: 8e3
		}).then(() => true).catch(() => false)) throw new LlmError("kimi: 等待输入框出现超时。请确认浏览器停留在 Kimi 的对话页面（未登录时也会停在登录页）。", "KIMI_EDITOR_NOT_FOUND");
	}
	/** 新建对话后等页面重新进入可输入状态；就绪即返回。 */
	async settleAfterNewChat(page) {
		await locateEditor(page).waitFor({
			state: "visible",
			timeout: 5e3
		}).catch(() => {});
		await page.waitForTimeout(120);
	}
	/**
	* 解析本轮审核要打开的入口地址：正常模式与项目模式各用各的，互不兜底。
	*
	* 选了项目模式却没填项目时直接报错——静默退回普通对话会让审核结果落错地方，
	* 比明确失败更难发现。
	*/
	resolveEntryUrl() {
		const config = this.options.config;
		if (config.kimiMode === "project") {
			const raw$1 = (config.projectUrl ?? "").trim();
			if (raw$1.length === 0) throw new LlmError("kimi: 审核模式是「项目模式」，但还没填项目。请到设置里把「项目 ID」填上（从项目页地址 https://www.kimi.com/project/<项目ID> 里取最后那段，形如 1a15bef4-b7a2-894f-8000-0e7143648841，只填 ID 就行）；若只想用普通对话，把「审核模式」切回「正常模式」。", "KIMI_PROJECT_URL_MISSING");
			return KimiBrowserChannel.toProjectUrl(raw$1, config.url);
		}
		const raw = (config.url ?? "").trim();
		return raw.length > 0 ? raw : "https://www.kimi.com/?chat_enter_method=new_chat";
	}
	/**
	* 把用户填的「项目」变成可打开的项目页地址。
	*
	* 只填项目 ID 是常态：手动抄一整条带查询参数的链接太容易出错，而域名在
	* 「正常模式链接」里已经有了（企业版域名也能跟着走）。所以：
	* - 已经是完整 URL（有 scheme）→ 原样返回，兼容老配置里存整条链接的情况；
	* - 只给了 ID → 用正常模式的 origin 拼 `<origin>/project/<ID>?chat_enter_method=new_chat`；
	* - 看起来不是 ID → 明确报错，别把一句说明文字拼进路径里再打开一个 404。
	*/
	static toProjectUrl(raw, normalUrl) {
		const text = raw.trim();
		if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) return text;
		const id = text.replace(/^\/+/u, "").replace(/\/+$/u, "").trim();
		if (!/^[0-9A-Za-z][0-9A-Za-z_-]*$/u.test(id)) throw new LlmError(`kimi: 项目 ID「${text}」看起来不合法。只填项目页地址里 /project/ 后面那一段，形如 1a15bef4-b7a2-894f-8000-0e7143648841（字母、数字和连字符）；要填完整项目页链接也可以，但必须以 http(s):// 开头。`, "KIMI_PROJECT_ID_INVALID");
		return `${KimiBrowserChannel.safeOrigin(normalUrl) ?? "https://www.kimi.com"}/project/${id}?chat_enter_method=new_chat`;
	}
	/**
	* 当前页面是否属于所选审核模式的入口。
	*
	* 正常模式不该停在项目页里（那会把对话归档到项目下）；项目模式两种页面都算——
	* 项目页发出第一条消息后地址会变成 `/chat/<uuid>`，无法再用路径判断归属。
	*/
	pageMatchesMode(page) {
		if (this.pageMode !== void 0 && this.pageMode !== this.options.config.kimiMode) return false;
		try {
			const entry = new URL(this.resolveEntryUrl());
			return new URL(page.url()).origin === entry.origin;
		} catch {
			return true;
		}
	}
	/** 取地址的 origin；地址不合法时返回 undefined，避免 `new URL` 直接抛错盖掉真正原因。 */
	static safeOrigin(raw) {
		try {
			return new URL(raw).origin;
		} catch {
			return;
		}
	}
	/**
	* 开一个**全新的标签页**当审核窗口，而不是在旧标签里点“新建会话”。
	*
	* 为什么不用点按钮：Kimi 的入口是只有一个图标的链接，标签页在后台时
	* `locator.click()` 点不动；而直接 `goto` 首页又会被恢复成上一次的对话。
	* 两条路都实测失败过，表现就是「每轮审核都在同一个对话里」，越审越慢。
	*
	* 现在直接开新标签并带上 Kimi 自己的新建参数 `?chat_enter_method=new_chat`，
	* 实测新标签打开就是 0 条消息的干净对话（约 3 秒）。旧的审核标签在新标签就绪后关掉，
	* 保证任何时候只有一个 Kimi 审核页，不会攒一堆标签。
	*/
	async openFreshConversation() {
		const context = this.page?.context();
		if (!context) throw new LlmError("kimi: 找不到浏览器上下文，无法新建审核标签页。", "KIMI_PAGE_CLOSED");
		const freshUrl = ensureFreshChatUrl(this.resolveEntryUrl());
		const fresh = await context.newPage();
		try {
			await fresh.goto(freshUrl, {
				waitUntil: "domcontentloaded",
				timeout: 3e4
			});
			await this.waitEditorReady(fresh);
			const carried = await fresh.evaluate(`document.querySelectorAll('[class*="chat-content-item"], [class*="message-item"]').length`).catch(() => 0);
			if (typeof carried === "number" && carried > 0) {
				await this.clickNewChatEntry(fresh);
				await fresh.waitForTimeout(800);
			}
		} catch (error) {
			await fresh.close().catch(() => {});
			throw error;
		}
		const previous = this.page;
		this.page = fresh;
		this.pageMode = this.options.config.kimiMode;
		if (previous && previous !== fresh) if (await Promise.race([previous.close({ runBeforeUnload: false }).then(() => true).catch((error) => {
			console.warn(`[kimi] 关闭旧审核标签失败（不影响本轮）：${error instanceof Error ? error.message : String(error)}`);
			return false;
		}), new Promise((resolve) => setTimeout(() => resolve(false), 3e3))])) console.info("[kimi] 已关闭上一轮的审核标签");
		else console.warn("[kimi] 关闭旧审核标签超时，该标签会保留在浏览器里");
		const carriedNow = await fresh.evaluate(`document.querySelectorAll('[class*="chat-content-item"], [class*="message-item"]').length`).catch(() => 0);
		console.info(`[kimi] 已打开新的审核标签页（历史消息 ${String(carriedNow)} 条）`);
	}
	/** 兜底：在页面内原生点一次“新建会话”（不要求元素可命中）。 */
	async clickNewChatEntry(page) {
		const NEW_CHAT_CLICK = `(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
      };
      const all = Array.from(document.querySelectorAll('a, button, div, span'));
      const hit = all.find((el) => (el.getAttribute('aria-label') || '').indexOf('新建会话') >= 0 && vis(el))
        || all.find((el) => /new-chat-btn|sidebar-new-chat/.test(String(el.className || '')) && vis(el));
      if (!hit) return false;
      hit.click();
      return true;
    })()`;
		try {
			if (await page.evaluate(NEW_CHAT_CLICK) === true) return true;
		} catch {}
		return await bestEffortNewChat(page, {
			labels: ["新建会话"],
			selectors: [
				"a[aria-label*=\"新建会话\"]",
				".new-chat-btn",
				".sidebar-new-chat"
			]
		}).catch(() => false);
	}
	/** 只清“已初始化对话”的标记：下一轮带 `initialize` 就会新开对话。发送设置不受影响。 */
	resetConversationGate(_sessionId) {
		this.conversationStarted = false;
	}
	/** 记录会话级发送方式；主通道调用同接口，保持两条通道行为一致。 */
	setSessionAutoSend(sessionId, auto) {
		this.autoSendSessions.set(sessionId, auto);
	}
	/** 取消挂在网页上的回合：打断等待中的 promise，让上层立刻拿到结束信号。 */
	async cancelTurn(sessionId) {
		if (sessionId) {
			this.cancels.get(sessionId)?.abort();
			return;
		}
		for (const controller of this.cancels.values()) controller.abort();
	}
	/**
	* 这一轮失败后还值得再试一次吗？
	*
	* 只重试“环境抖动”类失败：等回复超时、拿到空响应、页面/连接断掉、发送没被确认。
	* 认得出根因、再试也没用的失败（没登录、发送被禁用、找不到输入框、用户取消）
	* 直接抛给用户，避免用重试把明确的错误拖成更长的等待。
	*/
	static retryable(error) {
		const code = error?.code;
		return code === "KIMI_RESPONSE_TIMEOUT" || code === "KIMI_EMPTY_RESPONSE" || code === "KIMI_PAGE_CLOSED" || code === "KIMI_SEND_FAILED" || code === "KIMI_STREAM_STALLED";
	}
	/**
	* 提交一轮审核。
	*
	* 获取阶段出错时会自动重连并重试（`review.fetchRetries`，默认 1 次）：
	* 原实现失败即抛，网页卡住时只能由用户手动再点一次，这正是“获取出问题就卡住、
	* 不会重新获取”的形态。重试前一律丢弃旧连接，避免在已经死掉的页面上重试。
	*/
	async turn(request) {
		const retries = KimiBrowserChannel.sanitizeRetries(this.options.config.fetchRetries, 1, 3);
		let lastError;
		for (let attempt = 0; attempt <= retries; attempt += 1) {
			if (request.signal?.aborted) throw new LlmError("kimi: 本轮审核已被取消", "KIMI_TURN_CANCELLED");
			try {
				return await this.turnOnce(request);
			} catch (error) {
				lastError = error;
				if (!(attempt < retries && KimiBrowserChannel.retryable(error) && !request.signal?.aborted)) throw error;
				const reason = error instanceof Error ? error.message : String(error);
				console.warn(`[kimi] 第 ${attempt + 1} 次尝试失败（${reason}），重连后重试…`);
				this.dropConnection();
				try {
					await this.ensureReady();
				} catch (connectError) {
					throw new LlmError(`kimi: 重新连接审核浏览器失败（${connectError instanceof Error ? connectError.message : String(connectError)}）。`, "KIMI_RECONNECT_FAILED", { cause: connectError });
				}
				await new Promise((resolve) => setTimeout(resolve, 800));
			}
		}
		throw lastError ?? new LlmError("kimi: 审核回合没有执行（内部重试计数异常）", "KIMI_TURN_NOT_RUN");
	}
	/**
	* 把配置里的重试次数收敛成安全整数。
	*
	* volatile 数值字段在 Loader 尚未提交值时可能读到 `NaN`，而 `NaN ?? 1` 仍是 `NaN`；
	* `Math.max(0, Math.min(3, NaN))` 依旧是 `NaN`，会让 `attempt <= retries` 恒为 false，
	* 循环整体被跳过、上层收到 `undefined` 异常。这里统一按有限值校验并夹到合法区间。
	*/
	static sanitizeRetries(raw, fallback, max) {
		if (raw === null || raw === void 0 || raw === "") return fallback;
		const value = Number(raw);
		if (!Number.isFinite(value)) return fallback;
		return Math.max(0, Math.min(max, Math.trunc(value)));
	}
	async turnOnce(request) {
		if (!this.isPageUsable()) {
			this.dropConnection();
			await this.ensureReady();
		}
		const config = this.options.config;
		const autoSend = request.autoSend ?? this.autoSendSessions.get(request.sessionId) ?? config.autoSend !== false;
		const verifyMs = config.sendVerifyMs ?? 1500;
		const maxAttempts = config.sendRetries ?? 2;
		const controller = new AbortController();
		const abort = () => controller.abort();
		if (request.signal?.aborted) controller.abort();
		else request.signal?.addEventListener("abort", abort, { once: true });
		this.cancels.set(request.sessionId, controller);
		const cancelled = () => controller.signal.aborted;
		try {
			if (request.initialize && !this.conversationStarted) {
				await this.openFreshConversation();
				this.conversationStarted = true;
			} else if (this.page !== void 0 && !this.page.isClosed() && !this.pageMatchesMode(this.page)) {
				console.info("[kimi] 当前审核页与所选模式不符，按新模式重开一个标签页");
				await this.openFreshConversation();
				this.conversationStarted = true;
			}
			const page = this.page;
			if (!page || page.isClosed()) throw new LlmError("kimi: 审核标签页已关闭，重试时会自动重连。", "KIMI_PAGE_CLOSED");
			const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && matchesKimiCompletion(response.url()), { timeout: 0 });
			let sawResponse = false;
			responsePromise.then(() => {
				sawResponse = true;
			}).catch(() => {});
			const completionPromise = responsePromise.then(async (response) => {
				await markPageTitle(page, "[dsh Kimi 审核生成中]", this.titleState).catch(() => {});
				const [, body] = await Promise.all([withTimeout(response.finished().catch(() => void 0), config.streamIdleTimeoutMs, "KIMI_STREAM_STALLED", "kimi: 等待回复流结束超时"), withTimeout(response.body().catch(() => Buffer.alloc(0)), config.streamIdleTimeoutMs, "KIMI_STREAM_STALLED", "kimi: 读取回复体超时")]);
				return {
					url: response.url(),
					status: response.status(),
					body
				};
			});
			completionPromise.catch(() => {});
			const aborted = new Promise((_, reject) => {
				const rejectCancelled = () => reject(new LlmError("kimi: 本轮审核已被取消", "KIMI_TURN_CANCELLED"));
				if (cancelled()) {
					rejectCancelled();
					return;
				}
				controller.signal.addEventListener("abort", rejectCancelled, { once: true });
			});
			const ackTimeoutMs = Math.min(config.streamIdleTimeoutMs, KIMI_ACK_TIMEOUT_MS);
			let ackTimer;
			let ackDeadline;
			const startAckClock = () => {
				clearTimeout(ackTimer);
				ackDeadline = new Promise((_, reject) => {
					ackTimer = setTimeout(() => {
						reject(new LlmError(autoSend ? `kimi: 消息已发送，但 ${Math.round(ackTimeoutMs / 1e3)} 秒内没有等到网页的响应流（HTTP 层未捕获到本轮请求）。请人工检查 Kimi 窗口：对话里若已出现这条消息并开始回答，说明响应被页面拦截或网络中断；若输入框里还留着内容，说明回车没触发发送。确认后重试本轮任务。` : `kimi: 消息已填入输入框，等待你点击“发送”超时（${Math.round(ackTimeoutMs / 1e3)} 秒）。请确认输入框内容后点击页面上的发送按钮重试。`, autoSend ? "KIMI_RESPONSE_TIMEOUT" : "KIMI_MANUAL_SEND_TIMEOUT"));
					}, ackTimeoutMs);
				});
				ackDeadline.catch(() => {});
			};
			const editor = locateEditor(page);
			if (!await editor.isVisible().catch(() => false)) throw new LlmError("kimi: 未找到对话输入框。请确认浏览器停留在 Kimi 的对话页。", "KIMI_EDITOR_NOT_FOUND");
			await editor.click();
			await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
			await page.keyboard.press("Backspace");
			await page.keyboard.insertText(request.text);
			let sendBlocked = await looksSendBlocked(page);
			if (sendBlocked) {
				await page.waitForTimeout(300);
				sendBlocked = await looksSendBlocked(page);
			}
			if (sendBlocked) throw new LlmError("kimi: 发送按钮不可用，消息发不出去——通常是尚未登录 www.kimi.com。请先运行 node tools/open-login-kimi.mjs 登录；若已登录请确认页面没有正在生成的回复。", "KIMI_SEND_BLOCKED");
			this.conversationStarted = true;
			if (autoSend) {
				await this.focusBrowser();
				await markPageTitle(page, "[dsh Kimi 审核发送中]", this.titleState).catch(() => {});
				const outcome = await sendEditorMessage(page, editor, {
					verifyTimeoutMs: verifyMs,
					maxAttempts,
					pauseMinMs: 80,
					pauseMaxMs: 240,
					hasResponse: () => sawResponse,
					isCancelled: cancelled
				});
				if (!outcome.sent) throw new LlmError(`kimi: 消息已填入输入框，但没能确认发送出去。尝试记录：${outcome.attempts.join("；")}。页面可能改版导致回车和发送按钮都失效：请在 Kimi 窗口手动点一次“发送”后重试，或把 review.autoSend 关掉改为半自动（人工点发送）。`, "KIMI_SEND_FAILED");
				console.info(`[kimi] 审核消息已自动发送（方式：${outcome.via}）`);
			} else {
				await page.bringToFront();
				await markPageTitle(page, "[dsh 等待你在 Kimi 点击发送]", this.titleState).catch(() => {});
				console.info("[kimi] 消息已填入 Edge，请在 Kimi 页面点击“发送”…");
			}
			startAckClock();
			let completion;
			try {
				completion = await Promise.race([
					completionPromise,
					aborted,
					ackDeadline
				]);
				console.info("[kimi] 已收到 Kimi 完整回复，正在解析…");
			} catch (error) {
				if (error instanceof LlmError) throw error;
				if (!this.browser?.isConnected() || page.isClosed()) {
					console.warn("[kimi] 页面或浏览器已失效，丢弃连接以便下一轮重连：", error instanceof Error ? error.message : error);
					this.dropConnection();
					throw new LlmError("kimi: 浏览器页面已关闭或连接中断，本轮审核未完成。重试时会自动重新连接。", "KIMI_PAGE_CLOSED", { cause: error });
				}
				throw new LlmError(autoSend ? "kimi: 发送流程在确认网页响应之前就中断了（页面被关闭或网络监听失效）。请人工检查 Kimi 窗口后重试。" : "kimi: 等待你点击“发送”期间流程中断（页面被关闭或网络监听失效）。请确认输入框内容后重试。", autoSend ? "KIMI_RESPONSE_TIMEOUT" : "KIMI_MANUAL_SEND_TIMEOUT", { cause: error });
			} finally {
				clearTimeout(ackTimer);
				await markPageTitle(page, void 0, this.titleState).catch(() => {});
			}
			if (completion.body.length === 0) throw new LlmError("kimi: 收到回复响应但响应体为空（通常是限流或网络中断）。已保留页面，请检查 Kimi 窗口后重试。", "KIMI_EMPTY_RESPONSE");
			return parseKimiCompletion(completion.body);
		} finally {
			request.signal?.removeEventListener("abort", abort);
			this.cancels.delete(request.sessionId);
		}
	}
	/** 填入消息：把 Kimi 窗口提到最前（受注入的 focus 开关控制）。 */
	async focusBrowser() {
		const focus = this.options.focus;
		if (focus && (focus.enabled === false || focus.webWindow === false)) return;
		if (!this.page || this.page.isClosed()) return;
		await this.page.bringToFront().catch(() => {});
	}
	/**
	* 仅用于满足 BrowserChannel 接口的一致性占位：
	* 实际“审核完全结束后聚焦 dsh 窗口”由主通道 adapter 在最终正文交付前统一触发，
	* 本方法当前没有调用点，保留是为了让两条通道实现同一接口时不出现方法缺失。
	*/
	async focusHarness() {
		const focus = this.options.focus;
		if (!focus || focus.enabled === false || focus.dshWindow === false) return;
		await focusDshWindow({
			processNames: focus.dshProcessNames,
			titlePattern: focus.dshTitlePattern
		}).catch(() => {});
	}
	async status() {
		if (!this.isPageUsable()) return {
			ready: false,
			url: this.page && !this.page.isClosed() ? this.page.url() : void 0,
			message: this.browser && !this.browser.isConnected() ? "Kimi 浏览器连接已断开，下次请求会自动重连" : "Kimi 浏览器尚未启动"
		};
		return {
			ready: true,
			url: this.page.url(),
			message: "Kimi 审核通道已连接"
		};
	}
	async dispose() {
		for (const controller of this.cancels.values()) controller.abort();
		this.cancels.clear();
		this.autoSendSessions.clear();
		this.dropConnection();
	}
};

//#endregion
//#region src/glm-channel.ts
/** GLM 对话接口（SSE，`text/event-stream`）。 */
function matchesGlmCompletion(url) {
	return /chat\/completions/i.test(url);
}
/**
* 发送之后等“网页响应流”的上限。
*
* 这个值只管**发送确认完成之后**那一段：审核页正常 1~3 秒就回响应头，卡住时不该让回合白等
* 10 分钟（`review.streamIdleTimeoutMs` 默认 600 秒）。填字与发送确认的耗时不计入这里——
* 早期实现把 2 分钟窗口挂在填字之前，长提示词必然超时，网页答了插件却报没收到。
*/
const ACK_TIMEOUT_MS = 12e4;
/**
* 解析 GLM SSE 流。
*
* 事件形态（2026-09 真实样本，`calibration/glm-chat-*.bin`）：
* - `{"phase":"thinking","delta_content":"…"}` 思考过程 —— **不是正文**，单独归到 reasoning
* - `{"phase":"answer","delta_content":"…"}` 增量正文
* - `{"phase":"other","usage":{…}}` 用量统计等非正文事件
* - `{"phase":"done","done":true}` 结束
* - `data: [DONE]` 流结束哨兵
*
* 注意：thinking 与 answer 用的是同一个 `delta_content` 字段，只有 `phase` 能区分。
* 早期版本把两者一律并入正文，导致思考过程混进交付文本（会污染审核输入与结论展示）。
*/
function parseGlmCompletion(input) {
	const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
	const raw = buffer.toString("utf8");
	let text = "";
	let reasoning = "";
	let sawAny = false;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		let event;
		try {
			event = JSON.parse(payload);
		} catch {
			continue;
		}
		sawAny = true;
		if (event.type === "chat:completion") {
			const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
			const content = typeof event.data?.delta_content === "string" ? event.data.delta_content : "";
			const deltaReasoning = typeof event.data?.delta_reasoning === "string" ? event.data.delta_reasoning : "";
			if (deltaReasoning) reasoning += deltaReasoning;
			if (content) {
				if (phase === "thinking") reasoning += content;
				else if (phase === "answer" || phase === "") text += content;
			}
		}
	}
	if (!text && !reasoning && sawAny) return { text: "" };
	if (!text && !reasoning) {
		const dir = defaultProfileDir("calibration");
		const file = path.join(dir, `glm-unparsed-${Date.now()}.bin`);
		import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(file, buffer))).catch(() => {});
		throw new LlmError("glm: SSE 流里没有解析出正文", "GLM_EMPTY_RESPONSE");
	}
	return {
		text,
		...reasoning ? { reasoning } : {}
	};
}
var GLMChannel = class {
	browser;
	context;
	page;
	conversationStarted = false;
	titleState = {};
	options;
	profileDir;
	label;
	constructor(options) {
		this.options = options;
		this.profileDir = options.profileDir ?? options.config.glmProfileDir ?? defaultProfileDir("glm-profile");
		this.label = options.label ?? "glm";
	}
	async ensureReady() {
		if (this.browser && this.page) return;
		const { browser, context } = await connectBrowser({
			port: this.options.config.glmDebugPort,
			profileDir: this.profileDir,
			url: this.options.config.glmUrl,
			autoStartKeeper: true,
			label: this.label
		});
		this.browser = browser;
		this.context = context;
		const pages = context.pages();
		this.page = pages.find((item) => item.url().startsWith(new URL(this.options.config.glmUrl).origin)) ?? pages[0] ?? await context.newPage();
		await ensureChatPage(this.page, this.options.config.glmUrl);
		await this.page.waitForTimeout(1500);
		if (await looksLoginWall(this.page)) throw new LlmError("glm: 浏览器窗口已打开，但尚未登录（发送按钮处于禁用状态）。请先运行 node tools/open-login-glm.mjs 完成一次登录，再重试审核。", "GLM_LOGIN_REQUIRED");
	}
	resetConversationGate() {
		this.conversationStarted = false;
	}
	async turn(request) {
		if (!this.page) await this.ensureReady();
		const page = this.page;
		if (request.initialize && !this.conversationStarted) {
			await bestEffortNewChat(page);
			await page.waitForTimeout(800);
			this.conversationStarted = true;
		}
		let sawResponse = false;
		const completionPromise = page.waitForResponse((response) => response.request().method() === "POST" && matchesGlmCompletion(response.url()), { timeout: 0 }).then(async (response) => {
			sawResponse = true;
			await markPageTitle(page, "[dsh GLM 审核生成中]", this.titleState).catch(() => {});
			const [, body] = await Promise.all([withTimeout(response.finished().catch(() => void 0), this.options.config.streamIdleTimeoutMs, "GLM_STREAM_STALLED", "glm: 等待回复流结束超时"), withTimeout(response.body().catch(() => Buffer.alloc(0)), this.options.config.streamIdleTimeoutMs, "GLM_STREAM_STALLED", "glm: 读取回复体超时")]);
			return {
				url: response.url(),
				status: response.status(),
				body
			};
		});
		completionPromise.catch(() => {});
		const ackTimeoutMs = Math.min(this.options.config.streamIdleTimeoutMs, ACK_TIMEOUT_MS);
		let ackTimer;
		let ackDeadline;
		const startAckClock = () => {
			clearTimeout(ackTimer);
			ackDeadline = new Promise((_, reject) => {
				ackTimer = setTimeout(() => {
					reject(new LlmError(request.autoSend ? `glm: 消息已发送，但 ${Math.round(ackTimeoutMs / 1e3)} 秒内没有等到网页的响应流（HTTP 层未捕获到本轮请求）。请人工检查网页：对话里若已出现这条消息并开始回答，说明响应被页面拦截或网络中断；若输入框里还留着内容，说明回车没触发发送。确认后重试本轮任务。` : `glm: 消息已填入输入框，等待你点击“发送”超时（${Math.round(ackTimeoutMs / 1e3)} 秒）。请确认输入框内容后点击页面上的发送按钮重试。`, request.autoSend ? "GLM_AUTO_SEND_TIMEOUT" : "GLM_MANUAL_SEND_TIMEOUT"));
				}, ackTimeoutMs);
			});
			ackDeadline.catch(() => {});
		};
		const editor = locateEditor(page);
		if (!await editor.isVisible().catch(() => false)) throw new LlmError("glm: 未找到对话输入框。请确认浏览器停留在 chat.z.ai 的对话页。", "GLM_EDITOR_NOT_FOUND");
		await editor.click();
		await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
		await page.keyboard.press("Backspace");
		await page.keyboard.insertText(request.text);
		let sendBlocked = await looksSendBlocked(page);
		if (sendBlocked) {
			await page.waitForTimeout(600);
			sendBlocked = await looksSendBlocked(page);
		}
		if (sendBlocked) throw new LlmError("glm: 发送按钮不可用，消息发不出去——通常是尚未登录 chat.z.ai。请先运行 node tools/open-login-glm.mjs 登录；若已登录请确认页面没有正在生成的回复。", "GLM_SEND_BLOCKED");
		if (request.autoSend) {
			await markPageTitle(page, "[dsh 自动发送中]", this.titleState);
			const outcome = await sendEditorMessage(page, editor, {
				verifyTimeoutMs: 3e3,
				maxAttempts: 2,
				pauseMinMs: 0,
				pauseMaxMs: 0,
				hasResponse: () => sawResponse,
				isCancelled: () => request.signal?.aborted ?? false
			});
			if (!outcome.sent) throw new LlmError(`glm: 消息已填入输入框，但没能确认发送出去。尝试记录：${outcome.attempts.join("；")}。页面可能改版导致回车与发送按钮都失效——请人工检查网页后重试。`, "GLM_SEND_NOT_TRIGGERED");
			console.info(`[glm] 全自动：已确认发送（方式：${outcome.via}）。`);
		} else {
			await page.bringToFront();
			this.conversationStarted = true;
			await markPageTitle(page, "[dsh 等待你在 GLM 点击发送]", this.titleState);
			console.info("[glm] 消息已填入 Edge，请在 GLM 页面点击“发送”…");
		}
		startAckClock();
		let completion;
		try {
			completion = await Promise.race([completionPromise, ackDeadline]);
			console.info("[glm] 已收到 GLM 完整回复，正在解析…");
		} catch (error) {
			if (error instanceof LlmError) throw error;
			if (page.isClosed()) throw new LlmError("glm: 浏览器页面被关闭", "GLM_PAGE_CLOSED");
			throw new LlmError(request.autoSend ? "glm: 发送流程在确认网页响应之前就中断了（页面被关闭或网络监听失效）。请人工检查网页后重试。" : "glm: 等待你点击“发送”期间流程中断（页面被关闭或网络监听失效）。请确认输入框内容后重试。", request.autoSend ? "GLM_AUTO_SEND_TIMEOUT" : "GLM_MANUAL_SEND_TIMEOUT", { cause: error });
		} finally {
			clearTimeout(ackTimer);
			await markPageTitle(page, void 0, this.titleState);
		}
		return parseGlmCompletion(completion.body);
	}
	/** 填入消息：把 GLM 窗口提到最前（受注入的 focus 开关控制）。 */
	async focusBrowser() {
		const focus = this.options.focus;
		if (focus && (focus.enabled === false || focus.webWindow === false)) return;
		if (!this.page || this.page.isClosed()) return;
		await this.page.bringToFront().catch(() => {});
	}
	/**
	* 仅用于满足 BrowserChannel 接口的一致性占位：
	* 实际“审核完全结束后聚焦 dsh 窗口”由主通道 adapter 在最终正文交付前统一触发。
	*/
	async focusHarness() {
		const focus = this.options.focus;
		if (!focus || focus.enabled === false || focus.dshWindow === false) return;
		await focusDshWindow({
			processNames: focus.dshProcessNames,
			titlePattern: focus.dshTitlePattern
		}).catch(() => {});
	}
	async status() {
		if (!this.browser || !this.page) return {
			ready: false,
			message: "GLM 浏览器尚未启动"
		};
		return {
			ready: !this.page.isClosed(),
			url: this.page.url(),
			message: "GLM 审核通道已连接"
		};
	}
	async dispose() {
		this.browser = void 0;
		this.context = void 0;
		this.page = void 0;
	}
};

//#endregion
//#region src/reviewer.ts
const KIMI_REVIEW_SESSION = "kimi-review";
const GLM_REVIEW_SESSION = "glm-review";
const REVIEW_PROTOCOL = `你是独立的代码与交付质量审核员。请审核给定任务的目标与产出是否一致。

只输出一个 JSON 对象，格式：
{"ok": true 或 false, "issues": ["问题1", "问题2"], "suggestions": ["建议1"]}

审核要点：
1. 产出是否真正满足任务目标，是否有遗漏或跑题；
2. 代码/文件是否存在明显错误、路径错误、未完成占位；
3. 是否缺少必要的验证（测试、运行结果、边界处理）；
4. 不要吹毛求疵，只报会导致返工的问题；没有问题时 ok=true、issues=[]。

重要：如果证据里出现“审核证据被截断”字样，那是审核通道自身的截断，不代表产出文件不完整；
不要因为该截断判定文件被截断或未完成。`;
/** DeepSeek 同对话自审：不携带文件内容，直接要求它复查刚才的交付。 */
const SELF_REVIEW_PROTOCOL = `[自审] 请审查你刚才给出的交付结果，不要重新实现任务。

只输出一个 JSON 对象：{"ok": true 或 false, "issues": ["问题1"], "suggestions": ["建议1"]}

自审要点：
1. 是否真正满足上一条用户任务的目标，有没有遗漏或跑题；
2. 交付的代码/文件是否完整、可运行，有没有截断、占位、路径错误；
3. 是否做过必要验证（运行结果、语法检查、边界情况）；
4. 没有会导致返工的问题就输出 ok=true、issues=[]。`;
function clamp(text, maxChars) {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…（已截断）`;
}
function buildReviewPrompt(evidence, maxEvidenceChars) {
	const files = evidence.files && evidence.files.length > 0 ? `\n\n涉及文件：\n${evidence.files.map((file) => `- ${file}`).join("\n")}` : "";
	return [
		REVIEW_PROTOCOL,
		`[任务目标]\n${clamp(evidence.task, Math.floor(maxEvidenceChars / 3))}`,
		`[待审核产出]\n${clamp(evidence.artifact, maxEvidenceChars)}${files}`
	].join("\n\n");
}
function parseReviewVerdict(text) {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
	const candidate = fenced ? fenced[1].trim() : trimmed;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start >= 0 && end > start) try {
		const parsed = JSON.parse(candidate.slice(start, end + 1));
		return {
			ok: parsed.ok === true,
			issues: Array.isArray(parsed.issues) ? parsed.issues.filter((v) => typeof v === "string") : [],
			suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((v) => typeof v === "string") : [],
			raw: text
		};
	} catch {}
	return {
		ok: false,
		issues: ["审核回复无法解析为 JSON"],
		suggestions: [],
		raw: text
	};
}
var KimiReviewer = class {
	/** Kimi 审核需要外部证据（任务 + 产出 + 文件内容）。 */
	needsEvidence = true;
	channel;
	config;
	constructor(channel, config) {
		this.channel = channel;
		this.config = config;
	}
	/**
	* 提交一次审核。
	*
	* 两个配置决定行为：
	* - `review.autoSend`：`true`（全自动，默认）自动发送并确认发出；`false`（半自动）
	*   只填入并聚焦窗口，等你点发送。
	* - `review.conversationMode`：`fresh`（默认）每次审核前新开对话，避免历史累积；
	*   `reuse` 复用同一个对话。
	*/
	async review(evidence, _options = {}) {
		await this.channel.ensureReady();
		const fresh = this.config.conversationMode !== "reuse";
		if (fresh) this.channel.resetConversationGate?.(KIMI_REVIEW_SESSION);
		return parseReviewVerdict((await this.channel.turn({
			sessionId: KIMI_REVIEW_SESSION,
			model: "kimi-web",
			text: buildReviewPrompt(evidence, this.config.maxEvidenceChars),
			initialize: fresh,
			autoSend: this.config.autoSend !== false,
			role: "review"
		})).text);
	}
};
var GlmReviewer = class {
	/** GLM 审核需要外部证据（任务 + 产出 + 文件内容）。 */
	needsEvidence = true;
	channel;
	config;
	constructor(channel, config) {
		this.channel = channel;
		this.config = config;
	}
	/** 提交一次审核；自动化程度与对话模式同样由 `review.autoSend` / `review.conversationMode` 决定。 */
	async review(evidence, _options = {}) {
		await this.channel.ensureReady();
		const fresh = this.config.conversationMode !== "reuse";
		if (fresh) this.channel.resetConversationGate?.(GLM_REVIEW_SESSION);
		return parseReviewVerdict((await this.channel.turn({
			sessionId: GLM_REVIEW_SESSION,
			model: "glm-web",
			text: buildReviewPrompt(evidence, this.config.maxEvidenceChars),
			initialize: fresh,
			autoSend: this.config.autoSend !== false,
			role: "review"
		})).text);
	}
};
/**
* DeepSeek 同对话自审：复用正在工作的网页对话，只发一条自审指令。
* 不需要新窗口，也不需要重复粘贴文件内容——上下文里已经有产出。
*/
var DeepSeekSelfReviewer = class {
	/** 自审不需要构造外部证据。 */
	needsEvidence = false;
	channel;
	constructor(channel) {
		this.channel = channel;
	}
	async review(evidence, options = {}) {
		const goal = evidence.task.trim().slice(0, 300);
		const text = goal ? `${SELF_REVIEW_PROTOCOL}\n\n[任务目标（供对照）]\n${goal}` : SELF_REVIEW_PROTOCOL;
		const target = options.conversationSessionId;
		return parseReviewVerdict((await this.channel.turn({
			sessionId: "deepseek-self-review",
			preserveConversation: true,
			...target !== void 0 ? { conversationSessionId: target } : {},
			model: "deepseek-web",
			text,
			initialize: false,
			role: "review"
		})).text);
	}
};

//#endregion
//#region src/doctor.ts
/**
* 汇总选择器命中情况（纯函数，便于离线断言）。
*
* 页面改版时最有用的信息不是「没找到输入框」，而是「5 个候选里 0 个命中」——
* 这说明站点结构整体变了，而不是某一条选择器写错。
*/
function summarizeCandidates(candidates, hits) {
	const hitSet = new Set(hits);
	const hit = candidates.filter((candidate) => hitSet.has(candidate));
	const miss = candidates.filter((candidate) => !hitSet.has(candidate));
	return {
		hit,
		miss,
		detail: hit.length === 0 ? `0/${candidates.length} 命中：${miss.join(" | ")}` : `${hit.length}/${candidates.length} 命中：${hit.join(" | ")}${miss.length > 0 ? `；未命中：${miss.join(" | ")}` : ""}`
	};
}
/** 目录可写性：真写一个临时文件再删掉，比 access(W_OK) 可信（Windows 上后者常年撒谎）。 */
async function probeDirWritable(dir) {
	const file = join(dir, `.dsh-doctor-${process.pid}-${Date.now()}.tmp`);
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(file, "ok", "utf8");
		await unlink(file);
		return {
			ok: true,
			detail: dir
		};
	} catch (error) {
		return {
			ok: false,
			detail: `${dir}：${error instanceof Error ? error.message : String(error)}`
		};
	}
}
/** 读构建加载戳（%LOCALAPPDATA%\DshDeepSeekWeb\loaded-build.json）。 */
async function readLoadStamp() {
	const base = process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
	try {
		const raw = await readFile(join(base, "DshDeepSeekWeb", "loaded-build.json"), "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return void 0;
		const record = parsed;
		return {
			...typeof record.build === "string" ? { build: record.build } : {},
			...typeof record.module === "string" ? { module: record.module } : {},
			...typeof record.pid === "number" ? { pid: record.pid } : {},
			...typeof record.at === "string" ? { at: record.at } : {}
		};
	} catch {
		return;
	}
}
/** CDP 端口是否已经有浏览器在监听（也回答「DSH 是不是正占用着这个浏览器」）。 */
async function probeCdpPort(port, timeoutMs = 1500) {
	try {
		return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
	} catch {
		return false;
	}
}
/** 静态检查：不启动浏览器。 */
async function collectStaticChecks(options) {
	const { config, profileDir, stateFile } = options;
	const checks = [];
	const resolveBrowser = options.resolveBrowser ?? resolveBrowserExecutable;
	const readStamp = options.readStamp ?? readLoadStamp;
	const edge = resolveBrowser("msedge");
	const chrome = resolveBrowser("chrome");
	if (edge !== void 0 || chrome !== void 0) {
		checks.push({
			id: "browser-executable",
			status: "ok",
			message: `找到 ${config.channel === "msedge" ? "Edge" : "Chrome"} 可执行文件`,
			detail: [
				edge !== void 0 ? `msedge: ${edge}` : "msedge: 未找到",
				chrome !== void 0 ? `chrome: ${chrome}` : "chrome: 未找到",
				`当前配置使用 ${config.channel}`
			].join("\n")
		});
		if (config.channel === "msedge" && edge === void 0) checks.push({
			id: "browser-channel-missing",
			status: "error",
			message: `配置指定 msedge，但本机没有找到 Edge`,
			detail: chrome !== void 0 ? `可改用 chrome：${chrome}` : "两种浏览器都没找到，请先安装 Edge 或 Chrome"
		});
		if (config.channel === "chrome" && chrome === void 0) checks.push({
			id: "browser-channel-missing",
			status: "error",
			message: `配置指定 chrome，但本机没有找到 Chrome`,
			detail: edge !== void 0 ? `可改用 msedge：${edge}` : "两种浏览器都没找到，请先安装 Edge 或 Chrome"
		});
	} else checks.push({
		id: "browser-executable",
		status: "error",
		message: "本机没有找到 Edge 或 Chrome",
		detail: "插件需要真实浏览器窗口；请安装其中一个后重试"
	});
	if (config.browser === "attach") checks.push({
		id: "profile",
		status: "ok",
		message: "attach 模式复用外部浏览器 profile，不需要本插件目录",
		detail: `调试端口 ${config.debugPort}`
	});
	else {
		const profile = await probeDirWritable(profileDir);
		checks.push({
			id: "profile",
			status: profile.ok ? "ok" : "error",
			message: profile.ok ? "profile 目录可写" : "profile 目录不可写，登录态会存不下来",
			detail: profile.detail
		});
	}
	const state = await probeDirWritable(dirname(stateFile));
	checks.push({
		id: "state-file",
		status: state.ok ? "ok" : "warning",
		message: state.ok ? "状态文件目录可写" : "状态文件目录不可写，每次重启都会从头回放上下文",
		detail: stateFile
	});
	const stamp = await readStamp();
	if (stamp === void 0) checks.push({
		id: "build",
		status: "warning",
		message: "没有读到构建加载戳（插件可能还没在 DSH 里加载过）",
		detail: `当前代码构建标识：${BUILD}`
	});
	else if (stamp.build === BUILD) checks.push({
		id: "build",
		status: "ok",
		message: "加载戳与当前构建一致",
		detail: `${stamp.build}\n${stamp.module ?? "(无路径)"}\npid ${stamp.pid ?? "?"} @ ${stamp.at ?? "?"}`
	});
	else checks.push({
		id: "build",
		status: BUILD === "dev" ? "warning" : "error",
		message: BUILD === "dev" ? "当前是源码直跑（build=dev），加载戳指向宿主里已装的构建——要验证线上产物请用构建产物运行" : "宿主加载的不是当前这份构建（插件被上游包覆盖，或还没重启）",
		detail: `加载的是 ${stamp.build ?? "(未知)"}，当前代码是 ${BUILD}`
	});
	const ledgerFile = join(baseDirOf(stateFile), "call-ledger.json");
	const ledger = new Ledger({ file: ledgerFile });
	await ledger.load();
	const summary = ledger.summary();
	const intervals = summary.intervals;
	if (summary.totals.total === 0) checks.push({
		id: "ledger",
		status: "warning",
		message: "台账里还没有记录（要么还没真正发过请求，要么刚装不久）",
		detail: `台账文件：${ledgerFile}`
	});
	else {
		const shortest = intervals.minMs;
		const dense = shortest > 0 && shortest < 3e4;
		checks.push({
			id: "ledger",
			status: dense ? "warning" : "ok",
			message: summary.totals.total === 0 ? "台账空闲" : `近 ${summary.days.length} 天 ${summary.totals.total} 次调用（对话 ${summary.totals.chat}、失败 ${summary.totals.failed}）`,
			detail: [
				intervals.count > 0 ? `相邻对话间隔：最短 ${formatMs(intervals.minMs)}、中位 ${formatMs(intervals.medianMs)}、p90 ${formatMs(intervals.p90Ms)}` : "相邻对话间隔：样本不足（少于 2 次成功对话）",
				dense ? "⚠ 出现过 30 秒以内的连环请求，这正是最容易被判机器行为的形态" : "",
				Object.keys(summary.failures).length > 0 ? `失败分布：${Object.entries(summary.failures).map(([kind, count]) => `${kind} ${count}`).join("、")}` : "",
				`台账文件：${ledgerFile}`
			].filter(Boolean).join("\n")
		});
	}
	return checks;
}
/** 状态文件所在目录（台账与它同级，用户只需记一个目录）。 */
function baseDirOf(stateFile) {
	return dirname(stateFile);
}
/** 毫秒转人话（与 notify 的 formatDuration 同口径，但 doctor 不依赖提示模块）。 */
function formatMs(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	if (ms < 1e3) return `${Math.round(ms)}ms`;
	if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
	const minutes = Math.floor(ms / 6e4);
	const seconds = Math.round(ms % 6e4 / 1e3);
	return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}
/**
* 打开（或连上）一个可用的页面。
*
* 优先连已经在跑的 CDP 端口：DSH 正占用插件浏览器时，managed 模式二次启动会
* 因为 user-data-dir 被锁而白等 60 秒。能连上就复用，连不上才自己拉。
*/
async function openLiveContext(options) {
	const { config, profileDir } = options;
	const launch = options.launch ?? launchManagedBrowser;
	const endpoint = `http://127.0.0.1:${config.debugPort}`;
	const origin = new URL(config.url).origin;
	if (await probeCdpPort(config.debugPort)) {
		const context = (await chromium.connectOverCDP(endpoint)).contexts()[0];
		if (!context) throw new Error(`CDP ${config.debugPort} 上没有可用 context`);
		const existing$1 = context.pages().find((page$2) => !page$2.isClosed() && page$2.url().startsWith(origin));
		if (existing$1 !== void 0) return { page: existing$1 };
		const page$1 = await context.newPage();
		return {
			page: page$1,
			ownedPage: page$1
		};
	}
	if (config.browser === "attach" && config.autoStartKeeper !== true) throw new Error(`attach 模式下 CDP ${config.debugPort} 不可达。请先以 --remote-debugging-port=${config.debugPort} 启动浏览器。`);
	const connection = await launch({
		channel: config.channel,
		profileDir,
		preferredPort: config.debugPort,
		url: config.url,
		label: "deepseek-web doctor"
	});
	const existing = connection.context.pages().find((page$1) => !page$1.isClosed() && page$1.url().startsWith(origin));
	if (existing !== void 0) return {
		page: existing,
		ownedBrowser: connection.browser
	};
	const page = await connection.context.newPage();
	await page.goto(config.url, {
		waitUntil: "domcontentloaded",
		timeout: 6e4
	}).catch(() => {});
	return {
		page,
		ownedBrowser: connection.browser,
		ownedPage: page
	};
}
/** 关闭 openLiveContext 创建的资源；复用别人的页面时什么也不做。 */
async function closeLiveContext(live) {
	await live.ownedPage?.close().catch(() => {});
	await live.ownedBrowser?.close().catch(() => {});
}
/** 在线检查：CDP / 登录态 / 选择器命中。 */
async function collectLiveChecks(live, config) {
	const { page } = live;
	const checks = [];
	checks.push({
		id: "cdp",
		status: "ok",
		message: live.ownedBrowser === void 0 ? "复用了已在运行的浏览器" : "已启动并连上浏览器",
		detail: `端口 ${config.debugPort}，页面 ${page.url()}`
	});
	const loggedOut = await looksLoggedOut(page).catch(() => false);
	const loginWall = await looksLoginWall(page).catch(() => false);
	if (loggedOut || loginWall) checks.push({
		id: "login",
		status: "error",
		message: "当前浏览器没有登录 chat.deepseek.com",
		detail: "在打开的窗口里登录一次即可；登录态会保存在 profile 目录"
	});
	else checks.push({
		id: "login",
		status: "ok",
		message: "登录态正常（能看到对话输入区）",
		detail: page.url()
	});
	const editorHits = [];
	for (const candidate of EDITOR_CANDIDATES) if (await page.locator(candidate).first().isVisible().catch(() => false)) editorHits.push(candidate);
	const editor = summarizeCandidates(EDITOR_CANDIDATES, editorHits);
	checks.push({
		id: "editor",
		status: editor.hit.length > 0 ? "ok" : "error",
		message: editor.hit.length > 0 ? "找到聊天输入框" : "没找到聊天输入框（页面可能改版或未登录）",
		detail: editor.detail
	});
	const sendHits = [];
	for (const candidate of SEND_BUTTON_CANDIDATES) if (await page.locator(candidate).count().catch(() => 0) > 0) sendHits.push(candidate);
	const send = summarizeCandidates(SEND_BUTTON_CANDIDATES, sendHits);
	checks.push({
		id: "send-button",
		status: send.hit.length > 0 ? "ok" : "warning",
		message: send.hit.length > 0 ? "找到发送按钮" : "没找到发送按钮（纯回车发送的站点属正常；否则说明页面改版）",
		detail: send.detail
	});
	checks.push({
		id: "pacing",
		status: "ok",
		message: "当前节流参数",
		detail: [
			`发送前随机停顿 ${config.sendPauseMinMs}~${config.sendPauseMaxMs}ms`,
			`连发 ${config.longRunAfterSends} 轮后长休 ${config.longRunPauseMinMs}~${config.longRunPauseMaxMs}ms`,
			`同账号并发上限 ${config.maxConcurrentTurns || "不限"}`,
			`并行会话页上限 ${config.maxSessionPages}`,
			`回放预算 ${config.maxReplayChars} 字`
		].join("\n")
	});
	checks.push({
		id: "account-standing",
		status: "warning",
		message: "本地检查无法证明账号当前没有被限流或临时封禁",
		detail: "如果怀疑被限，请在网页端手动发一条：能正常回答就是没被限。"
	});
	return checks;
}
/** 汇总成报告；`ok` 只看有没有 error（warning 不算失败）。 */
function makeReport(checks, build = BUILD) {
	return {
		ok: !checks.some((check) => check.status === "error"),
		build,
		checks
	};
}
/** 跑完整自检。`live: false` 时只跑静态检查（CI / 离线回归用）。 */
async function runDoctor(options) {
	const checks = await collectStaticChecks({
		config: options.config,
		profileDir: options.profileDir,
		stateFile: options.stateFile,
		...options.resolveBrowser === void 0 ? {} : { resolveBrowser: options.resolveBrowser }
	});
	if (options.live === false) return makeReport(checks);
	let live;
	try {
		live = await openLiveContext({
			config: options.config,
			profileDir: options.profileDir,
			...options.launch === void 0 ? {} : { launch: options.launch }
		});
		checks.push(...await collectLiveChecks(live, options.config));
	} catch (error) {
		checks.push({
			id: "live",
			status: "error",
			message: "在线检查失败：浏览器没连上",
			detail: error instanceof Error ? error.message : String(error)
		});
	} finally {
		if (live !== void 0) await closeLiveContext(live);
	}
	return makeReport(checks);
}

//#endregion
//#region src/ledger-route.ts
/** 台账摘要路由（GET）。 */
const LEDGER_ROUTE = "/api/dsh-deepseek-web/ledger";
/** 安装自检路由（GET；`?live=1` 才跑需要浏览器的在线检查）。 */
const DOCTOR_ROUTE = "/api/dsh-deepseek-web/doctor";
function header(request, name$1) {
	const value = request.headers[name$1];
	return typeof value === "string" ? value : void 0;
}
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return;
	}
}
function isLoopbackAddress(address) {
	const value = String(address ?? "");
	return value === "::1" || value === "::ffff:127.0.0.1" || /^127\./.test(value);
}
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/**
* 同源围栏：判断这个请求是否来自本机同一页面。
*
* 只放行 loopback。非 loopback 的 Host 一律拒绝 —— 本插件没有需要被
* 反向代理暴露的远程用法，宁可少支持一种部署，也不把只读接口开给任意来源。
*/
function isBridgeRequestAllowed(request) {
	const host = header(request, "host");
	if (typeof host !== "string" || host === "") return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (header(request, "sec-fetch-site") === "cross-site") return false;
	const origin = header(request, "origin");
	if (origin !== void 0) try {
		if (new URL(origin).host !== hostUrl.host) return false;
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	return isLoopbackAddress(request.socket?.remoteAddress);
}
function sendJson(res, status, payload) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff"
	});
	res.end(JSON.stringify(payload));
}
function methodNotAllowed(res) {
	res.writeHead(405, { allow: "GET" });
	res.end();
}
/**
* 注册两条只读路由。返回值是处置函数（宿主 unload 时调用）。
*
* `webServer.register` 对重复的 `(kind, path)` 会直接抛错，所以调用方必须
* 保证只注册一次；这里不吞异常，让装配错误在加载期就暴露。
*/
function registerBridgeRoutes(ctx, data) {
	const disposers = [];
	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: LEDGER_ROUTE,
		handler: async (req, res) => {
			if (req.method !== "GET") return methodNotAllowed(res);
			if (!isBridgeRequestAllowed(req)) return sendJson(res, 403, {
				ok: false,
				code: "FORBIDDEN",
				message: "只允许本机同源页面读取。"
			});
			try {
				sendJson(res, 200, {
					ok: true,
					value: {
						summary: await data.readLedger(),
						generatedAt: Date.now(),
						...data.ledgerFile === void 0 ? {} : { file: data.ledgerFile },
						...data.build === void 0 ? {} : { build: data.build }
					}
				});
			} catch (error) {
				sendJson(res, 500, {
					ok: false,
					code: "LEDGER_FAILED",
					message: error instanceof Error ? error.message : String(error)
				});
			}
		}
	}));
	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: DOCTOR_ROUTE,
		handler: async (req, res) => {
			if (req.method !== "GET") return methodNotAllowed(res);
			if (!isBridgeRequestAllowed(req)) return sendJson(res, 403, {
				ok: false,
				code: "FORBIDDEN",
				message: "只允许本机同源页面读取。"
			});
			const live = new URL(`http://localhost${req.url ?? "/"}`).searchParams.get("live") === "1";
			try {
				sendJson(res, 200, {
					ok: true,
					value: {
						report: await data.readDoctor(live),
						generatedAt: Date.now()
					}
				});
			} catch (error) {
				sendJson(res, 500, {
					ok: false,
					code: "DOCTOR_FAILED",
					message: error instanceof Error ? error.message : String(error)
				});
			}
		}
	}));
	return () => {
		for (const dispose of disposers) dispose();
	};
}

//#endregion
//#region src/login-probe.ts
const DEFAULT_TIMERS = {
	schedule: (handler, delayMs) => {
		const timer = setTimeout(handler, delayMs);
		timer.unref?.();
		return timer;
	},
	cancel: (handle) => clearTimeout(handle)
};
/** 默认首次延迟：20 秒。 */
const DEFAULT_PROBE_INITIAL_DELAY_MS = 2e4;
/** 默认探活间隔：30 分钟。 */
const DEFAULT_PROBE_INTERVAL_MS = 30 * 6e4;
/**
* 登录态探活调度器。
*
* `start()` 之后按「首次延迟 → 间隔 → 间隔 → …」串行排期；`stop()` 立即取消
* 未到期的下一次探活，并让正在跑的那次结果不再触发重排。
*/
var LoginProbeScheduler = class {
	target;
	initialDelayMs;
	intervalMs;
	timers;
	now;
	onResult;
	handle;
	stopped = true;
	running = false;
	result;
	constructor(options) {
		this.target = options.target;
		this.initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_PROBE_INITIAL_DELAY_MS);
		this.intervalMs = options.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
		this.timers = options.timers ?? DEFAULT_TIMERS;
		this.now = options.now ?? Date.now;
		this.onResult = options.onResult;
	}
	/** 开始排期；重复调用无副作用。 */
	start() {
		if (!this.stopped) return;
		this.stopped = false;
		this.scheduleNext(this.initialDelayMs);
	}
	/** 停止排期。 */
	stop() {
		this.stopped = true;
		if (this.handle !== void 0) {
			this.timers.cancel(this.handle);
			this.handle = void 0;
		}
	}
	/** 最近一次探活结果（还没探过时为 `undefined`）。 */
	last() {
		return this.result;
	}
	/** 立即探一次（自检/设置页用），不影响既有排期。 */
	async probeNow() {
		return await this.run();
	}
	scheduleNext(delayMs) {
		if (this.stopped) return;
		this.handle = this.timers.schedule(() => {
			this.handle = void 0;
			this.run().then((result) => {
				if (result === void 0) return;
				if (this.intervalMs > 0) this.scheduleNext(this.intervalMs);
				else this.stopped = true;
			});
		}, delayMs);
	}
	async run() {
		if (this.running) return this.result ?? {
			status: "unknown",
			detail: "上一次探活还没结束",
			checkedAt: this.now()
		};
		this.running = true;
		let result;
		try {
			result = await this.target.probeLogin();
		} catch (error) {
			result = {
				status: "unknown",
				detail: `探活失败：${error instanceof Error ? error.message : String(error)}`,
				checkedAt: this.now()
			};
		} finally {
			this.running = false;
		}
		this.result = result;
		this.onResult?.(result);
		return result;
	}
};
/** 把探活结果压成一行提示文案（日志 / 自检 / 面板共用同一口径）。 */
function summarizeLoginProbe(result) {
	if (result === void 0) return "还没探活";
	switch (result.status) {
		case "ok": return "登录态正常";
		case "expired": return `登录态已失效${result.detail === void 0 ? "" : `：${result.detail}`}`;
		default: return `无法判断登录态${result.detail === void 0 ? "" : `：${result.detail}`}`;
	}
}

//#endregion
//#region src/index.ts
const name = "llm-deepseek-web";
const inject = ["llm"];
/** MIME → 扩展名，仅用于给没有原文件名的图片起个可读名字。 */
function extensionForMediaType(mediaType) {
	switch (mediaType) {
		case "image/jpeg": return "jpg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		default: return "png";
	}
}
/**
* 把宿主的 AttachmentStore 绑成适配层要的读图函数。
*
* 不写进 `inject`：老宿主（0.1）没有 attachments 服务，加进必需依赖会让整个插件
* 不加载；改成运行时探测，拿不到就返回 undefined，图片直传自动退回文本标记。
*/
function bindImageReader(ctx) {
	let store;
	try {
		store = ctx.attachments;
	} catch {
		return;
	}
	if (!store || typeof store.readImage !== "function") {
		console.info("[llm-deepseek-web] 宿主未提供附件服务，图片将退回文本标记。");
		return;
	}
	const resolved = store;
	return async (ref) => {
		const stored = await resolved.readImage(ref);
		return {
			name: ref.name ?? `image.${extensionForMediaType(ref.mediaType)}`,
			mimeType: ref.mediaType,
			data: stored.data
		};
	};
}
/**
* 装配免费网页版主通道与可选审核通道。
*
* @param ctx - 插件上下文；`llm` 由 `inject` 保证就绪。
* @param config - Loader 传入的配置；标 `.volatile()` 的字段此时是引用对象。
*/
function apply(ctx, config) {
	const live = liveConfig(config);
	const channel = new PlaywrightBrowserChannel({ config: live });
	const kimiChannel = new KimiBrowserChannel({
		config: live.review,
		focus: live.focus
	});
	const glmChannel = new GLMChannel({
		config: live.review,
		focus: live.focus
	});
	const kimiReviewer = new KimiReviewer(kimiChannel, live.review);
	const glmReviewer = new GlmReviewer(glmChannel, live.review);
	const selfReviewer = new DeepSeekSelfReviewer(channel);
	const adapter = new DeepSeekWebAdapter(live, channel, {
		get needsEvidence() {
			return live.review.provider !== "deepseek-web";
		},
		review: (evidence, options) => {
			switch (live.review.provider) {
				case "kimi": return kimiReviewer.review(evidence, options);
				case "glm": return glmReviewer.review(evidence, options);
				default: return selfReviewer.review(evidence, options);
			}
		}
	}, (totals) => {
		console.info(`[llm-deepseek-web] 通道 token 累计：${totals.totalTokens} tokens / ${totals.usageTurns} 轮`);
	}, bindImageReader(ctx));
	ctx.effect(() => {
		const unregister = ctx.llm.registerAdapter([PROVIDER], adapter);
		return () => {
			unregister();
			channel.dispose().catch(() => {});
			kimiChannel.dispose().catch(() => {});
			glmChannel.dispose().catch(() => {});
		};
	}, "llm-deepseek-web");
	if (live.loginProbe.enabled) {
		const probe = new LoginProbeScheduler({
			target: channel,
			initialDelayMs: live.loginProbe.initialDelayMs,
			intervalMs: live.loginProbe.intervalMs,
			onResult: (result) => {
				if (result.status === "expired") ctx.logger.warn(`[llm-deepseek-web] ${summarizeLoginProbe(result)}；请在网页窗口重新登录。`);
				else ctx.logger.info(`[llm-deepseek-web] ${summarizeLoginProbe(result)}`);
			}
		});
		ctx.effect(() => {
			probe.start();
			return () => probe.stop();
		}, "llm-deepseek-web: login probe");
	}
	ctx.inject(["webServer"], (sub) => {
		const appDataRoot = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
		const stateFile = live.stateFile || path.join(appDataRoot, "DshDeepSeekWeb", "session-state.json");
		const ledgerFile = path.join(path.dirname(stateFile), "call-ledger.json");
		const profileDir = live.profileDir || defaultProfileDir("edge-profile");
		sub.effect(() => registerBridgeRoutes(sub, {
			readLedger: () => adapter.ledgerSummary(),
			readDoctor: (wantLive) => runDoctor({
				config: live,
				profileDir,
				stateFile,
				live: wantLive
			}),
			ledgerFile,
			build: BUILD
		}), "llm-deepseek-web: readonly bridge");
	});
	ctx.logger.info(`[llm-deepseek-web] provider "${PROVIDER}" registered (browser=${live.browser}, sendMode=${live.sendMode}, review=${live.review.enabled ? live.review.provider : "off"}, imageUpload=${live.enableImageUpload ? "on" : "off"})`);
	const stamp = writeLoadStamp();
	ctx.logger.info(`[llm-deepseek-web] 构建标识 ${BUILD}（加载文件：${stamp ?? "加载戳写入失败"}）`);
}

//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=index.js.map