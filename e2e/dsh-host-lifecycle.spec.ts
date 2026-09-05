import { expect, test } from '@playwright/test'
import { DshHostManager } from '../electron/dsh-host/DshHostManager'
import type { DshHostStatus } from '../shared/dsh-ipc'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  let spawns = 0
  let kills = 0
  const manager = new DshHostManager({
    defaultDshHome: '/unused',
    discovery: {} as never,
    broadcast: () => {}
  })
  // Only launch discovery, path conversion and process creation are controlled;
  // the production start/stop/retry state machine runs unchanged.
  const launch = {
    resolveLaunchTargets: async () => [{
      candidate: { id: 'fixture', kind: 'installation', runtime: { kind: 'wsl', distro: 'fixture' } }
    }],
    resolveTargetHome: () => '/unused',
    resolveRemoteLaunch: async (): Promise<null> => null,
    spawnTarget: () => {
      spawns++
      return { onceExit: () => {}, kill: () => { kills++ } }
    },
    waitReady: async () => {}
  }
  Object.assign(manager, launch)
  return {
    manager,
    launch,
    counts: () => ({ spawns, kills }),
    override: (patch: Partial<typeof launch>) => Object.assign(manager, patch)
  }
}

test('dispose during remote path conversion prevents a late spawn', async () => {
  const { manager, counts, override } = fixture()
  const entered = deferred<void>()
  const conversion = deferred<null>()
  override({ resolveRemoteLaunch: () => {
    entered.resolve()
    return conversion.promise
  } })
  const starting = manager.ensureStarted()
  await entered.promise
  const disposing = manager.dispose()
  conversion.resolve(null)
  await Promise.all([starting, disposing])
  expect(counts()).toEqual({ spawns: 0, kills: 0 })
  expect(manager.getStatus().state).toBe('stopped')
  await manager.ensureStarted()
  expect(counts().spawns).toBe(0)
})

test('restart during discovery waits for cancellation and starts a fresh host', async () => {
  const { manager, launch, counts, override } = fixture()
  const discovery = deferred<Awaited<ReturnType<typeof launch.resolveLaunchTargets>>>()
  let scans = 0
  override({ resolveLaunchTargets: () => ++scans === 1 ? discovery.promise : launch.resolveLaunchTargets() })
  const starting = manager.ensureStarted()
  const restarting = manager.restart()
  discovery.resolve(await launch.resolveLaunchTargets())
  try {
    const [, status] = await Promise.all([starting, restarting])
    expect(status.state).toBe('ready')
    expect(scans).toBe(2)
    expect(counts()).toEqual({ spawns: 1, kills: 0 })
  } finally {
    await manager.dispose()
  }
  expect(counts().kills).toBe(1)
})

test('concurrent start requests wait for an in-progress stop', async () => {
  const { manager, counts, override } = fixture()
  const ready = deferred<void>()
  override({ waitReady: () => ready.promise })
  const starting = manager.ensureStarted()
  await expect.poll(() => counts().spawns).toBe(1)
  const stopping = manager.stop()
  const next = manager.ensureStarted()
  const states: DshHostStatus[] = []
  void next.then((state) => { states.push(state) })
  expect(states).toEqual([])
  ready.resolve()
  try {
    await Promise.all([starting, stopping, next])
    expect(manager.getStatus().state).toBe('ready')
    expect(counts()).toEqual({ spawns: 2, kills: 1 })
  } finally {
    await manager.dispose()
  }
})
