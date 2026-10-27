/**
 * managed 浏览器复用回归（离线，不需要真实浏览器）。
 *
 * 背景：宿主的生命周期比浏览器短——`dsh headless` 退出或桌面版重启后，插件托管的
 * Edge/Chrome 仍在运行。旧实现会另选端口再 spawn 一个 Edge，被 Chromium 单实例
 * 接管，新端口永远等不到 CDP，60 秒后报 BROWSER_MANAGED_START_FAILED。
 *
 * 这里钉住四件事：
 * 1. 端点文件按 profile 路径隔离，同一路径大小写不同仍指向同一文件；
 * 2. 读写往返、坏 JSON、越界端口都要安全降级为「无端点」；
 * 3. clear 之后读不到；
 * 4. 端点指向死端口时，reuseManagedBrowser 必须快速返回 undefined 并清掉脏文件，
 *    不能把 60 秒超时带回来。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  clearManagedEndpoint,
  managedEndpointFile,
  readManagedEndpoint,
  reuseManagedBrowser,
  writeManagedEndpoint,
} from '../src/browser-shared.ts'

const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-managed-reuse-'))
const profileA = path.join(dir, 'edge-profile')
const profileB = path.join(dir, 'other-profile')

try {
  // 1. 路径隔离 + 大小写归一
  assert.notEqual(managedEndpointFile(profileA), managedEndpointFile(profileB))
  assert.equal(path.basename(managedEndpointFile(profileA)), path.basename(managedEndpointFile(profileA.toUpperCase())))

  // 2. 读写往返
  writeManagedEndpoint(profileA, { port: 9333, pid: 1234, at: '2026-10-26T00:00:00.000Z' })
  assert.deepEqual(readManagedEndpoint(profileA), { port: 9333, pid: 1234, at: '2026-10-26T00:00:00.000Z' })
  assert.equal(readManagedEndpoint(profileB), undefined)

  // 2b. 坏 JSON / 越界端口
  await writeFile(managedEndpointFile(profileA), '{not json', 'utf8')
  assert.equal(readManagedEndpoint(profileA), undefined)
  await writeFile(managedEndpointFile(profileA), JSON.stringify({ port: 80 }), 'utf8')
  assert.equal(readManagedEndpoint(profileA), undefined)

  // 3. clear
  writeManagedEndpoint(profileA, { port: 9444, at: '2026-10-26T00:00:00.000Z' })
  clearManagedEndpoint(profileA)
  assert.equal(readManagedEndpoint(profileA), undefined)

  // 4. 死端口：快速失败 + 清脏文件
  writeManagedEndpoint(profileA, { port: 1, at: '2026-10-26T00:00:00.000Z' })
  const t0 = Date.now()
  const reused = await reuseManagedBrowser({ profileDir: profileA, url: 'https://chat.deepseek.com', label: 'deepseek-web' })
  const elapsed = Date.now() - t0
  assert.equal(reused, undefined)
  assert.ok(elapsed < 3_500, `死端口不应拖满 60 秒，实际 ${elapsed}ms`)
  assert.equal(readManagedEndpoint(profileA), undefined, '脏文件应被清掉')

  // 4b. 没有端点时直接返回，不做无谓连接
  const t1 = Date.now()
  assert.equal(await reuseManagedBrowser({ profileDir: profileB, url: 'https://chat.deepseek.com', label: 'deepseek-web' }), undefined)
  assert.ok(Date.now() - t1 < 500)

  console.log('PASS managed 浏览器端点读写、隔离、降级与快速失败')
} finally {
  await rm(dir, { recursive: true, force: true })
}
