# 依赖安全审计记录

> 审计日期：2026-07-31

## 结论

- `npm audit` 报告的 16 个 high 实际均由同一漏洞沿依赖树汇总产生：
  `brace-expansion` 内存耗尽 DoS（CVE-2026-14257 / GHSA-mh99-v99m-4gvg）。
- 漏洞只存在于 `electron-builder` 的传递依赖中；`electron-builder` 是开发期打包工具，
  不进入应用运行时。
- `npm audit --omit=dev` 结果为 **0 vulnerabilities**，当前终端应用运行时不受影响。
- 当前不执行 `npm audit fix --force`：dry-run 会大幅降级并重写构建依赖，且仍不能消除
  这 16 条告警。

## 决策

1. M2–M6 继续开发，不把该告警视为发布阻断项。
2. 运行时安全门禁使用 `npm audit --omit=dev`。
3. 不可信 PR 不得在带有签名密钥的 runner 上执行安装包构建；构建任务应限制内存和超时。
4. M7 正式打包与签名前重新审计，优先等待 `electron-builder` 稳定版升级其传递依赖。
5. 如发布前上游仍未修复，再在独立分支评估 npm `overrides`，并完整验证三端打包链。

参考：https://github.com/advisories/GHSA-mh99-v99m-4gvg
