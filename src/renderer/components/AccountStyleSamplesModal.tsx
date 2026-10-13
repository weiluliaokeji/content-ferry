import { useEffect, useState } from "react";
import { request } from "../api";
import type { MediaAccount } from "../types";
import { Modal } from "./Modal";

interface AccountStyleSample {
  title: string;
  relativePath: string;
  createdAt: string;
  articleStatus: "published" | null;
  attribution: "published_record" | "author_confirmed" | "unassigned";
  attributionEvidence: string;
  selected: boolean;
}

interface AccountStyleSampleList {
  sourceConfigured: boolean;
  items: AccountStyleSample[];
  selectedPaths: string[];
  authorConfirmedPaths: string[];
  truncated: boolean;
}

interface ProfileContent { commonVoice: string; genreTraits: Array<{ genre: string; traits: string }>; visualTraits: string }
interface ProfileSource { title: string; relativePath: string }
interface ProfileVersion { id: string; versionNumber: number; profile: ProfileContent; sampleSources: ProfileSource[]; confirmedAt: string }
interface ProfileProposal { id: string; profile: ProfileContent; sampleSources: ProfileSource[]; basedOnVersionId: string | null; createdAt: string }
interface ProfileState { active: ProfileVersion | null; versions: ProfileVersion[]; pendingProposal: ProfileProposal | null }

