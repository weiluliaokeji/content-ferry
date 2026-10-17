# 文渡待开发与优化事项

问题、需求和设计事项统一记录在 GitHub Issues 中。本文件只保留未完成事项的索引，不复制 Issue 的详细范围、验收标准或实现讨论。

## 待处理

- 清理数学排版链剩余的 KaTeX 低危告警：当前编辑器关闭 LaTeX，报告中的原型污染绕过还需要额外前提；Mermaid 11 与 `micromark-extension-math` 仍锁有旧版 KaTeX。待 Mermaid 主版本兼容性和新增依赖许可证核验完成后，再升级其数学渲染链或用上游兼容修复替换；完成条件是生产依赖审计不再报告该链，且公式、流程图和安装包渲染复验通过。

- [研究资料来源可信度与精确引用](https://github.com/weiluliaokeji/content-ferry/issues/38)（`needs-triage`）
- [补齐 Git 结果应用为文章建议动作](https://github.com/weiluliaokeji/content-ferry/issues/39)（`needs-triage`）
- [高级记忆维护与冲突版本确认](https://github.com/weiluliaokeji/content-ferry/issues/40)（`needs-triage`）
- [Git 源码证据的符号级分析](https://github.com/weiluliaokeji/content-ferry/issues/41)（`needs-triage`）
- [普通 Markdown 内容源入口与 Front Matter 扩展](https://github.com/weiluliaokeji/content-ferry/issues/42)（`needs-triage`）
- [文渡原生微信视频号执行工作流](https://github.com/weiluliaokeji/content-ferry/issues/43)（`needs-triage`、`ready-for-human`）
- [支持自定义视觉连接作为图片初审模型](https://github.com/weiluliaokeji/content-ferry/issues/44)（`needs-triage`）
- [按账号学习并持续应用历史文章写作风格](https://github.com/weiluliaokeji/content-ferry/issues/54)（进行中；规格已同步）
  - [提炼、比较并确认账号风格档案版本](https://github.com/weiluliaokeji/content-ferry/issues/56)（已实现，待作者验收；依赖 #55，样本挑选阶段已验收）
  - [主稿按目标账号应用风格档案](https://github.com/weiluliaokeji/content-ferry/issues/57)（已接入主稿生成，待作者验收）
  - [渠道稿分别应用目标账号风格档案](https://github.com/weiluliaokeji/content-ferry/issues/58)（依赖 #56；可与 #57 并行）
- [为提纲和正文加入独立内容评审与有界修订](https://github.com/weiluliaokeji/content-ferry/issues/59)（提纲、主稿和四个平台的改写稿评审已实现，待作者验收）
  - [为生成提纲加入独立评审与有界修订](https://github.com/weiluliaokeji/content-ferry/issues/60)（已实现，待作者验收）
  - [为主稿起草加入独立评审与依据核查](https://github.com/weiluliaokeji/content-ferry/issues/61)（独立评审、三轮正文修订、未通过保留和资料缺口后的正式补研复评已实现；新抓取网页正文只作待作者确认的候选依据。实践评审缺口后的授权任务回接与同一轮起草复评已接入；重启后可恢复未保存候选，作者主动续审时重读当前资料与实践结果，不重复生成初稿或配图。等待作者决定后的细粒度实践续跑和真实窗口验收仍待完成；跳过实践后明确调整范围、修订候选并独立复评已接入；完成条件是这些路径都能保留候选、事件和明确停止原因，并在取得新观察后独立复评）
    - 多章节初稿已逐节生成、保存检查点并统一评审；各节只选相关资料，评审修订、补研和实践更新优先使用有锚点的局部替换，保留其他章节。每次新起草时增加一次有界资料核对，仅有关键缺口才补研；新增来源后复核其是否真的填补缺口。下一步用真实主题和不同模型验收文章完整性、事实依据、实践结果与可操作性，重点核查起草前补研是否值得其耗时、评审能否识别“关键步骤推给官网”的空洞指南，以及结构缺失时的完整重写是否仍会压短内容。
  - [为实质改写后的渠道稿加入独立评审](https://github.com/weiluliaokeji/content-ferry/issues/62)（已实现，待作者验收）

已完成的阿文工具调用闭环和联网找图事项不再列在这里；对应历史 Issue 可在 GitHub 的已关闭列表中查看。
