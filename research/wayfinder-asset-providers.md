# Wayfinder：第三方与 AI 配图的素材提供器及版权追溯

## 结论

素材提供器不应被强行做成一个同时具备搜索、生成、截图和代码分析的“大接口”。保留三类适配器，但统一返回候选素材和来源元数据，由一个素材编排层负责下载、保存、确认、引用和追溯：

- **搜索提供器**：搜索结果只进入候选列表；用户确认后才下载到文章 `assets/`。
- **生成提供器**：沿用现有 ModelScope/Agnes 图片连接；图片模型只接收用户确认后的提示词，生成结果先作为未确认本地素材，用户选择后才插入正文或设为封面。
- **派生提供器**：网页截图、源码截图和 Mermaid 图均视为从输入资料派生的本地素材，不作为“第三方图片搜索”处理。

统一的不是调用方法，而是返回数据：

```ts
type AssetProvenance = {
  kind: "search" | "ai_generated" | "web_screenshot" | "source_code" | "mermaid" | "local";
  provider: string;
  sourceUrl?: string;
  landingUrl?: string;
  creator?: string;
  license?: string;
  licenseUrl?: string;
  attribution?: string;
  retrievedAt: string;
  prompt?: string;
  model?: string;
  repositoryUrl?: string;
  commitSha?: string;
  filePath?: string;
  lineRange?: string;
  parentAssetId?: string;
  rendererVersion?: string;
  confirmation: "pending" | "confirmed" | "rejected";
};
```

建议新增单独的素材来源记录（素材文件仍保存到文章 `assets/` 或项目素材库），至少保存 `assetId`、文件哈希、文章/项目上下文、上述 provenance JSON、确认人和确认时间。正式 Markdown 只引用本地相对路径，不把第三方 CDN 当作事实源。

## 提供器选择

### 1. 第一期开放授权图片：Openverse，Wikimedia Commons 作为补充

Openverse API 的图片结果直接包含 `foreign_landing_url`、`creator`、`creator_url`、`license`、`license_version`、`license_url`、`provider`、`detail_url` 和 `attribution` 等字段，适合做候选素材和署名生成。Openverse 明确提醒：它不保证上游许可证信息准确，用户仍需在落地页核对，因此不能把“搜索到”当成“已获授权”。

Wikimedia Commons 的 MediaWiki API 可通过 `imageinfo` + `iiprop=extmetadata` 读取 `Artist`、`Credit`、`LicenseUrl` 等机器可读信息。适合作为需要更完整署名字段的补充来源。

第一期不做通用搜索引擎图片抓取，也不把无许可字段的结果自动写入文章。商业图片站和需要复杂账户/计费的 API 等后续按许可和使用量单独评估。

### 2. AI 生图

复用现有 `CoverGenerationService` 的 ModelScope/Agnes 连接，不新增图片 SDK。增加统一 provenance：提供商、模型、最终提示词、生成时间、结果哈希、服务条款/模型卡链接（若连接配置提供）和“AI 生成、权利需用户确认”提示。

AI 生成结果可以先保存为本地素材，不能自动认为拥有可商用权利；用户选择“插入正文/设为封面”时确认一次，发布前仍显示来源提示。AI 调用审计继续记录请求/响应摘要，但不替代素材 provenance，也不把二进制图片写入日志。

### 3. 网页截图

截图必须绑定原始页面 URL、页面标题、抓取时间、截图工具/版本和用户确认。默认只允许公开页面；登录页、验证码页面、私有/本机地址和需要绕过访问控制的页面不进入自动流程。截图仅作为“待确认派生素材”，不自动插入正文。

### 4. 源码配图

源码证据与图片来源分开记录：仓库 URL、固定 commit SHA、文件路径、行号范围、仓库许可证 URL、获取时间和渲染器版本。默认只读静态分析，不执行仓库代码、不自动安装依赖；大仓库、私有仓库和增量 clone 由多源研究任务票据另行决定。生成图片只是源码片段的派生视图，文章事实仍应引用源码资料卡。

### 5. Mermaid

沿用 Issue #5 的决定：Markdown 中的 Mermaid 源码是事实源，PNG 是可重建的派生物；provenance 记录 `kind=mermaid`、源码哈希、Mermaid 版本和生成时间。渲染失败保留源码块并交给用户处理。

## 用户确认和发布门槛

- 搜索结果：必须展示预览、落地页、作者、许可证、许可证链接和拟生成署名；用户确认后才下载/插入。
- CC BY 等要求署名的素材：确认后提供可复制署名，并在发布前提示用户核对目标平台是否允许/需要署名。
- 无许可证或许可证无法核验：允许作为候选预览，不允许一键写入正式文章；用户若坚持使用，必须明确“未核验”并再次确认。
- AI、截图、源码图：统一标记来源类型；不会伪称为原创照片或已取得第三方授权。
- 所有素材在发布快照中记录素材哈希和 provenance ID，远端平台只保存上传后的回执映射。

## 缓存和安全

- 搜索候选缓存按提供器、查询和分页短期缓存；已确认素材按文件哈希复用，但保留最初来源和许可证快照。
- 下载继续复用现有远程图片安全策略：HTTP(S)、公网地址、重定向限制、大小限制和文件签名校验。
- provenance 记录 URL、标题、许可证和摘要，不记录访问令牌、Cookie 或完整网页正文。
- 外部页面内容只作为不可信资料，不能通过图片元数据或网页文字改变权限、发布状态或凭据。

## 官方依据

- [Openverse API client 文档](https://docs.openverse.org/packages/js/api_client/index.html)：搜索接口字段、未认证客户端和限流处理。
- [Openverse API media properties](https://docs.openverse.org/meta/media_properties/api.html)：许可证、作者、来源、落地页和 attribution 字段。
- [Openverse 使用说明](https://docs.openverse.org/_preview/4259/api/reference/made_with_ov.html) 与 [服务条款](https://docs.openverse.org/_preview/4859/terms_of_service.html)：开放授权范围及“需自行核对许可”的责任边界。
- [Wikimedia Commons machine-readable data](https://commons.wikimedia.org/wiki/Commons:Machine-readable_data)：通过 `imageinfo/extmetadata` 获取作者、署名和许可证信息。
- [GitHub REST Contents API](https://docs.github.com/en/rest/repos/contents)：固定路径读取源码并获得文件 SHA；后续源码研究可据此建立 commit/path 证据链。

## 实施顺序

1. 先落地 provenance 数据模型和本地素材确认/引用流程。
2. 接入 Openverse，补充 Wikimedia 元数据读取；没有可核验许可的候选不自动插入。
3. 将现有 AI 生图和 Mermaid 结果迁移到同一 provenance 记录。
4. 再接网页截图和源码派生图；它们依赖多源研究任务的暂停、取消、缓存和仓库范围决策。
