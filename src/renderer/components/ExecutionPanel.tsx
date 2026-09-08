import { useEffect, useState } from "react";
import { request } from "../api";

type Runtime = "python" | "node" | "git" | "custom";
type Target = "host_trusted" | "wsl" | "docker" | "windows_sandbox";
type NetworkPolicy = "disabled" | "allowlist" | "direct";

interface ExecutionPreflight {
  available: boolean;
  targetType: Target;
  executable: string;
  resolvedCwd: string;
  warnings: string[];
  reason?: string;
}

interface ExecutionRun {
  id?: string;
  status: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  artifacts: Array<{ path: string; size: number; sha256: string }>;
  errorMessage?: string;
}

interface SystemTool {
  id: string;
  path: string;
  version: string;
  capabilities: string[];
}

interface PermissionGrant {
  id: string;
  scope: string;
  decision: string;
  toolId?: string;
  action?: string;
  targetPrefix?: string;
  expiresAt?: string;
}

interface GitSourceResult {
  clone: { id: string; status: string };
  commitSha: string;
  repositoryUrl: string;
  files: string[];
}

interface GitAnalysisResult {
  run: { id: string };
  commitSha: string;
  repositoryUrl: string;
  files: Array<{ path: string; lineCount: number; lineStart: number; lineEnd: number; excerpt: string; sha256: string; runId: string }>;
}

