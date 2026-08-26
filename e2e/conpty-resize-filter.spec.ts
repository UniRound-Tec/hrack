import { expect, test } from '@playwright/test'
import { ConptyResizeFilter } from '../electron/pty/ConptyResizeFilter'

const conptyRedraw = (cols: number, rows: number, body = 'screen') =>
  `\x1b[?25l\x1b[8;${rows};${cols}t\x1b[H${body}\x1b[K\x1b[?25h`

test('suppresses a size-marked ConPTY resize redraw', () => {
  const filter = new ConptyResizeFilter()
  filter.expectResize(120, 30)

  expect(filter.push(`${conptyRedraw(120, 30)}tail`)).toEqual({
    forward: 'tail',
    suppressedRedraws: 1,
    cursorSyncs: []
  })
})

test('never suppresses an application full redraw without a size marker', () => {
  const filter = new ConptyResizeFilter()
  filter.expectResize(120, 30)
  const applicationRedraw =
    '\x1b[?25l\x1b[HAPP_NEW_LAYOUT_AFTER_RESIZE\x1b[24;1H\x1b[?25h'

  expect(filter.push(applicationRedraw)).toEqual({
    forward: applicationRedraw,
    suppressedRedraws: 0,
    cursorSyncs: []
  })
})

test('suppresses stale and latest marked redraws during rapid resize', () => {
  const filter = new ConptyResizeFilter()
  filter.expectResize(100, 30)
  filter.expectResize(140, 40)

  expect(
    filter.push(`${conptyRedraw(100, 30)}${conptyRedraw(140, 40)}tail`)
  ).toEqual({
    forward: 'tail',
    suppressedRedraws: 2,
    cursorSyncs: []
  })
})

test('recognizes a marked redraw split across arbitrary chunks', () => {
  const filter = new ConptyResizeFilter()
  filter.expectResize(120, 30)
  const source = `${conptyRedraw(120, 30, 'row 1\r\nrow 2')}after`
  let forward = ''
  let suppressedRedraws = 0

  for (const char of source) {
    const result = filter.push(char)
    forward += result.forward
    suppressedRedraws += result.suppressedRedraws
  }

  expect(forward).toBe('after')
  expect(suppressedRedraws).toBe(1)
})