export function AccountStyleSamplesModal({ account, onClose }: { account: MediaAccount; onClose: () => void }) {
  const [items, setItems] = useState<AccountStyleSample[]>([]);
  const [sourceConfigured, setSourceConfigured] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");
  const [appliedRange, setAppliedRange] = useState({ createdFrom: "", createdTo: "" });
  const [confirmedPaths, setConfirmedPaths] = useState<string[]>([]);
  const [savedSelectedPaths, setSavedSelectedPaths] = useState<string[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [profileState, setProfileState] = useState<ProfileState>({ active: null, versions: [], pendingProposal: null });
  const [candidate, setCandidate] = useState<ProfileProposal | null>(null);
  const [activeEdit, setActiveEdit] = useState<ProfileContent | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => { void loadSamples(appliedRange); void loadProfile(); }, [account.id, appliedRange]);

  const loadProfile = async () => {
    try {
      const state = await request<ProfileState>(`/media-accounts/${account.id}/style-profile`);
      setProfileState(state);
      setCandidate(state.pendingProposal);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取风格档案。");
    }
  };

  const loadSamples = async (range: { createdFrom: string; createdTo: string }) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (range.createdFrom) params.set("createdFrom", range.createdFrom);
      if (range.createdTo) params.set("createdTo", range.createdTo);
      const result = await request<AccountStyleSampleList>(`/media-accounts/${account.id}/style-samples${params.size ? `?${params}` : ""}`);
      setItems(result.items);
      setSourceConfigured(result.sourceConfigured);
      setTruncated(result.truncated);
      setSelectedPaths(result.selectedPaths);
      setSavedSelectedPaths(result.selectedPaths);
      setConfirmedPaths(result.authorConfirmedPaths);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取文章样本。");
    } finally {
      setLoading(false);
    }
  };

  const toggleSample = (item: AccountStyleSample) => {
    setNotice("");
    setItems((current) => current.map((candidate) => candidate.relativePath === item.relativePath
      ? { ...candidate, selected: !candidate.selected }
      : candidate));
    setSelectedPaths((current) => item.selected
      ? current.filter((value) => value !== item.relativePath)
      : current.includes(item.relativePath) ? current : [...current, item.relativePath]);
    if (item.attribution === "unassigned") {
      setConfirmedPaths((current) => item.selected
        ? current.filter((value) => value !== item.relativePath)
        : [...current, item.relativePath]);
    }
  };

  const saveSelection = async () => {
    setSaving(true);
    setError("");
    try {
      const result = await request<AccountStyleSampleList>(`/media-accounts/${account.id}/style-samples`, {
        method: "PUT",
        body: JSON.stringify({
          selectedPaths,
          authorConfirmedPaths: confirmedPaths.filter((articlePath) => selectedPaths.includes(articlePath))
        })
      });
      setItems(result.items);
      setSelectedPaths(result.selectedPaths);
      setSavedSelectedPaths(result.selectedPaths);
      setConfirmedPaths(result.authorConfirmedPaths);
      setNotice("代表样本已保存。接下来可以基于这些文章提炼风格档案。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存代表样本失败。");
    } finally {
      setSaving(false);
    }
  };

  const createProposal = async () => {
    setExtracting(true);
    setError("");
    try {
      const proposal = await request<ProfileProposal>(`/media-accounts/${account.id}/style-profile/proposals`, { method: "POST", body: "{}" });
      setCandidate(proposal);
      setNotice("风格提炼已完成。检查样本来源与内容，修改后再确认保存。");
      await loadProfile();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "风格提炼失败。");
    } finally {
      setExtracting(false);
    }
  };

  const resolveProposal = async (confirm: boolean) => {
    if (!candidate) return;
    setSavingProfile(true);
    setError("");
    try {
      await request(`/media-accounts/${account.id}/style-profile/proposals/${candidate.id}`, {
        method: "PUT", body: JSON.stringify(candidate.profile)
      });
      await request(`/media-accounts/${account.id}/style-profile/proposals/${candidate.id}/${confirm ? "confirm" : "reject"}`, { method: "POST", body: "{}" });
      setCandidate(null);
      setNotice(confirm ? "已确认并启用新的账号风格档案版本；手动填写的写作风格未更改。" : "已拒绝本次提炼，当前启用版本未更改。");
      await loadProfile();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存风格档案失败。");
    } finally {
      setSavingProfile(false);
    }
  };

  const saveActiveEdit = async () => {
    if (!activeEdit || !profileState.active) return;
    setSavingProfile(true);
    setError("");
    try {
      await request(`/media-accounts/${account.id}/style-profile/active`, {
        method: "PUT",
        body: JSON.stringify({ basedOnVersionId: profileState.active.id, profile: activeEdit })
      });
      setActiveEdit(null);
      setNotice("手工修改已保存为新的风格档案版本；旧版本和样本来源已保留，账号手动写作风格未更改。");
      await loadProfile();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存风格档案失败。");
    } finally {
      setSavingProfile(false);
    }
  };

  const selectedSampleCount = selectedPaths.length;
  const sampleSelectionSaved = hasSavedSampleSelection(selectedPaths, savedSelectedPaths);

  return <Modal title={`代表文章样本：${account.displayName}`} eyebrow="账号写作风格" onClose={onClose} disabled={saving || savingProfile} wide>
    <div className="account-style-samples">
      <p className="hint">只把属于此账号的已完成文章作为样本。带发布记录的文章会自动标明依据；其他文章只有在你勾选确认后才会归属此账号。目录和正文内容不会用来猜测归属。</p>
      <form className="account-style-sample-search" onSubmit={(event) => { event.preventDefault(); setAppliedRange({ createdFrom, createdTo }); }}>
        <label>创建时间从<input type="date" value={createdFrom} onChange={(event) => setCreatedFrom(event.target.value)} /></label>
        <label>到<input type="date" value={createdTo} onChange={(event) => setCreatedTo(event.target.value)} /></label>
        <button type="submit" className="secondary-button" disabled={loading}>查找</button>
      </form>
      {loading ? <p className="hint">正在读取文章库…</p>
        : !sourceConfigured ? <p className="account-style-sample-empty">请先在“文章库”中设置文章目录，再挑选代表样本。</p>
          : items.length === 0 ? <p className="account-style-sample-empty">没有找到可用文章。草稿不会显示。</p>
            : <div className="account-style-sample-list">{items.map((item) => <label className="account-style-sample-row" key={item.relativePath}>
              <input type="checkbox" checked={item.selected} onChange={() => toggleSample(item)} disabled={saving} />
              <span className="account-style-sample-details">
                <strong>{item.title}</strong>
                <code>{item.relativePath}</code>
                <small>创建于 {formatCreationDate(item.createdAt)}</small>
                <small>{item.attributionEvidence}</small>
                {item.attribution === "unassigned" && <small className="account-style-sample-confirm">勾选即确认：这是该账号已完成的文章，并将其加入代表样本。</small>}
              </span>
            </label>)}</div>}
      {truncated && <p className="hint">当前结果超过 200 篇；请缩小创建时间范围，以继续查找其他文章。</p>}
      <section className="account-style-profile-workflow" aria-label="账号风格档案">
        <div className="section-heading"><div><h3>风格档案</h3><p className="hint">档案与账号定位中的手动写作风格分开保存；只有你确认后才会启用新版本。</p></div><button type="button" className="secondary-button" onClick={() => void createProposal()} disabled={extracting || savingProfile || loading || !sampleSelectionSaved || selectedSampleCount < 2 || selectedSampleCount > 12}>{extracting ? "正在分析代表文章…" : profileState.active ? "根据代表文章更新" : "提炼风格档案"}</button></div>
        {!sampleSelectionSaved ? <p className="hint">代表文章选择有未保存更改；请先点击“保存代表样本”，再提炼风格。</p> : selectedSampleCount < 2 && <p className="hint">至少保存 2 篇代表文章后，才能提炼风格档案。</p>}
        {selectedSampleCount > 12 && <p className="hint">当前选中 {selectedSampleCount} 篇；一次提炼最多使用 12 篇，请先取消部分选择。</p>}
        {!profileState.active && !candidate && <p className="account-style-sample-empty">尚未建立已确认的风格档案。请先保存至少 2 篇代表文章，再提炼风格。</p>}
        {profileState.active && <div className="account-style-profile-active"><div className="section-heading"><strong>当前启用版本 v{profileState.active.versionNumber}</strong>{!activeEdit && <button type="button" className="text-button" onClick={() => setActiveEdit({ ...profileState.active!.profile, genreTraits: profileState.active!.profile.genreTraits.map((item) => ({ ...item })) })} disabled={savingProfile}>手工编辑</button>}</div>{!activeEdit && <><p>{profileState.active.profile.commonVoice}</p>{profileState.active.profile.genreTraits.map((item) => <p key={`${item.genre}:${item.traits}`}><strong>{item.genre}：</strong>{item.traits}</p>)}{profileState.active.profile.visualTraits && <p><strong>配图习惯：</strong>{profileState.active.profile.visualTraits}</p>}<small>已确认于 {formatCreationDate(profileState.active.confirmedAt)} · 来源 {profileState.active.sampleSources.length} 篇文章</small></>}{activeEdit && <div className="account-style-profile-candidate"><p className="hint">保存会创建并启用新版本，沿用当前版本的样本来源。</p><ProfileEditor profile={activeEdit} onChange={setActiveEdit} disabled={savingProfile} /><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setActiveEdit(null)} disabled={savingProfile}>取消</button><button type="button" onClick={() => void saveActiveEdit()} disabled={savingProfile || !activeEdit.commonVoice.trim()}>{savingProfile ? "正在保存…" : `保存为 v${profileState.versions[0]?.versionNumber ? profileState.versions[0].versionNumber + 1 : profileState.active.versionNumber + 1}`}</button></div></div>}</div>}
        {candidate && <div className="account-style-profile-candidate">
          <h4>{profileState.active ? "新版本候选" : "风格档案候选"}</h4>
          {profileState.active && <p className="hint">与当前版本相比，请检查哪些特征值得保留或调整。确认前不会影响当前档案。</p>}
          {profileState.active && <div className="account-style-profile-comparison"><div><strong>当前版本 v{profileState.active.versionNumber}</strong><p>{profileState.active.profile.commonVoice}</p></div><div><strong>本次候选</strong><p>{candidate.profile.commonVoice}</p></div></div>}
          <label>账号共同风格<textarea value={candidate.profile.commonVoice} maxLength={3000} onChange={(event) => setCandidate({ ...candidate, profile: { ...candidate.profile, commonVoice: event.target.value } })} disabled={savingProfile} /></label>
          <label>正文配图习惯<textarea value={candidate.profile.visualTraits} maxLength={1500} placeholder="样本没有稳定的配图习惯时留空" onChange={(event) => setCandidate({ ...candidate, profile: { ...candidate.profile, visualTraits: event.target.value } })} disabled={savingProfile} /></label>
          <div className="account-style-profile-genres"><div className="section-heading"><h4>体裁特点</h4><button type="button" className="text-button" onClick={() => setCandidate({ ...candidate, profile: { ...candidate.profile, genreTraits: [...candidate.profile.genreTraits, { genre: "", traits: "" }] } })} disabled={savingProfile || candidate.profile.genreTraits.length >= 8}>添加体裁</button></div>
            {candidate.profile.genreTraits.map((item, index) => <div className="account-style-profile-genre" key={index}><label>体裁<input value={item.genre} onChange={(event) => updateGenre(index, { ...item, genre: event.target.value })} disabled={savingProfile} /></label><label>特点<textarea value={item.traits} onChange={(event) => updateGenre(index, { ...item, traits: event.target.value })} disabled={savingProfile} /></label><button type="button" className="text-button danger-text" onClick={() => setCandidate({ ...candidate, profile: { ...candidate.profile, genreTraits: candidate.profile.genreTraits.filter((_, itemIndex) => itemIndex !== index) } })} disabled={savingProfile}>移除</button></div>)}
          </div>
          <div><strong>提炼依据</strong><ul>{candidate.sampleSources.map((source) => <li key={source.relativePath}>{source.title} <code>{source.relativePath}</code></li>)}</ul></div>
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => void resolveProposal(false)} disabled={savingProfile}>拒绝候选</button><button type="button" onClick={() => void resolveProposal(true)} disabled={savingProfile || !candidate.profile.commonVoice.trim()}>{savingProfile ? "正在保存…" : `确认并启用 v${profileState.versions[0]?.versionNumber ? profileState.versions[0].versionNumber + 1 : 1}`}</button></div>
        </div>}
        {profileState.versions.length > 1 && <details className="account-style-profile-history"><summary>历史版本（{profileState.versions.length}）</summary>{profileState.versions.slice(1).map((version) => <div key={version.id}><strong>v{version.versionNumber} · {formatCreationDate(version.confirmedAt)}</strong><p>{version.profile.commonVoice}</p><small>来源：{version.sampleSources.map((source) => source.title).join("、")}</small></div>)}</details>}
      </section>
      {notice && <p className="success-message">{notice}</p>}
      {error && <p className="error">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving || savingProfile}>关闭</button><button type="button" onClick={() => void saveSelection()} disabled={saving || savingProfile || loading || !sourceConfigured}>{saving ? "正在保存…" : "保存代表样本"}</button></div>
    </div>
  </Modal>;

  function updateGenre(index: number, value: { genre: string; traits: string }) {
    setCandidate((current) => current ? { ...current, profile: { ...current.profile, genreTraits: current.profile.genreTraits.map((item, itemIndex) => itemIndex === index ? value : item) } } : current);
  }
}

