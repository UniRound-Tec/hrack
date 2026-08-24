# HRack Remote DSH D5 发布清单

> 对应规格：[HRack Remote DSH Web Tunnel](./SPEC-REMOTE-DSH-WEB-TUNNEL.md#20-d5-发布关门执行记录)
> 状态：执行中；自动化、生产 Server 与替代域名门槛已通过，实体设备和正式 DSH 域名待完成。

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
- [ ] `dsh.hrack.modplex.app` DNS 指向生产主机
- [ ] 正式域名签发证书、切换 `DSH_PUBLIC_ORIGIN` 并复跑公网门禁

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

## E. 实体设备

- [x] Android 模拟器真实公网全链复跑，软键盘已显示，后台恢复同一 WebView/工作区为 2,945 ms
- [x] 本轮首次加载 16,089 ms、列表重进 4,529 ms，性能按实记录
- [x] 外链只有用户确认后才交给系统浏览器
- [x] iOS Hermes/资源导出通过：5 个产物、3,638,632 字节
- [x] 物理模式要求显式设备序列号，并拒绝 `ro.kernel.qemu=1`
- [ ] Android 物理真机从不同公网加载真实 DSH WebView
- [ ] Android 物理真机验证软键盘、safe area、后台恢复和外链
- [ ] iPhone/iPad 物理真机从不同公网加载真实 DSH WebView
- [ ] iPhone/iPad 物理真机验证软键盘、safe area、后台恢复和外链
- [ ] 两个平台均验证 browse picker、空白 session、双 event WS 与 PTY 并行

真机运行同一公网门禁时必须额外设置：

```text
HRACK_ANDROID_SERIAL=<adb devices 显示的真机序列号>
HRACK_DSH_REQUIRE_PHYSICAL=1
HRACK_REMOTE_DSH_D4_JOIN_URL=<从 dashboard 临时注入，不写入文件>
```

门禁输出必须为 `device=physical`；任何 `device=emulator` 或未设置物理强制开关的结果都不能
勾选本节真机条目。iOS 必须在受支持的 macOS/Xcode 签名环境安装到实体设备再执行人工矩阵，
Windows 上的 Expo export 只能保留为 bundle 预检证据。

只有 B 的正式域名两项和 E 的全部实体设备项完成后，才能把 D5 与整条 DSH 扩展轨改为“已关门”。
