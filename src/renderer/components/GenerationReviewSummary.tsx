import type { ContentGenerationReview } from "../types";

export function getGenerationReviewHeading(status: ContentGenerationReview["status"], subject: string): string {
  return status === "passed" ? `${subject}评审通过`
    : status === "review_failed" ? `${subject}评审未完成` : `${subject}需要处理`;
}

export function GenerationReviewSummary({ review, subject, onReReview, disabled = false, placement = "inline" }: { review: ContentGenerationReview | null | undefined; subject: string; onReReview?: () => void; disabled?: boolean; placement?: "inline" | "topbar" }) {
  if (!review) return null;
  const blocked = review.status !== "passed";
  const heading = getGenerationReviewHeading(review.status, subject);
  const compactSummary = [
    review.repairRounds ? `自动修订 ${review.repairRounds} 轮` : "",
    review.report.findings.length ? `${review.report.findings.length} 项待处理` : "",
    review.stale ? "评审后有修改" : ""
  ].filter(Boolean).join(" · ");
  const details = <>
    <p>{review.report.summary}{review.stale ? ` ${subject}已在评审后修改，记录对应的是修改前版本。` : ""}</p>
    {review.report.findings.length > 0 && <ul>{review.report.findings.map((finding, index) => <li key={`${finding.title}-${index}`}><b>{finding.severity === "blocker" ? "需处理" : "待改进"}：{finding.title}</b>{finding.resolution && finding.resolution !== "revision" ? <small>处理方式：{({ research: "补充并采纳资料", practice: "执行本篇实践", scope_decision: "由作者确认文章范围" } as const)[finding.resolution]}</small> : null}　{finding.detail}{finding.evidence?.length ? <small>依据：{finding.evidence.join("；")}</small> : null}</li>)}</ul>}
    {review.report.error && <p>{review.report.error}</p>}
    {onReReview && (blocked || review.stale) && <button type="button" className="secondary-button" onClick={onReReview} disabled={disabled}>重新评审当前内容</button>}
  </>;

  return <section className={`generation-review-summary ${blocked ? "needs-author" : "passed"}${placement === "topbar" ? " topbar-review-summary" : ""}`} aria-live="polite">
    {placement === "topbar" ? <details className="generation-review-details" open={blocked || review.stale}>
      <summary className="topbar-review-trigger"><strong>{heading}</strong>{compactSummary && <span>{compactSummary}</span>}</summary>
      <div className="generation-review-popover">{details}</div>
    </details> : <>
      <div className="generation-review-summary-heading">
        <strong>{heading}</strong>
        <span>{compactSummary}</span>
      </div>
      <details className="generation-review-details" open={blocked || review.stale}>
        <summary>查看评审详情</summary>
        {details}
      </details>
    </>}
  </section>;
}
