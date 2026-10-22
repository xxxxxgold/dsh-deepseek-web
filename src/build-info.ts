/**
 * 构建身份（build stamp）：让「宿主这次到底加载了哪一份 lib/index.js」变成可验证的事实，
 * 而不是靠「我重启过了」这种无法证伪的说法。
 *
 * 背景：插件装进 dsh profile 后，`dsh plugin` 的任何一次安装/更新都会按 profile 里声明的
 * `github:...` 重新拉取上游 tarball，把本地构建的 lib/index.js 覆盖回旧版本。那种情况下
 * 重启也不解决问题，而现象与「代码没修好」一模一样，极难区分。这里做两件事：
 *
 * 1. `BUILD` —— 编译期注入的版本+时间戳，插件注册时写进日志，肉眼即可比对。
 * 2. `writeLoadStamp()` —— 启动时把「构建标识 + 实际加载的文件绝对路径 + pid」落到一个
 *    固定的小文件里。宿主重启后读该文件，就能确定加载的是哪一份字节、来自哪个路径。
 *
 * 两者都只是诊断，失败一律吞掉：绝不因为写不了文件而影响插件加载。
 *
 * @module dsh-deepseek-web/build-info
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 编译期由 tsdown 的 `define` 注入；源码直跑（tsx）时不存在，回退成 dev。 */
declare const __DSH_DEEPSEEK_WEB_BUILD__: string | undefined

export const BUILD: string =
  typeof __DSH_DEEPSEEK_WEB_BUILD__ === 'string' ? __DSH_DEEPSEEK_WEB_BUILD__ : 'dev'

/** 本模块自身在磁盘上的绝对路径 —— 也就是宿主真正加载的那份产物。 */
const modulePath = fileURLToPath(import.meta.url)

/** 加载戳文件路径：%LOCALAPPDATA%\DshDeepSeekWeb\loaded-build.json（拿不到就用家目录）。 */
function stampPath(): string {
  const base = process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local')
  return join(base, 'DshDeepSeekWeb', 'loaded-build.json')
}

/**
 * 记录「本次加载」的构建身份，供重启后核对。
 *
 * @returns 写入的绝对路径；失败时返回 undefined（调用方不需要关心错误）。
 */
export function writeLoadStamp(): string | undefined {
  const file = stampPath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      `${JSON.stringify({ build: BUILD, module: modulePath, pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    )
    return file
  } catch {
    return undefined
  }
}
