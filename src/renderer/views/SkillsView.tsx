import type { Dispatch, SetStateAction } from "react";
import { patchAppSettings, request } from "../api";
import { skillModelGroups } from "../app-constants";
import { skillModelStatus } from "../utils";
import type { AppSettingsContract, ManagedSkill, ModelConnection, ModelProviderId, WebSearchSettings } from "../types";

export interface SkillsViewProps {
  skills: ManagedSkill[];
  batchModelByGroup: Record<string, ModelProviderId | null>;
  setBatchModelByGroup: Dispatch<SetStateAction<Record<string, ModelProviderId | null>>>;
  batchSaving: boolean;
  selectedSkillIds: Record<string, boolean>;
  setSelectedSkillIds: Dispatch<SetStateAction<Record<string, boolean>>>;
  modelConnections: ModelConnection[];
  settings: AppSettingsContract | null;
  setSettings: Dispatch<SetStateAction<AppSettingsContract | null>>;
  webSearchSettings: WebSearchSettings;
  researchProxyUrl: string | undefined;
  auditDir: string;
  toggleGroupSelection: (groupKey: string, selectAll: boolean) => void;
  applyBatchModel: (groupKey: string) => void | Promise<void>;
  openSkillEditor: (skill: ManagedSkill) => void;
  loadSkillsAndConnections: () => Promise<void> | void;
  openTavilySettings: () => void;
  openResearchProxySettings: () => void;
  setEditingConnection: Dispatch<SetStateAction<ModelConnection | undefined>>;
  setConnectionCredential: Dispatch<SetStateAction<string>>;
  openCreateConnection: () => void;
  deleteModelConnection: (provider: string) => void | Promise<void>;
  setError: Dispatch<SetStateAction<string>>;
}

