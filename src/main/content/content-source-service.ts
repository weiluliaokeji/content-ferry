import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { rasterizeSvgToPng } from "../../shared/svg-rasterize";

export interface ContentSourcePreviewItem {
  relativePath: string;
  title: string | null;
  frontMatterKeys: string[];
  tags: string[];
  createdAt: string | null;
  archived: boolean;
}

export interface ContentSourcePreview {
  rootPath: string;
  articleCount: number;
  sitePageCount: number;
  items: ContentSourcePreviewItem[];
  truncated: boolean;
  warnings: string[];
}

export interface ContentSourceArticle {
  relativePath: string;
  title: string | null;
  markdown: string;
  frontMatter: string;
}

export interface StagedArticleDeletion {
  finalize(): void;
  rollback(): void;
}

type DeletionFileSystem = Pick<typeof fs,
  "renameSync" | "copyFileSync" | "unlinkSync" | "mkdirSync" | "existsSync" |
  "readdirSync" | "rmdirSync">;

const ignoredDirectories = new Set([".git", "node_modules", "dist", ".vitepress", ".contentferry-trash"]);
const maxPreviewItems = 200;

export class ContentSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "ContentSourceError"; }
}

export class ContentSourceService {
  constructor(private readonly db: Database.Database) {}

  getSource(workspaceId: string): string | null {
    const row = this.db.prepare("SELECT root_path FROM content_sources WHERE workspace_id = ?").get(workspaceId) as { root_path: string } | undefined;
    return row?.root_path ?? null;
  }

  setSource(workspaceId: string, rootPath: string): string {
    const resolved = path.resolve(rootPath);
    const stats = this.requireReadableDirectory(resolved);
    if (!stats.isDirectory()) throw new ContentSourceError("文章库路径必须是一个文件夹。");
    this.db.prepare(`INSERT INTO content_sources (workspace_id, root_path, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET root_path = excluded.root_path, updated_at = excluded.updated_at`)
      .run(workspaceId, resolved, new Date().toISOString());
    return resolved;
  }

