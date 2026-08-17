import { expect, test } from '@playwright/test'
import { ptyEnvironment } from '../electron/pty/PTYManager'

test.describe('PTY environment', () => {
  test('replaces a dumb terminal capability without changing renderer theme settings', () => {
    expect(
      ptyEnvironment({
        TERM: 'dumb',
        HRACK_CODEX_HOOK_DROP: 'C:\\hrack\\drop'
      })
    ).toMatchObject({
      TERM: 'xterm-256color',
      HRACK_CODEX_HOOK_DROP: 'C:\\hrack\\drop'
    })
  })

  test('preserves an explicit usable terminal capability', () => {
    expect(ptyEnvironment({ TERM: 'screen-256color' }).TERM).toBe(
      'screen-256color'
    )
  })
})