export function SkillsView(props: SkillsViewProps) {
  const {
    skills, batchModelByGroup, setBatchModelByGroup, batchSaving, selectedSkillIds, setSelectedSkillIds,
    modelConnections, settings, setSettings, webSearchSettings, researchProxyUrl, auditDir,
    toggleGroupSelection, applyBatchModel, openSkillEditor, loadSkillsAndConnections,
    openTavilySettings, openResearchProxySettings, setEditingConnection, setConnectionCredential,
    openCreateConnection, deleteModelConnection, setError,
  } = props;

  return <>
    <section className="card">
      <div className="section-heading"><div><h2>技能</h2><p className="hint compact-hint">每个技能都有独立的 SKILL.md，可修改执行规则、停用，或更换模型连接。</p></div><button className="text-button" onClick={() => void loadSkillsAndConnections()}>刷新</button></div>
      {skillModelGroups.map((group) => {
        const groupSkills = skills.filter((skill) => group.match(skill.category));
        if (groupSkills.length === 0) return null;
        const selected = batchModelByGroup[group.key];
        const selectedInGroup = groupSkills.filter((skill) => selectedSkillIds[skill.id]);
        return (
          <div className="skill-group" key={group.key}>
            <div className="section-heading group-heading">
              <div><h3>{group.title}</h3><p className="hint compact-hint">{group.description}</p></div>
              {group.providers && <div className="group-batch-model">
                <div className="group-select-all">
                  <button type="button" className="text-button" disabled={batchSaving || groupSkills.length === selectedInGroup.length} onClick={() => toggleGroupSelection(group.key, true)}>全选</button>
                  <button type="button" className="text-button" disabled={batchSaving || selectedInGroup.length === 0} onClick={() => toggleGroupSelection(group.key, false)}>取消全选</button>
                </div>
                <select value={selected ?? ""} onChange={(event) => setBatchModelByGroup((current) => ({ ...current, [group.key]: (event.target.value || null) as ModelProviderId | null }))} aria-label={`${group.title}批量模型`}>
                  <option value="">选择目标模型…</option>
                  {modelConnections.filter((connection) => group.providers!.includes(connection.provider) || (group.key === "text" && connection.custom)).map((connection) => <option key={connection.provider} value={connection.provider}>{connection.displayName}</option>)}
                </select>
                <button type="button" className="secondary-button" disabled={!selected || batchSaving || selectedInGroup.length === 0} onClick={() => void applyBatchModel(group.key)}>{batchSaving ? "正在应用…" : selectedInGroup.length > 0 ? `应用到选中的 ${selectedInGroup.length} 个技能` : "请先勾选技能"}</button>
              </div>}
            </div>
            <div className="skill-grid">{groupSkills.map((skill) => (
              <div className="skill-card" key={skill.id}>
                <label className="skill-select" onClick={(event) => event.stopPropagation()} title="勾选后用于批量设置模型">
                  <input type="checkbox" checked={!!selectedSkillIds[skill.id]} onChange={(event) => setSelectedSkillIds((current) => ({ ...current, [skill.id]: event.target.checked }))} aria-label={`选择 ${skill.name} 批量设置模型`} />
                </label>
                <button type="button" className="skill-card-body" onClick={() => openSkillEditor(skill)}>
                  <span><em>{skill.category}</em><strong>{skill.name}</strong></span>
                  <p>{skill.description}</p>
                  <small>{skill.enabled ? `已启用 · ${skillModelStatus(skill)}` : "已停用"}</small>
                </button>
              </div>
            ))}</div>
          </div>
        );
      })}
    </section>
    <section className="card">
      <div className="section-heading"><div><h2>模型连接</h2><p className="hint compact-hint">凭证加密保存在本机，页面只显示是否已配置，不回显明文。内置项为预置模板可编辑；自定义连接可删除。</p></div><button className="text-button" onClick={openCreateConnection}>添加连接</button></div>
      <ul className="account-list">{modelConnections.map((connection) => <li key={connection.provider}><span><strong>{connection.displayName}</strong><small>{connection.custom ? "自定义连接" : "预置模板"}{connection.modelId ? ` · ${connection.modelId}` : " · 使用服务默认模型"}{connection.proxyUrl ? ` · 代理 ${connection.proxyUrl}` : ""}</small></span><span className="account-actions"><em>{connection.provider === "openai_codex" ? "使用 ChatGPT 登录" : connection.credentialConfigured ? "凭证已配置" : "待配置凭证"}</em><button className="text-button" onClick={() => { setEditingConnection(connection); setConnectionCredential(""); setError(""); }}>配置</button>{connection.custom && <button className="text-button" onClick={() => void deleteModelConnection(connection.provider)}>删除</button>}</span></li>)}</ul>
    </section>
    <section className="card">
      <div className="section-heading"><div><h2>联网检索服务</h2><p className="hint compact-hint">用于阿文补充公开资料，不属于任何一个模型连接。默认使用免配置搜索源；Tavily 可提升稳定性。</p></div></div>
      <ul className="account-list">
        <li><span><strong>Tavily</strong><small>{webSearchSettings.tavilyCredentialSource === "environment" ? "开发环境变量配置" : "用于稳定的联网资料检索"}</small></span><span className="account-actions"><em>{webSearchSettings.tavilyConfigured ? "已配置" : "可选"}</em><button className="text-button" onClick={openTavilySettings}>配置</button></span></li>
        <li><span><strong>检索代理</strong><small>{researchProxyUrl ? `已配置：${researchProxyUrl}` : "留空直连；防火墙后访问检索源时填写"}</small></span><span className="account-actions"><em>{researchProxyUrl ? "已配置" : "直连"}</em><button className="text-button" onClick={openResearchProxySettings}>配置</button></span></li>
      </ul>
    </section>
    <section className="card">
      <div className="section-heading"><div><h2>AI 调用审计</h2><p className="hint compact-hint">开启后，每次模型调用都会把完整请求与响应写入数据目录下的日志，用于排查生成质量与失败；默认关闭。</p></div></div>
      <div className="skill-settings-row">
        <label className="toggle-label"><input type="checkbox" checked={settings?.auditAiCalls ?? false} onChange={async (event) => {
          const next = event.target.checked;
          try {
            const updated = await patchAppSettings({ auditAiCalls: next });
            setSettings((prev) => prev ? { ...prev, auditAiCalls: updated.auditAiCalls } : prev);
          } catch (error) {
            setError(error instanceof Error ? error.message : "无法保存审计设置。");
          }
        }} />开启 AI 调用审计（记录完整请求与响应）</label>
        <button className="text-button" onClick={async () => { try { await request<void>("/app/audit-log/clear", { method: "POST" }); } catch (error) { setError(error instanceof Error ? error.message : "清空审计日志失败。"); } }}>清空审计日志</button>
      </div>
      {auditDir && <p className="hint compact-hint">日志路径：{auditDir}（按天分文件，保留 30 天）</p>}
    </section>
  </>;
}
