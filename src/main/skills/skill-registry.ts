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

const legacyHumanizeSelectionMarkdown = `# 选中文本去 AI 味

只改写用户选中的文字。减少模板化分点、机械连接词、空泛总结和过度修饰；保留专有名词、数据、引用、作者态度及上下文衔接。输出可直接替换原段落的正文，不附解释。
`;

const legacyHumanizeSelectionV2Markdown = `---
name: humanize-selection
description: 对文渡编辑器中选中的公众号或技术文章片段进行去 AI 味改写；减少模板感、表演感和语域漂移，同时严格保留事实、术语、Markdown 与作者立场，并输出可直接替换原选区的正文。
---

# 文章选区去 AI 味

## 目标

把选中文字从“像模型在表演写作”改成“像具体作者在当前文章里表达”。去 AI 味不是同义词替换，也不是故意制造错别字、口语病或虚假经历。

前文、后文和文章标题只用于判断语气与衔接，不得改写或复述；最终只处理选区。

## 执行顺序

1. 判断选区用途：默认按微信公众号公开文章处理；技术教程、操作步骤或代码说明按技术文章处理。
2. 先圈出保护项，再判断问题，最后改写。不得为了自然牺牲准确性。
3. 短选区允许删掉不承载信息的套话；长选区优先句内降调，保留段落顺序、关键转场和作者节奏。
4. 完成保真回读，再做一次轻量的残留 AI 味检查。

## 必须保护

- 数字、日期、版本号、比例、单位、比较关系和限定条件；
- 人名、组织、产品、模型、平台、项目名称，以及观点和责任归属；
- 引号内原话、文章标题、可核查引用、链接和来源；
- Markdown 标题层级、列表、表格、引用、代码围栏、行内代码、图片与链接地址；
- 命令、代码、接口名、字段名、参数、文件路径、环境变量、日志、报错和状态码；
- 作者已经表达的立场、经验、犹豫、边界和【待核查】标记。

不得新增原文没有的事实、数据、案例、来源、亲身经历或结论。无源的“研究表明、数据显示、业内人士认为”不能被改写成仿佛已经证实；删掉权威铺垫仍不能成立时，保留原意，不补造来源。

## 重点处理的问题

按模式判断，不机械见词就改：

1. 开场与元话术：如“在当今……时代”“值得注意的是”“本文将深入探讨”“让我们一起看看”。直接进入事实、问题或作者判断。
2. 空总结与旁白：如“综上所述”“归根结底”“这说明了”“真正值得关注的是”。若没有新增信息则删除；承担转场时只压低姿态。
3. 伪洞见骨架：如“不是 X，而是 Y”“不仅仅是 X，更是 Y”“真正的 X 是……”。保留必要边界，去掉只为制造顿悟感的外壳。
4. 商业黑话与表演性技术腔：如“赋能、抓手、闭环、底层逻辑、稳稳兜住、收口、落盘”。在确属行业或技术术语时保留，否则改成谁做了什么、产生什么结果。
5. 自媒体流水线语气：如“保姆级、硬核干货、一文读懂、建议收藏、划重点、未来可期”。保留真实作者本来就在使用且有具体经历支撑的口语，不硬造网感。
6. 机械结构：过密的“首先/其次/最后”、强行三件套、每句同长度、每段都总结、分点强迫症。技术步骤和真实清单不得为了反结构而合并。
7. 翻译腔与修饰堆积：缩短过长主语和定语链，减少连续被动句以及“基于……通过……来……”套壳，但保留系统行为主语。
8. 标点腔：同段破折号、分号过密时按语义换成逗号、冒号、括号或断句；单个合理破折号不必修改。

## 改写力度

- 选区少于约 300 字：默认标准改写。可删纯套话、并合紧邻重复句，但不能丢信息。
- 选区达到约 300 字或包含多段 Markdown：默认保守改写。不重排段落，不删除承担转场、节奏或独有判断的完整句子。
- 选区超过约 1000 字：尽量保持段落数、顺序和大致长度。除纯空话外，改写后字数原则上不少于原文的 85%；不要压缩成摘要。
- 用户明确要求保长度、一句不删或尽量原样时：只做句内降调，不删整句、不并句、不重排。

## 正向标准

- 优先呈现具体主体、动作、条件和结果，而不是抽象拔高；
- 保留公众号文章需要的阅读节奏，但不制造金句、反问或戏剧化碎句；
- 保持与上下文一致的正式度和作者口吻，不把技术文章改成聊天，也不把个人表达改成公告；
- 允许普通事实句存在，不在每句话后补“这意味着什么”；
- 没有材料支持时宁可克制，不用虚构细节来制造“人味”。

## 两遍回读

第一遍检查：所有保护项是否原样保留；事实、归属、条件和作者态度是否改变；Markdown 是否仍有效；删改处是否出现断裂。

第二遍只检查：残留套话、空总结、旁白式解释、空泛判断和过于均匀的句长。只做小修，不重新改写全文。

## 输出要求

只输出一份可以直接替换原选区的正文。保留必要的 Markdown 和段落换行；不要输出问题分析、修改说明、评分、引号、前后文或代码围栏。
`;

