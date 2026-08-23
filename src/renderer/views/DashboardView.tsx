import { bestWechatJob, wechatJobLabel } from "../publish-labels";
import { platformName } from "../api";
import type { ContentProject, MediaAccount } from "../types";

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
}

export function DashboardView(props: DashboardViewProps) {
  const { projects, accounts, wechatJobs, saving, openProjectCreator, openBrief, openResearch, openOutline, openDraft, openPublishPreparation, deleteProjectDraft } = props;

  return <section className={`card${projects.length === 0 ? " dashboard-empty-card" : ""}`}>
    {projects.length === 0 ? (
      <div className="dashboard-empty"><h2>写下一个主题，开始第一篇文章</h2><p>文渡会创建草稿，并结合账号定位辅助整理方向、提纲和正文。</p><button onClick={openProjectCreator}>＋ 新建文章</button></div>
    ) : (
      <ul className="project-list">{projects.map((project) => {
        const job = bestWechatJob(wechatJobs, (item) => item.projectId === project.id || item.sourceRelativePath === project.sourceRelativePath || item.title === project.topic);
        const nextText = job?.status === "published" ? "微信公众号已确认发布完成" : job?.status === "cancelled" ? "发布任务已人工取消，可重新设置后再发布" : job?.status === "submitted" ? "已提交微信，正在等待最终回执" : job?.status === "draft_ready" ? "已同步微信草稿箱，等待预览和发布" : project.draftReady ? "正文已保存，可继续编辑或准备发布" : project.outlineReady ? "提纲已确认，下一步生成正文" : project.researchReady ? "资料已补充，下一步生成提纲" : project.briefReady ? "创作方向已整理，下一步联网补研" : "下一步整理创作方向和资料";
        const action = project.draftReady || project.outlineReady ? () => void openDraft(project) : project.researchReady ? () => void openOutline(project) : project.briefReady ? () => void openResearch(project, true) : () => void openBrief(project);
        const label = project.draftReady ? "打开正文" : project.outlineReady ? "起草正文" : project.researchReady ? "生成提纲" : project.briefReady ? "联网补研" : "整理创作方向";
        const account = project.targetAccountId ? accounts.find((item) => item.id === project.targetAccountId) : undefined;
        const canPrepare = !job || job.status === "failed" || job.status === "cancelled";
        const canEditBrief = project.briefReady && !project.outlineReady && !project.draftReady;
        return <li key={project.id}>
          <span>{project.draftReady ? <button className="article-title-button" onClick={() => void openDraft(project)}>{project.topic}</button> : <strong>{project.topic}</strong>}<small>{nextText}</small></span>
            <span className="account-actions">
            <span className="account-badge">{account ? `${platformName(account.platform)} · ${account.displayName}` : "未选发布账号"}</span>
            {canEditBrief && <button className="secondary-button" onClick={() => void openBrief(project)}>编辑创作方向</button>}
            {project.researchReady && <button className="secondary-button" onClick={() => void openResearch(project)}>查看资料</button>}
            {project.outlineReady && <button className="secondary-button" onClick={() => void openOutline(project)}>{job?.status === "published" ? "查看提纲" : "编辑提纲"}</button>}
            {!project.draftReady && <button onClick={action}>{label}</button>}
            {project.draftReady && canPrepare && <button className="secondary-button" onClick={() => openPublishPreparation(project)}>准备发布</button>}
            {job?.status === "draft_ready" && <span className="status-badge">草稿已同步</span>}
            {job?.status === "submitted" && <span className="status-badge">微信处理中</span>}
            {job?.status === "published" && <span className="status-badge success">已发布</span>}
            {job?.status === "cancelled" && <span className="status-badge warning">已取消发布</span>}
            <button className="text-button danger-text" onClick={() => void deleteProjectDraft(project)} disabled={saving}>{job ? "删除本地文章" : "删除草稿"}</button>
          </span>
        </li>;
      })}</ul>
    )}
  </section>;
}
