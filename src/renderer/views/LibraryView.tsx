import type { Dispatch, SetStateAction } from "react";
import type { ChannelRow } from "../types";
import type { ContentSourcePreview } from "../types";

export interface LibraryViewProps {
  sourcePreview: ContentSourcePreview | undefined;
  libraryPageItems: ContentSourcePreview["items"];
  libraryPageSize: number;
  setLibraryPageSize: Dispatch<SetStateAction<number>>;
  libraryTotalPages: number;
  librarySafePage: number;
  setLibraryPage: Dispatch<SetStateAction<number>>;
  expandedLibraryActions: string | null;
  setExpandedLibraryActions: Dispatch<SetStateAction<string | null>>;
  PAGE_SIZE_OPTIONS: number[];
  openSource: () => void;
  openSourceArticle: (relativePath: string, panel?: "assistant" | "preview" | "settings", showError?: boolean) => Promise<boolean> | void;
  channelRowsFor: (item: ContentSourcePreview["items"][number]) => ChannelRow[];
}

export function LibraryView(props: LibraryViewProps) {
  const {
    sourcePreview, libraryPageItems, libraryPageSize, setLibraryPageSize, libraryTotalPages,
    librarySafePage, setLibraryPage, expandedLibraryActions, setExpandedLibraryActions,
    PAGE_SIZE_OPTIONS, openSource, openSourceArticle, channelRowsFor,
  } = props;

  return <section className="card">
    <div className="section-heading"><div><h2>VitePress 文章库</h2><p className="hint compact-hint">这里的 Markdown 文件是正式内容源，可同时用 Obsidian 编辑，也可以发布到已接入的平台。</p></div><button onClick={() => void openSource()}>配置并扫描</button></div>
    {sourcePreview && <><p className="library-summary">已连接 {sourcePreview.rootPath}，发现 {sourcePreview.articleCount} 篇文章{libraryTotalPages > 1 ? ` · 第 ${librarySafePage} / ${libraryTotalPages} 页（每页 ${libraryPageSize} 篇）` : ""}。</p><ul className="content-library-list">
      {libraryPageItems.map((item) => {
        const rows = channelRowsFor(item);
        const actionableRows = rows.filter((row) => row.action.kind !== "none");
        return (
          <li key={item.relativePath}>
            <span className="article-primary">
              <button className="article-title-button" onClick={() => void openSourceArticle(item.relativePath)}>{item.title ?? "未命名文章"}</button>
            </span>
            <span className="channel-strip">
              {rows.map((row) => (
                <span className="channel-chip" key={row.platform} title={`${row.label}：${row.statusLabel}`}>
                  <span className="channel-chip-name">{row.label}</span>
                  <span className={"status-badge " + row.tone}>{row.statusLabel}</span>
                </span>
              ))}
              {actionableRows.length > 0 && (
              <span className="channel-actions-wrap">
                <button className={"secondary-button channel-actions-toggle" + (expandedLibraryActions === item.relativePath ? " active" : "")} onClick={() => setExpandedLibraryActions(expandedLibraryActions === item.relativePath ? null : item.relativePath)}>{expandedLibraryActions === item.relativePath ? "收起" : "操作"}</button>
                {expandedLibraryActions === item.relativePath && (
                  <span className="channel-actions-popover">
                    {actionableRows.map((row) => {
                      const action = row.action;
                      if (action.kind === "none") return null;
                      return <button key={row.platform} className={action.kind === "continue" ? "secondary-button" : "text-button"} onClick={() => { setExpandedLibraryActions(null); action.onClick(); }}>{action.label}</button>;
                    })}
                  </span>
                )}
              </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
    {libraryTotalPages > 1 && <div className="library-pagination"><label className="pagination-size-label">每页<select className="pagination-size" value={libraryPageSize} onChange={(event) => { setLibraryPage(1); setLibraryPageSize(Number(event.target.value)); setExpandedLibraryActions(null); }}>{PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} 条</option>)}</select></label>{libraryTotalPages > 1 && <><button className="secondary-button" disabled={librarySafePage <= 1} onClick={() => { setLibraryPage((page) => Math.max(1, page - 1)); setExpandedLibraryActions(null); }}>上一页</button><span className="library-pagination-info">{librarySafePage} / {libraryTotalPages}</span><button className="secondary-button" disabled={librarySafePage >= libraryTotalPages} onClick={() => { setLibraryPage((page) => Math.min(libraryTotalPages, page + 1)); setExpandedLibraryActions(null); }}>下一页</button></>}</div>}
    </>}
  </section>;
}
