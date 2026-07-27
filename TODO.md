# 文渡待开发与优化事项

本文件记录已经讨论确认、但尚未进入当前实现范围的功能和工程优化。它不是需求文档的替代品：开始实现前仍需核对`spec/`中的产品边界和验收要求；完成、取消或被新方案取代后，应及时更新本文件。

## 研究计划、资料卡与授权联网补研

**状态：** 部分实现
**主要范围：** 创作简报、模型任务、资料卡存储、可见浏览器/搜索适配器、提纲生成与编辑器资料来源面板。

目前阿文已可通过 OpenAI Codex 的实时网页检索生成研究结论和可筛选资料卡；提纲和正文只接收被保留的资料卡。写作任务保持离线，避免在普通写作中任意联网。文章提纲也不得承担研究待办。

建议流程：

1. 支持资料卡重试、编辑研究问题和“仅使用已有资料”的显式快捷入口。
2. 为必须登录、验证码、动态页面和无稳定接口的来源接入可见浏览器自动化，并在不确定步骤交给用户接管。
3. 增加官方来源域名白名单、来源去重、可信度提示、手工补录资料卡和引用到正文的精确映射。
4. 记录每次补研的模型、技能版本、输入摘要、工具调用、耗时、失败原因与可恢复位置。

**完成条件：** 用户可以查看、编辑、停止和重试一次补研；每个关键事实可以追溯到资料卡；网络失败可重试或人工接管；未核实信息不会被伪装为已经核查；研究计划、资料卡和文章提纲在界面与数据模型中相互独立。

## VitePress 依赖的透明度和解耦

**状态：** 待设计与开发  
**主要范围：** `ContentSourceService`、内容源 API、文章库设置界面  
**目标：** 保留当前 VitePress 兼容能力，同时把目录约定和 Front Matter 映射显式化，为普通 Markdown 本地文章库留出扩展入口。

当前实现对`posts/<文章目录>/index.md`、`assets/`、`.vitepress/`和`public/`等 VitePress 约定存在隐式依赖。第一阶段将这些差异集中在`ContentSourceService`内部，不扩散到编辑、AI、发布和工作流模块。

### 第一步：抽取目录模式为配置

在`content-source-service.ts`中增加可配置的文章目录模式：

```typescript
interface ArticlePathPattern {
  baseDir: string;           // 默认 "posts"
  entryFile: string;         // 默认 "index.md"
  assetDir: string;          // 默认 "assets"
  extraIgnoreDirs: string[]; // 默认 [".vitepress"]
}
```

`isArticlePath`改为接收目录模式：

```typescript
function isArticlePath(relativePath: string, pattern: ArticlePathPattern): boolean {
  const segments = relativePath.split(path.sep);
  return segments[0] === pattern.baseDir
    && segments.length >= 3
    && segments.at(-1)?.toLowerCase() === pattern.entryFile;
}
```

实现时还需统一扫描、创建、重命名、删除、素材解析和测试使用的目录规则，不能只修改文章识别函数。

### 第二步：Front Matter 字段映射

在内容源边界完成 VitePress 字段到内部通用字段的映射：

| VitePress 字段 | 内部通用名 | 处理方式 |
|---|---|---|
| `title` | `title` | 一致，不改 |
| `created` | `createdAt` | 字段名映射，值不改 |
| `tags` | `tags` | 一致 |
| `publish` | `status` | `false`映射为`draft`，`true`映射为`published` |
| `updated` | 无 | 不新增内部字段，使用文件`mtime` |

`setSource`增加`sourceType: "vitepress" | "plain"`参数，默认使用`"vitepress"`以保持现有用户兼容。

当`sourceType`为`"plain"`时：

- 不要求`posts/`目录层级；
- 不应用`.vitepress/`专用过滤；
- 不使用`public/`资源回退；
- 仍需定义文章入口文件、图片相对路径、标题和创建时间的明确规则，避免把所有 Markdown 都误识别为文章。

内部模型不应直接暴露`publish`等 VitePress 专用字段。保存回源文件时，再由对应内容源适配规则恢复原字段，并保留未知 Front Matter 扩展字段。

### 第三步：界面措辞去品牌化

- 面向普通用户的“VitePress 文章库”改为“本地文章库”。
- 文章库配置和状态区域显示当前类型，例如“VitePress”或“普通 Markdown”。
- `setSource`增加`sourceType`后，首次选择目录时允许用户确认类型；能够可靠识别时可以推荐，但不能静默改变已有内容源类型。
- VitePress 专用格式说明只在当前类型为 VitePress 时展示。

### 完成条件

- 现有 VitePress 文章库扫描、编辑、标题目录重命名、素材解析、删除和微信发布回归测试全部通过。
- 新增普通 Markdown 内容源的扫描、创建、编辑、图片和删除测试。
- 内容源类型和目录模式被持久化，重启后不丢失。
- UI、API、需求文档、开发设计和用户说明同步更新。
- 升级后现有用户默认仍是 VitePress，不需要重新选择目录，也不会改变原 Front Matter。
