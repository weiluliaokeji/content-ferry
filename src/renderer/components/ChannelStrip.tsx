import { platformName } from "../api";
import type { ChannelAction, ChannelRow } from "../types";

function PlatformIcon({ platform }: { platform: ChannelRow["platform"] }) {
  const initials: Record<ChannelRow["platform"], string> = {
    wechat_official: "微",
    csdn: "C",
    cnblogs: "园",
    juejin: "掘",
    "51cto": "51",
  };
  const label = platformName(platform);
  return <span className={`platform-icon platform-${platform}`} aria-label={label} title={label}>{initials[platform]}</span>;
}

function StatusIcon({ row }: { row: ChannelRow }) {
  const glyph = row.action.kind === "generate" ? "未" : row.statusLabel === "已发布" ? "✓" : row.statusLabel === "已冻结" ? "冻" : /草稿|待发布/.test(row.statusLabel) ? "稿" : /处理中|确认中/.test(row.statusLabel) ? "…" : /失败|取消/.test(row.statusLabel) ? "✕" : "待";
  return <span className={`status-icon status-${row.tone}`} aria-label={`${row.label}：${row.statusLabel}`} title={`${row.label}：${row.statusLabel}`}>{glyph}</span>;
}

function ChannelActionIcon({ action }: { action: ChannelAction }) {
  if (action.kind === "none") return null;
  const glyph = action.kind === "generate" ? "＋" : "✎";
  const title = action.kind === "generate" ? action.label : "继续处理渠道稿";
  return <button type="button" className="channel-action-icon" onClick={action.onClick} aria-label={title} title={title}>{glyph}</button>;
}

export function ChannelStrip({ rows, actions = false }: { rows: ChannelRow[]; actions?: boolean }) {
  return <span className="channel-strip">
    {rows.map((row) => <span className="channel-chip" key={row.platform}>
      <PlatformIcon platform={row.platform} />
      <StatusIcon row={row} />
      {actions && <ChannelActionIcon action={row.action} />}
    </span>)}
  </span>;
}
