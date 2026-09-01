// pi-manage 本地服务：托管前端静态产物 + 提供配置管理 REST API。
// Node 原生进程持有完整文件系统/网络权限，前端不再依赖浏览器沙箱授权。

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, extname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadState, saveAll } from './config.js'
import { PI_API_OPTIONS } from '../src/types.js'
import type { PiApi, PiLibrary, PiSettings } from '../src/types.js'
import { fetchProviderModels } from './fetchModels.js'
import { testModel } from './modelTest.js'
import { latestClientUa } from './clientUa.js'
import { lookupModelMeta } from './modelsDev.js'
import { loadAppConfig, saveAppConfig, initAppConfig } from './appConfig.js'
import { outboundFetch, validateProxySettings, type ProxySettings } from './proxyFetch.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 编译产物在 dist-server/server/，上两级到项目根；dist 前端产物也在项目根
const DIST_DIR = join(__dirname, '..', '..', 'dist')
const DEFAULT_PORT = 8787

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

// 请求体上限：配置整包远小于此，防御异常/恶意超大请求
const MAX_BODY_BYTES = 10 * 1024 * 1024

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('请求体超过 10MB 上限')
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

// ---------- API 路由 ----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// /api/models/import 的 api 协议白名单：与 PiApi 联合类型同源（PI_API_OPTIONS），
// 拒绝任意字符串静默落入 openai 分支按错误协议请求网关
const KNOWN_APIS = new Set<string>(PI_API_OPTIONS.map((o) => o.value))

function proxySettingsFromBody(body: Record<string, unknown>): ProxySettings {
  return {
    proxy: typeof body.proxy === 'string' ? body.proxy.trim() : '',
    username: typeof body.proxyUsername === 'string' ? body.proxyUsername.trim() : '',
    password: typeof body.proxyPassword === 'string' ? body.proxyPassword : '',
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(res, 200, loadState())
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/proxy') {
    // 本工具自身配置（代理等），与 pi 的 settings.json 分离
    sendJson(res, 200, loadAppConfig())
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/ua-latest') {
    // 指定 kind 时生成单条 UA（可带 existing 只替换版本段）；否则返回两条默认模板供预拉取
    const kind = url.searchParams.get('kind')
    const existing = url.searchParams.get('existing') ?? undefined
    if (kind === 'codex' || kind === 'claude') {
      try {
        sendJson(res, 200, { ua: await latestClientUa(kind, existing) })
      } catch (e) {
        sendJson(res, 400, { error: (e as Error).message })
      }
      return true
    }
    const [codex, claude] = await Promise.allSettled([latestClientUa('codex'), latestClientUa('claude')])
    sendJson(res, 200, {
      codex: codex.status === 'fulfilled' ? codex.value : null,
      claude: claude.status === 'fulfilled' ? claude.value : null,
    })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/models-dev') {
    // 编辑表单「获取元数据」：按 id 查 models.dev 补全；
    // proxy 参数：临时代理（代理页「测试」按钮验证输入框当前值，不落盘不进缓存）
    const id = url.searchParams.get('id') ?? ''
    if (!id) {
      sendJson(res, 400, { error: '缺少 id' })
      return true
    }
    try {
      sendJson(res, 200, { meta: await lookupModelMeta(id, url.searchParams.get('proxy') ?? undefined) })
    } catch (e) {
      sendJson(res, 400, { error: (e as Error).message })
    }
    return true
  }
  if (req.method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = (await readBody(req)) as Record<string, unknown>
    } catch (e) {
      sendJson(res, 400, { error: (e as Error).message })
      return true
    }
    // 代理测试：独立、无缓存地请求 models.dev；认证信息放 POST body，避免泄漏到 URL/访问日志。
    if (url.pathname === '/api/proxy/test') {
      const settings = proxySettingsFromBody(body)
      if (!settings.proxy) {
        sendJson(res, 400, { error: '请先填写代理地址' })
        return true
      }
      const validationError = validateProxySettings(settings)
      if (validationError) {
        sendJson(res, 400, { error: validationError })
        return true
      }
      try {
        const response = await outboundFetch(
          'https://models.dev/api.json',
          { signal: AbortSignal.timeout(15_000) },
          settings,
        )
        if (!response.ok) throw new Error(`目标站点返回 HTTP ${response.status}`)
        await response.text()
        sendJson(res, 200, { ok: true })
      } catch (e) {
        sendJson(res, 400, { error: (e as Error).message })
      }
      return true
    }
    // 代理配置：保存即生效（写入应用配置文件 + 同步进程环境变量）
    if (url.pathname === '/api/proxy') {
      const settings = proxySettingsFromBody(body)
      if (settings.proxy) {
        const validationError = validateProxySettings(settings)
        if (validationError) {
          sendJson(res, 400, { error: validationError })
          return true
        }
      }
      const config = loadAppConfig()
      config.proxy = settings.proxy || undefined
      config.proxyUsername = settings.proxy ? settings.username || undefined : undefined
      config.proxyPassword = settings.proxy ? settings.password || undefined : undefined
      try {
        sendJson(res, 200, saveAppConfig(config))
      } catch (e) {
        sendJson(res, 500, { error: `保存失败：${(e as Error).message}` })
      }
      return true
    }
    if (url.pathname === '/api/save') {
      const library = body.library as PiLibrary
      const settings = body.settings as PiSettings
      // 合并基线：前端最后一次见到的磁盘 settings，后端据此三方合并外部变更
      const settingsBaseline = body.settingsBaseline as PiSettings | undefined
      if (!isPlainObject(library) || !isPlainObject(library.providers)) {
        sendJson(res, 400, { error: 'library 必须是含 providers 对象的结构' })
        return true
      }
      if (settings !== undefined && !isPlainObject(settings)) {
        sendJson(res, 400, { error: 'settings 必须是对象' })
        return true
      }
      if (settingsBaseline !== undefined && settingsBaseline !== null && !isPlainObject(settingsBaseline)) {
        sendJson(res, 400, { error: 'settingsBaseline 必须是对象' })
        return true
      }
      sendJson(res, 200, saveAll(library, settings ?? {}, settingsBaseline ?? undefined))
      return true
    }
    if (url.pathname === '/api/models/test') {
      // 模型连接测试：provider + model 整包提交（表单未保存的编辑值也可测），
      // 请求构造与 pi 实际发送一致（端点/认证/模型级覆盖合并）；
      // prompt 可自定义（仅本次请求，不落盘）
      const provider = body.provider
      const model = body.model
      if (!isPlainObject(provider) || !isPlainObject(model) || typeof model.id !== 'string' || !model.id) {
        sendJson(res, 400, { error: '需要 provider 对象和含 id 的 model 对象' })
        return true
      }
      const opts = {
        prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, 2000) : undefined,
      }
      sendJson(res, 200, await testModel(provider as never, model as never, opts))
      return true
    }
    if (url.pathname === '/api/models/import') {
      const api = typeof body.api === 'string' ? body.api : ''
      if (!KNOWN_APIS.has(api)) {
        sendJson(res, 400, { error: `不支持的 api 协议：${api || '(未指定)'}` })
        return true
      }
      try {
        const models = await fetchProviderModels({
          api: api as PiApi,
          baseUrl: String(body.baseUrl ?? ''),
          apiKey: String(body.apiKey ?? ''),
          headers: (body.headers as Record<string, string> | undefined) ?? {},
        })
        sendJson(res, 200, { models })
      } catch (e) {
        sendJson(res, 400, { error: (e as Error).message })
      }
      return true
    }
  }
  return false
}

