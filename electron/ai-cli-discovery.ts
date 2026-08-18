import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, join } from 'node:path'
import type {
  CliInstallation,
  CliLaunchSelection,
  CliRuntime,
  CliRuntimeError,
  CliScanReport,
  LaunchableCli,
  SpawnOptions
} from '../shared/ipc-contract'
import { parseWslUncPath } from './directory-picker'

const COMMAND_TIMEOUT_MS = 2_500
const COMMAND_MAX_BUFFER = 64 * 1024
const SCAN_CONCURRENCY = 4
const CLI_SCAN_CACHE_VERSION = 6
export const DSH_CLI_DEFINITION_ID = 'dsh'
/** Sample version-like string for probe tests; discovery does not pin DSH. */
export const DSH_COMPATIBLE_VERSION = '0.1.0-rc.6'
const SYSTEM_WSL_DISTROS = new Set([
  'docker-desktop',
  'docker-desktop-data',
  'podman-machine-default'
])

interface CliProbe {
  args: string[]
  outputPattern: RegExp
  acceptedExitCodes?: number[]
  timeoutMs?: number
}

export interface CliDefinition {
  id: string
  adapterId: string
  displayName: string
  hint: string
  iconId: string
  /** 完整 Observer Adapter 已落地；启动列表优先展示。 */
  observerImplemented?: boolean
  executables: { windows?: string[]; unix?: string[] }
  identityProbe?: CliProbe
  /** Windows npm shim may not support the same identity command as Unix. */
  skipWindowsIdentityProbe?: boolean
  probes: CliProbe[]
  knownPaths?: { windows?: string[]; unixHomeRelative?: string[] }
  launchArgs?: string[]
  /** false 时参与发现与缓存，但不作为普通终端 CLI 卡片展示。 */
  exposeInLauncher?: boolean
  /** false 时不把 /mnt/<drive>/ 下的 Windows shim 当成 WSL 安装。 */
  allowWslWindowsInterop?: boolean
}

const versionLike = /(?:\bv?\d+\.\d+(?:\.\d+)?\b)/i
const brandedOrVersion = (brand: RegExp): RegExp =>
  new RegExp(`(?:${brand.source}|${versionLike.source})`, 'i')

const versionProbe = (brand: RegExp): CliProbe => ({
  args: ['--version'],
  outputPattern: brandedOrVersion(brand)
})

