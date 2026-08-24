import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DSH_REMOTE_BROWSE_OVERLAY = `- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-browse-host
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: directory-picker-browse-surface
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
`

/**
 * Product-owned overlay. It deliberately lives below HRack userData instead of
 * the selected DSH_HOME, so enabling Remote never edits a user's DSH profile.
 */
export async function ensureRemoteDshOverlay(
  userDataDir: string
): Promise<string> {
  const directory = join(userDataDir, 'dsh-runtime')
  const path = join(directory, 'remote-web.patch.yml')
  await mkdir(directory, { recursive: true })
  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch {
    // A missing product artifact is created below.
  }
  if (current !== DSH_REMOTE_BROWSE_OVERLAY) {
    await writeFile(path, DSH_REMOTE_BROWSE_OVERLAY, {
      encoding: 'utf8',
      mode: 0o600
    })
  }
  return path
}
