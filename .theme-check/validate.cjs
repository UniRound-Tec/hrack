/* Self-contained checker for personal HRack themes — plain Node, no build step.
 * Mirrors shared/theme-schema.ts (UI_COLOR_TOKENS + color literal rules).
 * Usage: node .theme-check/validate.cjs <theme.json>
 * NOTE: mirror only — if shared/theme-schema.ts changes, update the lists below. */
const fs = require('node:fs')

const UI_COLOR_TOKENS = [
  'bg.app','bg.content','bg.surface','bg.surface.hover','bg.surface.strong',
  'bg.control','bg.control.active','bg.overlay','bg.backdrop','bg.backdrop.strong',
  'text.primary','text.secondary','text.strong','text.muted','text.faint','text.disabled','text.inverse',
  'border.default','border.subtle','border.faint','border.strong','border.control',
  'accent.flame','accent.cursor','accent.spark','accent.target',
  'brand.logo','brand.logoShine','brand.logoMuted',
  'status.working','status.working.dot','status.needsYou','status.needsYou.dot',
  'status.done','status.done.dot','status.error','status.error.dot',
  'status.idle','status.idle.dot','status.exited','status.exited.dot',
  'titlebar.fg','titlebar.fg.hover','titlebar.bg.hover','titlebar.close.bg.hover','titlebar.close.fg.hover',
  'scrollbar.thumb','scrollbar.thumb.hover','scrollbar.thumb.active',
  'sidebar.tint.a','sidebar.tint.b','shadow.window','shadow.popover',
  'button.primary.bg','button.primary.bg.hover','button.primary.fg',
  'button.secondary.bg','button.secondary.bg.hover','button.secondary.fg',
  'input.bg','input.bg.hover','input.border.focus','focus.ring'
]
const TOKEN_SET = new Set(UI_COLOR_TOKENS)
const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HEX_COLOR_PATTERN = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i
const FUNCTION_COLOR_PATTERN = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^;{}]+\)$/i

const file = process.argv[2]
if (!file) { console.error('usage: node validate.cjs <theme.json>'); process.exit(1) }
const value = JSON.parse(fs.readFileSync(file, 'utf8'))

// validateUiTheme equivalent
const errors = []
if (typeof value.id !== 'string' || !THEME_ID_PATTERN.test(value.id)) errors.push('id invalid')
if (typeof value.name !== 'string' || !value.name.trim()) errors.push('name invalid')
if (value.type !== 'light' && value.type !== 'dark') errors.push('type invalid')
if (typeof value.colors !== 'object' || Array.isArray(value.colors) || !value.colors) {
  errors.push('colors must be an object')
} else {
  for (const [t, c] of Object.entries(value.colors)) {
    if (!TOKEN_SET.has(t)) errors.push(`unknown token: ${t}`)
    else {
      const s = typeof c === 'string' ? c.trim() : ''
      if (!(s === 'transparent' || HEX_COLOR_PATTERN.test(s) || FUNCTION_COLOR_PATTERN.test(s))) {
        errors.push(`not a color literal: ${t} = ${c}`)
      }
    }
  }
}
if (!(value.terminal === null || value.terminal === undefined)) errors.push('terminal must be null')
if (errors.length) { console.error('INVALID:\n' + errors.map(e => '  - ' + e).join('\n')); process.exit(1) }
console.log('validateUiTheme: OK (id=%s, type=%s)', value.id, value.type)

// resolveUiTheme equivalent (standalone)
const missing = UI_COLOR_TOKENS.filter(t => !(t in value.colors))
if (missing.length) { console.error('missing tokens:', missing.join(', ')); process.exit(1) }
console.log('resolveUiTheme: OK — all %d tokens resolve', UI_COLOR_TOKENS.length)

// WCAG contrast for key pairs
function parse(str) {
  const s = str.trim(); let m
  if ((m = s.match(/^#([\da-f]{3,4})$/i))) {
    const e = [...m[1]].map(c => parseInt(c + c, 16))
    return { r: e[0], g: e[1], b: e[2], a: m[1].length === 4 ? e[3] / 255 : 1 }
  }
  if ((m = s.match(/^#([\da-f]{6}|[\da-f]{8})$/i))) {
    const h = m[1]
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }
  }
  if ((m = s.match(/^rgba?\(([^)]+)\)$/i))) {
    const p = m[1].split(/[,/]/).map(x => x.trim())
    const [r, g, b] = p.slice(0, 3).map(n => parseFloat(n))
    let a = 1
    if (p[3] != null) a = p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])
    return { r, g, b, a }
  }
  throw new Error('unsupported: ' + str)
}
const comp = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a) })
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05) }
const C = value.colors
const pair = (fg, bg) => ratio(comp(parse(C[fg]), parse(C[bg])), parse(C[bg]))
const checks = [
  ['text.primary / bg.content', 'text.primary', 'bg.content', 4.5],
  ['text.secondary / bg.content', 'text.secondary', 'bg.content', 4.5],
  ['text.strong / bg.content', 'text.strong', 'bg.content', 4.5],
  ['text.strong / bg.surface', 'text.strong', 'bg.surface', 4.5],
  ['text.strong / bg.surface.strong', 'text.strong', 'bg.surface.strong', 4.5],
  ['text.muted / bg.content', 'text.muted', 'bg.content', 4.5],
  ['text.muted / bg.surface.strong', 'text.muted', 'bg.surface.strong', 4.5],
  ['text.faint / bg.content', 'text.faint', 'bg.content', 3],
  ['text.primary / input.bg', 'text.primary', 'input.bg', 4.5],
  ['button.primary.fg / button.primary.bg', 'button.primary.fg', 'button.primary.bg', 4.5],
  ['button.primary.fg / button.primary.bg.hover', 'button.primary.fg', 'button.primary.bg.hover', 4.5],
  ['button.secondary.fg / button.secondary.bg', 'button.secondary.fg', 'button.secondary.bg', 4.5],
  ['button.secondary.fg / button.secondary.bg.hover', 'button.secondary.fg', 'button.secondary.bg.hover', 4.5],
  ['status.working / bg.content', 'status.working', 'bg.content', 4.5],
  ['status.needsYou / bg.content', 'status.needsYou', 'bg.content', 4.5],
  ['status.done / bg.content', 'status.done', 'bg.content', 4.5],
  ['status.error / bg.content', 'status.error', 'bg.content', 4.5],
  ['status.idle / bg.content', 'status.idle', 'bg.content', 4.5],
  ['status.exited / bg.content', 'status.exited', 'bg.content', 3],
  ['titlebar.fg.hover / titlebar.bg.hover', 'titlebar.fg.hover', 'titlebar.bg.hover', 4.5],
  ['titlebar.close.fg/bg.hover', 'titlebar.close.fg.hover', 'titlebar.close.bg.hover', 4.5],
  ['focus.ring / bg.content', 'focus.ring', 'bg.content', 3],
  ['accent.flame / bg.content', 'accent.flame', 'bg.content', 3]
]
let fail = 0
for (const [label, fg, bg, min] of checks) {
  const r = pair(fg, bg); const ok = r >= min; if (!ok) fail++
  console.log('%s %-42s %5.2f:1 (min %s)', ok ? 'PASS' : 'FAIL', label, r, min)
}
console.log(fail ? `contrast: ${fail} FAIL` : 'contrast: ALL PASS')
process.exit(fail ? 2 : 0)
