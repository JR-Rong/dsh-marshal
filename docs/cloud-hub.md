# 独立云端 Hub

`marshal-hub` 复用桌面插件的 Hub 逻辑，只承载管理页面、HTTPS API 和 WSS 中转，不需要安装 DeepSeek Harness，不运行 Codex 或 Claude。模型调用仍由每台 Mac 执行。

构建后启动：

```sh
node lib/src/bin/hub.js /var/lib/dsh-marshal/hub.json /var/lib/dsh-marshal/server-cert.pem /var/lib/dsh-marshal/server-key.pem 48443
```

要求 Node.js 24+，运行依赖为 `ws` 和 `zod`。TLS 必填，不提供明文监听模式。服务默认监听 `0.0.0.0:48443`；公网只需放行该 TCP 端口。`GET /marshal/health` 只返回服务存活状态，设备与会话 API 仍需认证。

`hub.json` 使用现有配置字段：`role: "hub"`、随机 `dashboardToken`、准确的 HTTPS `publicOrigin`、绝对路径 `devicesFile`。可使用可信公共证书，或使用已经由客户端信任的私有 CA 签发证书。证书 SAN 必须覆盖连接地址；不得关闭证书或主机名校验。私有 CA 的签名密钥不应部署到服务器。

当前私人部署启用了 `accountLogin: true` 与已核实的 `dshAccountHash`，两台 Mac 也启用 `accountLogin`。日常在 DSH 插件中使用当前账号进入；管理令牌保留供后台运维，浏览器不再接受旧 token 登录表单。账号验证方式、边界和回退见[账号与调度空间](account-workspaces.md)。

迁移已有 Hub 时，复制设备表和 `identity.json`，保留 `operatorId`、设备令牌摘要及策略版本；只将 `identity.json` 的 `devicesPath` 更新为云端设备表的绝对路径。保留各节点的 journal 和设备 ID。节点切换 `hubUrl` 后会重新建立同步屏障；不要把旧的浏览器订阅当作仍然有效。

Linux 可使用 [systemd 单元](../deploy/dsh-marshal.service)：创建无登录权限的 `dsh-marshal` 用户，将密钥、身份及配置置于该用户所有的 `0700` 状态目录，文件为 `0600`；代码和运行时由 root 管理、服务用户只读。根据实际安装的 Node 版本调整单元中的运行时路径。服务限制为最多 256 MiB 内存，并由 systemd 在失败后重启。

本次云端部署采用 `https://hub.example.com/marshal`，通过已有 Caddy 的 443 端口转发。上面的 systemd 单元在端口之后追加 `127.0.0.1`，使 Hub 的 48443 仅绑定回环地址；公网不需要开放该端口。[Caddy 站点片段](../deploy/dsh-marshal.caddy) 仅接管该 IP 的 `/marshal` 路径，其他站点保持原配置。IP 客户端可能不发送 SNI，因此 Caddy 顶层全局配置设置 `default_sni hub.example.com`；域名客户端继续按自己的 SNI 选站点。前端和上游 TLS 都校验证书。服务端已有 Caddy 2.6.2，片段使用该版本支持的 `tls_trusted_ca_certs`；升级 Caddy 时按对应版本文档检查配置兼容性。

现有服务器 Caddyfile 修改前须备份、检查配置、平滑 reload，并验证原站点响应。本次备份为 `/etc/caddy/Caddyfile.before-dsh-marshal-20261031`。证书和站点密钥的 Caddy 副本位于 `/etc/caddy/dsh-marshal/`，私钥只允许 root 与 caddy 组读取。CA 签名私钥仍留在安装管理机。

切换顺序：先部署并验证云端证书、健康检查和无认证访问被拒绝，再逐台备份和更新 Mac 的 `hubUrl`，核对两个节点同步、指令去重和原生模型完成事件，最后停用旧的本机 Hub 启动项。不要同时改变隐私策略。回退时恢复每台 Mac 的原 Hub 地址并启动原服务；保留两侧状态文件，避免丢失身份或误重发指令。

公网入口现使用 Let's Encrypt 短有效期 IP 证书；Caddy→Hub 的回环上游继续使用原私有证书和指定 CA。节点已移除 `hubCaFile`，使用系统默认信任链和主机名校验。旧 CA 和配置备份保留用于回退。

Certbot 5.9.0 安装在 `/opt/dsh-marshal/certbot`，使用原 Caddy 已注册 ACME 账号。HTTP `/.well-known/acme-challenge/*` 从 `/var/www/dsh-marshal-acme` 提供验证文件，其他路径保持原重定向。官方依据：[Certbot IP 证书说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)。

[dsh-marshal-cert-renew.timer](../deploy/dsh-marshal-cert-renew.timer) 每 6 小时运行续期检查，随机延迟最多 15 分钟；[renew-ip-cert.sh](../deploy/renew-ip-cert.sh) 成功续期后安装 root:caddy 0640 证书、校验配置并平滑 reload。服务器的 service drop-in 为 Certbot 指定本机 HTTP 代理 `127.0.0.1:7890`，因直连 ACME 超时。已验证首次签发、部署 hook、定时器和一次未到期续签检查；未来自动续签依赖代理、80 端口验证路径及 ACME 服务可用，尚未跨到期窗口观察。公网证书当前到期时间：2026-11-07 23:20:28 UTC。

检查：`systemctl status dsh-marshal-cert-renew.timer`、`journalctl -u dsh-marshal-cert-renew.service`。不要关闭 TLS 校验。
