import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ModelProviderId } from "../ai/model-connection-repository";

export interface ManagedSkill {
  id: string;
  name: string;
  description: string;
  category: "创作" | "改写" | "检测" | "图片";
  enabled: boolean;
  provider: ModelProviderId | null;
  markdown: string;
  filePath: string;
}

const builtIns: Array<Omit<ManagedSkill, "enabled" | "provider" | "filePath"> & { defaultProvider: ModelProviderId | null }> = [
  {
    id: "wechat-writing",
    name: "微信公众号文章撰写",
    description: "结合账号定位、创作简报和资料，生成适合微信公众号阅读的文章。",
    category: "创作",
    defaultProvider: "openai_codex",
    markdown: `# 微信公众号文章撰写

## 目标

结合账号定位、目标读者、用户观点与资料，协助作者完成有明确观点、信息可靠、适合手机阅读的公众号文章。

## 工作方式

1. 账号定位与本篇主题一致时，不重复询问已有信息。
2. 先识别还缺少的关键资料，再形成提纲。
3. 正文避免空泛套话，事实、数据和引用标记来源或待核查项。
4. 保留作者个人判断与经历，不把文章写成无立场的资料汇总。
`
  },
  {
    id: "platform-rewrite",
    name: "平台稿改写",
    description: "按目标平台的内容形态和读者习惯大幅改写渠道稿。",
    category: "改写",
    defaultProvider: "openai_codex",
    markdown: `# 平台稿改写

根据目标平台的用户、内容结构和分发特点重写文章。允许调整标题、结构、案例和表达顺序，但不得改变核心事实与作者原意。自有网站与微信公众号可以同稿，其他平台稿应避免机械复制。
`
  },
  {
    id: "article-summary",
    name: "文章摘要生成",
    description: "根据文章原文和目标平台的长度限制，生成可直接使用、可继续编辑的文章摘要。",
    category: "创作",
    defaultProvider: "openai_codex",
    markdown: `# 文章摘要生成

## 目标

根据完整原文提炼目标平台需要的文章摘要。摘要用于内容卡片、分享预览或发布信息，不是对正文的机械截断。

## 规则

1. 严格遵守任务中给出的最大字符数，中文标点也计入字符数。
2. 只使用原文已经提供的信息，不添加原文没有的事实、数字、评价或结论。
3. 优先交代文章讨论的问题、核心角度和读者能获得的价值。
4. 不写“本文将”“这篇文章主要介绍”等空泛开场，不使用标签、Markdown、链接或换行。
5. 根据目标平台调整表达：微信公众号摘要自然、有阅读吸引力但不夸大；CSDN 摘要突出技术问题、方法和适用对象。
6. 输出一段完整摘要，不附解释。
`
  },
  {
    id: "selection-edit",
    name: "选区 AI 编辑",
    description: "根据文章上下文，对选中文字执行改写、扩写、缩写或补充案例，结果可预览后替换。",
    category: "改写",
    defaultProvider: "openai_codex",
    markdown: `# 选区 AI 编辑

## 目标

只处理用户选中的正文片段，并结合前后文完成指定操作。输出必须能直接替换原选区。

## 通用规则

1. 保留原文中的事实、数据、专有名词、链接、引用和 Markdown 结构，不得凭空添加信息。
2. 与文章的目标读者、语气和上下文自然衔接，不重复前后文已经表达的内容。
3. “改写”强调清楚、自然和准确；“扩写”补充解释与推理，不灌水；“缩写”保留核心信息；“补充案例”只能基于用户提供或上下文中已有的真实案例，信息不足时用【需要作者补充案例】标记。
4. 只返回替换后的选区文本，不输出说明、引号或代码围栏。`
  },
  {
    id: "humanize-selection",
    name: "选中文本去 AI 味",
    description: "只处理编辑器中选中的段落，让表达更自然，同时保持原意和事实。",
    category: "改写",
    defaultProvider: "openai_codex",
    markdown: `# 选中文本去 AI 味

只改写用户选中的文字。减少模板化分点、机械连接词、空泛总结和过度修饰；保留专有名词、数据、引用、作者态度及上下文衔接。输出可直接替换原段落的正文，不附解释。
`
  },
  {
    id: "zhuque-detection",
    name: "腾讯朱雀 AI 检测",
    description: "自动打开可见浏览器、填写正文、执行检测并回填结果，异常时交给用户接管。",
    category: "检测",
    defaultProvider: null,
    markdown: `# 腾讯朱雀 AI 检测

## 自动流程

1. 使用独立且可见的浏览器窗口打开腾讯朱雀。
2. 自动填入待检测正文并点击检测。
3. 读取人工创作与 AI 生成相关结果并回填文章。
4. 仅在登录、验证码或网页结构变化导致自动化无法继续时，请用户接管。

检测结果是发布前优化依据。即使 AI 特征较高，有权限的用户填写理由后仍可继续发布。
`
  },
  {
    id: "contentany-detection",
    name: "ContentAny AI 检测",
    description: "自动打开 ContentAny 检测页面、填入正文、读取 AI 指数与质量报告，异常时交给用户接管。",
    category: "检测",
    defaultProvider: null,
    markdown: `# ContentAny AI 检测

## 自动流程

1. 使用独立且可见的浏览器窗口打开 ContentAny AI 检测页面。
2. 自动填入待检测正文并点击 AI 指数检测。
3. 读取 AI 内容密度、全文 AI 指数、限流预警和质量评估等可见结果。
4. 遇到登录、验证码或页面结构变化时保留浏览器窗口，交给用户完成后重试。

检测结果是发布前优化依据，不是事实判定或唯一发布依据。即使 AI 特征较高，有权限的用户仍可填写例外理由后继续发布。`,
  },
  {
    id: "cover-prompt-generation",
    name: "封面提示词生成",
    description: "根据文章主题和正文提炼视觉主体、构图、风格与限制，生成可编辑的封面生图提示词。",
    category: "创作",
    defaultProvider: "openai_codex",
    markdown: `# 封面提示词生成

## 目标

阅读文章标题和正文，生成一段可直接交给图片模型的微信公众号封面提示词。

## 规则

1. 提炼文章真正的主题、对象和情绪，不机械复述标题。
2. 明确画面主体、环境、构图、镜头、色彩、光线和视觉风格，适配 16:9 横版封面。
3. 主体应在缩略图中仍然清楚，并为可能的标题排版预留干净区域。
4. 默认不要在图片中生成文字、Logo、水印、二维码、界面小字或无意义符号。
5. 涉及抽象技术概念时，将其转化为可理解的视觉隐喻，避免堆砌芯片、机器人和霓虹电路等套路元素。
6. 不添加原文没有的人物、品牌背书、产品能力或事件事实。
7. 只输出一段完整的中文生图提示词，不附解释。`
  },
  {
    id: "cover-generation",
    name: "文章封面生成",
    description: "将用户确认的提示词原样交给图片模型，并把生成结果保存到文章素材目录。",
    category: "图片",
    defaultProvider: "modelscope",
    markdown: `# 文章封面生成

使用用户已经确认的提示词生成 16:9 横版封面。不得自动拼接文章标题、正文、摘要或其他限制；是否生成文字完全以用户最终确认的提示词为准。生成结果必须先展示给用户确认，不能自动发布。
`
  }
];

