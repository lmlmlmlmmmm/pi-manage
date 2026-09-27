import assert from 'node:assert/strict'
import fs from 'node:fs'
import { once } from 'node:events'
import { fork, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, beforeEach, test } from 'node:test'
import ts from 'typescript'

const repository = resolve('.')
const envNames = ['PI_CODING_AGENT_DIR', 'PI_MANAGE_PROXY', 'PI_MANAGE_PROXY_USERNAME', 'PI_MANAGE_PROXY_PASSWORD']
const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
let fixtureDir, packageDir, extension
let agentNumber = 0

before(async () => {
  fixtureDir = fs.mkdtempSync(join(tmpdir(), 'pi-manage-extension-test-'))
  packageDir = join(fixtureDir, 'package with spaces')
  fs.mkdirSync(join(packageDir, 'dist'), { recursive: true })
  fs.mkdirSync(join(packageDir, 'extensions'))
  fs.writeFileSync(join(packageDir, 'dist/index.html'), '<html>isolated pi-manage fixture</html>')
  fs.copyFileSync('package.json', join(packageDir, 'package.json'))
  fs.copyFileSync('extensions/pi-manage.js', join(packageDir, 'extensions/pi-manage.js'))
  // 只以插件后台入口为根编译必要依赖，在临时包中验证实际子进程，不进行全项目构建。
  const config = ts.readConfigFile(resolve('tsconfig.server.json'), ts.sys.readFile)
  const parsed = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, repository)
  const program = ts.createProgram([resolve('server/managed-entry.ts')], {
    ...parsed.options, rootDir: repository, outDir: join(packageDir, 'dist-server'), noEmit: false,
  })
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
  assert.deepEqual(diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), [])
  assert.equal(program.emit().emitSkipped, false)
  extension = (await import(pathToFileURL(join(packageDir, 'extensions/pi-manage.js')).href)).default
})

beforeEach(() => {
  const agentDir = join(fixtureDir, `agent-${++agentNumber}`)
  fs.mkdirSync(agentDir)
  process.env.PI_CODING_AGENT_DIR = agentDir
  for (const name of envNames.slice(1)) delete process.env[name]
})

after(() => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  if (!fixtureDir) return
  const rel = relative(tmpdir(), fixtureDir)
  assert.ok(rel.startsWith('pi-manage-extension-test-') && !isAbsolute(rel) && !rel.includes('..'))
  fs.rmSync(fixtureDir, { recursive: true, force: true })
})

function host(t, factory = extension, browserCode = 0) {
  const handlers = new Map()
  const commands = new Map()
  const notices = []
  const opens = []
  const ctx = { hasUI: true, mode: 'tui', ui: { notify: (text, level) => notices.push({ text, level }) } }
  factory({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    exec: async (command, args, options) => {
      opens.push({ command, args, options })
      return { code: browserCode, killed: false, stdout: '', stderr: '' }
    },
  })
  const shutdown = (reason = 'quit') => handlers.get('session_shutdown')({ type: 'session_shutdown', reason }, ctx)
  t.after(() => shutdown())
  return {
    notices, opens, commands, handlers, shutdown,
    run: (args = '') => commands.get('pi-manage').handler(args, ctx),
    url: () => notices.map((notice) => notice.text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]).filter(Boolean).at(-1),
  }
}

async function assertServing(url) {
  assert.ok(url, '后台必须报告实际分配的端口')
  assert.deepEqual(await (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) })).json(), { ok: true })
  assert.match(await (await fetch(url, { signal: AbortSignal.timeout(2000) })).text(), /isolated pi-manage fixture/)
}

test('扩展发现阶段只注册命令，status 和无效参数不会启动后台', async (t) => {
  const pi = host(t)
  assert.equal(pi.commands.size, 1)
  assert.equal(pi.handlers.has('session_shutdown'), true)
  assert.equal(pi.notices.length, 0)
  await pi.run('status')
  assert.match(pi.notices.at(-1).text, /尚未启动/)
  await pi.run('unsupported --argument')
  assert.match(pi.notices.at(-1).text, /用法/)
  assert.equal(pi.url(), undefined)
  assert.equal(pi.opens.length, 0)
})

test('启动真实后台，重复或并发调用复用同一个实例', { timeout: 15000 }, async (t) => {
  const pi = host(t)
  await Promise.all([pi.run('start'), pi.run('start')])
  const url = pi.url()
  await assertServing(url)
  await pi.run('start')
  assert.equal(pi.url(), url)
  await pi.run('status')
  assert.equal(pi.notices.at(-1).text, url)
  assert.equal(pi.opens.length, 0)
  const reported = new Set(pi.notices.map((notice) => notice.text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]).filter(Boolean))
  assert.deepEqual([...reported], [url])
})

