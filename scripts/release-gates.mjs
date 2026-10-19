import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const RELEASE_ENVIRONMENT = "release-production";
export const RELEASE_REVIEWER = "weiluliaokeji";

export function validateEnvironment(environment) {
  const rule = environment?.protection_rules?.find((entry) => entry.type === "required_reviewers");
  if (environment?.name !== RELEASE_ENVIRONMENT || environment.can_admins_bypass !== false ||
      rule?.reviewers?.length !== 1 || rule.reviewers[0]?.type !== "User" ||
      rule.reviewers[0]?.reviewer?.login?.toLowerCase() !== RELEASE_REVIEWER) {
    throw new Error(`发布环境未正确保护：请设置 ${RELEASE_ENVIRONMENT}，唯一 Required reviewer 为 ${RELEASE_REVIEWER}，并禁止管理员绕过。`);
  }
}

export function validateApproval(history) {
  // A run re-attempt must obtain a fresh approval through the environment gate.
  // GitHub's approval history contains the entire run, so it is supplementary evidence.
  const relevant = history.filter((entry) => entry.environments?.some((environment) => environment.name === RELEASE_ENVIRONMENT));
  if (!relevant.length || relevant.some((entry) => entry.state === "rejected") ||
      !relevant.some((entry) => entry.state === "approved" && entry.user?.login?.toLowerCase() === RELEASE_REVIEWER)) {
    throw new Error(`没有找到 ${RELEASE_REVIEWER} 对本次运行的发布批准，请在 Actions 的 Review deployments 中批准。`);
  }
}

function digest(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function context() {
  const result = { tag: process.env.GITHUB_REF_NAME, sha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT };
  if (!/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(result.tag ?? "") || !/^[a-f0-9]{40}$/.test(result.sha ?? "") ||
      !/^\d+$/.test(result.runId ?? "") || !/^\d+$/.test(result.runAttempt ?? "")) throw new Error("缺少有效的 GitHub tag、提交或运行标识。");
  return result;
}

export function createCandidate(source, destination, expected) {
  if (existsSync(destination)) throw new Error("候选包目录必须尚不存在，避免混入旧产物。");
  const names = readdirSync(source).filter((name) => /\.(exe|blockmap)$/i.test(name)).sort();
  if (!names.some((name) => name.endsWith(".exe"))) throw new Error("没有可发布的 Windows 安装包。");
  // GitHub Release 上传通路会丢弃资产名中的非 ASCII 前缀（gh release create 实测：
  // `文渡-Setup-1.0.0.exe` 落到 GitHub 变成 `-Setup-1.0.0.exe`），导致清单承诺的文件名
  // 与草稿资产名不一致。在源头拒绝非 ASCII 产物名，把失败暴露在构建期而非发布期。
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new Error(`候选文件名必须仅含 ASCII 字母、数字、点、连字符和下划线：${name}。请把 electron-builder 的 artifactName 改为 ASCII 命名（例如 "ContentFerry-Setup-\${version}-\${env.CONTENTFERRY_BUILD_STAMP}.\${ext}"）。`);
    }
  }
  mkdirSync(destination, { recursive: true });
  for (const name of names) {
    const file = join(source, name);
    if (!lstatSync(file).isFile() || lstatSync(file).size === 0) throw new Error("候选产物必须是非空普通文件。");
    copyFileSync(file, join(destination, name));
  }
  const sums = names.map((name) => `${digest(join(destination, name))}  ${name}`).join("\n") + "\n";
  writeFileSync(join(destination, "SHA256SUMS.txt"), sums);
  const files = [...names, "SHA256SUMS.txt"].map((name) => ({ name, sha256: digest(join(destination, name)) }));
  const manifest = { schemaVersion: 1, ...expected, files };
  writeFileSync(join(destination, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export function verifyCandidate(directory, expected) {
  const manifest = JSON.parse(readFileSync(join(directory, "release-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || Object.entries(expected).some(([key, value]) => manifest[key] !== value) ||
      !Array.isArray(manifest.files) || !manifest.files.some((file) => file.name?.endsWith(".exe")) ||
      !manifest.files.some((file) => file.name === "SHA256SUMS.txt")) throw new Error("候选包与批准的版本、提交或运行不一致。");
  const names = new Set();
  for (const file of manifest.files) {
    if (typeof file.name !== "string" || basename(file.name) !== file.name || /[^\x20-\x7e]/.test(file.name) ||
        !/^(?:SHA256SUMS\.txt|.+\.(?:exe|blockmap))$/.test(file.name) || names.has(file.name)) throw new Error("候选清单包含不安全、重复或非发布文件。");
    names.add(file.name);
    const absolute = join(directory, file.name);
    if (!lstatSync(absolute).isFile() || digest(absolute) !== file.sha256) throw new Error(`候选包校验和不匹配：${file.name}`);
  }
  const actual = readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names, "release-manifest.json"].sort())) throw new Error("候选目录存在清单之外的文件。");
  const sums = manifest.files.filter((file) => file.name !== "SHA256SUMS.txt").map((file) => `${file.sha256}  ${file.name}`).join("\n") + "\n";
  if (readFileSync(join(directory, "SHA256SUMS.txt"), "utf8") !== sums) throw new Error("校验和文本与候选清单不一致。");
  return manifest;
}

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("GitHub 请求失败；请检查当前步骤权限和网络，不会继续发布。");
  return result.stdout;
}

