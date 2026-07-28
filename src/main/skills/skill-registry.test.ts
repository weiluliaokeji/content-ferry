import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { SkillRegistry, shouldUpgradeReference } from "./skill-registry";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cf-skill-registry-"));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const stubDb = {
  prepare: () => ({ get: () => undefined, run: () => undefined, all: () => [] })
} as unknown as import("better-sqlite3").Database;

const SHARED_NAMES = ["protected-spans.md", "public-writing-patterns.md", "long-form.md", "quality-check.md"];

describe("SkillRegistry shared references", () => {
  let root: string;
  let registry: SkillRegistry;

  beforeEach(() => {
    root = tmpRoot();
    registry = new SkillRegistry(stubDb, root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("seeds the 4 shared references into both consuming skills", () => {
    for (const id of ["wechat-writing", "humanize-selection"]) {
      const dir = path.join(root, id, "references");
      expect(fs.existsSync(dir), `${id}/references should exist`).toBe(true);
      for (const name of SHARED_NAMES) {
        const file = path.join(dir, name);
        expect(fs.existsSync(file), `${id}/${name} should exist`).toBe(true);
        expect(fs.readFileSync(file, "utf8").trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("does not treat _shared as a skill in the data root", () => {
    expect(fs.existsSync(path.join(root, "_shared"))).toBe(false);
    expect(registry.list().map((s) => s.id)).not.toContain("_shared");
  });

  it("does not seed shared references into non-consuming skills", () => {
    expect(fs.existsSync(path.join(root, "web-research", "references"))).toBe(false);
  });

  it("writes a seed-state file at the skills root", () => {
    expect(fs.existsSync(path.join(root, ".skill-reference-seed.json"))).toBe(true);
  });

  it("preserves a user-edited reference instead of overwriting it", () => {
    const file = path.join(root, "wechat-writing", "references", "protected-spans.md");
    const builtIn = fs.readFileSync(file, "utf8");
    const edited = `${builtIn}\n<!-- user edit -->\n`;
    fs.writeFileSync(file, edited, "utf8");

    new SkillRegistry(stubDb, root);

    expect(fs.readFileSync(file, "utf8")).toBe(edited);
  });

  it("upgrades an untouched reference when the built-in content changes", () => {
    const file = path.join(root, "wechat-writing", "references", "protected-spans.md");
    const builtIn = fs.readFileSync(file, "utf8");

    // Simulate a previous built-in that differed, which we had seeded untouched.
    const oldContent = "# OLD protected spans\n";
    fs.writeFileSync(file, oldContent, "utf8");
    const seedPath = path.join(root, ".skill-reference-seed.json");
    const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
    seed["wechat-writing"]["protected-spans.md"] = sha256(oldContent);
    fs.writeFileSync(seedPath, JSON.stringify(seed), "utf8");

    new SkillRegistry(stubDb, root);

    expect(fs.readFileSync(file, "utf8")).toBe(builtIn);
  });

  it("upgrades a legacy built-in file seeded before the seed-state migration", () => {
    const file = path.join(root, "wechat-writing", "references", "public-writing-patterns.md");
    let oldContent: string;
    try {
      oldContent = execSync("git show HEAD:assets/skills/wechat-writing/references/public-writing-patterns.md", {
        cwd: path.resolve(__dirname, "../../.."),
        encoding: "utf8"
      });
    } catch {
      // 仓库无法调用 git 时跳过；纯函数测试已覆盖该判据逻辑。
      return;
    }
    // beforeEach 已 seed 当前 built-in 并写入 seed-state（记录当前哈希）。
    // 把数据文件覆盖成旧版内置内容（哈希不同）但保持 seed-state 不变——
    // 这正是老用户卡住的状态：seed-state 记的是新哈希，数据文件是旧哈希。
    fs.writeFileSync(file, oldContent, "utf8");

    const freshRoot = tmpRoot();
    new SkillRegistry(stubDb, freshRoot);
    const expected = fs.readFileSync(path.join(freshRoot, "wechat-writing", "references", "public-writing-patterns.md"), "utf8");
    fs.rmSync(freshRoot, { recursive: true, force: true });

    new SkillRegistry(stubDb, root);

    expect(fs.readFileSync(file, "utf8")).toBe(expected);
  });
});

describe("shouldUpgradeReference", () => {
  const builtIn = "current-built-in-hash";
  const seedHash = "current-built-in-hash";
  const legacyHash = "dea93921ac95a8d3e0b4ad19428b3a63de1274a08ff188a9e1c83ea6b96c90e7"; // public-writing-patterns 旧版
  const userEdit = "some-unrelated-user-edit-hash";

  it("upgrades when the data file is missing", () => {
    expect(shouldUpgradeReference(undefined, builtIn, seedHash)).toBe(true);
  });

  it("upgrades when already at the current built-in", () => {
    expect(shouldUpgradeReference(builtIn, builtIn, seedHash)).toBe(true);
  });

  it("upgrades a known legacy built-in hash", () => {
    expect(shouldUpgradeReference(legacyHash, builtIn, seedHash)).toBe(true);
  });

  it("upgrades when it matches the recorded seed hash", () => {
    expect(shouldUpgradeReference(seedHash, builtIn, seedHash)).toBe(true);
  });

  it("preserves a user edit that matches no known hash", () => {
    expect(shouldUpgradeReference(userEdit, builtIn, seedHash)).toBe(false);
  });
});

describe("SkillRegistry SKILL.md legacy upgrade", () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("upgrades a SKILL.md that matches a registered legacy version to the current built-in", () => {
    root = tmpRoot();
    new SkillRegistry(stubDb, root);
    const skillFile = path.join(root, "wechat-writing", "SKILL.md");
    const currentBuiltIn = fs.readFileSync(skillFile, "utf8");

    // 用登记过的 legacy 版本（用户此前安装的内置版）覆盖数据目录。
    const legacySource = path.resolve(__dirname, "../../../assets/skills/wechat-writing/legacy/v3.md");
    const legacyContent = fs.readFileSync(legacySource, "utf8");
    expect(legacyContent.replace(/\r\n/g, "\n").trim()).not.toBe(currentBuiltIn.replace(/\r\n/g, "\n").trim());
    fs.writeFileSync(skillFile, legacyContent, "utf8");

    new SkillRegistry(stubDb, root);

    expect(fs.readFileSync(skillFile, "utf8")).toBe(currentBuiltIn);
  });

  it("preserves a SKILL.md that matches no legacy version (user edit)", () => {
    root = tmpRoot();
    new SkillRegistry(stubDb, root);
    const skillFile = path.join(root, "wechat-writing", "SKILL.md");
    const userEdit = "# 微信公众号文章撰写\n\n这是我大幅改过的自定义版本，和任何内置 legacy 都对不上。\n";
    fs.writeFileSync(skillFile, userEdit, "utf8");

    new SkillRegistry(stubDb, root);

    expect(fs.readFileSync(skillFile, "utf8")).toBe(userEdit);
  });
});
