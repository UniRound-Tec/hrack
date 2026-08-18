---
name: create-hrack-theme
description: Create, modify, validate, or package HRack UI themes as JSON. Use when designing a new HRack color theme, editing semantic UI colors, converting a palette into HRack tokens, or contributing a built-in theme.
---

# Create an HRack Theme

Create a semantic JSON theme that stays readable across the whole HRack interface. Prefer a coherent hierarchy and accessible contrast over direct one-to-one palette substitution.

## Decide the delivery target first

Ask once, up front, before reading any repo file:

- **Personal theme** (default for one-off palette requests): keep `id: "custom"`, deliver JSON to paste into **Settings -> Appearance -> Theme JSON**. No repo changes, no typecheck, no tests — use the fast path below.
- **Built-in theme**: unique lowercase id, add `src/themes/<id>.json`, import it in `src/app/themeRuntime.ts`, register it in the built-in list. Use the full pipeline below.

Never overwrite a built-in id or silently change the selected theme.

## Locate the validator before any color work

The bundled checker is the only sanctioned contrast oracle. Find it in this order:

1. This skill's own folder in the repo checkout: `resources/skills/create-hrack-theme/validate-theme.cjs`.
2. The session workspace (glob `**/validate-theme.cjs`).
3. Ask the user once for the HRack checkout path. Do not guess paths and do not silently skip validation.

If no copy is reachable, write the embedded copy from the appendix below to a temp file and run it with `node`. **Never substitute manual WCAG arithmetic for the script.** Hand-computed ratios have produced wrong PASS/FAIL calls and missed required fields; only the script (and ultimately `validateUiTheme()`) is authoritative.

## Quick reference

This section mirrors `shared/theme-schema.ts` and `src/themes/dark.json` conventions. It is the fast path: work from here and only re-read the repo when something looks stale. If `UI_COLOR_TOKENS` in `shared/theme-schema.ts` differs from the groups below, the schema wins and this Skill (and `validate-theme.cjs`) needs updating.

All 63 tokens, by group:

- **bg (10)**: `app, content, surface, surface.hover, surface.strong, control, control.active, overlay, backdrop, backdrop.strong`
- **text (7)**: `primary, secondary, strong, muted, faint, disabled, inverse`
- **border (5)**: `default, subtle, faint, strong, control`
- **accent (4)**: `flame, cursor, spark, target`
- **brand (3)**: `logo, logoShine, logoMuted`
- **status (12)**: `working, needsYou, done, error, idle, exited`, each with a `.dot` twin
- **titlebar (5)**: `fg, fg.hover, bg.hover, close.bg.hover, close.fg.hover`
- **scrollbar (3)**: `thumb, thumb.hover, thumb.active`
- **sidebar (2)**: `tint.a, tint.b`; **shadow (2)**: `window, popover`
- **controls (10)**: `button.primary.{bg,bg.hover,fg}`, `button.secondary.{bg,bg.hover,fg}`, `input.{bg,bg.hover,border.focus}`, `focus.ring`

Minimal standalone shape — `type` is required (a hand-built theme missing `type` fails validation), `terminal` stays `null` until the xterm convergence:

```json
{
  "id": "custom",
  "name": "My Theme",
  "type": "dark",
  "colors": { "…": "all 63 tokens for a standalone personal theme" },
  "terminal": null
}
```

Validator facts the alpha formulas below must not contradict:

- `titlebar.bg.hover` and `titlebar.close.bg.hover` must be **opaque solids**. The contrast check ignores the bg's alpha and reads the raw RGB, so an alpha color there evaluates as a bright pastel and fails (cf. `src/themes/dracula.json`, which uses solids). `close.bg.hover` must also be a red dark enough for `close.fg.hover` (white) to hold ≥4.5:1.
- `text.strong` and `text.muted` are re-checked against `bg.surface.strong`, not only `bg.content`. With a mid-luminance foreground palette, keep the whole surface family within a step of `bg.content` — flattening `surface.hover == surface.strong` is a common fix (cf. Dracula).

Hierarchy invariants (dark type; invert for light):

