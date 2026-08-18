import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DSH_CLI_DEFINITION_ID,
  DSH_COMPATIBLE_VERSION,
  cliDefinitions
} from '../electron/ai-cli-discovery'
import {
  DSH_WSL_PID_MARKER,
  buildDshExternalSpawnSpec,
  bundledDshRuntime,
  selectDshRuntimeCandidates
} from '../electron/dsh-host/DshRuntime'
import type { DshRuntimeCandidate } from '../shared/dsh-ipc'
import {
  resolveHrackUserDataDir,
  resolveNativeDshHome,
  resolveWslDshHome
} from '../electron/app-paths'
import { launchApp } from './helpers'

const windowsCandidate: Extract<
  DshRuntimeCandidate,
  { kind: 'installation' }
> = {
  id: 'dsh:windows',
  kind: 'installation',
  runtime: { kind: 'host', platform: 'windows' },
  resolvedExecutable: 'C:\\Users\\Test User\\AppData\\Roaming\\npm\\dsh.cmd',
  version: DSH_COMPATIBLE_VERSION
}

const wslCandidate: Extract<
  DshRuntimeCandidate,
  { kind: 'installation' }
> = {
  id: 'dsh:wsl-ubuntu',
  kind: 'installation',
  runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
  resolvedExecutable: '/home/test/.local/bin/dsh',
  version: DSH_COMPATIBLE_VERSION
}

test('DSH is discovered as an exact-version hidden runtime', () => {
  const definition = cliDefinitions.find(
    (item) => item.id === DSH_CLI_DEFINITION_ID
  )
  expect(definition).toBeDefined()
  expect(definition?.exposeInLauncher).toBe(false)
  expect(definition).toMatchObject({ allowWslWindowsInterop: false })
  expect(definition?.probes[0].outputPattern.test(DSH_COMPATIBLE_VERSION)).toBe(true)
  expect(definition?.probes[0].outputPattern.test('0.1.0-rc.7')).toBe(false)
})

test('HRack paths use the new brand and share an existing DSH home', () => {
  const appData = join('users', 'test', 'app-data')
  const home = join('users', 'test')
  expect(resolveHrackUserDataDir(appData, true)).toBe(join(appData, 'HRack'))
  expect(
    resolveNativeDshHome(
      'shared',
      home,
      join(appData, 'HRack', 'dsh-home')
    )
  ).toBe(join(home, '.dsh'))
  expect(resolveWslDshHome('shared', '/home/test')).toBe('/home/test/.dsh')
  expect(resolveWslDshHome('isolated', '/home/test')).toBe(
    '/home/test/.local/share/hrack/dsh-home'
  )
})

test('auto prefers host then WSL then the bundled fallback', () => {
  expect(
    selectDshRuntimeCandidates(
      { kind: 'auto' },
      [wslCandidate, windowsCandidate]
    ).map((candidate) => candidate.id)
  ).toEqual([windowsCandidate.id, wslCandidate.id, bundledDshRuntime.id])
  expect(
    selectDshRuntimeCandidates(
      { kind: 'installation', installationId: wslCandidate.id },
      [windowsCandidate, wslCandidate]
    )
  ).toEqual([wslCandidate])
  expect(() =>
    selectDshRuntimeCandidates(
      { kind: 'installation', installationId: 'missing' },
      [windowsCandidate]
    )
  ).toThrow(/no longer available/)
})

