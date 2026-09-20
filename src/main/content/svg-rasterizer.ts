import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { rasterizeSvgToPng } from "../../shared/svg-rasterize";

type WorkerMessage = Uint8Array | { error?: string };

function isWorkerMessage(value: unknown): value is WorkerMessage {
  return value instanceof Uint8Array || (typeof value === "object" && value !== null && ("error" in value));
}

/**
 * Rasterize outside the Electron main event loop when the compiled worker is
 * available. Vitest loads TypeScript directly, so the synchronous fallback is
 * intentionally kept for source-level tests and non-packaged tooling.
 */
export async function rasterizeSvgOffMainThread(svg: Buffer): Promise<Buffer> {
  const workerPath = path.join(__dirname, "svg-rasterize-worker.js");
  if (!fs.existsSync(workerPath)) return rasterizeSvgToPng(svg);

  return new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(workerPath);
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
      void worker.terminate();
    };
    worker.once("message", (message: unknown) => {
      if (!isWorkerMessage(message)) {
        finish(() => reject(new Error("SVG 转换线程返回了无效结果。")));
        return;
      }
      if (message instanceof Uint8Array) {
        finish(() => resolve(Buffer.from(message)));
        return;
      }
      finish(() => reject(new Error(message.error ?? "SVG 转换失败。")));
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0) finish(() => reject(new Error(`SVG 转换线程异常退出（${code}）。`)));
    });
    worker.postMessage(svg);
  });
}
