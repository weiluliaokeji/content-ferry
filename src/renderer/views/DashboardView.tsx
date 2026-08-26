import type { Dispatch, SetStateAction } from "react";
import { bestWechatJob } from "../publish-labels";
import { platformName } from "../api";
import type { ContentProject, MediaAccount, ChannelRow, ChannelAction } from "../types";

export interface DashboardViewProps {
  items: DashboardItem[];
  totalItems: number;
  accounts: MediaAccount[];
  wechatJobs: import("../types").WechatPublishJob[];
  saving: boolean;
  openProjectCreator: () => void;
  openBrief: (project: ContentProject, researchFirst?: boolean) => Promise<void> | void;
  openResearch: (project: ContentProject, followUp?: boolean) => Promise<void> | void;
  openOutline: (project: ContentProject) => Promise<void> | void;
  openDraft: (project: ContentProject) => Promise<void> | void;
  openPublishPreparation: (project: ContentProject) => void;
  deleteProjectDraft: (project: ContentProject) => Promise<void> | void;
  openSourceArticle: (relativePath: string, panel?: "assistant" | "preview" | "settings", showError?: boolean) => Promise<boolean> | void;
  channelRowsFor: (item: { relativePath: string; title?: string | null }) => ChannelRow[];
  page: number;
  totalPages: number;
  pageSize: number;
  setPage: Dispatch<SetStateAction<number>>;
  setPageSize: Dispatch<SetStateAction<number>>;
  PAGE_SIZE_OPTIONS: number[];
}

export type DashboardItem =
  | { kind: "project"; id: string; title: string; createdAt: string; relativePath: string | null; project: ContentProject }
  | { kind: "external"; id: string; title: string; createdAt: string; relativePath: string };

function PlatformIcon({ platform }: { platform: ChannelRow["platform"] }) {
  const label = platformName(platform);
  const initials: Record<ChannelRow["platform"], string> = {
    wechat_official: "微",
    csdn: "C",
    cnblogs: "园",
    juejin: "掘",
  };
  return <span className={`platform-icon platform-${platform}`} aria-label={label} title={label}>{initials[platform]}</span>;
}

function StatusIcon({ row }: { row: ChannelRow }) {
  const glyph = row.statusLabel === "已发布" ? "✓" : row.statusLabel === "已冻结" ? "冻" : /草稿|待发布/.test(row.statusLabel) ? "稿" : /处理中|确认中/.test(row.statusLabel) ? "⏳" : /失败|取消/.test(row.statusLabel) ? "✕" : "○";
  return <span className={`status-icon status-${row.tone}`} aria-label={`${row.label}：${row.statusLabel}`} title={`${row.label}：${row.statusLabel}`}>{glyph}</span>;
}

function ChannelActionButton({ action }: { action: ChannelAction }) {
  if (action.kind === "none") return null;
  return <button className="text-button" onClick={() => action.onClick()}>{action.label}</button>;
}

function ChannelStrip({ rows }: { rows: ChannelRow[] }) {
  return <span className="channel-strip">
    {rows.map((row) => (
      <span className="channel-chip" key={row.platform}>
        <PlatformIcon platform={row.platform} />
        <StatusIcon row={row} />
        <ChannelActionButton action={row.action} />
      </span>
    ))}
  </span>;
}

