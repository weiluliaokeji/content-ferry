import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AiAuditLog, auditLogDirectory, type AiAuditCall } from "./ai-audit-log";

const sampleCall: AiAuditCall = {
  task: "draft",
  skillId: "wechat-writing",
  provider: "openai_codex",
  model: "gpt-test",
  inputTokens: 10,
  outputTokens: 20,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
  durationMs: 123,
  ok: true,
  prompt: "请遵循以下 ContentFerry 技能说明：\n\n<rules>\n\n本次任务：\n写一段关于咖啡的文字",
  response: JSON.stringify({ markdown: "今天我们来聊聊咖啡。" }),
  error: null
};

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = undefined;
});

function makeTempDir(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-audit-"));
  return tempDir;
}

describe("AiAuditLog", () => {
  it("writes a JSON line containing the full prompt and response when enabled", () => {
    const dir = makeTempDir();
    const log = new AiAuditLog(dir, () => true);
    log.record(sampleCall);

    const file = path.join(auditLogDirectory(dir), `ai-audit-${new Date().toISOString().slice(0, 10)}.log`);
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.task).toBe("draft");
    expect(entry.skillId).toBe("wechat-writing");
    expect(entry.ok).toBe(true);
    // Full content, not truncated.
    expect(entry.prompt).toBe(sampleCall.prompt);
    expect(entry.response).toBe(sampleCall.response);
    expect(entry.inputTokens).toBe(10);
    expect(typeof entry.ts).toBe("string");
  });

  it("does not write anything when disabled", () => {
    const dir = makeTempDir();
    const log = new AiAuditLog(dir, () => false);
    log.record(sampleCall);
    expect(fs.existsSync(auditLogDirectory(dir))).toBe(false);
  });

  it("records failures with the error message and no response", () => {
    const dir = makeTempDir();
    const log = new AiAuditLog(dir, () => true);
    log.record({ ...sampleCall, ok: false, response: null, error: "模型超时" });
    const file = path.join(auditLogDirectory(dir), `ai-audit-${new Date().toISOString().slice(0, 10)}.log`);
    const entry = JSON.parse(fs.readFileSync(file, "utf8").trim()) as Record<string, unknown>;
    expect(entry.ok).toBe(false);
    expect(entry.error).toBe("模型超时");
    expect(entry.response).toBeNull();
  });

  it("clear removes the whole audit directory", () => {
    const dir = makeTempDir();
    const log = new AiAuditLog(dir, () => true);
    log.record(sampleCall);
    expect(fs.existsSync(auditLogDirectory(dir))).toBe(true);
    log.clear();
    expect(fs.existsSync(auditLogDirectory(dir))).toBe(false);
  });

  it("prunes files older than the retention window", () => {
    const dir = makeTempDir();
    const log = new AiAuditLog(dir, () => true);
    const auditDir = auditLogDirectory(dir);
    fs.mkdirSync(auditDir, { recursive: true });
    // A stale file dated 90 days ago.
    const stale = path.join(auditDir, "ai-audit-2000-01-01.log");
    fs.writeFileSync(stale, "{}");
    fs.utimesSync(stale, new Date(0), new Date(0));
    // Trigger pruning via a fresh record.
    log.record(sampleCall);
    expect(fs.existsSync(stale)).toBe(false);
    const today = `ai-audit-${new Date().toISOString().slice(0, 10)}.log`;
    expect(fs.existsSync(path.join(auditDir, today))).toBe(true);
  });
});

describe("auditLogDirectory", () => {
  it("uses the platform separator consistently (no mixed slashes)", () => {
    const dataDir = process.platform === "win32" ? "D:\\ToolsData\\ContentFerry" : "/data/ContentFerry";
    const dir = auditLogDirectory(dataDir);
    const usesBackslash = dir.includes("\\");
    const usesSlash = dir.includes("/");
    // The renderer must display whatever the main process computes here, never
    // build the path with a hard-coded "/". On every OS the result uses exactly
    // one separator style.
    if (process.platform === "win32") {
      expect(usesBackslash).toBe(true);
      expect(usesSlash).toBe(false);
    } else {
      expect(usesSlash).toBe(true);
      expect(usesBackslash).toBe(false);
    }
    expect(dir.endsWith(`logs${path.sep}ai-audit`)).toBe(true);
  });
});
