# Research: popular GUI + terminal theme palettes

Date: 2026-08-06

## Recommendation

Ship these four paired themes first, in this order:

1. **Catppuccin Mocha** — the best contemporary default: a complete 26-color semantic palette and an official terminal port.
2. **Dracula** — the most recognizable high-color option, with an official GUI palette and Windows Terminal port.
3. **Gruvbox Dark (medium)** — a warm, low-glare alternative whose original Vim source also publishes the terminal 16-color mapping.
4. **Nord** — a restrained cool option with a small, rigorously named palette and an official Xresources terminal port.

This is deliberately a small first batch: it covers pastel, vivid, warm, and cool styles without adding variants that are hard to distinguish in the picker. As a current popularity signal—not as a quality ranking—the official GitHub repositories had approximately 19.6k, 23.6k, 15.7k, and 6.9k stars respectively when checked on the date above: [Catppuccin](https://github.com/catppuccin/catppuccin), [Dracula](https://github.com/dracula/dracula-theme), [Gruvbox](https://github.com/morhetz/gruvbox), [Nord](https://github.com/nordtheme/nord).

All source palettes below come from repositories owned by the theme projects/authors. No values were taken from theme-aggregation sites, gists, or unofficial ports.

## GUI semantic mapping for Vibing

The source projects do not share a GUI token schema, so the following is a **Vibing mapping decision**. Every opaque hex is an exact color from the linked official palette or official terminal port. Values marked `*` are exact CSS alpha variants of an official source color; they are not additional upstream palette entries.

| Vibing role | Catppuccin Mocha | Dracula | Gruvbox Dark | Nord |
|---|---:|---:|---:|---:|
| `bg.app` | `#11111B` Crust | `#21222C` terminal Black | `#1D2021` dark0 hard | `#2E3440` nord0 |
| `bg.content` | `#181825` Mantle | `#282A36` Background | `#282828` dark0 | `#3B4252` nord1 |
| `bg.surface` | `#1E1E2E` Base | `#282A36` Background | `#3C3836` dark1 | `#434C5E` nord2 |
| `bg.surface.hover` | `#313244` Surface0 | `#44475A` Current Line | `#504945` dark2 | `#4C566A` nord3 |
| `bg.surface.strong` | `#45475A` Surface1 | `#44475A` Current Line | `#665C54` dark3 | `#4C566A` nord3 |
| `text.primary` | `#CDD6F4` Text | `#F8F8F2` Foreground | `#FBF1C7` light0 | `#ECEFF4` nord6 |
| `text.secondary` | `#BAC2DE` Subtext1 | `rgb(248 248 242 / 88%)`* | `#EBDBB2` light1 | `#E5E9F0` nord5 |
| `text.strong` | `#A6ADC8` Subtext0 | `rgb(248 248 242 / 78%)`* | `#D5C4A1` light2 | `#D8DEE9` nord4 |
| `text.muted` | `#9399B2` Overlay2 | `rgb(248 248 242 / 62%)`* | `#A89984` light4 | `rgb(216 222 233 / 72%)`* |
| `text.faint` | `#6C7086` Overlay0 | `#6272A4` Comment | `#928374` Gray | `rgb(216 222 233 / 48%)`* |
| `accent.flame` | `#FAB387` Peach | `#FFB86C` Orange | `#FE8019` bright orange | `#D08770` nord12 |
| `accent.cursor` | `#CBA6F7` Mauve | `#BD93F9` Purple | `#FE8019` bright orange | `#88C0D0` nord8 |
| `accent.spark` | `#F5E0DC` Rosewater | `#F8F8F2` Foreground | `#FBF1C7` light0 | `#ECEFF4` nord6 |
| `accent.target` / `focus.ring` | `#89B4FA` Blue | `#BD93F9` Purple | `#83A598` bright blue | `#81A1C1` nord9 |
| `status.working` | `#89B4FA` Blue | `#8BE9FD` Cyan | `#83A598` bright blue | `#88C0D0` nord8 |
| `status.needsYou` | `#F9E2AF` Yellow | `#F1FA8C` Yellow | `#FABD2F` bright yellow | `#EBCB8B` nord13 |
| `status.done` | `#A6E3A1` Green | `#50FA7B` Green | `#B8BB26` bright green | `#A3BE8C` nord14 |
| `status.error` | `#F38BA8` Red | `#FF5555` Red | `#FB4934` bright red | `#D08770` nord12 |

Mapping notes:

- Keep each source palette intact; do not normalize all themes toward Vibing's current gray theme. Their different hue and contrast behavior is the feature.
- Catppuccin already defines the closest match to Vibing's background/surface/text hierarchy, so its mapping is direct.
- Dracula only publishes two neutral backgrounds plus one comment color. Reusing its official terminal `black` for the app shell and alpha variants of `Foreground` for intermediate text preserves the Dracula identity without inventing new hues. The repeated `Background`/`Current Line` values are intentional.
- Gruvbox uses the original **dark, medium contrast** values. `dark0_hard` is used only to deepen the outer app shell; the content and terminal remain the upstream default `dark0`.
- Nord's four Polar Night colors map directly to the four background elevations. It has only three Snow Storm text colors, so muted/faint text are alpha variants of nord4.
- Nord's nord11 remains the error dot, while nord12 is used for error text because nord11 does not reach 3:1 contrast on the mapped nord1 content background.
- For the remaining Vibing tokens, derive borders and scrollbar colors by applying alpha to the theme's `text.primary` or strongest neutral surface; derive overlays/backdrops/shadows from `bg.app` or black. Do not introduce a fifth neutral hue solely to fill a token.
- Preserve the existing Windows close-button red (`#C42B1C`) for `titlebar.close.bg.hover`; it is platform behavior, not theme identity.

### Primary GUI palette sources

- Catppuccin: official [Mocha palette](https://github.com/catppuccin/catppuccin#-mocha) and [style guide](https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md).
- Dracula: official [OSS color palette](https://github.com/dracula/dracula-theme#color-palette-oss); the extra app-shell black is from the official [Windows Terminal definition](https://github.com/dracula/windows-terminal/blob/master/dracula.json).
- Gruvbox: original [palette and dark-mode relative-color definitions](https://github.com/morhetz/gruvbox/blob/master/colors/gruvbox.vim).
- Nord: official [16-color source palette](https://github.com/nordtheme/nord/blob/develop/src/nord.css) and [palette documentation](https://www.nordtheme.com/docs/colors-and-palettes).

## Terminal palettes

`purple` in Windows Terminal files is mapped to xterm.js `magenta`. Gruvbox's `aqua` is mapped to xterm.js `cyan`. Hex case is normalized here; values are otherwise unchanged.

### Base, cursor, and selection

| Field | Catppuccin Mocha | Dracula | Gruvbox Dark | Nord |
|---|---:|---:|---:|---:|
| `background` | `#1E1E2E` | `#282A36` | `#282828` | `#2E3440` |
| `foreground` | `#CDD6F4` | `#F8F8F2` | `#EBDBB2` | `#D8DEE9` |
| `cursor` | `#F5E0DC` | `#F8F8F2` | `#EBDBB2`† | `#D8DEE9` |
| `cursorAccent` | `#1E1E2E`† | `#282A36`† | `#282828`† | `#2E3440`† |
| `selectionBackground` | `#585B70` | `#44475A` | `#665C54`† | `#4C566A`† |

† xterm.js mapping decision. The upstream terminal source either has no `cursorAccent` concept or does not specify selection. `cursorAccent = background`; Gruvbox cursor uses foreground and its Vim `bg3` becomes selection; Nord selection uses nord3, the palette's darkest high-contrast neutral.

### ANSI 0–7

| ANSI / xterm.js field | Catppuccin Mocha | Dracula | Gruvbox Dark | Nord |
|---|---:|---:|---:|---:|
| 0 `black` | `#45475A` | `#21222C` | `#282828` | `#3B4252` |
| 1 `red` | `#F38BA8` | `#FF5555` | `#CC241D` | `#BF616A` |
| 2 `green` | `#A6E3A1` | `#50FA7B` | `#98971A` | `#A3BE8C` |
| 3 `yellow` | `#F9E2AF` | `#F1FA8C` | `#D79921` | `#EBCB8B` |
| 4 `blue` | `#89B4FA` | `#BD93F9` | `#458588` | `#81A1C1` |
| 5 `magenta` | `#F5C2E7` | `#FF79C6` | `#B16286` | `#B48EAD` |
| 6 `cyan` | `#94E2D5` | `#8BE9FD` | `#689D6A` | `#88C0D0` |
| 7 `white` | `#BAC2DE` | `#F8F8F2` | `#A89984` | `#E5E9F0` |

### ANSI 8–15

| ANSI / xterm.js field | Catppuccin Mocha | Dracula | Gruvbox Dark | Nord |
|---|---:|---:|---:|---:|
| 8 `brightBlack` | `#585B70` | `#6272A4` | `#928374` | `#4C566A` |
| 9 `brightRed` | `#F38BA8` | `#FF6E6E` | `#FB4934` | `#BF616A` |
| 10 `brightGreen` | `#A6E3A1` | `#69FF94` | `#B8BB26` | `#A3BE8C` |
| 11 `brightYellow` | `#F9E2AF` | `#FFFFA5` | `#FABD2F` | `#EBCB8B` |
| 12 `brightBlue` | `#89B4FA` | `#D6ACFF` | `#83A598` | `#81A1C1` |
| 13 `brightMagenta` | `#F5C2E7` | `#FF92DF` | `#D3869B` | `#B48EAD` |
| 14 `brightCyan` | `#94E2D5` | `#A4FFFF` | `#8EC07C` | `#8FBCBB` |
| 15 `brightWhite` | `#A6ADC8` | `#FFFFFF` | `#EBDBB2` | `#ECEFF4` |

### Primary terminal sources

- Catppuccin: official [Windows Terminal Mocha JSON](https://github.com/catppuccin/windows-terminal/blob/main/mocha.json).
- Dracula: official [Windows Terminal JSON](https://github.com/dracula/windows-terminal/blob/master/dracula.json).
- Gruvbox: original Vim source's [“Setup Terminal Colors For Neovim” block](https://github.com/morhetz/gruvbox/blob/master/colors/gruvbox.vim#L256-L277), which maps the original neutral and bright palette entries to ANSI 0–15.
- Nord: official [Xresources definition](https://github.com/nordtheme/xresources/blob/develop/src/nord), which explicitly maps nord0–nord15 to terminal foreground, background, cursor, and ANSI 0–15.

## License and reuse check

| Theme assets used | Upstream license | Source |
|---|---|---|
| Catppuccin palette + Windows Terminal port | MIT | [palette license](https://github.com/catppuccin/catppuccin/blob/main/LICENSE), [port license](https://github.com/catppuccin/windows-terminal/blob/main/LICENSE) |
| Dracula palette + Windows Terminal port | MIT | [palette license](https://github.com/dracula/dracula-theme/blob/master/LICENSE), [port license](https://github.com/dracula/windows-terminal/blob/master/LICENSE) |
| Gruvbox palette + terminal mapping | MIT/X11, as declared by the author | [official README license section](https://github.com/morhetz/gruvbox#license) |
| Nord palette + Xresources port | MIT | [palette license](https://github.com/nordtheme/nord/blob/develop/license), [port license](https://github.com/nordtheme/xresources/blob/develop/license) |

These are permissive licenses. When distributing the bundled themes, retain the relevant copyright and license notices in the app's third-party notices/source distribution. Gruvbox is the only source here without a standalone license file in the original repository; its README explicitly declares MIT/X11, so preserve the author/project attribution and the declared license reference.

## Candidates intentionally deferred

- **Solarized Dark** is enduring, complete, and MIT-licensed in the [official repository](https://github.com/altercation/solarized), but its low-contrast blue-green base overlaps Nord's restrained role in a four-theme first batch. It is the strongest fifth addition, ideally shipped together with Solarized Light.
- **Tokyo Night** is popular and has official editor/terminal files, but Catppuccin already fills the contemporary blue/purple slot. Add it after picker UX can comfortably handle more near-neighbor dark themes.
- **One Dark** remains highly recognizable, but the original [Atom One Dark UI](https://github.com/atom/one-dark-ui) does not define an official ANSI 16-color terminal palette. Bundling it would require either a Vibing-authored mapping or reliance on a third-party port, so it does not meet this first batch's source-quality bar.

## Implementation acceptance points

- GUI and terminal choices should use the same display name and palette identity but remain independently selectable, matching Vibing's current settings model.
- Add a terminal test that asserts all 21 xterm.js fields (base/cursor/selection + ANSI 16) per theme so later cleanup cannot silently reorder ANSI colors.
- Add a GUI validation/contrast smoke test for primary text, secondary text, focused controls, error text, and selected rows. Upstream syntax palettes are not a guarantee that every newly mapped GUI pair meets the intended contrast.
- Preview swatches should be ordered ANSI 0–7 then 8–15, and labels should distinguish `Catppuccin Mocha` and `Gruvbox Dark` rather than the ambiguous family names.

---

# Light pack addendum

Date: 2026-08-06

## Light-theme recommendation

Ship exactly these four light themes:

1. **Catppuccin Latte** — the contemporary pastel choice and the natural light companion to Mocha.
2. **Solarized Light** — the enduring low-glare, warm-paper choice with a first-party terminal specification.
3. **Rosé Pine Dawn** — a distinctive rose/cream palette with unusually complete first-party semantic and Windows Terminal sources.
4. **Gruvbox Light (medium)** — the retro warm choice and the natural light companion to Gruvbox Dark.

This set optimizes for visual diversity without sacrificing source quality: lavender-gray, yellowed paper/blue-green, rose cream, and earthy retro beige. Catppuccin and Gruvbox also form recognizable light/dark families with the first pack. Solarized is one of the oldest still-popular developer palettes, while Rosé Pine adds a newer but clearly differentiated option.

**GitHub Light Default** was the strongest source-quality runner-up: its official [VS Code generator](https://github.com/primer/github-vscode-theme/blob/main/src/theme.js) uses first-party Primer semantic and ANSI tokens. It is deferred because Vibing's existing light theme already occupies the neutral white/gray role, so it adds less visual choice than Rosé Pine Dawn. **Tokyo Night Day** is also first-party and complete, but the light variant is substantially less recognizable than the dark family and overlaps the cool blue/lavender role already covered by Latte.

## Light GUI semantic mapping for Vibing

As with the dark pack, this table is a **Vibing mapping decision** over exact upstream colors. Opaque hex values are copied from the official palette or official terminal port. Values marked `*` are exact alpha variants of an official source color.

| Vibing role | Catppuccin Latte | Solarized Light | Rosé Pine Dawn | Gruvbox Light |
|---|---:|---:|---:|---:|
| `bg.app` | `#DCE0E8` Crust | `#EEE8D5` base2 | `#FAF4ED` Base | `#F2E5BC` light0 soft |
| `bg.content` | `#E6E9EF` Mantle | `#FDF6E3` base3 | `#FFFAF3` Surface | `#FBF1C7` light0 |
| `bg.surface` | `#EFF1F5` Base | `#FDF6E3` base3 | `#F2E9E1` Overlay | `#EBDBB2` light1 |
| `bg.surface.hover` | `#CCD0DA` Surface0 | `#EEE8D5` base2 | `#F4EDE8` Highlight Low | `#D5C4A1` light2 |
| `bg.surface.strong` | `#BCC0CC` Surface1 | `rgb(147 161 161 / 32%)`* base1 | `#DFDAD9` Highlight Med | `#BDAE93` light3 |
| `text.primary` | `#4C4F69` Text | `#586E75` base01 | `#464261` Text | `#282828` dark0 |
| `text.secondary` | `#5C5F77` Subtext1 | `#657B83` base00 | `#575279` first-party terminal text | `#3C3836` dark1 |
| `text.strong` | `#6C6F85` Subtext0 | `#839496` base0 | `#797593` Subtle | `#504945` dark2 |
| `text.muted` | `#7C7F93` Overlay2 | `rgb(101 123 131 / 72%)`* base00 | `#9893A5` Muted | `#665C54` dark3 |
| `text.faint` | `#9CA0B0` Overlay0 | `#93A1A1` base1 | `rgb(152 147 165 / 70%)`* | `#7C6F64` dark4 |
| `accent.flame` | `#FE640B` Peach | `#CB4B16` Orange | `#EA9D34` Gold | `#AF3A03` faded orange |
| `accent.cursor` | `#8839EF` Mauve | `#268BD2` Blue | `#907AA9` Iris | `#AF3A03` faded orange |
| `accent.spark` | `#DC8A78` Rosewater | `#B58900` Yellow | `#D7827E` Rose | `#282828` dark0 |
| `accent.target` / `focus.ring` | `#1E66F5` Blue | `#268BD2` Blue | `#286983` Pine | `#076678` faded blue |
| `status.working` | `#1E66F5` Blue | `#2AA198` Cyan | `#56949F` Foam | `#076678` faded blue |
| `status.needsYou` | `#DF8E1D` Yellow | `#B58900` Yellow | `#EA9D34` Gold | `#B57614` faded yellow |
| `status.done` | `#40A02B` Green | `#859900` Green | `#286983` Pine | `#79740E` faded green |
| `status.error` | `#D20F39` Red | `#DC322F` Red | `#B4637A` Love | `#9D0006` faded red |

Mapping notes:

- Catppuccin Latte is a direct inversion of the Mocha elevation vocabulary: Crust/Mantle form the shell, Base is the main surface, and Surface0/1 are interaction states.
- Solarized officially provides only two light background elevations, base3 and base2. The stronger surface uses a 32% alpha of official base1 rather than inventing a beige.
- Rosé Pine's current palette changed Dawn `Text` to `#464261`, while its official Windows Terminal port still uses the earlier `#575279`. The GUI uses current `Text`; `text.secondary` and terminal foreground retain the first-party terminal value. This difference is intentional and documented, not a transcription error.
- Gruvbox Light uses the upstream default **medium contrast** `light0` for content. `light0_soft` is used only for the app shell, and the upstream faded accent colors are used for GUI statuses because they are designed for the light variant.

### Primary light GUI sources

- Catppuccin Latte: official [Latte palette](https://github.com/catppuccin/catppuccin#-latte).
- Solarized Light: original author's [palette values and usage relationships](https://github.com/altercation/solarized/blob/master/README.md).
- Rosé Pine Dawn: official [machine-readable palette](https://github.com/rose-pine/palette/blob/main/palette.json), including Base, Surface, Overlay, text, accents, and highlights.
- Gruvbox Light: original [absolute palette and light-mode relative-color definitions](https://github.com/morhetz/gruvbox/blob/master/colors/gruvbox.vim).

## Complete light xterm palettes

Each column below contains all 21 fields required by Vibing's current xterm theme contract: five base/cursor/selection fields plus ANSI 0–15. `purple` from Windows Terminal is mapped directly to xterm.js `magenta`; Gruvbox `aqua` is mapped to `cyan`.

### Base, cursor, and selection (5 fields)

| xterm.js field | Catppuccin Latte | Solarized Light | Rosé Pine Dawn | Gruvbox Light |
|---|---:|---:|---:|---:|
| `background` | `#EFF1F5` | `#FDF6E3` | `#FAF4ED` | `#FBF1C7` |
| `foreground` | `#4C4F69` | `#657B83` | `#575279` | `#3C3836` |
| `cursor` | `#DC8A78` | `#586E75` | `#9893A5` | `#3C3836`† |
| `cursorAccent` | `#EFF1F5`† | `#FDF6E3`† | `#FAF4ED`† | `#FBF1C7`† |
| `selectionBackground` | `#ACB0BE` | `#EEE8D5`† | `#DFDAD9` | `#BDAE93`† |

† xterm.js mapping decision. Upstream formats without a `cursorAccent` concept use the terminal background. Solarized selection uses its official light highlight base2. Gruvbox cursor uses foreground, and its Vim `bg3` visual-selection neutral becomes `selectionBackground`. Catppuccin and Rosé Pine cursor/selection values are explicit in their official Windows Terminal files.

### ANSI 0–7

| ANSI / xterm.js field | Catppuccin Latte | Solarized Light | Rosé Pine Dawn | Gruvbox Light |
|---|---:|---:|---:|---:|
| 0 `black` | `#5C5F77` | `#EEE8D5` | `#F2E9E1` | `#FBF1C7` |
| 1 `red` | `#D20F39` | `#DC322F` | `#B4637A` | `#CC241D` |
| 2 `green` | `#40A02B` | `#859900` | `#286983` | `#98971A` |
| 3 `yellow` | `#DF8E1D` | `#B58900` | `#EA9D34` | `#D79921` |
| 4 `blue` | `#1E66F5` | `#268BD2` | `#56949F` | `#458588` |
| 5 `magenta` | `#EA76CB` | `#D33682` | `#907AA9` | `#B16286` |
| 6 `cyan` | `#179299` | `#2AA198` | `#D7827E` | `#689D6A` |
| 7 `white` | `#ACB0BE` | `#073642` | `#575279` | `#7C6F64` |

### ANSI 8–15

| ANSI / xterm.js field | Catppuccin Latte | Solarized Light | Rosé Pine Dawn | Gruvbox Light |
|---|---:|---:|---:|---:|
| 8 `brightBlack` | `#ACB0BE` | `#FDF6E3` | `#797593` | `#928374` |
| 9 `brightRed` | `#D20F39` | `#CB4B16` | `#B4637A` | `#9D0006` |
| 10 `brightGreen` | `#40A02B` | `#93A1A1` | `#286983` | `#79740E` |
| 11 `brightYellow` | `#DF8E1D` | `#839496` | `#EA9D34` | `#B57614` |
| 12 `brightBlue` | `#1E66F5` | `#657B83` | `#56949F` | `#076678` |
| 13 `brightMagenta` | `#EA76CB` | `#6C71C4` | `#907AA9` | `#8F3F71` |
| 14 `brightCyan` | `#179299` | `#586E75` | `#D7827E` | `#427B58` |
| 15 `brightWhite` | `#BCC0CC` | `#002B36` | `#575279` | `#3C3836` |

Important: in Solarized and Gruvbox light variants, several ANSI “bright” entries are intentionally darker than their normal counterparts. That is the upstream light-background mapping and must not be reordered or auto-lightened.

### Primary light terminal sources

- Catppuccin Latte: official [Windows Terminal Latte JSON](https://github.com/catppuccin/windows-terminal/blob/main/latte.json).
- Solarized Light: original author's [Xresources mapping](https://github.com/altercation/solarized/blob/master/xresources/solarized), using the file's documented Light redefinition block; the first-party [Solarized Light iTerm2 file](https://github.com/altercation/solarized/blob/master/iterm2-colors-solarized/Solarized%20Light.itermcolors) corroborates terminal foreground/background behavior.
- Rosé Pine Dawn: official [Windows Terminal Dawn scheme](https://github.com/rose-pine/windows-terminal/blob/main/rose-pine-dawn.scheme.json).
- Gruvbox Light: original Vim source's [terminal ANSI block](https://github.com/morhetz/gruvbox/blob/master/colors/gruvbox.vim#L256-L277), evaluated with the same file's light-mode `bg`, `fg`, faded, and neutral definitions.

## Light-theme license and reuse check

| Theme assets used | Upstream license | Source |
|---|---|---|
| Catppuccin Latte palette + Windows Terminal port | MIT | [palette license](https://github.com/catppuccin/catppuccin/blob/main/LICENSE), [port license](https://github.com/catppuccin/windows-terminal/blob/main/LICENSE) |
| Solarized palette + terminal files | MIT | [official license](https://github.com/altercation/solarized/blob/master/LICENSE) |
| Rosé Pine palette + Windows Terminal port | MIT | [palette license](https://github.com/rose-pine/palette/blob/main/LICENSE), [port license](https://github.com/rose-pine/windows-terminal/blob/main/LICENSE) |
| Gruvbox palette + terminal mapping | MIT/X11, as declared by the author | [official README license section](https://github.com/morhetz/gruvbox#license) |

All four are permissively licensed. Preserve the upstream copyright/license notices in Vibing's third-party notices/source distribution. As noted for the dark pack, Gruvbox declares MIT/X11 in its official README but does not include a standalone license file, so retain the project/author attribution and declared license reference.

## Light-pack acceptance points

- Use the exact terminal fields above as fixtures. In particular, do not assume bright ANSI colors have greater luminance on light themes.
- Pair display names explicitly: `Catppuccin Latte`, `Solarized Light`, `Rosé Pine Dawn`, and `Gruvbox Light`; avoid family-only labels.
- Run contrast smoke tests against the actual mapped GUI surfaces. Solarized intentionally has restrained contrast, while Rosé Pine's terminal foreground intentionally differs from its current GUI `Text` token.
- Keep GUI and terminal selection independent, as the current settings model allows, even though the names form a coordinated pack.