const humanizeSelectionMarkdown = `---
name: humanize-selection
description: 对文渡编辑器中选中的公众号或技术文章片段进行去 AI 味改写；在保留事实、Markdown、术语、作者立场和上下文衔接的前提下，减少模板感、表演感、机械结构和语域漂移，并输出可直接替换原选区的正文。
---

# 文章选区去 AI 味

## 目标

把选区改得像具体作者在当前文章中表达。只改“怎么说”，不改变“说什么”；不要靠错别字、假经历、强行口语或虚构细节制造人味。

标题、前文和后文只用于判断语气与衔接，不得出现在输出中。

## 工作流

1. 先识别选区是公众号公开表达、技术教程还是操作说明。
2. 读取 [保护项](./references/protected-spans.md)，先锁定不能漂移的内容。
3. 读取 [公众号与技术文章模式](./references/public-writing-patterns.md)，按问题族判断，不按词表机械替换。
4. 选区较长、包含多段或用户要求保长度时，再读取 [长文策略](./references/long-form.md)。
5. 先做最少必要修改，再按 [回读清单](./references/quality-check.md) 检查；最多两遍，不循环抛光。

## 默认力度

- 短选区：允许删掉纯套话、调整局部句式，但不能丢独有信息。
- 多段选区：保留段落顺序、关键转场和作者节奏，优先句内降调。
- 长文选区：不得压缩成摘要；除纯空话外，原则上保留至少 85% 的长度。
- 明确要求一句不删或尽量原样：只做句内改写，不删整句、不并句、不重排。

## 输出合同

只输出一份可直接替换原选区的正文，保留必要的 Markdown 和换行。不要输出诊断、统计、评分、修改说明、前后文、引号或代码围栏。
`;

