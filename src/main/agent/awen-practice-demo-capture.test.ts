import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { containsSensitiveCommandOutput, isPracticeDemoFileUrlAllowed, renderCommandOutputHtml, resolvePracticeDemoHtml } from "./awen-practice-demo-capture";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("AwenPracticeDemoCapture workspace boundary", () => {
  it("renders exact command output as escaped text and labels it as a generated display image", () => {
    const html = renderCommandOutputHtml("scoop list", "Name  Version\njava <script>alert(1)</script>", true);
    expect(html).toContain("scoop list · 本机命令实际输出");
    expect(html).toContain("java &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("…输出已截断");
    expect(html).toContain("不是操作系统终端窗口截图");
  });

  it("refuses command output screenshots when the output contains credentials or local absolute paths", () => {
    expect(containsSensitiveCommandOutput("api_key=abc123")).toBe(true);
    expect(containsSensitiveCommandOutput("C:\\Users\\adams\\secret.txt")).toBe(true);
    expect(containsSensitiveCommandOutput("corretto17-jdk 17.0.20.8.1 java")).toBe(false);
  });

  it("accepts only HTML inside the current practice directory for preview and linked resources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-demo-capture-"));
    temporaryDirectories.push(root);
    const taskDirectory = path.join(root, "task");
    fs.mkdirSync(taskDirectory);
    const htmlPath = path.join(taskDirectory, "demo.html");
    const imagePath = path.join(taskDirectory, "preview.png");
    const outsidePath = path.join(root, "outside.html");
    fs.writeFileSync(htmlPath, "<!doctype html><title>Demo</title>");
    fs.writeFileSync(imagePath, "image bytes");
    fs.writeFileSync(outsidePath, "<!doctype html>");

    expect(resolvePracticeDemoHtml(taskDirectory, "demo.html")).toBe(htmlPath);
    expect(isPracticeDemoFileUrlAllowed(pathToFileURL(htmlPath).toString(), taskDirectory)).toBe(true);
    expect(isPracticeDemoFileUrlAllowed(pathToFileURL(imagePath).toString(), taskDirectory)).toBe(true);
    expect(isPracticeDemoFileUrlAllowed(pathToFileURL(outsidePath).toString(), taskDirectory)).toBe(false);
    expect(isPracticeDemoFileUrlAllowed("https://example.com/demo.html", taskDirectory)).toBe(false);
  });

  it("rejects absolute, traversing, non-HTML, and missing inputs before opening a window", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-demo-capture-"));
    temporaryDirectories.push(root);
    const taskDirectory = path.join(root, "task");
    fs.mkdirSync(taskDirectory);
    fs.writeFileSync(path.join(root, "outside.html"), "<!doctype html>");
    fs.writeFileSync(path.join(taskDirectory, "source.js"), "document.title='not a page';");

    expect(() => resolvePracticeDemoHtml(taskDirectory, path.join(taskDirectory, "outside.html"))).toThrow("相对路径");
    expect(() => resolvePracticeDemoHtml(taskDirectory, "../outside.html")).toThrow("HTML 文件");
    expect(() => resolvePracticeDemoHtml(taskDirectory, "source.js")).toThrow("HTML 文件");
    expect(() => resolvePracticeDemoHtml(taskDirectory, "missing.html")).toThrow("找不到");
  });
});
