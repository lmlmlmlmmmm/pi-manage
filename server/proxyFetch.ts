// HTTP/mixed 与 SOCKS5 代理支持：所有后端外发 HTTPS 请求统一经代理隧道转发。
// 零第三方依赖：HTTP 使用 CONNECT（可带 Basic 认证），SOCKS5 使用 RFC 1928/1929 握手。

import { request as httpsRequest } from 'node:https'
import { connect as tcpConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

export interface ProxySettings {
  proxy: string
  username?: string
  password?: string
}

export type ProxyOverride = string | ProxySettings

interface ParsedProxy {
  protocol: 'http:' | 'socks5:'
  hostname: string
  port: number
  username: string
  password: string
}

interface ProxiedFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

interface ProxiedFetchResult {
  ok: boolean
  status: number
  text(): Promise<string>
  /** 解析 JSON（对齐原生 fetch 的便捷方法；解析失败抛错） */
  json(): Promise<unknown>
}

function configuredProxy(override?: ProxyOverride): ProxySettings | undefined {
  if (typeof override === 'string') {
    const proxy = override.trim()
    return proxy ? { proxy } : undefined
  }
  if (override) {
    const proxy = override.proxy.trim()
    return proxy ? { ...override, proxy } : undefined
  }
  const proxy = process.env.PI_MANAGE_PROXY?.trim()
  if (!proxy) return undefined
  return {
    proxy,
    username: process.env.PI_MANAGE_PROXY_USERNAME,
    password: process.env.PI_MANAGE_PROXY_PASSWORD,
  }
}

// 兼容既有调用方：只返回当前代理地址，不暴露认证信息。
export function proxyUrl(override?: ProxyOverride): string | undefined {
  return configuredProxy(override)?.proxy
}

function parseProxy(settings: ProxySettings): ParsedProxy {
  const raw = settings.proxy.trim()
  const value = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('代理地址格式无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'socks5:') {
    throw new Error('仅支持 http://、socks5:// 或 host:port 代理地址')
  }
  if (!url.hostname) throw new Error('代理地址缺少主机名')
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('代理地址不能包含路径、查询参数或片段')
  }
  const port = Number(url.port || (url.protocol === 'socks5:' ? 1080 : 80))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('代理端口必须在 1-65535 之间')
  }
  return {
    protocol: url.protocol,
    hostname: url.hostname.replace(/^\[(.*)]$/, '$1'),
    port,
    // 单独字段优先；环境变量也可直接使用带 userinfo 的代理 URL。
    username: settings.username?.trim() || decodeURIComponent(url.username),
    password: settings.password || decodeURIComponent(url.password),
  }
}

export function validateProxySettings(settings: ProxySettings): string | undefined {
  try {
    const parsed = parseProxy(settings)
    if (parsed.protocol === 'socks5:') {
      if (Buffer.byteLength(parsed.username) > 255) return 'SOCKS5 用户名不能超过 255 字节'
      if (Buffer.byteLength(parsed.password) > 255) return 'SOCKS5 密码不能超过 255 字节'
    }
    return undefined
  } catch (e) {
    return (e as Error).message
  }
}

function openProxySocket(proxy: ParsedProxy, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('请求已中止'))
      return
    }
    const socket = tcpConnect(proxy.port, proxy.hostname)
    const fail = (error: Error) => {
      cleanup()
      socket.destroy()
      reject(error)
    }
    const onAbort = () => fail(new Error('请求已中止'))
    const onError = (error: Error) => fail(new Error(`代理连接失败：${error.message}`))
    const onTimeout = () => fail(new Error('代理连接超时'))
    const cleanup = () => {
      socket.removeListener('error', onError)
      socket.removeListener('timeout', onTimeout)
      signal?.removeEventListener('abort', onAbort)
    }
    socket.setTimeout(30_000)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => {
      cleanup()
      socket.setTimeout(0)
      resolve(socket)
    })
  })
}

