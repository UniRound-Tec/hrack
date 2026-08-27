import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DSH_REMOTE_BROWSE_OVERLAY = `# HRack sets SSH_CONNECTION for the
# managed remote host, so DSH's official auto picker selects its browse pair.
# Do not insert picker entries here: a profile may already pin the official
# browse implementation. Only restore the official trusted-host config chain
# after user layers so --trusted-host reaches the HTTP/RPC authority fence.
- id: web-runtime
  inject:
    - webStartup
  config:
    trustedHosts: !!js ctx.webStartup.trustedHosts
- id: connection
  inject:
    - webRuntime
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
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
