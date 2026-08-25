/**
 * Coordinates pause/resume across independent PTY output consumers.
 * The native PTY pauses for the first lease and resumes only after the last
 * owner releases, so renderer and remote acknowledgements cannot race.
 */
export class PtyPauseLeases {
  private readonly owners = new Set<symbol>()

  constructor(
    private readonly pause: () => void,
    private readonly resume: () => void
  ) {}

  get size(): number {
    return this.owners.size
  }

  acquire(owner: symbol): void {
    if (this.owners.has(owner)) return
    const first = this.owners.size === 0
    this.owners.add(owner)
    if (first) this.pause()
  }

  release(owner: symbol): void {
    if (!this.owners.delete(owner)) return
    if (this.owners.size === 0) this.resume()
  }
}
