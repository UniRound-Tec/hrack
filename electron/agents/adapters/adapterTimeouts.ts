/**
 * Adapter preparation may need to cold-start WSL and touch a Windows-mounted
 * filesystem before the CLI itself runs. Keep one shared ceiling so individual
 * adapters do not accidentally reintroduce the former 3 second race.
 */
export const ADAPTER_COMMAND_TIMEOUT_MS = 10_000
