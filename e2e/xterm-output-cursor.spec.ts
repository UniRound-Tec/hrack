import { expect, test } from '@playwright/test'
import type { Terminal } from '@xterm/xterm'
import { installOutputCursorRendering } from '../src/terminal/outputCursorRendering'

test('PTY output cursor moves do not restart the renderer blink cycle', () => {
  let renderedCursorMoves = 0
  const renderService = {
    handleCursorMove() {
      renderedCursorMoves++
    }
  }
  const terminal = {
    _core: {
      _renderService: renderService
    }
  }

  const patch = installOutputCursorRendering(
    terminal as unknown as Terminal
  )

  renderService.handleCursorMove()
  renderService.handleCursorMove()
  expect(renderedCursorMoves).toBe(0)

  patch.dispose()
  renderService.handleCursorMove()
  expect(renderedCursorMoves).toBe(1)
})