test('external launch preserves native and WSL runtime boundaries', () => {
  const windows = buildDshExternalSpawnSpec({
    candidate: windowsCandidate,
    port: 43123,
    dshHome: 'C:\\HRack Data\\dsh-home',
    commandInterpreter: 'C:\\Windows\\System32\\cmd.exe',
    inheritedEnv: { SystemRoot: 'C:\\Windows' }
  })
  expect(windows.file).toBe('C:\\Windows\\System32\\cmd.exe')
  expect(windows.args.slice(0, 3)).toEqual(['/d', '/v:off', '/c'])
  expect(windows.args[3]).toContain('dsh.cmd')
  expect(windows.args[3]).toContain('"--port" "43123"')
  expect(windows.env.DSH_HOME).toBe('C:\\HRack Data\\dsh-home')

  const wsl = buildDshExternalSpawnSpec({
    candidate: wslCandidate,
    port: 43124,
    dshHome: '/home/test/.local/share/hrack/dsh-home',
    environmentPath: '/home/test/.local/bin:/usr/bin:/bin',
    inheritedEnv: { SystemRoot: 'C:\\Windows' }
  })
  expect(wsl.file).toBe('wsl.exe')
  expect(wsl.args).toEqual(expect.arrayContaining([
    '--distribution',
    'Ubuntu-24.04',
    'PATH=/home/test/.local/bin:/usr/bin:/bin',
    'DSH_HOME=/home/test/.local/share/hrack/dsh-home',
    '/home/test/.local/bin/dsh',
    '--port',
    '43124'
  ]))
  expect(wsl.args.join(' ')).toContain(DSH_WSL_PID_MARKER)
  expect(wsl.env.DSH_HOME).toBeUndefined()
})

test('settings scans DSH runtimes and persists an explicit bundled choice', async () => {
  const first = await launchApp({ createDefaultTerminal: false })
  try {
    await first.window.evaluate(() => {
      window.__hrackDebugShell?.navigate('settings')
    })
    const select = first.window.getByTestId('dsh-runtime-select')
    await expect(select).toBeEnabled({ timeout: 20_000 })
    await expect(select).toHaveAttribute('data-value', 'auto')
    await select.click()
    await first.window.getByTestId('dsh-runtime-select-option-bundled').click()
    await expect.poll(
      () => first.window.evaluate(async () =>
        (await window.dshApi.getConfig()).runtimePreference.kind
      )
    ).toBe('bundled')
  } finally {
    await first.app.close()
  }

  const second = await launchApp({
    createDefaultTerminal: false,
    userDataDir: first.userDataDir
  })
  try {
    const config = await second.window.evaluate(() => window.dshApi.getConfig())
    expect(config.runtimePreference).toEqual({ kind: 'bundled' })
    const report = await second.window.evaluate(() =>
      window.dshApi.scanRuntimes(false)
    )
    expect(report.candidates[0]).toMatchObject({
      id: 'bundled',
      kind: 'bundled',
      version: DSH_COMPATIBLE_VERSION
    })
  } finally {
    await second.app.close()
  }
})

test('Home exposes a discovered local DSH runtime', async () => {
  const executable = resolve(
    __dirname,
    '../dsh-runtime/node_modules/.bin/dsh.cmd'
  )
  const expectedRuntime = process.platform === 'win32'
    ? 'Windows'
    : process.platform === 'darwin'
      ? 'macOS'
      : 'Linux'
  const appState = await launchApp({
    createDefaultTerminal: false,
    env: { HRACK_E2E_DSH_INSTALLATION: executable }
  })
  try {
    const report = await appState.window.evaluate(() =>
      window.dshApi.scanRuntimes(false)
    )
    expect(report.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'installation',
        resolvedExecutable: executable
      })
    ]))
    await expect(appState.window.getByTestId('home-quick-dsh')).toContainText(
      expectedRuntime
    )
  } finally {
    await appState.app.close()
  }
})

test('auto starts a discovered Windows DSH installation through its real shim', async () => {
  test.skip(process.platform !== 'win32', 'Windows npm shim coverage')
  test.setTimeout(120_000)
  const executable = resolve(
    __dirname,
    '../dsh-runtime/node_modules/.bin/dsh.cmd'
  )
  expect(existsSync(executable)).toBe(true)
  const appState = await launchApp({
    createDefaultTerminal: false,
    env: { HRACK_E2E_DSH_INSTALLATION: executable }
  })
  try {
    await expect.poll(
      () => appState.window.evaluate(async () =>
        (await window.dshApi.ensureStarted()).state
      ),
      { timeout: 90_000, intervals: [500, 1000, 2000] }
    ).toBe('ready')
    const status = await appState.window.evaluate(() => window.dshApi.getStatus())
    expect(status.activeRuntime).toMatchObject({
      kind: 'installation',
      resolvedExecutable: executable,
      runtime: { kind: 'host', platform: 'windows' }
    })
    await expect(
      appState.window.evaluate(() => window.dshApi.getBootManifest())
    ).resolves.toBeTruthy()
  } finally {
    await appState.app.close()
  }
})

