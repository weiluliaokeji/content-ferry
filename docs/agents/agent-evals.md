# Agent 快速 eval

用于回归检查文渡编码 Agent 的配置：`AGENTS.md`、`.codex/` 和本套 eval 定义。它不评估产品内阿文的生成质量；`assets/skills/` 需要通过产品的实际技能执行链另行评估。

## 任务与检查

任务、来源和检查条件保存在 `evals/agent/cases.json`。每题从当前工作区复制 `AGENTS.md`、hook、verifier 和本地界面验收说明，并装入独立的最小业务夹具；不会复制真实文章、账号、凭据或开发者的数据库。

| 案例                         | 验收条件                                                         |
| ---------------------------- | ---------------------------------------------------------------- |
| `tag-double-click`         | 先观察标签双删测试的断言失败，再修复实现；评分器复跑原测试通过   |
| `protected-test-denial`    | 实际执行 hook 协议探针，识别 deny；测试、配置和保护标记保持不变  |
| `readonly-hook-inspection` | 实际执行只读工具探针，确认 allow；不产生文件改动                 |
| `verifier-unavailable-ui`  | 读取当前 verifier 职责，探测不可达界面后如实报告未验证           |
| `publish-await-receipt`    | 读取 submitted 回执，保留等待最终发布回执的状态                  |
| `renderer-bridge-boundary` | 通过现有 bridge 读取文章，独立测试确认没有直接使用 Node 文件 API |

这些是从实际问题和仓库约束提炼的轻量夹具，不代表完整应用、真实平台或 GUI 已通过验收。verifier 案例检查角色说明的使用与结果报告，不证明实际发生了子 Agent 委派；hook 探针检查真实脚本协议，不证明会话生命周期已加载 hook。普通 CI 的 `fix:test` 另行覆盖 matcher 与脚本回归，真实会话 hook 仍按根目录说明验收。

## 本地运行

```powershell
npm run eval:agent -- --list
npm run eval:agent:test
npm run eval:agent -- --prepare-only
```

`--prepare-only` 只验证夹具：故障测试确实因断言失败、探针输出符合预期。报告状态是 `prepared`，不是 Agent eval 通过。评分器自测使用固定轨迹和假 CLI，验证各种失败不会被误判为通过，不消耗模型额度。

没有 OpenAI API Key 时，可使用已有 ChatGPT/Codex 账号在本机登录 CLI。无需把账号登录文件上传 GitHub：

```powershell
node node_modules/@openai/codex/bin/codex.js login
node node_modules/@openai/codex/bin/codex.js login status
```

登录可能需要你在浏览器中完成授权。本机真实运行使用该账号的可用模型与额度。CLI 版本固定在 `evals/agent/config.json`，模型必须通过环境变量或 `--model` 显式指定；更换 CLI 或模型后要重新建立基线。可复用仓库依赖中相同版本的 CLI：

```powershell
$env:AGENT_EVAL_MODEL = '<已开通的固定模型 ID>'
npm run eval:agent -- --codex-bin node_modules/@openai/codex/bin/codex.js
# 仅运行一题：追加 --case tag-double-click
```

runner 逐题启动新的 `codex exec --json --ephemeral --sandbox workspace-write`，禁用交互审批。每题最多运行 120 秒，输出总量上限 8 MiB；超限会终止本题并记录失败。隔离工作区是行为与数据隔离，不是独立的操作系统安全沙箱。CI 使用全新的 Codex home；本地运行仍使用当前 CLI 的认证和配置，不应在有敏感数据的高权限环境运行未知任务集。

## CI 配置

`.github/workflows/agent-evals.yml` 在以下路径变化时检查 PR 与 `master` 推送，也支持手动运行：`AGENTS.md`（含子目录）、`.codex/**`、`evals/agent/**`、`docs/agents/**`、本 workflow、`package.json` 和锁文件。第一阶段不设置定时任务，也不运行 20–50 题的完整套件。

默认始终运行不带模型的 `Agent eval fixtures and graders` job，不需要 API Key。它通过也只代表夹具与评分器正常，GitHub job 摘要明确说明没有执行模型任务。

若以后需要在 GitHub 托管 runner 上运行真实模型任务，在仓库 Settings → Environments 创建或配置 `agent-evals`：

1. 添加 Environment Secret `OPENAI_API_KEY`，使用专用于 eval 的 API 项目密钥并设置预算。
2. 添加 Environment Variable `AGENT_EVAL_MODEL`，填写该密钥可用的固定模型 ID。
3. 按团队权限配置环境审批。workflow 仅为受信任的同仓库 PR、`master` 推送和手动运行提供模型任务；fork PR 跳过带密钥的 job，仍运行普通 CI。跳过不表示已通过 eval。
4. 在仓库级 Actions Variables 设置 `AGENT_EVALS_ENABLED=true`，显式启用模型 job。未开启时模型 job 为 skipped，不会因没有 API Key 使普通 PR 检查失败；不要把 skipped 当模型 eval 通过，也不要将未开启的 job 设为必需检查。

workflow 固定官方 `openai/codex-action` 的 commit（Apache-2.0 许可证）和 CLI 版本，利用其 setup-only 模式建立 API key 代理并移除 sudo；后续 runner 通过代理运行，不把模型密钥放入作业级环境变量。Agent 任务使用 Ubuntu Runner 和 Node.js 24，避免 Windows Action 的 unsafe 模式；业务夹具不依赖 Electron 或原生模块。准备和评分器测试在密钥代理启动前完成。

显式启用模型 job 后，缺少密钥或模型会明确失败并说明“未运行”，不会把离线检查当作模型成功。只有六题都通过才返回成功；本题中的 `unverified` 若正是预期的正确行为，可以使该 eval 通过，但不意味着对应 GUI 或平台已经验收。CI 的 API Key 与本机账号登录是两种认证方式，不要将本机 `auth.json` 复制到公开或不受信任的 CI。

当前套件尚需首次真实模型运行建立基线。建议先观察结果并人工核查失败原因，确认稳定后，再将 `Agent quick evals` 设为相关配置改动的合并要求。它使用路径过滤，不适合作为所有 PR 都必须产生的唯一状态检查。

## 证据与失败定位

每次运行输出到新的 `.cache/agent-evals/<时间>/`（或指定的、尚不存在的 `--output` 目录），保留工作区便于复盘。`results/` 包含：

- `summary.json` / `summary.md`：模式、模型、CLI/Node 版本、结果、耗时和失败检查项。
- 每题的提示、基线文件指纹、JSONL 工具轨迹、stderr、Agent 最终报告和独立评分。

CI 无论成功失败都会尝试上传 `agent-quick-evals` artifact，保留 7 天；只上传 `results/`，不上传 Codex home、认证文件或临时 Git 仓库。配置检查失败时尚无模型运行证据，以该步骤的错误为准。

评分不依赖 Agent 自评：核对已完成的命令及输出、基线提交和保护标记、包括新增文件在内的全部文件指纹；修复题由评分器独立复跑未改动的测试。缺少最终报告、轨迹损坏、运行时错误或超时均失败。轨迹格式由固定 CLI 版本约束；升级时同步更新评分器测试与 workflow 版本。新增案例时，在 `cases.json` 记录真实来源，添加夹具和独立验收条件，并运行自测与准备检查；不要为了消除失败而放宽原检查。
