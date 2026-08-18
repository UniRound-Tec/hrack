export type ParsedHrackCli =
  | { kind: 'help' }
  | {
      kind: 'request'
      method: string
      params: Record<string, unknown>
      watch?: boolean
    }

const CLI_HEADS = new Set([
  'opencode',
  'sessions',
  'session',
  'help',
  '-h',
  '--help',
  '--hrack-cli'
])

export function extractHrackCliArgv(argv: readonly string[]): string[] | null {
  const hrackFlag = argv.indexOf('--hrack-cli')
  if (hrackFlag >= 0) return argv.slice(hrackFlag + 1).map(String)
  for (let index = 0; index < argv.length; index++) {
    if (CLI_HEADS.has(argv[index])) return argv.slice(index).map(String)
  }
  return null
}

export function isHrackCliInvocation(argv: readonly string[]): boolean {
  const extracted = extractHrackCliArgv(argv)
  return extracted !== null && extracted[0] !== undefined
}

function takeFlag(
  args: string[],
  names: readonly string[]
): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    for (const name of names) {
      if (value === name) {
        const next = args[index + 1]
        args.splice(index, next === undefined ? 1 : 2)
        return next
      }
      if (value.startsWith(`${name}=`)) {
        args.splice(index, 1)
        return value.slice(name.length + 1)
      }
    }
  }
  return undefined
}

function usage(): string {
  return [
    'Usage:',
    '  hrack opencode models [--installation <id>]',
    '  hrack opencode create --workspace <path> --model <provider/model>',
    '                       [--agent plan|build] [--name <title>]',
    '                       [--installation <id>]',
    '  hrack sessions',
    '  hrack session send <sessionId> <text>',
    '  hrack session turn <sessionId>',
    '  hrack session watch <sessionId>',
    '  hrack session close <sessionId>',
    '  hrack session rename <sessionId> <name>',
    '  hrack session mode <sessionId> plan|build',
    '  hrack session approve <sessionId> <requestId> [--remember]',
    '  hrack session deny <sessionId> <requestId>',
    '  hrack session questions <sessionId>',
    '  hrack session answer <sessionId> <requestId> --json <payload>',
    '  hrack session reject-question <sessionId> <requestId>',
    '  hrack session wait <sessionId> --until blocked|turn|exited'
  ].join('\n')
}

function takeBoolFlag(args: string[], names: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (names.includes(value)) {
      args.splice(index, 1)
      return true
    }
  }
  return false
}

export function parseHrackCli(argv: readonly string[]): ParsedHrackCli {
  const args = [...argv]
  if (args[0] === '--hrack-cli') args.shift()
  const head = args.shift()
  if (!head || head === 'help' || head === '-h' || head === '--help') {
    return { kind: 'help' }
  }

  if (head === 'opencode') {
    const command = args.shift()
    if (command === 'models') {
      const installation = takeFlag(args, ['--installation', '-i'])
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'opencode.models',
        params: installation ? { installationId: installation } : {}
      }
    }
    if (command === 'create') {
      const workspace = takeFlag(args, ['--workspace', '-w'])
      const model = takeFlag(args, ['--model', '-m'])
      const agent = takeFlag(args, ['--agent'])
      const name = takeFlag(args, ['--name'])
      const installation = takeFlag(args, ['--installation', '-i'])
      if (!workspace) throw new Error('create requires --workspace')
      if (!model) throw new Error('create requires --model')
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'opencode.create',
        params: {
          workspace,
          model,
          ...(agent ? { agent } : {}),
          ...(name ? { name } : {}),
          ...(installation ? { installationId: installation } : {})
        }
      }
    }
    if (!command || command === 'help') return { kind: 'help' }
    throw new Error(`Unknown opencode command: ${command}\n${usage()}`)
  }

  if (head === 'sessions') {
    if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
    return { kind: 'request', method: 'sessions.list', params: {} }
  }

  if (head === 'session') {
    const command = args.shift()
    if (!command || command === 'help') return { kind: 'help' }
    const sessionId = args.shift()
    if (!sessionId) throw new Error(`session ${command} requires <sessionId>`)
    if (command === 'send') {
      const text = args.join(' ').trim()
      if (!text) throw new Error('session send requires <text>')
      return {
        kind: 'request',
        method: 'session.send',
        params: { sessionId, text }
      }
    }
    if (command === 'turn') {
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.turn',
        params: { sessionId }
      }
    }
    if (command === 'watch') {
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.watch',
        params: { sessionId },
        watch: true
      }
    }
    if (command === 'close' || command === 'stop' || command === 'delete') {
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.close',
        params: { sessionId }
      }
    }
    if (command === 'rename') {
      const name = args.join(' ').trim()
      if (!name) throw new Error('session rename requires <name>')
      return {
        kind: 'request',
        method: 'session.rename',
        params: { sessionId, name }
      }
    }
    if (command === 'mode') {
      const agent = args.shift()
      if (!agent) throw new Error('session mode requires plan or build')
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.mode',
        params: { sessionId, agent }
      }
    }
    if (command === 'approve') {
      const requestId = args.shift()
      if (!requestId) throw new Error('session approve requires <requestId>')
      const remember = takeBoolFlag(args, ['--remember'])
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.approve',
        params: {
          sessionId,
          requestId,
          ...(remember ? { remember: true } : {})
        }
      }
    }
    if (command === 'deny') {
      const requestId = args.shift()
      if (!requestId) throw new Error('session deny requires <requestId>')
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.deny',
        params: { sessionId, requestId }
      }
    }
    if (command === 'questions') {
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.questions',
        params: { sessionId }
      }
    }
    if (command === 'answer') {
      const requestId = args.shift()
      if (!requestId) throw new Error('session answer requires <requestId>')
      const json = takeFlag(args, ['--json'])
      if (!json) throw new Error('session answer requires --json')
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.answer',
        params: { sessionId, requestId, json }
      }
    }
    if (command === 'reject-question') {
      const requestId = args.shift()
      if (!requestId) throw new Error('session reject-question requires <requestId>')
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.reject-question',
        params: { sessionId, requestId }
      }
    }
    if (command === 'wait') {
      const until = takeFlag(args, ['--until'])
      if (!until) throw new Error('session wait requires --until')
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.wait',
        params: { sessionId, until }
      }
    }
    throw new Error(`Unknown session command: ${command}\n${usage()}`)
  }

  throw new Error(`Unknown command: ${head}\n${usage()}`)
}

export function cliUsage(): string {
  return usage()
}
