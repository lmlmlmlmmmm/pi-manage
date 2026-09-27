import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { outboundFetch } from '../server/proxyFetch.ts'

const cert = readFileSync(new URL('./fixtures/proxy-test-cert.pem', import.meta.url))
const key = readFileSync(new URL('./fixtures/proxy-test-key.pem', import.meta.url))

// 测试代理实现标准 SOCKS5 握手，将虚构域名转发到临时 HTTPS 服务。
function acceptSocks(socket, connect, observed) {
  let buffer = Buffer.alloc(0)
  let phase = 'hello'
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    if (phase === 'hello') {
      if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
      buffer = buffer.subarray(2 + buffer[1])
      phase = 'auth'
      socket.write(Buffer.from([5, 2]))
    }
    if (phase === 'auth') {
      if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return
      const userLength = buffer[1]
      const passwordLength = buffer[2 + userLength]
      if (buffer.length < 3 + userLength + passwordLength) return
      observed.auth = [buffer.subarray(2, 2 + userLength).toString(), buffer.subarray(3 + userLength, 3 + userLength + passwordLength).toString()]
      buffer = buffer.subarray(3 + userLength + passwordLength)
      phase = 'connect'
      socket.write(Buffer.from([1, 0]))
    }
    if (phase === 'connect') {
      if (buffer.length < 5 || buffer.length < 7 + buffer[4]) return
      observed.host = buffer.subarray(5, 5 + buffer[4]).toString()
      observed.port = buffer.readUInt16BE(5 + buffer[4])
      buffer = buffer.subarray(7 + buffer[4])
      socket.removeListener('data', onData)
      connect(socket, buffer, Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
    }
  }
  socket.on('data', onData)
}

async function fixture(t, protocol, { trust = true, truncated = false } = {}) {
  const sockets = new Set()
  const track = (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    return socket
  }
  const observed = {}
  const target = https.createServer({ key, cert }, async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (truncated) {
      res.writeHead(200, { 'Content-Length': '10000' })
      res.write('partial')
      setImmediate(() => res.destroy())
      return
    }
    res.end(JSON.stringify({ method: req.method, path: req.url, token: req.headers['x-test-token'], body: Buffer.concat(chunks).toString() }))
  })
  target.on('connection', track)
  target.listen(0, '127.0.0.1')
  await once(target, 'listening')
  const port = target.address().port
  const connect = (socket, head, acknowledgement) => {
    const upstream = track(net.connect(port, '127.0.0.1', () => {
      socket.write(acknowledgement)
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    }))
    socket.on('close', () => upstream.destroy())
  }
  const proxy = protocol === 'http' ? http.createServer() : net.createServer()
  proxy.on('connection', track)
  if (protocol === 'http') {
    proxy.on('connect', (req, socket, head) => {
      observed.host = req.url
      observed.auth = req.headers['proxy-authorization']
      connect(socket, head, 'HTTP/1.1 200 Connection Established\r\n\r\n')
    })
  } else {
    proxy.on('connection', (socket) => acceptSocks(socket, connect, observed))
  }
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  if (trust) {
    // 只信任公开测试证书；不关闭证书验证，也不修改真实进程的代理环境。
    const originalConnect = tls.connect
    t.mock.method(tls, 'connect', (options) => originalConnect({ ...options, ca: cert }))
    syncBuiltinESMExports()
  }
  t.after(async () => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    for (const socket of sockets) socket.destroy()
    await Promise.all([proxy, target].map((server) => new Promise((resolve) => server.close(resolve))))
  })
  return {
    url: `https://pi-manage-proxy.test:${port}/probe`,
    proxy: { proxy: `${protocol}://127.0.0.1:${proxy.address().port}`, username: 'test-user', password: 'test-password' },
    observed,
    port,
  }
}

test('HTTP CONNECT 隧道实际承载 HTTPS 请求、认证和完整 UTF-8 请求体', { timeout: 5000 }, async (t) => {
  const { url, proxy, observed, port } = await fixture(t, 'http')
  const body = JSON.stringify({ text: '代理测试' })
  const result = await outboundFetch(url, { method: 'POST', headers: { 'X-Test-Token': 'example' }, body }, proxy)
  assert.equal(result.ok, true)
  assert.deepEqual(await result.json(), { method: 'POST', path: '/probe', token: 'example', body })
  assert.equal(observed.host, `pi-manage-proxy.test:${port}`)
  assert.equal(observed.auth, `Basic ${Buffer.from('test-user:test-password').toString('base64')}`)
})

test('SOCKS5 认证后经代理解析虚构域名并发送 HTTPS 请求', { timeout: 5000 }, async (t) => {
  const { url, proxy, observed, port } = await fixture(t, 'socks5')
  const result = await outboundFetch(url, {}, proxy)
  assert.equal(result.ok, true)
  assert.deepEqual(observed.auth, ['test-user', 'test-password'])
  assert.equal(observed.host, 'pi-manage-proxy.test')
  assert.equal(observed.port, port)
  assert.equal((await result.json()).path, '/probe')
})

test('TLS 验证失败以请求错误返回，不产生未处理的 socket 异常', { timeout: 5000 }, async (t) => {
  const { url, proxy } = await fixture(t, 'http', { trust: false })
  await assert.rejects(outboundFetch(url, {}, proxy), /代理隧道内错误/)
})

test('代理响应中途截断时结束请求，不永久等待 end 事件', { timeout: 5000 }, async (t) => {
  const { url, proxy } = await fixture(t, 'http', { truncated: true })
  await assert.rejects(outboundFetch(url, {}, proxy), /代理隧道内错误/)
})

test('代理握手期间取消请求会关闭连接', { timeout: 5000 }, async (t) => {
  const sockets = new Set()
  const proxy = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => proxy.close(resolve))
  })
  await assert.rejects(outboundFetch('https://pi-manage-proxy.test/', {
    signal: AbortSignal.timeout(100),
  }, `http://127.0.0.1:${proxy.address().port}`), /中止|aborted/)
})
