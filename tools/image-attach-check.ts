/**
 * 附件上传链路的离线行为测试（不需要真实浏览器）。
 *
 * 真机验证证明"图片确实到了网页版"，这里补的是分支覆盖：纯文本轮不传图、
 * 同名预览幂等跳过、找不到文件输入框时不炸、超过内联上限改走 CDP。
 */
import assert from 'node:assert/strict'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { PlaywrightBrowserChannel } from '../src/playwright-channel.ts'
import type { BrowserTurnRequest } from '../src/browser-channel.ts'

const PREVIEW = '.ds-animated-size-item'

interface FakeOptions {
  /** input[type=file] 是否存在 */
  hasFileInput?: boolean
  /** 输入框里已有的附件预览文件名（img alt） */
  previewNames?: string[]
  /** 预览块总数（决定 waitForFunction 是否看到新增） */
  previewCount?: number
}

/** 只实现 attachAttachments / clearAttachments 用到的调用面。 */
function fakePage(options: FakeOptions = {}) {
  const { hasFileInput = true, previewNames = [], previewCount = 0 } = options
  const calls = { setInputFiles: [] as unknown[][], cdp: 0, clicked: 0 }

  const locator = (selector: string) => {
    const base = {
      first: () => base,
      count: async () => {
        if (selector === 'input[type="file"]') return hasFileInput ? 1 : 0
        if (selector === PREVIEW) return previewCount
        if (selector === `${PREVIEW} div:has(> .ds-icon)`) return 0 // 没有残留可删
        return 0
      },
      click: async () => { calls.clicked += 1 },
      evaluateAll: async () => previewNames,
      setInputFiles: async (files: unknown[]) => { calls.setInputFiles.push(files) },
      fill: async () => {},
    }
    return base
  }

  const page = {
    locator,
    waitForResponse: async () => ({ status: () => 200 }),
    waitForFunction: async () => true,
    evaluate: async () => undefined,
    context: () => ({
      newCDPSession: async () => {
        calls.cdp += 1
        return {
          send: async (method: string) => {
            if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
            if (method === 'DOM.querySelector') return { nodeId: 7 }
            return {}
          },
          detach: async () => {},
        }
      },
    }),
  }
  return { page: page as never, calls }
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  const config = liveConfig(Config({
    enableImageUpload: true,
    uploadTimeoutMs: 2_000,
    uploadOnError: 'fallback-text',
    ...overrides,
  } as never))
  const channel = new PlaywrightBrowserChannel({ config })
  const attach = (channel as unknown as {
    attachAttachments(page: never, request: BrowserTurnRequest): Promise<void>
  }).attachAttachments.bind(channel)
  return { attach, config }
}

const image = (name: string, bytes: number) => ({
  name,
  mimeType: 'image/png' as const,
  data: new Uint8Array(bytes),
})

const request = (attachments?: BrowserTurnRequest['attachments']): BrowserTurnRequest => ({
  sessionId: 'offline',
  model: 'deepseek-web-auto',
  text: 'hello',
  initialize: false,
  autoSend: true,
  attachments,
})

let passed = 0
function ok(name: string) {
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 1. 纯文本轮：不碰文件输入框
{
  const { attach } = makeChannel()
  const { page, calls } = fakePage()
  await attach(page, request(undefined))
  assert.equal(calls.setInputFiles.length, 0, '纯文本轮不该调用 setInputFiles')
  ok('无附件时零上传开销')
}

// 2. 正常一张图：走 setInputFiles，参数原样传下去
{
  const { attach } = makeChannel()
  const { page, calls } = fakePage({ previewCount: 0 })
  await attach(page, request([image('shot.png', 1024)]))
  assert.equal(calls.setInputFiles.length, 1, '应该调用一次 setInputFiles')
  const file = (calls.setInputFiles[0] as Array<{ name: string; mimeType: string }>)[0]
  assert.equal(file.name, 'shot.png')
  assert.equal(file.mimeType, 'image/png')
  ok('单张图片按文件对象传给网页输入框')
}

// 3. 幂等：同名预览已经在输入框里，不重复上传（频控重发会走到这里）
{
  const { attach } = makeChannel()
  const { page, calls } = fakePage({ previewNames: ['shot.png'] })
  await attach(page, request([image('shot.png', 1024)]))
  assert.equal(calls.setInputFiles.length, 0, '同名预览已存在时不该重复上传')
  ok('同一张图重复触发只上传一次')
}

// 4. 页面上没有文件输入框：fallback-text 模式下不抛错（降级为文字标记）
{
  const { attach } = makeChannel({ uploadOnError: 'fallback-text' })
  const { page } = fakePage({ hasFileInput: false })
  await attach(page, request([image('shot.png', 1024)]))
  ok('找不到文件输入框时降级不抛错')
}

// 5. 同样场景，abort 模式必须抛错（让上层知道图没上去）
{
  const { attach } = makeChannel({ uploadOnError: 'abort' })
  const { page } = fakePage({ hasFileInput: false })
  await assert.rejects(
    () => attach(page, request([image('shot.png', 1024)])),
    (error: Error & { code?: string }) => error.code === 'WEB_IMAGE_UPLOAD_FAILED',
    'abort 模式应抛 WEB_IMAGE_UPLOAD_FAILED',
  )
  ok('上传失败时 abort 模式明确报错')
}

// 6. 超过内联上限：改走 CDP，不调用 setInputFiles
{
  const { attach } = makeChannel()
  const { page, calls } = fakePage()
  await attach(page, request([image('huge.png', 46 * 1024 * 1024)]))
  assert.equal(calls.cdp, 1, '超过 45MB 应该走 CDP 上传')
  assert.equal(calls.setInputFiles.length, 0, '走 CDP 时不该再调 setInputFiles')
  ok('超过内联上限改走 CDP 通道')
}

console.log(`\n图片上传链路离线测试：${passed} 项通过`)
