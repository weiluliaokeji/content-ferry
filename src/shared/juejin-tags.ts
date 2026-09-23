/**
 * 掘金分类与标签的确定性推断逻辑（前后端共用）。
 *
 * 这些函数不依赖浏览器或 Node 专属 API，因此同时被：
 * - renderer（JuejinDraftWorkspace）用于在缺省/AI 推荐缺失时的兜底推断；
 * - main（JuejinChannelService.recommendPublishOptions）用作模型不可用时的兜底。
 *
 * 注意：纯字面子串匹配只是兜底手段。真正的语义选型由后端在创建掘金稿时
 * 调用 AI 完成（见 juejin-channel-service.ts 的 recommendPublishOptions）。
 */

/**
 * 掘金服务端硬性上限：一篇文章最多只能挂 3 个标签。
 * 超过会直接被接口拒绝（"您最多可以为文章添加3个标签"），
 * 因此推荐、解析、UI 选择、发布前都必须按此常量截断，不要各自写死数字。
 */
export const JUEJIN_MAX_TAGS = 3;

/** 掘金固定分类 ID（来自 PsChina/web-publish adapters/juejin.yaml 实测）。 */
export const JUEJIN_CATEGORIES: Array<{ label: string; id: string }> = [
  { label: "后端", id: "6809637769959178254" },
  { label: "前端", id: "6809637767543259144" },
  { label: "Android", id: "6809635626879549454" },
  { label: "iOS", id: "6809635626661445640" },
  { label: "人工智能", id: "6809637773935378440" },
  { label: "开发工具", id: "6809637771511070734" },
  { label: "代码人生", id: "6809637776263217160" },
  { label: "阅读", id: "6809637772874219534" }
];

/** 掘金已知 tag 名 → ID 映射；未命中的输入按 tag ID 原文透传。 */
export const JUEJIN_KNOWN_TAGS: Record<string, string> = {
  "AI编程": "7467857238494020000",
  "OpenAI": "6809641073527226000",
  "AIGC": "7197380506562871000"
};

/** 掘金分类关键词组（id 对应 JUEJIN_CATEGORIES）：按标题+正文命中数最多的分类胜出。 */
export const JUEJIN_CATEGORY_KEYWORDS: Array<{ id: string; keywords: string[] }> = [
  { id: "6809637769959178254", keywords: ["后端", "java", "spring", "微服务", "数据库", "mysql", "redis", "golang", "服务端", "接口", "架构", "分布式", "中间件", "docker", "kubernetes", "k8s", "linux", "nginx", "消息队列", "kafka", "高并发"] },
  { id: "6809637767543259144", keywords: ["前端", "react", "vue", "javascript", "typescript", "html", "css", "组件", "界面", "网页", "浏览器", "web", "node"] },
  { id: "6809635626879549454", keywords: ["android", "安卓", "kotlin", "gradle", "apk"] },
  { id: "6809635626661445640", keywords: ["ios", "swift", "objective-c", "xcode", "iphone", "macos"] },
  { id: "6809637773935378440", keywords: ["人工智能", "大模型", "llm", "gpt", "机器学习", "深度学习", "神经网络", "nlp", "多模态", "rag", "智能体", "aigc", "prompt", "提示词", "微调", "finetune", "embedding", "token", "ai"] },
  { id: "6809637771511070734", keywords: ["开发工具", "vscode", "ide", "编辑器", "命令行", "终端", "git", "github", "调试", "性能优化", "测试", "构建", "ci/cd", "自动化"] },
  { id: "6809637776263217160", keywords: ["程序员", "代码人生", "职场", "面试", "职业", "成长", "心得", "经验", "随笔"] },
  { id: "6809637772874219534", keywords: ["阅读", "读书", "书评", "读后感", "荐书", "书单"] }
];

/** 判断 text 是否包含 keyword：纯英文/数字类关键词按单词边界匹配，其余按子串匹配。 */
export function textContainsKeyword(text: string, keyword: string): boolean {
  const lower = text.toLowerCase();
  const kw = keyword.toLowerCase();
  if (/^[a-z0-9][a-z0-9+#._-]*$/.test(kw)) {
    return new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower);
  }
  return lower.includes(kw);
}

/** 统计 keyword 在 text 中的出现次数：英文/数字按单词边界，其余按子串。 */
function countKeywordMatches(text: string, keyword: string): number {
  const kw = keyword.toLowerCase();
  if (/^[a-z0-9][a-z0-9+#._-]*$/.test(kw)) {
    const matches = text.match(new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"));
    return matches ? matches.length : 0;
  }
  if (!kw) return 0;
  let count = 0;
  let index = text.indexOf(kw);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(kw, index + kw.length);
  }
  return count;
}

// 分类关键词里的泛词：命中即计分的权重调低，避免“人工智能”组仅凭 ai/token/prompt
// 等高频泛词就压过真正更匹配的具体分类（如讲 Docker/K8s 的后端文章）。
const CATEGORY_GENERIC_KEYWORDS: Record<string, number> = { ai: 0.3, token: 0.3, prompt: 0.3 };

/** 根据标题+正文自动推断掘金分类 id：命中关键词加权得分最高的分类胜出，无命中时返回默认分类（代码人生）。 */
export function inferJuejinCategory(title: string, markdown: string): string {
  const text = `${title}\n${markdown}`.toLowerCase();
  let bestId = "";
  let bestScore = 0;
  for (const group of JUEJIN_CATEGORY_KEYWORDS) {
    let score = 0;
    for (const keyword of group.keywords) {
      if (textContainsKeyword(text, keyword)) {
        score += keyword in CATEGORY_GENERIC_KEYWORDS ? CATEGORY_GENERIC_KEYWORDS[keyword] : 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = group.id;
    }
  }
  if (bestId) return bestId;
  const fallback = JUEJIN_CATEGORIES.find((category) => category.label === "代码人生");
  return fallback?.id ?? JUEJIN_CATEGORIES[0]?.id ?? "";
}

/**
 * 根据标题+正文从官方标签中推断最多 JUEJIN_MAX_TAGS 个标签 id。
 * 与旧实现（按官方标签列表顺序取前 N 个命中的）不同，这里统计每个官方标签名在
 * 正文中的出现次数（标题命中额外加权），按相关性排序取前 N，避免热度靠前的泛标签
 * 占满名额；id 必须真实存在于 availableTags，严禁造非法 tag_id。
 */
export function inferJuejinTags(title: string, markdown: string, availableTags: Array<{ id: string; name: string }>): string[] {
  const body = `${title}\n${markdown}`.toLowerCase();
  const titleLower = title.toLowerCase();
  const scored: Array<{ id: string; score: number }> = [];
  for (const tag of availableTags) {
    const name = tag.name.trim();
    if (!name) continue;
    const occurrences = countKeywordMatches(body, name);
    if (occurrences === 0) continue;
    let score = occurrences;
    // 标题命中加权：出现在标题里的标签比仅在正文零星出现更可能是文章主题。
    if (countKeywordMatches(titleLower, name) > 0) score += 3;
    scored.push({ id: tag.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, JUEJIN_MAX_TAGS).map((entry) => entry.id);
}
