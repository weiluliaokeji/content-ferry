import type { ManagedSkill, ModelProviderId } from "./types";

// 技能分组常量（无状态依赖，App.tsx 与 useSkillsSettings 共用）
export const skillModelGroups = [
  { key: "text", title: "文本类技能", description: "依赖文本大模型（OpenAI 系列，其余接口可自定义连接）", match: (c: ManagedSkill["category"]) => c === "创作" || c === "改写" || c === "研究", providers: ["openai_codex"] as ModelProviderId[] },
  { key: "image", title: "图像类技能", description: "依赖图像大模型（ModelScope / Agnes AI）", match: (c: ManagedSkill["category"]) => c === "图片", providers: ["modelscope", "agnes"] as ModelProviderId[] },
  { key: "none", title: "无模型技能", description: "走浏览器自动化，不需要大模型连接", match: (c: ManagedSkill["category"]) => c === "检测" }
];
