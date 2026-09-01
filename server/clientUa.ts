// 从 npm registry 获取 codex / claude-code 最新版本，生成标准格式的 CLI UA。
// 网络请求经 outboundFetch（用户配置代理时走代理）。
// 用于填写代理网关要求的 User-Agent（多数网关按前缀校验，如 codex_vscode/、claude-cli/）。
// 已有 UA 时只替换版本段、保留 OS/VS Code 等其他段；无则用默认模板。

import { outboundFetch } from './proxyFetch.js'

interface ClientUaDef {
  label: string
  npmUrl: string
  // 版本段正则：匹配「前缀/版本」，用于在已有 UA 中只替换版本号
  versionRe: RegExp
  // 无现有 UA 时的默认模板（{version} 占位）；Windows/VS Code 段可按需修改
  template: string
}

const DEFS = {
  codex: {
    label: 'codex',
    npmUrl: 'https://registry.npmjs.org/@openai/codex/latest',
    versionRe: /^(codex_vscode|codex_cli|codex_nova)\/[^ ]+/,
    template: 'codex_vscode/{version} (Windows 10.0.26200; x86_64) unknown (VS Code; 26.721.30844)',
  },
  claude: {
    label: 'claude-cli',
    npmUrl: 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest',
    versionRe: /^claude-cli\/[^ ]+/,
    template: 'claude-cli/{version} (external, cli)',
  },
} as const

export type ClientUaKind = keyof typeof DEFS

// 会话内缓存版本号，避免重复请求
const versionCache = new Map<ClientUaKind, Promise<string>>()

// npm registry 允许跨域（Access-Control-Allow-Origin: *），浏览器直连
function fetchLatestVersion(kind: ClientUaKind): Promise<string> {
  let p = versionCache.get(kind)
  if (!p) {
    p = (async () => {
      const res = await outboundFetch(DEFS[kind].npmUrl, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`npm HTTP ${res.status}`)
      const data = (await res.json()) as { version?: string }
      if (!data.version) throw new Error('npm 响应缺少 version 字段')
      return data.version
    })().catch((e: unknown) => {
      // 失败即清空缓存：rejected promise 若留在缓存，进程内就永远无法重试了
      versionCache.delete(kind)
      throw e
    })
    versionCache.set(kind, p)
  }
  return p
}

// 生成/更新 UA：existing 以对应前缀开头时只换版本段（保留原前缀与 OS/其他段），否则用模板
export async function latestClientUa(kind: ClientUaKind, existing?: string): Promise<string> {
  const def = DEFS[kind]
  const version = await fetchLatestVersion(kind)
  if (existing && def.versionRe.test(existing)) {
    return existing.replace(def.versionRe, (m) => `${m.split('/')[0]}/${version}`)
  }
  return def.template.replace('{version}', version)
}