- Surfaces run `bg.app` darkest → `bg.content` → `bg.surface` family. Keep surface luminance ≤ content when muted text must hold ≥4.5:1 on it — a surface brighter than content breaks the muted tier.
- Text ladder by contrast: `primary` (highest) > `secondary` > `strong` (the palette's signature foreground) > `muted` (≥4.5:1 on content) > `faint` (≥3:1) > `disabled` (alpha-dimmed). `inverse` is the app background tone.
- Derive mechanical tokens with alpha formulas instead of hunting palette equivalents: borders `rgb(<foreground hue> / 6–22%)` (faint < subtle < default < strong), scrollbars `rgb(<light hue> / 14–34%)`, backdrops/shadows `rgb(<darkest bg> / 45–72%)`, sidebar tints `rgb(<accent hue> / 6–13%)`.
- `*.dot` tokens may repeat the label color or a close sibling.

Contrast thresholds (WCAG, measured on `bg.content` unless noted):

- `text.primary/secondary/strong/muted`: ≥4.5:1
- `text.faint`, `focus.ring`, `accent.*`: ≥3:1
- button fg on its bg **and** its bg.hover: ≥4.5:1
- status labels: ≥4.5:1; dots and decorative fills: no hard floor

## Port a popular palette (the common case)

Imported palettes (Dracula, Nord, SynthWave '84, Gruvbox…) share one shape: two backgrounds, a foreground, a hover/brand color, and syntax colors. Map by role, not by name:

| Palette slot | HRack tokens |
|---|---|
| Darkest background | `bg.app`, `input.bg`, `text.inverse` |
| Main background | `bg.content`, `bg.overlay` (add ~94% alpha) |
| Foreground / mid tone | `text.strong`; lighten for `primary`/`secondary`, keep `muted`/`faint` near it |
| Hover / brand color | `button.primary.bg` (+ lightened `.hover`), `accent.cursor` or `focus.ring` |
| Yellow / "contrast" | `status.needsYou(.dot)`, `accent.target` |
| Greens | `status.done` / `status.done.dot` |
| Reds | `status.error` / `status.error.dot`, `titlebar.close.bg.hover` |
| Cyans / blues | `status.working(.dot)`, `accent.spark` |
| Orange / highlight | `accent.flame` |
| Purples / pinks | `brand.logo`, `focus.ring`, sidebar tints |

Blend the two backgrounds for the surface family, then fill borders, scrollbars, shadows, and tints from the alpha formulas. Reserve 5 minutes only for pairs the validator flags.

## Validate and deliver

**Personal theme — fast path:**

1. Run `node resources/skills/create-hrack-theme/validate-theme.cjs <theme.json>` (or the embedded appendix copy — see "Locate the validator before any color work"). It is zero-dependency, mirrors `validateUiTheme()`/`resolveUiTheme()` rules, and prints WCAG ratios for the canonical fg/bg pairs.
2. Do not compile the TS schema ad hoc (`tsc`/`node` toolchain startup has hung in this environment). The bundled script is the sanctioned checker; only `validateUiTheme()` itself is authoritative.
3. Deliver the JSON, a short mapping summary, and any intentionally sub-threshold pairs.

**Built-in theme — full pipeline:**

1. Fast-path script first, then confirm the theme resolves every `UI_COLOR_TOKENS` via `validateUiTheme()`/`resolveUiTheme()`, and that every existing built-in still does.
2. Type-check HRack after changing TypeScript or the shared contract.
3. Run the targeted theme editor and window-shell tests before any full E2E suite; full regression only at the merge gate.
4. Verify save, hot reload, invalid JSON, duplicate ids, built-in id protection, and the selected-theme fallback.

Report the theme id, type, changed files, validation performed, and any remaining contrast risk.

## Appendix: embedded `validate-theme.cjs`

Byte-mirror of `resources/skills/create-hrack-theme/validate-theme.cjs`. When either copy changes, update both in the same commit. To validate without the repo, save everything between the fences below as a `.cjs` file and run `node <file> <theme.json>`.

````js
/* Bundled with the create-hrack-theme Skill — plain Node, zero dependencies.
 * Mirrors shared/theme-schema.ts (UI_COLOR_TOKENS + color literal rules) and
 * prints WCAG contrast for the canonical fg/bg pairs.
 * MIRROR ONLY: if shared/theme-schema.ts changes, update the lists below.
 * Usage: node validate-theme.cjs <theme.json> [fallback.json]
 */
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
const fallbackFile = process.argv[3]
if (!file) { console.error('usage: node validate-theme.cjs <theme.json> [fallback.json]'); process.exit(1) }
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
if (errors.length) { console.error('validateUiTheme FAILED:\n' + errors.map(e => '  - ' + e).join('\n')); process.exit(1) }
console.log('validateUiTheme: OK (id=%s, name=%s, type=%s)', value.id, value.name, value.type)

// resolveUiTheme equivalent — standalone, then merged with an optional same-type fallback
const missing = UI_COLOR_TOKENS.filter(t => !(t in value.colors))
if (missing.length && !fallbackFile) {
  console.error('missing tokens (no fallback given):', missing.join(', '))
  process.exit(1)
}
let merged = { ...value.colors }
if (fallbackFile) {
  const fb = JSON.parse(fs.readFileSync(fallbackFile, 'utf8'))
  if (fb.type !== value.type) { console.error('fallback type mismatch'); process.exit(1) }
  for (const t of UI_COLOR_TOKENS) if (!merged[t]) merged[t] = fb.colors[t]
}
const stillMissing = UI_COLOR_TOKENS.filter(t => !merged[t])
if (stillMissing.length) { console.error('unresolved tokens:', stillMissing.join(', ')); process.exit(1) }
console.log('resolveUiTheme: OK — all %d tokens resolve%s', UI_COLOR_TOKENS.length, fallbackFile ? ' (with fallback)' : ' (standalone)')

// WCAG contrast for canonical pairs
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
  throw new Error('unsupported color for contrast: ' + str)
}
const comp = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a) })
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05) }
const pair = (fg, bg) => ratio(comp(parse(merged[fg]), parse(merged[bg])), parse(merged[bg]))
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
````
