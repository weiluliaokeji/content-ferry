import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { rasterizeSvgToPng } from "../../shared/svg-rasterize";
import { rasterizeSvgOffMainThread } from "./svg-rasterizer";

export interface ContentSourcePreviewItem {
  relativePath: string;
  title: string | null;
  frontMatterKeys: string[];
  tags: string[];
  createdAt: string | null;
  status: "draft" | "published" | null;
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

export type ContentSourceType = "vitepress" | "plain";

export interface ArticlePathPattern {
  baseDir: string;
  entryFile: string;
  assetDir: string;
  extraIgnoreDirs: string[];
}

export interface ContentSourceConfig {
  rootPath: string;
  sourceType: ContentSourceType;
  pattern: ArticlePathPattern;
}

export interface ContentSourceArticle {
  relativePath: string;
  title: string | null;
  markdown: string;
  frontMatter: string;
}

export interface RelatedContentArticle {
  title: string;
  relativePath: string;
  excerpt: string;
}

export interface ArticleResourceMetadata {
  resourcePath: string;
  mimeType: string;
  size: number;
  modifiedAtMs: number;
}

export interface PortableArticlePracticeSource {
  type: "web_capture";
  title: string;
  sourceUrl: string;
  capturedAt: string;
  conditions: string;
  imagePath: string;
  imageSha256: string;
}

export interface PortableArticlePracticeDemoCapture {
  type: "demo_capture";
  captureKind?: "command_output";
  title: string;
  capturedAt: string;
  conditions: string;
  imagePath: string;
  imageSha256: string;
}

export interface PortableArticlePracticeParagraphLink {
  type: "practice_paragraph_link";
  title: string;
  claim: string;
  capturedAt: string;
  conditions: string;
  paragraphSha256: string;
  sourceUrl?: string;
  screenshotSha256?: string;
  status: "linked" | "pending_review";
}

export interface PortableArticlePracticeObservation {
  type: "practice_observation";
  title: string;
  claim: string;
  capturedAt: string;
  conditions: string;
  sourceUrl?: string;
  screenshotSha256?: string;
  status: "pending_review";
}

export interface PortableArticlePracticeImageDerivative {
  type: "image_derivative";
  purpose: "article_cover" | "article_body";
  parentImagePath: string;
  parentImageSha256: string;
  imagePath: string;
  imageSha256: string;
  createdAt: string;
}

export interface ArticlePracticeImageDerivativeView extends PortableArticlePracticeImageDerivative {
  parentStatus: "matched" | "missing" | "changed";
  imageStatus: "matched" | "missing" | "changed";
  bodyStatus?: ArticlePracticeCaptureBodyStatus;
  bodyImagePath?: string;
}

export type ArticlePracticeCaptureBodyStatus = "linked" | "moved" | "not_in_body" | "missing" | "modified";

export interface PracticeCaptureBodyStatus {
  bodyStatus: ArticlePracticeCaptureBodyStatus;
  bodyImagePath?: string;
}

export type ArticlePracticeSourceView =
  | (PortableArticlePracticeSource & { bodyStatus: ArticlePracticeCaptureBodyStatus; bodyImagePath?: string })
  | (PortableArticlePracticeDemoCapture & { bodyStatus: ArticlePracticeCaptureBodyStatus; bodyImagePath?: string })
  | PortableArticlePracticeParagraphLink
  | PortableArticlePracticeObservation
  | ArticlePracticeImageDerivativeView;

interface PortableArticlePracticeSourceManifest {
  version: 4;
  sources: Array<PortableArticlePracticeSource | PortableArticlePracticeDemoCapture | PortableArticlePracticeParagraphLink | PortableArticlePracticeObservation | PortableArticlePracticeImageDerivative>;
}

type RasterizedSvgCacheEntry = { signature: string; png: Buffer };

export interface StagedArticleDeletion {
  finalize(): void;
  rollback(): void;
}

interface ReversibleDirectoryMove {
  commit(): void;
  rollback(): void;
}

type DeletionFileSystem = Pick<typeof fs,
  "renameSync" | "copyFileSync" | "unlinkSync" | "mkdirSync" | "existsSync" |
  "readdirSync" | "rmdirSync">;

const defaultPattern: Record<ContentSourceType, ArticlePathPattern> = {
  vitepress: { baseDir: "posts", entryFile: "index.md", assetDir: "assets", extraIgnoreDirs: [".vitepress"] },
  plain: { baseDir: "", entryFile: "index.md", assetDir: "assets", extraIgnoreDirs: [] }
};
const ignoredDirectories = new Set([".git", "node_modules", "dist", ".contentferry-trash"]);
const maxPreviewItems = 200;

export class ContentSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "ContentSourceError"; }
}

export class ContentSourceService {
  private readonly rasterizedSvgCache = new Map<string, RasterizedSvgCacheEntry>();
  private readonly rasterizedSvgPending = new Map<string, Promise<Buffer>>();

  constructor(private readonly db: Database.Database) {}

  getSource(workspaceId: string): string | null {
    return this.getSourceConfig(workspaceId)?.rootPath ?? null;
  }

  getSourceConfig(workspaceId: string): ContentSourceConfig | null {
    const row = this.db.prepare("SELECT root_path AS rootPath, source_type AS sourceType, pattern_json AS patternJson FROM content_sources WHERE workspace_id = ?")
      .get(workspaceId) as { rootPath: string; sourceType?: string; patternJson?: string } | undefined;
    if (!row) return null;
    const sourceType = row.sourceType === "plain" ? "plain" : "vitepress";
    return { rootPath: row.rootPath, sourceType, pattern: readPattern(row.patternJson, sourceType) };
  }

  setSource(workspaceId: string, rootPath: string, sourceType: ContentSourceType = "vitepress", pattern?: Partial<ArticlePathPattern>): string {
    const resolved = path.resolve(rootPath);
    const stats = this.requireReadableDirectory(resolved);
    if (!stats.isDirectory()) throw new ContentSourceError("文章库路径必须是一个文件夹。");
    const nextPattern = normalizePattern(sourceType, pattern);
    this.db.prepare(`INSERT INTO content_sources (workspace_id, root_path, source_type, pattern_json, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET root_path = excluded.root_path, source_type = excluded.source_type, pattern_json = excluded.pattern_json, updated_at = excluded.updated_at`)
      .run(workspaceId, resolved, sourceType, JSON.stringify(nextPattern), new Date().toISOString());
    return resolved;
  }

