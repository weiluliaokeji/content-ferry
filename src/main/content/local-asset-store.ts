import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const mimeExtensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp"
};

export class LocalAssetStore {
  constructor(private readonly rootDirectory: string) {
    fs.mkdirSync(rootDirectory, { recursive: true });
  }

  save(contextId: string, mimeType: string, base64: string): { assetUrl: string; previewUrl: string } {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(contextId)) throw new Error("Invalid asset context.");
    const extension = mimeExtensions[mimeType];
    if (!extension) throw new Error("仅支持 JPG、PNG、GIF 和 WebP 图片。");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0 || bytes.length > 15 * 1024 * 1024) throw new Error("图片必须小于 15 MB。");
    const directory = path.join(this.rootDirectory, contextId);
    fs.mkdirSync(directory, { recursive: true });
    const fileName = `${randomUUID()}${extension}`;
    fs.writeFileSync(path.join(directory, fileName), bytes);
    return {
      assetUrl: `contentferry-asset://${contextId}/${fileName}`,
      previewUrl: `/api/content-assets/${contextId}/${fileName}`
    };
  }

  read(contextId: string, fileName: string): { stream: fs.ReadStream; mimeType: string } {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(contextId) || !/^[A-Fa-f0-9-]{36}\.(jpg|png|gif|webp)$/.test(fileName)) {
      throw new Error("Invalid asset path.");
    }
    const extension = path.extname(fileName).toLowerCase();
    const mimeType = Object.entries(mimeExtensions).find(([, value]) => value === extension)?.[0] ?? "application/octet-stream";
    const filePath = path.join(this.rootDirectory, contextId, fileName);
    if (!fs.existsSync(filePath)) throw new Error("Asset not found.");
    return { stream: fs.createReadStream(filePath), mimeType };
  }

  readBytes(contextId: string, fileName: string): { bytes: Buffer; mimeType: string } {
    const asset = this.resolveAsset(contextId, fileName);
    return { bytes: fs.readFileSync(asset.filePath), mimeType: asset.mimeType };
  }

  private resolveAsset(contextId: string, fileName: string): { filePath: string; mimeType: string } {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(contextId) || !/^[A-Fa-f0-9-]{36}\.(jpg|png|gif|webp)$/.test(fileName)) {
      throw new Error("图片路径不合法。");
    }
    const filePath = path.join(this.rootDirectory, contextId, fileName);
    if (!fs.existsSync(filePath)) throw new Error("找不到图片。");
    const mimeType = { ".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" }[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
    return { filePath, mimeType };
  }
}