test('默认命令打开管理页，浏览器打开失败仍保留可访问地址', { timeout: 15000 }, async (t) => {
  const pi = host(t, extension, 1)
  await pi.run()
  await assertServing(pi.url())
  assert.equal(pi.opens.length, 1)
  assert.equal(pi.opens[0].args.at(-1), pi.url())
  assert.equal(pi.opens[0].options.timeout, 5000)
  assert.match(pi.notices.at(-1).text, /未能自动打开浏览器/)
  assert.equal(pi.notices.at(-1).level, 'warning')
})

test('停止操作幂等，停止后可以重新启动', { timeout: 15000 }, async (t) => {
  const pi = host(t)
  await pi.run('start')
  const oldUrl = pi.url()
  await Promise.all([pi.run('stop'), pi.run('stop')])
  await assert.rejects(fetch(`${oldUrl}/api/health`, { signal: AbortSignal.timeout(1000) }))
  await pi.run('status')
  assert.match(pi.notices.at(-1).text, /尚未启动/)
  await pi.run('start')
  await assertServing(pi.url())
})

test('启动期间停止或退出也能清理后台，旧会话不接收迟到通知', { timeout: 15000 }, async (t) => {
  const pi = host(t)
  const starting = pi.run('start')
  await pi.run('stop')
  await starting
  await pi.run('status')
  assert.match(pi.notices.at(-1).text, /尚未启动/)
  const another = pi.run('start')
  const noticeCount = pi.notices.length
  await pi.shutdown()
  await another
  assert.equal(pi.notices.length, noticeCount)
})

for (const reason of ['quit', 'reload', 'new', 'resume', 'fork']) {
  test(`${reason} 生命周期事件会关闭本次后台`, { timeout: 15000 }, async (t) => {
    const pi = host(t)
    await pi.run('start')
    const url = pi.url()
    await assertServing(url)
    await pi.shutdown(reason)
    await assert.rejects(fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }))
  })
}

test('两个 pi 实例使用独立端口，关闭其中一个不会影响另一个', { timeout: 15000 }, async (t) => {
  const first = host(t)
  const second = host(t)
  await Promise.all([first.run('start'), second.run('start')])
  assert.notEqual(first.url(), second.url())
  await first.shutdown()
  await assert.rejects(fetch(`${first.url()}/api/health`, { signal: AbortSignal.timeout(1000) }))
  await assertServing(second.url())
})

test('缺少构建产物时给出可操作提示，不尝试启动开发服务', async (t) => {
  const empty = join(fixtureDir, 'missing-build')
  fs.mkdirSync(join(empty, 'extensions'), { recursive: true })
  fs.writeFileSync(join(empty, 'package.json'), '{"type":"module"}')
  fs.copyFileSync('extensions/pi-manage.js', join(empty, 'extensions/pi-manage.js'))
  const factory = (await import(pathToFileURL(join(empty, 'extensions/pi-manage.js')).href)).default
  const pi = host(t, factory)
  await pi.run('start')
  assert.match(pi.notices.at(-1).text, /缺少构建产物.*npm run build/)
  assert.equal(pi.notices.at(-1).level, 'error')
  assert.equal(pi.url(), undefined)
})

test('后台启动失败会报告原因，修正配置后可以重试', { timeout: 15000 }, async (t) => {
  const appDir = join(process.env.PI_CODING_AGENT_DIR, '.pi-manage')
  fs.mkdirSync(appDir)
  fs.writeFileSync(join(appDir, 'config.json'), '{broken fixture')
  const pi = host(t)
  await pi.run('start')
  assert.equal(pi.notices.at(-1).level, 'error')
  assert.match(pi.notices.at(-1).text, /后台已退出/)
  fs.writeFileSync(join(appDir, 'config.json'), '{}')
  await pi.run('start')
  await assertServing(pi.url())
})

test('父进程被强制结束后，后台通过 IPC 断开自行退出', { timeout: 15000 }, async (t) => {
  const parent = fork(resolve('scripts/fixtures/pi-extension-parent.mjs'), [join(packageDir, 'dist-server/server/managed-entry.js')], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  })
  let backendPid
  t.after(() => {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
    if (backendPid) {
      try { process.kill(backendPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  })
  const [ready] = await once(parent, 'message')
  assert.equal(ready.type, 'ready')
  backendPid = ready.pid
  const url = `http://127.0.0.1:${ready.port}`
  await assertServing(url)
  const ended = once(parent, 'close')
  parent.kill('SIGKILL')
  await ended
  const deadline = Date.now() + 5000
  while (true) {
    try { process.kill(backendPid, 0) } catch (error) {
      assert.equal(error.code, 'ESRCH')
      backendPid = undefined
      break
    }
    assert.ok(Date.now() < deadline, '父进程退出后后台仍然存活')
    await delay(25)
  }
  await assert.rejects(fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }))
})

test('后台专用入口拒绝脱离 pi 的 IPC 通道运行', { timeout: 5000 }, async (t) => {
  const child = spawn(process.execPath, [join(packageDir, 'dist-server/server/managed-entry.js')], {
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  let error = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text) => { error += text })
  const [code] = await once(child, 'close')
  assert.equal(code, 1)
  assert.match(error, /需要由 pi-manage 扩展启动/)
})
