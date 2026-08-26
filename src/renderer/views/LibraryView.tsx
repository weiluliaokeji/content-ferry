import type { Dispatch, SetStateAction } from "react";
import type { ChannelRow } from "../types";
import type { ContentSourcePreview } from "../types";
import { platformName } from "../api";

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
  archiveArticlesBefore: (cutoff: string) => Promise<number>;
}

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

function ChannelStrip({ rows }: { rows: ChannelRow[] }) {
  return <span className="channel-strip">
    {rows.map((row) => (
      <span className="channel-chip" key={row.platform}>
        <PlatformIcon platform={row.platform} />
        <StatusIcon row={row} />
      </span>
    ))}
  </span>;
}

export function LibraryView(props: LibraryViewProps) {
  const {
    sourcePreview, libraryPageItems, libraryPageSize, setLibraryPageSize, libraryTotalPages,
    librarySafePage, setLibraryPage,
    PAGE_SIZE_OPTIONS, archivedCount, openSource, openSourceArticle, channelRowsFor, archiveArticlesBefore,
  } = props;

  const handleArchiveBefore = async () => {
    if (!window.confirm("将把 2026-08-11 之前创建的所有文章标记为已归档。归档后的文章只会在「归档库」显示，工作台不再展示。\n\n此操作会修改 VitePress 源文件的 front matter，是否继续？")) return;
    const count = await archiveArticlesBefore("2026-08-11 00:00:00");
    if (count > 0) alert(`已归档 ${count} 篇文章。`);
  };

  return <section className="card">
    <div className="section-heading"><div><h2>VitePress 归档库</h2><p className="hint compact-hint">已归档的文章只供查阅，不再出现在工作台。可通过「重新发布」在工作台重新打开发布流程。</p></div><button onClick={() => void openSource()}>配置并扫描</button></div>
    {sourcePreview && (libraryPageItems.length === 0 ? (
      <div className="empty-guidance"><strong>还没有归档文章</strong><p>在工作台完成全平台发布后，文章会自动归档到这里；也可以一次性归档历史文章。</p><button className="secondary-button" onClick={() => void handleArchiveBefore()}>归档 2026-08-11 之前的文章</button></div>
    ) : (
      <>
        <p className="library-summary">已连接 {sourcePreview.rootPath}，已归档 {archivedCount} 篇文章{libraryTotalPages > 1 ? ` · 第 ${librarySafePage} / ${libraryTotalPages} 页（每页 ${libraryPageSize} 篇）` : ""}。</p>
        <div className="library-actions-bar"><button className="secondary-button" onClick={() => void handleArchiveBefore()}>归档 2026-08-11 之前的文章</button></div>
        <ul className="content-library-list">
          {libraryPageItems.map((item) => {
            const rows = channelRowsFor(item);
            return (
              <li key={item.relativePath}>
                <span className="article-primary">
                  <button className="article-title-button" onClick={() => void openSourceArticle(item.relativePath)}>{item.title ?? "未命名文章"}</button>
                </span>
                <span className="channel-strip">
                  <ChannelStrip rows={rows} />
                  <span className="channel-actions-wrap">
                    <button className="secondary-button" onClick={() => void openSourceArticle(item.relativePath, "settings")}>重新发布</button>
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        {libraryTotalPages > 1 && <div className="library-pagination"><label className="pagination-size-label">每页<select className="pagination-size" value={libraryPageSize} onChange={(event) => { setLibraryPage(1); setLibraryPageSize(Number(event.target.value)); }}>{PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} 条</option>)}</select></label>{libraryTotalPages > 1 && <><button className="secondary-button" disabled={librarySafePage <= 1} onClick={() => { setLibraryPage((page) => Math.max(1, page - 1)); }}>上一页</button><span className="library-pagination-info">{librarySafePage} / {libraryTotalPages}</span><button className="secondary-button" disabled={librarySafePage >= libraryTotalPages} onClick={() => { setLibraryPage((page) => Math.min(libraryTotalPages, page + 1)); }}>下一页</button></>}</div>}
      </>
    ))}
  </section>;
}
