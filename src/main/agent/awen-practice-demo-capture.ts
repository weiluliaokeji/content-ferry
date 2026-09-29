import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BrowserWindow, session } from "electron";
import type { ContentProjectRepository } from "../content/content-project-repository";
import type { ContentSourceService } from "../content/content-source-service";
import type { ToolExecutionContext } from "./tool-runner";
import type { AwenPracticeCodeRunner } from "./awen-practice-code-runner";
import type { ExecutionRepository } from "./execution-repository";
import { ExecutionPolicyError } from "./execution-service";

export interface AwenPracticeDemoCaptureInput {
  relativePath: string;
  caption: string;
}

export interface AwenPracticeDemoCaptureResult {
  title: string;
  url: string;
  observedAt: string;
  observation: string;
  assetUrl: string;
  screenshotMarkdown: string;
  screenshotSha256: string;
  operationSummary: string;
}

export interface AwenPracticeCommandOutputCaptureInput {
  runId: string;
  label: string;
  caption: string;
}

const MAX_DEMO_HTML_BYTES = 5 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;

/** Previews task-produced HTML without network access, Node integration, or access outside its task directory. */
export class AwenPracticeDemoCapture {
  constructor(
    private readonly contentSources: ContentSourceService,
    private readonly contentProjects: ContentProjectRepository,
    private readonly codeRunner: AwenPracticeCodeRunner,
    private readonly executionRuns?: ExecutionRepository
  ) {}

  getWorkflowDirectory(projectId: string | undefined, workflowId: string): string {
    return this.codeRunner.getWorkflowDirectory(projectId, workflowId);
  }

