import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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

  it("registers the reviewer prompt as an editable skill with stage-specific evidence rules", () => {
    const reviewer = registry.get("content-review");
    expect(reviewer.name).toBe("文章独立评审");
    expect(reviewer.providerInherited).toBe(true);
    expect(reviewer.provider).toBe("openai_codex");
    expect(reviewer.files.map((file) => file.relativePath)).toContain("SKILL.md");
    const instructions = registry.instructionsFor("content-review", "评审阶段：提纲");
    expect(instructions).toContain("提纲阶段尚无实际实践结果本身不是 blocker 或 warning");
    expect(instructions).toContain("正文中的第一手实践、操作结果、数量和条件性结论");
    expect(instructions).toContain("各部分是否有不同的信息作用");
    expect(instructions).toContain("不以字数和小标题数量代替质量判断");
    expect(instructions).toContain("稳定的概念解释和广泛成立的一般原理，不因没有逐句来源而要求补研");
    expect(instructions).toContain("作者经历、本机状态和实测结果必须有作者记录或本篇实践观察");
    expect(instructions).toContain("不同官方资料冲突时，要求说明差异或适用范围");
    expect(instructions).toContain("单次用户报告可揭示边界或失败模式");
    expect(instructions).toContain("提纲评审先给出全文简报对齐结论");
  });

  it("registers a separately configurable goal-verification skill inherited from the Awen model by default", () => {
    const verifier = registry.get("goal-verification");

    expect(verifier.category).toBe("评审");
    expect(verifier.providerInherited).toBe(true);
    expect(verifier.provider).toBe("openai_codex");
    const instructions = registry.instructionsFor("goal-verification", "核验一项工具结果");
    expect(instructions).toContain("只依据作者目标、持久化工具观察和最终候选答复作出判断");
    expect(instructions).toContain("不能把核验器没给出引文表述成工具没结果");
    expect(instructions).toContain("答复遗漏已有观察、证据不足需新观察、来源/引文错配、工具失败或不可用、等待授权/作者输入");
  });

  it("loads source-selection and conflict-resolution rules for research", () => {
    const instructions = registry.instructionsFor("web-research", "为正文补充安装依据");

    expect(instructions).toContain("按具体主张选择最接近事实本身的一手来源");
    expect(instructions).toContain("不同官方页面互相冲突");
    expect(instructions).toContain("将社区教程、论坛、Issue 和个人经验用于发现边界与失败模式");
    expect(instructions).toContain("不得重复相同或实质等价的查询");
  });

  it("upgrades the exact previous built-in research/review skills and preserves custom edits", () => {
    for (const id of ["web-research", "content-review"]) {
      const file = path.join(root, id, "SKILL.md");
      const legacy = fs.readFileSync(path.resolve(__dirname, `../../../assets/skills/${id}/legacy/v1.md`), "utf8");
      const current = fs.readFileSync(path.resolve(__dirname, `../../../assets/skills/${id}/SKILL.md`), "utf8");

      fs.writeFileSync(file, legacy, "utf8");
      new SkillRegistry(stubDb, root);
      expect(fs.readFileSync(file, "utf8")).toBe(current);

      const custom = `${current}\n\n<!-- 作者自定义规则 -->\n`;
      fs.writeFileSync(file, custom, "utf8");
      new SkillRegistry(stubDb, root);
      expect(fs.readFileSync(file, "utf8")).toBe(custom);
    }
  });

  it("uses a saved reviewer skill edit on the next instruction load", () => {
    registry.saveFile("content-review", "SKILL.md", "# 自定义评审规则\n\n提纲阶段不得要求实测结果。\n");

    expect(registry.instructionsFor("content-review", "评审阶段：提纲")).toContain("自定义评审规则");
  });

  it("writes a seed-state file at the skills root", () => {
    expect(fs.existsSync(path.join(root, ".skill-reference-seed.json"))).toBe(true);
  });

  it("does not rewrite a reference file that already matches the built-in", () => {
    const file = path.join(root, "awen-assistant", "references", "memory-policy.md");
    const write = vi.spyOn(fs, "writeFileSync");

    new SkillRegistry(stubDb, root);

    expect(write.mock.calls.some(([target]) => target === file)).toBe(false);
    write.mockRestore();
  });

  it("does not rewrite unchanged reference seed state on startup", () => {
    const file = path.join(root, ".skill-reference-seed.json");
    const write = vi.spyOn(fs, "writeFileSync");

    new SkillRegistry(stubDb, root);

    expect(write.mock.calls.some(([target]) => target === file)).toBe(false);
    write.mockRestore();
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
    const oldContent = fs.readFileSync(path.join(__dirname, "fixtures", "public-writing-patterns-pre-shared.md"), "utf8");
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
  const seedHash = "previous-seed-hash";
  const legacyHash = "dea93921ac95a8d3e0b4ad19428b3a63de1274a08ff188a9e1c83ea6b96c90e7"; // public-writing-patterns 旧版
  const userEdit = "some-unrelated-user-edit-hash";

  it("upgrades when the data file is missing", () => {
    expect(shouldUpgradeReference(undefined, builtIn, seedHash)).toBe(true);
  });

  it("does not rewrite content that already matches the current built-in", () => {
    expect(shouldUpgradeReference(builtIn, builtIn, seedHash)).toBe(false);
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
