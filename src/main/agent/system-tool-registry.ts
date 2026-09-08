import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SystemToolDescriptor {
  id: string;
  command: string;
  path: string;
  version: string;
  capabilities: string[];
}

const CANDIDATES = [
  { id: "git", command: "git", args: ["--version"], capabilities: ["git_clone", "source_read"] },
  { id: "python", command: "python", args: ["--version"], capabilities: ["python_demo"] },
  { id: "node", command: "node", args: ["--version"], capabilities: ["node_demo"] },
  { id: "ffmpeg", command: "ffmpeg", args: ["-version"], capabilities: ["audio", "video"] },
  { id: "pandoc", command: "pandoc", args: ["--version"], capabilities: ["document_convert"] },
  { id: "mermaid-cli", command: "mmdc", args: ["--version"], capabilities: ["mermaid_render"] }
] as const;

/** Read-only discovery seam; it never installs tools or grants execution rights. */
export class SystemToolRegistry {
  private cached?: { expiresAt: number; items: SystemToolDescriptor[] };

  async list(): Promise<SystemToolDescriptor[]> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.items;
    const found = await Promise.all(CANDIDATES.map(async (candidate): Promise<SystemToolDescriptor | null> => {
      try {
        const located = await execFileAsync("where.exe", [candidate.command], { windowsHide: true, timeout: 1200, maxBuffer: 32 * 1024 });
        const executablePath = located.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        if (!executablePath) return null;
        const versionResult = await execFileAsync(executablePath, [...candidate.args], { windowsHide: true, timeout: 1200, maxBuffer: 64 * 1024 });
        const version = `${versionResult.stdout}\n${versionResult.stderr}`.trim().split(/\r?\n/)[0] ?? "未知版本";
        return { id: candidate.id, command: candidate.command, path: executablePath, version, capabilities: [...candidate.capabilities] };
      } catch {
        return null;
      }
    }));
    const items = found.filter((tool): tool is SystemToolDescriptor => tool !== null);
    this.cached = { expiresAt: Date.now() + 30_000, items };
    return items;
  }
}
