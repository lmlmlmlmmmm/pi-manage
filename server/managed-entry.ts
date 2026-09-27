// pi 扩展专用后台：通过 IPC 接受退出指令，父进程消失后也不能留下独立守护进程。
import { existsSync } from 'node:fs'
import { start } from './index.js'

if (!process.send || !process.connected) {
  console.error('此入口需要由 pi-manage 扩展启动；独立运行请使用 pi-manage 命令。')
  process.exit(1)
}

let server: ReturnType<typeof start> | undefined
let stopping = false

function shutdown(): void {
  if (stopping) return
  stopping = true
  // 停止接收新请求并关闭浏览器连接，模型测试会随响应连接关闭而取消。
  if (server?.listening) {
    server.close(() => process.exit(0))
    server.closeAllConnections()
    // 上游网络请求或其他未结束的句柄不能延长插件后台的生命周期。
    setTimeout(() => process.exit(0), 1000).unref()
  } else {
    process.exit(0)
  }
}

process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') shutdown()
})
process.once('disconnect', shutdown)
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

if (!existsSync(new URL('../../dist/index.html', import.meta.url))) {
  console.error('缺少网页构建产物，请先在 pi-manage 项目目录执行 npm run build。')
  process.exit(1)
}

// 每个 pi 运行实例独占自己的空闲端口，绝不接管或关闭其他实例的后台。
server = start(0, false)
server.once('listening', () => {
  const address = server!.address()
  if (!address || typeof address === 'string') throw new Error('后台未获得有效的本机端口')
  if (!process.connected || stopping) {
    shutdown()
    return
  }
  process.send!({ type: 'ready', port: address.port }, (error: Error | null) => {
    if (error) shutdown()
  })
})
