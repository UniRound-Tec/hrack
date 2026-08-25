import type { RemoteDshState } from '../../shared/ipc-contract'
import type { RemoteWebSurface } from '../../shared/remote-protocol'
import { getMainPrefs, persistMainPrefs } from '../main-prefs'
import type { DshHostManager } from '../dsh-host/DshHostManager'
import { DshTunnelClient, type DshTunnelClientState } from '../dsh-host/DshTunnelClient'
import { ensureRemoteDshOverlay } from '../dsh-host/RemoteDshOverlay'
import type { RemoteDesktopClient, RemoteDshTunnelLease } from './RemoteDesktopClient'

/** Coordinates the opt-in, managed DSH host generation and independent tunnel seat. */
export class RemoteDshCoordinator {
  private enabled = getMainPrefs().remoteDshEnabled
  private relaySupported = false
  private lease: RemoteDshTunnelLease | null = null
  private surface: RemoteWebSurface | null = null
  private generation = 0
  private operation = 0
  private hostTransitionExpected = false
  private readonly tunnel: DshTunnelClient

  constructor(
    private readonly options: {
      userDataDir: string
      host: DshHostManager
      remote: RemoteDesktopClient
      broadcast: (state: RemoteDshState) => void
    }
  ) {
    this.tunnel = new DshTunnelClient(options.host, (state) => {
      this.onTunnelState(state)
    })
  }

  getState(): RemoteDshState {
    return {
      enabled: this.enabled,
      relaySupported: this.relaySupported,
      surface: this.surface ? { ...this.surface } : null
    }
  }

  async setEnabled(enabled: boolean): Promise<RemoteDshState> {
    if (enabled === this.enabled) return this.getState()
    this.enabled = enabled
    await persistMainPrefs({ remoteDshEnabled: enabled })
    if (!enabled) {
      this.operation += 1
      this.tunnel.stop()
      this.publishSurface('unavailable', true)
    } else if (this.lease) {
      void this.startCurrentLease()
    } else {
      this.publishSurface('unavailable', true)
    }
    this.broadcast()
    return this.getState()
  }

  acceptLease(lease: RemoteDshTunnelLease | null): void {
    this.operation += 1
    this.tunnel.stop()
    this.lease = lease ? { ...lease } : null
    this.relaySupported = lease !== null
    if (!this.enabled || !lease) {
      if (this.enabled) this.publishSurface('unavailable', true)
      this.broadcast()
      return
    }
    void this.startCurrentLease()
  }

  hostStopped(): void {
    if (this.hostTransitionExpected) return
    if (!this.enabled || !this.lease) return
    this.operation += 1
    this.tunnel.stop()
    this.publishSurface('failed', false)
  }

  dispose(): void {
    this.operation += 1
    this.tunnel.stop()
    this.lease = null
  }

  private async startCurrentLease(): Promise<void> {
    const lease = this.lease
    if (!this.enabled || !lease) return
    const operation = ++this.operation
    this.publishSurface('starting', true)
    try {
      const overlayPath = await ensureRemoteDshOverlay(this.options.userDataDir)
      if (operation !== this.operation || !this.enabled || this.lease !== lease) return
      this.hostTransitionExpected = true
      const status = await (async () => {
        await this.options.host.configureRemoteWeb({
          publicOrigin: lease.publicOrigin,
          overlayPath
        })
        return this.options.host.ensureStarted()
      })().finally(() => {
        this.hostTransitionExpected = false
      })
      if (operation !== this.operation || !this.enabled || this.lease !== lease) return
      if (status.state !== 'ready') {
        this.publishSurface('unavailable', false)
        return
      }
      this.tunnel.start({
        tunnelUrl: lease.tunnelUrl,
        roomId: lease.roomId,
        seatToken: lease.seatToken,
        publicOrigin: lease.publicOrigin
      })
    } catch {
      if (operation === this.operation) this.publishSurface('failed', false)
    }
  }

  private onTunnelState(state: DshTunnelClientState): void {
    if (!this.enabled || !this.lease) return
    if (state === 'connecting') this.publishSurface('starting', false)
    else if (state === 'open') this.publishSurface('ready', false)
    else if (state === 'closed') this.publishSurface('unavailable', false)
  }

  private publishSurface(
    state: RemoteWebSurface['state'],
    newGeneration: boolean
  ): void {
    if (newGeneration || this.generation === 0) this.generation += 1
    this.surface = {
      id: 'dsh',
      kind: 'dsh-web',
      displayName: 'DeepSeek Harness',
      iconId: 'dsh',
      state,
      generation: this.generation
    }
    this.options.remote.setDshSurface(this.surface)
    this.broadcast()
  }

  private broadcast(): void {
    this.options.broadcast(this.getState())
  }
}
