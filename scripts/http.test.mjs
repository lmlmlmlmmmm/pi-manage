import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:http'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { start } from '../server/index.ts'

test('本机 API 拒绝跨来源和简单请求，合法同源 JSON 可以正常保存', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'pi-manage-http-'))
  const previousDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  let commands = 0
  t.mock.method(childProcess, 'execSync', () => {
    commands++
    throw new Error('测试中禁止执行任何系统命令')
  })
  syncBuiltinESMExports()
  const server = start(0, false)
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    t.mock.restoreAll()
    syncBuiltinESMExports()
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousDir
    const rel = relative(tmpdir(), dir)
    assert.ok(rel.startsWith('pi-manage-http-') && !isAbsolute(rel) && !rel.includes('..'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const commandBody = JSON.stringify({
    provider: { api: 'openai-completions', baseUrl: 'https://unused.invalid', apiKey: '!must-not-run' },
    model: { id: 'demo' },
  })
  for (const headers of [
    { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
    { Origin: 'null', 'Content-Type': 'application/json' },
    { Origin: 'http://127.0.0.1:1', 'Content-Type': 'application/json' },
    { Origin: base, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
  ]) {
    const response = await fetch(`${base}/api/models/test`, { method: 'POST', headers, body: commandBody })
    assert.equal(response.status, 403)
  }
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const response = await fetch(`${base}/api/models/test`, {
      method: 'POST', headers: { 'Content-Type': contentType }, body: commandBody,
    })
    assert.equal(response.status, 415)
  }
  assert.equal(commands, 0)
  const invalidMode = await fetch(`${base}/api/models/test`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...JSON.parse(commandBody), stream: 'true' }),
  })
  assert.equal(invalidMode.status, 400)
  assert.match((await invalidMode.json()).error, /stream 必须是布尔值/)
  assert.equal(commands, 0)
  assert.equal(fs.existsSync(join(dir, '.pi-manage')), false)
  for (const body of ['null', '[]', '{broken']) {
    const response = await fetch(`${base}/api/save`, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body,
    })
    assert.equal(response.status, 400)
  }
  const deniedRead = await fetch(`${base}/api/config`, { headers: { 'Sec-Fetch-Site': 'same-site' } })
  assert.equal(deniedRead.status, 403)
  const state = await (await fetch(`${base}/api/config`)).json()
  const saved = await fetch(`${base}/api/save`, {
    method: 'POST',
    headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ ...state, settingsBaseline: state.settings, settings: { theme: 'light' } }),
  })
  assert.equal(saved.status, 200)
  const result = await saved.json()
  assert.equal(result.ok, true)
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'settings.json'), 'utf-8')).theme, 'light')
})

test('客户端取消测试会关闭上游流，后续正常测试不受影响', { timeout: 8000 }, async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'pi-manage-http-cancel-'))
  const previous = Object.fromEntries(['PI_CODING_AGENT_DIR', 'PI_MANAGE_PROXY'].map((name) => [name, process.env[name]]))
  process.env.PI_CODING_AGENT_DIR = dir
  delete process.env.PI_MANAGE_PROXY
  const entered = Promise.withResolvers()
  const upstreamClosed = Promise.withResolvers()
  let normal = false
  const gateway = createServer(async (req, res) => {
    for await (const chunk of req) { /* 等待测试请求体发送完成，模拟正在生成回复的网关。 */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (normal) {
      res.end('data: {"choices":[{"delta":{"content":"fixture reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      return
    }
    res.once('close', () => upstreamClosed.resolve())
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    entered.resolve()
  })
  let backend
  t.after(async () => {
    for (const server of [backend, gateway]) {
      if (!server?.listening) continue
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    const rel = relative(tmpdir(), dir)
    assert.ok(rel.startsWith('pi-manage-http-cancel-') && !isAbsolute(rel) && !rel.includes('..'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  gateway.listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  backend = start(0, false)
  await once(backend, 'listening')
  const base = `http://127.0.0.1:${backend.address().port}`
  const upstream = `http://127.0.0.1:${gateway.address().port}`
  const originalFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.ok([base, upstream].includes(new URL(String(url)).origin), '测试禁止外部请求')
    return originalFetch(url, options)
  })
  const body = JSON.stringify({ provider: { api: 'openai-completions', baseUrl: upstream }, model: { id: 'demo' } })
  const controller = new AbortController()
  const pending = fetch(`${base}/api/models/test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal,
  })
  await entered.promise
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  await upstreamClosed.promise
  normal = true
  const result = await (await fetch(`${base}/api/models/test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  })).json()
  assert.equal(result.ok, true, result.error)
  assert.equal(result.reply, 'fixture reply')
})