export class SkillRegistry {
  constructor(private readonly db: Database.Database, private readonly rootDirectory: string) {
    fs.mkdirSync(rootDirectory, { recursive: true });
    this.seed();
  }

  list(): ManagedSkill[] {
    return builtIns.map((definition) => this.get(definition.id));
  }

  get(skillId: string): ManagedSkill {
    const definition = builtIns.find((item) => item.id === skillId);
    if (!definition) throw new Error("找不到这个技能。");
    const setting = this.db.prepare("SELECT enabled, provider FROM skill_settings WHERE skill_id = ?")
      .get(skillId) as { enabled: number; provider: ModelProviderId | null } | undefined;
    const filePath = this.filePath(skillId);
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      category: definition.category,
      enabled: setting ? Boolean(setting.enabled) : true,
      provider: setting?.provider ?? definition.defaultProvider,
      markdown: fs.readFileSync(filePath, "utf8"),
      filePath
    };
  }

  save(skillId: string, input: { markdown: string; enabled: boolean; provider: ModelProviderId | null }): ManagedSkill {
    this.get(skillId);
    if (input.markdown.length > 100_000) throw new Error("SKILL.md 不能超过 100 KB。");
    const normalized = input.markdown.replace(/\r\n/g, "\n").trimEnd() + "\n";
    const target = this.filePath(skillId);
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, normalized, "utf8");
    fs.renameSync(temporary, target);
    this.db.prepare(`INSERT INTO skill_settings (skill_id, enabled, provider, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(skill_id)
      DO UPDATE SET enabled = excluded.enabled, provider = excluded.provider, updated_at = excluded.updated_at`)
      .run(skillId, input.enabled ? 1 : 0, input.provider, new Date().toISOString());
    return this.get(skillId);
  }

  private seed(): void {
    for (const definition of builtIns) {
      const directory = path.join(this.rootDirectory, definition.id);
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, "SKILL.md");
      if (!fs.existsSync(target)) fs.writeFileSync(target, definition.markdown, "utf8");
    }
  }

  private filePath(skillId: string): string {
    if (!/^[a-z0-9-]+$/.test(skillId)) throw new Error("技能 ID 不合法。");
    return path.join(this.rootDirectory, skillId, "SKILL.md");
  }
}
