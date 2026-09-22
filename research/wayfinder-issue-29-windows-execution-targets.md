# Wayfinder Issue 29：Windows 本地工具执行目标与隔离能力

## 结论

本机、WSL、Docker 和 Windows Sandbox 不是可互换的“安全等级按钮”。每个目标都改变文件、网络、进程、身份、资源和可恢复性边界，因此应作为统一权限策略中的资源维度；目标切换是否需要询问，取决于有效能力是否扩大，而不是目标名称本身。

## 一手资料事实

### Windows Sandbox

Windows Sandbox 默认启用网络和剪贴板，并支持通过 `.wsb` 配置网络、主机目录映射、映射目录的读写权限以及内存等选项。主机目录映射会把主机文件暴露给沙箱，微软明确提示可写映射可能让不可信程序影响主机或窃取数据。关闭 Sandbox 后其内容会被删除，因此它适合临时、可丢弃的实验 staging。

来源：[Microsoft：Use and configure Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)

### WSL

WSL 通过 `/mnt/<drive>` 访问 Windows 文件；访问 Windows 文件时最终仍受 Windows 用户权限控制。微软还说明，从 Windows 命令行调用 `wsl.exe` 时，Linux 工具使用与调用方相同的 Windows 管理权限；WSL 也支持从 Linux 调用 Windows 工具。WSL 因此提供不同的工具链和文件系统语义，但不能默认视为 Windows Sandbox 等价的安全边界。

来源：

- [Microsoft：File permissions for WSL](https://learn.microsoft.com/en-us/windows/wsl/file-permissions)
- [Microsoft：Working across file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)
- [Microsoft：WSL FAQ](https://learn.microsoft.com/en-us/windows/wsl/faq)

### Docker

Docker 容器默认没有资源限制，可以通过 `--memory`、`--cpus` 等参数设置限制。Rootless 模式让 daemon 和容器以非 root 用户运行，可降低 daemon/runtime 漏洞影响，但是否真正隔离仍取决于镜像、挂载、网络、Docker Desktop 配置和运行参数。容器不能被当作绝对安全边界，尤其不能默认授予 privileged、宿主机网络或 Docker socket。

来源：

- [Docker：Resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
- [Docker：Rootless mode](https://docs.docker.com/engine/security/rootless/)
- [Docker：Engine security](https://docs.docker.com/engine/security/)

### Windows 本机与 Job Objects

Windows Job Objects 可以管理进程树、限制资源、统计资源使用并统一终止进程，但它们不是完整的文件系统/网络安全边界，不能把本机执行变成沙箱。ContentFerry 的 `host_trusted` 目标因此只能作为明确标注的高风险目标，并配合超时、进程树终止和输出限制。

来源：[Microsoft：Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

## 对目标切换的判断

从本机切到 WSL 做“同一授权目录的只读文件存在性检查”可以自动执行，前提是策略引擎确认：

- 归一化后的实际文件范围仍在同一授权根目录内；
- 读写方向没有从 read 变成 write；
- 网络策略没有扩大；
- 没有引入 Windows 命令互操作、sudo、依赖安装或外部写入；
- WSL distro 和实际解释器已验证可用；
- 运行记录明确记下目标切换和路径映射。

以下情况应重新询问或拒绝：切换后可访问更多主机目录、需要写入 Windows 文件、需要 sudo/管理员能力、打开网络、挂载 Docker socket、使用 privileged/host network、从隔离目标切到本机，或用目标切换规避先前的拒绝。

## 对 ContentFerry 的采用建议

1. 把 `targetType` 纳入权限请求和授权租约，而不是只在执行面板中作为用户表单字段。
2. 权限检查使用“有效能力集合”而不是只比较目标名称；目标切换后重新解析路径映射、网络、身份和副作用。
3. 允许模型提出替代目标，但只能由统一策略决定 `allow / ask / deny`；不可用目标不能静默替换为更弱或更强目标。
4. 目标不可用时返回可解释失败和可选替代方案；若替代方案已在授权范围内，可以继续，否则进入询问。
5. 所有运行记录保存目标类型、目标版本/发行版/镜像摘要、路径映射、网络策略和授权决定。

## 参考决策

该研究支持路线图 Issue 27 对 Q8 的修正：执行目标是统一权限策略中的资源维度，而不是天然要求逐次人工选择；同等能力范围内可以自动切换，跨边界才询问。
