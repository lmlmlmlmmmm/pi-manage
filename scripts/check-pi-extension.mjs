// 使用本机已有的 pi 加载器验证扩展契约；只发现当前包，不启动会话或读取真实配置。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const piRoot = process.argv[2]
if (!piRoot) throw new Error('用法：node scripts/check-pi-extension.mjs <pi-coding-agent 安装目录>')
const dir = fs.mkdtempSync(join(tmpdir(), 'pi-manage-pi-loader-'))
const previous = process.env.PI_CODING_AGENT_DIR
process.env.PI_CODING_AGENT_DIR = dir
try {
  const { discoverAndLoadExtensions } = await import(pathToFileURL(resolve(piRoot, 'dist/core/extensions/loader.js')).href)
  const result = await discoverAndLoadExtensions([resolve('.')], dir, dir)
  assert.deepEqual(result.errors, [])
  assert.equal(result.extensions.length, 1)
  const extension = result.extensions[0]
  assert.equal(typeof extension.commands.get('pi-manage')?.handler, 'function')
  assert.equal(extension.handlers.get('session_shutdown')?.length, 1)
  const notices = []
  await extension.commands.get('pi-manage').handler('status', { hasUI: true, ui: { notify: (text) => notices.push(text) } })
  assert.match(notices[0], /尚未启动/)
  assert.equal(fs.existsSync(join(dir, 'settings.json')), false)
  console.log('pi 官方加载器已识别包清单、/pi-manage 命令和 session_shutdown 清理事件；发现阶段未启动后台。')
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previous
  const rel = relative(tmpdir(), dir)
  assert.ok(rel.startsWith('pi-manage-pi-loader-') && !isAbsolute(rel) && !rel.includes('..'))
  fs.rmSync(dir, { recursive: true, force: true })
}
