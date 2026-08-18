---
name: create-hrack-theme
description: Create, modify, validate, or package HRack UI themes as JSON. Use when designing a new HRack color theme, editing semantic UI colors, converting a palette into HRack tokens, or contributing a built-in theme.
---

# Create an HRack Theme

Create a semantic JSON theme that stays readable across the whole HRack interface. Prefer a coherent hierarchy and accessible contrast over direct one-to-one palette substitution.

## Start from the repository

1. Read `shared/theme-schema.ts` completely. It is the authoritative token list and validation contract.
2. Inspect `src/themes/light.json` and `src/themes/dark.json` before choosing values. Current source wins if this Skill is stale.
3. Decide the delivery target:
   - For a personal theme, return JSON that can be pasted into **Settings -> Appearance -> Theme JSON**. Keep `id` as `custom`; HRack persists it to a fixed `custom.json`.
   - For a product-owned theme, add `src/themes/<id>.json`, import it in `src/app/themeRuntime.ts`, and register it in the built-in theme list.
4. Do not overwrite a built-in id or silently change the selected theme.

## Theme contract

Use this shape:

```json
{
  "id": "custom",
  "name": "My Theme",
  "type": "dark",
  "colors": {
    "bg.app": "#171717",
    "bg.content": "#202020",
    "text.primary": "#f5f5f5",
    "border.default": "rgb(255 255 255 / 10%)",
    "focus.ring": "#8ab4f8"
  },
  "terminal": null
}
```

Rules:

- For the personal theme, keep `id` exactly `custom`. For product-owned themes use a unique lowercase id.
- Set `type` to `light` or `dark`.
- Use only tokens listed in `UI_COLOR_TOKENS`.
- Use literal CSS colors: hex, `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, or `color()`.
- Do not use `var()`, URLs, gradients, CSS declarations, or unknown keys.
- Keep `terminal` as `null`; terminal palettes remain a separate setting.
- User themes may omit tokens. HRack fills them from the built-in theme of the same `type`. Built-in themes must resolve every token.

## Design semantic roles

Build the hierarchy in this order:

1. Establish `bg.app`, `bg.content`, `bg.surface`, controls, overlays, and borders.
2. Define primary, secondary, muted, faint, disabled, and inverse text with clear separation.
3. Keep status families distinguishable: working, needs-you, done, error, idle, and exited.
4. Check primary and secondary button foreground/background pairs in normal and hover states.
5. Give focus, cursor, target, and spark accents distinct jobs without letting one hue dominate the interface.
6. Keep sidebar tints subtle and preserve readable title-bar controls and scrollbars.

Avoid low-contrast text, invisible borders, transparent controls, and status colors that collapse into one another. Test both dense settings rows and terminal-adjacent surfaces, not just a palette swatch.

## Validate and deliver

1. Parse the JSON and run it through `validateUiTheme()` and `resolveUiTheme()`.
2. Confirm every built-in theme resolves all `UI_COLOR_TOKENS`.
3. Type-check HRack after changing TypeScript or the shared contract.
4. Run the targeted theme editor and window-shell tests before any full E2E suite.
5. Verify save, hot reload, invalid JSON, duplicate ids, built-in id protection, and the selected-theme fallback.
6. Report the theme id, type, changed files, validation performed, and any remaining contrast risk.
