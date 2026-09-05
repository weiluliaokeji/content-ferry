import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChannelRow, ContentProject, ContentSourcePreview } from "../types";
import { formatLocalTimestamp } from "../app-helpers";
import { request } from "../api";
import { ChannelStrip } from "../components/ChannelStrip";
import { Pagination } from "../components/Pagination";

export interface LibraryViewProps {
  sourcePreview: ContentSourcePreview | undefined;
  libraryPageItems: ContentSourcePreview["items"];
  libraryPageSize: number;
  setLibraryPageSize: Dispatch<SetStateAction<number>>;
  libraryTotalPages: number;
  librarySafePage: number;
  setLibraryPage: Dispatch<SetStateAction<number>>;
  PAGE_SIZE_OPTIONS: number[];
  archivedCount: number;
  openSource: () => void;
  openSourceArticle: (relativePath: string, panel?: "assistant" | "preview" | "settings", showError?: boolean) => Promise<boolean> | void;
  channelRowsFor: (item: ContentSourcePreview["items"][number]) => ChannelRow[];
  openBrief: (project: ContentProject) => Promise<void> | void;
  openResearch: (project: ContentProject) => Promise<void> | void;
  openOutline: (project: ContentProject) => Promise<void> | void;
}

export function LibraryView(props: LibraryViewProps) {
  const {
    sourcePreview, libraryPageItems, libraryPageSize, setLibraryPageSize, libraryTotalPages,
    librarySafePage, setLibraryPage,
    PAGE_SIZE_OPTIONS, archivedCount, openSource, openSourceArticle, channelRowsFor,
    openBrief, openResearch, openOutline,
  } = props;

  // 展开态独占：同一时刻只有一行处于展开状态。创作档案按需懒加载，
  // 避免列表渲染时对每行都发一次反查请求。
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [dossiers, setDossiers] = useState<Record<string, ContentProject | null>>({});
  const [loadingPath, setLoadingPath] = useState<string | null>(null);

  const toggleRow = async (relativePath: string) => {
    if (expandedPath === relativePath) { setExpandedPath(null); return; }
    setExpandedPath(relativePath);
    if (relativePath in dossiers) return;
    setLoadingPath(relativePath);
    try {
      const result = await request<{ project: ContentProject | null }>(
        `/content-projects/by-source?relativePath=${encodeURIComponent(relativePath)}`
      );
      setDossiers((current) => ({ ...current, [relativePath]: result.project }));
    } catch {
      setDossiers((current) => ({ ...current, [relativePath]: null }));
    } finally {
      setLoadingPath(null);
    }
  };

  return <section className="card">
    <div className="section-heading"><div className="library-intro"><p className="hint compact-hint">已归档的文章只供查阅。点击右侧 ⋯ 可重新发布；文渡创建的文章还能查看当时的创作方向、素材与提纲。</p>{sourcePreview && <p className="hint compact-hint">已连接 {sourcePreview.rootPath}。</p>}</div><button onClick={() => void openSource()}>配置并扫描</button></div>
    {sourcePreview && (libraryPageItems.length === 0 ? (
      <div className="empty-guidance"><strong>还没有归档文章</strong><p>在工作台完成全平台发布后，文章会自动归档到这里。</p></div>
    ) : (
      <>
        <ul className="content-library-list">
          {libraryPageItems.map((item) => {
            const rows = channelRowsFor(item);
            const isExpanded = expandedPath === item.relativePath;
            const loaded = item.relativePath in dossiers;
            const project = dossiers[item.relativePath] ?? null;
            return (
              <li key={item.relativePath}>
                <span className="article-primary">
                  <span className="article-title-inline"><button className="article-title-button" onClick={() => void openSourceArticle(item.relativePath)}>{item.title ?? "未命名文章"}</button>{item.createdAt && <small className="article-created-at">{formatLocalTimestamp(item.createdAt)}</small>}</span>
                </span>
                <span className="channel-strip-wrap">
                  {/* 归档库只做状态查阅，平台操作入口在工作台（spec/05 §4.1）。 */}
                  <ChannelStrip rows={rows} />
                  <button
                    type="button"
                    className="library-row-toggle"
                    aria-expanded={isExpanded}
                    aria-label={isExpanded ? "收起操作" : "展开操作"}
                    title={isExpanded ? "收起操作" : "展开操作"}
                    onClick={() => void toggleRow(item.relativePath)}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r="1.35" fill="currentColor" /><circle cx="8" cy="8" r="1.35" fill="currentColor" /><circle cx="13" cy="8" r="1.35" fill="currentColor" /></svg>
                  </button>
                </span>
                {isExpanded && (
                  <div className="library-row-actions">
                    <button className="secondary-button" onClick={() => void openSourceArticle(item.relativePath, "settings")}>重新发布</button>
                    {loadingPath === item.relativePath && <small>正在读取创作记录…</small>}
                    {loadingPath !== item.relativePath && loaded && project && (
                      <>
                        {project.briefReady && <button className="secondary-button" onClick={() => void openBrief(project)}>查看创作方向</button>}
                        {project.researchReady && <button className="secondary-button" onClick={() => void openResearch(project)}>查看素材</button>}
                        {project.outlineReady && <button className="secondary-button" onClick={() => void openOutline(project)}>查看提纲</button>}
                        {!project.briefReady && !project.researchReady && !project.outlineReady && <small>这篇文章没有留下创作记录。</small>}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <Pagination
          page={librarySafePage}
          totalPages={libraryTotalPages}
          pageSize={libraryPageSize}
          totalItems={archivedCount}
          setPage={setLibraryPage}
          setPageSize={setLibraryPageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
        />
      </>
    ))}
  </section>;
}
