import { useEffect, useState } from "react";
import { AlertCircle, AtSign, CheckCircle2, ClipboardPaste, ExternalLink, KeyRound, ListPlus, LoaderCircle, Mail, Plus, ShieldCheck, Trash2, Unplug, WandSparkles } from "lucide-react";
import { api } from "../api.js";
import { Button, ConfirmDialog, EmptyState, IconButton, LoadingBlock, Modal, ProviderMark, Segmented, StatusBadge, useToast } from "../components.jsx";
import AliasSyncModal from "../AliasSyncModal.jsx";
import { accountSupportsOfficialAliases, normalizeProvider, providerMeta } from "../providers.js";
import { accountStatus, relativeTime } from "../utils.js";

const MicrosoftProviderIcon = ({ size }) => <ProviderMark provider="microsoft" size={size} />;
const GoogleProviderIcon = ({ size }) => <ProviderMark provider="google" size={size} />;

function ConnectionModal({ open, onClose, existingAccount, onConnected }) {
  const [session, setSession] = useState(null);
  const [account, setAccount] = useState(null);
  const [importSummary, setImportSummary] = useState(null);
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [xunmailCredential, setXunmailCredential] = useState("");
  const [provider, setProvider] = useState(() => normalizeProvider(existingAccount?.provider));
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setSession(null);
    setAccount(null);
    setImportSummary(null);
    setStatus("idle");
    setMessage("");
    setCallbackUrl("");
    setXunmailCredential("");
    setProvider(normalizeProvider(existingAccount?.provider));
  }, [open, existingAccount?.id]);

  const meta = providerMeta(provider);

  const start = async () => {
    if (provider === "xunmail") {
      if (!xunmailCredential.trim()) {
        setMessage("请粘贴 Xunmail 格式凭据");
        return;
      }
      setLoading(true);
      setMessage("");
      try {
        const result = await api("/api/xunmail/import", { method: "POST", body: { credential: xunmailCredential } });
        setAccount(result.account);
        setImportSummary(result);
        setStatus("connected");
        toast(result.failed ? `已导入 ${result.imported} 个邮箱，${result.failed} 个失败` : `已通过 Xunmail 导入 ${result.imported} 个邮箱`);
        onConnected();
      } catch (error) {
        setStatus("idle");
        setMessage(error.message);
        toast(error.message, "error");
      } finally {
        setLoading(false);
      }
      return;
    }
    const popup = window.open("about:blank", meta.popupName);
    setLoading(true);
    setMessage("");
    setCallbackUrl("");
    try {
      const result = await api(`${meta.oauthBase}/start`, { method: "POST", body: { accountId: existingAccount?.id || null } });
      setSession(result);
      setStatus("awaiting_callback");
      if (popup) {
        popup.location.href = result.authorizationUrl;
        popup.focus();
      } else {
        window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      popup?.close();
      setStatus("error");
      setMessage(error.message);
      toast(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const complete = async (value) => {
    const pastedUrl = String(value || callbackUrl).trim();
    if (!pastedUrl) {
      setMessage(`请粘贴 ${meta.name} 授权后浏览器地址栏里的完整 localhost 地址`);
      return;
    }
    setLoading(true);
    setStatus("completing");
    setMessage("");
    try {
      const result = await api(`${meta.oauthBase}/${session.sessionId}/complete`, {
        method: "POST",
        body: { callbackUrl: pastedUrl },
      });
      setAccount(result.account);
      setStatus("connected");
      toast(`${result.account.email} 已通过 ${meta.name} OAuth 连接`);
      onConnected();
    } catch (error) {
      setStatus("awaiting_callback");
      setMessage(error.message);
      toast(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const pasteAndComplete = async () => {
    let value = callbackUrl.trim();
    if (!value && navigator.clipboard?.readText) {
      try {
        value = (await navigator.clipboard.readText()).trim();
        setCallbackUrl(value);
      } catch {
        setMessage("浏览器未允许读取剪贴板，请长按输入框粘贴回调地址");
        return;
      }
    }
    await complete(value);
  };

  const waiting = status === "awaiting_callback" || status === "completing";
  const footer = status === "connected"
    ? <Button variant="primary" icon={CheckCircle2} onClick={onClose}>完成</Button>
    : waiting
      ? <><Button onClick={onClose}>稍后处理</Button><a className="button button-secondary button-md" href={session.authorizationUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /><span>打开 {meta.name}</span></a><Button variant="primary" icon={ClipboardPaste} loading={loading} onClick={pasteAndComplete}>{callbackUrl.trim() ? "完成绑定" : "粘贴并完成"}</Button></>
      : provider === "xunmail"
        ? <><Button onClick={onClose}>取消</Button><Button variant="primary" icon={ShieldCheck} loading={loading} onClick={start}>验证并导入</Button></>
      : <><Button onClick={onClose}>取消</Button><Button variant="primary" icon={ShieldCheck} loading={loading} onClick={start}>{provider === "google" ? "打开 Google 授权" : `${meta.name} 官方授权`}</Button></>;

  return (
    <Modal open={open} onClose={onClose} title={existingAccount ? `重新授权 ${meta.name} 账号` : "绑定源头邮箱"} description={existingAccount?.email || meta.description} size="md" footer={footer}>
      {status === "connected" ? (
        <div className="connection-success"><span><CheckCircle2 size={30} /></span><h3>{provider === "xunmail" ? "Xunmail 导入已完成" : "OAuth 授权已完成"}</h3><p>{provider === "xunmail" && importSummary ? `成功导入 ${importSummary.imported} 个邮箱` : account?.email}</p><div><b>{provider === "xunmail" ? importSummary?.imported || 1 : "RT"}</b><small>{provider === "xunmail" ? "Graph 凭据已加密保存" : "长期授权已加密保存"}</small></div>{provider === "xunmail" && importSummary?.failed ? <div className="inline-alert warning"><AlertCircle size={17} /><span>{importSummary.failed} 个邮箱导入失败：{importSummary.items.filter((item) => item.status === "failed").slice(0, 3).map((item) => item.email || "格式无效").join("、")}</span></div> : null}</div>
      ) : waiting ? (
        <div className="oauth-callback-step">
          <span className={`challenge-icon ${status === "completing" ? "pulse" : ""}`}>{status === "completing" ? <LoaderCircle className="spin" size={24} /> : <ExternalLink size={24} />}</span>
          <h3>{status === "completing" ? `正在验证 ${meta.name} 回调` : `完成 ${meta.name} 授权`}</h3>
          <p>授权完成后浏览器会停在 localhost 页面。</p>
          <label className="form-field oauth-callback-field">
            <span className="field-label">localhost 回调地址</span>
            <textarea rows="3" value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder={provider === "google" ? "http://127.0.0.1:12142/?code=...&state=..." : "http://localhost:12141/desktop?code=...&state=..."} autoCapitalize="off" autoCorrect="off" spellCheck="false" />
            <small>粘贴浏览器地址栏中的完整地址</small>
          </label>
          {message && <div className="inline-alert danger"><AlertCircle size={17} /><span>{message}</span></div>}
        </div>
      ) : (
        <div className="oauth-start-panel">
          {!existingAccount && <Segmented value={provider} onChange={setProvider} ariaLabel="邮箱提供商" items={[{ value: "microsoft", label: "Microsoft", icon: MicrosoftProviderIcon }, { value: "google", label: "Google", icon: GoogleProviderIcon }, { value: "xunmail", label: "Xunmail", icon: Mail }]} />}
          <ProviderMark provider={provider} size={48} />
          <h3>{provider === "xunmail" ? "Xunmail Graph 导入" : `${meta.name} OAuth`}</h3>
          <p>{provider === "xunmail" ? "每行粘贴一组四段格式，服务器逐个验证后加密保存并自动取件" : provider === "google" ? "使用你在系统设置配置的自有 Google OAuth 客户端；未配置时必须先填写 Client ID 和 Client Secret" : `由 ${meta.name} 官方页面授权，使用 PKCE 保护授权码`}</p>
          {provider === "xunmail" ? <label className="form-field oauth-callback-field xunmail-import-field">
            <span className="field-label">Xunmail 格式凭据</span>
            <textarea rows="5" value={xunmailCredential} onChange={(event) => setXunmailCredential(event.target.value)} placeholder="邮箱----密码----client_id----refresh_token" autoCapitalize="off" autoCorrect="off" spellCheck="false" />
            <small>一行一个，单次最多 100 个。密码字段仅用于兼容格式，不会保存，也不会发送到 Xunmail Graph API。</small>
          </label> : null}
          {message && <div className="inline-alert danger"><AlertCircle size={17} /><span>{message}</span></div>}
          {provider === "xunmail" ? <div className="provider-login-note"><KeyRound size={24} /><span><b>服务器代为调用 Xunmail Graph API</b><small>client_id 和 refresh_token 加密保存；导入完成后可直接扫描收件箱</small></span></div> : <div className="provider-login-note"><KeyRound size={24} /><span><b>{provider === "google" ? "自有 Google OAuth 客户端" : "Mailspring 公共客户端"}</b><small>{provider === "google" ? "必须在系统设置填写自己的 Client ID + Secret；Refresh Token 加密保存" : "无需应用 Secret，Refresh Token 加密保存"}</small></span></div>}
        </div>
      )}
    </Modal>
  );
}

export default function SourcesPage({ refreshKey, onDataChange, onNavigate, addOpen, setAddOpen }) {
  const [data, setData] = useState(null);
  const [reconnecting, setReconnecting] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [aliasSyncAccount, setAliasSyncAccount] = useState(null);
  const toast = useToast();
  const load = async () => {
    try { setData(await api("/api/accounts")); } catch (error) { toast(error.message, "error"); }
  };
  useEffect(() => { load(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async () => {
    try { await api(`/api/accounts/${removing.id}`, { method: "DELETE" }); toast("源头邮箱已移除"); setRemoving(null); load(); onDataChange(); }
    catch (error) { toast(error.message, "error"); }
  };
  const connectionDone = () => { load(); onDataChange(); };
  const items = data?.items || [];

  return (
    <div className="page-stack sources-page">
      <div className="context-bar"><div className="context-copy"><Mail size={16} />已添加 {items.length} 个源头邮箱</div><Button variant="primary" icon={Plus} onClick={() => setAddOpen(true)}>添加源头邮箱</Button></div>
      <section className="source-grid">
        {!data ? <LoadingBlock rows={7} /> : items.length ? items.map((account) => {
          const accountMeta = providerMeta(account.provider);
          const supportsOfficial = accountSupportsOfficialAliases(account);
          return <article className={`source-card source-card-${accountMeta.id}`} key={account.id}>
            <header><ProviderMark provider={accountMeta.id} size={38} /><div><h2>{account.display_name || account.email.split("@")[0]}</h2><p>{account.email}<span className="provider-name">{accountMeta.name}</span></p></div><StatusBadge status={account.status}>{accountStatus[account.status]}</StatusBadge></header>
            {supportsOfficial ? <div className="source-quota"><div><span>官方基础地址</span><b>{account.official_used} <small>/ {account.official_limit}</small></b></div><div className="quota-track"><i style={{ width: `${Math.min(100, account.official_used / account.official_limit * 100)}%` }} /></div><small>剩余 {account.official_remaining} 个记录名额，实际以 Microsoft 官网限制为准</small></div> : <div className="source-provider-capability"><WandSparkles size={18} /><span><b>支持 Plus 分裂地址</b><small>{account.provider === "xunmail" ? "通过 Xunmail Graph API 自动取件，使用主地址生成 +tag 地址" : "Google 不提供官方别名，本系统使用主地址生成 +tag 地址"}</small></span></div>}
            <dl className="source-stats"><div><dt>官方别名</dt><dd>{supportsOfficial ? account.official_aliases : "不支持"}</dd></div><div><dt>分裂地址</dt><dd>{account.split_count}</dd></div><div><dt>收件扫描</dt><dd>{relativeTime(account.last_inbox_scan_at)}</dd></div><div><dt>{supportsOfficial ? "别名同步" : account.provider === "xunmail" ? "取件状态" : "OAuth 状态"}</dt><dd>{supportsOfficial ? relativeTime(account.last_synced_at) : account.oauth_connected ? account.provider === "xunmail" ? "已连接" : "已授权" : "待授权"}</dd></div></dl>
            {account.status === "action_required" && <div className="inline-alert warning"><AlertCircle size={15} /><span>{accountMeta.name} OAuth 需要重新授权</span><Button size="sm" onClick={() => setReconnecting(account)}>重新授权</Button></div>}
            {account.limit_reason && <div className="inline-alert warning"><AlertCircle size={15} /><span>{account.limit_reason}</span></div>}
            <footer>{supportsOfficial && <Button icon={AtSign} onClick={() => onNavigate("factory", { accountId: account.id, mode: "official" })}>官方别名</Button>}<Button icon={WandSparkles} onClick={() => onNavigate("factory", { accountId: account.id, mode: "split" })}>生成分裂</Button><div className="source-more">{supportsOfficial && <IconButton icon={ListPlus} label="手工登记官网别名" onClick={() => setAliasSyncAccount(account)} />}<IconButton icon={account.status === "connected" ? ShieldCheck : Unplug} label={account.provider === "xunmail" ? "更新 Xunmail 凭据" : `重新授权 ${accountMeta.name}`} onClick={() => setReconnecting(account)} /><IconButton icon={Trash2} label="移除源头邮箱" onClick={() => setRemoving(account)} /></div></footer>
          </article>;
        }) : <div className="empty-source-panel"><EmptyState icon={Mail} title="添加第一个源头邮箱" description="支持 Microsoft OAuth、Google OAuth 与 Xunmail Graph 格式导入。" action={<Button variant="primary" icon={Plus} onClick={() => setAddOpen(true)}>添加源头邮箱</Button>} /></div>}
      </section>
      <ConnectionModal open={addOpen} onClose={() => setAddOpen(false)} onConnected={connectionDone} />
      <ConnectionModal open={Boolean(reconnecting)} existingAccount={reconnecting} onClose={() => setReconnecting(null)} onConnected={connectionDone} />
      <AliasSyncModal account={aliasSyncAccount} onClose={() => setAliasSyncAccount(null)} onSynced={connectionDone} />
      <ConfirmDialog open={Boolean(removing)} onClose={() => setRemoving(null)} onConfirm={remove} title="移除这个源头邮箱？" description={removing ? `${removing.email} 的登录会话、官方别名记录（如有）、分裂地址和验证码都会从本系统删除。` : ""} confirmText="移除邮箱" danger />
    </div>
  );
}
