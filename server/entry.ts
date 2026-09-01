#!/usr/bin/env node
// pi-manage 命令行入口：npm i -g 后直接 `pi-manage` 启动本地服务
import { start } from './index.js'

const args = process.argv.slice(2)
let port = 8787
let open = true

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') {
    // 非法端口直接报错退出：静默回落 8787 会让用户误以为自定义端口已生效
    const raw = args[i + 1]
    const v = Number(raw)
    if (!Number.isInteger(v) || v < 1 || v > 65535) {
      console.error(`无效的端口参数：${raw ?? '（缺失）'}。用法：--port <1-65535>`)
      process.exit(1)
    }
    port = v
    i++
  } else if (args[i] === '--no-open') {
    open = false
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`pi-manage - pi 本地配置管理
用法: pi-manage [--port <端口>] [--no-open]
  --port     监听端口（默认 8787）
  --no-open  启动后不自动打开浏览器`)
    process.exit(0)
  }
}

start(port, open)
