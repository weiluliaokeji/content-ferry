import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ContentProjectRepository } from "../content/content-project-repository";
import type { ArticlePracticeTaskRepository } from "../content/article-practice-task-repository";

const MAX_FILE_BYTES = 1_000_000;
const MAX_CONTENT_CHARS = 250_000;

export interface PracticeProjectFileEdit {
  relativePath: string;
  content: string;
  expectedSha256: string;
}

export interface PracticeProjectFileRead {
  relativePath: string;
  content: string;
  sha256: string;
}

export interface PracticeProjectFileChange {
  id: string;
  projectId: string;
  taskId: string;
  relativePath: string;
  beforeSha256: string;
  afterSha256: string;
  diff: { before: string; after: string };
}

/** Writes are scoped to one article's selected project directory and always retain a recoverable original. */
export class AwenPracticeProjectEditor {
  private readonly backupRoot: string;

  constructor(
    private readonly projects: ContentProjectRepository,
    private readonly tasks: ArticlePracticeTaskRepository,
    dataDirectory: string
  ) {
    this.backupRoot = path.join(path.resolve(dataDirectory), "practice-file-backups");
  }

  read(taskId: string, projectId: string, relativePath: string): PracticeProjectFileRead {
    const task = this.tasks.require(taskId);
    if (task.projectId !== projectId) throw new Error("实践任务与当前文章不匹配。");
    if (task.status !== "practicing" && task.status !== "waiting_permission") throw new Error("只有正在实践或已获授权的任务可以读取项目文件。");

    const project = this.projects.require(projectId);
    if (!project.practiceProjectDirectory) throw new Error("请先为当前文章关联代码项目目录。");
    const root = resolveDirectory(project.practiceProjectDirectory);
    const target = resolveExistingTextFile(root, relativePath);
    const bytes = fs.readFileSync(target);
    if (bytes.length > MAX_FILE_BYTES) throw new Error("目标文件超过 1 MB，不能通过阿文读取。");
    if (bytes.includes(0)) throw new Error("目标文件不是普通文本文件，不能通过阿文读取。");
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) {
      throw new Error("目标文件不是有效的 UTF-8 文本，不能通过阿文读取。");
    }
    if (content.length > MAX_CONTENT_CHARS) throw new Error("目标文件超过 250000 个字符，不能放入本轮读取上下文。");
    return {
      relativePath: path.relative(root, target).split(path.sep).join("/"),
      content,
      sha256: sha256(bytes)
    };
  }

  write(taskId: string, projectId: string, input: PracticeProjectFileEdit): PracticeProjectFileChange | { unchanged: true; relativePath: string } {
    const task = this.tasks.require(taskId);
    if (task.projectId !== projectId) throw new Error("实践任务与当前文章不匹配。");
    // The workflow runner invokes this only after the pending tool call has
    // received an app-side grant. While it waits, the durable task is marked
    // waiting_permission and the runner resumes without an intermediate
    // repository callback, so both states are valid at this boundary.
    if (task.status !== "practicing" && task.status !== "waiting_permission") throw new Error("只有正在实践或已获授权的任务可以修改项目文件。");
    if (input.content.length > MAX_CONTENT_CHARS) throw new Error("修改内容超过 250000 个字符。");

    const project = this.projects.require(projectId);
    if (!project.practiceProjectDirectory) throw new Error("请先为当前文章关联代码项目目录。");
    const root = resolveDirectory(project.practiceProjectDirectory);
    const target = resolveExistingTextFile(root, input.relativePath);
    const original = fs.readFileSync(target);
    if (original.length > MAX_FILE_BYTES) throw new Error("目标文件超过 1 MB，不能通过阿文自动修改。");
    if (original.includes(0)) throw new Error("目标文件不是普通文本文件，不能通过阿文自动修改。");
    const hadBom = original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const body = Buffer.from(input.content, "utf8");
    const next = hadBom && !body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
      ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
      : body;
    const beforeSha256 = sha256(original);
    if (!/^[a-f0-9]{64}$/iu.test(input.expectedSha256) || beforeSha256 !== input.expectedSha256.toLowerCase()) {
      throw new Error("文件在阿文读取后发生变化。为避免覆盖新内容，请重新读取并核对后再修改。");
    }
    const afterSha256 = sha256(next);
    const relativePath = path.relative(root, target).split(path.sep).join("/");
    if (beforeSha256 === afterSha256) return { unchanged: true, relativePath };

    const id = randomUUID();
    const taskBackupRoot = path.join(this.backupRoot, taskId);
    fs.mkdirSync(taskBackupRoot, { recursive: true });
    assertNoSymlinkAncestors(this.backupRoot);
    const backupPath = path.join(taskBackupRoot, `${id}.before`);
    const temporaryPath = path.join(path.dirname(target), `.contentferry-${id}.tmp`);
    const displacedPath = path.join(path.dirname(target), `.contentferry-${id}.previous`);
    fs.writeFileSync(backupPath, original, { flag: "wx", mode: 0o600 });
    try {
      fs.writeFileSync(temporaryPath, next, { flag: "wx", mode: fs.statSync(target).mode & 0o777 });
      fs.renameSync(target, displacedPath);
      if (sha256(fs.readFileSync(displacedPath)) !== beforeSha256) {
        fs.renameSync(displacedPath, target);
        throw new Error("文件在修改前发生变化。阿文没有覆盖它，请重新检查后再试。");
      }
      try {
        fs.renameSync(temporaryPath, target);
      } catch (error) {
        fs.renameSync(displacedPath, target);
        throw error;
      }
      fs.unlinkSync(displacedPath);
      const change: PracticeProjectFileChange = {
        id, projectId, taskId, relativePath, beforeSha256, afterSha256,
        diff: createFocusedDiff(original.toString("utf8"), next.toString("utf8"))
      };
      try {
        this.tasks.recordPracticeResult(taskId, { kind: "project_file_change", ...change, backupPath });
      } catch (error) {
        restoreBackup(backupPath, target);
        throw error;
      }
      return change;
    } catch (error) {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      if (fs.existsSync(displacedPath) && !fs.existsSync(target)) fs.renameSync(displacedPath, target);
      throw error;
    }
  }

  restore(taskId: string, projectId: string, changeId: string): { relativePath: string; restored: true } {
    const task = this.tasks.require(taskId);
    if (task.projectId !== projectId) throw new Error("实践任务与当前文章不匹配。");
    const events = this.tasks.listEvents(taskId);
    const changed = events.find((event) => event.kind === "practice_result" && event.payload.kind === "project_file_change" && event.payload.id === changeId);
    if (!changed) throw new Error("找不到这项实践产生的文件改动记录。");
    const payload = changed.payload;
    const backupPath = requireString(payload.backupPath, "原文件备份记录");
    const relativePath = requireString(payload.relativePath, "文件相对路径");
    if (events.some((event) => event.kind === "practice_result" && event.payload.kind === "project_file_change_restored" && event.payload.id === changeId)) {
      return { relativePath, restored: true };
    }
    const expectedCurrentHash = requireString(payload.afterSha256, "修改后文件指纹");
    const project = this.projects.require(projectId);
    if (!project.practiceProjectDirectory) throw new Error("当前文章已解除关联项目目录，无法恢复文件改动。");
    const root = resolveDirectory(project.practiceProjectDirectory);
    const target = resolveExistingTextFile(root, relativePath);
    if (sha256(fs.readFileSync(target)) !== expectedCurrentHash) {
      throw new Error("目标文件在阿文修改后又发生变化。为避免覆盖新内容，请人工核对后处理。");
    }
    const canonicalBackupRoot = resolveDirectory(this.backupRoot);
    const canonicalBackup = resolveExistingFile(canonicalBackupRoot, backupPath);
    restoreBackup(canonicalBackup, target);
    this.tasks.recordProjectFileRestored(taskId, { id: changeId, relativePath });
    return { relativePath, restored: true };
  }
}

