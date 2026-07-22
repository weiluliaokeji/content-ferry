import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../db/database";
import { SkillRegistry } from "./skill-registry";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("SkillRegistry built-in migrations", () => {
  it("upgrades the untouched legacy humanize skill", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-skill-migration-"));
    temporaryDirectories.push(root);
    const skillDirectory = path.join(root, "humanize-selection");
    fs.mkdirSync(skillDirectory, { recursive: true });
    fs.writeFileSync(path.join(skillDirectory, "SKILL.md"), `# 选中文本去 AI 味

只改写用户选中的文字。减少模板化分点、机械连接词、空泛总结和过度修饰；保留专有名词、数据、引用、作者态度及上下文衔接。输出可直接替换原段落的正文，不附解释。
`, "utf8");

    const database = openInMemoryDatabase();
    try {
      const registry = new SkillRegistry(database.connection, root);
      const skill = registry.get("humanize-selection");
      expect(skill.name).toBe("文章选区去 AI 味");
      expect(skill.markdown).toContain("name: humanize-selection");
      expect(skill.markdown).toContain("./references/protected-spans.md");
      expect(skill.markdown).toContain("原则上保留至少 85%");
      expect(fs.existsSync(path.join(skillDirectory, "references", "protected-spans.md"))).toBe(true);
      expect(fs.existsSync(path.join(skillDirectory, "references", "long-form.md"))).toBe(true);

      const shortInstructions = registry.instructionsFor("humanize-selection", "需要处理的选区：\n短句。\n\n选区后文：\n无");
      expect(shortInstructions).toContain("# 公众号与技术文章模式");
      expect(shortInstructions).not.toContain("# 长文策略");
      const longInstructions = registry.instructionsFor(
        "humanize-selection",
        `需要处理的选区：\n${"长文内容。".repeat(220)}\n\n选区后文：\n无`
      );
      expect(longInstructions).toContain("# 长文策略");
    } finally {
      database.close();
    }
  });

  it("preserves a user-edited humanize skill", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-skill-custom-"));
    temporaryDirectories.push(root);
    const skillDirectory = path.join(root, "humanize-selection");
    fs.mkdirSync(skillDirectory, { recursive: true });
    const customized = "# 我的去 AI 味规则\n\n保留我的自定义要求。\n";
    fs.writeFileSync(path.join(skillDirectory, "SKILL.md"), customized, "utf8");

    const database = openInMemoryDatabase();
    try {
      const skill = new SkillRegistry(database.connection, root).get("humanize-selection");
      expect(skill.markdown).toBe(customized);
    } finally {
      database.close();
    }
  });
});
