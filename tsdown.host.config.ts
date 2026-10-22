/**
 * Host bundle for the dsh-deepseek-web plugin: compiles src/index.ts into a
 * plain Node ESM file (lib/index.js) so an installed package needs no TS
 * runtime. Mirrors the workspace host build contract (tsdown, ESM, node,
 * es2024); everything the running dsh host provides (@deepseek-ai/*, which
 * must resolve to the host's own module instances) plus playwright-core
 * (declared as a real dependency) stays external.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const EXTERNAL = (specifier: string): boolean =>
  specifier.startsWith('@deepseek-ai/') || specifier === 'playwright-core'

/**
 * 构建标识：`<版本>+<构建时间>`。编译期写死进产物，插件注册时打进日志，
 * 用来回答「宿主这次加载的到底是哪一份 lib/index.js」——排查部署断层时
 * 不必再靠进程启动时间猜。源码直跑（tsx）时没有这个常量，走 'dev' 分支。
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string }
const buildId = `${pkg.version ?? '0.0.0'}+${new Date().toISOString().replace(/[-:]/gu, '').replace(/\..*$/u, '')}`

export default {
  name: 'dsh-deepseek-web/host',
  entry: { index: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
  outDir: fileURLToPath(new URL('./lib/', import.meta.url)),
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    __DSH_DEEPSEEK_WEB_BUILD__: JSON.stringify(buildId),
  },
  deps: {
    neverBundle: EXTERNAL,
    alwaysBundle: (specifier: string): boolean => !EXTERNAL(specifier),
  },
  outputOptions: {
    entryFileNames: 'index.js',
  },
}