  preview(workspaceId: string): ContentSourcePreview {
    const rootPath = this.getSource(workspaceId);
    if (!rootPath) throw new ContentSourceError("尚未设置文章库路径。");
    this.requireReadableDirectory(rootPath);

    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) walk(path.join(directory, entry.name));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          files.push(path.join(directory, entry.name));
        }
      }
    };
    walk(rootPath);
    const articleFiles = files.filter((filePath) => isArticlePath(path.relative(rootPath, filePath)));
    const warnings: string[] = [];
    const allItems = articleFiles.map((filePath) => {
      const relativePath = path.relative(rootPath, filePath).split(path.sep).join("/");
      try {
        const parsed = parseFrontMatter(fs.readFileSync(filePath, "utf8"));
        const fallbackCreatedAt = fs.statSync(filePath).birthtime.toISOString();
        return { relativePath, ...parsed, createdAt: parsed.createdAt ?? fallbackCreatedAt };
      } catch {
        warnings.push(`无法读取：${relativePath}`);
        return { relativePath, title: null, frontMatterKeys: [], tags: [], createdAt: null, archived: false };
      }
    });
    allItems.sort((left, right) => {
      const byCreated = parseCreatedTimestamp(right.createdAt) - parseCreatedTimestamp(left.createdAt);
      return byCreated || left.relativePath.localeCompare(right.relativePath, "zh-CN");
    });
    const items = allItems.slice(0, maxPreviewItems);
    if (articleFiles.length > maxPreviewItems) warnings.push(`为保持预览快速，仅显示前 ${maxPreviewItems} 篇文章。`);
    return { rootPath, articleCount: articleFiles.length, sitePageCount: files.length - articleFiles.length, items, truncated: articleFiles.length > maxPreviewItems, warnings };
  }

  getArticle(workspaceId: string, relativePath: string): ContentSourceArticle {
    const filePath = this.resolveArticlePath(workspaceId, relativePath);
    const source = fs.readFileSync(filePath, "utf8");
    const parts = splitFrontMatter(source);
    return {
      relativePath: toPortablePath(path.relative(this.getSource(workspaceId)!, filePath)),
      title: parseFrontMatter(source).title,
      markdown: parts.body,
      frontMatter: parts.frontMatter
    };
  }

  getArticleTags(workspaceId: string, relativePath: string): string[] {
    const filePath = this.resolveArticlePath(workspaceId, relativePath);
    const source = fs.readFileSync(filePath, "utf8");
    const parts = splitFrontMatter(source);
    return parseFrontMatterTags(parts.frontMatter);
  }

  saveArticle(workspaceId: string, relativePath: string, markdown: string): ContentSourceArticle {
    const filePath = this.resolveArticlePath(workspaceId, relativePath);
    const rootPath = this.getSource(workspaceId)!;
    const source = fs.readFileSync(filePath, "utf8");
    const parts = splitFrontMatter(source);
    const normalizedBody = normalizeSavedMarkdown(markdown).replace(/^\s+/, "").replace(/\s+$/, "");
    const currentTitle = parseFrontMatter(source).title;
    const nextTitle = extractLeadingArticleTitle(normalizedBody) ?? currentTitle;
    const nextFrontMatter = nextTitle && parts.frontMatter
      ? replaceFrontMatterTitle(parts.frontMatter, nextTitle)
      : parts.frontMatter;
    const nextSource = nextFrontMatter
      ? `${nextFrontMatter}\n\n${normalizedBody}\n`
      : `${normalizedBody}\n`;
    let nextFilePath = filePath;
    let nextRelativePath = relativePath;
    if (nextTitle && currentTitle && normalizeArticleTitle(nextTitle) !== normalizeArticleTitle(currentTitle)) {
      const articleDirectory = path.dirname(filePath);
      const postsRoot = path.resolve(rootPath, "posts");
      if (path.basename(filePath).toLowerCase() === "index.md" && isPathInside(postsRoot, articleDirectory)) {
        const nextDirectory = path.join(path.dirname(articleDirectory), sanitizeArticleDirectoryName(nextTitle));
        if (path.resolve(nextDirectory).toLowerCase() !== path.resolve(articleDirectory).toLowerCase()) {
          if (fs.existsSync(nextDirectory)) throw new ContentSourceError(`文章标题对应的目录已存在：${path.basename(nextDirectory)}`);
          try { fs.renameSync(articleDirectory, nextDirectory); }
          catch (error) {
            if (!isWindowsDirectoryBusyError(error)) throw error;
            try {
              copyDirectoryFileByFile(articleDirectory, nextDirectory, fs);
              removeDirectoryFileByFile(articleDirectory, fs);
            } catch (fallbackError) {
              try { removeDirectoryFileByFile(nextDirectory, fs); } catch { /* keep the original as the source of truth */ }
              throw new ContentSourceError("文章目录正在被其他程序占用，逐文件迁移也未能完成。请关闭 Obsidian 或资源管理器预览后重试。", { cause: fallbackError });
            }
          }
          nextFilePath = path.join(nextDirectory, "index.md");
          nextRelativePath = toPortablePath(path.relative(rootPath, nextFilePath));
          const now = new Date().toISOString();
          this.db.transaction(() => {
            this.db.prepare("UPDATE content_projects SET source_relative_path = ?, updated_at = ? WHERE workspace_id = ? AND source_relative_path = ?")
              .run(nextRelativePath, now, workspaceId, relativePath);
            this.db.prepare("UPDATE article_settings SET context_key = ? WHERE context_key = ?")
              .run(`source:${nextRelativePath}`, `source:${relativePath}`);
          })();
        }
      }
    }
    fs.writeFileSync(nextFilePath, nextSource, "utf8");
    return this.getArticle(workspaceId, nextRelativePath);
  }

  setArchived(workspaceId: string, relativePath: string, archived: boolean): ContentSourceArticle {
    const filePath = this.resolveArticlePath(workspaceId, relativePath);
    const source = fs.readFileSync(filePath, "utf8");
    const parts = splitFrontMatter(source);
    const nextFrontMatter = parts.frontMatter
      ? replaceFrontMatterArchived(parts.frontMatter, archived)
      : `---\narchived: ${archived}\n---`;
    const nextSource = `${nextFrontMatter}\n\n${parts.body}\n`;
    fs.writeFileSync(filePath, nextSource, "utf8");
    return this.getArticle(workspaceId, relativePath);
  }

  archiveArticlesBefore(workspaceId: string, cutoff: string): { archivedCount: number } {
    const preview = this.preview(workspaceId);
    const cutoffTimestamp = parseCreatedTimestamp(cutoff);
    let archivedCount = 0;
    for (const item of preview.items) {
      if (item.archived) continue;
      const itemTimestamp = parseCreatedTimestamp(item.createdAt);
      if (itemTimestamp > 0 && itemTimestamp <= cutoffTimestamp) {
        this.setArchived(workspaceId, item.relativePath, true);
        archivedCount++;
      }
    }
    return { archivedCount };
  }

  createArticle(workspaceId: string, title: string): ContentSourceArticle {
    const rootPath = this.getSource(workspaceId);
    if (!rootPath) throw new ContentSourceError("请先配置 VitePress 文章库，再新建文章。");
    this.requireReadableDirectory(rootPath);
    const safeTitle = sanitizeArticleDirectoryName(title);
    let directoryName = safeTitle;
    let suffix = 2;
    while (fs.existsSync(path.join(rootPath, "posts", directoryName))) {
      directoryName = `${safeTitle}-${suffix++}`;
    }
    const articleDirectory = path.join(rootPath, "posts", directoryName);
    fs.mkdirSync(path.join(articleDirectory, "assets"), { recursive: true });
    const relativePath = toPortablePath(path.join("posts", directoryName, "index.md"));
    const created = formatLocalDateTime(new Date());
    const source = `---\ntitle: '${escapeYamlSingleQuoted(title.trim())}'\ncreated: '${created}'\ntags: []\npublish: false\n---\n\n# ${title.trim()}\n`;
    fs.writeFileSync(path.join(articleDirectory, "index.md"), source, { encoding: "utf8", flag: "wx" });
    return this.getArticle(workspaceId, relativePath);
  }

  stageArticleDeletion(workspaceId: string, relativePath: string): StagedArticleDeletion {
    const articlePath = this.resolveArticlePath(workspaceId, relativePath);
    const rootPath = this.getSource(workspaceId)!;
    const postsRoot = path.resolve(rootPath, "posts");
    const articleDirectory = path.dirname(articlePath);
    if (!isPathInside(postsRoot, articleDirectory) || path.dirname(articleDirectory) === postsRoot && path.basename(articlePath).toLowerCase() !== "index.md") {
      throw new ContentSourceError("只能删除文章库 posts 目录中的标准文章目录。");
    }
    const trashRoot = path.resolve(rootPath, ".contentferry-trash");
    if (!isPathInside(rootPath, trashRoot)) throw new ContentSourceError("无法创建安全删除暂存目录。");
    fs.mkdirSync(trashRoot, { recursive: true });
    const stagedPath = path.join(trashRoot, randomUUID());
    return stageDirectoryDeletion(articleDirectory, stagedPath, trashRoot);
  }

  saveArticleAsset(workspaceId: string, relativePath: string, mimeType: string, base64: string): { assetUrl: string } {
    const filePath = this.resolveArticlePath(workspaceId, relativePath);
    const extension = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" }[mimeType];
    if (!extension) throw new ContentSourceError("仅支持 JPG、PNG、GIF 和 WebP 图片。");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0 || bytes.length > 15 * 1024 * 1024) throw new ContentSourceError("图片必须小于 15 MB。");
    const assetsDirectory = path.join(path.dirname(filePath), "assets");
    fs.mkdirSync(assetsDirectory, { recursive: true });
    const fileName = `${randomUUID()}${extension}`;
    fs.writeFileSync(path.join(assetsDirectory, fileName), bytes);
    return { assetUrl: `./assets/${fileName}` };
  }

  readArticleAsset(workspaceId: string, relativePath: string, fileName: string): { stream: fs.ReadStream; mimeType: string } {
    const filePath = this.resolveArticlePath(workspaceId, relativePath);
    if (!/^[A-Fa-f0-9-]{36}\.(jpg|png|gif|webp)$/.test(fileName)) throw new ContentSourceError("图片路径不合法。");
    const assetPath = path.join(path.dirname(filePath), "assets", fileName);
    if (!fs.existsSync(assetPath)) throw new ContentSourceError("找不到图片。");
    const mimeType = { ".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" }[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
    return { stream: fs.createReadStream(assetPath), mimeType };
  }

  readArticleResource(workspaceId: string, relativePath: string, sourceUrl: string, options: { rasterize?: boolean } = {}): { stream: NodeJS.ReadableStream; mimeType: string } {
    const articlePath = this.resolveArticlePath(workspaceId, relativePath);
    const rootPath = this.getSource(workspaceId)!;
    const cleanSource = decodeResourcePath(sourceUrl);
    const isBareFileName = !cleanSource.includes("/") && !cleanSource.includes("\\");
    const candidates = cleanSource.startsWith("/")
      ? [
          path.resolve(rootPath, "public", cleanSource.slice(1)),
          path.resolve(rootPath, cleanSource.slice(1))
        ]
      : [
          path.resolve(path.dirname(articlePath), cleanSource),
          ...(isBareFileName ? [path.resolve(path.dirname(articlePath), "assets", cleanSource)] : [])
        ];
    const resourcePath = candidates.find((candidate) => isPathInside(rootPath, candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!resourcePath) throw new ContentSourceError(`找不到文章引用的本地图片：${sourceUrl}。请将文件放回文章同级或 assets 目录，或删除这处图片引用后重试。`);
    const extension = path.extname(resourcePath).toLowerCase();
    const mimeType = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".avif": "image/avif"
    }[extension];
    if (!mimeType) throw new ContentSourceError("文章引用的文件不是受支持的图片。");
    if (extension === ".svg") {
      // SVGs authored with only a viewBox and no width/height attributes collapse to a
      // zero-size box inside the editor's <img> and in published output. Inject explicit
      // intrinsic dimensions parsed from the viewBox so they render at a usable size.
      const raw = fs.readFileSync(resourcePath, "utf-8");
      const normalized = withSvgIntrinsicSize(raw);
      // Renderer previews ask for a rasterized PNG by passing `rasterize: true`.
      // Browsers render inline `<img src="...svg">` documents by loading the
      // SVG and every external resource it references (web fonts, remote
      // images, `@import url(...)`). In sandboxed editors those fetches can
      // fail and the SVG collapses to a flat background rectangle. Replacing
      // every glyph with resvg's system-font fallback ships a self-contained
      // PNG that always displays. We never rewrite the original SVG on disk.
      if (options.rasterize) {
        const png = rasterizeSvgToPng(Buffer.from(normalized, "utf-8"));
        return { stream: Readable.from(png), mimeType: "image/png" };
      }
      return { stream: Readable.from(Buffer.from(normalized, "utf-8")), mimeType };
    }
    return { stream: fs.createReadStream(resourcePath), mimeType };
  }

  private resolveArticlePath(workspaceId: string, relativePath: string): string {
    const rootPath = this.getSource(workspaceId);
    if (!rootPath) throw new ContentSourceError("尚未设置文章库路径。");
    const normalizedRelativePath = relativePath.replaceAll("/", path.sep);
    if (!isArticlePath(normalizedRelativePath)) throw new ContentSourceError("所选文件不是文章库中的文章。");
    const resolved = path.resolve(rootPath, normalizedRelativePath);
    const relativeToRoot = path.relative(rootPath, resolved);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new ContentSourceError("文章路径超出已配置的文章库。");
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new ContentSourceError("找不到这篇文章，可能已被外部工具移动。");
    }
    return resolved;
  }

  private requireReadableDirectory(directory: string): fs.Stats {
    try { return fs.statSync(directory); }
    catch { throw new ContentSourceError("找不到文章库路径，或当前用户没有读取权限。"); }
  }
}

