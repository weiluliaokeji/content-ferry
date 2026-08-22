import type { ContentAnyReference, ZhuqueReport } from "../types";

// 朱雀/ContentAny 检测结果视图（自 main.tsx 拆分）
export function ContentAnyReferenceView({ reference }: { reference: ContentAnyReference }) {
  return <section className="contentany-reference" aria-label="ContentAny 参考结果"><div className="contentany-reference-header"><span>{reference.label}</span>{reference.score && <strong>{reference.score}</strong>}</div><p>{reference.summary}</p>{reference.detail !== reference.summary && <small>{reference.detail}</small>}</section>;
}

export function ZhuqueReportView({ report }: { report: ZhuqueReport }) {
  const human = report.humanPercent ?? 0;
  const uncertain = report.uncertainPercent ?? 0;
  const humanEnd = Math.min(100, human);
  const uncertainEnd = Math.min(100, human + uncertain);
  const chartStyle = {
    background: `conic-gradient(#bfe8ad 0 ${humanEnd}%, #f5d9a5 ${humanEnd}% ${uncertainEnd}%, #f6bcbc ${uncertainEnd}% 100%)`
  };
  const format = (value: number | null) => value == null ? "未读取" : `${value.toFixed(2)}%`;
  return <section className="zhuque-report" aria-label="腾讯朱雀检测报告">
    <div className="zhuque-segment-panel">
      <div className="zhuque-report-heading"><strong>{report.verdict}</strong><small>{report.ratioSource === "segments" ? "右侧比例按各类彩色分段的非空白字符数计算，并非朱雀网页提供的官方比例。" : "右侧为朱雀网页读取的官方比例；不同底色对应朱雀对各段文字的判断。"}</small></div>
      <div className="zhuque-segments">
        {report.segments.length > 0
          ? report.segments.map((segment, index) => <span className={`zhuque-segment ${segment.kind}`} key={`${index}-${segment.text.slice(0, 12)}`}>{segment.text}</span>)
          : <p className="hint">已读取总体比例，但网页没有提供可识别的分段结果。可在右侧查看比例，或打开原始结果窗口核对。</p>}
      </div>
    </div>
    <aside className="zhuque-ratio-panel">
      <div className="zhuque-donut" style={chartStyle}><span /></div>
      <dl>
        <div className="human"><dt>人工特征</dt><dd>{format(report.humanPercent)}</dd></div>
        <div className="uncertain"><dt>疑似 AI</dt><dd>{format(report.uncertainPercent)}</dd></div>
        <div className="ai"><dt>AI 特征</dt><dd>{format(report.aiPercent)}</dd></div>
      </dl>
    </aside>
  </section>;
}