  preview(workspaceId: string): ContentSourcePreview {
    const config = this.getSourceConfig(workspaceId);
    if (!config) throw new ContentSourceError("尚未设置文章库路径。");
    const { rootPath, pattern } = config;
    this.requireReadableDirectory(rootPath);

    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name) && !pattern.extraIgnoreDirs.includes(entry.name)) walk(path.join(directory, entry.name));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          files.push(path.join(directory, entry.name));
        }
      }
    };
    walk(rootPath);
    const articleFiles = files.filter((filePath) => isArticlePath(path.relative(rootPath, filePath), pattern));
    const warnings: string[] = [];
    const allItems = articleFiles.map((filePath) => {
      const relativePath = path.relative(rootPath, filePath).split(path.sep).join("/");
      try {
        const parsed = parseFrontMatter(fs.readFileSync(filePath, "utf8"), config.sourceType);
        const fallbackCreatedAt = fs.statSync(filePath).birthtime.toISOString();
        return { relativePath, ...parsed, createdAt: parsed.createdAt ?? fallbackCreatedAt };
      } catch {
        warnings.push(`无法读取：${relativePath}`);
        return { relativePath, title: null, frontMatterKeys: [], tags: [], createdAt: null, status: null, archived: false };
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
      title: parseFrontMatter(source, this.getSourceConfig(workspaceId)?.sourceType ?? "vitepress").title,
      markdown: parts.body,
      frontMatter: parts.frontMatter
    };
  }

  searchRelatedArticles(workspaceId: string, query: string, excludeRelativePath?: string | null, limit = 3): RelatedContentArticle[] {
    const config = this.getSourceConfig(workspaceId);
    if (!config || !query.trim() || limit <= 0) return [];
    const { rootPath, pattern } = config;
    this.requireReadableDirectory(rootPath);
    const terms = extractArticleSearchTerms(query);
    if (terms.size === 0) return [];

    const filePaths: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name) && !pattern.extraIgnoreDirs.includes(entry.name)) walk(path.join(directory, entry.name));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) filePaths.push(path.join(directory, entry.name));
      }
    };
    walk(rootPath);

    const ranked: Array<RelatedContentArticle & { score: number }> = [];
    for (const filePath of filePaths) {
      const relativePath = toPortablePath(path.relative(rootPath, filePath));
      if (!isArticlePath(path.relative(rootPath, filePath), pattern) || relativePath === excludeRelativePath) continue;
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const frontMatter = parseFrontMatter(raw, config.sourceType);
        if (frontMatter.archived || frontMatter.status === "draft") continue;
        const { body } = splitFrontMatter(raw);
        const title = frontMatter.title?.trim() || extractLeadingArticleTitle(body) || path.basename(path.dirname(filePath));
        const titleTerms = extractArticleSearchTerms(title);
        const headingText = body.split(/\r?\n/u).filter((line) => /^#{1,6}\s/u.test(line)).join(" ");
        const headingTerms = extractArticleSearchTerms(headingText);
        const bodyTerms = extractArticleSearchTerms(body);
        let score = 0;
        for (const term of terms) {
          if (titleTerms.has(term)) score += 5;
          if (headingTerms.has(term)) score += 2;
          if (bodyTerms.has(term)) score += 1;
        }
        if (score < 2) continue;
        ranked.push({ title, relativePath, excerpt: selectRelatedArticleExcerpt(body, terms), score });
      } catch { /* One unreadable historical article must not block drafting. */ }
    }
    return ranked.sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath, "zh-CN"))
      .slice(0, Math.min(limit, 5))
      .map(({ title, relativePath, excerpt }) => ({ title, relativePath, excerpt }));
  }

  getArticleTags(workspaceId: string, relativePath: string): string[] {
    const filePath = this.resolveArticlePath(workspaceId, relativePath);
    const source = fs.readFileSync(filePath, "utf8");
    const parts = splitFrontMatter(source);
    return parseFrontMatterTags(parts.frontMatter);
  }

  saveArticle(workspaceId: string, relativePath: string, markdown: string): ContentSourceArticle {
    const filePath = this.resolveArticlePath(workspaceId, relativePath);
    const config = this.getSourceConfig(workspaceId)!;
    const { rootPath, pattern } = config;
    const source = fs.readFileSync(filePath, "utf8");
    const parts = splitFrontMatter(source);
    const normalizedBody = normalizeSavedMarkdown(markdown).replace(/^\s+/, "").replace(/\s+$/, "");
    const currentTitle = parseFrontMatter(source, config.sourceType).title;
    const nextTitle = extractLeadingArticleTitle(normalizedBody) ?? currentTitle;
    const nextFrontMatter = nextTitle && parts.frontMatter
      ? replaceFrontMatterTitle(parts.frontMatter, nextTitle)
      : parts.frontMatter;
    const nextSource = nextFrontMatter
      ? `${nextFrontMatter}\n\n${normalizedBody}\n`
      : `${normalizedBody}\n`;
    let nextFilePath = filePath;
    let nextRelativePath = relativePath;
    let sourceWrittenDuringRename = false;
    if (nextTitle && currentTitle && normalizeArticleTitle(nextTitle) !== normalizeArticleTitle(currentTitle)) {
      const articleDirectory = path.dirname(filePath);
      const articleRoot = pattern.baseDir ? path.resolve(rootPath, pattern.baseDir) : path.resolve(rootPath);
      if (path.basename(filePath).toLowerCase() === pattern.entryFile.toLowerCase() && isPathInside(articleRoot, articleDirectory)) {
          const nextDirectory = path.join(path.dirname(articleDirectory), sanitizeArticleDirectoryName(nextTitle));
          if (path.resolve(nextDirectory).toLowerCase() !== path.resolve(articleDirectory).toLowerCase()) {
            if (fs.existsSync(nextDirectory)) throw new ContentSourceError(`文章标题对应的目录已存在：${path.basename(nextDirectory)}`);
            const directoryMove = moveDirectoryWithRollback(articleDirectory, nextDirectory);
            nextFilePath = path.join(nextDirectory, pattern.entryFile);
            nextRelativePath = toPortablePath(path.relative(rootPath, nextFilePath));
            const now = new Date().toISOString();
            try {
              fs.writeFileSync(nextFilePath, nextSource, "utf8");
              sourceWrittenDuringRename = true;
              this.db.transaction(() => {
              this.db.prepare("UPDATE content_projects SET source_relative_path = ?, updated_at = ? WHERE workspace_id = ? AND source_relative_path = ?")
                .run(nextRelativePath, now, workspaceId, relativePath);
              this.db.prepare("UPDATE article_settings SET context_key = ? WHERE context_key = ?")
                .run(`source:${nextRelativePath}`, `source:${relativePath}`);
              this.db.prepare("UPDATE image_search_history SET context_key = ? WHERE context_key = ?")
                .run(`source:${nextRelativePath}`, `source:${relativePath}`);
              this.migrateArticleContext(`source:${relativePath}`, `source:${nextRelativePath}`);
            })();
              directoryMove.commit();
            } catch (error) {
              let recoveryError: unknown;
              try { fs.writeFileSync(nextFilePath, source, "utf8"); }
              catch (restoreError) { recoveryError = restoreError; }
              try {
                directoryMove.rollback();
              } catch (rollbackError) {
                recoveryError ??= rollbackError;
              }
              if (recoveryError) throw new ContentSourceError("文章标题迁移失败，数据库与文章目录均未能恢复一致。请先备份文章目录，再联系支持人员处理。", { cause: recoveryError });
              throw error;
            }
        }
      }
    }
    if (!sourceWrittenDuringRename) fs.writeFileSync(nextFilePath, nextSource, "utf8");
    return this.getArticle(workspaceId, nextRelativePath);
  }

  private migrateArticleContext(previousContextKey: string, nextContextKey: string): void {
    const oldThread = this.db.prepare("SELECT memory, updated_at AS updatedAt FROM article_chat_threads WHERE context_key = ?")
      .get(previousContextKey) as { memory: string; updatedAt: string } | undefined;
    const newThread = this.db.prepare("SELECT memory, updated_at AS updatedAt FROM article_chat_threads WHERE context_key = ?")
      .get(nextContextKey) as { memory: string; updatedAt: string } | undefined;

    if (oldThread && !newThread) {
      this.db.prepare("INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, ?, ?)")
        .run(nextContextKey, oldThread.memory, oldThread.updatedAt);
    } else if (oldThread && newThread) {
      const mergedMemory = [newThread.memory, oldThread.memory].filter(Boolean).join("\n");
      this.db.prepare("UPDATE article_chat_threads SET memory = ?, updated_at = MAX(updated_at, ?) WHERE context_key = ?")
        .run(mergedMemory, oldThread.updatedAt, nextContextKey);
    }

    this.db.prepare("UPDATE article_chat_messages SET context_key = ? WHERE context_key = ?")
      .run(nextContextKey, previousContextKey);
    if (oldThread) this.db.prepare("DELETE FROM article_chat_threads WHERE context_key = ?").run(previousContextKey);

    this.db.prepare("UPDATE article_quality_checks SET context_key = ? WHERE context_key = ?")
      .run(nextContextKey, previousContextKey);
    this.db.prepare("UPDATE agent_events SET scope_key = ? WHERE scope_key = ?")
      .run(nextContextKey, previousContextKey);
    this.db.prepare("UPDATE memory_candidates SET scope_key = ? WHERE scope_key = ?")
      .run(nextContextKey, previousContextKey);
    this.db.prepare("UPDATE agent_memories SET scope_key = ? WHERE scope_key = ?")
      .run(nextContextKey, previousContextKey);
    this.db.prepare("UPDATE memory_maintenance_state SET scope_key = ? WHERE scope_key = ?")
      .run(nextContextKey, previousContextKey);
    this.db.prepare("UPDATE writing_memories SET scope_key = ? WHERE scope_key = ?")
      .run(nextContextKey, previousContextKey);
    this.db.prepare("UPDATE memory_uses SET task_key = ? WHERE task_key = ?")
      .run(`article-chat:${nextContextKey}`, `article-chat:${previousContextKey}`);
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
    const config = this.getSourceConfig(workspaceId);
    if (!config) throw new ContentSourceError("请先配置本地文章库，再新建文章。");
    const { rootPath, pattern } = config;
    this.requireReadableDirectory(rootPath);
    const safeTitle = sanitizeArticleDirectoryName(title);
    let directoryName = safeTitle;
    let suffix = 2;
    const articleRoot = path.join(rootPath, pattern.baseDir);
    while (fs.existsSync(path.join(articleRoot, directoryName))) {
      directoryName = `${safeTitle}-${suffix++}`;
    }
    const articleDirectory = path.join(articleRoot, directoryName);
    fs.mkdirSync(path.join(articleDirectory, pattern.assetDir), { recursive: true });
    const relativePath = toPortablePath(path.join(pattern.baseDir, directoryName, pattern.entryFile));
    const created = formatLocalDateTime(new Date());
    const publicationField = config.sourceType === "vitepress" ? "publish: false" : "status: draft";
    const source = `---\ntitle: '${escapeYamlSingleQuoted(title.trim())}'\ncreated: '${created}'\ntags: []\n${publicationField}\n---\n\n# ${title.trim()}\n`;
    fs.writeFileSync(path.join(articleDirectory, pattern.entryFile), source, { encoding: "utf8", flag: "wx" });
    return this.getArticle(workspaceId, relativePath);
  }

  stageArticleDeletion(workspaceId: string, relativePath: string): StagedArticleDeletion {
    const articlePath = this.resolveArticlePath(workspaceId, relativePath);
    const rootPath = this.getSource(workspaceId)!;
    const config = this.getSourceConfig(workspaceId)!;
    const postsRoot = path.resolve(rootPath, config.pattern.baseDir);
    const articleDirectory = path.dirname(articlePath);
    if (!isPathInside(postsRoot, articleDirectory) || path.dirname(articleDirectory) === postsRoot && path.basename(articlePath).toLowerCase() !== config.pattern.entryFile.toLowerCase()) {
      throw new ContentSourceError("只能删除文章库中的标准文章目录。");
    }
    const trashRoot = path.resolve(rootPath, ".contentferry-trash");
    if (!isPathInside(rootPath, trashRoot)) throw new ContentSourceError("无法创建安全删除暂存目录。");
    fs.mkdirSync(trashRoot, { recursive: true });
    const stagedPath = path.join(trashRoot, randomUUID());
    return stageDirectoryDeletion(articleDirectory, stagedPath, trashRoot);
  }

  saveArticleAsset(workspaceId: string, relativePath: string, mimeType: string, base64: string, parentAssetPath?: string, purpose: "article_cover" | "article_body" = "article_cover"): { assetUrl: string } {
    const filePath = this.resolveArticlePath(workspaceId, relativePath);
    const extension = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" }[mimeType];
    if (!extension) throw new ContentSourceError("仅支持 JPG、PNG、GIF 和 WebP 图片。");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0 || bytes.length > 15 * 1024 * 1024) throw new ContentSourceError("图片必须小于 15 MB。");
    const config = this.getSourceConfig(workspaceId)!;
    const assetsDirectory = path.join(path.dirname(filePath), config.pattern.assetDir);
    fs.mkdirSync(assetsDirectory, { recursive: true });
    const fileName = `${randomUUID()}${extension}`;
    const imagePath = path.join(assetsDirectory, fileName);
    const assetUrl = `./${patternAssetDirectory(config.pattern)}/${fileName}`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let derivative: PortableArticlePracticeImageDerivative | undefined;
    let manifestPath: string | undefined;
    let temporaryManifestPath: string | undefined;
    let imageWritten = false;
    try {
      if (parentAssetPath) {
        const articleDirectory = path.dirname(filePath);
        const parentPath = resolveLocalArticleImagePath(articleDirectory, parentAssetPath);
        if (!parentPath || !isPathInside(articleDirectory, parentPath)) throw new ContentSourceError("裁剪来源必须位于当前文章目录内。");
        if (isPathInside(assetsDirectory, parentPath)) {
          const realAssets = fs.realpathSync(assetsDirectory);
          const realParent = fs.realpathSync(parentPath);
          if (!isPathInside(realAssets, realParent) || !fs.statSync(realParent).isFile()) throw new ContentSourceError("裁剪来源不在本篇文章素材目录中。");
          const parentSha256 = createHash("sha256").update(fs.readFileSync(realParent)).digest("hex");
          manifestPath = path.join(assetsDirectory, ".wendu-practice-sources.json");
          const manifest = readPortablePracticeManifest(manifestPath);
          const matchedSource = manifest.sources.find((source) => (source.type === "web_capture" || source.type === "demo_capture") && source.imageSha256 === parentSha256);
          if (matchedSource?.type === "web_capture" || matchedSource?.type === "demo_capture") {
            derivative = {
              type: "image_derivative", purpose, parentImagePath: `./${path.relative(articleDirectory, realParent).replaceAll("\\", "/")}`,
              parentImageSha256: parentSha256, imagePath: assetUrl, imageSha256: sha256, createdAt: new Date().toISOString()
            };
            temporaryManifestPath = `${manifestPath}.${randomUUID()}.tmp`;
            const next: PortableArticlePracticeSourceManifest = { version: 4, sources: [...manifest.sources, derivative] };
            const serialized = `${JSON.stringify(next, null, 2)}\n`;
            if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024 || next.sources.length > 500) throw new ContentSourceError("文章实践来源清单已达到大小上限，未保存裁剪版本。");
            fs.writeFileSync(temporaryManifestPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
          }
        }
      }
      fs.writeFileSync(imagePath, bytes, { encoding: undefined, flag: "wx", mode: 0o600 });
      imageWritten = true;
      if (temporaryManifestPath && manifestPath) fs.renameSync(temporaryManifestPath, manifestPath);
      return { assetUrl };
    } catch (error) {
      if (temporaryManifestPath && fs.existsSync(temporaryManifestPath)) fs.unlinkSync(temporaryManifestPath);
      if (imageWritten && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      throw error;
    }
  }

  saveArticlePracticeCapture(workspaceId: string, relativePath: string, base64: string, source: Omit<PortableArticlePracticeSource, "type" | "imagePath" | "imageSha256">): { assetUrl: string; sha256: string } {
    const articlePath = this.resolveArticlePath(workspaceId, relativePath);
    const config = this.getSourceConfig(workspaceId);
    if (!config) throw new ContentSourceError("文章库设置已变化，无法保存实践截图。");
    const url = new URL(source.sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password || !Number.isFinite(Date.parse(source.capturedAt))) throw new ContentSourceError("实践来源清单只接受公开 HTTPS 地址和有效采集时间。");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0 || bytes.length > 15 * 1024 * 1024) throw new ContentSourceError("截图必须小于 15 MB。");
    const assetsDirectory = path.join(path.dirname(articlePath), config.pattern.assetDir);
    fs.mkdirSync(assetsDirectory, { recursive: true });
    const fileName = `${randomUUID()}.png`;
    const imagePath = path.join(assetsDirectory, fileName);
    const assetUrl = `./${patternAssetDirectory(config.pattern)}/${fileName}`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const shareableSourceUrl = new URL(url.origin + url.pathname).toString();
    const manifestPath = path.join(assetsDirectory, ".wendu-practice-sources.json");
    const temporaryManifestPath = `${manifestPath}.${randomUUID()}.tmp`;
    let imageWritten = false;
    try {
      fs.writeFileSync(imagePath, bytes, { encoding: undefined, flag: "wx", mode: 0o600 });
      imageWritten = true;
      const manifest = readPortablePracticeManifest(manifestPath);
      const entry: PortableArticlePracticeSource = {
        type: "web_capture",
        title: source.title.slice(0, 300),
        sourceUrl: shareableSourceUrl,
        capturedAt: source.capturedAt,
        conditions: source.conditions.slice(0, 500),
        imagePath: assetUrl,
        imageSha256: sha256
      };
      const next: PortableArticlePracticeSourceManifest = { version: 4, sources: [...manifest.sources, entry] };
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024 || next.sources.length > 500) throw new ContentSourceError("文章实践来源清单已达到大小上限，未保存截图。");
      fs.writeFileSync(temporaryManifestPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temporaryManifestPath, manifestPath);
      return { assetUrl, sha256 };
    } catch (error) {
      if (fs.existsSync(temporaryManifestPath)) fs.unlinkSync(temporaryManifestPath);
      if (imageWritten && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      throw error;
    }
  }

  saveArticlePracticeDemoCapture(workspaceId: string, relativePath: string, base64: string, source: Omit<PortableArticlePracticeDemoCapture, "type" | "imagePath" | "imageSha256">): { assetUrl: string; sha256: string } {
    const articlePath = this.resolveArticlePath(workspaceId, relativePath);
    const config = this.getSourceConfig(workspaceId);
    if (!config) throw new ContentSourceError("文章库设置已变化，无法保存 Demo 截图。");
    if (!source.title.trim() || source.title.length > 300 || !Number.isFinite(Date.parse(source.capturedAt)) || !source.conditions.trim() || source.conditions.length > 500) {
      throw new ContentSourceError("本地 Demo 截图来源信息不完整。");
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0 || bytes.length > 15 * 1024 * 1024) throw new ContentSourceError("本地 Demo 截图必须小于 15 MB。");
    const assetsDirectory = path.join(path.dirname(articlePath), config.pattern.assetDir);
    fs.mkdirSync(assetsDirectory, { recursive: true });
    const fileName = `${randomUUID()}.png`;
    const imagePath = path.join(assetsDirectory, fileName);
    const assetUrl = `./${patternAssetDirectory(config.pattern)}/${fileName}`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const manifestPath = path.join(assetsDirectory, ".wendu-practice-sources.json");
    const temporaryManifestPath = `${manifestPath}.${randomUUID()}.tmp`;
    let imageWritten = false;
    try {
      fs.writeFileSync(imagePath, bytes, { encoding: undefined, flag: "wx", mode: 0o600 });
      imageWritten = true;
      const manifest = readPortablePracticeManifest(manifestPath);
      const entry: PortableArticlePracticeDemoCapture = {
        type: "demo_capture",
        ...(source.captureKind ? { captureKind: source.captureKind } : {}),
        title: source.title.trim(),
        capturedAt: source.capturedAt,
        conditions: source.conditions.trim(),
        imagePath: assetUrl,
        imageSha256: sha256
      };
      const next: PortableArticlePracticeSourceManifest = { version: 4, sources: [...manifest.sources, entry] };
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024 || next.sources.length > 500) throw new ContentSourceError("文章实践来源清单已达到大小上限，未保存 Demo 截图。");
      fs.writeFileSync(temporaryManifestPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temporaryManifestPath, manifestPath);
      return { assetUrl, sha256 };
    } catch (error) {
      if (fs.existsSync(temporaryManifestPath)) fs.unlinkSync(temporaryManifestPath);
      if (imageWritten && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      throw error;
    }
  }

  linkArticlePracticeParagraph(workspaceId: string, relativePath: string, input: {
    title: string; claim: string; capturedAt: string; paragraphText: string; conditions?: string; sourceUrl?: string; screenshotSha256?: string;
  }): PortableArticlePracticeParagraphLink {
    const articlePath = this.resolveArticlePath(workspaceId, relativePath);
    const config = this.getSourceConfig(workspaceId);
    if (!config) throw new ContentSourceError("文章库设置已变化，无法保存实践来源。");
    if (!input.title.trim() || !input.claim.trim() || !Number.isFinite(Date.parse(input.capturedAt)) || input.paragraphText.trim().length < 8 || input.paragraphText.length > 5000) {
      throw new ContentSourceError("实践结论或正文段落信息不完整，无法建立来源关联。");
    }
    const markdown = fs.readFileSync(articlePath, "utf8");
    const paragraphSha256 = createHash("sha256").update(normalizeProvenanceText(input.paragraphText), "utf8").digest("hex");
    const occurrences = countParagraphHashOccurrences(markdown, paragraphSha256);
    const entry: PortableArticlePracticeParagraphLink = {
      type: "practice_paragraph_link",
      title: input.title.trim().slice(0, 300),
      claim: input.claim.trim().slice(0, 500),
      capturedAt: input.capturedAt,
      conditions: portablePracticeConditions(input.conditions),
      paragraphSha256,
      ...(shareableHttpsUrl(input.sourceUrl) ? { sourceUrl: shareableHttpsUrl(input.sourceUrl) } : {}),
      ...(input.screenshotSha256 && /^[a-f0-9]{64}$/iu.test(input.screenshotSha256) ? { screenshotSha256: input.screenshotSha256 } : {}),
      status: occurrences === 1 ? "linked" : "pending_review"
    };
    const assetsDirectory = path.join(path.dirname(articlePath), config.pattern.assetDir);
    fs.mkdirSync(assetsDirectory, { recursive: true });
    const manifestPath = path.join(assetsDirectory, ".wendu-practice-sources.json");
    const temporaryManifestPath = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      const manifest = readPortablePracticeManifest(manifestPath);
      const existing = manifest.sources.find((source) => source.type === "practice_paragraph_link" &&
        source.paragraphSha256 === entry.paragraphSha256 && source.claim === entry.claim && source.capturedAt === entry.capturedAt);
      if (existing?.type === "practice_paragraph_link") return existing;
      const next: PortableArticlePracticeSourceManifest = { version: 4, sources: [...manifest.sources, entry] };
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024 || next.sources.length > 500) throw new ContentSourceError("文章实践来源清单已达到大小上限。");
      fs.writeFileSync(temporaryManifestPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temporaryManifestPath, manifestPath);
      return entry;
    } catch (error) {
      if (fs.existsSync(temporaryManifestPath)) fs.unlinkSync(temporaryManifestPath);
      throw error;
    }
  }

  reanchorArticlePracticeParagraph(workspaceId: string, relativePath: string, input: {
    claim: string; capturedAt: string; expectedParagraphSha256: string; paragraphText: string;
  }): boolean {
    const articlePath = this.resolveArticlePath(workspaceId, relativePath);
    const config = this.getSourceConfig(workspaceId);
    if (!config || !/^[a-f0-9]{64}$/iu.test(input.expectedParagraphSha256) || input.paragraphText.trim().length < 8 || input.paragraphText.length > 5000) return false;
    const markdown = fs.readFileSync(articlePath, "utf8");
    const nextParagraphSha256 = createHash("sha256").update(normalizeProvenanceText(input.paragraphText), "utf8").digest("hex");
    if (countParagraphHashOccurrences(markdown, nextParagraphSha256) !== 1) return false;
    const manifestPath = path.join(path.dirname(articlePath), config.pattern.assetDir, ".wendu-practice-sources.json");
    const temporaryManifestPath = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      const manifest = readPortablePracticeManifest(manifestPath);
      const index = manifest.sources.findIndex((source) => source.type === "practice_paragraph_link" &&
        source.paragraphSha256 === input.expectedParagraphSha256 && source.claim === input.claim && source.capturedAt === input.capturedAt);
      if (index < 0) return false;
      const existing = manifest.sources[index];
      if (existing.type !== "practice_paragraph_link") return false;
      manifest.sources[index] = { ...existing, paragraphSha256: nextParagraphSha256, status: "linked" };
      const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
      fs.writeFileSync(temporaryManifestPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temporaryManifestPath, manifestPath);
      return true;
    } catch (error) {
      if (fs.existsSync(temporaryManifestPath)) fs.unlinkSync(temporaryManifestPath);
      throw error;
    }
  }

  recordArticlePracticeObservation(workspaceId: string, relativePath: string, input: {
    title: string; claim: string; capturedAt: string; conditions: string; sourceUrl?: string; screenshotSha256?: string;
  }): PortableArticlePracticeObservation {
    const articlePath = this.resolveArticlePath(workspaceId, relativePath);
    const config = this.getSourceConfig(workspaceId);
    if (!config) throw new ContentSourceError("文章库设置已变化，无法保存实践来源。");
    const title = input.title.trim().slice(0, 300);
    const claim = input.claim.trim().slice(0, 500);
    const conditions = input.conditions.trim().slice(0, 500);
    const sourceUrl = shareableHttpsUrl(input.sourceUrl);
    const screenshotSha256 = input.screenshotSha256 && /^[a-f0-9]{64}$/iu.test(input.screenshotSha256) ? input.screenshotSha256 : undefined;
    if (!title || !claim || !conditions || !Number.isFinite(Date.parse(input.capturedAt)) || input.claim.length > 500 || input.conditions.length > 500 ||
      (input.sourceUrl !== undefined && !sourceUrl) || (input.screenshotSha256 !== undefined && !screenshotSha256)) {
      throw new ContentSourceError("实践观察摘要或来源信息不完整，无法加入文章来源清单。");
    }
    const entry: PortableArticlePracticeObservation = {
      type: "practice_observation", title, claim, capturedAt: input.capturedAt, conditions,
      ...(sourceUrl ? { sourceUrl } : {}), ...(screenshotSha256 ? { screenshotSha256 } : {}), status: "pending_review"
    };
    const assetsDirectory = path.join(path.dirname(articlePath), config.pattern.assetDir);
    fs.mkdirSync(assetsDirectory, { recursive: true });
    const manifestPath = path.join(assetsDirectory, ".wendu-practice-sources.json");
    const temporaryManifestPath = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      const manifest = readPortablePracticeManifest(manifestPath);
      const existing = manifest.sources.find((source) => source.type === "practice_observation" &&
        source.title === entry.title && source.claim === entry.claim && source.capturedAt === entry.capturedAt);
      if (existing?.type === "practice_observation") return existing;
      const next: PortableArticlePracticeSourceManifest = { version: 4, sources: [...manifest.sources, entry] };
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024 || next.sources.length > 500) throw new ContentSourceError("文章实践来源清单已达到大小上限。");
      fs.writeFileSync(temporaryManifestPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temporaryManifestPath, manifestPath);
      return entry;
    } catch (error) {
      if (fs.existsSync(temporaryManifestPath)) fs.unlinkSync(temporaryManifestPath);
      throw error;
    }
  }

  listArticlePracticeSources(workspaceId: string, relativePath: string): ArticlePracticeSourceView[] {
    const articlePath = this.resolveArticlePath(workspaceId, relativePath);
    const config = this.getSourceConfig(workspaceId);
    if (!config) return [];
    const manifestPath = path.join(path.dirname(articlePath), config.pattern.assetDir, ".wendu-practice-sources.json");
    const manifest = readPortablePracticeManifest(manifestPath);
    const markdown = fs.readFileSync(articlePath, "utf8");
    const assetsDirectory = path.join(path.dirname(articlePath), config.pattern.assetDir);
    return manifest.sources.map((source): ArticlePracticeSourceView => {
      if (source.type === "web_capture" || source.type === "demo_capture") return { ...source, ...resolvePracticeCaptureBodyStatus(markdown, articlePath, assetsDirectory, source) };
      if (source.type === "image_derivative") return { ...source,
        parentStatus: resolvePracticeImageFileStatus(articlePath, assetsDirectory, source.parentImagePath, source.parentImageSha256),
        imageStatus: resolvePracticeImageFileStatus(articlePath, assetsDirectory, source.imagePath, source.imageSha256),
        ...(source.purpose === "article_body" ? resolvePracticeCaptureBodyStatus(markdown, articlePath, assetsDirectory, source) : {})
      };
      if (source.type === "practice_observation") return source;
      const uniquelyPresent = countParagraphHashOccurrences(markdown, source.paragraphSha256) === 1;
      return { ...source, status: uniquelyPresent ? "linked" : "pending_review" };
    });
  }

  readArticleAsset(workspaceId: string, relativePath: string, fileName: string): { stream: fs.ReadStream; mimeType: string } {
    const filePath = this.resolveArticlePath(workspaceId, relativePath);
    if (!/^[A-Fa-f0-9-]{36}\.(jpg|png|gif|webp)$/.test(fileName)) throw new ContentSourceError("图片路径不合法。");
    const assetPath = path.join(path.dirname(filePath), this.getSourceConfig(workspaceId)!.pattern.assetDir, fileName);
    if (!fs.existsSync(assetPath)) throw new ContentSourceError("找不到图片。");
    const mimeType = { ".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" }[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
    return { stream: fs.createReadStream(assetPath), mimeType };
  }

  readArticleResource(workspaceId: string, relativePath: string, sourceUrl: string, options: { rasterize?: boolean } = {}): { stream: NodeJS.ReadableStream; mimeType: string } {
    const metadata = this.inspectArticleResource(workspaceId, relativePath, sourceUrl);
    const { resourcePath, mimeType } = metadata;
    if (mimeType === "image/svg+xml") {
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

  async readArticleResourceAsync(workspaceId: string, relativePath: string, sourceUrl: string, options: { rasterize?: boolean } = {}): Promise<{ stream: NodeJS.ReadableStream; mimeType: string }> {
    const metadata = this.inspectArticleResource(workspaceId, relativePath, sourceUrl);
    if (!options.rasterize || metadata.mimeType !== "image/svg+xml") return this.readArticleResource(workspaceId, relativePath, sourceUrl, options);
    const signature = `${metadata.size}:${metadata.modifiedAtMs}`;
    const cached = this.rasterizedSvgCache.get(metadata.resourcePath);
    if (cached?.signature === signature) return { stream: Readable.from(cached.png), mimeType: "image/png" };
    const pendingKey = `${metadata.resourcePath}\u0000${signature}`;
    const pending = this.rasterizedSvgPending.get(pendingKey) ?? this.createRasterizedSvg(metadata.resourcePath, signature, pendingKey);
    const png = await pending;
    return { stream: Readable.from(png), mimeType: "image/png" };
  }

  inspectArticleResource(workspaceId: string, relativePath: string, sourceUrl: string): ArticleResourceMetadata {
    const articlePath = this.resolveArticlePath(workspaceId, relativePath);
    const config = this.getSourceConfig(workspaceId)!;
    const rootPath = config.rootPath;
    const cleanSource = decodeResourcePath(sourceUrl);
    const isBareFileName = !cleanSource.includes("/") && !cleanSource.includes("\\");
    const candidates = cleanSource.startsWith("/")
      ? (config.sourceType === "vitepress"
        ? [path.resolve(rootPath, "public", cleanSource.slice(1)), path.resolve(rootPath, cleanSource.slice(1))]
        : [path.resolve(rootPath, cleanSource.slice(1))])
      : [
          path.resolve(path.dirname(articlePath), cleanSource),
          ...(isBareFileName ? [path.resolve(path.dirname(articlePath), config.pattern.assetDir, cleanSource)] : [])
        ];
    const resourcePath = candidates.find((candidate) => isPathInside(rootPath, candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!resourcePath) throw new ContentSourceError(`找不到文章引用的本地图片：${sourceUrl}。请将文件放回文章同级或 ${config.pattern.assetDir} 目录，或删除这处图片引用后重试。`);
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
    const stat = fs.statSync(resourcePath);
    return { resourcePath, mimeType, size: stat.size, modifiedAtMs: stat.mtimeMs };
  }

  private createRasterizedSvg(resourcePath: string, signature: string, pendingKey: string): Promise<Buffer> {
    const pending = (async () => {
      const raw = fs.readFileSync(resourcePath, "utf-8");
      const normalized = withSvgIntrinsicSize(raw);
      const png = await rasterizeSvgOffMainThread(Buffer.from(normalized, "utf-8"));
      this.rasterizedSvgCache.set(resourcePath, { signature, png });
      while (this.rasterizedSvgCache.size > 32) this.rasterizedSvgCache.delete(this.rasterizedSvgCache.keys().next().value as string);
      return png;
    })();
    this.rasterizedSvgPending.set(pendingKey, pending);
    void pending.then(
      () => { this.rasterizedSvgPending.delete(pendingKey); },
      () => { this.rasterizedSvgPending.delete(pendingKey); }
    );
    return pending;
  }

  private resolveArticlePath(workspaceId: string, relativePath: string): string {
    const rootPath = this.getSource(workspaceId);
    if (!rootPath) throw new ContentSourceError("尚未设置文章库路径。");
    const normalizedRelativePath = relativePath.replaceAll("/", path.sep);
    const config = this.getSourceConfig(workspaceId);
    if (!config || !isArticlePath(normalizedRelativePath, config.pattern)) throw new ContentSourceError("所选文件不是文章库中的文章。");
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

function isSafePracticeAssetPath(value: string, extensions: readonly string[]): boolean {
  if (!value.startsWith("./") || value.includes("\\") || /[?#:\u0000-\u001f]/u.test(value)) return false;
  const segments = value.slice(2).split("/");
  if (segments.length < 2 || segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  const fileName = segments.at(-1) ?? "";
  const allowedExtensions = extensions.map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  return new RegExp(`^[a-f0-9-]{36}\\.(?:${allowedExtensions})$`, "iu").test(fileName);
}

function readPortablePracticeManifest(manifestPath: string): PortableArticlePracticeSourceManifest {
  if (!fs.existsSync(manifestPath)) return { version: 4, sources: [] };
  const contents = fs.readFileSync(manifestPath, "utf8");
  if (Buffer.byteLength(contents, "utf8") > 2 * 1024 * 1024) throw new ContentSourceError("文章实践来源清单超过大小上限，未保存截图。");
  let parsed: unknown;
  try { parsed = JSON.parse(contents); } catch { throw new ContentSourceError("文章实践来源清单格式损坏，未保存截图以免覆盖原文件。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ContentSourceError("文章实践来源清单格式不正确。");
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "sources,version" || (record.version !== 1 && record.version !== 2 && record.version !== 3 && record.version !== 4) || !Array.isArray(record.sources) || record.sources.length > 500) throw new ContentSourceError("文章实践来源清单版本不支持、包含不可分享字段或记录过多。");
  const sources = record.sources.map((value): PortableArticlePracticeSource | PortableArticlePracticeDemoCapture | PortableArticlePracticeParagraphLink | PortableArticlePracticeObservation | PortableArticlePracticeImageDerivative => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContentSourceError("文章实践来源清单包含无效记录。");
    const item = value as Record<string, unknown>;
    const keys = Object.keys(item).sort().join(",");
    if (item.type === "web_capture") {
      if (keys !== "capturedAt,conditions,imagePath,imageSha256,sourceUrl,title,type" ||
        typeof item.title !== "string" || typeof item.sourceUrl !== "string" || typeof item.capturedAt !== "string" || typeof item.conditions !== "string" ||
        typeof item.imagePath !== "string" || typeof item.imageSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(item.imageSha256) ||
        !isSafePracticeAssetPath(item.imagePath, ["png"]) || !Number.isFinite(Date.parse(item.capturedAt)) ||
        item.title.length > 300 || item.conditions.length > 500) throw new ContentSourceError("文章实践来源清单包含无效或不可分享字段。");
      let sourceUrl: URL;
      try { sourceUrl = new URL(item.sourceUrl); } catch { throw new ContentSourceError("文章实践来源清单中的网址不合法。"); }
      if (sourceUrl.protocol !== "https:" || sourceUrl.username || sourceUrl.password) throw new ContentSourceError("文章实践来源清单中的来源必须为公开 HTTPS 地址。");
      return { type: "web_capture", title: item.title, sourceUrl: sourceUrl.toString(), capturedAt: item.capturedAt, conditions: item.conditions, imagePath: item.imagePath, imageSha256: item.imageSha256 };
    }
    if (item.type === "demo_capture") {
      const validDemoCaptureKeys = keys === "capturedAt,conditions,imagePath,imageSha256,title,type" ||
        keys === "captureKind,capturedAt,conditions,imagePath,imageSha256,title,type";
      if (!validDemoCaptureKeys || (item.captureKind !== undefined && item.captureKind !== "command_output") ||
        typeof item.title !== "string" || typeof item.capturedAt !== "string" || typeof item.conditions !== "string" ||
        typeof item.imagePath !== "string" || typeof item.imageSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(item.imageSha256) ||
        !isSafePracticeAssetPath(item.imagePath, ["png"]) || !Number.isFinite(Date.parse(item.capturedAt)) ||
        item.title.length < 1 || item.title.length > 300 || item.conditions.length < 1 || item.conditions.length > 500) {
        throw new ContentSourceError("文章实践来源清单包含无效的本地 Demo 截图记录。");
      }
      return { type: "demo_capture", ...(item.captureKind === "command_output" ? { captureKind: "command_output" as const } : {}), title: item.title, capturedAt: item.capturedAt, conditions: item.conditions, imagePath: item.imagePath, imageSha256: item.imageSha256 };
    }
    if (item.type === "practice_observation") {
      const observationKeys = ["capturedAt,claim,conditions,status,title,type", "capturedAt,claim,conditions,screenshotSha256,status,title,type", "capturedAt,claim,conditions,sourceUrl,status,title,type", "capturedAt,claim,conditions,screenshotSha256,sourceUrl,status,title,type"];
      if (!observationKeys.includes(keys) || typeof item.title !== "string" || typeof item.claim !== "string" || typeof item.capturedAt !== "string" ||
        typeof item.conditions !== "string" || item.status !== "pending_review" || !Number.isFinite(Date.parse(item.capturedAt)) ||
        item.title.length < 1 || item.title.length > 300 || item.claim.length < 1 || item.claim.length > 500 || item.conditions.length < 1 || item.conditions.length > 500 ||
        (item.sourceUrl !== undefined && (typeof item.sourceUrl !== "string" || !shareableHttpsUrl(item.sourceUrl) || shareableHttpsUrl(item.sourceUrl) !== item.sourceUrl)) ||
        (item.screenshotSha256 !== undefined && (typeof item.screenshotSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(item.screenshotSha256)))) {
        throw new ContentSourceError("文章实践来源清单包含无效观察摘要或不可分享字段。");
      }
      return { type: "practice_observation", title: item.title, claim: item.claim, capturedAt: item.capturedAt, conditions: item.conditions,
        ...(typeof item.sourceUrl === "string" ? { sourceUrl: item.sourceUrl } : {}),
        ...(typeof item.screenshotSha256 === "string" ? { screenshotSha256: item.screenshotSha256 } : {}), status: "pending_review" };
    }
    if (item.type === "image_derivative") {
      if (keys !== "createdAt,imagePath,imageSha256,parentImagePath,parentImageSha256,purpose,type" || !["article_cover", "article_body"].includes(String(item.purpose)) ||
        typeof item.parentImagePath !== "string" || !isSafePracticeAssetPath(item.parentImagePath, ["png", "jpg", "jpeg", "gif", "webp"]) ||
        typeof item.parentImageSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(item.parentImageSha256) ||
        typeof item.imagePath !== "string" || !isSafePracticeAssetPath(item.imagePath, ["png", "jpg", "jpeg", "gif", "webp"]) ||
        typeof item.imageSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(item.imageSha256) ||
        typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) throw new ContentSourceError("文章实践来源清单包含无效的图片衍生版本记录。");
      return { type: "image_derivative", purpose: item.purpose as "article_cover" | "article_body", parentImagePath: item.parentImagePath, parentImageSha256: item.parentImageSha256,
        imagePath: item.imagePath, imageSha256: item.imageSha256, createdAt: item.createdAt };
    }
    const baseParagraphKeys = "capturedAt,claim,conditions,paragraphSha256,status,title,type";
    const optionalParagraphKeys = [baseParagraphKeys, "capturedAt,claim,conditions,paragraphSha256,screenshotSha256,status,title,type", "capturedAt,claim,conditions,paragraphSha256,sourceUrl,status,title,type", "capturedAt,claim,conditions,paragraphSha256,screenshotSha256,sourceUrl,status,title,type",
      "capturedAt,claim,conditions,paragraphSha256,paragraphText,status,title,type", "capturedAt,claim,conditions,paragraphSha256,paragraphText,screenshotSha256,status,title,type", "capturedAt,claim,conditions,paragraphSha256,paragraphText,sourceUrl,status,title,type", "capturedAt,claim,conditions,paragraphSha256,paragraphText,screenshotSha256,sourceUrl,status,title,type"];
    if (item.type !== "practice_paragraph_link" || !optionalParagraphKeys.includes(keys) ||
      typeof item.title !== "string" || typeof item.claim !== "string" || typeof item.capturedAt !== "string" || typeof item.conditions !== "string" ||
      typeof item.paragraphSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(item.paragraphSha256) ||
      !["linked", "pending_review"].includes(String(item.status)) || !Number.isFinite(Date.parse(item.capturedAt)) ||
      item.title.length > 300 || item.claim.length > 500 || item.conditions.length > 500 ||
      (item.paragraphText !== undefined && (typeof item.paragraphText !== "string" || item.paragraphText.length < 8 || item.paragraphText.length > 5000)) ||
      (item.sourceUrl !== undefined && (typeof item.sourceUrl !== "string" || !shareableHttpsUrl(item.sourceUrl) || shareableHttpsUrl(item.sourceUrl) !== item.sourceUrl)) ||
      (item.screenshotSha256 !== undefined && (typeof item.screenshotSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(item.screenshotSha256)))) {
      throw new ContentSourceError("文章实践来源清单包含无效或不可分享字段。");
    }
    return { type: "practice_paragraph_link", title: item.title, claim: item.claim, capturedAt: item.capturedAt, conditions: item.conditions,
      paragraphSha256: item.paragraphSha256,
      ...(typeof item.sourceUrl === "string" ? { sourceUrl: item.sourceUrl } : {}),
      ...(typeof item.screenshotSha256 === "string" ? { screenshotSha256: item.screenshotSha256 } : {}),
      status: item.status as "linked" | "pending_review" };
  });
  for (const source of sources) {
      if (source.type === "image_derivative" && !sources.some((candidate) => (candidate.type === "web_capture" || candidate.type === "demo_capture") && candidate.imageSha256 === source.parentImageSha256)) {
      throw new ContentSourceError("文章实践来源清单中的图片衍生版本找不到对应原始截图。");
    }
  }
  return { version: 4, sources };
}

function normalizeProvenanceText(value: string): string { return value.replace(/\s+/g, " ").trim(); }

function portablePracticeConditions(value?: string): string {
  const conditions = (value ?? "").trim().replace(/https?:\/\/[^\s)\]}>,]+/giu, "").replace(/\s+/gu, " ");
  if (!conditions || conditions.length > 500 || /(?:[a-z]:[\\/]|\\\\[^\\]+\\|\/(?:users|home|private|tmp|var|mnt|workspaces?)\/|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|authorization)\s*[:=]|\bbearer\s+[a-z0-9._~+/-]+=*|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b)/iu.test(conditions)) {
    return "运行条件未单独记录。";
  }
  return conditions;
}

function shareableHttpsUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return `${url.origin}${url.pathname}`;
  } catch { return undefined; }
}

function countParagraphHashOccurrences(markdown: string, expectedHash: string): number {
  const blocks = markdown.split(/(?:\r?\n){2,}/u).map(normalizeProvenanceText).filter(Boolean);
  let count = 0;
  for (let start = 0; start < blocks.length; start++) {
    let candidate = "";
    for (let end = start; end < blocks.length; end++) {
      candidate = candidate ? `${candidate}\n\n${blocks[end]}` : blocks[end];
      if (createHash("sha256").update(normalizeProvenanceText(candidate), "utf8").digest("hex") === expectedHash) count++;
      if (count > 1) return count;
    }
  }
  return count;
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

function moveDirectoryWithRollback(source: string, destination: string, fileSystem: DeletionFileSystem = fs): ReversibleDirectoryMove {
  let copiedInsteadOfMoved = false;
  try {
    fileSystem.renameSync(source, destination);
  } catch (error) {
    if (!isWindowsDirectoryBusyError(error)) throw error;
    copiedInsteadOfMoved = true;
    try {
      copyDirectoryFileByFile(source, destination, fileSystem);
      removeDirectoryFileByFile(source, fileSystem);
    } catch (fallbackError) {
      try { removeDirectoryFileByFile(destination, fileSystem); } catch { /* keep the original as the source of truth */ }
      throw new ContentSourceError("文章目录正在被其他程序占用，逐文件迁移也未能完成。请关闭 Obsidian 或资源管理器预览后重试。", { cause: fallbackError });
    }
  }
  let active = true;
  return {
    commit: () => { active = false; },
    rollback: () => {
      if (!active) return;
      if (copiedInsteadOfMoved) {
        copyDirectoryFileByFile(destination, source, fileSystem);
        removeDirectoryFileByFile(destination, fileSystem);
      } else {
        fileSystem.renameSync(destination, source);
      }
      active = false;
    }
  };
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

function isArticlePath(relativePath: string, pattern: ArticlePathPattern): boolean {
  const segments = relativePath.split(path.sep);
  const hasBase = pattern.baseDir ? segments[0] === pattern.baseDir : true;
  const minimumSegments = pattern.baseDir ? 3 : 2;
  return hasBase && segments.length >= minimumSegments && segments.at(-1)?.toLowerCase() === pattern.entryFile.toLowerCase();
}

function extractArticleSearchTerms(value: string): Set<string> {
  const terms = new Set<string>();
  const normalized = value.toLocaleLowerCase("zh-CN");
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const text = match[0];
    if (text.length === 1) terms.add(text);
    for (let index = 0; index < text.length - 1; index++) terms.add(text.slice(index, index + 2));
  }
  for (const match of normalized.matchAll(/[a-z\d][a-z\d._+-]{1,}/gu)) terms.add(match[0]);
  return terms;
}

function selectRelatedArticleExcerpt(markdown: string, terms: Set<string>): string {
  const paragraphs = markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gmu, "")
    .split(/\r?\n\s*\r?\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !/^#{1,6}\s/u.test(paragraph) && !/^!\[/u.test(paragraph));
  const ranked = paragraphs.map((paragraph, index) => {
    const paragraphTerms = extractArticleSearchTerms(paragraph);
    let score = 0;
    for (const term of terms) if (paragraphTerms.has(term)) score++;
    return { paragraph, index, score };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.index - right.index);
  const excerpt = ranked.slice(0, 2).sort((left, right) => left.index - right.index).map(({ paragraph }) => paragraph).join("\n\n");
  return (excerpt || paragraphs.slice(0, 2).join("\n\n")).slice(0, 1800);
}

function normalizePattern(sourceType: ContentSourceType, pattern?: Partial<ArticlePathPattern>): ArticlePathPattern {
  const defaults = defaultPattern[sourceType];
  return {
    baseDir: safePatternSegment(pattern?.baseDir ?? defaults.baseDir, defaults.baseDir),
    entryFile: safePatternFile(pattern?.entryFile ?? defaults.entryFile, defaults.entryFile),
    assetDir: safePatternSegment(pattern?.assetDir ?? defaults.assetDir, defaults.assetDir),
    extraIgnoreDirs: [...new Set((pattern?.extraIgnoreDirs ?? defaults.extraIgnoreDirs).map((value) => safePatternSegment(value, "")).filter(Boolean))]
  };
}

function readPattern(serialized: string | undefined, sourceType: ContentSourceType): ArticlePathPattern {
  if (!serialized) return normalizePattern(sourceType);
  try {
    const value = JSON.parse(serialized) as Partial<ArticlePathPattern>;
    return normalizePattern(sourceType, value);
  } catch {
    return normalizePattern(sourceType);
  }
}

function patternAssetDirectory(pattern: ArticlePathPattern): string {
  return pattern.assetDir.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "") || "assets";
}

export function resolvePracticeCaptureBodyStatus(
  markdown: string,
  articlePath: string,
  assetsDirectory: string,
  source: { imagePath: string; imageSha256: string }
): PracticeCaptureBodyStatus {
  const articleDirectory = path.dirname(articlePath);
  const originalImagePath = resolveLocalArticleImagePath(articleDirectory, source.imagePath);
  const referencedImages = extractMarkdownImagePaths(markdown);
  let originalExists = false;
  let originalHash: string | undefined;
  if (originalImagePath && isPathInside(assetsDirectory, originalImagePath) && fs.existsSync(originalImagePath)) {
    try {
      const realAssets = fs.realpathSync(assetsDirectory);
      const realImage = fs.realpathSync(originalImagePath);
      if (isPathInside(realAssets, realImage) && fs.statSync(realImage).isFile()) {
        originalExists = true;
        originalHash = createHash("sha256").update(fs.readFileSync(realImage)).digest("hex");
      }
    } catch { /* Treat inaccessible or broken assets as unavailable evidence files. */ }
  }

  let referencesOriginal = false;
  for (const reference of referencedImages) {
    const imagePath = resolveLocalArticleImagePath(articleDirectory, reference);
    if (!imagePath || !isPathInside(assetsDirectory, imagePath)) continue;
    if (originalImagePath && path.resolve(imagePath).toLowerCase() === path.resolve(originalImagePath).toLowerCase()) referencesOriginal = true;
    try {
      const realAssets = fs.realpathSync(assetsDirectory);
      const realImage = fs.realpathSync(imagePath);
      if (!isPathInside(realAssets, realImage) || !fs.statSync(realImage).isFile()) continue;
      const hash = createHash("sha256").update(fs.readFileSync(realImage)).digest("hex");
      if (hash === source.imageSha256) {
        const bodyImagePath = `./${path.relative(articleDirectory, imagePath).replaceAll("\\", "/")}`;
        return { bodyStatus: bodyImagePath === source.imagePath ? "linked" : "moved", bodyImagePath };
      }
    } catch { /* Ignore missing, inaccessible, or broken image references. */ }
  }

  if (!originalExists) return { bodyStatus: "missing" };
  if (referencesOriginal && originalHash !== source.imageSha256) return { bodyStatus: "modified", bodyImagePath: source.imagePath };
  return { bodyStatus: "not_in_body" };
}

function resolvePracticeImageFileStatus(articlePath: string, assetsDirectory: string, imagePath: string, expectedSha256: string): "matched" | "missing" | "changed" {
  const image = resolveLocalArticleImagePath(path.dirname(articlePath), imagePath);
  if (!image || !isPathInside(assetsDirectory, image) || !fs.existsSync(image)) return "missing";
  try {
    const realAssets = fs.realpathSync(assetsDirectory);
    const realImage = fs.realpathSync(image);
    if (!isPathInside(realAssets, realImage) || !fs.statSync(realImage).isFile()) return "missing";
    const actualSha256 = createHash("sha256").update(fs.readFileSync(realImage)).digest("hex");
    return actualSha256 === expectedSha256 ? "matched" : "changed";
  } catch { return "missing"; }
}

function extractMarkdownImagePaths(markdown: string): string[] {
  const values = new Set<string>();
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/gu)) {
    const value = match[1] ?? match[2];
    if (value) values.add(value);
  }
  for (const match of markdown.matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/giu)) {
    if (match[2]) values.add(match[2]);
  }
  return [...values];
}