test('auto falls back to the bundled runtime when a cached local install is stale', async () => {
  test.skip(process.platform !== 'win32', 'Windows fallback coverage')
  test.setTimeout(120_000)
  const missingExecutable = resolve(
    __dirname,
    'fixtures/does-not-exist/dsh.exe'
  )
  const appState = await launchApp({
    createDefaultTerminal: false,
    env: { HRACK_E2E_DSH_INSTALLATION: missingExecutable }
  })
  try {
    await expect.poll(
      () => appState.window.evaluate(async () =>
        (await window.dshApi.ensureStarted()).state
      ),
      { timeout: 90_000, intervals: [500, 1000, 2000] }
    ).toBe('ready')
    const status = await appState.window.evaluate(() => window.dshApi.getStatus())
    expect(status.activeRuntime).toMatchObject({
      id: 'bundled',
      kind: 'bundled'
    })
  } finally {
    await appState.app.close()
  }
})

test('a real WSL launch receives Linux PATH/HOME and is reaped on stop', async () => {
  const distro = process.env['HRACK_E2E_REAL_DSH_WSL']
  test.skip(
    process.platform !== 'win32' || !distro,
    'Set HRACK_E2E_REAL_DSH_WSL to an installed distro for the real gate'
  )
  test.setTimeout(120_000)
  const windowsFixture = resolve(
    __dirname,
    'fixtures/dsh-runtime-host.sh'
  )
  const executable = execFileSync(
    'wsl.exe',
    ['--distribution', distro!, '--exec', 'wslpath', '-a', '-u', windowsFixture],
    { encoding: 'utf8' }
  ).trim()
  const home = execFileSync(
    'wsl.exe',
    ['--distribution', distro!, '--exec', 'sh', '-lc', 'printf %s "$HOME"'],
    { encoding: 'utf8' }
  ).trim()
  execFileSync(
    'wsl.exe',
    ['--distribution', distro!, '--exec', 'test', '-x', executable]
  )
  const appState = await launchApp({
    createDefaultTerminal: false,
    env: {
      HRACK_E2E_DSH_INSTALLATION: executable,
      HRACK_E2E_DSH_WSL_DISTRO: distro!,
      HRACK_E2E_DSH_WSL_HOME: home,
      HRACK_E2E_DSH_WSL_PATH:
        '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    }
  })
  let linuxPid = 0
  try {
    await expect.poll(
      () => appState.window.evaluate(async () =>
        (await window.dshApi.ensureStarted()).state
      ),
      { timeout: 60_000, intervals: [500, 1000, 2000] }
    ).toBe('ready')
    const status = await appState.window.evaluate(() => window.dshApi.getStatus())
    expect(status.activeRuntime).toMatchObject({
      kind: 'installation',
      resolvedExecutable: executable,
      runtime: { kind: 'wsl', distro }
    })
    const response = await appState.window.evaluate(() =>
      window.dshWireApi.fetch({
        requestId: 'wsl-fixture',
        method: 'POST',
        path: '/api/fixture.describe'
      })
    )
    const envelope = JSON.parse(response.body) as {
      result: {
        value: { dshHome: string; telemetryDisabled: string; pid: number }
      }
    }
    expect(envelope.result.value).toMatchObject({
      dshHome: `${home}/.local/share/hrack/dsh-home`,
      telemetryDisabled: '1'
    })
    linuxPid = envelope.result.value.pid
    expect(linuxPid).toBeGreaterThan(1)
  } finally {
    await appState.app.close()
  }
  await expect.poll(() => {
    try {
      execFileSync('wsl.exe', [
        '--distribution', distro!, '--exec', 'kill', '-0', String(linuxPid)
      ], { stdio: 'ignore' })
      return 'alive'
    } catch {
      return 'stopped'
    }
  }, { timeout: 10_000 }).toBe('stopped')
})
