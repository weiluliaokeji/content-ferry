import { platformName } from "../api";
import { request } from "../api";
import { csdnJobLabel, cnblogsJobLabel, juejinJobLabel, wechatJobLabel, fiftyoneCtoJobLabel, publishRecordBadge } from "../publish-labels";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { Pagination } from "../components/Pagination";
import { Modal } from "../components/Modal";
import type { PublishEntry } from "../app-helpers";
import type {
  CnblogsChannelDraft, CnblogsPublishJob, CsdnChannelDraft, CsdnPublishJob,
  FiftyoneCtoChannelDraft, FiftyoneCtoPublishJob, JuejinChannelDraft, JuejinPublishJob, MediaAccount, PublishLifecycleEvent, PublishLifecycleStatus, WechatPublishJob,
} from "../types";

const lifecycleStatusLabels: Record<PublishLifecycleStatus, string> = {
  queued: "排队中",
  preparing: "准备中",
  waiting_user: "等待用户操作",
  ready: "平台草稿已就绪",
  submitting: "提交中",
  published: "已发布",
  needs_credentials: "待补凭据",
  failed: "失败",
  needs_manual_reconciliation: "待人工核对",
  cancelled: "已取消"
};

function lifecycleStatusLabel(status: PublishLifecycleStatus | ""): string {
  return status ? lifecycleStatusLabels[status] : "创建任务";
}

