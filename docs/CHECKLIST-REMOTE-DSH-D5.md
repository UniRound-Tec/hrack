# HRack Remote DSH D5 发布清单

> 对应规格：[HRack Remote DSH Web Tunnel](./SPEC-REMOTE-DSH-WEB-TUNNEL.md#20-d5-发布关门执行记录)
> 状态：**已关门（2026-08-24，实体设备延期并由项目所有者显式接受风险）**。正式 DSH
> 域名和 Android release 模拟器公网全链已通过；未把模拟器结果冒充 Android/iOS 物理真机。

清单只保存状态、时间、commit、耗时、大小与校验和。禁止写入配对 URL、roomId、ticket、
Cookie、Authorization、邮箱验证码、密钥、电脑路径或 DSH/PTY 正文。

## A. 代码与配置

- [x] Server `e5453ca` 已提交、推送并部署
- [x] App `6104b20`（生命周期实现 `1c427d0`）已提交、推送并构建 Android release
- [x] Relay 40、Web 131、Nginx 5、Ops 4 项通过
- [x] App 51 项、typecheck、协议/终端/UI parity 与 Android release build 通过
- [x] Server typecheck 与生产 build 通过
- [x] `DSH_PUBLIC_ORIGIN` 由环境配置并传入 Relay/monitor
- [x] 生产 DSH 代码无 `modplex.app` 硬编码

## B. 独立域名与数据面

- [x] 另一组公开域名使用受信 Let's Encrypt TLS，证书余期 89 天
- [x] ALPN 真实协商 `h2`
- [x] D4 真实首屏约 4.54 MB 长响应通过
- [x] D4 两条公网 event WebSocket 同时通过
- [x] 运行中 OpenResty server/location 均 `access_log off`
- [x] request/response buffering 关闭，长流 timeout 为 3600 秒
- [x] `dsh.hrack.dev` 的公共 DNS 指向生产主机 `38.246.237.57`
- [x] 正式域名签发受信 ECDSA 证书，有效期至 2026-11-24，主机名校验与 ALPN `h2` 通过
- [x] 证书自动续期后的复制、`openresty -t` 与热重载钩子实跑通过
- [x] `DSH_PUBLIC_ORIGIN` 已切换为正式域名；`/_healthz` 为 200，匿名根路径为 401
- [x] 正式域名 Android release 公网门禁通过：两条 event WS、browse picker、空白 session 与 PTY 并行

## C. 备份、恢复与失效

- [x] 持久房间恢复后旧 ticket 为 404
- [x] 持久房间恢复后旧 Cookie 为 401
- [x] 恢复后的新 seat 可签发新 ticket 并得到 303
- [x] 生产备份为 32,597 字节，SHA-256 为 `83e3a716ccc1c649b6fa427ba0357d9cba4c099fe890224a8d83279c24e36ce04`
- [x] 隔离卷恢复 `integrity_check=ok`，共 11 张表
- [x] 演练后 Web、Relay、协调器、monitor、DSH edge 全部恢复健康
- [x] 轮换后的账号稳定房间在 Relay 重启后仍可用

## D. 监控与日志

- [x] 生产监控真实探测 DSH TLS 与 `/_healthz`
- [x] Relay 输出 tunnel/session、HTTP/WS 并发、buffer 与双向字节
- [x] 错误只分为 `buffer`、`timeout`、`protocol`、`transport`、`upstream`
- [x] 指标与告警不含 secret/path/body/用户标识
- [x] 现网首轮及备份恢复后的周期探测均为 `ok=true`

## E. 设备验收与发布决策

- [x] Android release 模拟器经正式域名真实公网全链复跑，系统软键盘已显示
- [x] 正式域名本轮首次加载 18,378 ms、列表重进 4,519 ms、后台恢复同一 WebView/工作区 5,003 ms
- [x] 两条 event WebSocket 与真实 PTY 并行；PTY 输入 ACK 为 375 ms、385 字节
- [x] 外链只有用户确认后才交给系统浏览器
- [x] iOS Hermes/资源导出通过：5 个产物、3,638,632 字节
- [x] 物理模式要求显式设备序列号，并拒绝 `ro.kernel.qemu=1`
- [ ] Android 物理真机从不同公网加载真实 DSH WebView
- [ ] Android 物理真机验证软键盘、safe area、后台恢复和外链
- [ ] iPhone/iPad 物理真机从不同公网加载真实 DSH WebView
- [ ] iPhone/iPad 物理真机验证软键盘、safe area、后台恢复和外链
- [ ] 两个平台均验证 browse picker、空白 session、双 event WS 与 PTY 并行
- [x] 2026-08-24 项目所有者因暂时没有真机，明确同意本次以 Android 模拟器收尾并接受下列残余风险

真机运行同一公网门禁时必须额外设置：

```text
HRACK_ANDROID_SERIAL=<adb devices 显示的真机序列号>
HRACK_DSH_REQUIRE_PHYSICAL=1
HRACK_REMOTE_DSH_D4_JOIN_URL=<从 dashboard 临时注入，不写入文件>
```

门禁输出必须为 `device=physical`；任何 `device=emulator` 或未设置物理强制开关的结果都不能
勾选上面的真机条目。iOS 必须在受支持的 macOS/Xcode 签名环境安装到实体设备再执行人工矩阵，
Windows 上的 Expo export 只能保留为 bundle 预检证据。

本次豁免的残余风险是：尚未验证真实 Android/iOS 的 OEM WebView 差异、刘海/safe area、物理软键盘、
蜂窝网络切换、系统回收与 iOS 签名安装。项目所有者已明确接受这些风险，所以当前 DSH 扩展轨可以
按“正式域名 + Android release 模拟器”证据关门；真机条目保持未勾选，后续有设备时补测。该决定
只适用于本次 DSH D5 发布，不改变父 Remote P8 的物理真机关门条件，也不构成真机通过声明。

## F. 2026-08-26 域名迁移

- 官方平台切换为 `https://hrack.dev`，DSH 独立 origin 切换为
  `https://dsh.hrack.dev`；旧 `modplex.app` 入口已停用，不提供跳转或 WSS 兼容。
- 迁移前对生产数据卷停写备份，随后在保留 `roomId` 和撤销凭据的前提下
  将 2 条活动配对记录显式迁移至新 origin；SQLite `integrity_check=ok`。
- 新域名已通过正式 TLS、HTTP 边界、生产监控、匿名建房封锁、双端真实 WSS
  配对与双向帧、DSH capability origin 和 `/_healthz` 验证。