function ProjectRow({
  project, accounts, wechatJobs, saving, openBrief, openResearch, openOutline, openDraft, openPublishPreparation, deleteProjectDraft, channelRowsFor
}: {
  project: ContentProject;
  accounts: MediaAccount[];
  wechatJobs: DashboardViewProps["wechatJobs"];
  saving: boolean;
  openBrief: DashboardViewProps["openBrief"];
  openResearch: DashboardViewProps["openResearch"];
  openOutline: DashboardViewProps["openOutline"];
  openDraft: DashboardViewProps["openDraft"];
  openPublishPreparation: DashboardViewProps["openPublishPreparation"];
  deleteProjectDraft: DashboardViewProps["deleteProjectDraft"];
  channelRowsFor: DashboardViewProps["channelRowsFor"];
}) {
  const job = bestWechatJob(wechatJobs, (item) => item.projectId === project.id || item.sourceRelativePath === project.sourceRelativePath || item.title === project.topic);
  const nextText = job?.status === "published" ? "微信公众号已确认发布完成" : job?.status === "cancelled" ? "发布任务已人工取消，可重新设置后再发布" : job?.status === "submitted" ? "已提交微信，正在等待最终回执" : job?.status === "draft_ready" ? "已同步微信草稿箱，等待预览和发布" : project.draftReady ? "正文已保存，可继续编辑或准备发布" : project.outlineReady ? "提纲已确认，下一步生成正文" : project.researchReady ? "资料已补充，下一步生成提纲" : project.briefReady ? "创作方向已整理，下一步联网补研" : "下一步整理创作方向和资料";
  const action = project.draftReady || project.outlineReady ? () => void openDraft(project) : project.researchReady ? () => void openOutline(project) : project.briefReady ? () => void openResearch(project, true) : () => void openBrief(project);
  const label = project.draftReady ? "打开正文" : project.outlineReady ? "起草正文" : project.researchReady ? "生成提纲" : project.briefReady ? "联网补研" : "整理创作方向";
  const account = project.targetAccountId ? accounts.find((item) => item.id === project.targetAccountId) : undefined;
  const canPrepare = !job || job.status === "failed" || job.status === "cancelled";
  const canEditBrief = project.briefReady && !project.outlineReady && !project.draftReady;
  const channelRows = channelRowsFor({ relativePath: project.sourceRelativePath ?? "", title: project.topic });
  return <li key={project.id}>
    <span>{project.draftReady ? <button className="article-title-button" onClick={() => void openDraft(project)}>{project.topic}</button> : <strong>{project.topic}</strong>}<small>{nextText}</small></span>
      <span className="account-actions">
      <span className="account-badge">{account ? `${platformName(account.platform)} · ${account.displayName}` : "未选发布账号"}</span>
      {canEditBrief && <button className="secondary-button" onClick={() => void openBrief(project)}>编辑创作方向</button>}
      {project.researchReady && <button className="secondary-button" onClick={() => void openResearch(project)}>查看资料</button>}
      {project.outlineReady && <button className="secondary-button" onClick={() => void openOutline(project)}>{job?.status === "published" ? "查看提纲" : "编辑提纲"}</button>}
      {!project.draftReady && <button onClick={action}>{label}</button>}
      {project.draftReady && canPrepare && <button className="secondary-button" onClick={() => openPublishPreparation(project)}>准备发布</button>}
      <button className="text-button danger-text" onClick={() => void deleteProjectDraft(project)} disabled={saving}>{job ? "删除本地文章" : "删除草稿"}</button>
    </span>
    {channelRows.length > 0 && <div className="dashboard-channel-row"><ChannelStrip rows={channelRows} /></div>}
  </li>;
}

export function DashboardView(props: DashboardViewProps) {
  const { items, totalItems, accounts, wechatJobs, saving, openProjectCreator, openBrief, openResearch, openOutline, openDraft, openPublishPreparation, deleteProjectDraft, openSourceArticle, channelRowsFor, page, totalPages, pageSize, setPage, setPageSize, PAGE_SIZE_OPTIONS } = props;

  return <section className={`card${items.length === 0 ? " dashboard-empty-card" : ""}`}>
    {items.length === 0 ? (
      <div className="dashboard-empty"><h2>写下一个主题，开始第一篇文章</h2><p>文渡会创建草稿，并结合账号定位辅助整理方向、提纲和正文。</p><button onClick={openProjectCreator}>＋ 新建文章</button></div>
    ) : (
      <>
        <ul className="project-list">{items.map((item) => item.kind === "project" ? (
          <ProjectRow
            key={item.id}
            project={item.project}
            accounts={accounts}
            wechatJobs={wechatJobs}
            saving={saving}
            openBrief={openBrief}
            openResearch={openResearch}
            openOutline={openOutline}
            openDraft={openDraft}
            openPublishPreparation={openPublishPreparation}
            deleteProjectDraft={deleteProjectDraft}
            channelRowsFor={channelRowsFor}
          />
        ) : (
          <li key={item.relativePath}>
            <span><button className="article-title-button" onClick={() => void openSourceArticle(item.relativePath)}>{item.title ?? "未命名文章"}</button></span>
            <div className="dashboard-channel-row"><ChannelStrip rows={channelRowsFor(item)} /></div>
          </li>
        ))}</ul>
        {totalPages > 1 && <div className="library-pagination">
          <label className="pagination-size-label">每页
            <select className="pagination-size" value={pageSize} onChange={(event) => { setPage(1); setPageSize(Number(event.target.value)); }}>{PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} 条</option>)}</select>
          </label>
          <button className="secondary-button" disabled={page <= 1} onClick={() => { setPage((p) => Math.max(1, p - 1)); }}>上一页</button>
          <span className="library-pagination-info">{page} / {totalPages}</span>
          <button className="secondary-button" disabled={page >= totalPages} onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); }}>下一页</button>
        </div>}
      </>
    )}
  </section>;
}
