import { useState } from "react";

export type HelpCenterView = "dashboard" | "library" | "publish" | "skills" | "accounts" | "logs" | "help";

export function HelpCenter({ onNavigate }: { onNavigate: (view: HelpCenterView) => void }) {
  const [guideError, setGuideError] = useState("");

  async function openUserGuide() {
    setGuideError("");
    if (!window.contentFerry) {
      setGuideError("完整说明文件只能从文渡桌面应用中打开。");
      return;
    }
    try {
      await window.contentFerry.openUserGuide();
    } catch (error) {
      setGuideError(error instanceof Error ? error.message : "无法打开完整使用说明。");
    }
  }

  return (
    <div className="help-center">
      <section className="card help-hero">
        <div>
          <p className="eyebrow">快速上手</p>
          <h2>先完成配置，再写第一篇文章</h2>
          <p>文章保存在你自己的 VitePress 文章库；模型、账号和发布记录保存在本机。</p>
        </div>
        <span>
          <button className="secondary-button" onClick={() => void openUserGuide()}>打开完整说明</button>
          <button onClick={() => onNavigate("dashboard")}>开始创作</button>
        </span>
      </section>
      {guideError && <p className="error">{guideError}</p>}

      <section className="help-steps">
        <article>
          <span>1</span>
          <h3>连接模型</h3>
          <p>在“技能与模型”登录 OpenAI Codex，或配置 OpenAI API、OpenRouter、Nous Research、GitHub Copilot 等连接。</p>
          <button className="text-button" onClick={() => onNavigate("skills")}>去配置模型</button>
        </article>
        <article>
          <span>2</span>
          <h3>选择文章库</h3>
          <p>选择 VitePress 的 <code>docs</code> 目录，不要只选择 <code>docs/posts</code>。草稿会直接写入文章库。</p>
          <button className="text-button" onClick={() => onNavigate("library")}>去内容库</button>
        </article>
        <article>
          <span>3</span>
          <h3>连接公众号</h3>
          <p>在微信公众平台“设置与开发 → 基本配置”获取 AppID、AppSecret，并把当前公网出口 IP 加入白名单。</p>
          <button className="text-button" onClick={() => onNavigate("accounts")}>去账号设置</button>
        </article>
        <article>
          <span>4</span>
          <h3>创作并发布</h3>
          <p>从主题开始，阿文先联网补充可追溯资料；资料不足时可在资料窗口继续指示补研。再生成提纲与正文；完成封面与 AIGC 特征检测后，先同步微信草稿并人工预览，再决定普通发布或群发。</p>
          <button className="text-button" onClick={() => onNavigate("dashboard")}>新建文章</button>
        </article>
      </section>

      <section className="card help-faq">
        <h2>微信公众号配置</h2>
        <details>
          <summary>AppID 和 AppSecret 在哪里获取？</summary>
          <p>登录 mp.weixin.qq.com，进入“设置与开发”，打开“基本配置”或“开发接口管理”。AppSecret 通常只在生成或重置时完整显示，请立即保存到密码管理器。</p>
        </details>
        <details>
          <summary>IP 白名单应该填写什么？</summary>
          <p>填写运行文渡电脑的公网出口 IP，不是 127.0.0.1 或 192.168.*。动态公网 IP 变化后，需要在公众号后台重新修改白名单。</p>
        </details>
        <details>
          <summary>为什么还要配置回调？</summary>
          <p>微信接口返回提交成功不代表最终发布成功。公众号需要通过公网 HTTPS 地址把最终事件转发到文渡的 <code>/wechat/callback/&lt;账号 ID&gt;</code>。</p>
        </details>
        <details>
          <summary>原创、赞赏和合集怎么设置？</summary>
          <p>在文章编辑页的“文章设置”中勾选申请原创声明、开启赞赏，或填写合集名称。草稿创建后，在发布中心点击“在微信后台完善并发布”；文渡会先读取微信“选择合集”窗口中可见的名称，按公众号缓存后再匹配文章设置。下次可直接从同一公众号的下拉建议中选择；微信后台仍是最终来源。你仍要核对最终效果，并在微信后台点击发布。</p>
        </details>

        <h2>常见问题</h2>
        <details>
          <summary>技能与模型有什么区别？</summary>
          <p>技能决定任务规则，例如公众号撰写、去 AI 味和封面提示词；模型连接决定由哪个服务执行。腾讯朱雀和 ContentAny 使用浏览器自动化，不需要大模型。“联网检索服务”则独立于模型连接：可选配置 Tavily，以提升阿文补研公开资料时的稳定性。</p>
          <p>技能按模型依赖分成三组：文本类（创作、改写，用 OpenAI 系列）、图像类（用 ModelScope / Gemini）、无模型（朱雀、ContentAny 走浏览器自动化）。想给同一类里的部分技能统一换模型时，不必逐个点开编辑：先在技能卡片右上角勾选要改的技能，再在该组标题栏的“批量设置模型”里选好目标模型，点“应用到选中的 N 个技能”即可一次改完。</p>
        </details>
        <details>
          <summary>怎样让 AI 按我的要求改写一段文字？</summary>
          <p>先在正文中选中文字，选择“改写”“去 AI 味”等动作，再在“补充要求（可选）”中填写语气、保留项或避免项；留空则使用该技能的默认规则。按 Ctrl+Enter 可直接生成建议。结果会保存到与阿文的对话，可在对话中接受或拒绝。</p>
          <p>在所见即所得编辑区选中文字后，可用 Ctrl+C 复制；Ctrl+Z 和 Ctrl+Y 分别撤销和重做。</p>
        </details>
        <details>
          <summary>文章、会话和阿文记忆保存在哪里？</summary>
          <p>文章保存在 VitePress 文章库；账号设置、发布记录、会话、记忆摘要和日志保存在文渡数据目录。长期记忆只保存提炼后的稳定写作偏好，不把完整会话直接当作写作规则。</p>
        </details>
        <details>
          <summary>阿文已经处理过的建议为什么不会再出现？</summary>
          <p>同意、拒绝或手动改掉建议对应原文后，文渡会保存该处理结果。正文中只显示仍待处理且能唯一定位的建议卡；阿文对话会保留原建议、改写文本和“已接受”“已拒绝”或“无法定位”的记录。建议卡可拖动，切换所见即所得和 Markdown 原文后会重新锚定到对应段落。</p>
        </details>
        <details>
          <summary>遇到错误怎么办？</summary>
          <p>到“运行日志”选择发生问题的日期，查看错误、请求路径、状态码和请求 ID。涉及微信发布时，可在发布中心核实后台结果并人工校正状态。</p>
          <button className="text-button" onClick={() => onNavigate("logs")}>查看运行日志</button>
        </details>
      </section>
    </div>
  );
}
