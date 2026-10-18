import { readFile } from "node:fs/promises";
export async function readArticle(articleId) {
  return readFile(articleId, "utf8");
}
