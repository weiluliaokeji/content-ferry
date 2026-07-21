# ContentFerry

面向 Windows 单机版的 AI 自媒体内容创作、发布与运营工作流。

## 当前阶段

已完成工程脚手架和首个账号管理闭环：Electron 桌面应用、React 界面、本地 Fastify API、SQLite 数据库，以及微信公众号/CSDN 多账号的本地管理。

- 首次运行会创建“我的内容工作台”；可添加多个微信公众号或 CSDN 账号。
- 账号定位、目标读者、禁用话题、写作风格和常用栏目已有持久化模型与 API，供后续创作流程使用。
- 已通过 ContentFerry 自有模型适配层接入 OpenAI Codex；复用本机 ChatGPT/Codex 登录，不安装或依赖 Hermes Agent。首次生成提纲和正文时调用真实模型，结果经用户确认后才保存。
- 提纲与正文默认使用可视化 Markdown 编辑器；底层仍保存标准 Markdown，但普通用户无需直接编辑 Markdown 标记。
- 账号凭据按用途独立使用 Windows 的安全存储加密后保存；读取接口只暴露“是否已配置”，不会回显密钥。
- 微信回调端点目前固定返回 `503`。在安全模式验签、事件持久化、去重和发布任务关联完成前，**不得**把它配置为生产公众号回调地址。

## 本地启动

```powershell
npm install
npm run dev
```

开发环境会启动桌面窗口、本地 API（`127.0.0.1:4317`）和前端开发服务。

启动开发应用时会自动为 Electron 重建 SQLite 驱动；如果切换了 Electron 或 Node 版本，可运行 `npm run rebuild:native` 后再启动。自动化测试使用相同的 Electron 运行时，因此不需要为了测试而关闭桌面应用。

开发页面固定使用 `http://127.0.0.1:5175/`。如果该端口被其他程序占用，启动会停止并提示错误，而不会悄悄改用其他端口；关闭原先的开发进程后重新运行即可。

不要把 AppSecret、公众号回调 Token、EncodingAESKey、Gitee Token、Cloudflare 凭据或浏览器 Cookie 写入仓库、`.env.example`、日志或 Markdown。

设计与验证文档位于 [spec](spec/)。
