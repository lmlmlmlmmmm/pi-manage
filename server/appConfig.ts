// pi-manage 自身的应用配置（代理等），存 ~/.pi/agent/.pi-manage/config.json。
// 与 pi 的 settings.json 完全分离：这是本工具的私有配置，pi 不读它。
// 代理值在保存时映射到进程环境变量（proxyFetch 按环境变量取），
// 重启后端后由 start() 时读文件预热注入，保证文件配置即时生效并能跨重启恢复。

import { existsSync, mkdirSync } from 'node:fs'
import { agentDir, readJson, writeFileAtomic } from './config.js'
import { join } from 'node:path'

const APP_CONFIG_FILE = join('.pi-manage', 'config.json')

export interface AppConfig {
  /** HTTP/mixed 或 SOCKS5 代理地址，如 http://127.0.0.1:10808、socks5://127.0.0.1:1080 */
  proxy?: string
  /** 可选代理认证；明文保存在本机私有配置中 */
  proxyUsername?: string
  proxyPassword?: string
  [key: string]: unknown
}

function appConfigFile(): string {
  return join(agentDir(), APP_CONFIG_FILE)
}

export function loadAppConfig(): AppConfig {
  return readJson<AppConfig>(appConfigFile(), 'pi-manage 配置') ?? {}
}

export function saveAppConfig(config: AppConfig): AppConfig {
  // 先建目录再写：代理页可能在首次运行（尚未触发 loadState 建目录）时直接保存
  mkdirSync(join(agentDir(), '.pi-manage'), { recursive: true })
  // 写文件 + 同步进程环境变量：当前进程内的请求立即生效，无需重启
  writeFileAtomic(appConfigFile(), JSON.stringify(config, null, 2))
  applyProxyEnv(config)
  return config
}

// 把代理配置映射到环境变量（proxyFetch 的统一取值点）。认证信息拆成独立变量，
// 避免为了运行时传递而改写用户输入的代理 URL。
export function applyProxyEnv(config: AppConfig): void {
  const proxy = config.proxy?.trim()
  const username = config.proxyUsername?.trim()
  const password = config.proxyPassword ?? ''
  if (proxy) {
    process.env.PI_MANAGE_PROXY = proxy
    if (username) process.env.PI_MANAGE_PROXY_USERNAME = username
    else delete process.env.PI_MANAGE_PROXY_USERNAME
    if (password) process.env.PI_MANAGE_PROXY_PASSWORD = password
    else delete process.env.PI_MANAGE_PROXY_PASSWORD
  } else {
    delete process.env.PI_MANAGE_PROXY
    delete process.env.PI_MANAGE_PROXY_USERNAME
    delete process.env.PI_MANAGE_PROXY_PASSWORD
  }
}

// 启动时调用：文件里的代理配置优先级低于用户显式设置的环境变量
//（环境变量方式是文档化的高级用法，不应被文件配置悄悄覆盖）
export function initAppConfig(): void {
  if (!existsSync(appConfigFile())) return
  if (process.env.PI_MANAGE_PROXY?.trim()) return
  applyProxyEnv(loadAppConfig())
}
