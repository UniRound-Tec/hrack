/** Copy one pre-HRack localStorage entry without deleting the rollback source. */
export function migrateLegacyStorageKey(
  currentKey: string,
  legacyKey: string
): void {
  try {
    const storage = globalThis.localStorage
    if (storage.getItem(currentKey) !== null) return
    const legacy = storage.getItem(legacyKey)
    if (legacy !== null) storage.setItem(currentKey, legacy)
  } catch {
    // Sandboxed renderers and unit tests may not expose localStorage.
  }
}