/**
 * Ensure an `<svg>` root element declares intrinsic `width`/`height`. Many diagram
 * generators emit only a `viewBox`, which leaves the image without intrinsic dimensions;
 * inside an `<img>` (editor preview, published articles) that collapses to a zero-size box.
 * When the dimensions are missing we copy them from the viewBox so the image renders.
 */
export function withSvgIntrinsicSize(svg: string): string {
  const openTagMatch = /<svg\b([^>]*)>/i.exec(svg);
  if (!openTagMatch) return svg;
  const attrs = openTagMatch[1];
  const hasWidth = /\bwidth\s*=/.test(attrs);
  const hasHeight = /\bheight\s*=/.test(attrs);
  if (hasWidth && hasHeight) return svg;
  const viewBoxMatch = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(attrs);
  if (!viewBoxMatch) return svg;
  const coords = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
  const width = coords[2];
  const height = coords[3];
  if (!width || !height || Number.isNaN(width) || Number.isNaN(height)) return svg;
  const additions: string[] = [];
  if (!hasWidth) additions.push(`width="${Math.round(width)}"`);
  if (!hasHeight) additions.push(`height="${Math.round(height)}"`);
  return svg.replace(openTagMatch[0], `<svg${attrs} ${additions.join(" ")}>`);
}

