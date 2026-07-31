import { EventEmitter } from 'node:events'
import { expect, test } from '@playwright/test'
import { installPtyErrorGuard } from '../electron/pty/PtyErrorGuard'

test('prevents node-pty from throwing a terminal-scoped socket error into the main process', () => {
  const inputSocket = new EventEmitter()
  const pty = Object.assign(new EventEmitter(), {
    _agent: { inSocket: inputSocket }
  })
  const socketError = Object.assign(new Error('write EAGAIN'), {
    code: 'EAGAIN'
  })
  const nodePtyWouldThrow = (): void => {
    // node-pty 1.1.0 WindowsTerminal uses this exact listener-count contract.
    if (pty.listeners('error').length < 2) throw socketError
  }

  expect(nodePtyWouldThrow).toThrow('write EAGAIN')

  installPtyErrorGuard(pty)
  installPtyErrorGuard(pty)

  expect(pty.listeners('error')).toHaveLength(2)
  expect(inputSocket.listeners('error')).toHaveLength(1)
  expect(nodePtyWouldThrow).not.toThrow()
  expect(() => pty.emit('error', socketError)).not.toThrow()
  expect(() => inputSocket.emit('error', socketError)).not.toThrow()
})
