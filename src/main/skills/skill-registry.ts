import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ModelProviderId } from "../ai/model-connection-repository";

export interface ManagedSkill {
  id: string;
  name: string;
  description: string;
  category: "创作" | "改写" | "检测" | "图片" | "研究";
  enabled: boolean;
  provider: ModelProviderId | null;
  markdown: string;
  filePath: string;
  files: SkillFileSummary[];
}

export interface SkillFileSummary {
  relativePath: string;
  size: number;
}

type BuiltInSkillDefinition = Omit<ManagedSkill, "enabled" | "provider" | "filePath" | "files"> & {
  defaultProvider: ModelProviderId | null;
  references?: Record<string, string>;
  legacyMarkdown?: string[];
};

type BuiltInSkillManifest = {
  schemaVersion: 1;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    category: ManagedSkill["category"];
    defaultProvider: ModelProviderId | null;
    legacyFiles?: string[];
  }>;
};

const SHARED_REFERENCE_CONSUMERS = new Set(["wechat-writing", "humanize-selection"]);

// Historical built-in reference content hashes. If a reference file in the
// user's data directory matches one of these, it is an untouched older built-in
// release rather than a user edit, so it is safe to upgrade to the current
// built-in. This list is what lets existing users (whose `.skill-reference-seed.json`
// was only written on first run *after* a built-in change) receive built-in
// updates: without it the seed logic cannot tell a stale built-in from a user edit.
// Add the previous hash here every time you change a built-in reference's content.
const KNOWN_LEGACY_BUILT_IN_HASHES = new Set([
  "314cc1ba252f191f3e317a92f1c538b5f480d3d90e60489968674ff677e34837", // long-form.md (pre 共享 references 重构)
  "7dc54dcc668a737cdfa585249ec0d75ff1b45e65e154e6fe5d3b9ee83eb0e4f4", // protected-spans.md
  "dea93921ac95a8d3e0b4ad19428b3a63de1274a08ff188a9e1c83ea6b96c90e7", // public-writing-patterns.md (pre shuorenhua 融合 / 7-22 打包版内置)
  "e8309267fb63fe44cd32da42a18c15fc68dda9abbcd6e77e4753954454a43ad3", // public-writing-patterns.md (改写前仓库 HEAD 版本)
  "b422b0d06ac203feab78b5988e79111f62746b8c3d338f5f36b673036bcd0ffa"  // quality-check.md
]);

export function shouldUpgradeReference(currentHash: string | undefined, builtInHash: string, seedHash: string | undefined): boolean {
  return (
    currentHash === undefined ||
    currentHash === builtInHash ||
    KNOWN_LEGACY_BUILT_IN_HASHES.has(currentHash) ||
    (seedHash !== undefined && currentHash === seedHash)
  );
}

function readReferencesFrom(skillDirectory: string): Record<string, string> | undefined {
  const referenceDirectory = path.join(skillDirectory, "references");
  if (!fs.existsSync(referenceDirectory)) return undefined;
  return Object.fromEntries(
    fs.readdirSync(referenceDirectory)
      .filter((name) => /^[a-z0-9-]+\.md$/.test(name))
      .map((name) => [name, fs.readFileSync(path.join(referenceDirectory, name), "utf8")])
  );
}

function readSharedReferences(directory: string): Record<string, string> | undefined {
  const sharedDirectory = path.join(directory, "_shared", "references");
  if (!fs.existsSync(sharedDirectory)) return undefined;
  return Object.fromEntries(
    fs.readdirSync(sharedDirectory)
      .filter((name) => /^[a-z0-9-]+\.md$/.test(name))
      .map((name) => [name, fs.readFileSync(path.join(sharedDirectory, name), "utf8")])
  );
}

const builtIns = loadBuiltInSkills(resolveBuiltInSkillsDirectory());

function resolveBuiltInSkillsDirectory(): string {
  const resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  const candidates = [
    resourcesPath ? path.join(resourcesPath, "assets", "skills") : "",
    path.resolve(__dirname, "../../../../assets/skills"),
    path.resolve(__dirname, "../../../assets/skills"),
    path.resolve(process.cwd(), "assets", "skills")
  ].filter(Boolean);
  const existing = candidates.find((candidate) => fs.existsSync(path.join(candidate, "manifest.json")));
  if (!existing) throw new Error("找不到内置技能资源，请检查安装包是否完整。");
  return existing;
}

