import type { Terminal } from '@xterm/xterm'

interface CursorRenderService {
  handleCursorMove(): void
}

interface XtermCoreWithRenderService {
  _renderService?: CursorRenderService
}

interface XtermWithRenderService extends Terminal {
  _core?: XtermCoreWithRenderService
}

export interface OutputCursorRenderingPatch {
  dispose(): void
}

/**
 * Keeps program output from restarting xterm's cursor blink animation.
 *
 * InputHandler emits onCursorMove for cursor movements parsed from PTY output.
 * xterm forwards those events to the renderer, whose only current effect is to
 * force the blinking cursor visible and restart its timer. A TUI that repaints
 * every second therefore makes the cursor flash in lockstep with its status
 * updates. Windows Terminal redraws a moved cursor without resetting blink.
 *
 * Focus and pointer activity have their own renderer paths and remain intact.
 * Keep this compatibility patch isolated so it can be removed if xterm splits
 * output cursor movement from user-activity blink resets upstream.
 */
export function installOutputCursorRendering(
  terminal: Terminal
): OutputCursorRenderingPatch {
  const target = terminal as XtermWithRenderService
  const renderService = target._core?._renderService
  if (!renderService) {
    throw new Error('xterm RenderService is unavailable after Terminal.open()')
  }

  const original = renderService.handleCursorMove
  const ignoreOutputCursorMove = (): void => {}
  renderService.handleCursorMove = ignoreOutputCursorMove

  return {
    dispose() {
      if (renderService.handleCursorMove === ignoreOutputCursorMove) {
        renderService.handleCursorMove = original
      }
    }
  }
}
