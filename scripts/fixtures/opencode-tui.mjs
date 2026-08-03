// Deterministic raw-mode TUI used by the default E2E gate. It exercises the
// same alternate-buffer and Ctrl+C path as OpenCode without requiring a local
// installation, login, provider, or network connection.

const { stdin, stdout } = process
let input = ''
let finished = false

function finish() {
  if (finished) return
  finished = true
  if (stdin.isTTY) stdin.setRawMode(false)
  stdout.write('\x1b[?1049l', () => process.exit(0))
}

process.on('SIGINT', finish)
process.on('SIGTERM', finish)

if (!stdin.isTTY) {
  process.stderr.write('fixture requires a TTY\n')
  process.exit(1)
}

stdin.setRawMode(true)
stdin.resume()
stdin.on('data', (chunk) => {
  const text = chunk.toString('utf8')
  if (text.includes('\x03')) {
    finish()
    return
  }

  for (const character of text) {
    if (character === '\r' || character === '\n') {
      if (input.length > 0) {
        stdout.write(`\r\nFixture reply complete: ${input}\r\n\r\nAsk anything`)
        input = ''
      }
      continue
    }
    if (character === '\x7f' || character === '\b') {
      input = input.slice(0, -1)
      continue
    }
    if (character >= ' ') input += character
  }
})

stdout.write('\x1b[?1049h\x1b[2J\x1b[HOpenCode fixture\r\n\r\nAsk anything')
