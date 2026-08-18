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

1. Run `node resources/skills/create-hrack-theme/validate-theme.cjs <theme.json>`. It is zero-dependency, mirrors `validateUiTheme()`/`resolveUiTheme()` rules, and prints WCAG ratios for the canonical fg/bg pairs.
2. Do not compile the TS schema ad hoc (`tsc`/`node` toolchain startup has hung in this environment). The bundled script is the sanctioned checker; only `validateUiTheme()` itself is authoritative.
3. Deliver the JSON, a short mapping summary, and any intentionally sub-threshold pairs.

**Built-in theme — full pipeline:**

1. Fast-path script first, then confirm the theme resolves every `UI_COLOR_TOKENS` via `validateUiTheme()`/`resolveUiTheme()`, and that every existing built-in still does.
2. Type-check HRack after changing TypeScript or the shared contract.
3. Run the targeted theme editor and window-shell tests before any full E2E suite; full regression only at the merge gate.
4. Verify save, hot reload, invalid JSON, duplicate ids, built-in id protection, and the selected-theme fallback.

Report the theme id, type, changed files, validation performed, and any remaining contrast risk.
