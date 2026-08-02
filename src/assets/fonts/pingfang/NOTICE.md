# PingFang SC（苹方-简）

- 来源：Apple 专有字体，由项目方自备；授权与合规由项目方自行解决（见 `docs/SPEC.md` §9 M5.a 决策注记）。
- 字重：Ultralight / Thin / Light / Regular / Medium / Semibold，woff2 格式。
- 体量：完整 CJK 字库，每字重约 5 MB，共约 30 MB。
- 用途：应用界面（chrome）中文字体；终端字体仍为 Maple Mono（见 `../maple-mono`）。

## 打包策略（必须遵守）

仓库保存完整字体，**构建产物禁止全量打包**：构建期按产物实际用字做子集化
（如 fonttools `pyftsubset` 输出 woff2 子集，或按 unicode-range 切片按需加载），
未使用的字重不进产物。M5.b P4 已由 `scripts/subset-fonts.mjs` 落地：构建只输出
Regular / Medium / Semibold 三档实际用字子集，并由 `scripts/assert-font-size.mjs`
断言三档总量小于 1 MB。