class SocketReader {
  private buffer = Buffer.alloc(0)
  private pending: {
    length: number
    resolve: (value: Buffer) => void
    reject: (error: Error) => void
  } | null = null
  private ended = false

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('end', this.onEnd)
    socket.on('timeout', this.onTimeout)
  }

  read(length: number): Promise<Buffer> {
    if (this.pending) return Promise.reject(new Error('代理握手发生并发读取'))
    if (this.buffer.length >= length) return Promise.resolve(this.take(length))
    if (this.ended) return Promise.reject(new Error('代理在握手完成前关闭连接'))
    return new Promise((resolve, reject) => {
      this.pending = { length, resolve, reject }
    })
  }

  dispose(): void {
    this.socket.removeListener('data', this.onData)
    this.socket.removeListener('error', this.onError)
    this.socket.removeListener('end', this.onEnd)
    this.socket.removeListener('timeout', this.onTimeout)
    // 握手后若代理提前附带了隧道数据，放回 socket 供 TLS 层继续读取。
    if (this.buffer.length) {
      this.socket.pause()
      this.socket.unshift(this.buffer)
      this.buffer = Buffer.alloc(0)
    }
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.flush()
  }

  private readonly onError = (error: Error) => this.fail(error)
  private readonly onEnd = () => {
    this.ended = true
    this.fail(new Error('代理在握手完成前关闭连接'))
  }
  private readonly onTimeout = () => this.fail(new Error('代理握手超时'))

  private flush(): void {
    const pending = this.pending
    if (!pending || this.buffer.length < pending.length) return
    this.pending = null
    pending.resolve(this.take(pending.length))
  }

  private take(length: number): Buffer {
    const value = this.buffer.subarray(0, length)
    this.buffer = this.buffer.subarray(length)
    return value
  }

  private fail(error: Error): void {
    const pending = this.pending
    this.pending = null
    pending?.reject(error)
  }
}

function readUntil(socket: Socket, marker: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const cleanup = () => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('end', onEnd)
      socket.removeListener('timeout', onTimeout)
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onError = (error: Error) => fail(error)
    const onEnd = () => fail(new Error('代理在握手完成前关闭连接'))
    const onTimeout = () => fail(new Error('代理握手超时'))
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > maxBytes) {
        fail(new Error('代理握手响应过大'))
        return
      }
      const end = buffer.indexOf(marker)
      if (end < 0) return
      cleanup()
      const consumed = end + marker.length
      const rest = buffer.subarray(consumed)
      if (rest.length) socket.unshift(rest)
      resolve(buffer.subarray(0, consumed))
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('end', onEnd)
    socket.once('timeout', onTimeout)
  })
}

