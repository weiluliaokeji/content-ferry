import { FormEvent, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { request } from "../api";
import type { AccountPlatform, AccountProfile, MediaAccount, WechatCredentialStatus } from "../types";

export interface UseAccountsConnectionsParams {
  accounts: MediaAccount[];
  loadAccounts: () => Promise<void>;
  setError: (value: string) => void;
  setSaving: (value: boolean) => void;
  setActiveView: (value: "dashboard" | "library" | "publish" | "skills" | "accounts" | "logs" | "help") => void;
  platform: AccountPlatform;
  setPlatform: (value: AccountPlatform) => void;
  displayName: string;
  setDisplayName: (value: string) => void;
  platformExternalId: string;
  setPlatformExternalId: (value: string) => void;
  editing: MediaAccount | undefined;
  setEditing: (value: MediaAccount | undefined) => void;
  editingDisplayName: string;
  setEditingDisplayName: (value: string) => void;
  editingExternalId: string;
  setEditingExternalId: (value: string) => void;
  profile: AccountProfile;
  setProfile: Dispatch<SetStateAction<AccountProfile>>;
}

// 账号与连接管理域（拆分自 App.tsx）
export function useAccountsConnections(params: UseAccountsConnectionsParams) {
  const {
    accounts, loadAccounts, setError, setSaving, setActiveView,
    platform, setPlatform, displayName, setDisplayName, platformExternalId, setPlatformExternalId,
    editing, setEditing, editingDisplayName, setEditingDisplayName, editingExternalId, setEditingExternalId,
    profile, setProfile
  } = params;

  const [wechatAccount, setWechatAccount] = useState<MediaAccount>();
  const [wechatAppId, setWechatAppId] = useState("");
  const [wechatAppSecret, setWechatAppSecret] = useState("");
  const [wechatCallbackToken, setWechatCallbackToken] = useState("");
  const [wechatCredentialStatus, setWechatCredentialStatus] = useState<WechatCredentialStatus>();
  const [wechatTestResult, setWechatTestResult] = useState<"success" | "">("");
  const [wechatTestError, setWechatTestError] = useState("");
  const [cnblogsCredentialAccount, setCnblogsCredentialAccount] = useState<MediaAccount | undefined>(undefined);
  const [cnblogsCredentialUsername, setCnblogsCredentialUsername] = useState("");
  const [cnblogsCredentialApiKey, setCnblogsCredentialApiKey] = useState("");
  const [cnblogsCredentialBlogUrl, setCnblogsCredentialBlogUrl] = useState("");
  const [cnblogsCredentialApiKeyConfigured, setCnblogsCredentialApiKeyConfigured] = useState(false);
  const [cnblogsCredentialSaving, setCnblogsCredentialSaving] = useState(false);
  const [cnblogsCredentialError, setCnblogsCredentialError] = useState("");
  const [juejinCredentialAccount, setJuejinCredentialAccount] = useState<MediaAccount | undefined>(undefined);
  const [juejinCredentialCookie, setJuejinCredentialCookie] = useState("");
  const [juejinCredentialAid, setJuejinCredentialAid] = useState("");
  const [juejinCredentialUuid, setJuejinCredentialUuid] = useState("");
  const [juejinCredentialCookieConfigured, setJuejinCredentialCookieConfigured] = useState(false);
  const [juejinCredentialAidConfigured, setJuejinCredentialAidConfigured] = useState(false);
  const [juejinCredentialUuidConfigured, setJuejinCredentialUuidConfigured] = useState(false);
  const [juejinCredentialSaving, setJuejinCredentialSaving] = useState(false);
  const [juejinCredentialError, setJuejinCredentialError] = useState("");
  const [juejinGrabRunning, setJuejinGrabRunning] = useState(false);
  const [juejinGrabStatus, setJuejinGrabStatus] = useState("");
  const [fiftyoneCtoCredentialAccount, setFiftyoneCtoCredentialAccount] = useState<MediaAccount | undefined>(undefined);
  const [fiftyoneCtoCredentialCookie, setFiftyoneCtoCredentialCookie] = useState("");
  const [fiftyoneCtoCredentialCookieConfigured, setFiftyoneCtoCredentialCookieConfigured] = useState(false);
  const [fiftyoneCtoCredentialSaving, setFiftyoneCtoCredentialSaving] = useState(false);
  const [fiftyoneCtoCredentialError, setFiftyoneCtoCredentialError] = useState("");
  const openProfile = (account: MediaAccount) => { setEditing(account); setEditingDisplayName(account.displayName); setEditingExternalId(account.externalAccountId ?? ""); setProfile(account.profile); setError(""); };
  const changeProfile = (field: keyof AccountProfile, value: string) => setProfile((current) => ({ ...current, [field]: value }));
  const saveWechatConnection = async (event: FormEvent) => {
    event.preventDefault();
    if (!wechatAccount || !wechatAppId.trim()) {
      setError("请填写 AppID。");
      return;
    }
    if (!wechatCredentialStatus?.appSecretConfigured && !wechatAppSecret.trim()) {
      setError("首次连接需要填写 AppSecret。");
      return;
    }
    if (!wechatCredentialStatus?.callbackTokenConfigured && !wechatCallbackToken.trim()) {
      setError("首次连接需要填写消息校验 Token。");
      return;
    }
    setSaving(true);
    try {
      await request<void>(`/media-accounts/${wechatAccount.id}/credentials/app_id`, { method: "PUT", body: JSON.stringify({ secret: wechatAppId.trim() }) });
      if (wechatAppSecret.trim()) await request<void>(`/media-accounts/${wechatAccount.id}/credentials/app_secret`, { method: "PUT", body: JSON.stringify({ secret: wechatAppSecret.trim() }) });
      if (wechatCallbackToken.trim()) await request<void>(`/media-accounts/${wechatAccount.id}/credentials/callback_token`, { method: "PUT", body: JSON.stringify({ secret: wechatCallbackToken.trim() }) });
      await request(`/integrations/wechat/accounts/${wechatAccount.id}/test`, { method: "POST", body: "{}" });
      setWechatAppSecret(""); setWechatCallbackToken(""); setWechatTestResult("success"); setWechatTestError(""); setError("");
      await loadAccounts();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "微信公众号连接失败。";
      setWechatTestResult(""); setWechatTestError(message); setError("");
    }
    finally { setSaving(false); }
  };
  const openWechatConnection = async (account: MediaAccount) => {
    setWechatAccount(account); setWechatAppSecret(""); setWechatCallbackToken(""); setWechatCredentialStatus(undefined); setWechatTestResult(""); setWechatTestError(""); setError("");
    try {
      const status = await request<WechatCredentialStatus>(`/media-accounts/${account.id}/credentials/status`);
      setWechatCredentialStatus(status);
      setWechatAppId(status.appId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取微信连接状态。"); }
  };
  const openCnblogsConnection = async (account: MediaAccount) => {
    setCnblogsCredentialAccount(account);
    setCnblogsCredentialUsername("");
    setCnblogsCredentialApiKey("");
    setCnblogsCredentialApiKeyConfigured(false);
    setCnblogsCredentialBlogUrl(account.externalAccountId ?? "");
    setCnblogsCredentialError("");
    setError("");
    try {
      const status = await request<WechatCredentialStatus>(`/media-accounts/${account.id}/credentials/status`);
      setCnblogsCredentialUsername(status.cnblogsUsername ?? "");
      setCnblogsCredentialApiKeyConfigured(Boolean(status.cnblogsApiKeyConfigured));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取博客园凭据状态。"); }
  };
  const saveCnblogsCredentials = async (event: FormEvent) => {
    event.preventDefault();
    if (!cnblogsCredentialAccount) return;
    if (!cnblogsCredentialUsername.trim()) {
      setCnblogsCredentialError("请填写博客园用户名。");
      return;
    }
    if (!cnblogsCredentialApiKeyConfigured && !cnblogsCredentialApiKey.trim()) {
      setCnblogsCredentialError("请填写 API Key；已配置时留空可保留原值。");
      return;
    }
    setCnblogsCredentialSaving(true);
    try {
      await request<MediaAccount>(`/media-accounts/${cnblogsCredentialAccount.id}/credentials/username`, {
        method: "PUT",
        body: JSON.stringify({ secret: cnblogsCredentialUsername.trim() })
      });
      if (cnblogsCredentialApiKey.trim()) {
        await request<MediaAccount>(`/media-accounts/${cnblogsCredentialAccount.id}/credentials/api_key`, {
          method: "PUT",
          body: JSON.stringify({ secret: cnblogsCredentialApiKey.trim() })
        });
      }
      await request<MediaAccount>(`/media-accounts/${cnblogsCredentialAccount.id}`, {
        method: "PUT",
        body: JSON.stringify({ displayName: cnblogsCredentialAccount.displayName, externalAccountId: cnblogsCredentialBlogUrl.trim() })
      });
      await loadAccounts();
      setCnblogsCredentialAccount(undefined);
      setCnblogsCredentialError("");
    } catch (cause) {
      setCnblogsCredentialError(cause instanceof Error ? cause.message : "保存博客园凭据失败。");
    } finally {
      setCnblogsCredentialSaving(false);
    }
  };
  const openCnblogsCredentialEntry = async (accountId?: string) => {
    const target = accountId ? accounts.find((item) => item.id === accountId) : undefined;
    const fallback = target ?? accounts.find((item) => item.platform === "cnblogs");
    if (!fallback) {
      setError("请先在“账号”中添加一个博客园账号，再配置用户名和 API Key。");
      return;
    }
    setActiveView("accounts");
    await openCnblogsConnection(fallback);
  };
  const openJuejinConnection = async (account: MediaAccount) => {
    setJuejinCredentialAccount(account);
    setJuejinCredentialCookie("");
    setJuejinCredentialAid("");
    setJuejinCredentialUuid("");
    setJuejinCredentialCookieConfigured(false);
    setJuejinCredentialAidConfigured(false);
    setJuejinCredentialUuidConfigured(false);
    setJuejinCredentialError("");
    setError("");
    try {
      const status = await request<WechatCredentialStatus>(`/media-accounts/${account.id}/credentials/status`);
      setJuejinCredentialCookieConfigured(Boolean(status.juejinCookieConfigured));
      setJuejinCredentialAidConfigured(Boolean(status.juejinAidConfigured));
      setJuejinCredentialUuidConfigured(Boolean(status.juejinUuidConfigured));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取掘金凭据状态。"); }
  };
  const saveJuejinCredentials = async (event: FormEvent) => {
    event.preventDefault();
    if (!juejinCredentialAccount) return;
    if (!juejinCredentialCookie.trim()) {
      setJuejinCredentialError("请填写 Cookie；已配置时留空可保留原值。");
      return;
    }
    setJuejinCredentialSaving(true);
    try {
      await request<MediaAccount>(`/media-accounts/${juejinCredentialAccount.id}/credentials/juejin_cookie`, {
        method: "PUT",
        body: JSON.stringify({ secret: juejinCredentialCookie.trim() })
      });
      if (juejinCredentialAid.trim()) {
        await request<MediaAccount>(`/media-accounts/${juejinCredentialAccount.id}/credentials/juejin_aid`, {
          method: "PUT",
          body: JSON.stringify({ secret: juejinCredentialAid.trim() })
        });
      }
      if (juejinCredentialUuid.trim()) {
        await request<MediaAccount>(`/media-accounts/${juejinCredentialAccount.id}/credentials/juejin_uuid`, {
          method: "PUT",
          body: JSON.stringify({ secret: juejinCredentialUuid.trim() })
        });
      }
      await loadAccounts();
      setJuejinCredentialAccount(undefined);
      setJuejinCredentialError("");
    } catch (cause) {
      setJuejinCredentialError(cause instanceof Error ? cause.message : "保存掘金凭据失败。");
    } finally {
      setJuejinCredentialSaving(false);
    }
  };
  const startJuejinCookieGrab = async () => {
    if (!juejinCredentialAccount) return;
    setJuejinGrabRunning(true);
    setJuejinGrabStatus("正在打开掘金登录窗口，请在弹出的窗口中登录掘金…");
    setJuejinCredentialError("");
    try {
      const started = await request<{ grabId: string }>("/integrations/juejin/cookie-grab/start", {
        method: "POST",
        body: JSON.stringify({ accountId: juejinCredentialAccount.id })
      });
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const snapshot = await request<{
          status: string;
          cookie?: string;
          aid?: string;
          uuid?: string;
          verified?: boolean;
          error?: string;
        }>(`/integrations/juejin/cookie-grab/status?grabId=${encodeURIComponent(started.grabId)}`);
        if (snapshot.status === "success") {
          if (snapshot.verified !== true) {
            // 防御：只有接口验证通过才自动保存；否则不保存，提示继续等待登录。
            setJuejinGrabStatus("已检测到登录 Cookie，但接口验证未通过，请确认登录态后重试。");
            return;
          }
          const cookie = snapshot.cookie ?? "";
          const aid = snapshot.aid ?? "";
          const uuid = snapshot.uuid ?? "";
          await request<MediaAccount>(`/media-accounts/${juejinCredentialAccount.id}/credentials/juejin_cookie`, {
            method: "PUT",
            body: JSON.stringify({ secret: cookie })
          });
          if (aid) {
            await request<MediaAccount>(`/media-accounts/${juejinCredentialAccount.id}/credentials/juejin_aid`, {
              method: "PUT",
              body: JSON.stringify({ secret: aid })
            });
          }
          if (uuid) {
            await request<MediaAccount>(`/media-accounts/${juejinCredentialAccount.id}/credentials/juejin_uuid`, {
              method: "PUT",
              body: JSON.stringify({ secret: uuid })
            });
          }
          await loadAccounts();
          setJuejinCredentialCookie(cookie);
          setJuejinCredentialAid(aid);
          setJuejinCredentialUuid(uuid);
          setJuejinCredentialCookieConfigured(Boolean(cookie));
          setJuejinCredentialAidConfigured(Boolean(aid));
          setJuejinCredentialUuidConfigured(Boolean(uuid));
          setJuejinGrabStatus("已自动获取并保存掘金凭据，接口验证通过。");
          return;
        }
        if (snapshot.status === "cancelled") {
          setJuejinGrabStatus("已取消自动获取（登录窗口已关闭）。");
          return;
        }
        if (snapshot.status === "error") {
          setJuejinGrabStatus(`自动获取失败：${snapshot.error ?? "未知错误"}`);
          return;
        }
      }
      setJuejinGrabStatus("等待登录超时，请在登录窗口完成登录后重试。");
    } catch (cause) {
      setJuejinGrabStatus(cause instanceof Error ? cause.message : "启动自动获取 Cookie 失败。");
    } finally {
      setJuejinGrabRunning(false);
    }
  };
  const openJuejinCredentialEntry = async (accountId?: string) => {
    const target = accountId ? accounts.find((item) => item.id === accountId) : undefined;
    const fallback = target ?? accounts.find((item) => item.platform === "juejin");
    if (!fallback) {
      setError("请先在“账号”中添加一个掘金账号，再配置 Cookie。");
      return;
    }
    setActiveView("accounts");
    await openJuejinConnection(fallback);
  };
  const openFiftyoneCtoConnection = async (account: MediaAccount) => {
    setFiftyoneCtoCredentialAccount(account);
    setFiftyoneCtoCredentialCookie("");
    setFiftyoneCtoCredentialCookieConfigured(false);
    setFiftyoneCtoCredentialError("");
    setError("");
    try {
      const status = await request<WechatCredentialStatus>(`/media-accounts/${account.id}/credentials/status`);
      setFiftyoneCtoCredentialCookieConfigured(Boolean(status.fiftyoneCtoCookieConfigured));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取 51CTO 凭据状态。"); }
  };
  const saveFiftyoneCtoCredentials = async (event: FormEvent) => {
    event.preventDefault();
    if (!fiftyoneCtoCredentialAccount) return;
    if (!fiftyoneCtoCredentialCookie.trim()) {
      setFiftyoneCtoCredentialError("请填写 Cookie；已配置时留空可保留原值。");
      return;
    }
    setFiftyoneCtoCredentialSaving(true);
    try {
      await request<MediaAccount>(`/media-accounts/${fiftyoneCtoCredentialAccount.id}/credentials/fiftyone_cto_cookie`, {
        method: "PUT",
        body: JSON.stringify({ secret: fiftyoneCtoCredentialCookie.trim() })
      });
      await loadAccounts();
      setFiftyoneCtoCredentialAccount(undefined);
      setFiftyoneCtoCredentialError("");
    } catch (cause) {
      setFiftyoneCtoCredentialError(cause instanceof Error ? cause.message : "保存 51CTO 凭据失败。");
    } finally {
      setFiftyoneCtoCredentialSaving(false);
    }
  };
  const openFiftyoneCtoCredentialEntry = async (accountId?: string) => {
    const target = accountId ? accounts.find((item) => item.id === accountId) : undefined;
    const fallback = target ?? accounts.find((item) => item.platform === "51cto");
    if (!fallback) {
      setError("请先在“账号”中添加一个 51CTO 账号，再配置 Cookie。");
      return;
    }
    setActiveView("accounts");
    await openFiftyoneCtoConnection(fallback);
  };
  const deleteAccount = async (account: MediaAccount) => {
    if (!window.confirm(`确定删除账号“${account.displayName}”吗？本机保存的该账号凭证也会删除，历史发布记录会保留。`)) return;
    setSaving(true);
    try {
      await request<void>(`/media-accounts/${account.id}`, { method: "DELETE" });
      setError(""); await loadAccounts();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "账号删除失败。"); }
    finally { setSaving(false); }
  };

  return {
    wechatAccount,
    setWechatAccount,
    wechatAppId,
    setWechatAppId,
    wechatAppSecret,
    setWechatAppSecret,
    wechatCallbackToken,
    setWechatCallbackToken,
    wechatCredentialStatus,
    setWechatCredentialStatus,
    wechatTestResult,
    setWechatTestResult,
    wechatTestError,
    setWechatTestError,
    cnblogsCredentialAccount,
    setCnblogsCredentialAccount,
    cnblogsCredentialUsername,
    setCnblogsCredentialUsername,
    cnblogsCredentialApiKey,
    setCnblogsCredentialApiKey,
    cnblogsCredentialBlogUrl,
    setCnblogsCredentialBlogUrl,
    cnblogsCredentialApiKeyConfigured,
    setCnblogsCredentialApiKeyConfigured,
    cnblogsCredentialSaving,
    setCnblogsCredentialSaving,
    cnblogsCredentialError,
    setCnblogsCredentialError,
    juejinCredentialAccount,
    setJuejinCredentialAccount,
    juejinCredentialCookie,
    setJuejinCredentialCookie,
    juejinCredentialAid,
    setJuejinCredentialAid,
    juejinCredentialUuid,
    setJuejinCredentialUuid,
    juejinCredentialCookieConfigured,
    setJuejinCredentialCookieConfigured,
    juejinCredentialAidConfigured,
    setJuejinCredentialAidConfigured,
    juejinCredentialUuidConfigured,
    setJuejinCredentialUuidConfigured,
    juejinCredentialSaving,
    setJuejinCredentialSaving,
    juejinCredentialError,
    setJuejinCredentialError,
    juejinGrabRunning,
    setJuejinGrabRunning,
    juejinGrabStatus,
    setJuejinGrabStatus,
    openProfile,
    changeProfile,
    saveWechatConnection,
    openWechatConnection,
    openCnblogsConnection,
    saveCnblogsCredentials,
    openCnblogsCredentialEntry,
    openJuejinConnection,
    saveJuejinCredentials,
    startJuejinCookieGrab,
    openJuejinCredentialEntry,
    fiftyoneCtoCredentialAccount,
    setFiftyoneCtoCredentialAccount,
    fiftyoneCtoCredentialCookie,
    setFiftyoneCtoCredentialCookie,
    fiftyoneCtoCredentialCookieConfigured,
    setFiftyoneCtoCredentialCookieConfigured,
    fiftyoneCtoCredentialSaving,
    setFiftyoneCtoCredentialSaving,
    fiftyoneCtoCredentialError,
    setFiftyoneCtoCredentialError,
    openFiftyoneCtoConnection,
    saveFiftyoneCtoCredentials,
    openFiftyoneCtoCredentialEntry,
    deleteAccount,
  };
}

export type UseAccountsConnectionsReturn = ReturnType<typeof useAccountsConnections>;
