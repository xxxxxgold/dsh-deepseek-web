/**
 * 把本地构建装进 DSH 桌面版真正加载的插件目录。
 *
 * 为什么需要这个脚本
 * ------------------
 * 桌面 DSH 加载的是
 *   ~/.dsh/profiles/<profile>/node_modules/dsh-deepseek-web-littlecar30/lib/index.js
 * 这份「已安装副本」与开发目录（本仓库 lib/）是两个独立文件，互不关联。只在仓库里
 * `npm run build` 再重启 dsh，加载的仍然是旧副本——这就是「明明改了代码、重启了、
 * 线上还是老行为」的第一重根因。
 *
 * 第二重根因（本脚本要堵死的）：profile 里的依赖原来声明成
 *   "dsh-deepseek-web-littlecar30": "github:xxxxxgold/dsh-deepseek-web"
 * 插件管理器任何一次 pnpm 安装/更新都会按这个声明从 GitHub 重新拉上游 tarball，
 * 把本地构建整个覆盖回旧版本。于是「修好了 → 某次装插件 → 又坏了」，表现和
 * 「根本没修」一模一样。
 *
 * 做法：把仓库打成 tgz 放进 `~/.dsh/profiles/_local-pkgs/`，把 profile 的依赖声明
 * 改成指向这个 tgz，再让 pnpm 以实体目录装进 node_modules。此后任何一次 pnpm install
 * 都只会从这个 tgz 复原同一份字节，不会再退回 GitHub 上的旧版本。
 *
 * 为什么不用 link:/junction
 * -------------------------
 * link 会让包的真实路径落在仓库内，Node 解析 `@deepseek-ai/*` 时会命中仓库
 * node_modules 里的旧副本，与宿主自带的那份不是同一个模块实例（跨副本 instanceof /
 * 类继承会失败）。tgz 安装产出的是 profile 内的实体目录，依赖解析形状与改造前
 * 一直正常工作的安装完全一致。
 *
 * 用法
 * ----
 *   node tools/deploy-local-profile.mjs                      # 部署到所有已装该包的 profile
 *   node tools/deploy-local-profile.mjs --dry-run            # 只看会做什么
 *   node tools/deploy-local-profile.mjs --profile desktop    # 只部署一个 profile
 *   node tools/deploy-local-profile.mjs --profiles-root DIR  # 指定别的 profile 根目录
 *
 * 依赖：node（自带）+ pnpm（优先用 DSH 自带的，其次用 PATH 上的）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-deepseek-web-littlecar30'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const sourceLib = join(repoRoot, 'lib', 'index.js')

if (!existsSync(sourceLib)) {
  console.error(`[deploy] 先构建：${sourceLib} 不存在，请跑 npm run build`)
  process.exit(1)
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const sourceHash = sha256(sourceLib)
const sourceBytes = statSync(sourceLib).size

/**
 * tgz 文件名里带产物哈希前缀。
 *
 * pnpm 对同一个 `file:` 路径会按内容寻址缓存：如果文件名不变，改了代码重装也可能
 * 直接复用 store 里的旧解包结果。把哈希写进文件名，内容一变路径就变，pnpm 必然
 * 重新解包，避免「改了、装了、还是旧代码」这种最难查的假修复。
 */
const TGZ_NAME = `${PACKAGE}-${pkg.version}-${sourceHash.slice(0, 12)}.tgz`


/** DSH 自带的 pnpm（存在就用它，保证与宿主的 pnpm 版本、store 一致）。 */
function resolvePnpm() {
  const candidates = [
    'D:/Program Files/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs',
    join(
      process.env['ProgramFiles'] ?? 'C:/Program Files',
      'DeepSeek Harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs',
    ),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { kind: 'node', path: candidate }
  }
  return { kind: 'bin', path: 'pnpm' }
}

function parseArgs(argv) {
  const args = { dryRun: false, profile: undefined, profilesRoot: undefined, skipInstall: false }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--dry-run') args.dryRun = true
    else if (token === '--skip-install') args.skipInstall = true
    else if (token === '--profile') args.profile = argv[++i]
    else if (token === '--profiles-root') args.profilesRoot = argv[++i]
  }
  return args
}

function fail(message) {
  console.error(`[deploy] ${message}`)
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))
const profilesRoot = args.profilesRoot ?? join(homedir(), '.dsh', 'profiles')

if (!existsSync(profilesRoot)) fail(`profile 根目录不存在：${profilesRoot}`)