/** Product facts only. Installation state always comes from the scanner. */
export const cliDefinitions: readonly CliDefinition[] = [
  {
    id: DSH_CLI_DEFINITION_ID,
    adapterId: 'dsh',
    displayName: 'DeepSeek Harness',
    hint: 'DeepSeek Harness Web agent',
    iconId: 'dsh',
    observerImplemented: true,
    exposeInLauncher: false,
    allowWslWindowsInterop: false,
    executables: { windows: ['dsh'], unix: ['dsh'] },
    probes: [{
      args: ['--version'],
      // 版本如实上报、发现阶段不设版本卡点：真正的兼容性由 host 启动后
      // 的控制面能力门禁（session.list / workspace.list RPC）兜底。
      outputPattern: versionLike
    }],
    knownPaths: {
      windows: ['%APPDATA%\\npm\\dsh.cmd'],
      unixHomeRelative: ['.local/bin/dsh']
    }
  },
  {
    id: 'claude', adapterId: 'claude-code', displayName: 'Claude Code',
    hint: 'Anthropic coding agent', iconId: 'claude-code',
    observerImplemented: true,
    executables: { windows: ['claude'], unix: ['claude'] },
    probes: [versionProbe(/claude(?: code)?/i)],
    knownPaths: {
      windows: ['%USERPROFILE%\\.local\\bin\\claude.exe'],
      unixHomeRelative: ['.local/bin/claude']
    }
  },
  {
    id: 'codex', adapterId: 'codex', displayName: 'Codex',
    hint: 'OpenAI coding agent', iconId: 'codex',
    observerImplemented: true,
    executables: { windows: ['codex'], unix: ['codex'] },
    probes: [versionProbe(/codex(?:-cli)?/i)],
    knownPaths: {
      windows: [
        '%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin\\codex.exe',
        '%USERPROFILE%\\.codex\\packages\\standalone\\current\\bin\\codex.exe'
      ],
      unixHomeRelative: ['.local/bin/codex', '.codex/packages/standalone/current/bin/codex']
    }
  },
  {
    id: 'antigravity', adapterId: 'antigravity', displayName: 'Antigravity CLI',
    hint: 'Google agentic CLI', iconId: 'antigravity',
    executables: { windows: ['agy'], unix: ['agy'] },
    probes: [versionProbe(/(?:antigravity|agy)/i)],
    knownPaths: {
      windows: ['%LOCALAPPDATA%\\agy\\bin\\agy.exe'],
      unixHomeRelative: ['.local/bin/agy']
    }
  },
  {
    id: 'opencode', adapterId: 'opencode', displayName: 'OpenCode',
    hint: 'Open-source coding agent', iconId: 'opencode',
    observerImplemented: true,
    executables: { windows: ['opencode'], unix: ['opencode'] },
    probes: [versionProbe(/opencode/i)],
    knownPaths: {
      windows: ['%USERPROFILE%\\.opencode\\bin\\opencode.exe'],
      unixHomeRelative: ['.opencode/bin/opencode']
    }
  },
  {
    id: 'cursor', adapterId: 'cursor-agent', displayName: 'Cursor Agent',
    hint: 'Cursor terminal agent', iconId: 'cursor-agent',
    executables: { windows: ['cursor-agent', 'agent'], unix: ['cursor-agent', 'agent'] },
    probes: [{ args: ['--version'], outputPattern: /cursor/i }]
  },
  {
    id: 'cline', adapterId: 'cline', displayName: 'Cline',
    hint: 'Cline terminal agent', iconId: 'cline',
    executables: { windows: ['cline'], unix: ['cline'] },
    probes: [versionProbe(/cline/i)]
  },
  {
    id: 'qwen', adapterId: 'qwen', displayName: 'Qwen Code',
    hint: 'Qwen coding agent', iconId: 'qwen',
    executables: { windows: ['qwen'], unix: ['qwen'] },
    probes: [versionProbe(/qwen/i)]
  },
  {
    id: 'amp', adapterId: 'amp', displayName: 'Amp',
    hint: 'Amp coding agent', iconId: 'amp',
    executables: { windows: ['amp'], unix: ['amp'] },
    probes: [versionProbe(/amp/i)]
  },
  {
    id: 'kimi', adapterId: 'kimi', displayName: 'Kimi Code',
    hint: 'Moonshot AI coding agent', iconId: 'kimi',
    observerImplemented: true,
    executables: { windows: ['kimi'], unix: ['kimi'] },
    probes: [versionProbe(/kimi/i)],
    knownPaths: {
      windows: ['%USERPROFILE%\\.kimi-code\\bin\\kimi.exe'],
      unixHomeRelative: ['.kimi-code/bin/kimi']
    }
  },
  {
    id: 'grok', adapterId: 'grok', displayName: 'Grok Build',
    hint: 'xAI coding agent', iconId: 'grok',
    executables: { windows: ['grok'], unix: ['grok'] },
    probes: [{ args: ['--version'], outputPattern: /grok/i }],
    knownPaths: {
      windows: ['%USERPROFILE%\\.grok\\bin\\grok.exe'],
      unixHomeRelative: ['.local/bin/grok', '.grok/bin/grok']
    }
  },
  {
    id: 'pi', adapterId: 'pi', displayName: 'Pi',
    hint: 'Minimal coding agent', iconId: 'pi',
    observerImplemented: true,
    executables: { windows: ['pi'], unix: ['pi'] },
    identityProbe: {
      args: ['--help'],
      outputPattern: /pi\s+-\s+AI coding assistant/i,
      timeoutMs: 5_000
    },
    skipWindowsIdentityProbe: true,
    probes: [
      {
        ...versionProbe(/pi(?: coding)?/i),
        timeoutMs: 5_000
      }
    ],
    knownPaths: {
      windows: ['%APPDATA%\\npm\\pi.cmd'],
      unixHomeRelative: ['.local/bin/pi']
    }
  },
  {
    id: 'copilot', adapterId: 'copilot', displayName: 'GitHub Copilot CLI',
    hint: 'GitHub terminal agent', iconId: 'copilot',
    executables: { windows: ['copilot'], unix: ['copilot'] },
    probes: [versionProbe(/copilot/i)]
  },
  {
    id: 'goose', adapterId: 'goose', displayName: 'Goose',
    hint: 'AAIF local agent', iconId: 'goose',
    executables: { windows: ['goose'], unix: ['goose'] },
    probes: [versionProbe(/goose/i)]
  },
  {
    id: 'crush', adapterId: 'crush', displayName: 'Crush',
    hint: 'Charm coding agent', iconId: 'crush',
    executables: { windows: ['crush'], unix: ['crush'] },
    probes: [versionProbe(/crush/i)]
  },
  {
    id: 'oz', adapterId: 'warp-agent', displayName: 'Warp / Oz',
    hint: 'Warp local agent runner', iconId: 'warp-agent',
    executables: { windows: ['oz', 'oz-preview'], unix: ['oz', 'oz-preview'] },
    probes: [versionProbe(/(?:warp|oz)/i)]
  },
  {
    id: 'devin', adapterId: 'devin', displayName: 'Devin CLI',
    hint: 'Cognition terminal agent', iconId: 'devin',
    executables: { windows: ['devin'], unix: ['devin'] },
    probes: [versionProbe(/devin/i)]
  },
  {
    id: 'kiro', adapterId: 'kiro', displayName: 'Kiro CLI',
    hint: 'AWS terminal agent', iconId: 'kiro',
    executables: { windows: ['kiro-cli'], unix: ['kiro-cli'] },
    probes: [versionProbe(/kiro/i)]
  },
  {
    id: 'aider', adapterId: 'aider', displayName: 'Aider',
    hint: 'Pair programming CLI', iconId: 'aider',
    executables: { windows: ['aider'], unix: ['aider'] },
    probes: [versionProbe(/aider/i)]
  },
  {
    id: 'factory-droid', adapterId: 'factory-droid', displayName: 'Factory Droid',
    hint: 'Factory coding agent', iconId: 'factory-droid',
    executables: { windows: ['droid'], unix: ['droid'] },
    identityProbe: { args: ['--help'], outputPattern: /(?:factory|droid CLI)/i },
    probes: [{ args: ['-v'], outputPattern: brandedOrVersion(/(?:factory|droid)/i) }],
    knownPaths: {
      windows: ['%USERPROFILE%\\.local\\bin\\droid.exe'],
      unixHomeRelative: ['.local/bin/droid']
    }
  },
  {
    id: 'auggie', adapterId: 'auggie', displayName: 'Auggie',
    hint: 'Augment Code terminal agent', iconId: 'auggie',
    executables: { unix: ['auggie'] },
    probes: [versionProbe(/(?:auggie|augment)/i)]
  },
  {
    id: 'mistral-vibe', adapterId: 'mistral-vibe', displayName: 'Mistral Vibe',
    hint: 'Mistral coding agent', iconId: 'mistral-vibe',
    executables: { windows: ['vibe'], unix: ['vibe'] },
    probes: [versionProbe(/(?:mistral|vibe)/i)],
    knownPaths: { unixHomeRelative: ['.local/bin/vibe'] }
  },
  {
    id: 'junie', adapterId: 'junie', displayName: 'Junie',
    hint: 'JetBrains coding agent', iconId: 'junie',
    executables: { windows: ['junie'], unix: ['junie'] },
    probes: [versionProbe(/junie/i)],
    knownPaths: { unixHomeRelative: ['.local/bin/junie'] }
  },
  {
    id: 'qoder', adapterId: 'qoder', displayName: 'Qoder CLI',
    hint: 'Qoder terminal agent', iconId: 'qoder',
    executables: { windows: ['qodercli'], unix: ['qodercli'] },
    probes: [versionProbe(/qoder/i)],
    knownPaths: { unixHomeRelative: ['.local/bin/qodercli'] }
  },
  {
    id: 'codebuddy-code', adapterId: 'codebuddy-code', displayName: 'CodeBuddy Code',
    hint: 'Tencent coding agent', iconId: 'codebuddy-code',
    executables: { windows: ['codebuddy', 'cbc'], unix: ['codebuddy', 'cbc'] },
    probes: [versionProbe(/(?:codebuddy|tencent)/i)],
    knownPaths: {
      windows: ['%LOCALAPPDATA%\\codebuddy\\bin\\codebuddy.exe'],
      unixHomeRelative: ['.local/bin/codebuddy']
    }
  },
  {
    id: 'kilo', adapterId: 'kilo', displayName: 'Kilo Code',
    hint: 'Kilo coding agent', iconId: 'kilo',
    executables: { windows: ['kilo'], unix: ['kilo'] },
    probes: [versionProbe(/kilo/i)],
    knownPaths: { unixHomeRelative: ['.local/bin/kilo'] }
  },
  {
    id: 'trae-agent', adapterId: 'trae-agent', displayName: 'Trae Agent',
    hint: 'ByteDance software engineering agent', iconId: 'trae-agent',
    executables: { windows: ['trae-cli'], unix: ['trae-cli'] },
    probes: [{ args: ['--help'], outputPattern: /trae(?: agent|-cli)/i }],
    knownPaths: { unixHomeRelative: ['.local/bin/trae-cli'] },
    launchArgs: ['interactive']
  }
] as const

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function decodeOutput(value: Buffer): string {
  if (value.length >= 2 && value[1] === 0) return value.toString('utf16le')
  return value.toString('utf8')
}

