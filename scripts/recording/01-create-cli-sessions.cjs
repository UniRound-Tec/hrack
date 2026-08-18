/*
 * Recording script 01: create a sequence of real CLI sessions.
 *
 * Examples:
 *   npm run record:cli-demo
 *   $env:HRACK_RECORDING_CLIS='codex,claude,opencode'; npm run record:cli-demo
 *   $env:HRACK_RECORDING_PAUSE_MS=3000; npm run record:cli-demo
 *
 * The script launches the already-built Electron app visibly. It scans actual
 * host/WSL installations by default; --fixture is only for automated checks.
 */

const { _electron: electron } = require('@playwright/test')
const { existsSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..', '..')
const main = join(root, 'out', 'main', 'index.js')
const args = process.argv.slice(2)
const fixtureMode = args.includes('--fixture')
const parseList = (value) => value
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean)

const cliOrder = parseList(
  process.env.HRACK_RECORDING_CLIS ?? 'codex,claude,opencode,kimi,pi,grok'
)
const pauseMs = Number.parseInt(process.env.HRACK_RECORDING_PAUSE_MS ?? '2200', 10)
const holdMs = Number.parseInt(process.env.HRACK_RECORDING_HOLD_MS ?? '12000', 10)
const initialPauseMs = Number.parseInt(process.env.HRACK_RECORDING_INITIAL_PAUSE_MS ?? '0', 10)
const recordingTitle = process.env.HRACK_RECORDING_WINDOW_TITLE ?? 'HRack · CLI session demo'
const workspace = resolve(process.env.HRACK_RECORDING_WORKSPACE ?? root)
const userDataDir = process.env.HRACK_RECORDING_USER_DATA_DIR ?? mkdtempSync(
  join(tmpdir(), 'hrack-recording-')
)

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function dismissOnboarding(page) {
  const onboarding = page.getByTestId('first-run-onboarding')
  if (!await onboarding.isVisible().catch(() => false)) return
  await page.getByTestId('onboarding-complete').click()
}

async function navigateHome(page) {
  await page.getByTestId('nav-home').click()
  await page.getByTestId('home-page').waitFor({ state: 'visible' })
}

async function launchCli(page, cli) {
  const launcher = page.getByTestId(`home-quick-${cli.definition.id}`)
  await launcher.click()
  await page.getByTestId('cli-config').waitFor({ state: 'visible' })
  await delay(pauseMs)

  const hostInstallation = cli.installations.find(
    (installation) => installation.runtime.kind === 'host'
  )
  if (hostInstallation) {
    await page.getByTestId(
      `cli-installation-${hostInstallation.runtime.platform}`
    ).click()
  }

  await page.getByTestId('cli-session-name').fill(`Demo · ${cli.definition.displayName}`)
  await page.getByTestId('cli-workspace').fill(workspace)
  await page.getByTestId('cli-launch').click()
  await page.getByTestId('cli-config').waitFor({ state: 'detached', timeout: 20_000 })
  await delay(pauseMs)
}

async function run() {
  if (!existsSync(main)) {
    throw new Error('Missing out/main/index.js. Run npm run build before recording.')
  }

  const env = {
    ...process.env,
    HRACK_USER_DATA_DIR: userDataDir,
    ...(fixtureMode
      ? {
          HRACK_E2E: '1',
          HRACK_E2E_CLI_FIXTURE: '1',
          HRACK_FIXTURE_OBSERVER: '1'
        }
      : { HRACK_E2E_CLI_FIXTURE: '0' })
  }
  const app = await electron.launch({ args: [main], env })
  const page = await app.firstWindow()
  try {
    await page.evaluate((title) => { document.title = title }, recordingTitle)
    await page.waitForFunction(
      () =>
        Boolean(document.querySelector('[data-testid="first-run-onboarding"]')) ||
        Boolean(document.querySelector('[data-testid="home-page"]')),
      null,
      { polling: 100, timeout: 30_000 }
    )
    await dismissOnboarding(page)
    await page.getByTestId('home-page').waitFor({ state: 'visible', timeout: 30_000 })
    await delay(Math.max(0, initialPauseMs))
    await delay(pauseMs)

    const report = await page.evaluate(() => window.cliApi.scan(false))
    const selected = cliOrder
      .map((id) => report.launchable.find((cli) => cli.definition.id === id))
      .filter(Boolean)

    if (selected.length === 0) {
      throw new Error(`None of the requested CLIs were discovered: ${cliOrder.join(', ')}`)
    }

    console.log(`Recording ${selected.length} CLI sessions: ${selected.map((cli) => cli.definition.displayName).join(', ')}`)
    for (const cli of selected) {
      await navigateHome(page)
      console.log(`Creating ${cli.definition.displayName}`)
      await launchCli(page, cli)
    }

    await navigateHome(page)
    console.log(`Sequence complete. Holding the final Home view for ${holdMs}ms.`)
    await delay(Math.max(0, holdMs))
  } finally {
    await app.close()
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
