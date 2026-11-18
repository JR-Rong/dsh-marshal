# EXC-0001 · Super-agent 派发桥的本机进程信任边界

- 状态：**待皇上批准，尚未生效**
- 提出：丞相
- 日期：2026-11-18
- 关联：SPC-0001 A12、ADR-0001
- 到期：2027-02-18（或 DSH 提供宿主级会话认证时提前复审）

## 豁免项

SPC-0001 原 A12 写“agent 无法伪造触发”。本机任意进程（含 agent 的 bash）若伪造完整的 `Origin`、`Sec-Fetch-Site: same-origin`、回环 `Host` 和 JSON body，仍可调用 `/marshal-superagent/api/human-create`、`/api/config`、`/api/dispatch`，从而改路由或派发。第三轮盲审据此判 fail，要求皇上书面接受新边界或加不可伪造认证。

## 豁免后的边界

- 本桥保证：**agent 的模型工具路径**（task_board_create、只读 marshal_superagent）不能改路由/派发；正常 agent 路径不触发 human-create。
- 本桥保证：缺 Origin、cross-site、坏 Host、缺 source 的请求全部 403；配置/补派只在本机同源浏览器控制页。
- 本桥**不保证**：与本机桌面宿主同权限的进程不能伪造全部浏览器请求头。该威胁由 OS 用户隔离、DSH 宿主认证或后续 WebCrypto 签名解决，不由本桥承担。

## 补偿措施

- 模型工具只读；config/dispatch 只在控制页。
- human-create/config/dispatch 校验 Origin + Sec-Fetch-Site + 回环 Host；控制页加 X-Frame-Options/CSP frame-ancestors。
- 每次派发/配置写状态与日志；status/控制页可见；回退只需恢复备份。
- 本机进程伪造属本机安全边界；若皇上要求挡住 agent bash，下一增量改为浏览器 WebCrypto 密钥签名。

## 批准

- 批准人：皇上（待批）
- 批准方式：在 DSH 会话中书面确认“接受 EXC-0001 的 B1 边界”
- 未批准前：不把 A12 判为覆盖；盲审 verdict 保留 fail；本 EXC 不生效。
