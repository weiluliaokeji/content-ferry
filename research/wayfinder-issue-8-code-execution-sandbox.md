# Wayfinder Issue #8：受控代码执行、分级授权与实验结果证据边界

## 决策摘要

Issue #8 的最新用户修订明确了一个重要区别：**默认安全策略不是能力上限**。文渡可以支持真实的联网调研、用户已有的 Python/Node/venv/Conda 环境、WSL 和 Docker，但每一次权限扩大和执行目标切换都必须由用户明确选择和确认；不可用时只能失败并说明原因，不能静默换到更弱的目标。

因此，一期采用“分级授权执行模型”：

1. 默认使用隔离 staging、关闭网络、不安装依赖。
2. 用户可为本次任务明确选择 Windows Sandbox、本机环境、WSL 或 Docker，并在确认页看到目标的实际路径、版本和来源。
3. 网络、目录读写、依赖安装和执行目标是四个独立授权项，不能由一个“允许运行”开关隐式覆盖。
4. 所有授权和环境信息进入执行记录；实验结果只能作为带条件的 `experimental_observation`，不能自动升级为通用事实。
5. Windows Sandbox 不可用时不自动回退；本机、WSL、Docker 只有在用户主动选择、且前置检查通过时才可运行。

## 研究范围与现状

### 仓库现状

- 原始调研时，代码只在首次配置中用 `execFile` 查询 Codex 登录状态；当前已经提供文章编辑器内的“代码与工具”图形确认流程，以及独立的执行记录和权限授权接口。
- `src/main/automation/*` 中的 `BrowserWindow`/`executeJavaScript` 是页面自动化，不应被当作代码沙箱。
- 安装包不保证附带 Python/Node 运行时，Docker、WSL 也不是所有 Windows 用户的前置条件；因此必须检测并展示实际可用性，不能把主机 `PATH` 当作可靠的安全或可用承诺。
- `docs/BUILDING.md` 中的 Node/Python 是开发者构建前置，不代表普通用户已经拥有可执行研究环境。

当前已补充 `src/main/agent/execution-service.ts`、`execution-repository.ts`、`permission-grant-repository.ts`、`git-source-service.ts` 与 `/api/execution/*` 接口：支持显式确认的本机、WSL、Docker、Windows Sandbox 结构化 argv 运行、超时/输出限制、目录授权检查、权限持久化、重启中断恢复和产物 hash 持久化；编辑器提供确认页和 Git 公开仓库浅克隆入口。目标不可用或网络策略不能强制执行时会明确失败，不会回退到本机。

### 权威资料依据

