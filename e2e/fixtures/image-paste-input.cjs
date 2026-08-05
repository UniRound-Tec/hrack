if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  process.stdout.write('IMAGE_PASTE_NO_TTY\r\n')
  process.exit(2)
}

process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('IMAGE_PASTE_READY\r\n')
process.stdin.once('data', (chunk) => {
  process.stdout.write(`INPUT_HEX:${Buffer.from(chunk).toString('hex')}\r\n`)
  process.stdin.setRawMode(false)
  process.exit(0)
})
