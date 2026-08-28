# 安全政策（Security Policy）

## 支持的版本

当前仅维护 `master` 分支的最新版本。已发布的安装包请尽量升级到最新版本。

## 报告漏洞

**请勿通过公开的 GitHub Issue 报告安全漏洞。**

请通过以下方式私报告：

- 在 GitHub 仓库 `weiluliaokeji/content-ferry` 中提交 **Private Security Advisory**（推荐）：
  `Security` → `Report a vulnerability`。
- 或通过仓库 Issues 直接 `@weiluliaokeji` 说明，但**先不要公开复现细节**。

报告中请尽量包含：

- 受影响版本与运行环境（Windows 版本、安装包类型）。
- 漏洞类型与触发步骤。
- 潜在影响（凭据泄露、本地提权、数据损坏等）。

维护者会在合理时间内确认收悉，并协商修复与负责任披露的时间表。

## 范围说明

文渡运行在本机，会处理你的微信公众号 / CSDN / 博客园等平台凭据。涉及凭据存储、回调 Token、本地服务 `127.0.0.1:4317` 暴露面的问题属于高优先级。
