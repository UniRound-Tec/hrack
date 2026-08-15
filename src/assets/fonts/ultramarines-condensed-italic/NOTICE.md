# Ultramarines Condensed Italic

- 来源：用户提供的 `ultramarinescondital-9.ttf`。
- 文件校验（SHA-256）：`6AA2C5DE6B19C2CC45DD9235DEA26E350257C397CBF81C579B2CA8CD384AA2C8`。
- 用途：应用 `vibing` 品牌字标；正文与界面中文仍使用 PingFang SC。
- 当前仓库未附独立字体许可证；授权与合规由项目方自行确认。

## 打包策略（必须遵守）

仓库保存原始 TTF，构建产物仅允许包含 `vibing` 所需的五个唯一字形，并转为
woff2。`scripts/subset-fonts.mjs` 统一生成 `Vibing-brand.woff2`，构建门禁禁止
原始字体或旧品牌字体进入正式产物。