  async capture(input: AwenPracticeDemoCaptureInput, context: ToolExecutionContext, captureInfo?: {
    captureKind?: "command_output";
    sourceUrl?: string;
    conditions?: string;
    operationSummary?: string;
    title?: string;
  }): Promise<AwenPracticeDemoCaptureResult> {
    if (!context.workflowId || !context.projectId) throw new ExecutionPolicyError("本地 Demo 截图必须关联当前文章的实践任务。");
    const workflowDirectory = this.getWorkflowDirectory(context.projectId, context.workflowId);
    if (!context.target || path.resolve(context.target) !== workflowDirectory) throw new ExecutionPolicyError("Demo 截图目标与当前实践工作区不一致。");
    if (context.signal?.aborted) throw new ExecutionPolicyError("本地 Demo 截图已取消。");
    const filePath = resolvePracticeDemoHtml(workflowDirectory, input.relativePath);
    const project = this.contentProjects.require(context.projectId);
    if (!project.sourceRelativePath) throw new ExecutionPolicyError("当前文章还没有可保存素材的文章路径，无法保存 Demo 截图。");

    const partition = `awen-demo-${context.workflowId.replace(/[^a-z0-9-]/giu, "")}`;
    const demoSession = session.fromPartition(partition, { cache: false });
    demoSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    demoSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "file://*/*"] }, (details, callback) => {
      if (details.url.startsWith("file:") && isPracticeDemoFileUrlAllowed(details.url, workflowDirectory)) callback({ cancel: false });
      else callback({ cancel: true });
    });
    const cancelDownload = (_event: Electron.Event, item: Electron.DownloadItem) => item.cancel();
    demoSession.on("will-download", cancelDownload);

    const window = new BrowserWindow({
      width: 1180,
      height: 820,
      show: true,
      title: "文渡 · 阿文本地 Demo 预览",
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    const permitTaskFile = (event: Electron.Event, rawUrl: string) => {
      if (!isPracticeDemoFileUrlAllowed(rawUrl, workflowDirectory)) event.preventDefault();
    };
    window.webContents.on("will-navigate", permitTaskFile);
    window.webContents.on("will-redirect", permitTaskFile);
    const closeOnAbort = () => { if (!window.isDestroyed()) window.destroy(); };
    context.signal?.addEventListener("abort", closeOnAbort, { once: true });

    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        window.loadFile(filePath),
        new Promise<never>((_resolve, reject) => {
          loadTimer = setTimeout(() => reject(new ExecutionPolicyError("本地 Demo 打开超时，未保存截图。")), 20_000);
        })
      ]);
      if (context.signal?.aborted || window.isDestroyed()) throw new ExecutionPolicyError("本地 Demo 截图已取消。");
      const page = await window.webContents.executeJavaScript(`(() => ({ title: (document.title || "").slice(0, 300), text: (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 8000) }))()`, true) as { title: string; text: string };
      if (context.signal?.aborted || window.isDestroyed()) throw new ExecutionPolicyError("本地 Demo 截图已取消。");
      const png = window.webContents.capturePage().then((image) => image.toPNG());
      const bytes = await png;
      if (bytes.length === 0 || bytes.length > MAX_SCREENSHOT_BYTES) throw new ExecutionPolicyError("本地 Demo 截图为空或超过文章图片大小限制，没有保存截图。");
      const observedAt = new Date().toISOString();
      const title = captureInfo?.title || page.title || path.basename(filePath, path.extname(filePath));
      const saved = this.contentSources.saveArticlePracticeDemoCapture(project.workspaceId, project.sourceRelativePath, bytes.toString("base64"), {
        ...(captureInfo?.captureKind ? { captureKind: captureInfo.captureKind } : {}),
        title,
        capturedAt: observedAt,
        conditions: captureInfo?.conditions ?? "文渡临时工作区内生成的本地 HTML Demo；预览禁用外网请求、下载、弹窗和系统权限；不含临时工作区路径。"
      });
      return {
        title,
        url: captureInfo?.sourceUrl ?? `local-demo:${input.relativePath.replaceAll("\\", "/")}`,
        observedAt,
        observation: page.text,
        assetUrl: saved.assetUrl,
        screenshotMarkdown: `![${sanitizeAlt(input.caption || title)}](${saved.assetUrl})`,
        screenshotSha256: saved.sha256,
        operationSummary: captureInfo?.operationSummary ?? "打开本地 Demo 窗口并截取可见结果"
      };
    } finally {
      if (loadTimer) clearTimeout(loadTimer);
      context.signal?.removeEventListener("abort", closeOnAbort);
      if (!window.isDestroyed()) window.destroy();
      demoSession.removeListener("will-download", cancelDownload);
      await demoSession.clearStorageData().catch(() => undefined);
    }
  }

  async captureCommandOutput(input: AwenPracticeCommandOutputCaptureInput, context: ToolExecutionContext): Promise<AwenPracticeDemoCaptureResult> {
    if (!this.executionRuns) throw new ExecutionPolicyError("当前版本没有本机命令输出截图能力。请把已取得的命令结果作为文字使用。" );
    if (!context.workflowId || !context.practiceTaskId || !context.projectId) throw new ExecutionPolicyError("命令输出截图必须关联当前文章的实践任务。" );
    if (!/^[0-9a-f-]{36}$/iu.test(input.runId) || !input.label.trim() || input.label.length > 100 || input.caption.length > 100) {
      throw new ExecutionPolicyError("命令输出截图参数不正确。" );
    }
    const workflowDirectory = this.getWorkflowDirectory(context.projectId, context.workflowId);
    if (!context.target || path.resolve(context.target) !== workflowDirectory) throw new ExecutionPolicyError("命令输出截图目标与当前实践工作区不一致。" );
    const run = this.executionRuns.require(input.runId);
    if (run.request.workflowId !== context.workflowId || run.request.practiceTaskId !== context.practiceTaskId || run.projectId !== context.projectId || path.resolve(run.request.cwd) !== workflowDirectory) {
      throw new ExecutionPolicyError("只能截取当前文章、本次实践工作流中已完成命令的实际输出。" );
    }
    if (run.status !== "completed" || run.exitCode !== 0 || !run.stdout.trim()) throw new ExecutionPolicyError("只有成功返回非空标准输出的本次命令才能生成输出截图。" );
    if (containsSensitiveCommandOutput(run.stdout)) throw new ExecutionPolicyError("命令输出包含疑似凭据或本机绝对路径，为避免写入文章素材，文渡没有生成截图。可先检查并清理结果，或仅使用文字结论。" );
    if (context.signal?.aborted) throw new ExecutionPolicyError("命令输出截图已取消。" );
    const relativePath = `command-output-${run.id}-${randomUUID()}.html`;
    const outputHtml = renderCommandOutputHtml(input.label.trim(), run.stdout.slice(0, 16_000), run.truncated);
    const filePath = path.join(workflowDirectory, relativePath);
    fs.writeFileSync(filePath, outputHtml, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return this.capture({ relativePath, caption: input.caption }, context, {
      captureKind: "command_output",
      sourceUrl: `local-command-output:${run.id}`,
      title: input.label.trim(),
      conditions: `根据本次授权的本机命令运行 ${run.id} 实际返回的 stdout 生成；退出码 0${run.truncated ? "；原始输出曾被截断" : ""}。画面是命令输出展示图，不是操作系统终端窗口截图；不含本机路径。`,
      operationSummary: "根据本次命令实际输出生成终端样式页面并截取；非操作系统终端窗口截图。"
    });
  }
}

