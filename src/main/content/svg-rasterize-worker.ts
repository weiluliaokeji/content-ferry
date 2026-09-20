import { parentPort } from "node:worker_threads";
import { rasterizeSvgToPng } from "../../shared/svg-rasterize";

if (!parentPort) throw new Error("SVG 转换线程缺少消息端口。");

parentPort.on("message", (svg: Uint8Array) => {
  try {
    parentPort?.postMessage(rasterizeSvgToPng(Buffer.from(svg)));
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : "SVG 转换失败。" });
  }
});
