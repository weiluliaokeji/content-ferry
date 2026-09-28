import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SystemToolDescriptor {
  id: string;
  command: string;
  path: string;
  version: string;
  capabilities: string[];
}

type LocatedTool = (command: string) => Promise<string[]>;
type ReadDirectory = (directory: string) => Promise<string[]>;

const COMMAND_EXTENSIONS = [".exe", ".com", ".cmd", ".bat", ".ps1"] as const;
const EXTENSION_PRIORITY = new Map<string, number>(COMMAND_EXTENSIONS.map((extension, index) => [extension, index]));

/** Read-only discovery seam; it never installs tools or grants execution rights. */
export class SystemToolRegistry {
  private cached?: { expiresAt: number; items: SystemToolDescriptor[] };
  private readonly environment: NodeJS.ProcessEnv;

  constructor(
    private readonly locate: LocatedTool = async (command) => {
      const located = await execFileAsync("where.exe", [command], { windowsHide: true, timeout: 1200, maxBuffer: 32 * 1024 });
      return located.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    },
    private readonly readDirectory: ReadDirectory = (directory) => fs.promises.readdir(directory),
    environment: NodeJS.ProcessEnv = process.env
  ) {
    // Discovery can await filesystem I/O while another test or caller changes process.env.
    // Snapshot it so one registry always sees a consistent PATH and Portable location.
    this.environment = { ...environment };
  }

  async list(query?: string): Promise<SystemToolDescriptor[]> {
    const all = this.cached && this.cached.expiresAt > Date.now() ? this.cached.items : this.refreshInventory();
    const items = await all;
    const normalizedQuery = query?.trim().toLocaleLowerCase();
    return normalizedQuery ? items.filter((item) => item.command.toLocaleLowerCase().includes(normalizedQuery)) : items;
  }

  async find(id: string): Promise<SystemToolDescriptor | null> {
    return (await this.list()).find((item) => item.id === id) ?? null;
  }

  private async refreshInventory(): Promise<SystemToolDescriptor[]> {
    const items = (await findInstalledCommandCandidates(this.environment, this.readDirectory))
      .map(({ command, path: executablePath }): SystemToolDescriptor => ({
        id: "cli:" + command.toLowerCase(),
        command,
        path: executablePath,
        version: "未探测（发现阶段不会运行工具）",
        capabilities: ["task_cli"]
      }));
    this.cached = { expiresAt: Date.now() + 30_000, items };
    return items;
  }

  /** Resolve an arbitrary installed CLI by name without executing it during discovery. */
  async resolveCommand(command: string): Promise<SystemToolDescriptor | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(command)) return null;
    try {
      const candidates = await this.locateCandidates(command);
      // A PowerShell shim may exit before its formatted pipeline output reaches
      // a child process. Prefer the program's native CLI launcher when both
      // forms are installed; this applies to any command, not a named tool.
      const path = chooseCommandCandidate(candidates);
      if (!path) return null;
      return {
        id: `cli:${command.toLowerCase()}`,
        command,
        path,
        version: "按需读取实际运行结果",
        capabilities: ["task_cli"]
      };
    } catch {
      return null;
    }
  }

  private async locateCandidates(command: string): Promise<string[]> {
    let located: string[] = [];
    try {
      located = await this.locate(command);
    } catch {
      // where.exe can fail even when a PowerShell shim exists outside PATH.
    }
    return uniquePaths([
      ...located,
      ...findPowerShellScriptCandidates(command, this.environment.PATH ?? ""),
      ...findPortableCommandCandidates(command, this.environment)
    ]);
  }
}

/**
 * Enumerate command entry points from PATH and the portable app's adjacent tools directories.
 * Discovery reads filenames only; it never executes an installed program to guess its behavior.
 */
export function findInstalledCommandCandidates(
  environment: NodeJS.ProcessEnv = process.env,
  readDirectory: ReadDirectory = (directory) => fs.promises.readdir(directory),
  isFile: (candidate: string) => boolean = (candidate) => fs.statSync(candidate).isFile()
): Promise<Array<{ command: string; path: string }>> {
  return enumerateInstalledCommandCandidates(environment, readDirectory, isFile);
}

