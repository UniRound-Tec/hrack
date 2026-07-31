export interface PtyErrorEmitter {
  on(event: 'error', listener: (error: unknown) => void): unknown
  listeners(event: 'error'): Function[]
  _agent?: {
    inSocket?: PtyErrorEmitter
  }
}

const guardedPtys = new WeakSet<object>()

/**
 * node-pty 1.1.0 的 WindowsTerminal 会先关闭出错 socket，然后在 PTY 对象的
 * error listener 少于 2 个时把非 EIO socket error 直接 throw 到主进程。
 * 终端级管道错误应只结束该会话，不能终止整个 Electron 应用。
 */
export function installPtyErrorGuard(pty: PtyErrorEmitter): void {
  if (guardedPtys.has(pty)) return

  const ignoreTerminalScopedError = (_error: unknown): void => {}
  while (pty.listeners('error').length < 2) {
    pty.on('error', ignoreTerminalScopedError)
  }
  const inputSocket = pty._agent?.inSocket
  if (inputSocket && inputSocket.listeners('error').length === 0) {
    // pty.write() 通过该 socket 异步完成；子进程快速退出时 Windows 会发 EAGAIN。
    inputSocket.on('error', ignoreTerminalScopedError)
  }
  guardedPtys.add(pty)
}
