import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { bestWechatJob } from "../publish-labels";
import { platformName } from "../api";
import { Pagination } from "../components/Pagination";
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
  onBatchArchive?: (relativePaths: string[]) => Promise<void> | void;
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
  if (row.action.kind === "generate") return null;
  const glyph = row.statusLabel === "已发布" ? "✓" : row.statusLabel === "已冻结" ? "冻" : /草稿|待发布/.test(row.statusLabel) ? "稿" : /处理中|确认中/.test(row.statusLabel) ? "⏳" : /失败|取消/.test(row.statusLabel) ? "✕" : "○";
  return <span className={`status-icon status-${row.tone}`} aria-label={`${row.label}：${row.statusLabel}`} title={`${row.label}：${row.statusLabel}`}>{glyph}</span>;
}

function ChannelActionIcon({ action }: { action: ChannelAction }) {
  if (action.kind === "none") return null;
  const glyph = action.kind === "generate" ? "＋" : "✎";
  const title = action.kind === "generate" ? "新建渠道稿" : "编辑/继续";
  return <button className="channel-action-icon" onClick={() => action.onClick()} aria-label={title} title={title}>{glyph}</button>;
}

function ChannelStrip({ rows }: { rows: ChannelRow[] }) {
  return <span className="channel-strip">
    {rows.map((row) => (
      <span className="channel-chip" key={row.platform}>
        <PlatformIcon platform={row.platform} />
        <StatusIcon row={row} />
        <ChannelActionIcon action={row.action} />
      </span>
    ))}
  </span>;
}

function ProjectRow({
  project, accounts, wechatJobs, saving, openBrief, openResearch, openOutline, openDraft, openPublishPreparation, deleteProjectDraft, channelRowsFor, selected, onToggle
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
  selected: boolean;
  onToggle: () => void;
}) {
  const job = bestWechatJob(wechatJobs, (item) => item.projectId === project.id || item.sourceRelativePath === project.sourceRelativePath || item.title === project.topic);
  const nextText = job?.status === "published" ? "微信公众号已确认发布完成" : job?.status === "cancelled" ? "发布任务已人工取消，可重新设置后再发布" : job?.status === "submitted" ? "已提交微信，正在等待最终回执" : job?.status === "draft_ready" ? "已同步微信草稿箱，等待预览和发布" : project.draftReady ? "正文已保存，可继续编辑或准备发布" : project.outlineReady ? "提纲已确认，下一步生成正文" : project.researchReady ? "资料已补充，下一步生成提纲" : project.briefReady ? "创作方向已整理，下一步联网补研" : "下一步整理创作方向和资料";
  const action = project.draftReady || project.outlineReady ? () => void openDraft(project) : project.researchReady ? () => void openOutline(project) : project.briefReady ? () => void openResearch(project, true) : () => void openBrief(project);
  const label = project.draftReady ? "打开正文" : project.outlineReady ? "起草正文" : project.researchReady ? "生成提纲" : project.briefReady ? "联网补研" : "整理创作方向";
  const account = project.targetAccountId ? accounts.find((item) => item.id === project.targetAccountId) : undefined;
  const canPrepare = !job || job.status === "failed" || job.status === "cancelled";
  const canEditBrief = project.briefReady && !project.outlineReady && !project.draftReady;
  const channelRows = channelRowsFor({ relativePath: project.sourceRelativePath ?? "", title: project.topic });
  const archivablePath = project.sourceRelativePath;
  return <li key={project.id}>
    <span className="dashboard-row-primary">
      <span className="dashboard-row-title-block">
        <span className="dashboard-row-title-line">
          {archivablePath && <input type="checkbox" className="dashboard-row-checkbox" checked={selected} onChange={onToggle} aria-label="选择此文章" />}
          {project.draftReady ? <button className="article-title-button" onClick={() => void openDraft(project)}>{project.topic}</button> : <strong>{project.topic}</strong>}
        </span>
        <small>{nextText}</small>
      </span>
      {channelRows.length > 0 && <ChannelStrip rows={channelRows} />}
    </span>
    <span className="account-actions">
      <span className="account-badge">{account ? `${platformName(account.platform)} · ${account.displayName}` : "未选发布账号"}</span>
      {canEditBrief && <button className="secondary-button" onClick={() => void openBrief(project)}>编辑创作方向</button>}
      {project.researchReady && <button className="secondary-button" onClick={() => void openResearch(project)}>查看资料</button>}
      {project.outlineReady && <button className="secondary-button" onClick={() => void openOutline(project)}>{job?.status === "published" ? "查看提纲" : "编辑提纲"}</button>}
      {!project.draftReady && <button onClick={action}>{label}</button>}
      {project.draftReady && canPrepare && <button className="secondary-button" onClick={() => openPublishPreparation(project)}>准备发布</button>}
      <button className="text-button danger-text" onClick={() => void deleteProjectDraft(project)} disabled={saving}>{job ? "删除本地文章" : "删除草稿"}</button>
    </span>
  </li>;
}

