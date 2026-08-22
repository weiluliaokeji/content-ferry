import type { ContentReview, ZhuqueReport } from "../types";
import { ZhuqueReportView } from "./ZhuqueReportViews";

// 内容质量检测工作区（自 main.tsx 拆分）
export function QualityWorkspace({
  title,
  review,
  zhuqueReport,
  error,
  saving,
  detecting,
  onChange,
  onBack,
  onAutoDetect,
  onOpenZhuque,
  onOptimize,
  onContinueEditing,
  onReady
}: {
  title: string;
  review: ContentReview | undefined;
  zhuqueReport: ZhuqueReport | undefined;
  error: string;
  saving: boolean;
  detecting: boolean;
  onChange: (review: ContentReview) => void;
  onBack: () => void;
  onAutoDetect: () => void;
  onOpenZhuque: () => void;
  onOptimize: () => void;
  onContinueEditing: () => void;
  onReady: () => void;
}) {
  return <div className="quality-workspace">
    <header className="editor-topbar">
      <button className="secondary-button" onClick={onBack} disabled={saving || detecting}>← 返回文章</button>
      <div className="editor-document-title"><strong>发布前优化：{title}</strong><small>自动检测优先，只有特殊情况才需要人工接管</small></div>
      <div className="editor-top-actions"><button onClick={onReady} disabled={!review || saving || detecting}>内容已准备好</button></div>
    </header>
    <main className="quality-main">
      {error && <p className="error">{error}</p>}
      {!review ? <section className="quality-card"><p>正在准备检测工具…</p></section> : <>
        <section className="quality-card primary">
          <div className="quality-step"><span>1</span><div><h2>腾讯朱雀自动检测</h2><p>文渡自动打开可见浏览器、填入当前正文、触发检测并读取结果。登录状态会保留。</p></div></div>
          <button onClick={onAutoDetect} disabled={detecting}>{detecting ? "正在自动操作朱雀，请稍候…" : review.aiCheckResult ? "重新自动检测" : "开始自动检测"}</button>
          <details><summary>只有自动化无法完成时才需要人工接管</summary><p>遇到登录、验证码或页面变化时，浏览器窗口会保持打开。完成操作后再次点击自动检测即可从当前会话继续。</p><button className="text-button" onClick={onOpenZhuque}>单独打开朱雀网页</button></details>
        </section>
        <section className="quality-card">
          <div className="quality-step"><span>2</span><div><h2>查看结果并决定怎么改</h2><p>自动读取的结果可以修正；系统不会把检测结果当成文章作者身份的最终判定。</p></div></div>
          {zhuqueReport && <ZhuqueReportView report={zhuqueReport} />}
          <label>检测摘要与补充备注<textarea value={review.aiCheckResult} onChange={(event) => onChange({ ...review, aiCheckResult: event.target.value })} placeholder="自动检测完成后会显示总体指标；也可以补充你对结果的判断" /></label>
          {zhuqueReport && <button className="text-button zhuque-original-button" onClick={onOpenZhuque}>查看朱雀原始结果窗口</button>}
          <label>希望 AI 重点修改什么<textarea value={review.notes} onChange={(event) => onChange({ ...review, notes: event.target.value })} placeholder="例如：减少机械分点，增加真实判断，重写开头和总结" /></label>
          <button className="ai-action-button" onClick={onOptimize} disabled={saving || detecting}>{saving ? "AI 正在生成优化稿…" : "让 AI 按检测结果生成可编辑新稿"}</button>
        </section>
        <div className="quality-footer"><button className="secondary-button" onClick={onContinueEditing} disabled={saving || detecting}>保存结果，自己继续修改</button><button onClick={onReady} disabled={saving || detecting}>跳过继续优化，进入发布准备</button></div>
      </>}
    </main>
  </div>;
}

