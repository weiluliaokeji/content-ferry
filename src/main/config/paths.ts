import path from "node:path";
import { app } from "electron";

export function getDataDirectory(): string {
  const override = process.env.CONTENTFERRY_DATA_DIR;
  return override ? path.resolve(override) : path.join(app.getPath("userData"), "data");
}