export function DashboardView(props: DashboardViewProps) {
  const { items, totalItems, accounts, wechatJobs, saving, openProjectCreator, openBrief, openResearch, openOutline, openDraft, openPublishPreparation, deleteProjectDraft, openSourceArticle, channelRowsFor, onBatchArchive, page, totalPages, pageSize, setPage, setPageSize, PAGE_SIZE_OPTIONS } = props;
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [archiving, setArchiving] = useState(false);

  const selectablePaths = useMemo(() => new Set(items.map((item) => item.relativePath).filter((path): path is string => !!path)), [items]);

  const allPageSelected = selectablePaths.size > 0 && [...selectablePaths].every((path) => selectedPaths.has(path));

  const togglePath = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const togglePage = () => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const path of selectablePaths) next.delete(path);
      } else {
        for (const path of selectablePaths) next.add(path);
      }
      return next;
    });
  };

  const handleBatchArchive = async () => {
    if (!onBatchArchive || selectedPaths.size === 0) return;
    setArchiving(true);
    try {
      await onBatchArchive([...selectedPaths]);
      setSelectedPaths(new Set());
    } finally {
      setArchiving(false);
    }
  };

  return <section className={`card${items.length === 0 ? " dashboard-empty-card" : ""}`}>
    {items.length === 0 ? (
      <div className="dashboard-empty"><h2>写下一个主题，开始第一篇文章</h2><p>文渡会创建草稿，并结合账号定位辅助整理方向、提纲和正文。</p><button onClick={openProjectCreator}>＋ 新建文章</button></div>
    ) : (
      <>
        {onBatchArchive && selectablePaths.size > 0 && (
          <div className="dashboard-batch-bar">
            <label className="dashboard-batch-select-all">
              <input type="checkbox" checked={allPageSelected} onChange={togglePage} />
              <span>全选本页</span>
            </label>
            <span className="dashboard-batch-count">已选 {selectedPaths.size} 篇</span>
            <button className="secondary-button" onClick={() => void handleBatchArchive()} disabled={archiving || selectedPaths.size === 0}>
              {archiving ? "归档中…" : "批量归档"}
            </button>
          </div>
        )}
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
            selected={!!item.relativePath && selectedPaths.has(item.relativePath)}
            onToggle={() => item.relativePath && togglePath(item.relativePath)}
          />
        ) : (
          <li key={item.relativePath}>
            <span className="dashboard-row-primary">
              <span className="dashboard-row-title-block">
                <span className="dashboard-row-title-line">
                  <input type="checkbox" className="dashboard-row-checkbox" checked={selectedPaths.has(item.relativePath)} onChange={() => togglePath(item.relativePath)} aria-label="选择此文章" />
                  <button className="article-title-button" onClick={() => void openSourceArticle(item.relativePath)}>{item.title ?? "未命名文章"}</button>
                </span>
              </span>
              <ChannelStrip rows={channelRowsFor(item)} />
            </span>
          </li>
        ))}</ul>
        <Pagination
          page={page}
          totalPages={totalPages}
          pageSize={pageSize}
          totalItems={totalItems}
          setPage={setPage}
          setPageSize={setPageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
        />
      </>
    )}
  </section>;
}