function normalizeSavedMarkdown(markdown: string): string {
  let inFence = false;
  return markdown.replace(/\r?\n/g, "\n").split("\n").map((line) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence) return line.replace(/\\[ \t]*$/, "  ");
    return line;
  }).join("\n");
}

export function stageDirectoryDeletion(
  articleDirectory: string,
  stagedPath: string,
  trashRoot: string,
  fileSystem: DeletionFileSystem = fs
): StagedArticleDeletion {
    let copiedInsteadOfMoved = false;
    try {
      fileSystem.renameSync(articleDirectory, stagedPath);
    } catch (error) {
      if (!isWindowsDirectoryBusyError(error)) throw error;
      copiedInsteadOfMoved = true;
      copyDirectoryFileByFile(articleDirectory, stagedPath, fileSystem);
      try {
        removeDirectoryFileByFile(articleDirectory, fileSystem);
      } catch (removeError) {
        try {
          copyDirectoryFileByFile(stagedPath, articleDirectory, fileSystem);
          removeDirectoryFileByFile(stagedPath, fileSystem);
        } catch {
          // Keep the staged copy if restoring the original is also blocked.
        }
        throw new ContentSourceError("文章目录正在被其他程序占用。请关闭 Obsidian 中这篇文章、VitePress 预览或资源管理器预览窗格后重试删除。", { cause: removeError });
      }
    }
    let active = true;
    return {
      finalize: () => {
        if (!active) return;
        try {
          removeDirectoryFileByFile(stagedPath, fileSystem);
        } catch {
          // The original article is already deleted. A later cleanup may remove
          // a trash copy that is temporarily held by an external Windows process.
        }
        active = false;
        try {
          if (fileSystem.readdirSync(trashRoot).length === 0) fileSystem.rmdirSync(trashRoot);
        } catch {
          // A later cleanup can remove an empty staging directory.
        }
      },
      rollback: () => {
        if (!active || !fileSystem.existsSync(stagedPath)) return;
        if (copiedInsteadOfMoved) {
          copyDirectoryFileByFile(stagedPath, articleDirectory, fileSystem);
          removeDirectoryFileByFile(stagedPath, fileSystem);
        } else {
          fileSystem.renameSync(stagedPath, articleDirectory);
        }
        active = false;
      }
    };
}

