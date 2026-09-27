// pi 官方支持 JavaScript 扩展；只使用宿主 API 和 Node 标准库，不增加 SDK 运行时依赖。
import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const workerFile = fileURLToPath(new URL('../dist-server/server/managed-entry.js', import.meta.url))
const pageFile = new URL('../dist/index.html', import.meta.url)

export default function piManageExtension(pi) {
  let current
  let shuttingDown = false
  let generation = 0

  function startBackend(ctx, version) {
    if (current) return current
    if (!existsSync(workerFile) || !existsSync(pageFile)) {
      throw new Error('缺少构建产物，请先在 pi-manage 项目目录执行 npm run build，然后重试 /pi-manage。')
    }
    // pi 独立可执行文件不能当作 Node 解释器；此时使用 PATH 中的 Node.js 22+。
    const embedded = process.versions.bun || process.features?.sea === true || process.getBuiltinModule?.('node:sea')?.isSea()
    const child = fork(workerFile, [], {
      execPath: embedded ? 'node' : process.execPath,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    })
    const owned = { child, url: '', stopping: false, exited: false, stderr: '', ready: null, closed: null, stop: null }
    current = owned
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (text) => { owned.stderr = (owned.stderr + text).slice(-2000) })
    let resolveClosed
    owned.closed = new Promise((resolve) => { resolveClosed = resolve })
    owned.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('pi-manage 后台启动超时'))
        void stopBackend().catch((error) => {
          if (!shuttingDown && generation === version) ctx.ui.notify(error.message, 'error')
        })
      }, 10000)
      child.on('message', (message) => {
        if (message?.type !== 'ready' || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535 || owned.stopping) return
        owned.url = `http://127.0.0.1:${message.port}`
        clearTimeout(timeout)
        resolve(owned.url)
      })
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(new Error(`无法启动后台，请确认 Node.js 22+ 可用：${error.message}`))
      })
      child.once('close', (code, signal) => {
        clearTimeout(timeout)
        owned.exited = true
        if (current === owned) current = undefined
        resolveClosed()
        const error = new Error(owned.stopping ? '后台启动已取消' : `pi-manage 后台已退出（${signal || code}）${owned.stderr.trim() ? `：${owned.stderr.trim()}` : ''}`)
        reject(error)
        // 旧会话关闭后的回调不能再访问失效的 UI 上下文。
        if (owned.url && !owned.stopping && !shuttingDown && generation === version) ctx.ui.notify(error.message, 'error')
      })
    })
    return owned
  }

  async function stopBackend() {
    const owned = current
    if (!owned) return
    if (owned.stop) return owned.stop
    owned.stopping = true
    owned.stop = (async () => {
      // 先请后台自行关闭连接；逾期只终止本扩展持有的子进程，不按端口查杀进程。
      const force = setTimeout(() => { if (!owned.exited) owned.child.kill('SIGKILL') }, 1500)
      let deadline
      try {
        if (owned.child.connected) {
          owned.child.send({ type: 'shutdown' }, (error) => {
            if (error && !owned.exited) owned.child.kill()
          })
        } else if (!owned.exited) {
          owned.child.kill()
        }
        await Promise.race([
          owned.closed,
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('后台未能及时退出，请重试 /pi-manage stop。')), 5000) }),
        ])
      } finally {
        clearTimeout(force)
        clearTimeout(deadline)
        owned.stop = null
      }
    })()
    return owned.stop
  }

  // 发现扩展时只注册能力；用户没有执行命令就不会产生后台或定时器。
  pi.on('session_start', () => { shuttingDown = false })
  pi.on('session_shutdown', async () => {
    shuttingDown = true
    generation++
    await stopBackend()
  })
  pi.registerCommand('pi-manage', {
    description: '打开 pi 配置管理页；start 仅启动，status 查看地址，stop 停止后台',
    getArgumentCompletions: (prefix) => ['open', 'start', 'status', 'stop'].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!ctx.hasUI || shuttingDown) return
      const action = args.trim() || 'open'
      if (!['open', 'start', 'status', 'stop'].includes(action)) {
        ctx.ui.notify('用法：/pi-manage [open|start|status|stop]', 'warning')
        return
      }
      const version = generation
      const active = () => !shuttingDown && generation === version
      try {
        if (action === 'stop') {
          await stopBackend()
          if (active()) ctx.ui.notify('pi-manage 后台已停止', 'info')
          return
        }
        if (action === 'status') {
          ctx.ui.notify(current?.stopping ? 'pi-manage 正在停止' : current?.url || (current ? 'pi-manage 正在启动' : 'pi-manage 尚未启动'), 'info')
          return
        }
        if (current?.stopping) await stopBackend()
        if (!active()) return
        const owned = startBackend(ctx, version)
        const url = await owned.ready
        if (!active() || owned.stopping || owned.exited) return
        ctx.ui.notify(`pi-manage：${url}（退出当前 pi 会话时自动停止）`, 'info')
        if (action === 'open') {
          const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
          const parameters = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
          const result = await pi.exec(command, parameters, { timeout: 5000 })
          if (active() && (result.code !== 0 || result.killed)) ctx.ui.notify(`未能自动打开浏览器，请访问 ${url}`, 'warning')
        }
      } catch (error) {
        if (active()) ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })
}