function ProfileEditor({ profile, onChange, disabled }: { profile: ProfileContent; onChange: (profile: ProfileContent) => void; disabled: boolean }) {
  const updateGenre = (index: number, value: { genre: string; traits: string }) => onChange({ ...profile, genreTraits: profile.genreTraits.map((item, itemIndex) => itemIndex === index ? value : item) });
  return <>
    <label>账号共同风格<textarea value={profile.commonVoice} maxLength={3000} onChange={(event) => onChange({ ...profile, commonVoice: event.target.value })} disabled={disabled} /></label>
    <label>正文配图习惯<textarea value={profile.visualTraits} maxLength={1500} placeholder="样本没有稳定的配图习惯时留空" onChange={(event) => onChange({ ...profile, visualTraits: event.target.value })} disabled={disabled} /></label>
    <div className="account-style-profile-genres"><div className="section-heading"><h4>体裁特点</h4><button type="button" className="text-button" onClick={() => onChange({ ...profile, genreTraits: [...profile.genreTraits, { genre: "", traits: "" }] })} disabled={disabled || profile.genreTraits.length >= 8}>添加体裁</button></div>
      {profile.genreTraits.map((item, index) => <div className="account-style-profile-genre" key={index}><label>体裁<input value={item.genre} onChange={(event) => updateGenre(index, { ...item, genre: event.target.value })} disabled={disabled} /></label><label>特点<textarea value={item.traits} onChange={(event) => updateGenre(index, { ...item, traits: event.target.value })} disabled={disabled} /></label><button type="button" className="text-button danger-text" onClick={() => onChange({ ...profile, genreTraits: profile.genreTraits.filter((_, itemIndex) => itemIndex !== index) })} disabled={disabled}>移除</button></div>)}
    </div>
  </>;
}

function formatCreationDate(value: string): string {
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : "创建时间未知";
}

function hasSavedSampleSelection(selectedPaths: string[], savedPaths: string[]): boolean {
  const selected = [...selectedPaths].sort();
  return selected.length === savedPaths.length && selected.every((value, index) => value === [...savedPaths].sort()[index]);
}