function PublishLifecycleHistory({ jobId, platform, title }: { jobId: string; platform: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<PublishLifecycleEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError("");
    void request<{ events: PublishLifecycleEvent[] }>(`/publish-lifecycle/jobs/${jobId}/events`)
      .then((payload) => { if (active) setEvents(payload.events); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "无法读取发布状态轨迹。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [jobId, open]);

  return <>
    <button type="button" className="text-button" onClick={() => setOpen(true)}>状态轨迹</button>
    {open && <Modal title="发布状态轨迹" eyebrow={`${platform} · ${title}`} onClose={() => setOpen(false)} disabled={loading}>
      {loading && <p className="hint">正在读取状态轨迹…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && events.length === 0 && <p className="hint">暂时没有可显示的状态事件。</p>}
      {!loading && !error && events.length > 0 && <ol className="publish-lifecycle-events">
        {events.map((event) => <li key={event.id}>
          <div><strong>{lifecycleStatusLabel(event.newStatus)}</strong><small>{new Date(event.createdAt).toLocaleString()} · {event.source === "manual" ? "人工" : event.source === "platform" ? "平台回执" : event.source === "legacy_sync" ? "兼容同步" : "系统"}</small></div>
          <p>{event.previousStatus ? `${lifecycleStatusLabel(event.previousStatus)} → ${lifecycleStatusLabel(event.newStatus)}` : `创建任务 → ${lifecycleStatusLabel(event.newStatus)}`}</p>
          <small>{event.reason}</small>
        </li>)}
      </ol>}
    </Modal>}
  </>;
}

export interface PublishViewProps {
  wechatJobs: WechatPublishJob[];
  csdnJobs: CsdnPublishJob[];
  cnblogsJobs: CnblogsPublishJob[];
  juejinJobs: JuejinPublishJob[];
  fiftyoneCtoJobs: FiftyoneCtoPublishJob[];
  accounts: MediaAccount[];
  pendingPageItems: PublishEntry[];
  pendingTotalItems: number;
  pendingTotalPages: number;
  pendingSafePage: number;
  setPublishPendingPage: Dispatch<SetStateAction<number>>;
  publishPendingPageSize: number;
  setPublishPendingPageSize: Dispatch<SetStateAction<number>>;
  completedPageItems: PublishEntry[];
  completedTotalItems: number;
  completedTotalPages: number;
  completedSafePage: number;
  setPublishCompletedPage: Dispatch<SetStateAction<number>>;
  publishCompletedPageSize: number;
  setPublishCompletedPageSize: Dispatch<SetStateAction<number>>;
  PAGE_SIZE_OPTIONS: number[];
  saving: boolean;
  wechatJobsRefreshedAt: Date | undefined;
  wechatJobsRefreshing: boolean;
  csdnDraftSaving: boolean;
  cnblogsDraftSaving: boolean;
  juejinDraftSaving: boolean;
  fiftyoneCtoDraftSaving: boolean;
  csdnDrafts: CsdnChannelDraft[];
  cnblogsDrafts: CnblogsChannelDraft[];
  juejinDrafts: JuejinChannelDraft[];
  fiftyoneCtoDrafts: FiftyoneCtoChannelDraft[];
  setActiveView: Dispatch<SetStateAction<"dashboard" | "library" | "publish" | "skills" | "accounts" | "logs" | "help">>;
  refreshWechatStatus: () => Promise<void> | void;
  startWechatBrowserAssist: (job: WechatPublishJob) => Promise<void> | void;
  openWechatDraftBox: () => Promise<void> | void;
  submitWechatJob: (job: WechatPublishJob, mode: "publish" | "mass") => Promise<void> | void;
  openWechatStatusCorrection: (job: WechatPublishJob) => void;
  retryWechatJob: (job: WechatPublishJob) => Promise<void> | void;
  startCsdnBrowserAssist: (jobId: string) => Promise<void> | void;
  openCsdnStatusCorrection: (job: CsdnPublishJob) => void;
  confirmCsdnPublish: (jobId: string) => Promise<void> | void;
  csdnJobCanStart: (job: CsdnPublishJob) => boolean;
  csdnJobCanCorrect: (job: CsdnPublishJob) => boolean;
  confirmCnblogsPublish: (jobId: string) => Promise<void> | void;
  openCnblogsStatusCorrection: (job: CnblogsPublishJob) => void;
  openCnblogsCredentialEntry: (accountId: string) => Promise<void> | void;
  openExistingCnblogsDraft: (choice: { draft: CnblogsChannelDraft; job?: CnblogsPublishJob }) => void;
  confirmJuejinPublish: (jobId: string) => Promise<void> | void;
  openJuejinStatusCorrection: (job: JuejinPublishJob) => void;
  openJuejinCredentialEntry: (accountId: string) => Promise<void> | void;
  openExistingJuejinDraft: (choice: { draft: JuejinChannelDraft; job?: JuejinPublishJob }) => void;
  confirmFiftyoneCtoPublish: (jobId: string) => Promise<void> | void;
  openFiftyoneCtoStatusCorrection: (job: FiftyoneCtoPublishJob) => void;
  openFiftyoneCtoCredentialEntry: (accountId: string) => Promise<void> | void;
  openExistingFiftyoneCtoDraft: (choice: { draft: FiftyoneCtoChannelDraft; job?: FiftyoneCtoPublishJob }) => void;
}

export function PublishView(props: PublishViewProps) {
  const {
    wechatJobs, csdnJobs, cnblogsJobs, juejinJobs, fiftyoneCtoJobs, accounts, pendingPageItems, pendingTotalItems, pendingTotalPages,
    pendingSafePage, setPublishPendingPage, publishPendingPageSize, setPublishPendingPageSize,
    completedPageItems, completedTotalItems, completedTotalPages, completedSafePage, setPublishCompletedPage,
    publishCompletedPageSize, setPublishCompletedPageSize, PAGE_SIZE_OPTIONS, saving,
    wechatJobsRefreshedAt, wechatJobsRefreshing, csdnDraftSaving, cnblogsDraftSaving, juejinDraftSaving, fiftyoneCtoDraftSaving,
    csdnDrafts, cnblogsDrafts, juejinDrafts, fiftyoneCtoDrafts, setActiveView, refreshWechatStatus,
    startWechatBrowserAssist, openWechatDraftBox, submitWechatJob, openWechatStatusCorrection,
    retryWechatJob, startCsdnBrowserAssist, openCsdnStatusCorrection, confirmCsdnPublish,
    csdnJobCanStart, csdnJobCanCorrect, confirmCnblogsPublish, openCnblogsStatusCorrection,
    openCnblogsCredentialEntry, openExistingCnblogsDraft, confirmJuejinPublish,
    openJuejinStatusCorrection, openJuejinCredentialEntry, openExistingJuejinDraft,
    confirmFiftyoneCtoPublish, openFiftyoneCtoStatusCorrection, openFiftyoneCtoCredentialEntry, openExistingFiftyoneCtoDraft,
  } = props;

  return <>
    {wechatJobs.length === 0 && csdnJobs.length === 0 && cnblogsJobs.length === 0 && juejinJobs.length === 0 && fiftyoneCtoJobs.length === 0 ? <section className="card"><div className="empty-guidance"><strong>还没有发布任务</strong><p>请先在工作台选择文章并发起发布。</p><button onClick={() => setActiveView("dashboard")}>前往工作台</button></div></section> : <>
      {pendingPageItems.length > 0 && <section className="card">
        <div className="section-heading"><h2>待处理</h2></div>
        <ul className="publish-job-list">{pendingPageItems.map((entry) => {
          if (entry.kind === "wechat") {
            const job = entry.job;
            const account = accounts.find((item) => item.id === job.accountId);
            return <li key={job.id}><span><strong>{job.title}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{wechatJobLabel(job)} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusNote && <small className="hint compact-hint">{job.statusNote}</small>}{job.errorMessage && <em className="error">{job.errorMessage}</em>}</span><span className="account-actions">{job.status === "draft_ready" && <><button onClick={() => void startWechatBrowserAssist(job)} disabled={saving}>在微信后台完善并发布</button><button className="secondary-button" onClick={() => void openWechatDraftBox()} disabled={saving}>微信草稿箱</button><details className="publish-more-actions"><summary>更多操作</summary><button className="text-button" onClick={() => void submitWechatJob(job, "publish")} disabled={saving}>接口普通发布</button><button className="text-button" onClick={() => void submitWechatJob(job, "mass")} disabled={saving}>接口群发所有关注者</button></details></>}{job.status === "browser_editing" && <><span className="status-badge">请在微信编辑器中确认发布</span><button onClick={() => openWechatStatusCorrection(job)}>确认结果</button><button className="secondary-button" onClick={() => void startWechatBrowserAssist(job)} disabled={saving}>打开微信核对发布</button></>}{job.status === "submitted" && <><span className="status-badge">等待微信回执</span><button className="text-button" onClick={() => openWechatStatusCorrection(job)}>校正状态</button></>}{job.status === "failed" && <><button className="secondary-button" onClick={() => void retryWechatJob(job)}>重新设置并同步</button><button className="text-button" onClick={() => openWechatStatusCorrection(job)}>校正状态</button></>}</span></li>;
          }
          if (entry.kind === "csdn") {
            const job = entry.job;
            const account = accounts.find((item) => item.id === job.accountId);
            const draft = csdnDrafts.find((item) => item.id === job.channelDraftId);
            return <li key={job.id}><span><strong>{draft?.title ?? "CSDN 渠道稿"}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{csdnJobLabel(job)} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusNote && <small className="hint compact-hint">{job.statusNote}</small>}{job.remoteUrl && <small><a href={job.remoteUrl} target="_blank" rel="noreferrer">查看已发布文章</a></small>}{job.errorMessage && <em className="error">{job.errorMessage}</em>}</span><span className="account-actions">
              {job.status === "ready_for_final_confirmation" && <span className="status-badge">请在 CSDN 编辑器中确认发布</span>}
              {job.status === "needs_user" && <span className="status-badge">内容未自动填充完整，请在 CSDN 编辑器中补齐</span>}
              {(job.status === "ready_for_final_confirmation" || job.status === "needs_user") && <>
                <button className="secondary-button" onClick={() => void startCsdnBrowserAssist(job.id)} disabled={csdnDraftSaving}>{job.status === "needs_user" ? "打开 CSDN 补齐内容" : "打开 CSDN 核对发布"}</button>
                <button onClick={() => openCsdnStatusCorrection(job)}>确认结果</button>
                <details className="publish-more-actions"><summary>更多操作</summary><button className="text-button" onClick={() => void confirmCsdnPublish(job.id)} disabled={csdnDraftSaving}>自动点击发布并读取链接</button></details>
              </>}
              {job.status !== "ready_for_final_confirmation" && job.status !== "needs_user" && csdnJobCanStart(job) && <button onClick={() => void startCsdnBrowserAssist(job.id)} disabled={csdnDraftSaving}>在浏览器中完成发布</button>}
              {job.status === "submitting" && <span className="status-badge">正在读取回执</span>}
              {csdnJobCanCorrect(job) && job.status !== "ready_for_final_confirmation" && job.status !== "needs_user" && <button className="text-button" onClick={() => openCsdnStatusCorrection(job)} disabled={csdnDraftSaving}>校正状态</button>}
            </span></li>;
          }
          if (entry.kind === "cnblogs") {
            const job = entry.job;
            const account = accounts.find((item) => item.id === job.accountId);
            const draft = cnblogsDrafts.find((item) => item.id === job.channelDraftId);
            const cnblogsLinkLabel = job.status === "draft_created" || job.status === "confirming" ? "查看博客园草稿" : "查看已发布文章";
            return <li key={job.id}><span><strong>{draft?.title ?? "博客园渠道稿"}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{cnblogsJobLabel(job)} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusNote && <small className="hint compact-hint">{job.statusNote}</small>}{job.remoteUrl && <small><a href={job.remoteUrl} target="_blank" rel="noreferrer">{cnblogsLinkLabel}</a></small>}{job.errorMessage && <em className="error">{job.errorMessage}</em>}</span><span className="account-actions">
              {job.status === "draft_creating" && <span className="status-badge">正在创建博客园草稿</span>}
              {job.status === "queued" && <span className="status-badge">排队中，等待创建博客园草稿</span>}
              {(job.status === "draft_created" || job.status === "confirming") && <>
                <button className="secondary-button" onClick={() => void confirmCnblogsPublish(job.id)} disabled={cnblogsDraftSaving}>确认公开</button>
                <button className="text-button" onClick={() => openCnblogsStatusCorrection(job)} disabled={cnblogsDraftSaving}>校正状态</button>
              </>}
              {job.status === "needs_credentials" && <>
                <button className="secondary-button" onClick={() => void openCnblogsCredentialEntry(job.accountId)}>配置博客园凭据</button>
                <button className="text-button" onClick={() => openCnblogsStatusCorrection(job)} disabled={cnblogsDraftSaving}>校正状态</button>
              </>}
              {job.status === "needs_manual_reconciliation" && <>
                <button className="secondary-button" onClick={() => openCnblogsStatusCorrection(job)} disabled={cnblogsDraftSaving}>人工校正</button>
                <button className="text-button" onClick={() => void confirmCnblogsPublish(job.id)} disabled={cnblogsDraftSaving}>重试确认公开</button>
              </>}
              {job.status === "failed" && <>
                <button className="secondary-button" onClick={() => { const draft = cnblogsDrafts.find((d) => d.id === job.channelDraftId); if (draft) openExistingCnblogsDraft({ draft, job }); }} disabled={cnblogsDraftSaving}>重新发布</button>
                <button className="text-button" onClick={() => openCnblogsStatusCorrection(job)} disabled={cnblogsDraftSaving}>校正状态</button>
              </>}
            </span></li>;
          }
          if (entry.kind === "juejin") {
            const job = entry.job;
            const account = accounts.find((item) => item.id === job.accountId);
            const draft = juejinDrafts.find((item) => item.id === job.channelDraftId);
            const juejinLinkLabel = job.status === "draft_created" || job.status === "confirming" ? "查看掘金草稿" : "查看已发布文章";
            return <li key={job.id}><span><strong>{draft?.title ?? "掘金渠道稿"}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{juejinJobLabel(job)} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusNote && <small className="hint compact-hint">{job.statusNote}</small>}{job.remoteUrl && <small><a href={job.remoteUrl} target="_blank" rel="noreferrer">{juejinLinkLabel}</a></small>}{job.errorMessage && <em className="error">{job.errorMessage}</em>}</span><span className="account-actions">
              {job.status === "draft_creating" && <span className="status-badge">正在创建掘金草稿</span>}
              {job.status === "queued" && <span className="status-badge">排队中，等待创建掘金草稿</span>}
              {(job.status === "draft_created" || job.status === "confirming") && <>
                <button className="secondary-button" onClick={() => void confirmJuejinPublish(job.id)} disabled={juejinDraftSaving}>确认公开</button>
                <button className="text-button" onClick={() => openJuejinStatusCorrection(job)} disabled={juejinDraftSaving}>校正状态</button>
              </>}
              {job.status === "needs_credentials" && <>
                <button className="secondary-button" onClick={() => void openJuejinCredentialEntry(job.accountId)}>配置掘金凭据</button>
                <button className="text-button" onClick={() => openJuejinStatusCorrection(job)} disabled={juejinDraftSaving}>校正状态</button>
              </>}
              {job.status === "needs_manual_reconciliation" && <>
                <button className="secondary-button" onClick={() => openJuejinStatusCorrection(job)} disabled={juejinDraftSaving}>人工校正</button>
                <button className="text-button" onClick={() => void confirmJuejinPublish(job.id)} disabled={juejinDraftSaving}>重试确认公开</button>
              </>}
              {job.status === "failed" && <>
                <button className="secondary-button" onClick={() => { const draft = juejinDrafts.find((d) => d.id === job.channelDraftId); if (draft) openExistingJuejinDraft({ draft, job }); }} disabled={juejinDraftSaving}>重新发布</button>
                <button className="text-button" onClick={() => openJuejinStatusCorrection(job)} disabled={juejinDraftSaving}>校正状态</button>
              </>}
            </span></li>;
          }
          const job = entry.job;
          const account = accounts.find((item) => item.id === job.accountId);
          const draft = fiftyoneCtoDrafts.find((item) => item.id === job.channelDraftId);
          return <li key={job.id}><span><strong>{draft?.title ?? "51CTO 渠道稿"}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{fiftyoneCtoJobLabel(job)} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusNote && <small className="hint compact-hint">{job.statusNote}</small>}{job.remoteUrl && <small><a href={job.remoteUrl} target="_blank" rel="noreferrer">查看已发布文章</a></small>}{job.errorMessage && <em className="error">{job.errorMessage}</em>}</span><span className="account-actions">
            {job.status === "draft_creating" && <span className="status-badge">正在发布到 51CTO</span>}
            {job.status === "queued" && <span className="status-badge">排队中，等待发布到 51CTO</span>}
            {job.status === "needs_credentials" && <>
              <button className="secondary-button" onClick={() => void openFiftyoneCtoCredentialEntry(job.accountId)}>配置 51CTO 凭据</button>
              <button className="text-button" onClick={() => openFiftyoneCtoStatusCorrection(job)} disabled={fiftyoneCtoDraftSaving}>校正状态</button>
            </>}
            {job.status === "needs_manual_reconciliation" && <>
              <button className="secondary-button" onClick={() => openFiftyoneCtoStatusCorrection(job)} disabled={fiftyoneCtoDraftSaving}>人工校正</button>
              <button className="text-button" onClick={() => void confirmFiftyoneCtoPublish(job.id)} disabled={fiftyoneCtoDraftSaving}>重试发布</button>
            </>}
            {job.status === "failed" && <>
              <button className="secondary-button" onClick={() => { const draft = fiftyoneCtoDrafts.find((d) => d.id === job.channelDraftId); if (draft) openExistingFiftyoneCtoDraft({ draft, job }); }} disabled={fiftyoneCtoDraftSaving}>重新发布</button>
              <button className="text-button" onClick={() => openFiftyoneCtoStatusCorrection(job)} disabled={fiftyoneCtoDraftSaving}>校正状态</button>
            </>}
          </span></li>;
        })}</ul>
        <Pagination
          page={pendingSafePage}
          totalPages={pendingTotalPages}
          pageSize={publishPendingPageSize}
          totalItems={pendingTotalItems}
          setPage={setPublishPendingPage}
          setPageSize={setPublishPendingPageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
        />
      </section>}
      {completedPageItems.length > 0 && <section className="card">
        <ul className="publish-job-list publish-completed-list">{completedPageItems.map((entry) => {
          if (entry.kind === "wechat") {
            const job = entry.job;
            const account = accounts.find((item) => item.id === job.accountId);
            const badge = publishRecordBadge(job);
            return <li key={job.id}><span><strong>{job.title}</strong><small className="publish-record-meta">{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{new Date(job.updatedAt).toLocaleString()}</small>{job.statusSource === "manual" && <small className="manual-status-note">人工校正：{job.statusNote}</small>}</span><span className="publish-record-actions"><PublishLifecycleHistory jobId={job.id} platform="微信公众号" title={job.title} /><span className={`status-badge ${badge.tone}`}>{badge.text}</span></span></li>;
          }
          if (entry.kind === "csdn") {
            const job = entry.job;
            const account = accounts.find((item) => item.id === job.accountId);
            const draft = csdnDrafts.find((item) => item.id === job.channelDraftId);
            const badge = publishRecordBadge(job);
            return <li key={job.id}><span><strong>{draft?.title ?? "CSDN 渠道稿"}</strong><small className="publish-record-meta">{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{new Date(job.updatedAt).toLocaleString()}</small>{job.statusSource === "manual" && job.statusNote && <small className="manual-status-note">人工核实：{job.statusNote}</small>}{job.remoteUrl && <small className="publish-record-link"><a href={job.remoteUrl} target="_blank" rel="noreferrer">查看已发布文章</a></small>}</span><span className="publish-record-actions"><PublishLifecycleHistory jobId={job.id} platform="CSDN" title={draft?.title ?? "CSDN 渠道稿"} /><span className={`status-badge ${badge.tone}`}>{badge.text}</span></span></li>;
          }
          if (entry.kind === "cnblogs") {
            const job = entry.job;
            const account = accounts.find((item) => item.id === job.accountId);
            const draft = cnblogsDrafts.find((item) => item.id === job.channelDraftId);
            const badge = publishRecordBadge(job);
            return <li key={job.id}><span><strong>{draft?.title ?? "博客园渠道稿"}</strong><small className="publish-record-meta">{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{new Date(job.updatedAt).toLocaleString()}</small>{job.statusSource === "manual" && job.statusNote && <small className="manual-status-note">人工核实：{job.statusNote}</small>}{job.remoteUrl && <small className="publish-record-link"><a href={job.remoteUrl} target="_blank" rel="noreferrer">查看已发布文章</a></small>}</span><span className="publish-record-actions"><PublishLifecycleHistory jobId={job.id} platform="博客园" title={draft?.title ?? "博客园渠道稿"} /><span className={`status-badge ${badge.tone}`}>{badge.text}</span></span></li>;
          }
          if (entry.kind === "juejin") {
            const job = entry.job;
            const account = accounts.find((item) => item.id === job.accountId);
            const draft = juejinDrafts.find((item) => item.id === job.channelDraftId);
            const badge = publishRecordBadge(job);
            return <li key={job.id}><span><strong>{draft?.title ?? "掘金渠道稿"}</strong><small className="publish-record-meta">{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{new Date(job.updatedAt).toLocaleString()}</small>{job.statusSource === "manual" && job.statusNote && <small className="manual-status-note">人工核实：{job.statusNote}</small>}{job.remoteUrl && <small className="publish-record-link"><a href={job.remoteUrl} target="_blank" rel="noreferrer">查看已发布文章</a></small>}</span><span className="publish-record-actions"><PublishLifecycleHistory jobId={job.id} platform="掘金" title={draft?.title ?? "掘金渠道稿"} /><span className={`status-badge ${badge.tone}`}>{badge.text}</span></span></li>;
          }
          const job = entry.job;
          const account = accounts.find((item) => item.id === job.accountId);
            const draft = fiftyoneCtoDrafts.find((item) => item.id === job.channelDraftId);
            const badge = publishRecordBadge(job);
            return <li key={job.id}><span><strong>{draft?.title ?? "51CTO 渠道稿"}</strong><small className="publish-record-meta">{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{new Date(job.updatedAt).toLocaleString()}</small>{job.statusSource === "manual" && job.statusNote && <small className="manual-status-note">人工核实：{job.statusNote}</small>}{job.remoteUrl && <small className="publish-record-link"><a href={job.remoteUrl} target="_blank" rel="noreferrer">查看已发布文章</a></small>}</span><span className="publish-record-actions"><PublishLifecycleHistory jobId={job.id} platform="51CTO" title={draft?.title ?? "51CTO 渠道稿"} /><span className={`status-badge ${badge.tone}`}>{badge.text}</span></span></li>;
        })}</ul>
        <Pagination
          page={completedSafePage}
          totalPages={completedTotalPages}
          pageSize={publishCompletedPageSize}
          totalItems={completedTotalItems}
          setPage={setPublishCompletedPage}
          setPageSize={setPublishCompletedPageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
        />
      </section>}
    </>}
  </>;
}