function resolveDirectory(value: string): string {
  const resolved = path.resolve(value);
  assertNoSymlinkAncestors(resolved);
  const canonical = fs.realpathSync.native(resolved);
  if (!fs.statSync(canonical).isDirectory()) throw new Error("关联项目路径不是文件夹。");
  return canonical;
}

function resolveExistingTextFile(root: string, relativePath: string): string {
  if (!relativePath.trim() || relativePath.includes("\0") || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error("只能修改项目目录中的相对文件路径。");
  }
  const normalized = relativePath.replace(/[\\/]+/gu, path.sep);
  const segments = normalized.split(path.sep);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("文件路径不能包含空白段、当前目录或上级目录。");
  if (process.platform === "win32" && segments.some((segment) => /[:. ]$/u.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
    throw new Error("文件名不能使用 Windows 保留名称、盘符或数据流语法。");
  }
  let cursor = root;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (isMissingPathError(error)) throw new Error(index === segments.length - 1 ? "目标必须是已存在的普通文件。" : "文件路径中的目录不存在。");
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("不能通过符号链接或 junction 修改项目文件。");
    const last = index === segments.length - 1;
    if (last ? !stat.isFile() : !stat.isDirectory()) throw new Error(last ? "目标必须是已存在的普通文件。" : "文件路径中的目录不存在。");
  }
  const canonical = fs.realpathSync.native(cursor);
  if (!isPathInside(root, canonical)) throw new Error("目标文件越过了文章关联项目目录。");
  return canonical;
}

function resolveExistingFile(root: string, value: string): string {
  // Mirror resolveExistingTextFile: canonicalize before the containment check so a
  // short (8.3) backup path matches a long-form canonical root (e.g. RUNNER~1 vs
  // runneradmin on CI), instead of failing the boundary check.
  const resolved = fs.realpathSync.native(path.resolve(value));
  if (!isPathInside(root, resolved)) throw new Error("原文件备份路径无效。");
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("原文件备份不可用。");
  return resolved;
}

function restoreBackup(backupPath: string, target: string): void {
  const bytes = fs.readFileSync(backupPath);
  const temporaryPath = `${target}.contentferry-restore-${randomUUID()}.tmp`;
  const displacedPath = `${target}.contentferry-restore-${randomUUID()}.previous`;
  fs.writeFileSync(temporaryPath, bytes, { flag: "wx", mode: fs.statSync(target).mode & 0o777 });
  try {
    fs.renameSync(target, displacedPath);
    try {
      fs.renameSync(temporaryPath, target);
    } catch (error) {
      fs.renameSync(displacedPath, target);
      throw error;
    }
    fs.unlinkSync(displacedPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function createFocusedDiff(before: string, after: string): { before: string; after: string } {
  const oldLines = before.split(/\r?\n/u);
  const newLines = after.split(/\r?\n/u);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) { oldEnd -= 1; newEnd -= 1; }
  const from = Math.max(0, start - 3);
  const toOld = Math.min(oldLines.length, oldEnd + 4);
  const toNew = Math.min(newLines.length, newEnd + 4);
  return { before: oldLines.slice(from, toOld).join("\n"), after: newLines.slice(from, toNew).join("\n") };
}

function assertNoSymlinkAncestors(target: string): void {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`路径不能经过符号链接或 junction：${current}`);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}缺失。`);
  return value;
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