async function establishHttpTunnel(socket: Socket, proxy: ParsedProxy, host: string, port: number): Promise<void> {
  const target = `${host}:${port}`
  const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`, 'Proxy-Connection: Keep-Alive']
  if (proxy.username || proxy.password) {
    const token = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
    lines.push(`Proxy-Authorization: Basic ${token}`)
  }
  socket.setTimeout(30_000)
  socket.write(lines.join('\r\n') + '\r\n\r\n')
  const header = (await readUntil(socket, Buffer.from('\r\n\r\n'), 32 * 1024)).toString('latin1')
  socket.setTimeout(0)
  const statusLine = header.split('\r\n')[0] ?? ''
  if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
    if (/\s407\s/.test(statusLine)) throw new Error('代理认证失败（HTTP 407）')
    throw new Error(`代理拒绝建立隧道：${statusLine || '无状态行'}`)
  }
}

async function establishSocks5Tunnel(socket: Socket, proxy: ParsedProxy, host: string, port: number): Promise<void> {
  socket.setTimeout(30_000)
  const reader = new SocketReader(socket)
  try {
    const hasCredentials = !!(proxy.username || proxy.password)
    socket.write(Buffer.from(hasCredentials ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))
    const methodReply = await reader.read(2)
    if (methodReply[0] !== 0x05) throw new Error('SOCKS5 代理返回了无效版本')
    if (methodReply[1] === 0xff) throw new Error('SOCKS5 代理不接受可用的认证方式')
    if (methodReply[1] === 0x02) {
      const user = Buffer.from(proxy.username)
      const password = Buffer.from(proxy.password)
      if (user.length > 255 || password.length > 255) throw new Error('SOCKS5 用户名或密码超过 255 字节')
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([password.length]), password]))
      const authReply = await reader.read(2)
      if (authReply[0] !== 0x01 || authReply[1] !== 0x00) throw new Error('SOCKS5 代理认证失败')
    } else if (methodReply[1] !== 0x00) {
      throw new Error(`SOCKS5 代理选择了不支持的认证方式：0x${methodReply[1].toString(16)}`)
    }

    const hostBytes = Buffer.from(host)
    if (hostBytes.length > 255) throw new Error('目标主机名过长，无法通过 SOCKS5 连接')
    socket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
        hostBytes,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]),
    )
    const reply = await reader.read(4)
    if (reply[0] !== 0x05) throw new Error('SOCKS5 代理返回了无效连接响应')
    if (reply[1] !== 0x00) throw new Error(`SOCKS5 代理拒绝连接，错误码：0x${reply[1].toString(16)}`)

    if (reply[3] === 0x01) await reader.read(4)
    else if (reply[3] === 0x04) await reader.read(16)
    else if (reply[3] === 0x03) {
      const length = (await reader.read(1))[0]
      await reader.read(length)
    } else throw new Error('SOCKS5 代理返回了未知地址类型')
    await reader.read(2)
  } finally {
    reader.dispose()
    socket.setTimeout(0)
  }
}

function requestThroughTunnel(
  socket: Socket,
  target: URL,
  opts: ProxiedFetchOptions,
): Promise<ProxiedFetchResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const tlsSocket = tlsConnect({ socket, servername: target.hostname })
    const headers = { ...opts.headers }
    if (opts.body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(Buffer.byteLength(opts.body))
    }
    const request = httpsRequest(
      target,
      {
        method: opts.method ?? 'GET',
        headers,
        agent: false,
        createConnection: () => tlsSocket,
        signal: opts.signal,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          if (settled) return
          settled = true
          const body = Buffer.concat(chunks).toString('utf-8')
          const status = response.statusCode ?? 0
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => body,
            json: async () => JSON.parse(body),
          })
        })
      },
    )
    request.setTimeout(60_000, () => request.destroy(new Error('代理隧道内请求超时')))
    request.on('error', (error) => {
      if (settled) return
      settled = true
      reject(new Error(`代理隧道内错误：${error.message}`))
    })
    request.end(opts.body)
  })
}

// 统一出口：配置代理时先建立隧道，再由 Node HTTPS 客户端发送请求；未配置则使用原生 fetch。
export async function outboundFetch(
  url: string,
  opts: ProxiedFetchOptions = {},
  proxyOverride?: ProxyOverride,
): Promise<ProxiedFetchResult> {
  const settings = configuredProxy(proxyOverride)
  if (!settings) {
    const response = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: opts.signal,
    })
    return {
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
      json: () => response.json(),
    }
  }

  const target = new URL(url)
  if (target.protocol !== 'https:') throw new Error('代理模式仅支持 HTTPS 目标请求')
  const proxy = parseProxy(settings)
  const socket = await openProxySocket(proxy, opts.signal)
  const onAbort = () => socket.destroy(new Error('请求已中止'))
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (proxy.protocol === 'socks5:') {
      await establishSocks5Tunnel(socket, proxy, target.hostname, Number(target.port || 443))
    } else {
      await establishHttpTunnel(socket, proxy, target.hostname, Number(target.port || 443))
    }
    return await requestThroughTunnel(socket, target, opts)
  } catch (e) {
    socket.destroy()
    throw e
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
