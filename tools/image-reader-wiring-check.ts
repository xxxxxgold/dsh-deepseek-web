/**
 * 离线回归：图片直传的读图能力必须"与附件服务的加载顺序无关"。
 *
 * 真实事故：插件在 `apply()` 里直接读 `ctx.attachments`，而 cordis 4 对**未注入**服务的
 * 属性访问会抛错；旧代码把异常吞成 undefined，于是读图函数永远是 undefined，
 * `renderNewWebMessages` 一张图都不收集、界面也毫无提示。用户看到的是「多轮之后贴图
 * 没上传到网页版」，而本机 40+ 会话里从未记录过任何一次图片上传。
 *
 * 本检查打在插件入口这个外部接缝上（真调 `apply()`，服务在后才挂载），而不是照抄
 * `ctx.inject` 的写法自证；任何把读图绑回"启动期一次性快照"的改动都会让它变红。
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply, bindImageReader, Config } from '../src/index.ts'

/** 假冒宿主附件服务：只实现插件用到的 readImage。 */
class FakeAttachmentStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  async readImage(ref: { attachmentId: string }): Promise<{ data: Uint8Array }> {
    return { data: new TextEncoder().encode(`bytes:${ref.attachmentId}`) }
  }
}

/** 假冒宿主 llm 服务：只为捕获插件注册的适配器（按 provider 分开，插件已不止一个 provider）。 */
class FakeLlm extends Service {
  readonly captured = new Map<string, { imageUploadReady?: boolean }>()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  registerAdapter(providers: readonly string[], adapter: unknown): () => void {
    for (const provider of providers) this.captured.set(provider, adapter as { imageUploadReady?: boolean })
    return () => {
      for (const provider of providers) this.captured.delete(provider)
    }
  }
}

const tick = (ms = 150): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// 1. 最坏顺序：先加载插件（此时宿主还没有附件服务），服务随后才挂载。
{
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  await tick(20)
  const llm = ctx.get('llm') as FakeLlm

  apply(ctx, Config({
    stateFile: path.join(tmpdir(), 'dsh-image-wiring-check', 'session-state.json'),
    focus: { enabled: false },
    loginProbe: { enabled: false },
  }) as never)
  await tick(30)

  const deepseek = llm.captured.get('deepseek-web')
  assert.ok(deepseek, '插件必须向宿主注册 DeepSeek 适配器')
  assert.equal(deepseek!.imageUploadReady, false, '附件服务挂载前不得假装能读图（只能降级）')

  ctx.plugin(FakeAttachmentStore)
  await tick()

  assert.equal(
    deepseek!.imageUploadReady,
    true,
    '附件服务就绪后适配器必须拿到读图能力——无论它与插件谁先加载（旧实现就是在这里永久降级的）',
  )
}

// 2. 读图函数本身：字节、MIME、文件名都要原样交给通道。
{
  const ctx = new Context()
  let reader: ReturnType<typeof bindImageReader>
  ctx.inject(['attachments'], (sub) => {
    reader = bindImageReader(sub)
  })
  ctx.plugin(FakeAttachmentStore)
  await tick()

  assert.equal(typeof reader!, 'function', 'inject 回调里必须能绑出读图函数')
  const read = await reader!({ attachmentId: 'sha256:demo', mediaType: 'image/jpeg' } as never)
  assert.deepEqual(
    Array.from(read!.data),
    Array.from(new TextEncoder().encode('bytes:sha256:demo')),
    '读图函数必须原样交出宿主给的字节',
  )
  assert.equal(read!.mimeType, 'image/jpeg', 'MIME 必须原样透传')
  assert.equal(read!.name, 'image.jpg', '没有原始文件名时应按 MIME 兜出一个可读名字')
}

// 3. 老宿主没有附件服务：安静降级，绝不抛错（插件其余部分照常工作）。
{
  const ctx = new Context()
  assert.equal(bindImageReader(ctx), undefined, '没有附件服务时应降级为 undefined 而不是抛错')
}

// 4. 根因留档：未注入的属性访问会抛错——所以探测必须发生在 inject 回调里。
{
  const ctx = new Context()
  ctx.plugin(FakeAttachmentStore)
  await tick()
  let thrown: string | undefined
  ctx.plugin({
    name: 'check-uninjected-access',
    apply(sub) {
      try {
        void (sub as unknown as { attachments?: unknown }).attachments
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error)
      }
    },
  })
  await tick()
  assert.match(
    thrown ?? '',
    /without inject/,
    '未注入时属性访问必须抛错（旧实现正是把它吞成 undefined，导致图片直传永久降级）',
  )
}

console.log('OK: 读图能力与附件服务加载顺序无关，字节/MIME/文件名透传正常，老宿主安全降级')