export function renderCommandOutputHtml(label: string, output: string, truncated: boolean): string {
  const safeLabel = escapeHtml(label);
  const safeOutput = escapeHtml(output);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safeLabel}</title><style>*{box-sizing:border-box}body{margin:0;padding:44px;background:#10151d;color:#e6edf3;font:16px/1.55 Consolas,"Cascadia Mono",monospace}.terminal{max-width:1120px;margin:0 auto;border:1px solid #384453;border-radius:12px;overflow:hidden;background:#151c26;box-shadow:0 18px 54px #0005}.head{display:flex;align-items:center;gap:9px;padding:15px 20px;background:#202a37;color:#d7e0eb}.dot{width:10px;height:10px;border-radius:50%;background:#657386}.label{margin-left:8px;font-size:14px}.body{padding:24px;min-height:180px}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.65 Consolas,"Cascadia Mono",monospace;color:#d6e2f0}.note{padding:12px 24px;border-top:1px solid #303a48;color:#98a6b8;font:12px/1.5 "Segoe UI",sans-serif}</style></head><body><main class="terminal"><header class="head"><i class="dot"></i><i class="dot"></i><i class="dot"></i><span class="label">${safeLabel} · 本机命令实际输出</span></header><section class="body"><pre>${safeOutput}${truncated ? "\n…输出已截断" : ""}</pre></section><footer class="note">根据本次命令返回内容生成的输出展示图，不是操作系统终端窗口截图。</footer></main></body></html>`;
}

export function containsSensitiveCommandOutput(output: string): boolean {
  return /(?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/iu.test(output)
    || /(?:[a-z]:\\|\\\\[^\\\s]+\\[^\\\s]+)/iu.test(output);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? character);
}

export function resolvePracticeDemoHtml(workflowDirectory: string, relativePath: string): string {
  if (!relativePath.trim() || path.isAbsolute(relativePath) || /^[a-z]:/iu.test(relativePath) || relativePath.includes("\0")) {
    throw new ExecutionPolicyError("Demo 文件必须使用本次临时工作区内的相对路径。");
  }
  const root = path.resolve(workflowDirectory);
  const candidate = path.resolve(root, relativePath);
  if (!isPathInside(root, candidate) || !/\.html?$/iu.test(candidate)) throw new ExecutionPolicyError("Demo 截图只支持临时工作区内的 HTML 文件。");
  assertNoSymlinkPath(root);
  assertNoSymlinkPath(candidate);
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = fs.realpathSync.native(root);
    realFile = fs.realpathSync.native(candidate);
  } catch { throw new ExecutionPolicyError("找不到本次实践工作区中的 Demo HTML 文件。"); }
  if (!isPathInside(realRoot, realFile) || !fs.statSync(realFile).isFile()) throw new ExecutionPolicyError("Demo 文件必须是本次工作区内的普通文件。");
  if (fs.statSync(realFile).size > MAX_DEMO_HTML_BYTES) throw new ExecutionPolicyError("Demo HTML 超过 5 MB，未打开预览。");
  return realFile;
}

export function isPracticeDemoFileUrlAllowed(rawUrl: string, workflowDirectory: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "file:") return false;
    const candidate = fileURLToPath(url);
    const root = fs.realpathSync.native(path.resolve(workflowDirectory));
    const raw = path.resolve(candidate);
    if (!fs.existsSync(raw)) return false;
    // Canonicalize before containment checks: on CI/windows the candidate path
    // may use 8.3 short names (e.g. RUNNER~1) while root is already expanded,
    // which makes a raw isPathInside comparison fail. realpathSync.native
    // expands both sides to the same long form.
    const realPath = fs.realpathSync.native(raw);
    return isPathInside(root, realPath) && fs.statSync(realPath).isFile();
  } catch { return false; }
}

function assertNoSymlinkPath(target: string): void {
  const root = path.parse(path.resolve(target)).root;
  let current = root;
  for (const segment of path.relative(root, path.resolve(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new ExecutionPolicyError("Demo 路径不能经过符号链接或 junction。");
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sanitizeAlt(value: string): string {
  return value.replace(/[\[\]\\\r\n]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 100) || "本地 Demo 实践截图";
}
