const enableMouse = '\x1b[?1000h\x1b[?1006h'
const disableMouse = '\x1b[?1000l\x1b[?1006l'

let received = Buffer.alloc(0)
let finished = false

function finish(message, code) {
  if (finished) return
  finished = true
  process.stdout.write(`${disableMouse}\r\n${message}\r\n`)
  process.exit(code)
}

process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdout.write(`${enableMouse}\x1b[2J\x1b[HCLICK_INSIDE_TUI`)

process.stdin.on('data', (chunk) => {
  received = Buffer.concat([received, chunk])
  const text = received.toString('latin1')
  const report = text.match(/\x1b\[<\d+;\d+;\d+[Mm]/)?.[0]
  if (report) {
    finish(`MOUSE_REPORT_OK:${Buffer.from(report, 'latin1').toString('hex')}`, 0)
  }
})

setTimeout(() => finish('MOUSE_REPORT_TIMEOUT', 1), 8_000).unref()
