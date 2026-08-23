import type { Dispatch, FormEvent, SetStateAction } from "react";
import { platformName } from "../api";
import type { AccountPlatform, MediaAccount } from "../types";

export interface AccountsViewProps {
  accounts: MediaAccount[];
  loading: boolean;
  saving: boolean;
  platform: AccountPlatform;
  setPlatform: Dispatch<SetStateAction<AccountPlatform>>;
  displayName: string;
  setDisplayName: Dispatch<SetStateAction<string>>;
  platformExternalId: string;
  setPlatformExternalId: Dispatch<SetStateAction<string>>;
  loadAccounts: () => Promise<void>;
  deleteAccount: (account: MediaAccount) => Promise<void> | void;
  openWechatConnection: (account: MediaAccount) => Promise<void> | void;
  openCnblogsConnection: (account: MediaAccount) => Promise<void> | void;
  openJuejinConnection: (account: MediaAccount) => Promise<void> | void;
  openProfile: (account: MediaAccount) => void;
  addAccount: (event: FormEvent) => Promise<void> | void;
}

export function AccountsView(props: AccountsViewProps) {
  const {
    accounts, loading, saving, platform, setPlatform, displayName, setDisplayName,
    platformExternalId, setPlatformExternalId, loadAccounts, deleteAccount,
    openWechatConnection, openCnblogsConnection, openJuejinConnection, openProfile, addAccount,
  } = props;

  return <>
    <section className="card">
      <div className="section-heading"><h2>已绑定账号</h2><button className="text-button" onClick={() => void loadAccounts()} disabled={loading}>刷新</button></div>
      {loading ? <p>正在读取本地账号…</p> : accounts.length === 0 ? <p className="muted">还没有账号。先添加“围炉聊科技”或你的测试公众号。</p> : <ul className="account-list bound-account-list">{accounts.map((account) => <li key={account.id}>
        <span className="bound-account-summary"><strong>{account.displayName}</strong><small>{platformName(account.platform)} · {account.profile.positioning ? "已设置定位" : "待设置定位"}</small></span>
        <em className={`connection-status${account.credentialsConfigured ? " connected" : ""}`}>{account.credentialsConfigured ? "凭据已配置" : "待完成接入"}</em>
        <span className="account-row-actions">{account.platform === "wechat_official" && <button className="secondary-button compact-action" onClick={() => void openWechatConnection(account)}>连接微信</button>}{account.platform === "cnblogs" && <button className="secondary-button compact-action" onClick={() => void openCnblogsConnection(account)}>配置博客园凭据</button>}{account.platform === "juejin" && <button className="secondary-button compact-action" onClick={() => void openJuejinConnection(account)}>配置掘金凭据</button>}<button className="secondary-button compact-action" onClick={() => openProfile(account)}>编辑定位</button><button className="text-button danger-text compact-action" onClick={() => void deleteAccount(account)} disabled={saving}>删除</button></span>
      </li>)}</ul>}
    </section>
    <section className="card"><h2>添加账号</h2><form onSubmit={addAccount} className="account-form"><label>平台<select value={platform} onChange={(event) => setPlatform(event.target.value as AccountPlatform)}><option value="wechat_official">微信公众号</option><option value="csdn">CSDN</option><option value="cnblogs">博客园</option><option value="juejin">掘金</option></select></label><label>账号名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：围炉聊科技" maxLength={100} /></label>{platform === "cnblogs" && <label>博客地址/博客名<input value={platformExternalId} onChange={(event) => setPlatformExternalId(event.target.value)} placeholder="例如：https://www.cnblogs.com/weiluliaokeji 或 weiluliaokeji" maxLength={200} /><small>用于定位博客园博客；建议填写，便于发布前自动校验博客名。</small></label>}<button disabled={saving}>{saving ? "正在保存…" : "添加账号"}</button></form></section>
  </>;
}
