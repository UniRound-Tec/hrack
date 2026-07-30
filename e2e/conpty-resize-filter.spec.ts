import { expect, test } from '@playwright/test'
import { ConptyResizeFilter } from '../electron/pty/ConptyResizeFilter'

const redraw = (body = 'screen') =>
  `\x1b[?25l\x1b[H${body}\x1b[K\x1b[?25h`

test('passes ordinary PTY data through unchanged', () => {
  const filter = new ConptyResizeFilter()
  expect(filter.push('hello\r\n')).toEqual({
    forward: 'hello\r\n',
    suppressedRedraws: 0,
    cursorSyncs: []
  })
})

test('suppresses one resize redraw but preserves trailing real output', () => {
  const filter = new ConptyResizeFilter()
  filter.expectResize()

  expect(filter.push(`${redraw()}real output`)).toEqual({
    forward: 'real output',
    suppressedRedraws: 1,
    cursorSyncs: []
  })
})

test('accepts ConPTY window-size header', () => {
  const filter = new ConptyResizeFilter()
  filter.expectResize()

  expect(
    filter.push(
      '\x1b[?25l\x1b[8;43;141t\x1b[Hrow\x1b[K\x1b[?25h'
    )
  ).toEqual({
    forward: '',
    suppressedRedraws: 1,
    cursorSyncs: []
  })
})

test('recognizes a redraw split across arbitrary onData chunks', () => {
  const filter = new ConptyResizeFilter()
  filter.expectResize()

  const source = `${redraw('row 1\r\nrow 2')}after`
  let forward = ''
  let suppressed = 0
  for (const char of source) {
    const result = filter.push(char)
    forward += result.forward
    suppressed += result.suppressedRedraws
  }

  expect(forward).toBe('after')
  expect(suppressed).toBe(1)
})

test('does not suppress a non-ConPTY cursor-hide sequence', () => {
  const filter = new ConptyResizeFilter()
  filter.expectResize()
  const applicationDraw = '\x1b[?25l\x1b[2Japplication\x1b[?25h'

  expect(filter.push(applicationDraw)).toEqual({
    forward: applicationDraw,
    suppressedRedraws: 0,
    cursorSyncs: []
  })
})

test('coalesces consecutive resize expectations before output', () => {
  const filter = new ConptyResizeFilter()
  filter.expectResize()
  filter.expectResize()
  const second = redraw('second')

  expect(filter.push(`${redraw('first')}${second}tail`)).toEqual({
    forward: `${second}tail`,
    suppressedRedraws: 1,
    cursorSyncs: []
  })
})

test('waits for a newer redraw when resize happens during capture', () => {
  const filter = new ConptyResizeFilter()
  filter.expectResize()
  expect(filter.push('\x1b[?25l\x1b[Hfirst')).toEqual({
    forward: '',
    suppressedRedraws: 0,
    cursorSyncs: []
  })

  filter.expectResize()
  expect(
    filter.push(`\x1b[?25h${redraw('second')}tail`)
  ).toEqual({
    forward: 'tail',
    suppressedRedraws: 2,
    cursorSyncs: []
  })
})

test('fails open when a candidate exceeds the safety limit', () => {
  const filter = new ConptyResizeFilter({ maxCandidateChars: 24 })
  filter.expectResize()
  const unterminated = '\x1b[?25l\x1b[H' + 'x'.repeat(40)

  expect(filter.push(unterminated)).toEqual({
    forward: unterminated,
    suppressedRedraws: 0,
    cursorSyncs: []
  })
  expect(filter.push('next')).toEqual({
    forward: 'next',
    suppressedRedraws: 0,
    cursorSyncs: []
  })
})

test('extracts the final absolute cursor position from a redraw', () => {
  const filter = new ConptyResizeFilter()
  filter.expectResize()
  const frame = '\x1b[?25l\x1b[Hprompt\x1b[K\x1b[10;49H\x1b[?25h'

  expect(filter.push(frame)).toEqual({
    forward: '',
    suppressedRedraws: 1,
    cursorSyncs: [{ row: 10, column: 49 }]
  })
})