const profiles = readdirSync(profilesRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
  .map(entry => entry.name)
  .filter(name => (args.profile ? name === args.profile : true))
  .sort()

// ── 1. 打包（只打一次，所有 profile 共用同一份 tgz）─────────────────────────
const stashDir = join(profilesRoot, '_local-pkgs')
const stashTgz = join(stashDir, TGZ_NAME)

if (args.dryRun) {
  console.info(`[deploy] [dry-run] 会执行 npm-pack 生成 ${TGZ_NAME}（源 ${sourceBytes} 字节，sha256 ${sourceHash.slice(0, 16)}…）`)
} else {
  mkdirSync(stashDir, { recursive: true })
  const tmpDir = join(stashDir, '.pack-tmp')
  mkdirSync(tmpDir, { recursive: true })
  console.info('[deploy] 打包…')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  execFileSync('npm', ['pack', '--pack-destination', tmpDir, '--silent'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  })
  // npm pack 只会输出 <name>-<version>.tgz（忽略我们想要的哈希后缀），
  // 所以打包完成后取那个文件、按产物哈希改名，再作为本次部署的 tgz。
  const packedTgz = readdirSync(tmpDir).filter(name => name.endsWith('.tgz'))
  if (packedTgz.length !== 1) fail(`打包产物异常：${tmpDir} 下找到 ${packedTgz.length} 个 tgz（${packedTgz.join('、') || '无'}）`)
  copyFileSync(join(tmpDir, packedTgz[0]), stashTgz)
  rmSync(tmpDir, { recursive: true, force: true })
  console.info(`[deploy] tgz 就位：${stashTgz}（${statSync(stashTgz).size} 字节）`)
}

// ── 2. 逐 profile 改依赖声明并安装 ────────────────────────────────────────
const spec = `file:../_local-pkgs/${TGZ_NAME}`
const pnpm = resolvePnpm()
let deployed = 0
let skipped = 0

for (const profile of profiles) {
  const profileDir = join(profilesRoot, profile)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    skipped++
    continue
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const deps = manifest.dependencies ?? {}
  const installedDir = join(profileDir, 'node_modules', PACKAGE)
  const alreadyDeclared = deps[PACKAGE] !== undefined
  if (!alreadyDeclared && !existsSync(installedDir)) {
    skipped++
    continue
  }

  console.info(`[deploy] profile=${profile}`)
  if (deps[PACKAGE] !== spec) {
    if (args.dryRun) {
      console.info(`[deploy]   [dry-run] 依赖声明 ${deps[PACKAGE] ?? '(无)'} -> ${spec}`)
    } else {
      const backup = `${manifestPath}.bak-${new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)}`
      copyFileSync(manifestPath, backup)
      manifest.dependencies = { ...deps, [PACKAGE]: spec }
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      console.info(`[deploy]   依赖声明 -> ${spec}（备份 ${backup}）`)
    }
  } else {
    console.info('[deploy]   依赖声明已是本地 tgz')
  }

  if (args.skipInstall) {
    console.info('[deploy]   --skip-install：跳过安装')
    continue
  }
  if (args.dryRun) {
    console.info('[deploy]   [dry-run] 会在该 profile 跑 pnpm install')
    continue
  }
  console.info('[deploy]   pnpm install…')
  const command = pnpm.kind === 'node'
    ? [process.execPath, [pnpm.path, 'install', '--config.confirmModulesPurge=false']]
    : [pnpm.path, ['install', '--config.confirmModulesPurge=false']]
  try {
    execFileSync(command[0], command[1], { cwd: profileDir, stdio: 'inherit' })
  } catch {
    fail(`profile=${profile} pnpm install 失败；profile 目录未被破坏，可重跑本脚本`)
  }

  // ── 3. 校验装进去的字节就是刚构建的那份 ────────────────────────────────
  const target = join(installedDir, 'lib', 'index.js')
  if (!existsSync(target)) fail(`profile=${profile} 安装后找不到 ${target}`)
  const targetHash = sha256(target)
  if (targetHash !== sourceHash) {
    fail(`profile=${profile} 校验失败：装进去的 index.js 与仓库产物不一致（${targetHash.slice(0, 16)} vs ${sourceHash.slice(0, 16)}）`)
  }
  const text = readFileSync(target, 'utf8')
  const build = /const BUILD = "([^"]+)"/u.exec(text)?.[1] ?? '(无构建标识)'
  console.info(`[deploy]   ✓ ${statSync(target).size} 字节，sha256 ${targetHash.slice(0, 16)}…，构建标识 ${build}`)
  deployed++
}

console.info(`[deploy] 完成：部署 ${deployed} 个 profile，跳过 ${skipped} 个未装该包的 profile`)
if (!args.dryRun && deployed > 0) {
  console.info('[deploy] 生效方式：重启 DSH 桌面版；重启后读 %LOCALAPPDATA%\\DshDeepSeekWeb\\loaded-build.json 可核对真正加载的构建标识')
}
