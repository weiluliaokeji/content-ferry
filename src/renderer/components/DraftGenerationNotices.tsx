import type { ContentDraft } from "../types";

export function DraftGenerationNotices({
  styleSelectionNote,
  imageCuration
}: {
  styleSelectionNote?: string;
  imageCuration?: ContentDraft["imageCuration"];
}) {
  if (!styleSelectionNote && !imageCuration) return null;

  const imageTitle = imageCuration?.outcome === "added"
    ? `已加入 ${imageCuration.inserted} 张配图`
    : imageCuration?.outcome === "unavailable" ? "配图处理未完成" : "未添加配图";

  return <div className="draft-generation-notices">
    {styleSelectionNote && <section className="draft-generation-notice draft-style-selection-note" role="status" aria-label="风格选择说明">
      <strong>阿文的风格选择</strong>
      <p>{styleSelectionNote}</p>
    </section>}
    {imageCuration && <section className={`draft-generation-notice draft-image-curation-note draft-image-curation-${imageCuration.outcome}`} role="status" aria-label="配图处理结果">
      <strong>配图处理：{imageTitle}</strong>
      <p>{imageCuration.reason}</p>
    </section>}
  </div>;
}