- Windows Sandbox 是可丢弃的 Hyper-V 隔离环境，Windows Home 不支持；微软还说明网络默认开启，应用必须在 `.wsb` 中显式关闭或按本次授权开启：[Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/)、[配置 Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)。
- `.wsb` 可以配置 Networking、MappedFolders、ClipboardRedirection 和 MemoryInMB。映射目录应限制在本次 staging，并明确只读/可写。
- Windows Job Objects 可以管理进程组、工作集、CPU 率、优先级和结束时间，但它不是完整的安全边界，不能替代 VM/容器隔离：[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。
- Docker 默认没有资源上限，必须显式配置内存和 CPU；rootless 模式让 daemon 和容器以非 root 用户运行，可减少 daemon/runtime 漏洞影响：[资源约束](https://docs.docker.com/engine/containers/resource_constraints/)、[Rootless mode](https://docs.docker.com/engine/security/rootless/)、[运行容器](https://docs.docker.com/engine/containers/run/)。
- WSL 默认把 Windows 盘挂载到 `/mnt/<drive>`，Windows 文件的权限会按 Windows 权限映射；Linux 文件系统和 Windows 文件系统的读写边界不同：[WSL 文件权限](https://learn.microsoft.com/en-us/windows/wsl/file-permissions)、[WSL 互操作](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop)。WSL 不是与 Windows Sandbox 等价的安全边界。
- Python `venv` 在已有 Python 上创建独立环境，`pyvenv.cfg` 和解释器路径可以用于识别环境来源；环境不应写入源码库：[Python venv](https://docs.python.org/3/library/venv.html)。

## 分级执行目标

目标是用户明确选择的资源边界，不是“检测到哪个就自动用哪个”。执行记录必须保存 `targetType`、规范化目标标识、实际解释器路径/版本或镜像摘要、可用性检查和确认时间。

| 目标 | 适用场景 | 默认风险提示 | 一期边界 |
|---|---|---|---|
| `windows_sandbox` | 可信度最高的隔离 demo | 需要 Windows Pro/Enterprise/Education 与已启用 Sandbox | 支持 staging、资源限制和显式网络授权 |
| `host_trusted` | 用户已有系统 Python/Node、venv/Conda，必须调用本机工具 | 不是安全沙箱；进程理论上可访问主机其它资源 | 明确标注“本机高风险”，使用 watchdog/Job Object 附加防护 |
| `wsl` | 用户指定的 WSL 发行版和 Linux 工具链 | 与 Windows 文件互操作，隔离弱于 Sandbox | 仅用户明确选中的 distro；默认在 distro 文件系统的临时 staging 运行 |
| `docker` | 用户已有 Docker Engine/Desktop 和固定镜像 | 容器不是绝对安全边界，错误挂载/特权参数会扩大风险 | 禁止 privileged、Docker socket 和 host network；固定资源与挂载 |

缺少目标运行时、发行版、镜像或权限时，返回“目标不可用及修复办法”，不得自动尝试下一目标。用户之后可以重新选择另一个目标并重新确认。

### 环境识别

执行前必须展示实际环境，而不是只显示“Python/Node 已找到”：

- Python：规范化 `sys.executable`、`sys.version`、`sys.prefix`/`sys.base_prefix`，检查 `pyvenv.cfg`；Conda 记录环境目录、名称和 `conda` 来源。
- Node：记录 `process.execPath`、`node --version` 和环境目录；不接受仅凭 PATH 的模糊名称。
- WSL：记录 distro 名、WSL 版本、Linux `python`/`node` 的实际路径与版本；默认使用 `/home/.../staging`，不直接把整个 `/mnt/c` 暴露给任务。
- Docker：记录 daemon/engine 版本、镜像引用和 digest、rootless 状态、运行参数摘要；没有可验证 digest 的浮动镜像只能明确标为不可复现或需用户确认。

## 分级授权模型

一次执行至少有以下独立授权状态，任何一项改变都需要重新确认：

### A. 执行目标授权

确认页显示目标类型、目标版本、解释器或镜像、工作目录和风险说明。切换到本机、WSL 或 Docker 不是 Sandbox 的自动降级，而是用户的新选择。

### B. 文件授权

默认只提供本次运行的 staging：输入只读，输出目录可写。用户可选择额外目录和读写方向，但必须逐目录确认。文章库默认只读；允许写回时另设确认，并建议先生成快照/备份。

路径处理必须规范化并拒绝越界、绝对路径注入、符号链接/junction 绕过和宽泛的用户目录映射。默认不暴露数据库、`%APPDATA%`、浏览器 profile、`.ssh`、Cookie、凭据目录或整个 Git 工作区。本机目标无法提供绝对文件隔离，确认页必须明确这一限制。

### C. 网络授权

网络等级独立于模型连接配置：

- `disabled`：默认关闭网络。
- `allowlist`：用户逐次指定 HTTPS 域名；默认拒绝 localhost、私网和 LAN 地址，显示解析后的目标域名；可选使用用户明确选择的检索代理。
- `direct`：用户明确选择的直连高风险模式；提示可能访问局域网/私网，并记录为高风险授权。

不能静默继承主进程的 `HTTP_PROXY`、`HTTPS_PROXY`、模型代理、Cookie 或环境变量；必须把代理类型/地址（脱敏）和域名策略写入执行记录。研究网页检索与代码 demo 的网络权限分开确认。

### D. 依赖安装授权

默认不自动安装。阿文可以先给出安装计划，用户逐条确认后才执行。确认项至少包含：目标环境、包管理器、完整结构化 argv、包名与精确版本/范围、registry 或下载来源、预计修改目录、许可证和是否会运行安装脚本。

优先创建一次性 venv/Conda 环境或使用固定 Docker 镜像；修改用户现有环境是单独的高风险选项。部分安装、锁文件变化和失败必须单独记录，不能自动重试或悄悄切换环境。第一期不允许由模型直接拼接 shell 字符串，也不默认执行未知的 `postinstall`/安装脚本。

## 执行前确认页

每次运行都显示并要求明确确认：

- 任务和源码/输入 snapshot 的 SHA-256；
- 执行目标、实际解释器路径/版本或镜像 digest；
- 规范化 argv、工作目录和 staging 路径；
- 目录授权清单及读写方向；
- 网络等级、域名白名单和代理模式；
- 依赖安装计划、命令、来源、许可证和影响；
- CPU/内存/墙钟/输出限制；
- 会注入的公开环境变量键名（不展示或注入密钥）；
- 失败、取消、超时和应用重启后的处理方式。

阿文只能生成计划和解释风险，不能代替用户确认。确认仅对本次 run 有效，不形成对未知项目、命令或网络的永久信任。

## 资源限制与失败语义

一期的默认上限可以按目标适配，但必须显式落入执行记录：

| 项目 | Sandbox 默认值 | WSL/host/Docker 初始值 |
|---|---:|---:|
| 单次墙钟时间 | 60 秒 | 60 秒；用户可在确认页提高 |
| 输入 staging | 20 MiB / 200 文件 | 同等默认上限 |
| stdout + stderr | 1 MiB | 同等默认上限 |
| 输出文件 | 10 MiB / 50 文件 | 同等默认上限 |
| 并发 | 每个工作区 1 个 | 每个工作区 1 个 |
| 内存 | Sandbox 配置 2048 MiB 起步 | Docker 使用 `--memory`；WSL/host 仅 watchdog，不能声称精确配额 |
| CPU | Sandbox 不宣称精确配额 | Docker 使用 `--cpus`；WSL/host 使用 Job Object/监控但标记为近似 |

取消、超时、输出超限、进程树异常、Sandbox 丢失和应用重启分别记录为可区分状态；不把部分输出或网络失败伪装为成功。应用重启后标记 `interrupted`，保留 staging 和部分 artifact，由用户重新确认并重跑，不自动恢复有副作用的任务。

## 证据与文章追溯模型

执行结果独立于普通运行日志保存。建议 `execution_runs` 增加：

- `target_type`、目标指纹、解释器/镜像版本；
- `network_policy`、白名单和代理模式摘要；
- `directory_grants`（路径哈希、读写方向）；
- `dependency_plan`、逐项批准和部分安装状态；
- 用户确认时间、策略配置 hash、状态和退出码。

`execution_artifacts` 保存 source/input/stdout/stderr/output 的大小、SHA-256、截断标记、保留期限和敏感标记。stdout/stderr 不进入普通运行日志，也不自动发送给模型。

实验 claim 的固定证据链为：

`execution_run → source/input snapshot → code hash → argv/runtime/target/policy → output artifact hash → claim`

统一使用 `experimental_observation`：它只能描述“在指定目标、版本、输入、时间和限制下观察到……”，不自动等价于源码事实、性能保证、兼容性或安全结论。只有用户在资料卡中接受实验结果后，claim 才能进入提纲/正文；文章中应保留“实验观察”标签、复现条件和引用入口。用户选择“让阿文分析结果”时，发送前展示选中的 artifact 范围。

## 一期最小边界

不把一期做成通用 CI 或任意远程执行器。最小可实施范围是：

1. 建立统一 `execution target`、`network policy`、`directory grant`、`dependency approval` 和证据记录模型。
2. 做好目标探测和前置检查：Windows Sandbox、指定本机解释器/venv/Conda、指定 WSL distro、指定 Docker 引擎/镜像分别可见；不可用时可解释失败，不切换目标。
3. 提供一个结构化 argv 的 runner 入口和确认页；初期只支持有限的 Python/Node demo 或用户明确选择的工具，不接受任意 shell 文本。
4. 先实现 staging 输入、独立输出、取消/超时/输出限制和 `experimental_observation` 追溯。
5. 网络开启、目录写入、依赖安装、目标切换分别确认；依赖计划与执行状态可审计。
6. Sandbox、Docker、WSL、host 采用不同 adapter；不通过“检测到不可用就换下一个”来实现兼容性。

以下不属于一期默认能力，但可以在同一授权模型上扩展：私有仓库凭据、自动维护用户环境、多次基准测试、任意编译链、GPU、远程执行和跨机器任务调度。

## 验收标准

1. 用户能够选择 Sandbox、本机、WSL 或 Docker；界面显示实际路径/版本/环境来源，目标不可用时不静默替换。
2. 用户能分别确认执行、网络、目录写入和依赖安装；默认仍是隔离 staging、断网、不安装依赖。
3. 运行记录能复原目标、argv、源码/input hash、目录和网络策略、依赖审批、资源限制与输出 artifact。
4. 失败、取消、超时、部分安装、Sandbox/容器丢失和应用重启都有可读状态，不自动重跑。
5. 文章中的实验论点能够回到执行记录和 artifact hash，并明确实验条件和证据边界。

## 参考资料

- [Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/)
- [Use and configure Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)
- [Docker run](https://docs.docker.com/engine/containers/run/)
- [WSL file permissions](https://learn.microsoft.com/en-us/windows/wsl/file-permissions)
- [WSL interoperability](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop)
- [Python venv](https://docs.python.org/3/library/venv.html)
