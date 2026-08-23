import { type ReactNode } from "react";
import type { AccountProfile } from "../types";

// 通用弹窗与账号画像字段（自 main.tsx 拆分）
export function ProfileFields({ profile, onChange }: { profile: AccountProfile; onChange: (field: keyof AccountProfile, value: string) => void }) {
  return <><label>账号定位<textarea autoFocus value={profile.positioning} onChange={(event) => onChange("positioning", event.target.value)} placeholder="这个账号长期为谁解决什么问题？" /></label><label>目标读者<textarea value={profile.targetAudience} onChange={(event) => onChange("targetAudience", event.target.value)} placeholder="例如：关注 AI 工具的技术从业者" /></label><label>禁用话题<textarea value={profile.prohibitedTopics} onChange={(event) => onChange("prohibitedTopics", event.target.value)} placeholder="不希望涉及的话题、表达或承诺" /></label><label>写作风格<textarea value={profile.writingStyle} onChange={(event) => onChange("writingStyle", event.target.value)} placeholder="例如：务实、清晰、有案例" /></label><label>常用栏目<textarea value={profile.regularColumns} onChange={(event) => onChange("regularColumns", event.target.value)} placeholder="例如：工具实测、工作流拆解" /></label><label>文章签名<textarea value={profile.articleSignature} onChange={(event) => onChange("articleSignature", event.target.value)} placeholder="发布草稿时自动追加到正文末尾，例如：本文首发于公众号「围炉聊科技」" /></label></>;
}

export function Modal({ title, eyebrow, children, onClose, disabled, wide = false, priority = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; disabled: boolean; wide?: boolean; priority?: boolean }) {
  return <div className={`modal-backdrop${priority ? " priority-modal" : ""}`} role="presentation" onMouseDown={() => !disabled && onClose()}><section className={`modal-card${wide ? " wide-modal" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}><div className="section-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div><button className="text-button" onClick={onClose} disabled={disabled}>关闭</button></div>{children}</section></div>;
}

