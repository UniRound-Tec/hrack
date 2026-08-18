import { createConnection } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const userData = process.env.HRACK_USER_DATA_DIR
  ?? join(process.env.APPDATA ?? '', 'HRack Dev')
const token = (process.env.HRACK_BRIDGE_TOKEN
  ?? readFileSync(join(userData, 'bridge.token'), 'utf8')).trim()
const socketPath = process.env.HRACK_BRIDGE_SOCKET
  ?? `\\\\.\\pipe\\hrack-bridge-${process.env.USERNAME ?? 'user'}`
const method = process.argv[2]
if (!method) {
  console.error('usage: node scripts/hrack-bridge-client.mjs <method> [json-params]')
  process.exit(1)
}
const rawParams = process.argv[3]
const params = !rawParams
  ? {}
  : rawParams.startsWith('@')
    ? JSON.parse(readFileSync(rawParams.slice(1), 'utf8'))
    : JSON.parse(rawParams)
const request = { id: `live-${Date.now()}`, token, method, params }

const socket = createConnection(socketPath)
let buffer = ''
socket.setEncoding('utf8')
socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
socket.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) console.log(line)
    newline = buffer.indexOf('\n')
    if (method !== 'session.watch') {
      socket.end()
    }
  }
})
socket.on('error', (error) => {
  console.error(error.message)
  process.exit(2)
})
socket.on('close', () => process.exit(0))
setTimeout(() => {
  console.error('client timeout')
  process.exit(3)
}, Number(process.env.HRACK_CLIENT_TIMEOUT_MS ?? 60_000))
