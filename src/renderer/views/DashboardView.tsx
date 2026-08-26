import { bestWechatJob } from "../publish-labels";
import { platformName } from "../api";
import type { ContentProject, MediaAccount, ContentSourcePreview, ChannelRow, ChannelAction } from "../types";

export interface DashboardViewProps {
  projects: ContentProject[];
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
  externalArticles: ContentSourcePreview["items"];
  publishedCount: number;
  openSourceArticle: (relativePath: string, panel?: "assistant" | "preview" | "settings", showError?: boolean) => Promise<boolean> | void;
  channelRowsFor: (item: { relativePath: string; title?: string | null }) => ChannelRow[];
}

function ChannelActionButton({ action }: { action: ChannelAction }) {
  if (action.kind === "none") return null;
  return <button className="text-button" onClick={() => action.onClick()}>{action.label}</button>;
}

function ChannelStrip({ rows }: { rows: ChannelRow[] }) {
  return <span className="channel-strip">
    {rows.map((row) => (
      <span className="channel-chip" key={row.platform} title={`${row.label}：${row.statusLabel}`}>
        <span className="channel-chip-name">{row.label}</span>
        <span className={"status-badge " + row.tone}>{row.statusLabel}</span>
        <ChannelActionButton action={row.action} />
      </span>
    ))}
  </span>;
}

export function DashboardView(props: DashboardViewProps) {
  const { projects, accounts, wechatJobs, saving, openProjectCreator, openBrief, openResearch, openOutline, openDraft, openPublishPreparation, deleteProjectDraft, externalArticles, publishedCount, openSourceArticle, channelRowsFor } = props;

  return <section className={`card${projects.length === 0 && externalArticles.length === 0 ? " dashboard-empty-card" : ""}`}>
    {projects.length === 0 && externalArticles.length === 0 ? (
      <div className="dashboard-empty"><h2>写下一个主题，开始第一篇文章</h2><p>文渡会创建草稿，并结合账号定位辅助整理方向、提纲和正文。</p>{publishedCount > 0 && <p className="hint compact-hint">你已完成全平台发布的 {publishedCount} 篇文章都在「内容库」，可去那里查阅或重新发布。</p>}<button onClick={openProjectCreator}>＋ 新建文章</button></div>
    ) : (
      <>
        {projects.length > 0 && <ul className="project-list">{projects.map((project) => {
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
        })}</ul>}
        {externalArticles.length > 0 && (
          <div className="external-articles">
            <h2 className="external-articles-heading">外部文章</h2>
            <ul className="project-list">{externalArticles.map((item) => (
              <li key={item.relativePath}>
                <span><button className="article-title-button" onClick={() => void openSourceArticle(item.relativePath)}>{item.title ?? "未命名文章"}</button></span>
                <div className="dashboard-channel-row"><ChannelStrip rows={channelRowsFor(item)} /></div>
              </li>
            ))}</ul>
          </div>
        )}
      </>
    )}
  </section>;
}
