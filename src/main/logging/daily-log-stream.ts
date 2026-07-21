import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";

const RETENTION_DAYS = 30;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function dailyLogFilePath(directory: string, date = new Date()): string {
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
  return path.join(directory, `contentferry-${day}.log`);
}

export function createDailyLogStream(directory: string): Writable {
  fs.mkdirSync(directory, { recursive: true });
  removeExpiredLogs(directory);
  return new Writable({
    write(chunk, _encoding, callback) {
      const filePath = dailyLogFilePath(directory);
      const chunkBytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (fs.existsSync(filePath) && fs.statSync(filePath).size + chunkBytes > MAX_FILE_BYTES) {
        const extension = path.extname(filePath);
        const stem = filePath.slice(0, -extension.length);
        let part = 1;
        while (fs.existsSync(`${stem}-${part}${extension}`)) part += 1;
        fs.renameSync(filePath, `${stem}-${part}${extension}`);
      }
      try {
        fs.appendFileSync(filePath, chunk);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    }
  });
}

export function listRuntimeLogFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => /^contentferry(?:-\d{4}-\d{2}-\d{2}(?:-\d+)?)?\.log$/.test(name))
    .map((name) => path.join(directory, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

function removeExpiredLogs(directory: string): void {
  const oldestAllowed = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const filePath of listRuntimeLogFiles(directory)) {
    if (path.basename(filePath) === "contentferry.log") continue;
    if (fs.statSync(filePath).mtimeMs < oldestAllowed) fs.rmSync(filePath);
  }
}