async function enumerateInstalledCommandCandidates(
  environment: NodeJS.ProcessEnv,
  readDirectory: ReadDirectory,
  isFile: (candidate: string) => boolean
): Promise<Array<{ command: string; path: string }>> {
  const directories = uniquePaths([
    ...(environment.PATH ?? "").split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/gu, "")).filter(Boolean),
    ...await findPortableCommandDirectories(environment, readDirectory)
  ]);
  const found = new Map<string, { command: string; path: string; priority: number }>();
  for (const directory of directories) {
    let entries: string[];
    try { entries = await readDirectory(directory); } catch { continue; }
    for (const entry of entries) {
      const extension = path.extname(entry).toLowerCase();
      const priority = EXTENSION_PRIORITY.get(extension);
      if (priority === undefined) continue;
      const command = entry.slice(0, -extension.length);
      if (!isCommandName(command)) continue;
      const key = command.toLowerCase();
      const existing = found.get(key);
      if (existing && (path.dirname(existing.path).toLowerCase() !== directory.toLowerCase() || existing.priority <= priority)) continue;
      const candidatePath = path.join(directory, entry);
      try {
        if (!isFile(candidatePath)) continue;
      } catch {
        continue;
      }
      found.set(key, { command, path: candidatePath, priority });
    }
  }
  return [...found.values()]
    .sort((left, right) => left.command.localeCompare(right.command, undefined, { sensitivity: "base" }))
    .map(({ command, path: executablePath }) => ({ command, path: executablePath }));
}

async function findPortableCommandDirectories(environment: NodeJS.ProcessEnv, readDirectory: ReadDirectory): Promise<string[]> {
  const portableExecutable = environment.PORTABLE_EXECUTABLE_FILE;
  if (!portableExecutable) return [];
  const portableDirectory = path.dirname(path.resolve(portableExecutable));
  const toolsDirectory = path.dirname(portableDirectory);
  let siblings: string[];
  try { siblings = (await readDirectory(toolsDirectory)).slice(0, 200); } catch { return []; }
  const directories = [portableDirectory, toolsDirectory, ...siblings.map((name) => path.join(toolsDirectory, name))]
    .flatMap((root) => [root, path.join(root, "bin"), path.join(root, "shims")]);
  const available: string[] = [];
  for (const directory of directories) {
    try { await readDirectory(directory); available.push(directory); } catch { /* Skip inaccessible or absent directories. */ }
  }
  return available;
}

function isCommandName(command: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(command);
}

/** Find any command next to a portable app in a shallow tools directory. */
export function findPortableCommandCandidates(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (candidate: string) => boolean = fs.existsSync,
  readDirectories: (directory: string) => string[] = (directory) => fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
): string[] {
  if (!isCommandName(command)) return [];
  const portableExecutable = environment.PORTABLE_EXECUTABLE_FILE;
  if (!portableExecutable) return [];
  const portableDirectory = path.dirname(path.resolve(portableExecutable));
  const toolsDirectory = path.dirname(portableDirectory);
  let siblings: string[] = [];
  try { siblings = readDirectories(toolsDirectory).slice(0, 200); } catch { return []; }
  const directories = [portableDirectory, toolsDirectory, ...siblings.map((name) => path.join(toolsDirectory, name))]
    .flatMap((root) => [root, path.join(root, "bin"), path.join(root, "shims")]);
  const candidates = directories.flatMap((directory) => [".exe", ".com", ".cmd", ".bat", ".ps1"]
    .map((extension) => path.join(directory, `${command}${extension}`)));
  return uniquePaths(candidates.filter((candidate) => { try { return fileExists(candidate); } catch { return false; } }));
}

function chooseCommandCandidate(candidates: string[]): string | undefined {
  const directories = new Map<string, string[]>();
  for (const candidate of candidates) {
    const key = path.dirname(candidate).toLowerCase();
    directories.set(key, [...(directories.get(key) ?? []), candidate]);
  }
  for (const group of directories.values()) {
    for (const extension of [".exe", ".com", ".cmd", ".bat", ".ps1"]) {
      const found = group.find((candidate) => candidate.toLowerCase().endsWith(extension));
      if (found) return found;
    }
  }
  return undefined;
}

/** Finds PATH-based PowerShell script shims that `where.exe` omits. */
export function findPowerShellScriptCandidates(
  command: string,
  pathValue = process.env.PATH ?? "",
  fileExists: (candidate: string) => boolean = fs.existsSync
): string[] {
  if (!isCommandName(command)) return [];
  const candidates: string[] = [];
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/gu, "");
    if (!directory) continue;
    const candidate = path.join(directory, `${command}.ps1`);
    try {
      if (fileExists(candidate)) candidates.push(candidate);
    } catch {
      // One inaccessible PATH entry must not hide tools in the remaining entries.
    }
  }
  return uniquePaths(candidates);
}

function uniquePaths(candidates: string[]): string[] {
  const found = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase();
    if (found.has(key)) return false;
    found.add(key);
    return true;
  });
}