function copyDirectoryFileByFile(source: string, destination: string, fileSystem: DeletionFileSystem): void {
  fileSystem.mkdirSync(destination, { recursive: true });
  const entries = fileSystem.readdirSync(source, { withFileTypes: true }) as fs.Dirent[];
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryFileByFile(sourcePath, destinationPath, fileSystem);
    } else if (entry.isFile()) {
      fileSystem.copyFileSync(sourcePath, destinationPath);
    } else {
      throw new ContentSourceError(`文章目录包含暂不支持安全删除的文件类型：${entry.name}`);
    }
  }
}

function removeDirectoryFileByFile(directory: string, fileSystem: DeletionFileSystem): void {
  if (!fileSystem.existsSync(directory)) return;
  const entries = fileSystem.readdirSync(directory, { withFileTypes: true }) as fs.Dirent[];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removeDirectoryFileByFile(entryPath, fileSystem);
    } else {
      fileSystem.unlinkSync(entryPath);
    }
  }
  fileSystem.rmdirSync(directory);
}

function isWindowsDirectoryBusyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sanitizeArticleDirectoryName(title: string): string {
  const sanitized = title.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ").replace(/[. ]+$/g, "").replace(/\s+/g, " ");
  return sanitized.slice(0, 100) || "未命名文章";
}

function escapeYamlSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function extractLeadingArticleTitle(markdown: string): string | null {
  const firstContentLine = markdown.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  const match = firstContentLine ? /^#\s+(.+?)\s*#*\s*$/.exec(firstContentLine) : null;
  if (!match) return null;
  const title = match[1]
    .replace(/!\[([^\]]*)]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
  return title || null;
}

function replaceFrontMatterTitle(frontMatter: string, title: string): string {
  const titleLine = `title: '${escapeYamlSingleQuoted(title)}'`;
  if (/^title\s*:/m.test(frontMatter)) return frontMatter.replace(/^title\s*:.*$/m, titleLine);
  return frontMatter.replace(/^---\s*$/m, (opening) => `${opening}\n${titleLine}`);
}

function replaceFrontMatterArchived(frontMatter: string, archived: boolean): string {
  const archivedLine = `archived: ${archived}`;
  if (/^archived\s*:/m.test(frontMatter)) return frontMatter.replace(/^archived\s*:.*$/m, archivedLine);
  return frontMatter.replace(/\n---\s*$/, `\n${archivedLine}\n---`);
}

function normalizeArticleTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatLocalDateTime(value: Date): string {
  const part = (number: number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${part(value.getMonth() + 1)}-${part(value.getDate())} ${part(value.getHours())}:${part(value.getMinutes())}:${part(value.getSeconds())}`;
}

function toPortablePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function decodeResourcePath(sourceUrl: string): string {
  const withoutSuffix = sourceUrl.split(/[?#]/, 1)[0].trim();
  let decoded: string;
  try { decoded = decodeURIComponent(withoutSuffix); }
  catch { throw new ContentSourceError("文章图片地址格式不正确。"); }
  if (!decoded || decoded.includes("\0") || /^[a-z][a-z\d+.-]*:/i.test(decoded) || path.isAbsolute(decoded.replaceAll("/", path.sep)) && !decoded.startsWith("/")) {
    throw new ContentSourceError("文章图片地址不是可读取的本地路径。");
  }
  return decoded;
}

function isPathInside(rootPath: string, candidate: string): boolean {
  const relative = path.relative(rootPath, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isArticlePath(relativePath: string): boolean {
  const segments = relativePath.split(path.sep);
  // Existing VitePress convention: posts/<article title>/index.md.
  return segments[0] === "posts" && segments.length >= 3 && segments.at(-1)?.toLowerCase() === "index.md";
}

function parseFrontMatter(markdown: string): Pick<ContentSourcePreviewItem, "title" | "frontMatterKeys" | "tags" | "createdAt" | "archived"> {
  if (!markdown.startsWith("---")) return { title: null, frontMatterKeys: [], tags: [], createdAt: null, archived: false };
  const closing = markdown.indexOf("\n---", 3);
  if (closing < 0) return { title: null, frontMatterKeys: [], tags: [], createdAt: null, archived: false };
  const lines = markdown.slice(3, closing).split(/\r?\n/);
  const frontMatterKeys = lines.map((line) => /^([A-Za-z][\w-]*):/.exec(line.trim())?.[1]).filter((key): key is string => Boolean(key));
  const title = lines.map((line) => /^title:\s*["']?(.+?)["']?\s*$/.exec(line.trim())?.[1]).find((value): value is string => Boolean(value)) ?? null;
  const createdAt = lines.map((line) => /^created:\s*["']?(.+?)["']?\s*$/.exec(line.trim())?.[1]).find((value): value is string => Boolean(value)) ?? null;
  const archivedLine = lines.map((line) => /^archived:\s*(.+?)\s*$/.exec(line.trim())?.[1]).find((value): value is string | undefined => Boolean(value));
  const archived = archivedLine ? /^(true|yes|1)$/i.test(archivedLine) : false;
  const tags = parseFrontMatterTags(markdown.slice(3, closing));
  return { title, frontMatterKeys, tags, createdAt, archived };
}

/**
 * 从 front matter 文本中解析 tags。兼容两种常见写法：
 * 1) 逗号/分号分隔的标量：tags: AI安全, 实战教程
 * 2) YAML 列表：tags:\n  - AI安全\n  - 实战教程\n  或 tags: [AI安全, 实战教程]
 * 返回去重、去空、trim 后的标签数组。
 */
export function parseFrontMatterTags(frontMatter: string): string[] {
  const lines = frontMatter.split(/\r?\n/);
  let inTags = false;
  const raw: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (inTags) {
      if (/^[A-Za-z][\w-]*:/.test(trimmed)) break;
      if (/^-\s+(.+)$/.test(trimmed)) {
        raw.push(trimmed.replace(/^-\s+/, ""));
        continue;
      }
      // 数组行内格式 tags: [a, b]
      const inline = /^tags:\s*\[([^\]]*)\]/.exec(trimmed);
      if (inline) {
        raw.push(...inline[1].split(/[,，]/));
        break;
      }
      break;
    }
    if (/^tags\s*:/.test(trimmed)) {
      const scalar = /^tags\s*:\s*["']?(.+?)["']?\s*$/.exec(trimmed);
      if (scalar) {
        raw.push(...scalar[1].split(/[,，]/));
        break;
      }
      const inline = /^tags\s*:\s*\[([^\]]*)\]/.exec(trimmed);
      if (inline) {
        raw.push(...inline[1].split(/[,，]/));
        break;
      }
      inTags = true;
    }
  }
  const result = raw.map((value) => value.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  return [...new Set(result)];
}

export function getArticleTags(frontMatter: string): string[] {
  return parseFrontMatterTags(frontMatter);
}

function parseCreatedTimestamp(value: string | null): number {
  if (!value) return 0;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function splitFrontMatter(markdown: string): { frontMatter: string; body: string } {
  if (!markdown.startsWith("---")) return { frontMatter: "", body: markdown };
  const closing = markdown.indexOf("\n---", 3);
  if (closing < 0) return { frontMatter: "", body: markdown };
  const frontMatterEnd = closing + 4;
  return {
    frontMatter: markdown.slice(0, frontMatterEnd),
    body: markdown.slice(frontMatterEnd).replace(/^\r?\n+/, "")
  };
}
