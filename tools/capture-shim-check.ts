/**
 * 校验「页面网络镜像」注入的 `__name` 垫片存在（离线可复现）。
 *
 * 背景：打包器（rolldown/tsdown，`keepNames` 默认开启）会把闭包里出现的
 * 函数表达式改写成 `__name(fn, "…")`。`ensureCapture` 的闭包是用
 * `page.evaluate()` 序列化后送进页面执行的——页面上下文里没有 `__name`，
 * 整段注入会抛 `ReferenceError: __name is not defined`，实时思考流随之失效
 * （真机复现过：最终回复正常，但 reasoning 全程空白）。
 *
 * 回归口径：
 * 1. 源码：`ensureCapture` 里镜像闭包之前必须有字符串形式的垫片，
 *    且字符串形式不会被序列化改写（用双引号单行表达式，不写成箭头函数）；
 * 2. 产物：`lib/index.js` 里必须保留同一段垫片字符串。
 *
 * 只做静态断言：真机行为已由 `tools/manual/probe-send.ts` 覆盖。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

let failures = 0

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`ok: ${name}`)
    return
  }
  failures += 1
  console.error(`FAIL: ${name}${detail === undefined ? '' : `\n  ${detail}`}`)
}

/** 垫片在源码与产物里都应逐字出现；改动它等于同时改这里的断言。 */
const SHIM = 'window.__name = window.__name || ((fn) => fn)'

const source = readFileSync(join(repo, 'src', 'playwright-channel.ts'), 'utf8')
const shimAt = source.indexOf(SHIM)
check('源码：ensureCapture 带 __name 垫片', shimAt >= 0, `未找到：${SHIM}`)

if (shimAt >= 0) {
  const captureAt = source.indexOf('private async ensureCapture(')
  const mirrorAt = source.indexOf('await page.evaluate(() => {', captureAt)
  check('源码：垫片在镜像闭包之前执行', captureAt >= 0 && mirrorAt > shimAt, `captureAt=${captureAt} mirrorAt=${mirrorAt} shimAt=${shimAt}`)
  check(
    '源码：垫片用字符串形式（不经序列化改写）',
    /page\.evaluate\(\s*'window\.__name/.test(source.slice(shimAt - 60, shimAt + SHIM.length + 10)),
    '垫片必须作为字符串传给 page.evaluate，写成箭头函数会被 keepNames 二次包装',
  )
}

let bundle = ''
try {
  bundle = readFileSync(join(repo, 'lib', 'index.js'), 'utf8')
} catch {
  // 未构建时跳过产物断言：`npm run test:parsers` 之前不强制 build。
  console.log('skip: 未找到 lib/index.js，跳过产物断言（先 npm run build）')
}

if (bundle !== '') {
  check('产物：lib/index.js 保留 __name 垫片', bundle.includes(SHIM), `未找到：${SHIM}`)
}

if (failures > 0) {
  console.error(`FAILED: ${failures} 项`)
  process.exit(1)
}
console.log('OK（__name 垫片：源码顺序 + 字符串形式 + 产物保留）')