function loadBuiltInSkills(directory: string): BuiltInSkillDefinition[] {
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BuiltInSkillManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.skills)) throw new Error("内置技能清单格式不正确。");
  const ids = new Set<string>();
  return manifest.skills.map((entry) => {
    if (!/^[a-z0-9-]+$/.test(entry.id) || ids.has(entry.id)) throw new Error("内置技能 ID 不合法或重复。");
    ids.add(entry.id);
    if (!["研究", "创作", "改写", "检测", "图片"].includes(entry.category)) throw new Error(`内置技能分类不合法：${entry.id}`);
    const skillDirectory = path.join(directory, entry.id);
    const markdown = fs.readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");
    const ownReferences = readReferencesFrom(skillDirectory);
    const sharedReferences = SHARED_REFERENCE_CONSUMERS.has(entry.id) ? readSharedReferences(directory) : undefined;
    const references = sharedReferences ? { ...ownReferences, ...sharedReferences } : ownReferences;
    const legacyMarkdown = (entry.legacyFiles ?? []).map((relativePath) => {
      if (!/^legacy\/[a-z0-9-]+\.md$/.test(relativePath)) throw new Error(`内置技能兼容文件路径不合法：${entry.id}`);
      return fs.readFileSync(path.join(skillDirectory, ...relativePath.split("/")), "utf8");
    });
    return { ...entry, markdown, references, legacyMarkdown };
  });
}

export class SkillRegistry {
  constructor(private readonly db: Database.Database, private readonly rootDirectory: string) {
    fs.mkdirSync(rootDirectory, { recursive: true });
    this.seed();
  }

  list(): ManagedSkill[] {
    return builtIns.map((definition) => this.get(definition.id));
  }