const humanizeSelectionReferences: Record<string, string> = {
  "protected-spans.md": `# 保护项

改写前先锁定以下内容，改写后逐项核对：

- 数字、日期、版本号、比例、单位、范围、比较关系和限定条件；
- 人名、组织、产品、模型、平台、项目名称，以及观点、行为和责任归属；
- 引号内原话、标题、引用、来源、链接与可核查表述；
- Markdown 标题层级、列表、表格、引用、代码围栏、行内代码、图片和链接地址；
- 命令、代码、接口名、字段名、参数、路径、环境变量、日志、报错和状态码；
- 作者已有的第一人称经历、态度、犹豫、边界和【待核查】标记。

## 硬约束

1. 不新增原文没有的事实、数字、案例、来源、亲身经历、情绪或结论。
2. 不改数字以增强冲击力，不把假设案例包装成真实经历。
3. 不擅自补“具体工具名”或细节；原文含糊时保持含糊，或保留待补信息。
4. 无源的“研究表明、数据显示、业内人士认为”不能改成仿佛已经证实。删掉权威铺垫后判断不能独立成立时，保留原意，不补造来源。
5. 技术文里的系统主语、步骤、清单和术语是信息结构，不因“像 AI”就改成口语或故事。

如果自然度与准确性冲突，优先准确。`,

  "public-writing-patterns.md": `# 公众号与技术文章模式

目标是减少模板感，不是执行禁用词扫描。先判断词句在当前上下文中是否真的空泛。

## 优先处理

### 开场和元话术

处理“在当今……时代”“值得注意的是”“本文将深入探讨”“让我们一起看看”等提示层。直接进入事实、问题、经历或作者判断，但不得虚构一个“具体事件”作为开场。

### 空总结和旁白

处理“综上所述”“归根结底”“这说明了”“真正值得关注的是”。没有新增信息时删除；承担转场或论证时只压低姿态，保留作用。

### 伪洞见骨架

处理“不是 X，而是 Y”“不仅仅是 X，更是 Y”“真正的 X 是……”。前半句只用于制造顿悟感时直接说有效判断；若承载边界、反例或风险则保留。

### 黑话和表演性技术腔

“赋能、抓手、闭环、底层逻辑、稳稳兜住、收口、落盘”等词只有在缺少具体动作时才处理。它们是行业术语、团队稳定用语或准确技术描述时保留。

### 自媒体流水线语气

处理“保姆级、硬核干货、一文读懂、建议收藏、划重点、未来可期”等批量生产式表达。作者已有且有真实经历支撑的口语可以保留，不主动塞入“说真的、我跟你说、太离谱了”等口头禅。

### 机械结构

检查过密的“首先/其次/最后”、强行三件套、连续同构排比、每段都总结、句长过于均匀和无必要的小标题。真实步骤、对比表和操作清单必须保留结构。

### 翻译腔和修饰堆积

缩短过长定语链，减少连续被动句以及“基于……通过……来……”套壳。不要为了主动语态虚构执行者；系统行为主语可以保留。

### 标点密度

只处理同段多次破折号、分号或冒号造成的机械节奏。冒号、引号、破折号都有正常用途，不设一刀切禁令；代码、链接、引用和 Markdown 标点不得修改。

## 正向标准

- 优先呈现原文已有的主体、动作、条件和结果；
- 有判断，但判断来自原文事实和作者态度，不靠拔高；
- 句子长短可以变化，但不强造碎句、金句、反问或戏剧性停顿；
- 允许自然重复，尤其是承担强调、转场和时间推进的重复；
- 只保留原文已有的第一人称和个性，不替作者“注入灵魂”；
- 保持语域一致，不把技术文章改成聊天，不把个人文章改成公告。`,

  "long-form.md": `# 长文策略

长文的目标是句内去味，不是压缩和重写成另一篇文章。

## 默认边界

1. 保留段落数量、顺序、标题层级和关键转场。
2. 不合并发生在不同时间点的相似经历，不把作者逐步形成判断的过程压成一句总结。
3. 不删除承担节奏、停顿、强调或视角切换的重复句。
4. 只有整句不含独有事实、数字、判断、动作、边界且删除后衔接自然时，才可视为纯空话。
5. 除纯空话外，输出长度原则上不少于原文的 85%；句数或段落数明显变化时回退检查。

## 保长度模式

用户要求“保长度、别缩水、一句不删、尽量原样”时：

- 不删整句，不并句，不重排段落；
- 只删除句内提示层、空泛修饰和拔高外壳；
- 提示层删除后句子不完整时，改用中性表达，不硬删；
- 不为了凑长度补入新事实、例子、感官细节、口头禅或态度。`,

  "quality-check.md": `# 回读清单

最多执行两遍。第一遍完成后若已自然、准确、可直接替换，就停止。

## 第一遍：保真

逐项检查：

1. 数字、名称、引用、链接、代码和 Markdown 是否原样保留；
2. 事实、责任主体、观点归属、条件和风险有没有改变；
3. 作者立场与已有第一人称经历有没有被添加、删除或夸大；
4. 技术正式度和文章语域有没有被口语化破坏；
5. 删改后是否出现指代悬空、段落断裂或逻辑跳步。

任一项失败都先恢复保真，不能用“更像人”解释失真。

## 第二遍：残留检查

只检查五类：残留开场套话、空总结、旁白式解释、空泛判断、连续句长和结构过于整齐。

第二遍只允许小修，不重新改写全文，不补细节，不强加幽默、情绪、自嘲、粗口、口头禅或故意的不完美。

## 交付标准

- 自然：像熟悉该主题的作者在表达，而不是模型在展示写作能力；
- 保真：每个信息点都能在原选区中找到依据；
- 可替换：不需要清理说明文字，Markdown 有效，与前后文衔接自然。`
};

