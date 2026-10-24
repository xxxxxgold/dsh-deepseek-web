/**
 * 逐条执行 `test:parsers` 里的每个自检脚本，记录各自的退出码与耗时。
 *
 * 用途：`npm run test:parsers` 用 `&&` 串联，任一失败即中断，但"全部成功"
 * 这件事在长链上不容易一眼看清——本脚本把它拆开跑，给每个脚本一行结论，
 * 失败时附最后几行输出。只读，不修改任何源码或产物。
 *
 * 用法：node tools/run-each-check.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const chain = pkg.scripts['test:parsers']
const cmds = chain.split(' && ').map(s => s.trim()).filter(Boolean)

// npm run 会把 node_modules/.bin 注入 PATH；直接 spawn 时得自己补上，
// 否则 Windows 上找不到 `tsx`/`tsdown` 这类本地可执行文件。
const binDir = path.join(root, 'node_modules', '.bin')
const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` }

let pass = 0
let fail = 0
const started = Date.now()

for (const cmd of cmds) {
  const t0 = Date.now()
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', timeout: 180_000, env })
  const ms = Date.now() - t0
  if (r.status === 0) {
    pass += 1
    console.log(`PASS  ${ms.toString().padStart(5)}ms  ${cmd}`)
  } else {
    fail += 1
    console.log(`FAIL(${r.status})  ${ms.toString().padStart(5)}ms  ${cmd}`)
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n')
    if (tail) console.log(tail.replace(/^/gm, '    '))
  }
}

const total = cmds.length
console.log(`\n合计 ${total} 个脚本：通过 ${pass}，失败 ${fail}，总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
process.exit(fail === 0 ? 0 : 1)
