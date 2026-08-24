import { FormEvent, useState } from "react";
import { request, patchAppSettings } from "../api";
import { skillModelGroups } from "../app-constants";
import type { ManagedSkill, ModelConnection, ModelProviderId, SkillFileContent, WebSearchSettings } from "../types";

export interface UseSkillsSettingsParams {
  loadSkillsAndConnections: () => Promise<void>;
  setError: (value: string) => void;
  setSaving: (value: boolean) => void;
}

// 技能/模型连接/Tavily/代理设置域（拆分自 App.tsx）
export function useSkillsSettings(params: UseSkillsSettingsParams) {
  const {
    loadSkillsAndConnections, setError, setSaving
  } = params;

  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [batchModelByGroup, setBatchModelByGroup] = useState<Record<string, ModelProviderId | null>>({});
  const [batchSaving, setBatchSaving] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<Record<string, boolean>>({});
  const [modelConnections, setModelConnections] = useState<ModelConnection[]>([]);
  const [webSearchSettings, setWebSearchSettings] = useState<WebSearchSettings>({ tavilyConfigured: false, tavilyCredentialSource: "none", researchProxyUrl: "" });
  const [editingSkill, setEditingSkill] = useState<ManagedSkill>();
  const [editingSkillFile, setEditingSkillFile] = useState<SkillFileContent>();
  const [savedSkillFileContent, setSavedSkillFileContent] = useState("");
  const [editingConnection, setEditingConnection] = useState<ModelConnection>();
  const [connectionCredential, setConnectionCredential] = useState("");
  const [connectionCreating, setConnectionCreating] = useState(false);
  const [tavilyModalOpen, setTavilyModalOpen] = useState(false);
  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [tavilySaving, setTavilySaving] = useState(false);
  const [tavilyTesting, setTavilyTesting] = useState(false);
  const [tavilyError, setTavilyError] = useState("");
  const [tavilyTestResult, setTavilyTestResult] = useState("");
  const [researchProxyUrl, setResearchProxyUrl] = useState("");
  const [researchProxyInput, setResearchProxyInput] = useState("");
  const [researchProxySaving, setResearchProxySaving] = useState(false);
  const [researchProxyError, setResearchProxyError] = useState("");
  const [researchProxyModalOpen, setResearchProxyModalOpen] = useState(false);
  const openSkillEditor = (skill: ManagedSkill) => {
    setEditingSkill(skill);
    setEditingSkillFile({ relativePath: "SKILL.md", content: skill.markdown, size: new Blob([skill.markdown]).size });
    setSavedSkillFileContent(skill.markdown);
    setError("");
  };
  const chooseSkillFile = async (relativePath: string) => {
    if (!editingSkill || editingSkillFile?.relativePath === relativePath) return;
    if (editingSkillFile && editingSkillFile.content !== savedSkillFileContent && !window.confirm("当前技能文件还有未保存修改。确定放弃并打开其他文件吗？")) return;
    setSaving(true);
    try {
      const file = await request<SkillFileContent>(`/skills/${editingSkill.id}/file?path=${encodeURIComponent(relativePath)}`);
      setEditingSkillFile(file);
      setSavedSkillFileContent(file.content);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "技能文件读取失败。");
    } finally {
      setSaving(false);
    }
  };
  const closeSkillEditor = () => {
    if (editingSkillFile && editingSkillFile.content !== savedSkillFileContent && !window.confirm("技能文件还有未保存修改。确定关闭吗？")) return;
    setEditingSkill(undefined);
    setEditingSkillFile(undefined);
    setSavedSkillFileContent("");
  };
  const saveSkill = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingSkill) return;
    setSaving(true);
    try {
      const selectedPath = editingSkillFile?.relativePath ?? "SKILL.md";
      const selectedContent = editingSkillFile?.content ?? editingSkill.markdown;
      if (selectedPath !== "SKILL.md") {
        await request<SkillFileContent>(`/skills/${editingSkill.id}/file`, {
          method: "PUT",
          body: JSON.stringify({ path: selectedPath, content: selectedContent })
        });
      }
      const saved = await request<ManagedSkill>(`/skills/${editingSkill.id}`, {
        method: "PUT",
        body: JSON.stringify({
          markdown: selectedPath === "SKILL.md" ? selectedContent : editingSkill.markdown,
          enabled: editingSkill.enabled,
          provider: editingSkill.provider
        })
      });
      setEditingSkill(saved);
      const refreshedFile = await request<SkillFileContent>(`/skills/${saved.id}/file?path=${encodeURIComponent(selectedPath)}`);
      setEditingSkillFile(refreshedFile);
      setSavedSkillFileContent(refreshedFile.content);
      setError("");
      await loadSkillsAndConnections();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "技能保存失败。");
    } finally {
      setSaving(false);
    }
  };
  const toggleGroupSelection = (groupKey: string, value: boolean) => {
    const group = skillModelGroups.find((item) => item.key === groupKey);
    if (!group) return;
    const groupSkills = skills.filter((skill) => group.match(skill.category));
    setSelectedSkillIds((current) => {
      const next = { ...current };
      for (const skill of groupSkills) next[skill.id] = value;
      return next;
    });
  };
  const applyBatchModel = async (groupKey: string) => {
    const group = skillModelGroups.find((item) => item.key === groupKey);
    const target = batchModelByGroup[groupKey];
    if (!group || !target) return;
    const groupSkills = skills.filter((skill) => group.match(skill.category));
    const selectedIds = new Set(Object.keys(selectedSkillIds).filter((id) => selectedSkillIds[id]));
    const targetSkills = groupSkills.filter((skill) => selectedIds.has(skill.id));
    if (targetSkills.length === 0) return;
    setBatchSaving(true);
    try {
      for (const skill of targetSkills) {
        await request<ManagedSkill>(`/skills/${skill.id}`, {
          method: "PUT",
          body: JSON.stringify({ markdown: skill.markdown, enabled: skill.enabled, provider: target })
        });
      }
      setSelectedSkillIds({});
      setBatchModelByGroup((current) => ({ ...current, [groupKey]: null }));
      await loadSkillsAndConnections();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "批量设置模型失败。");
    } finally {
      setBatchSaving(false);
    }
  };
  const openCreateConnection = () => {
    setEditingConnection({
      provider: "",
      displayName: "",
      modelId: "",
      baseUrl: "",
      proxyUrl: "",
      enabled: true,
      builtInSearch: true,
      custom: true,
      credentialConfigured: false
    });
    setConnectionCredential("");
    setError("");
    setConnectionCreating(true);
  };
  const closeConnectionModal = () => {
    setEditingConnection(undefined);
    setConnectionCredential("");
    setConnectionCreating(false);
  };
  const saveModelConnection = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingConnection) return;
    setSaving(true);
    try {
      const body = {
        displayName: editingConnection.displayName,
        modelId: editingConnection.modelId,
        baseUrl: editingConnection.baseUrl,
        proxyUrl: editingConnection.proxyUrl,
        enabled: editingConnection.enabled,
        builtInSearch: editingConnection.builtInSearch,
        ...(connectionCredential.trim() ? { credential: connectionCredential.trim() } : {})
      };
      const saved = connectionCreating
        ? await request<ModelConnection>("/model-connections", { method: "POST", body: JSON.stringify(body) })
        : await request<ModelConnection>(`/model-connections/${editingConnection.provider}`, {
          method: "PUT",
          body: JSON.stringify(body)
        });
      setEditingConnection(saved);
      setConnectionCredential("");
      setConnectionCreating(false);
      setError("");
      await loadSkillsAndConnections();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模型连接保存失败。");
    } finally {
      setSaving(false);
    }
  };
  const deleteModelConnection = async (provider: string) => {
    if (!window.confirm("确定删除该自定义模型连接吗？删除后不可恢复；已绑定此连接的技能将无法再使用该模型。")) return;
    setSaving(true);
    try {
      await request<void>(`/model-connections/${encodeURIComponent(provider)}`, { method: "DELETE" });
      setError("");
      if (editingConnection?.provider === provider) closeConnectionModal();
      await loadSkillsAndConnections();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模型连接删除失败。");
    } finally {
      setSaving(false);
    }
  };
  const openTavilySettings = () => {
    setTavilyApiKey("");
    setTavilyError("");
    setTavilyTestResult("");
    setTavilyModalOpen(true);
  };
  const testTavilyConnection = async () => {
    setTavilyTesting(true);
    setTavilyError("");
    setTavilyTestResult("");
    try {
      const result = await request<{ ok: boolean; resultCount: number }>("/web-search/tavily/test", {
        method: "POST",
        body: JSON.stringify(tavilyApiKey.trim() ? { apiKey: tavilyApiKey.trim() } : {})
      });
      setTavilyTestResult(`连接成功：Tavily 已返回 ${result.resultCount} 条测试结果。${tavilyApiKey.trim() ? "请点击“保存”后用于正式补研。" : "当前保存的 Key 可用于正式补研。"}`);
    } catch (cause) {
      setTavilyError(cause instanceof Error ? cause.message : "Tavily 连接测试失败。");
    } finally {
      setTavilyTesting(false);
    }
  };
  const saveTavilySettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!tavilyApiKey.trim()) {
      setTavilyError("请输入 Tavily API Key；如只想测试已有凭证，可直接点击“测试连接”。");
      return;
    }
    setTavilySaving(true);
    setTavilyError("");
    setTavilyTestResult("");
    try {
      const saved = await request<WebSearchSettings>("/web-search/tavily", {
        method: "PUT",
        body: JSON.stringify({ apiKey: tavilyApiKey.trim() })
      });
      setWebSearchSettings(saved);
      setTavilyApiKey("");
      setTavilyModalOpen(false);
    } catch (cause) {
      setTavilyError(cause instanceof Error ? cause.message : "Tavily 配置保存失败。");
    } finally {
      setTavilySaving(false);
    }
  };
  const clearTavilySettings = async () => {
    if (!window.confirm("确定移除本机保存的 Tavily API Key 吗？不会影响系统环境变量中的开发配置。")) return;
    setTavilySaving(true);
    setTavilyError("");
    setTavilyTestResult("");
    try {
      const saved = await request<WebSearchSettings>("/web-search/tavily", { method: "DELETE" });
      setWebSearchSettings(saved);
      setTavilyApiKey("");
    } catch (cause) {
      setTavilyError(cause instanceof Error ? cause.message : "Tavily 凭证移除失败。");
    } finally {
      setTavilySaving(false);
    }
  };
  const openResearchProxySettings = () => {
    setResearchProxyInput(researchProxyUrl);
    setResearchProxyError("");
    setResearchProxyModalOpen(true);
  };
  const saveResearchProxySettings = async (event: FormEvent) => {
    event.preventDefault();
    setResearchProxySaving(true);
    setResearchProxyError("");
    try {
      const saved = await request<WebSearchSettings>("/web-search/proxy", {
        method: "PUT",
        body: JSON.stringify({ proxyUrl: researchProxyInput.trim() })
      });
      setResearchProxyUrl(saved.researchProxyUrl ?? "");
      setResearchProxyModalOpen(false);
    } catch (cause) {
      setResearchProxyError(cause instanceof Error ? cause.message : "检索代理保存失败。");
    } finally {
      setResearchProxySaving(false);
    }
  };
  const clearResearchProxySettings = async () => {
    setResearchProxySaving(true);
    setResearchProxyError("");
    try {
      const saved = await request<WebSearchSettings>("/web-search/proxy", { method: "DELETE" });
      setResearchProxyUrl(saved.researchProxyUrl ?? "");
      setResearchProxyInput("");
      setResearchProxyModalOpen(false);
    } catch (cause) {
      setResearchProxyError(cause instanceof Error ? cause.message : "检索代理移除失败。");
    } finally {
      setResearchProxySaving(false);
    }
  };

  return {
    skills,
    setSkills,
    batchModelByGroup,
    setBatchModelByGroup,
    batchSaving,
    setBatchSaving,
    selectedSkillIds,
    setSelectedSkillIds,
    modelConnections,
    setModelConnections,
    webSearchSettings,
    setWebSearchSettings,
    editingSkill,
    setEditingSkill,
    editingSkillFile,
    setEditingSkillFile,
    savedSkillFileContent,
    setSavedSkillFileContent,
    editingConnection,
    setEditingConnection,
    connectionCredential,
    setConnectionCredential,
    connectionCreating,
    setConnectionCreating,
    tavilyModalOpen,
    setTavilyModalOpen,
    tavilyApiKey,
    setTavilyApiKey,
    tavilySaving,
    setTavilySaving,
    tavilyTesting,
    setTavilyTesting,
    tavilyError,
    setTavilyError,
    tavilyTestResult,
    setTavilyTestResult,
    researchProxyUrl,
    setResearchProxyUrl,
    researchProxyInput,
    setResearchProxyInput,
    researchProxySaving,
    setResearchProxySaving,
    researchProxyError,
    setResearchProxyError,
    researchProxyModalOpen,
    setResearchProxyModalOpen,
    openSkillEditor,
    chooseSkillFile,
    closeSkillEditor,
    saveSkill,
    toggleGroupSelection,
    applyBatchModel,
    saveModelConnection,
    openCreateConnection,
    closeConnectionModal,
    deleteModelConnection,
    openTavilySettings,
    testTavilyConnection,
    saveTavilySettings,
    clearTavilySettings,
    openResearchProxySettings,
    saveResearchProxySettings,
    clearResearchProxySettings,
  };
}

export type UseSkillsSettingsReturn = ReturnType<typeof useSkillsSettings>;
