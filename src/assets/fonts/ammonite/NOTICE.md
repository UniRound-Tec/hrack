# Ammonite

- 来源：M5.a 定稿原型的 `prototype/public/Ammonite-2.otf`。
- 文件校验（SHA-256）：`F7470224B6CB1F483635B00272DA43B28479CF49D5EBFB8EC470F7B7A1FE2158`。
- 用途：应用小写 `hrack` 字标；正文与界面中文仍使用 PingFang SC。
- 当前仓库未附独立字体许可证；授权与合规由项目方自行确认。

## 打包策略（必须遵守）

仓库保存原始 OTF，构建产物仅允许包含 `hrack` 所需的五个字形，并转为 woff2。
`scripts/subset-fonts.mjs` 统一生成 `HRack-brand.woff2`，构建门禁禁止
原始 OTF 进入正式产物。