type BuiltInSkillDefinition = Omit<ManagedSkill, "enabled" | "provider" | "filePath"> & {
  defaultProvider: ModelProviderId | null;
  references?: Record<string, string>;
};

const builtIns: BuiltInSkillDefinition[] = [
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
    name: "文章选区去 AI 味",
    description: "按公众号与技术文章语境改写选中文字，减少模板感并严格保护事实、Markdown、术语和作者立场。",
    category: "改写",
    defaultProvider: "openai_codex",
    markdown: humanizeSelectionMarkdown,
    references: humanizeSelectionReferences
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
      // Detection skills run through a visible browser session. Older builds
      // allowed a model setting to be saved here; ignore that stale setting.
      provider: isBrowserAutomationSkill(skillId) ? null : (setting?.provider ?? definition.defaultProvider),
      markdown: fs.readFileSync(filePath, "utf8"),
      filePath
    };
  }

  instructionsFor(skillId: string, taskPrompt: string): string {
    const skill = this.get(skillId);
    if (skillId !== "humanize-selection" || !skill.markdown.includes("./references/")) return skill.markdown;

    const referenceNames = ["protected-spans.md", "public-writing-patterns.md", "quality-check.md"];
    if (selectedTextLength(taskPrompt) >= 1_000 || /保长度|别缩水|一句不删|尽量原样/.test(taskPrompt)) {
      referenceNames.splice(2, 0, "long-form.md");
    }
    const referenceDirectory = path.join(this.rootDirectory, skillId, "references");
    const references = referenceNames.flatMap((name) => {
      const target = path.join(referenceDirectory, name);
      return fs.existsSync(target)
        ? [`\n<!-- 已按当前任务加载 references/${name} -->\n${fs.readFileSync(target, "utf8").trim()}`]
        : [];
    });
    return [skill.markdown.trim(), ...references].join("\n\n") + "\n";
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
      .run(skillId, input.enabled ? 1 : 0, isBrowserAutomationSkill(skillId) ? null : input.provider, new Date().toISOString());
    return this.get(skillId);
  }

  private seed(): void {
    for (const definition of builtIns) {
      const directory = path.join(this.rootDirectory, definition.id);
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, "SKILL.md");
      if (!fs.existsSync(target)) {
        fs.writeFileSync(target, definition.markdown, "utf8");
      }
      // Upgrade only the untouched legacy default. A skill edited from the
      // UI belongs to the user and must never be silently overwritten.
      if (definition.id === "humanize-selection") {
        const current = fs.readFileSync(target, "utf8");
        if (
          normalizeMarkdown(current) === normalizeMarkdown(legacyHumanizeSelectionMarkdown)
          || normalizeMarkdown(current) === normalizeMarkdown(legacyHumanizeSelectionV2Markdown)
        ) {
          fs.writeFileSync(target, definition.markdown, "utf8");
        }
      }
      if (definition.references) {
        const referenceDirectory = path.join(directory, "references");
        fs.mkdirSync(referenceDirectory, { recursive: true });
        for (const [name, markdown] of Object.entries(definition.references)) {
          if (!/^[a-z0-9-]+\.md$/.test(name)) throw new Error("内置技能引用文件名不合法。");
          const referencePath = path.join(referenceDirectory, name);
          if (!fs.existsSync(referencePath)) fs.writeFileSync(referencePath, markdown.trimEnd() + "\n", "utf8");
        }
      }
    }
  }

  private filePath(skillId: string): string {
    if (!/^[a-z0-9-]+$/.test(skillId)) throw new Error("技能 ID 不合法。");
    return path.join(this.rootDirectory, skillId, "SKILL.md");
  }
}

function isBrowserAutomationSkill(skillId: string): boolean {
  return skillId === "zhuque-detection" || skillId === "contentany-detection";
}

function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function selectedTextLength(prompt: string): number {
  const selected = /需要处理的选区：\s*\n([\s\S]*?)\n\s*选区后文：/.exec(prompt)?.[1] ?? "";
  return Array.from(selected.trim()).length;
}
