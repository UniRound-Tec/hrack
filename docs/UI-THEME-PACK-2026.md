# HRack UI Theme Pack 2026

This pack adds four light and four dark UI themes. They are intentionally more
opinionated than the existing compatibility palettes: each theme must have a
distinct surface hierarchy, accent language, status treatment, and atmosphere.
Terminal palettes remain independent.

## Light themes

### Paper Ink (`paper-ink`)

- Editorial, warm paper and printed graphite.
- Cream canvas, white paper surfaces, restrained vermilion accents.
- Borders feel like fine rules; shadows are warm and diffuse.
- Status colors remain sober and readable rather than saturated.

### Glacier Glass (`glacier-glass`)

- Cold, airy glass with pale ice-blue depth.
- Translucent controls, blue-white surfaces, cyan/cobalt focus accents.
- Borders are crisp and cool; shadows carry a faint blue cast.
- Working and focus states should feel luminous without becoming neon.

### Sakura Clay (`sakura-clay`)

- Soft blush porcelain grounded by muted terracotta.
- Warm off-white content, rose-tinted surfaces, clay/red accents.
- Gentle low-contrast layering with berry text and warm shadows.
- Avoid a cosmetic pink wash: controls and status colors must stay functional.

### Circuit Lime (`circuit-lime`)

- High-key technical workspace with an acid-lime signal language.
- Neutral white/graphite foundation; lime appears only for active emphasis.
- Harder borders and compact visual contrast evoke instruments and schematics.
- Keep body text neutral and reserve lime for focus, selection, and working state.

## Dark themes

### Obsidian Ember (`obsidian-ember`)

- Carbon-black surfaces with ember orange and hot red highlights.
- Strong depth separation without flattening everything to pure black.
- Warm glows are reserved for active, attention, and focus states.
- Completed and idle states remain calm so alerts retain impact.

### Midnight Cobalt (`midnight-cobalt`)

- Deep navy control room with electric cobalt and cyan instrumentation.
- Cool layered panels, precise blue borders, sharp luminous focus rings.
- Status colors should read like console indicators, not candy colors.
- Preserve comfortable contrast for long coding sessions.

### Forest Signal (`forest-signal`)

- Deep evergreen workspace with mint and amber signal lights.
- Surfaces progress from near-black pine to desaturated moss.
- Mint is the primary interactive accent; amber marks attention.
- The result should feel organic and quiet, not military camouflage.

### Violet Arcade (`violet-arcade`)

- Deep aubergine base with violet, magenta, and cyan energy.
- Layered dark-purple surfaces and selective neon edge highlights.
- Focus and active controls may glow; reading surfaces stay restrained.
- Avoid uniform purple: neutral text and dark structure must anchor the palette.

## Implementation constraints

- Each theme is a complete built-in `UiThemeSource` JSON file under `src/themes`.
- Every token in `UI_COLOR_TOKENS` must be defined; `terminal` stays `null`.
- Text/background pairs must remain readable at ordinary desktop sizes.
- Transparent colors use accepted CSS color literals only.
- Theme names and IDs above are stable and are used by persisted settings.
- Registration, selector integration, and final visual tuning are owned centrally.
