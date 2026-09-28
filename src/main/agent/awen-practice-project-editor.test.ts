import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import { ContentProjectRepository } from "../content/content-project-repository";
import { ArticlePracticeTaskRepository } from "../content/article-practice-task-repository";
import { AwenPracticeProjectEditor } from "./awen-practice-project-editor";

describe("AwenPracticeProjectEditor", () => {
  let database: AppDatabase | undefined;
  const roots: string[] = [];
  afterEach(() => {
    database?.close();
    database = undefined;
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    database = openInMemoryDatabase();
    database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)")
      .run("workspace", "测试", "2026-09-25T00:00:00.000Z");
    database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("project", "workspace", "示例文章", "2026-09-25T00:00:00.000Z", "2026-09-25T00:00:00.000Z");
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-code-project-"));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-practice-backup-"));
    roots.push(projectRoot, dataRoot);
    fs.mkdirSync(path.join(projectRoot, "src"));
    fs.writeFileSync(path.join(projectRoot, "src", "example.js"), "const value = 1;\n");
    fs.writeFileSync(path.join(projectRoot, "outside.js"), "leave me alone\n");
    const projects = new ContentProjectRepository(database.connection);
    projects.setPracticeProjectDirectory("project", projectRoot);
    const tasks = new ArticlePracticeTaskRepository(database.connection);
    const task = tasks.create("project", "验证现有示例");
    tasks.beginAssessment(task.id);
    tasks.beginPractice(task.id);
    return { projects, tasks, taskId: task.id, projectRoot, dataRoot, editor: new AwenPracticeProjectEditor(projects, tasks, dataRoot) };
  }

  it("backs up and records a scoped change, then restores only while the edited version is unchanged", () => {
    const { editor, taskId, tasks, projectRoot, dataRoot } = setup();
    const target = path.join(projectRoot, "src", "example.js");
    const observed = editor.read(taskId, "project", "src/example.js");
    expect(observed).toMatchObject({ relativePath: "src/example.js", content: "const value = 1;\n" });
    const change = editor.write(taskId, "project", { relativePath: "src/example.js", content: "const value = 2;\n", expectedSha256: observed.sha256 });
    expect(change).toMatchObject({ relativePath: "src/example.js", diff: { before: "const value = 1;\n", after: "const value = 2;\n" } });
    if ("unchanged" in change) throw new Error("预期产生文件改动。");
    expect(fs.readFileSync(target, "utf8")).toBe("const value = 2;\n");
    expect(fs.readFileSync(path.join(dataRoot, "practice-file-backups", taskId, `${change.id}.before`), "utf8")).toBe("const value = 1;\n");
    expect(tasks.listEvents(taskId).at(-1)?.payload).toMatchObject({ kind: "project_file_change", id: change.id });
    const outside = editor.read(taskId, "project", "outside.js");
    expect((editor.write(taskId, "project", { relativePath: "outside.js", content: "leave me alone\n", expectedSha256: outside.sha256 }) as { unchanged?: boolean }).unchanged).toBe(true);

    expect(editor.restore(taskId, "project", change.id)).toEqual({ relativePath: "src/example.js", restored: true });
    expect(fs.readFileSync(target, "utf8")).toBe("const value = 1;\n");
    expect(fs.readdirSync(path.join(dataRoot, "practice-file-backups", taskId))).toHaveLength(1);
    expect(editor.restore(taskId, "project", change.id)).toEqual({ relativePath: "src/example.js", restored: true });
  });

  it("refuses path traversal, new files, non-practice states, and restoration over later user edits", () => {
    const { editor, taskId, tasks, projectRoot } = setup();
    expect(() => editor.read(taskId, "project", "../outside.js")).toThrow("上级目录");
    expect(() => editor.read(taskId, "project", "src/new.js")).toThrow("已存在");
    const observed = editor.read(taskId, "project", "src/example.js");
    const change = editor.write(taskId, "project", { relativePath: "src/example.js", content: "const value = 2;\n", expectedSha256: observed.sha256 });
    if ("unchanged" in change) throw new Error("预期产生文件改动。");
    fs.writeFileSync(path.join(projectRoot, "src", "example.js"), "用户后来编辑的内容\n");
    expect(() => editor.restore(taskId, "project", change.id)).toThrow("又发生变化");
    tasks.beginDraft(taskId);
    expect(() => editor.write(taskId, "project", { relativePath: "src/example.js", content: "const value = 3;", expectedSha256: observed.sha256 })).toThrow("正在实践");
  });

  it("refuses to overwrite project edits made after the model read its baseline", () => {
    const { editor, taskId, projectRoot } = setup();
    const target = path.join(projectRoot, "src", "example.js");
    const observed = editor.read(taskId, "project", "src/example.js");
    fs.writeFileSync(target, "作者刚保存的新内容\n");

    expect(() => editor.write(taskId, "project", {
      relativePath: "src/example.js",
      content: "阿文基于旧内容生成的修改\n",
      expectedSha256: observed.sha256
    })).toThrow("读取后发生变化");
    expect(fs.readFileSync(target, "utf8")).toBe("作者刚保存的新内容\n");
  });
});
