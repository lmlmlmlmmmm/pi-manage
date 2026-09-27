// 模拟 pi 被强制结束：测试只终止父进程，后台必须自行检测 IPC 断开。
import { fork } from 'node:child_process'

const backend = fork(process.argv[2], [], {
  execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
})
backend.on('message', (message) => {
  if (message?.type === 'ready' && process.connected) process.send({ ...message, pid: backend.pid })
})
backend.on('error', (error) => { console.error(error.message); process.exit(1) })
backend.on('exit', (code) => process.exit(code ?? 0))
process.on('disconnect', () => process.exit(0))
