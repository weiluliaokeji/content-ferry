import { diffMarkdownLines, trimMarkdownDiffContext } from "../markdown-diff";

export function MarkdownDiffPreview({ before, after }: { before: string; after: string }) {
  const diff = diffMarkdownLines(before, after);
  const visibleLines = trimMarkdownDiffContext(diff);
  if (diff.added === 0 && diff.removed === 0) {
    return <p className="outline-diff-empty">建议与当前提纲没有差异。</p>;
  }

  return <div className="outline-diff-preview" role="region" aria-label="提纲修改差异">
    <div className="outline-diff-summary" aria-live="polite">
      <span className="outline-diff-added-count">+{diff.added} 行新增</span>
      <span className="outline-diff-removed-count">−{diff.removed} 行删除</span>
      <small>绿色为新增，红色为删除；未变内容仅显示修改点附近的几行。</small>
    </div>
    <div className="outline-diff-lines">
      {visibleLines.map((line, index) => line.kind === "omitted"
        ? <div className="outline-diff-omitted" key={`omitted-${index}`}>… 中间 {line.count} 行未变 …</div>
        : <div className={`outline-diff-line ${line.kind}`} key={`${line.kind}-${line.oldLine ?? ""}-${line.newLine ?? ""}-${index}`}>
            <span className="outline-diff-marker" aria-hidden="true">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
            <span className="outline-diff-line-number">{line.oldLine ?? ""}</span>
            <span className="outline-diff-line-number">{line.newLine ?? ""}</span>
            <span className="outline-diff-text">{line.text || " "}</span>
          </div>)}
    </div>
  </div>;
}