  get(skillId: string): ManagedSkill {
    const definition = builtIns.find((item) => item.id === skillId);
    if (!definition) throw new Error("找不到这个技能。");
    const setting = this.db.prepare("SELECT enabled, provider FROM skill_settings WHERE skill_id = ?")
      .get(skillId) as { enabled: number; provider: ModelProviderId | null } | undefined;
    const filePath = this.filePath(skillId);
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      category: definition.category,
      enabled: setting ? Boolean(setting.enabled) : true,
      // Detection skills run through a visible browser session. Older builds
      // allowed a model setting to be saved here; ignore that stale setting.
      provider: isBrowserAutomationSkill(skillId) ? null : (setting?.provider ?? definition.defaultProvider),
      markdown: fs.readFileSync(filePath, "utf8"),
      filePath,
      files: this.listFiles(skillId)
    };
  }

  readFile(skillId: string, relativePath: string): { relativePath: string; content: string; size: number } {
    this.getDefinition(skillId);
    const target = this.editableFilePath(skillId, relativePath);
    const content = fs.readFileSync(target, "utf8");
    return { relativePath: normalizeSkillRelativePath(relativePath), content, size: Buffer.byteLength(content, "utf8") };
  }

  saveFile(skillId: string, relativePath: string, content: string): { relativePath: string; content: string; size: number } {
    this.getDefinition(skillId);
    if (Buffer.byteLength(content, "utf8") > 200_000) throw new Error("技能文件不能超过 200 KB。");
    const target = this.editableFilePath(skillId, relativePath);
    const normalized = content.replace(/\r\n/g, "\n").trimEnd() + "\n";
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, normalized, "utf8");
    fs.renameSync(temporary, target);
    return { relativePath: normalizeSkillRelativePath(relativePath), content: normalized, size: Buffer.byteLength(normalized, "utf8") };
  }

  instructionsFor(skillId: string, taskPrompt: string): string {
    const skill = this.get(skillId);
    const referenceNames = [...skill.markdown.matchAll(/\.\/references\/([a-z0-9-]+\.md)/gi)].map((match) => match[1]);
    if (referenceNames.length === 0) return skill.markdown;
    const shouldLoadLongForm = skillId !== "humanize-selection"
      || selectedTextLength(taskPrompt) >= 1_000
      || /保长度|别缩水|一句不删|尽量原样/.test(taskPrompt);
    const selectedReferences = [...new Set(referenceNames)].filter((name) => name !== "long-form.md" || shouldLoadLongForm);
    const referenceDirectory = path.join(this.rootDirectory, skillId, "references");
    const references = selectedReferences.flatMap((name) => {
      const target = path.join(referenceDirectory, name);
      return fs.existsSync(target)
        ? [`\n<!-- 已按当前任务加载 references/${name} -->\n${fs.readFileSync(target, "utf8").trim()}`]
        : [];
    });
    return [skill.markdown.trim(), ...references].join("\n\n") + "\n";
  }

  save(skillId: string, input: { markdown: string; enabled: boolean; provider: ModelProviderId | null }): ManagedSkill {
    this.get(skillId);
    if (input.markdown.length > 100_000) throw new Error("SKILL.md 不能超过 100 KB。");
    const normalized = input.markdown.replace(/\r\n/g, "\n").trimEnd() + "\n";
    const target = this.filePath(skillId);
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, normalized, "utf8");
    fs.renameSync(temporary, target);
    this.db.prepare(`INSERT INTO skill_settings (skill_id, enabled, provider, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(skill_id)
      DO UPDATE SET enabled = excluded.enabled, provider = excluded.provider, updated_at = excluded.updated_at`)
      .run(skillId, input.enabled ? 1 : 0, isBrowserAutomationSkill(skillId) ? null : input.provider, new Date().toISOString());
    return this.get(skillId);
  }

  private seed(): void {
    const seedState = this.readReferenceSeedState();
    for (const definition of builtIns) {
      const directory = path.join(this.rootDirectory, definition.id);
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, "SKILL.md");
      if (!fs.existsSync(target)) {
        fs.writeFileSync(target, definition.markdown, "utf8");
      }
      // Upgrade only an untouched legacy default. A skill edited from the UI
      // belongs to the user and must never be silently overwritten.
      if (definition.legacyMarkdown?.some((legacy) => normalizeMarkdown(fs.readFileSync(target, "utf8")) === normalizeMarkdown(legacy))) {
        fs.writeFileSync(target, definition.markdown, "utf8");
      }
      if (definition.references) {
        const referenceDirectory = path.join(directory, "references");
        fs.mkdirSync(referenceDirectory, { recursive: true });
        const skillSeed = seedState[definition.id] ?? {};
        for (const [name, builtInContent] of Object.entries(definition.references)) {
          if (!/^[a-z0-9-]+\.md$/.test(name)) throw new Error("内置技能引用文件名不合法。");
          const normalizedBuiltIn = builtInContent.trimEnd() + "\n";
          const referencePath = path.join(referenceDirectory, name);
          const builtInHash = hashContent(normalizedBuiltIn);
          const currentHash = fs.existsSync(referencePath)
            ? hashContent(fs.readFileSync(referencePath, "utf8"))
            : undefined;
          // First seed, or the file still matches what we last seeded: keep it
          // in sync with the built-in. If the user edited it (hash differs),
          // preserve their copy instead of overwriting it.
          if (shouldUpgradeReference(currentHash, builtInHash, skillSeed[name])) {
            fs.writeFileSync(referencePath, normalizedBuiltIn, "utf8");
          }
          skillSeed[name] = builtInHash;
        }
        seedState[definition.id] = skillSeed;
      }
    }
    this.writeReferenceSeedState(seedState);
  }

  private readReferenceSeedState(): Record<string, Record<string, string>> {
    const seedFile = path.join(this.rootDirectory, ".skill-reference-seed.json");
    if (!fs.existsSync(seedFile)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, Record<string, string>>) : {};
    } catch {
      return {};
    }
  }

  private writeReferenceSeedState(state: Record<string, Record<string, string>>): void {
    const seedFile = path.join(this.rootDirectory, ".skill-reference-seed.json");
    fs.writeFileSync(seedFile, JSON.stringify(state), "utf8");
  }

  private filePath(skillId: string): string {
    if (!/^[a-z0-9-]+$/.test(skillId)) throw new Error("技能 ID 不合法。");
    return path.join(this.rootDirectory, skillId, "SKILL.md");
  }

  private getDefinition(skillId: string): BuiltInSkillDefinition {
    const definition = builtIns.find((item) => item.id === skillId);
    if (!definition) throw new Error("找不到这个技能。");
    return definition;
  }

  private listFiles(skillId: string): SkillFileSummary[] {
    const root = path.join(this.rootDirectory, skillId);
    const files: SkillFileSummary[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(target);
          continue;
        }
        if (!entry.isFile() || !isEditableSkillFile(entry.name)) continue;
        files.push({ relativePath: path.relative(root, target).split(path.sep).join("/"), size: fs.statSync(target).size });
        if (files.length >= 200) return;
      }
    };
    visit(root);
    return files.sort((left, right) => left.relativePath === "SKILL.md" ? -1 : right.relativePath === "SKILL.md" ? 1 : left.relativePath.localeCompare(right.relativePath));
  }

  private editableFilePath(skillId: string, relativePath: string): string {
    const normalized = normalizeSkillRelativePath(relativePath);
    if (!normalized || normalized.split("/").some((segment) => segment === ".." || segment === ".") || !isEditableSkillFile(normalized)) {
      throw new Error("技能文件路径不合法或不是可编辑文本文件。");
    }
    const root = path.resolve(this.rootDirectory, skillId);
    const target = path.resolve(root, ...normalized.split("/"));
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error("技能文件路径越出了技能目录。");
    if (!fs.existsSync(target) || !fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) throw new Error("找不到这个技能文件。");
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    if (!realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error("技能文件路径越出了技能目录。");
    return target;
  }
}

function isBrowserAutomationSkill(skillId: string): boolean {
  return skillId === "zhuque-detection" || skillId === "contentany-detection";
}

function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function selectedTextLength(prompt: string): number {
  const selected = /需要处理的选区：\s*\n([\s\S]*?)\n\s*选区后文：/.exec(prompt)?.[1] ?? "";
  return Array.from(selected.trim()).length;
}

function normalizeSkillRelativePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function isEditableSkillFile(filePath: string): boolean {
  return /(?:^|\/)(?:SKILL\.md|[^/]+\.(?:md|markdown|txt|yaml|yml|json|js|mjs|cjs|ts|py|ps1|sh))$/i.test(filePath.replace(/\\/g, "/"));
}