// ---------- 静态托管 ----------

function serveStatic(res: ServerResponse, pathname: string): void {
  // 安全：只允许 dist 目录内的文件。用 sep 结尾判定，避免 dist-foo 这类前缀目录绕过校验
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const file = join(DIST_DIR, rel)
  if (file !== DIST_DIR && !file.startsWith(DIST_DIR + sep)) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }
  if (existsSync(file)) {
    res.statusCode = 200
    res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
    res.end(readFileSync(file))
    return
  }
  // SPA 回退：非 /api 路径回 index.html
  const index = join(DIST_DIR, 'index.html')
  if (existsSync(index)) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(readFileSync(index))
  } else {
    res.statusCode = 404
    res.end('Not Found')
  }
}

// ---------- 启动 ----------

// Host 校验：DNS rebinding 把攻击域名解析到 127.0.0.1，请求在浏览器看来是同源，
// 可读写本机配置（含明文 apiKey）；只接受本机 Host 是标准阻断手段
function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false
  const name = host
    .replace(/:\d+$/, '')
    .replace(/^\[(.+)\]$/, '$1')
    .toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

function openBrowser(url: string): void {
  // 零依赖：按平台用默认浏览器打开
  const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' })
    child.unref()
  } catch {
    /* 打不开浏览器不影响服务 */
  }
}

export function start(port = DEFAULT_PORT, open = true): void {
  // 启动时读应用配置（代理等）注入进程环境；显式设置的 PI_MANAGE_PROXY 环境变量优先
  initAppConfig()
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!isAllowedHost(req.headers.host)) {
          res.statusCode = 403
          res.end('Forbidden')
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname.startsWith('/api/')) {
          if (await handleApi(req, res, url)) return
          sendJson(res, 404, { error: '未知 API' })
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405
          res.end('Method Not Allowed')
          return
        }
        serveStatic(res, url.pathname)
      } catch (e) {
        sendJson(res, 500, { error: (e as Error).message })
      }
    })()
  })

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用，请先停止占用进程或用 --port 指定其他端口`)
      process.exit(1)
    }
    throw e
  })

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`
    console.log(`pi-manage 已启动: ${url}`)
    console.log('按 Ctrl+C 停止')
    if (open) openBrowser(url)
  })
}