function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function isWindowsShim(path: string): boolean {
  return ['.cmd', '.bat'].includes(extname(path).toLowerCase())
}

function runCommand(
  file: string,
  args: readonly string[],
  timeout = COMMAND_TIMEOUT_MS
): Promise<CommandResult> {
  const command = process.platform === 'win32' && isWindowsShim(file)
    ? {
        file: process.env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/v:off', '/c', `call ${[file, ...args].map(quoteCmdArg).join(' ')}`],
        windowsVerbatimArguments: true
      }
    : { file, args: [...args], windowsVerbatimArguments: false }

  return new Promise((resolve) => {
    execFile(
      command.file,
      command.args,
      {
        encoding: 'buffer',
        timeout,
        maxBuffer: COMMAND_MAX_BUFFER,
        windowsHide: true,
        windowsVerbatimArguments: command.windowsVerbatimArguments
      },
      (error, stdout, stderr) => {
        const failure = error as NodeJS.ErrnoException & {
          code?: string | number
          killed?: boolean
        } | null
        resolve({
          code:
            typeof failure?.code === 'number'
              ? failure.code
              : error
                ? null
                : 0,
          stdout: decodeOutput(stdout as Buffer),
          stderr: decodeOutput(stderr as Buffer),
          timedOut: Boolean(failure?.killed)
        })
      }
    )
  })
}

async function mapLimit<T, U>(
  values: readonly T[],
  limit: number,
  task: (value: T) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(values.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await task(values[index])
    }
  })
  await Promise.all(workers)
  return results
}

function runtimeKey(runtime: CliRuntime): string {
  return runtime.kind === 'wsl'
    ? `wsl:${runtime.distro}`
    : `host:${runtime.platform}`
}