function resolveLocalArticleImagePath(articleDirectory: string, value: string): string | undefined {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(value)) return undefined;
  let decoded = value.trim();
  try { decoded = decodeURIComponent(decoded); } catch { return undefined; }
  decoded = decoded.split(/[?#]/u, 1)[0].replaceAll("\\", "/");
  if (!decoded) return undefined;
  return path.resolve(articleDirectory, decoded);
}

function safePatternSegment(value: string, fallback: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").trim();
  return normalized && normalized !== "." && normalized !== ".." && !normalized.includes("/") ? normalized : fallback;
}

function safePatternFile(value: string, fallback: string): string {
  const normalized = value.replaceAll("\\", "/").trim();
  return normalized && !normalized.includes("/") && normalized !== "." && normalized !== ".." ? normalized : fallback;
}

function parseFrontMatter(markdown: string, sourceType: ContentSourceType = "vitepress"): Pick<ContentSourcePreviewItem, "title" | "frontMatterKeys" | "tags" | "createdAt" | "status" | "archived"> {
  if (!markdown.startsWith("---")) return { title: null, frontMatterKeys: [], tags: [], createdAt: null, status: null, archived: false };
  const closing = markdown.indexOf("\n---", 3);
  if (closing < 0) return { title: null, frontMatterKeys: [], tags: [], createdAt: null, status: null, archived: false };
  const lines = markdown.slice(3, closing).split(/\r?\n/);
  const frontMatterKeys = lines.map((line) => /^([A-Za-z][\w-]*):/.exec(line.trim())?.[1]).filter((key): key is string => Boolean(key));
  const title = lines.map((line) => /^title:\s*["']?(.+?)["']?\s*$/.exec(line.trim())?.[1]).find((value): value is string => Boolean(value)) ?? null;
  const createdAt = lines.map((line) => /^created:\s*["']?(.+?)["']?\s*$/.exec(line.trim())?.[1]).find((value): value is string => Boolean(value)) ?? null;
  const archivedLine = lines.map((line) => /^archived:\s*(.+?)\s*$/.exec(line.trim())?.[1]).find((value): value is string | undefined => Boolean(value));
  const archived = archivedLine ? /^(true|yes|1)$/i.test(archivedLine) : false;
  const tags = parseFrontMatterTags(markdown.slice(3, closing));
  const publicationLine = sourceType === "vitepress"
    ? lines.map((line) => /^publish:\s*(.+?)\s*$/.exec(line.trim())?.[1]).find((value): value is string | undefined => Boolean(value))
    : lines.map((line) => /^status:\s*(.+?)\s*$/.exec(line.trim())?.[1]).find((value): value is string | undefined => Boolean(value));
  const status = parsePublicationStatus(publicationLine, sourceType);
  return { title, frontMatterKeys, tags, createdAt, status, archived };
}

function parsePublicationStatus(value: string | undefined, sourceType: ContentSourceType): "draft" | "published" | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  if (sourceType === "vitepress") return /^(true|yes|1|published)$/.test(normalized) ? "published" : /^(false|no|0|draft)$/.test(normalized) ? "draft" : null;
  return /^(published|publish|true|yes|1)$/.test(normalized) ? "published" : /^(draft|false|no|0)$/.test(normalized) ? "draft" : null;
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
      const inline = /^tags\s*:\s*\[([^\]]*)\]/.exec(trimmed);
      if (inline) {
        raw.push(...inline[1].split(/[,，]/));
        break;
      }
      const scalar = /^tags\s*:\s*["']?(.+?)["']?\s*$/.exec(trimmed);
      if (scalar) {
        raw.push(...scalar[1].split(/[,，]/));
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