function environment() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY ?? "")) throw new Error("仓库标识无效。");
  const data = JSON.parse(gh(["api", `repos/${process.env.GITHUB_REPOSITORY}/environments/${RELEASE_ENVIRONMENT}`]));
  validateEnvironment(data);
}

function verifyTag(expected) {
  let object = JSON.parse(gh(["api", `repos/${process.env.GITHUB_REPOSITORY}/git/ref/tags/${expected.tag}`])).object;
  for (let depth = 0; object.type === "tag" && depth < 5; depth++) object = JSON.parse(gh(["api", `repos/${process.env.GITHUB_REPOSITORY}/git/tags/${object.sha}`])).object;
  if (object.type !== "commit" || object.sha !== expected.sha) throw new Error("tag 已移动或无法定位批准提交，停止发布。");
}

function approval(expected) {
  validateApproval(JSON.parse(gh(["api", `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${expected.runId}/approvals`])));
}

function main() {
  const action = process.argv[2];
  if (action === "environment") { environment(); return; }
  const expected = context();
  if (action === "prepare") {
    const manifest = createCandidate(resolve("release"), resolve(".cache/release-candidate"), expected);
    const summary = `## 等待发布审批\n\n版本：${expected.tag}\n提交：${expected.sha}\n运行：${expected.runId} / ${expected.runAttempt}\n\n批准人：${RELEASE_REVIEWER}\n\n下载本次 release-candidate artifact 检查安装包及 release-manifest.json，再批准 ${RELEASE_ENVIRONMENT}。\n\n${manifest.files.map((file) => `${file.sha256}  ${file.name}`).join("\n")}\n`;
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    return;
  }
  if (action !== "publish") throw new Error("用法：release-gates.mjs environment|prepare|publish");
  environment();
  approval(expected);
  const directory = resolve(".cache/release-candidate");
  const manifest = verifyCandidate(directory, expected);
  verifyTag(expected);
  // Refuse replacement: re-running cannot overwrite an already published installer.
  const assets = [...manifest.files.map((file) => join(directory, file.name)), join(directory, "release-manifest.json")];
  gh(["release", "create", expected.tag, ...assets, "--repo", process.env.GITHUB_REPOSITORY,
    "--verify-tag", "--generate-notes", "--draft", "--title", `文渡 ${expected.tag}`]);
  // The by-tag REST endpoint is documented for published releases. List releases
  // with write credentials to locate our newly uploaded draft by numeric ID.
  const releases = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`])).flat();
  const release = releases.find((entry) => entry.tag_name === expected.tag && entry.draft);
  const expectedAssets = [...manifest.files, { name: "release-manifest.json", sha256: digest(join(directory, "release-manifest.json")) }];
  if (!Number.isSafeInteger(release?.id) || release.assets?.length !== expectedAssets.length || expectedAssets.some((file) =>
    !release.assets.some((asset) => asset.name === file.name && asset.digest === `sha256:${file.sha256}`))) {
    throw new Error("Release 草稿中的产物与候选清单不一致，保留草稿交由维护者排查，不公开发布。");
  }
  // Uploading may take minutes. Recheck authority and tag at the public side effect.
  environment();
  approval(expected);
  verifyTag(expected);
  gh(["api", "--method", "PATCH", `repos/${process.env.GITHUB_REPOSITORY}/releases/${release.id}`, "-F", "draft=false"]);
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), decision: "allow", rule: "release.publish", ...expected, reviewer: RELEASE_REVIEWER }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`发布门禁拒绝：${error.message}`); process.exitCode = 1; }
}