function installationId(
  definitionId: string,
  runtime: CliRuntime,
  path: string
): string {
  const digest = createHash('sha256')
    .update(`${definitionId}\0${runtimeKey(runtime)}\0${path.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16)
  return `${definitionId}:${digest}`
}

function versionText(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 200) ?? ''
}

async function verifyHost(
  definition: CliDefinition,
  path: string
): Promise<{ version?: string; timedOut: boolean } | null> {
  if (
    definition.identityProbe &&
    !(process.platform === 'win32' && definition.skipWindowsIdentityProbe)
  ) {
    const identity = await runCommand(
      path,
      definition.identityProbe.args,
      definition.identityProbe.timeoutMs
    )
    const accepted = definition.identityProbe.acceptedExitCodes ?? [0]
    const output = `${identity.stdout}\n${identity.stderr}`
    if (identity.timedOut) return { timedOut: true }
    if (
      identity.code === null ||
      !accepted.includes(identity.code) ||
      !definition.identityProbe.outputPattern.test(output)
    ) return null
  }
  for (const probe of definition.probes) {
    const result = await runCommand(path, probe.args, probe.timeoutMs)
    const output = `${result.stdout}\n${result.stderr}`
    const accepted = probe.acceptedExitCodes ?? [0]
    if (result.code !== null && accepted.includes(result.code) && probe.outputPattern.test(output)) {
      return { version: versionText(result.stdout, result.stderr), timedOut: false }
    }
    if (result.timedOut) return { timedOut: true }
  }
  return null
}

function expandWindowsPath(template: string): string | null {
  const expanded = template.replace(/%([^%]+)%/g, (_match, name: string) =>
    process.env[name] ?? process.env[name.toUpperCase()] ?? ''
  )
  return expanded.includes('%') || !expanded ? null : expanded
}

async function isExecutableFile(path: string, requireExecute = false): Promise<boolean> {
  try {
    await access(path, requireExecute ? fsConstants.X_OK : fsConstants.F_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function windowsExecutables(paths: string): string[] {
  return paths
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter((path) => ['.exe', '.com', '.cmd', '.bat'].includes(extname(path).toLowerCase()))
}

async function resolveWindowsCandidates(
  definition: CliDefinition
): Promise<ResolvedCandidate[]> {
  const fromPath: ResolvedCandidate[] = []
  for (const executable of definition.executables.windows ?? []) {
    const result = await runCommand('where.exe', [executable])
    if (result.code === 0) {
      for (const path of windowsExecutables(result.stdout)) {
        fromPath.push({ path, via: 'path' })
      }
    }
  }
  const knownPaths = (definition.knownPaths?.windows ?? [])
    .map(expandWindowsPath)
    .filter((path): path is string => Boolean(path))
  const known: ResolvedCandidate[] = []
  for (const path of knownPaths) {
    if (await isExecutableFile(path)) known.push({ path, via: 'known-path' })
  }
  return dedupeCandidates([...fromPath, ...known])
}

async function scanWindowsDefinition(
  definition: CliDefinition,
  errors: CliRuntimeError[]
): Promise<CliInstallation | null> {
  const runtime: CliRuntime = { kind: 'host', platform: 'windows' }
  const candidates = await resolveWindowsCandidates(definition)
  if (candidates.length === 0) return null
  let timedOut = false
  for (const resolved of candidates) {
    const verified = await verifyHost(definition, resolved.path)
    if (!verified) continue
    if (verified.timedOut) {
      timedOut = true
      continue
    }
    return {
      id: installationId(definition.id, runtime, resolved.path),
      definitionId: definition.id,
      runtime,
      resolvedExecutable: resolved.path,
      detectedVia: resolved.via,
      version: verified.version,
      verification: 'verified'
    }
  }
  errors.push({
    runtime,
    definitionId: definition.id,
    code: timedOut ? 'timeout' : 'probe-failed',
    detail: `${definition.displayName}: ${candidates.map((candidate) => candidate.path).join(', ')}`
  })
  return null
}

async function runWsl(
  distro: string,
  executable: string,
  args: readonly string[],
  timeout = 8_000
): Promise<CommandResult> {
  return runCommand('wsl.exe', [
    '--distribution', distro,
    '--exec', executable,
    ...args
  ], timeout)
}

async function wslUserEnvironment(
  distro: string
): Promise<{ home: string; shell: string; path: string } | null> {
  const result = await runWsl(distro, 'sh', [
    '-lc', 'printf "%s\\n%s\\n" "$HOME" "${SHELL:-/bin/sh}"'
  ])
  if (result.code !== 0) return null
  const [home, shell] = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
  if (!home || !shell) return null
  const pathResult = await runWsl(distro, shell, [
    '-lic', 'printf "%s\\n" "$PATH"'
  ])
  const path = pathResult.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .reverse()
    .find((value) => value.startsWith('/') && value.includes(':'))
  return pathResult.code === 0 && path ? { home, shell, path } : null
}

interface ResolvedCandidate {
  path: string
  via: 'path' | 'known-path'
}

interface WslCandidateInventory {
  byExecutable: Map<string, ResolvedCandidate[]>
  knownPaths: Set<string>
}

function isWslWindowsMount(path: string): boolean {
  return /^\/mnt\/[a-z](?:\/|$)/i.test(path)
}

function dedupeCandidates(candidates: readonly ResolvedCandidate[]): ResolvedCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false
    seen.add(candidate.path)
    return true
  })
}

const WSL_KNOWN_PATHS_SEPARATOR = '--hrack-known-paths--'
const WSL_CANDIDATE_SCAN_SCRIPT = [
  'path_value=$1',
  'shift',
  'export PATH="$path_value"',
  `while [ "$#" -gt 0 ] && [ "$1" != "${WSL_KNOWN_PATHS_SEPARATOR}" ]; do`,
  '  executable=$1',
  '  shift',
  '  resolved=$(command -v -- "$executable" 2>/dev/null || true)',
  '  case "$resolved" in',
  "    /*) printf 'P\\t%s\\t%s\\n' \"$executable\" \"$resolved\" ;;",
  '  esac',
  'done',
  'if [ "$#" -gt 0 ]; then shift; fi',
  'for candidate in "$@"; do',
  "  if [ -x \"$candidate\" ]; then printf 'K\\t%s\\n' \"$candidate\"; fi",
  'done'
].join('\n')

function wslFallbackExecutablePaths(home: string, executable: string): string[] {
  return [
    `${home}/.local/bin/${executable}`,
    `${home}/bin/${executable}`,
    `/usr/local/bin/${executable}`,
    `/usr/bin/${executable}`,
    `/bin/${executable}`
  ]
}

async function scanWslCandidateInventory(
  distro: string,
  home: string,
  environmentPath: string
): Promise<WslCandidateInventory | null> {
  const executables = [...new Set(
    cliDefinitions.flatMap((definition) => definition.executables.unix ?? [])
  )]
  const knownPaths = [...new Set([
    ...cliDefinitions.flatMap((definition) =>
      (definition.knownPaths?.unixHomeRelative ?? []).map((relative) =>
        join(home, ...relative.split('/')).replace(/\\/g, '/')
      )
    ),
    ...executables.flatMap((executable) =>
      wslFallbackExecutablePaths(home, executable)
    )
  ])]
  const result = await runWsl(distro, 'sh', [
    '-c',
    WSL_CANDIDATE_SCAN_SCRIPT,
    'hrack-candidate-scan',
    environmentPath,
    ...executables,
    WSL_KNOWN_PATHS_SEPARATOR,
    ...knownPaths
  ])
  if (result.code !== 0 || result.timedOut) return null

  const inventory: WslCandidateInventory = {
    byExecutable: new Map(),
    knownPaths: new Set()
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    const [kind, key, path] = line.split('\t')
    if (kind === 'P' && key && path?.startsWith('/')) {
      const candidates = inventory.byExecutable.get(key) ?? []
      candidates.push({ path, via: 'path' })
      inventory.byExecutable.set(key, candidates)
    } else if (kind === 'K' && key?.startsWith('/')) {
      inventory.knownPaths.add(key)
    }
  }
  return inventory
}

function resolveWslCandidates(
  definition: CliDefinition,
  home: string,
  inventory: WslCandidateInventory
): ResolvedCandidate[] {
  const nativePath: ResolvedCandidate[] = []
  const interopPath: ResolvedCandidate[] = []
  for (const executable of definition.executables.unix ?? []) {
    for (const candidate of inventory.byExecutable.get(executable) ?? []) {
      if (isWslWindowsMount(candidate.path)) {
        if (definition.allowWslWindowsInterop !== false) {
          interopPath.push(candidate)
        }
      } else {
        nativePath.push(candidate)
      }
    }
    for (const path of wslFallbackExecutablePaths(home, executable)) {
      if (inventory.knownPaths.has(path)) nativePath.push({ path, via: 'path' })
    }
  }
  const knownPath: ResolvedCandidate[] = []
  for (const relative of definition.knownPaths?.unixHomeRelative ?? []) {
    const path = join(home, ...relative.split('/')).replace(/\\/g, '/')
    if (inventory.knownPaths.has(path)) knownPath.push({ path, via: 'known-path' })
  }
  return dedupeCandidates([...nativePath, ...knownPath, ...interopPath])
}

interface NativeUserEnvironment {
  home: string
  pathDirectories: string[]
}

function splitPathDirectories(value: string | undefined): string[] {
  return (value ?? '')
    .split(delimiter)
    .map((path) => path.trim())
    .filter(Boolean)
}

async function nativeUserEnvironment(): Promise<NativeUserEnvironment> {
  const home = homedir()
  const shellCandidates = [
    process.env.SHELL,
    process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
    '/bin/sh'
  ].filter((shell, index, values): shell is string =>
    Boolean(shell) && values.indexOf(shell) === index
  )
  let loginPath = ''
  for (const shell of shellCandidates) {
    const result = await runCommand(shell, ['-lic', 'env'])
    if (result.code !== 0) continue
    const value = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith('PATH='))
      ?.slice('PATH='.length)
    if (value) {
      loginPath = value
      break
    }
  }
  const commonDirectories = [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ]
  return {
    home,
    pathDirectories: [...new Set([
      ...splitPathDirectories(loginPath),
      ...splitPathDirectories(process.env.PATH),
      ...commonDirectories
    ])]
  }
}

async function resolveNativeCandidates(
  definition: CliDefinition,
  environment: NativeUserEnvironment
): Promise<ResolvedCandidate[]> {
  const fromPath: ResolvedCandidate[] = []
  for (const executable of definition.executables.unix ?? []) {
    for (const directory of environment.pathDirectories) {
      const path = join(directory, executable)
      if (await isExecutableFile(path, true)) fromPath.push({ path, via: 'path' })
    }
  }
  const known: ResolvedCandidate[] = []
  for (const relative of definition.knownPaths?.unixHomeRelative ?? []) {
    const path = join(environment.home, ...relative.split('/'))
    if (await isExecutableFile(path, true)) known.push({ path, via: 'known-path' })
  }
  return dedupeCandidates([...fromPath, ...known])
}

async function scanNativeDefinition(
  definition: CliDefinition,
  runtime: Extract<CliRuntime, { kind: 'host' }>,
  environment: NativeUserEnvironment,
  errors: CliRuntimeError[]
): Promise<CliInstallation | null> {
  const candidates = await resolveNativeCandidates(definition, environment)
  if (candidates.length === 0) return null
  let timedOut = false
  for (const resolved of candidates) {
    const verified = await verifyHost(definition, resolved.path)
    if (!verified) continue
    if (verified.timedOut) {
      timedOut = true
      continue
    }
    return {
      id: installationId(definition.id, runtime, resolved.path),
      definitionId: definition.id,
      runtime,
      resolvedExecutable: resolved.path,
      detectedVia: resolved.via,
      version: verified.version,
      verification: 'verified'
    }
  }
  errors.push({
    runtime,
    definitionId: definition.id,
    code: timedOut ? 'timeout' : 'probe-failed',
    detail: `${definition.displayName}: ${candidates.map((candidate) => candidate.path).join(', ')}`
  })
  return null
}

async function verifyWsl(
  definition: CliDefinition,
  distro: string,
  path: string,
  environmentPath: string
): Promise<{ version?: string; timedOut: boolean } | null> {
  if (definition.identityProbe) {
    const identity = await runWsl(distro, 'env', [
      `PATH=${environmentPath}`,
      path,
      ...definition.identityProbe.args
    ])
    const accepted = definition.identityProbe.acceptedExitCodes ?? [0]
    const output = `${identity.stdout}\n${identity.stderr}`
    if (identity.timedOut) return { timedOut: true }
    if (
      identity.code === null ||
      !accepted.includes(identity.code) ||
      !definition.identityProbe.outputPattern.test(output)
    ) return null
  }
  for (const probe of definition.probes) {
    const result = await runWsl(distro, 'env', [
      `PATH=${environmentPath}`,
      path,
      ...probe.args
    ])
    const output = `${result.stdout}\n${result.stderr}`
    const accepted = probe.acceptedExitCodes ?? [0]
    if (result.code !== null && accepted.includes(result.code) && probe.outputPattern.test(output)) {
      return { version: versionText(result.stdout, result.stderr), timedOut: false }
    }
    if (result.timedOut) return { timedOut: true }
  }
  return null
}

async function listWslDistros(): Promise<{ distros: string[]; error?: CliRuntimeError }> {
  const runtime: CliRuntime = { kind: 'host', platform: 'windows' }
  const result = await runCommand('wsl.exe', ['--list', '--quiet'])
  if (result.code !== 0) {
    return {
      distros: [],
      error: { runtime, code: 'unavailable', detail: 'WSL is unavailable' }
    }
  }
  const distros = result.stdout
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter((name) => name && !SYSTEM_WSL_DISTROS.has(name.toLowerCase()))
  return { distros: [...new Set(distros)] }
}

async function scanWslDistro(
  distro: string,
  errors: CliRuntimeError[],
  environmentPaths: Map<string, string>,
  homes: Map<string, string>
): Promise<CliInstallation[]> {
  const runtime: CliRuntime = { kind: 'wsl', distro }
  const environment = await wslUserEnvironment(distro)
  if (!environment) {
    errors.push({ runtime, code: 'unavailable', detail: `${distro}: unable to resolve HOME` })
    return []
  }
  environmentPaths.set(distro, environment.path)
  homes.set(distro, environment.home)
  const inventory = await scanWslCandidateInventory(
    distro,
    environment.home,
    environment.path
  )
  if (!inventory) {
    errors.push({
      runtime,
      code: 'unavailable',
      detail: `${distro}: unable to scan executable paths`
    })
    return []
  }
  const found = await mapLimit(cliDefinitions, SCAN_CONCURRENCY, async (definition): Promise<CliInstallation | null> => {
    const candidates = resolveWslCandidates(
      definition,
      environment.home,
      inventory
    )
    if (candidates.length === 0) return null
    let timedOut = false
    for (const resolved of candidates) {
      const verified = await verifyWsl(
        definition,
        distro,
        resolved.path,
        environment.path
      )
      if (!verified) continue
      if (verified.timedOut) {
        timedOut = true
        continue
      }
      return {
        id: installationId(definition.id, runtime, resolved.path),
        definitionId: definition.id,
        runtime,
        resolvedExecutable: resolved.path,
        detectedVia: resolved.via,
        version: verified.version,
        verification: 'verified'
      } satisfies CliInstallation
    }
    {
      errors.push({
        runtime,
        definitionId: definition.id,
        code: timedOut ? 'timeout' : 'probe-failed',
        detail: `${definition.displayName}: ${candidates.map((candidate) => candidate.path).join(', ')}`
      })
      return null
    }
  })
  return found.filter((value): value is CliInstallation => Boolean(value))
}

function groupLaunchable(installations: readonly CliInstallation[]): LaunchableCli[] {
  const prioritizedDefinitions = [
    ...cliDefinitions.filter(
      (definition) =>
        definition.exposeInLauncher !== false && definition.observerImplemented
    ),
    ...cliDefinitions.filter(
      (definition) =>
        definition.exposeInLauncher !== false && !definition.observerImplemented
    )
  ]
  return prioritizedDefinitions.flatMap((definition) => {
    const matches = installations.filter((item) => item.definitionId === definition.id)
    if (matches.length === 0) return []
    return [{
      definition: {
        id: definition.id,
        adapterId: definition.adapterId,
        displayName: definition.displayName,
        hint: definition.hint,
        iconId: definition.iconId
      },
      installations: matches
    }]
  })
}

interface PersistedCliScan {
  version: typeof CLI_SCAN_CACHE_VERSION
  report: CliScanReport
  /** 包含不展示在普通 CLI 大厅中的辅助定义（当前为 DSH）。 */
  installations: CliInstallation[]
  wslEnvironmentPaths: Record<string, string>
  wslHomes: Record<string, string>
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : null
}

function parseCachedRuntime(value: unknown): CliRuntime | null {
  const raw = recordOf(value)
  if (!raw) return null
  if (
    raw.kind === 'host' &&
    (raw.platform === 'windows' || raw.platform === 'macos' || raw.platform === 'linux')
  ) {
    return { kind: 'host', platform: raw.platform }
  }
  if (
    raw.kind === 'wsl' &&
    typeof raw.distro === 'string' &&
    raw.distro.length > 0 &&
    raw.distro.length <= 128
  ) {
    return { kind: 'wsl', distro: raw.distro }
  }
  return null
}

function parseCachedInstallation(
  value: unknown,
  definition: CliDefinition
): CliInstallation | null {
  const raw = recordOf(value)
  if (!raw || raw.definitionId !== definition.id) return null
  const runtime = parseCachedRuntime(raw.runtime)
  if (
    !runtime ||
    typeof raw.resolvedExecutable !== 'string' ||
    raw.resolvedExecutable.length === 0 ||
    raw.resolvedExecutable.length > 4_096 ||
    (raw.detectedVia !== 'path' && raw.detectedVia !== 'known-path') ||
    raw.verification !== 'verified'
  ) {
    return null
  }
  const id = installationId(definition.id, runtime, raw.resolvedExecutable)
  if (raw.id !== id) return null
  return {
    id,
    definitionId: definition.id,
    runtime,
    resolvedExecutable: raw.resolvedExecutable,
    detectedVia: raw.detectedVia,
    version: typeof raw.version === 'string' ? raw.version.slice(0, 200) : undefined,
    verification: 'verified'
  }
}

function parsePersistedCliScan(value: unknown): {
  report: CliScanReport
  installations: CliInstallation[]
  wslEnvironmentPaths: Map<string, string>
  wslHomes: Map<string, string>
} | null {
  const root = recordOf(value)
  const rawReport = recordOf(root?.report)
  if (
    root?.version !== CLI_SCAN_CACHE_VERSION ||
    !rawReport ||
    typeof rawReport.startedAt !== 'number' ||
    typeof rawReport.finishedAt !== 'number' ||
    !Array.isArray(rawReport.launchable)
  ) {
    return null
  }

  const launchable = rawReport.launchable.flatMap((value): LaunchableCli[] => {
    const raw = recordOf(value)
    const rawDefinition = recordOf(raw?.definition)
    const definition = cliDefinitions.find((item) => item.id === rawDefinition?.id)
    if (
      !definition ||
      definition.exposeInLauncher === false ||
      !Array.isArray(raw?.installations)
    ) return []
    const installations = raw.installations
      .map((item) => parseCachedInstallation(item, definition))
      .filter((item): item is CliInstallation => Boolean(item))
    if (installations.length === 0) return []
    return [{
      definition: {
        id: definition.id,
        adapterId: definition.adapterId,
        displayName: definition.displayName,
        hint: definition.hint,
        iconId: definition.iconId
      },
      installations
    }]
  })
  const paths = new Map<string, string>()
  const rawPaths = recordOf(root.wslEnvironmentPaths)
  if (rawPaths) {
    for (const [distro, path] of Object.entries(rawPaths)) {
      if (distro.length <= 128 && typeof path === 'string' && path.startsWith('/')) {
        paths.set(distro, path)
      }
    }
  }
  if (!Array.isArray(root.installations)) return null
  const installations = root.installations
    .flatMap((value): CliInstallation[] => {
      const raw = recordOf(value)
      const definition = cliDefinitions.find(
        (item) => item.id === raw?.definitionId
      )
      if (!definition) return []
      const parsed = parseCachedInstallation(value, definition)
      return parsed ? [parsed] : []
    })
  const homes = new Map<string, string>()
  const rawHomes = recordOf(root.wslHomes)
  if (rawHomes) {
    for (const [distro, home] of Object.entries(rawHomes)) {
      if (
        distro.length <= 128 &&
        typeof home === 'string' &&
        home.startsWith('/') &&
        !home.includes('\0')
      ) {
        homes.set(distro, home)
      }
    }
  }
  return {
    report: {
      startedAt: rawReport.startedAt,
      finishedAt: rawReport.finishedAt,
      launchable,
      runtimeErrors: []
    },
    installations,
    wslEnvironmentPaths: paths,
    wslHomes: homes
  }
}

function e2eFixtureReport(startedAt: number): CliScanReport {
  const definition = cliDefinitions.find((item) => item.id === 'codex')!
  const windows: CliRuntime = { kind: 'host', platform: 'windows' }
  const wsl: CliRuntime = { kind: 'wsl', distro: 'Ubuntu-Test' }
  // S1：observer fixture 走查需要 CLI 在脚本重放期间保持存活，
  // 因此 Windows 安装改用交互式 cmd.exe（普通 e2e 仍用 where.exe 快速退出）。
  const fixtureExecutable =
    process.platform === 'win32'
      ? process.env['HRACK_FIXTURE_OBSERVER'] === '1'
        ? 'cmd.exe'
        : 'where.exe'
      : '/bin/false'
  return {
    startedAt,
    finishedAt: Date.now(),
    launchable: [{
      definition: {
        id: definition.id,
        adapterId: definition.adapterId,
        displayName: definition.displayName,
        hint: definition.hint,
        iconId: definition.iconId
      },
      installations: [
        {
          id: installationId('codex', windows, fixtureExecutable),
          definitionId: 'codex', runtime: windows,
          resolvedExecutable: fixtureExecutable, detectedVia: 'path',
          version: 'codex-cli test fixture', verification: 'verified'
        },
        {
          id: installationId('codex', wsl, '/bin/false'),
          definitionId: 'codex', runtime: wsl,
          resolvedExecutable: '/bin/false', detectedVia: 'path',
          version: 'codex-cli test fixture', verification: 'verified'
        }
      ]
    }],
    runtimeErrors: []
  }
}

async function assertDirectory(path: string): Promise<void> {
  const metadata = await stat(path)
  if (!metadata.isDirectory()) throw new Error(`Workspace is not a directory: ${path}`)
}

function validateSelection(selection: CliLaunchSelection): void {
  if (!selection || typeof selection !== 'object') throw new Error('Invalid CLI launch selection')
  if (typeof selection.installationId !== 'string' || !selection.installationId) {
    throw new Error('Missing CLI installation')
  }
  if (typeof selection.workspace !== 'string' || selection.workspace.length > 32_768) {
    throw new Error('Invalid workspace')
  }
  if (!Array.isArray(selection.args) || selection.args.length > 128) {
    throw new Error('Invalid CLI arguments')
  }
  for (const argument of selection.args) {
    if (typeof argument !== 'string' || argument.length > 4_096 || argument.includes('\0')) {
      throw new Error('Invalid CLI argument')
    }
  }
}

async function wslWorkspace(distro: string, workspace: string): Promise<string> {
  if (/^\/[\s\S]*/.test(workspace)) {
    const valid = await runWsl(distro, 'test', ['-d', workspace])
    if (valid.code !== 0) throw new Error(`Workspace is unavailable in ${distro}: ${workspace}`)
    return workspace
  }
  const unc = parseWslUncPath(workspace)
  if (unc) {
    if (unc.distro.toLowerCase() !== distro.toLowerCase()) {
      throw new Error(`Workspace belongs to WSL ${unc.distro}, not ${distro}`)
    }
    const path = unc.linuxPath
    const valid = await runWsl(distro, 'test', ['-d', path])
    if (valid.code !== 0) throw new Error(`Workspace is unavailable in ${distro}: ${path}`)
    return path
  }
  const converted = await runWsl(distro, 'wslpath', ['-a', '-u', workspace])
  const path = converted.stdout.trim()
  if (converted.code !== 0 || !path) throw new Error(`Cannot convert workspace for ${distro}`)
  const valid = await runWsl(distro, 'test', ['-d', path])
  if (valid.code !== 0) throw new Error(`Workspace is unavailable in ${distro}: ${path}`)
  return path
}

async function runtimeWorkspace(
  runtime: CliRuntime,
  requestedWorkspace: string
): Promise<string> {
  const requested = requestedWorkspace.trim()
  if (runtime.kind === 'wsl') {
    if (requested) return wslWorkspace(runtime.distro, requested)
    const result = await runWsl(runtime.distro, 'sh', [
      '-lc', 'printf "%s" "$HOME"'
    ])
    const home = result.stdout.trim()
    if (result.code !== 0 || !home.startsWith('/') || home.includes('\0')) {
      throw new Error(`Cannot resolve Home in ${runtime.distro}`)
    }
    const valid = await runWsl(runtime.distro, 'test', ['-d', home])
    if (valid.code !== 0) {
      throw new Error(`Home is unavailable in ${runtime.distro}: ${home}`)
    }
    return home
  }

  const workspace = requested || homedir()
  await assertDirectory(workspace)
  return workspace
}

export class AiCliDiscoveryService {
  private cached: CliScanReport | null = null
  private activeScan: Promise<CliScanReport> | null = null
  private installations: CliInstallation[] = []
  private wslEnvironmentPaths = new Map<string, string>()
  private wslHomes = new Map<string, string>()

  constructor(private readonly cachePath?: string) {}

  scan(force = false): Promise<CliScanReport> {
    if (!force && this.cached) return Promise.resolve(this.cached)
    if (this.activeScan) return this.activeScan
    this.activeScan = (force
      ? this.performScan()
      : this.loadPersistedScan().then((cached) => cached ?? this.performScan())
    ).finally(() => {
      this.activeScan = null
    })
    return this.activeScan
  }

  private async loadPersistedScan(): Promise<CliScanReport | null> {
    if (!this.cachePath || process.env['HRACK_E2E_CLI_FIXTURE'] === '1') return null
    try {
      const cached = parsePersistedCliScan(
        JSON.parse(await readFile(this.cachePath, 'utf8'))
      )
      if (!cached) return null
      this.cached = cached.report
      this.installations = cached.installations
      this.wslEnvironmentPaths = cached.wslEnvironmentPaths
      this.wslHomes = cached.wslHomes
      return cached.report
    } catch {
      return null
    }
  }

  private async persistScan(report: CliScanReport): Promise<void> {
    if (!this.cachePath || process.env['HRACK_E2E_CLI_FIXTURE'] === '1') return
    const payload: PersistedCliScan = {
      version: CLI_SCAN_CACHE_VERSION,
      report,
      installations: this.installations,
      wslEnvironmentPaths: Object.fromEntries(this.wslEnvironmentPaths),
      wslHomes: Object.fromEntries(this.wslHomes)
    }
    try {
      await mkdir(dirname(this.cachePath), { recursive: true })
      const tempPath = `${this.cachePath}.tmp`
      await writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8')
      await rename(tempPath, this.cachePath)
    } catch (error) {
      console.error('[cli-discovery] cache persistence failed:', error)
    }
  }

  private async performScan(): Promise<CliScanReport> {
    const startedAt = Date.now()
    if (process.env['HRACK_E2E_CLI_FIXTURE'] === '1') {
      const report = e2eFixtureReport(startedAt)
      this.installations = report.launchable.flatMap(
        (cli) => cli.installations
      )
      this.wslEnvironmentPaths = new Map()
      this.wslHomes = new Map()
      const dshExecutable = process.env['HRACK_E2E_DSH_INSTALLATION']
      if (dshExecutable && dshExecutable.length <= 4_096) {
        const distro = process.env['HRACK_E2E_DSH_WSL_DISTRO']
        const runtime: CliRuntime = distro
          ? { kind: 'wsl', distro }
          : {
              kind: 'host',
              platform: process.platform === 'win32'
                ? 'windows'
                : process.platform === 'darwin'
                  ? 'macos'
                  : 'linux'
            }
        this.installations.push({
          id: installationId(DSH_CLI_DEFINITION_ID, runtime, dshExecutable),
          definitionId: DSH_CLI_DEFINITION_ID,
          runtime,
          resolvedExecutable: dshExecutable,
          detectedVia: 'known-path',
          version: DSH_COMPATIBLE_VERSION,
          verification: 'verified'
        })
        if (runtime.kind === 'wsl') {
          const environmentPath = process.env['HRACK_E2E_DSH_WSL_PATH']
          const home = process.env['HRACK_E2E_DSH_WSL_HOME']
          if (environmentPath) {
            this.wslEnvironmentPaths.set(runtime.distro, environmentPath)
          }
          if (home) this.wslHomes.set(runtime.distro, home)
        }
      }
      return (this.cached = report)
    }
    const errors: CliRuntimeError[] = []
    const wslEnvironmentPaths = new Map<string, string>()
    const wslHomes = new Map<string, string>()
    let installations: CliInstallation[] = []

    if (process.platform === 'win32') {
      const [host, wsl] = await Promise.all([
        mapLimit(cliDefinitions, SCAN_CONCURRENCY, (definition) =>
          scanWindowsDefinition(definition, errors)
        ),
        listWslDistros()
      ])
      installations.push(...host.filter((value): value is CliInstallation => Boolean(value)))
      if (wsl.error) errors.push(wsl.error)
      const distroInstallations = await mapLimit(wsl.distros, 2, (distro) =>
        scanWslDistro(distro, errors, wslEnvironmentPaths, wslHomes)
      )
      installations.push(...distroInstallations.flat())
    } else {
      const runtime: CliRuntime = {
        kind: 'host',
        platform: process.platform === 'darwin' ? 'macos' : 'linux'
      }
      const environment = await nativeUserEnvironment()
      const found = await mapLimit(cliDefinitions, SCAN_CONCURRENCY, (definition) =>
        scanNativeDefinition(definition, runtime, environment, errors)
      )
      installations = found.filter((value): value is CliInstallation => Boolean(value))
    }

    const report: CliScanReport = {
      startedAt,
      finishedAt: Date.now(),
      launchable: groupLaunchable(installations),
      runtimeErrors: errors
    }
    this.installations = installations
    this.wslEnvironmentPaths = wslEnvironmentPaths
    this.wslHomes = wslHomes
    this.cached = report
    await this.persistScan(report)
    return report
  }

  /**
   * 读取一个定义的扫描结果。隐藏定义（如 DSH）复用普通 CLI 的同一轮
   * host/WSL 扫描与缓存，但不会出现在 launchable 卡片中。
   */
  async scanDefinition(
    definitionId: string,
    force = false
  ): Promise<{
    startedAt: number
    finishedAt: number
    installations: CliInstallation[]
    runtimeErrors: CliRuntimeError[]
  }> {
    if (!cliDefinitions.some((definition) => definition.id === definitionId)) {
      throw new Error(`Unknown CLI definition: ${definitionId}`)
    }
    const report = await this.scan(force)
    return {
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      installations: this.installations.filter(
        (installation) => installation.definitionId === definitionId
      ),
      runtimeErrors: report.runtimeErrors.filter(
        (error) =>
          error.definitionId === definitionId || error.definitionId === undefined
      )
    }
  }

  /** 按 installationId 找回本次扫描的已验证安装；已失效返回 null。 */
  async resolveInstallation(
    installationId: string
  ): Promise<CliInstallation | null> {
    const report = await this.scan(false)
    return (
      report.launchable
        .flatMap((cli) => cli.installations)
        .find((item) => item.id === installationId) ?? null
    )
  }

  /** 空工作区以所选安装的实际运行环境 Home 为准。 */
  async resolveWorkspace(
    installationId: string,
    workspace: string
  ): Promise<string> {
    if (!installationId || installationId.length > 4_096) {
      throw new Error('Missing CLI installation')
    }
    if (typeof workspace !== 'string' || workspace.length > 32_768) {
      throw new Error('Invalid workspace')
    }
    const installation = await this.resolveInstallation(installationId)
    if (!installation) {
      throw new Error('CLI installation is no longer available; refresh the scan')
    }
    return runtimeWorkspace(installation.runtime, workspace)
  }

  /** 安装所属 CLI Definition 的 Observer Adapter id；未知定义返回 null。 */
  definitionAdapterId(installation: CliInstallation): string | null {
    return (
      cliDefinitions.find(
        (definition) => definition.id === installation.definitionId
      )?.adapterId ?? null
    )
  }

  /**
   * 返回扫描与正式启动共同使用的最小运行环境。
   * WSL CLI 经常是 `#!/usr/bin/env node` 包装器；脱离登录 shell 裸执行
   * 会误用系统 Node，因此 Adapter probe 也必须复用这里的 PATH。
   */
  runtimeEnvironment(
    installation: CliInstallation
  ): Readonly<Record<string, string>> {
    if (installation.runtime.kind !== 'wsl') return {}
    const path = this.wslEnvironmentPaths.get(installation.runtime.distro)
    return path ? { PATH: path } : {}
  }

  /** 扫描时解析出的目标运行环境 Home；WSL 启动不可猜测 `/home/<user>`。 */
  runtimeHome(installation: CliInstallation): string | null {
    if (installation.runtime.kind !== 'wsl') return homedir()
    return this.wslHomes.get(installation.runtime.distro) ?? null
  }

  async prepareLaunch(
    selection: CliLaunchSelection,
    augmentation: {
      env?: Readonly<Record<string, string>>
      prependArgs?: readonly string[]
      appendArgs?: readonly string[]
      unsetEnv?: readonly string[]
    } = {}
  ): Promise<SpawnOptions> {
    validateSelection(selection)
    const report = await this.scan(false)
    const installation = report.launchable
      .flatMap((cli) => cli.installations)
      .find((item) => item.id === selection.installationId)
    if (!installation) throw new Error('CLI installation is no longer available; refresh the scan')
    const definition = cliDefinitions.find((item) => item.id === installation.definitionId)
    if (!definition) throw new Error('Unknown CLI definition')
    // Adapter 参数必须在 Windows `.cmd` 命令行序列化之前合并。序列化后再
    // 拼接不仅会丢参数，也无法在 cmd.exe 的多层 quoting 下保持安全。
    const args = [
      ...(augmentation.prependArgs ?? []),
      ...(definition.launchArgs ?? []),
      ...selection.args,
      ...(augmentation.appendArgs ?? [])
    ]

    const cwd = await runtimeWorkspace(installation.runtime, selection.workspace)

    if (installation.runtime.kind === 'wsl') {
      const environmentPath = this.runtimeEnvironment(installation).PATH
      return wslLaunchOptions(
        installation,
        cwd,
        args,
        augmentation,
        environmentPath
      )
    }

    if (process.platform === 'win32' && isWindowsShim(installation.resolvedExecutable)) {
      return {
        shell: process.env.ComSpec ?? 'cmd.exe',
        args: `/d /v:off /c call ${[installation.resolvedExecutable, ...args].map(quoteCmdArg).join(' ')}`,
        cwd
      }
    }
    return { shell: installation.resolvedExecutable, args, cwd }
  }

  /**
   * 在该安装所属 runtime（host PATH 或 WSL distro）里执行一次短命令。
   * 给 Bridge `models` 用，不启动 TUI。
   */
  async runInstallationCommand(
    installation: CliInstallation,
    args: readonly string[],
    timeoutMs = 15_000
  ): Promise<CommandResult> {
    if (installation.runtime.kind === 'wsl') {
      const environmentPath = this.runtimeEnvironment(installation).PATH
      return runWsl(
        installation.runtime.distro,
        'env',
        [
          ...(environmentPath ? [`PATH=${environmentPath}`] : []),
          installation.resolvedExecutable,
          ...args
        ],
        timeoutMs
      )
    }
    return runCommand(installation.resolvedExecutable, args, timeoutMs)
  }
}

/** 纯 argv 组装 seam：便于验证 env 确实进入 WSL 子进程而非只给 wsl.exe。 */
export function wslLaunchOptions(
  installation: CliInstallation,
  cwd: string,
  args: readonly string[],
  augmentation: {
    env?: Readonly<Record<string, string>>
    unsetEnv?: readonly string[]
  },
  environmentPath?: string
): SpawnOptions {
  if (installation.runtime.kind !== 'wsl') {
    throw new Error('wslLaunchOptions requires a WSL installation')
  }
  const environmentEntries = Object.entries(augmentation.env ?? {}).filter(
    ([key, value]) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      key.length <= 128 &&
      value.length <= 4_096 &&
      !value.includes('\0')
  )
  const needsEnvironmentWrapper =
    Boolean(environmentPath) ||
    environmentEntries.length > 0 ||
    (augmentation.unsetEnv?.length ?? 0) > 0
  return {
    shell: 'wsl.exe',
    args: [
      '--distribution', installation.runtime.distro,
      '--cd', cwd,
      '--exec',
      ...(needsEnvironmentWrapper
        ? [
            'env',
            ...(augmentation.unsetEnv ?? []).flatMap((key) => ['-u', key]),
            ...environmentEntries.map(([key, value]) => `${key}=${value}`),
            ...(environmentPath ? [`PATH=${environmentPath}`] : []),
            installation.resolvedExecutable
          ]
        : [installation.resolvedExecutable]),
      ...args
    ]
  }
}