export function ExecutionPanel({ projectId, onError, onInsertCitation, onClose }: { projectId?: string; onError: (message: string) => void; onInsertCitation?: (text: string) => void; onClose?: () => void }) {
  const [runtime, setRuntime] = useState<Runtime>("python");
  const [targetType, setTargetType] = useState<Target>("host_trusted");
  const [wslDistribution, setWslDistribution] = useState("");
  const [dockerImage, setDockerImage] = useState("");
  const [dockerMemoryInMb, setDockerMemoryInMb] = useState("2048");
  const [dockerCpus, setDockerCpus] = useState("2");
  const [dockerPidsLimit, setDockerPidsLimit] = useState("256");
  const [sandboxMemoryInMb, setSandboxMemoryInMb] = useState("2048");
  const [executable, setExecutable] = useState("");
  const [argsText, setArgsText] = useState("--version");
  const [cwd, setCwd] = useState("");
  const [grantPath, setGrantPath] = useState("");
  const [grantAccess, setGrantAccess] = useState<"read" | "write">("read");
  const [networkPolicy, setNetworkPolicy] = useState<NetworkPolicy>("disabled");
  const [allowedHosts, setAllowedHosts] = useState("");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [acknowledgeHostRisk, setAcknowledgeHostRisk] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preflight, setPreflight] = useState<ExecutionPreflight>();
  const [run, setRun] = useState<ExecutionRun>();
  const [observationTitle, setObservationTitle] = useState("");
  const [observationClaim, setObservationClaim] = useState("");
  const [observationSaved, setObservationSaved] = useState(false);
  const [systemTools, setSystemTools] = useState<SystemTool[]>([]);
  const [permissionGrants, setPermissionGrants] = useState<PermissionGrant[]>([]);
  const [grantScope, setGrantScope] = useState<"global" | "project">(projectId ? "project" : "global");
  const [selectedGrantPath, setSelectedGrantPath] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitDestination, setGitDestination] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitResult, setGitResult] = useState<GitSourceResult>();
  const [gitAnalysis, setGitAnalysis] = useState<GitAnalysisResult>();

  useEffect(() => {
    void request<{ items: SystemTool[] }>("/tools/system").then((result) => setSystemTools(result.items)).catch(() => setSystemTools([]));
    void request<{ items: PermissionGrant[] }>(`/agent/permissions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`).then((result) => setPermissionGrants(result.items)).catch(() => setPermissionGrants([]));
  }, [projectId]);

  const buildRequest = () => ({
    ...(projectId ? { projectId } : {}),
    targetType,
    runtime,
    ...(executable.trim() ? { executable: executable.trim() } : {}),
    args: argsText.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean),
    cwd: cwd.trim(),
    directoryGrants: [{ path: (grantPath || cwd).trim(), access: grantAccess }],
    networkPolicy,
    ...(networkPolicy === "allowlist" ? { allowedHosts: allowedHosts.split(/[,\n]/).map((host) => host.trim()).filter(Boolean) } : {}),
    ...(outputDirectory.trim() ? { outputDirectory: outputDirectory.trim() } : {}),
    ...(targetType === "wsl" && wslDistribution.trim() ? { targetOptions: { wslDistribution: wslDistribution.trim() } } : {}),
    ...(targetType === "docker" ? { targetOptions: { dockerImage: dockerImage.trim(), dockerMemoryInMb: Number(dockerMemoryInMb) || 2048, dockerCpus: Number(dockerCpus) || 2, dockerPidsLimit: Number(dockerPidsLimit) || 256 } } : {}),
    ...(targetType === "windows_sandbox" ? { targetOptions: { sandboxMemoryInMb: Number(sandboxMemoryInMb) || 2048 } } : {}),
    confirmed,
    acknowledgeHostRisk
  });

  const check = async () => {
    setBusy(true);
    setRun(undefined);
    try {
      const result = await request<ExecutionPreflight>("/execution/preflight", { method: "POST", body: JSON.stringify(buildRequest()) });
      setPreflight(result);
      if (!result.available) onError(result.reason ?? "当前执行目标不可用。");
    } catch (error) {
      onError(error instanceof Error ? error.message : "执行前置检查失败。");
    } finally { setBusy(false); }
  };

  const execute = async () => {
    setBusy(true);
    try {
      const result = await request<{ run: ExecutionRun }>("/execution/run", { method: "POST", body: JSON.stringify(buildRequest()) });
      setRun(result.run);
      setObservationTitle(`${runtime} 执行观察`);
      setObservationClaim(result.run.status === "completed" ? "请填写这次运行实际验证出的结论。" : "");
    } catch (error) {
      onError(error instanceof Error ? error.message : "代码执行失败。");
    } finally { setConfirmed(false); setBusy(false); }
  };

  const saveObservation = async () => {
    if (!run?.id || !observationTitle.trim() || !observationClaim.trim()) return;
    try {
      await request(`/execution/runs/${run.id}/observation`, { method: "POST", body: JSON.stringify({ title: observationTitle.trim(), claim: observationClaim.trim() }) });
      setObservationSaved(true);
    } catch (error) { onError(error instanceof Error ? error.message : "保存实验观察失败。"); }
  };

  const cloneGitSource = async () => {
    if (!gitUrl.trim() || !gitDestination.trim() || !projectId) return;
    setBusy(true);
    try {
      const result = await request<GitSourceResult>("/execution/git/clone", {
        method: "POST",
        body: JSON.stringify({ projectId, repositoryUrl: gitUrl.trim(), destination: gitDestination.trim(), ...(gitRef.trim() ? { ref: gitRef.trim() } : {}), networkPolicy: networkPolicy === "allowlist" ? "allowlist" : "direct", ...(networkPolicy === "allowlist" ? { allowedHosts: allowedHosts.split(/[\n,]/).map((host) => host.trim()).filter(Boolean) } : {}), confirmed })
      });
      setGitResult(result);
    } catch (error) { onError(error instanceof Error ? error.message : "Git 源码取证失败。"); }
    finally { setConfirmed(false); setBusy(false); }
  };

  const analyzeGitSource = async () => {
    if (!gitDestination.trim() || !projectId) return;
    setBusy(true);
    try {
      setGitAnalysis(await request<GitAnalysisResult>("/execution/git/analyze", { method: "POST", body: JSON.stringify({ projectId, destination: gitDestination.trim(), repositoryUrl: gitResult?.repositoryUrl ?? gitUrl.trim(), maxLinesPerFile: 400, confirmed }) }));
    } catch (error) { onError(error instanceof Error ? error.message : "Git 源码分析失败。"); }
    finally { setConfirmed(false); setBusy(false); }
  };

  const rememberDirectoryGrant = async () => {
    const targetPrefix = (grantPath || cwd).trim();
    if (!targetPrefix) return;
    try {
      const action = grantAccess === "write" ? "write" : "read";
      const grant = await request<PermissionGrant>("/agent/permissions", {
        method: "POST",
        body: JSON.stringify({ scope: grantScope, decision: "allow", toolId: `execution:${runtime}`, action, ...(grantScope === "project" && projectId ? { projectId } : {}), targetPrefix })
      });
      setPermissionGrants((current) => [grant, ...current]);
    } catch (error) { onError(error instanceof Error ? error.message : "保存权限失败。"); }
  };

  const directoryGrants = permissionGrants.filter((grant) => grant.targetPrefix && (grant.action === "read" || grant.action === "write"));
  return <div className="tool-detail execution-panel">
    <strong>代码与工具执行</strong>
    <p className="hint compact-hint">阿文只能提出计划；本页每次运行都要重新确认。参数按行传递，不接受 shell 字符串。</p>
    <div className="execution-tools"><strong>已探测工具</strong>{systemTools.length ? systemTools.map((tool) => <small key={tool.id}>{tool.id} · {tool.version} · {tool.path}</small>) : <small>暂未探测到 Git、Python、Node 或其他可选工具。</small>}</div>
    {permissionGrants.length > 0 && <div className="execution-tools"><strong>当前可用授权</strong>{permissionGrants.slice(0, 5).map((grant) => <small key={grant.id}>{grant.scope} · {grant.toolId ?? "全部工具"} · {grant.action ?? "全部动作"} · {grant.targetPrefix ?? "全部目标"}</small>)}</div>}
    <label>执行目标<select value={targetType} onChange={(event) => { setTargetType(event.target.value as Target); setPreflight(undefined); }}><option value="host_trusted">本机环境（高风险）</option><option value="windows_sandbox">Windows Sandbox</option><option value="wsl">WSL</option><option value="docker">Docker</option></select></label>
    {targetType === "wsl" && <label>WSL 发行版（可选）<input value={wslDistribution} onChange={(event) => setWslDistribution(event.target.value)} placeholder="留空使用默认发行版" /></label>}
    {targetType === "docker" && <><label>本地 Docker 镜像<input value={dockerImage} onChange={(event) => setDockerImage(event.target.value)} placeholder="例如 python:3.12-slim（不会自动拉取）" /></label><div className="execution-grid"><label>内存（MB）<input type="number" min={256} max={16384} value={dockerMemoryInMb} onChange={(event) => setDockerMemoryInMb(event.target.value)} /></label><label>CPU 数量<input type="number" min={0.1} max={32} step={0.1} value={dockerCpus} onChange={(event) => setDockerCpus(event.target.value)} /></label><label>进程数上限<input type="number" min={32} max={4096} value={dockerPidsLimit} onChange={(event) => setDockerPidsLimit(event.target.value)} /></label></div></>}
    {targetType === "windows_sandbox" && <label>Sandbox 内存（MB）<input type="number" min={1024} max={8192} value={sandboxMemoryInMb} onChange={(event) => setSandboxMemoryInMb(event.target.value)} /></label>}
    <label>运行时<select value={runtime} onChange={(event) => setRuntime(event.target.value as Runtime)}><option value="python">Python</option><option value="node">Node.js</option><option value="git">Git</option><option value="custom">自定义可执行文件</option></select></label>
    {runtime === "custom" && <label>可执行文件<input value={executable} onChange={(event) => setExecutable(event.target.value)} placeholder="例如：C:\\工具\\demo.exe" /></label>}
    {runtime === "git" && projectId && <section className="execution-observation">
      <strong>Git 源码取证</strong>
      <small>只接受公开 HTTPS 仓库；会创建浅克隆并固定 commit SHA。请勾选下方本次确认后再执行。</small>
      <input value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} placeholder="https://github.com/org/repo" />
      <input value={gitDestination} onChange={(event) => setGitDestination(event.target.value)} placeholder="新的 staging 目录，例如 D:\\Temp\\repo" />
      <input value={gitRef} onChange={(event) => setGitRef(event.target.value)} placeholder="分支或标签（可选）" />
      <div className="inline-actions">
        <button type="button" className="secondary-button" onClick={() => void cloneGitSource()} disabled={busy || !confirmed || !gitUrl.trim() || !gitDestination.trim() || networkPolicy === "disabled"}>克隆并固定源码版本</button>
        <button type="button" className="secondary-button" onClick={() => void analyzeGitSource()} disabled={busy || !confirmed || !gitDestination.trim() || !(gitResult?.repositoryUrl || gitUrl.trim())}>分析仓库文件</button>
      </div>
      {gitResult && <small>commit {gitResult.commitSha} · {gitResult.files.length} 个文件 · 执行记录 {gitResult.clone.id}</small>}
      {gitAnalysis && <div className="execution-tools">
        <strong>文件级取证（前 400 行）</strong>
        {gitAnalysis.files.map((file) => <article key={file.path}>
          <small>{file.path} · {file.lineCount} 行 · SHA-256 {file.sha256}</small>
          <pre>{file.excerpt}</pre>
          {onInsertCitation && <button type="button" className="text-button" onClick={() => onInsertCitation(`> 源码取证：\`${file.path}:${file.lineStart}-${file.lineEnd}\`（${gitAnalysis.repositoryUrl ? `仓库 ${gitAnalysis.repositoryUrl}；` : ""}commit ${gitAnalysis.commitSha}；分析记录 ${gitAnalysis.run.id}；文件读取记录 ${file.runId}；SHA-256 ${file.sha256}）\n>\n> ${file.excerpt.split("\n").slice(0, 8).join("\n> ")}`)}>插入正文引用</button>}
        </article>)}
      </div>}
    </section>}
    {directoryGrants.length > 0 && <label>使用已有授权目录<select value={selectedGrantPath} onChange={(event) => { const value = event.target.value; setSelectedGrantPath(value); if (value) { setCwd(value); setGrantPath(value); } }}><option value="">手动填写新目录</option>{directoryGrants.map((grant) => <option value={grant.targetPrefix} key={grant.id}>{grant.scope === "global" ? "所有文章" : "当前文章"} · {grant.targetPrefix} · {grant.action}</option>)}</select><small>系统级授权可供所有文章复用，但每次执行仍需确认具体命令、网络和目录。</small></label>}
    <label>工作目录<input value={cwd} onChange={(event) => { setCwd(event.target.value); if (!grantPath) setGrantPath(event.target.value); }} placeholder="允许访问的项目或 staging 目录" /></label>
    <label>授权目录<input value={grantPath} onChange={(event) => setGrantPath(event.target.value)} placeholder="本次运行允许访问的目录" /></label>
    <label>目录权限<select value={grantAccess} onChange={(event) => setGrantAccess(event.target.value as "read" | "write")}><option value="read">只读</option><option value="write">读写</option></select></label>
    <label>参数（每行一个）<textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} rows={3} /></label>
    <label>网络<select value={networkPolicy} onChange={(event) => setNetworkPolicy(event.target.value as NetworkPolicy)}><option value="disabled">关闭（程序无法被强制断网）</option><option value="allowlist">仅允许白名单</option><option value="direct">直连（高风险）</option></select></label>
    {networkPolicy === "allowlist" && <label>域名白名单<textarea value={allowedHosts} onChange={(event) => setAllowedHosts(event.target.value)} rows={2} placeholder="每行一个，例如 pypi.org" /></label>}
    <label>输出目录（可选）<input value={outputDirectory} onChange={(event) => setOutputDirectory(event.target.value)} placeholder="必须位于可写授权目录内" /></label>
    {targetType === "host_trusted" && <label className="checkbox-row"><input type="checkbox" checked={acknowledgeHostRisk} onChange={(event) => setAcknowledgeHostRisk(event.target.checked)} /><span>我知道本机执行不是安全沙箱，程序可能访问本机文件或网络</span></label>}
    <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我确认本次执行的目标、目录、网络和参数</span></label>
    <div className="inline-actions"><button type="button" className="secondary-button" onClick={() => void check()} disabled={busy || !cwd.trim() || !argsText.trim()}>{busy ? "检查中…" : "前置检查"}</button><select value={grantScope} onChange={(event) => setGrantScope(event.target.value as "global" | "project")} disabled={!projectId}><option value="project">仅当前文章</option><option value="global">所有文章共享</option></select><button type="button" className="secondary-button" onClick={() => void rememberDirectoryGrant()} disabled={busy || !cwd.trim()} title="只保存目录和运行时授权；每次执行仍需重新确认具体命令">记住此目录授权</button><button type="button" onClick={() => void execute()} disabled={busy || !confirmed || !preflight?.available}>{busy ? "执行中…" : "执行并记录"}</button></div>
    {preflight && <div className={preflight.available ? "ready execution-preflight" : "error execution-preflight"}><strong>{preflight.available ? "目标可用" : "目标不可用"}</strong><small>{preflight.executable} · {preflight.resolvedCwd}</small>{preflight.warnings.map((warning) => <small key={warning}>{warning}</small>)}{preflight.reason && <small>{preflight.reason}</small>}</div>}
    {run && <div className="execution-result"><strong>运行结果：{run.status}</strong><small>耗时 {run.durationMs} ms · 产物 {run.artifacts.length} 个</small>{run.stdout && <pre>{run.stdout}</pre>}{run.stderr && <pre className="error">{run.stderr}</pre>}{run.errorMessage && <p className="error">{run.errorMessage}</p>}{run.status === "completed" && run.id && projectId && <section className="execution-observation"><strong>保存为实验资料卡</strong><small>{observationSaved ? "已保存。请在资料来源中审核后再用于提纲或正文。" : "只保存带执行条件的观察，不会自动变成通用事实。"}</small><input value={observationTitle} onChange={(event) => { setObservationSaved(false); setObservationTitle(event.target.value); }} placeholder="观察标题" /><textarea value={observationClaim} onChange={(event) => { setObservationSaved(false); setObservationClaim(event.target.value); }} rows={3} placeholder="这次运行实际验证了什么？" /><button type="button" className="secondary-button" onClick={() => void saveObservation()} disabled={observationSaved || !observationTitle.trim() || !observationClaim.trim()}>保存到资料卡</button></section>}</div>}
  </div>;
}
