import crypto from "node:crypto";
import { publicAccount } from "./account-service.js";
import { codeFromText, normalizeEmail } from "./address-generator.js";
import { audit, createSourceAccount, nowIso } from "./db.js";
import { decodeDataUrl, htmlToText } from "./mail-content.js";

const DEFAULT_ALLOWED_HOSTS = "apple55.top,msg.linlanyu.com";
const CANONICAL_HTTPS_HOST = "apple55.top";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_TIMEZONE_OFFSET = "+08:00";
const MAIL_BODY_LIMIT = 100_000;
const MAX_MESSAGES_PER_SCAN = 100;

function canonicalAccessUrl(parsed) {
  if (parsed.hostname.toLowerCase() === CANONICAL_HTTPS_HOST) {
    parsed.protocol = "https:";
  }
  return parsed;
}

function errorWithStatus(message, status = 502, code = "ICLOUD_LINK_ERROR") {
  return Object.assign(new Error(message), { status, code });
}

function scalar(value) {
  if (value === undefined || value === null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  return "";
}

function allowedHostSet(value) {
  return new Set(String(value || DEFAULT_ALLOWED_HOSTS)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
}

function parseAccessUrl(value, email, allowedHosts) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); } catch {
    throw errorWithStatus("iCloud 取件 URL 无效", 400, "INVALID_ICLOUD_LINK_URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw errorWithStatus("iCloud 取件 URL 无效", 400, "INVALID_ICLOUD_LINK_URL");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  // Legacy providers include the base mailbox in the path. Validate it when
  // present, while allowing newer providers to use arbitrary paths/tokens.
  if (segments.length >= 3 && segments[0].toLowerCase() === "messages") {
    let scopedEmail = "";
    try { scopedEmail = decodeURIComponent(segments[2] || ""); } catch { /* validated below */ }
    if (normalizeEmail(scopedEmail) !== email) {
      throw errorWithStatus("iCloud 取件 URL 与邮箱不匹配", 400, "ICLOUD_LINK_URL_MISMATCH");
    }
  }
  if (!parsed.hostname) {
    throw errorWithStatus("iCloud 取件 URL 与邮箱不匹配", 400, "ICLOUD_LINK_URL_MISMATCH");
  }
  return canonicalAccessUrl(parsed).toString();
}

export function parseIcloudLinkCredentialLine(value, { allowedHosts = DEFAULT_ALLOWED_HOSTS } = {}) {
  const raw = scalar(value).trim();
  const separator = raw.indexOf("----");
  if (separator <= 0) {
    throw errorWithStatus("iCloud 格式应为：基础邮箱----取件URL", 400, "INVALID_ICLOUD_LINK_FORMAT");
  }
  const email = normalizeEmail(raw.slice(0, separator));
  if (!email || email.split("@")[1] !== "icloud.com" || email.split("@")[0].includes("+")) {
    throw errorWithStatus("只支持不带 +tag 的 iCloud 基础邮箱", 422, "UNSUPPORTED_ICLOUD_LINK_EMAIL");
  }
  const accessUrl = parseAccessUrl(raw.slice(separator + 4), email, allowedHostSet(allowedHosts));
  return { email, accessUrl };
}

function endpointUrls(accessUrl) {
  const parsed = canonicalAccessUrl(new URL(accessUrl));
  const segments = parsed.pathname.split("/").filter(Boolean);
  const scope = parsed.pathname.slice("/messages/".length);
  const root = `${parsed.protocol}//${parsed.host}`;
  if (parsed.hostname.toLowerCase() === "msg.linlanyu.com") {
    const list = new URL("/api/messages", root);
    list.searchParams.set("email", decodeURIComponent(segments[2] || ""));
    list.searchParams.set("token", segments[1] || "");
    list.searchParams.set("limit", String(MAX_MESSAGES_PER_SCAN));
    return { list: list.toString(), detail: null, inlineDetails: true };
  }
  const legacyPath = segments.length === 3
    && segments[0].toLowerCase() === "messages"
    && /^[a-z0-9_-]{16,}$/i.test(segments[1]);
  if (!legacyPath) {
    return { list: accessUrl, detail: null, inlineDetails: true, directPage: true };
  }
  return {
    list: new URL(`/api/messages/${scope}`, root).toString(),
    detail: (id) => new URL(`/message/${encodeURIComponent(id)}/${scope}`, root).toString(),
    inlineDetails: false,
  };
}

function attributeValue(attributes, name) {
  const match = String(attributes || "").match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? htmlToText(match[2]) : "";
}

function classContent(body, className) {
  const match = String(body || "").match(new RegExp(
    `<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    "i",
  ));
  return match ? htmlToText(match[1]) : "";
}

function messagesFromAccessPage(html) {
  const source = String(html || "");
  if (!/<div\b[^>]*\bid=["']message-list["']/i.test(source)) {
    const pageText = htmlToText(source);
    if (/全部邮件（共\s*0\s*封）/.test(pageText)
      && /暂时没有同步到这个子邮箱的邮件/.test(pageText)) {
      return [];
    }
    throw errorWithStatus("iCloud 取件服务返回了无效的邮件页面", 502, "INVALID_ICLOUD_LINK_RESPONSE");
  }
  const items = [];
  for (const match of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = match[1];
    const classes = attributeValue(attributes, "class").split(/\s+/);
    const id = attributeValue(attributes, "data-id");
    if (!classes.includes("item") || !id) continue;
    items.push({
      id,
      subject: classContent(match[2], "subject"),
      received_at: classContent(match[2], "time"),
      from_address: classContent(match[2], "from"),
    });
    if (items.length >= MAX_MESSAGES_PER_SCAN) break;
  }
  return items;
}

function normalizeReceivedAt(value, timezoneOffset) {
  const raw = scalar(value).trim();
  const local = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  const candidate = local ? `${local[1]}T${local[2]}${timezoneOffset}` : raw;
  const timestamp = new Date(candidate);
  return Number.isNaN(timestamp.getTime()) ? nowIso() : timestamp.toISOString();
}

export class IcloudLinkClient {
  constructor({ db, encryptionKey, fetchFn = fetch, allowedHosts, requestTimeoutMs, timezoneOffset } = {}) {
    this.db = db;
    this.fetch = fetchFn;
    this.allowedHosts = allowedHosts || process.env.ICLOUD_LINK_ALLOWED_HOSTS || DEFAULT_ALLOWED_HOSTS;
    const configuredTimeout = Number(requestTimeoutMs ?? process.env.ICLOUD_LINK_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.requestTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.floor(configuredTimeout)
      : DEFAULT_REQUEST_TIMEOUT_MS;
    const offset = String(timezoneOffset || process.env.ICLOUD_LINK_TIMEZONE_OFFSET || DEFAULT_TIMEZONE_OFFSET);
    this.timezoneOffset = /^(?:Z|[+-]\d{2}:\d{2})$/.test(offset) ? offset : DEFAULT_TIMEZONE_OFFSET;
    this.encryptionKey = crypto.createHash("sha256")
      .update(String(encryptionKey || process.env.DATA_ENCRYPTION_KEY || "aliashub-development-key"))
      .digest();
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decrypt(value) {
    try {
      const [version, iv, tag, encrypted] = String(value || "").split(".");
      if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("invalid encrypted value");
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      throw errorWithStatus("iCloud 取件凭据无法解密", 500, "ICLOUD_LINK_DECRYPT_FAILED");
    }
  }

  async jsonRequest(url) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.requestTimeoutMs);
    try {
      const response = await this.fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw errorWithStatus("iCloud 取件服务请求失败", response.status || 502, "ICLOUD_LINK_REQUEST_FAILED");
      }
      return data;
    } catch (error) {
      if (error?.code === "ICLOUD_LINK_REQUEST_FAILED") throw error;
      if (timedOut) throw errorWithStatus(`iCloud 取件请求超时（${this.requestTimeoutMs}ms）`, 504, "ICLOUD_LINK_REQUEST_TIMEOUT");
      throw errorWithStatus("iCloud 取件服务暂时不可用", 502, "ICLOUD_LINK_REQUEST_FAILED");
    } finally {
      clearTimeout(timer);
    }
  }

  async textRequest(url) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.requestTimeoutMs);
    try {
      const response = await this.fetch(url, {
        headers: { Accept: "text/html" },
        redirect: "error",
        signal: controller.signal,
      });
      const data = await response.text().catch(() => "");
      if (!response.ok) {
        throw errorWithStatus("iCloud 取件服务请求失败", response.status || 502, "ICLOUD_LINK_REQUEST_FAILED");
      }
      return data;
    } catch (error) {
      if (error?.code === "ICLOUD_LINK_REQUEST_FAILED") throw error;
      if (timedOut) throw errorWithStatus(`iCloud 取件请求超时（${this.requestTimeoutMs}ms）`, 504, "ICLOUD_LINK_REQUEST_TIMEOUT");
      throw errorWithStatus("iCloud 取件服务暂时不可用", 502, "ICLOUD_LINK_REQUEST_FAILED");
    } finally {
      clearTimeout(timer);
    }
  }

  async listMessages(accessUrl) {
    const endpoints = endpointUrls(accessUrl);
    if (endpoints.directPage) {
      try {
        const data = await this.jsonRequest(endpoints.list);
        const items = Array.isArray(data?.items)
          ? data.items
          : (Array.isArray(data?.messages)
            ? data.messages
            : (Array.isArray(data?.data?.messages) ? data.data.messages : null));
        if (items) return items.slice(0, MAX_MESSAGES_PER_SCAN);
      } catch (error) {
        if (error?.code !== "ICLOUD_LINK_REQUEST_FAILED" || error?.status !== 404) throw error;
      }
      return messagesFromAccessPage(await this.textRequest(accessUrl));
    }
    try {
      const data = await this.jsonRequest(endpoints.list);
      const items = Array.isArray(data?.items)
        ? data.items
        : (Array.isArray(data?.data?.messages) ? data.data.messages : null);
      if (!items) {
        throw errorWithStatus("iCloud 取件服务返回了无效的邮件列表", 502, "INVALID_ICLOUD_LINK_RESPONSE");
      }
      return items.slice(0, MAX_MESSAGES_PER_SCAN);
    } catch (error) {
      if (error?.code !== "ICLOUD_LINK_REQUEST_FAILED" || error?.status !== 404) throw error;
    }
    const pageUrl = canonicalAccessUrl(new URL(accessUrl)).toString();
    return messagesFromAccessPage(await this.textRequest(pageUrl));
  }

  async importCredential(value, { accountId = null } = {}) {
    const credentials = parseIcloudLinkCredentialLine(value, { allowedHosts: this.allowedHosts });
    let account = accountId
      ? this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(accountId))
      : this.db.prepare("SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE").get(credentials.email);
    if (accountId && !account) throw errorWithStatus("源头邮箱不存在", 404, "ICLOUD_LINK_ACCOUNT_NOT_FOUND");
    if (account && (account.provider !== "icloud_link" || account.email.toLowerCase() !== credentials.email)) {
      throw errorWithStatus("这个邮箱已经绑定到其他认证提供商，请先移除原账号", 409, "ICLOUD_LINK_PROVIDER_MISMATCH");
    }

    await this.listMessages(credentials.accessUrl);
    if (!account) {
      account = createSourceAccount(this.db, {
        email: credentials.email,
        displayName: credentials.email.split("@")[0],
        provider: "icloud_link",
        officialLimit: 1,
      });
    }
    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO icloud_mailboxes (account_id, access_url_encrypted, credential_updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          access_url_encrypted = excluded.access_url_encrypted,
          credential_updated_at = excluded.credential_updated_at
      `).run(account.id, this.encrypt(credentials.accessUrl), timestamp);
      this.db.prepare("UPDATE source_accounts SET status = 'connected', updated_at = ? WHERE id = ?").run(timestamp, account.id);
      audit(this.db, account.id, "account", "iCloud 取件链接导入完成", credentials.email, { provider: "icloud_link" });
    })();
    const updated = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id);
    return { status: "connected", account: publicAccount(this.db, updated) };
  }

  async importCredentials(value, { accountId = null } = {}) {
    const lines = scalar(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw errorWithStatus("请粘贴至少一行 iCloud 取件格式", 400, "ICLOUD_LINK_CREDENTIALS_REQUIRED");
    if (lines.length > 100) throw errorWithStatus("单次最多导入 100 个 iCloud 邮箱", 400, "ICLOUD_LINK_IMPORT_LIMIT");
    if (accountId && lines.length !== 1) {
      throw errorWithStatus("更新现有邮箱时只能提交一行取件凭据", 400, "ICLOUD_LINK_UPDATE_LIMIT");
    }
    const items = [];
    for (const line of lines) {
      const email = normalizeEmail(line.split("----", 1)[0]) || "";
      try {
        const result = await this.importCredential(line, { accountId });
        items.push({ email: result.account.email, status: "connected", account: result.account });
      } catch (error) {
        items.push({ email, status: "failed", error: error.message });
      }
    }
    const importedItems = items.filter((item) => item.status === "connected");
    if (!importedItems.length) {
      throw errorWithStatus(items[0]?.error || "iCloud 邮箱导入失败", 422, "ICLOUD_LINK_IMPORT_FAILED");
    }
    return {
      status: importedItems.length === items.length ? "connected" : "partial",
      account: importedItems[0].account,
      items,
      imported: importedItems.length,
      failed: items.length - importedItems.length,
    };
  }

  credentialsFor(account) {
    const row = this.db.prepare("SELECT * FROM icloud_mailboxes WHERE account_id = ?").get(account.id);
    if (!row) throw errorWithStatus("这个 iCloud 邮箱还没有导入取件链接", 409, "ICLOUD_LINK_CREDENTIALS_REQUIRED");
    return { accessUrl: this.decrypt(row.access_url_encrypted) };
  }

  normalizeMessage(account, item, detail) {
    const detailBody = typeof detail?.html === "string" && detail.html.trim()
      ? detail.html
      : detail?.body;
    const decodedBody = decodeDataUrl(detailBody);
    const rawBody = decodedBody.slice(0, MAIL_BODY_LIMIT);
    const bodyText = htmlToText(rawBody);
    const subject = scalar(detail?.subject || item?.subject).trim() || "(无主题)";
    const senderAddress = normalizeEmail(detail?.fromAddress || detail?.from || item?.from_address)
      || scalar(detail?.fromAddress || detail?.from || item?.from_address).trim();
    const receivedAt = normalizeReceivedAt(detail?.receivedAt || item?.received_at, this.timezoneOffset);
    const messageId = scalar(item?.id).trim();
    const graphMessageId = `icloud-link:${messageId}`;
    const verificationCode = codeFromText(`${subject}\n${bodyText}`);
    const preview = bodyText.replace(/\s+/g, " ").slice(0, 500);
    const sender = senderAddress || "未知发件人";
    return {
      fingerprint: crypto.createHash("sha256").update(`${account.id}:${graphMessageId}`).digest("hex"),
      graphMessageId,
      internetMessageId: "",
      senderName: "",
      senderAddress,
      toRecipients: [],
      ccRecipients: [],
      recipients: [],
      recipient: "",
      subject,
      preview,
      body: rawBody,
      bodyContentType: detail?.html ? "html" : "text",
      bodyTruncated: decodedBody.length > MAIL_BODY_LIMIT,
      verificationCode,
      webLink: "",
      isRead: false,
      hasAttachments: false,
      receivedAt,
      codeItem: verificationCode ? {
        fingerprint: crypto.createHash("sha256").update(`${account.id}:${graphMessageId}:${verificationCode}`).digest("hex"),
        code: verificationCode,
        sender,
        subject,
        preview: preview.slice(0, 360),
        recipient: "",
        recipients: [],
        receivedAt,
      } : null,
    };
  }

  async scanInbox(account) {
    if (account.provider !== "icloud_link") {
      throw errorWithStatus("这个邮箱不是 iCloud 取件链接邮箱", 409, "ICLOUD_LINK_PROVIDER_MISMATCH");
    }
    const { accessUrl } = this.credentialsFor(account);
    const items = await this.listMessages(accessUrl);
    const endpoints = endpointUrls(accessUrl);
    const unseen = items.filter((item) => {
      const id = scalar(item?.id).trim();
      if (!id) return false;
      return !this.db.prepare("SELECT 1 FROM mail_messages WHERE account_id = ? AND graph_message_id = ?")
        .get(account.id, `icloud-link:${id}`);
    });
    const messages = await Promise.all(unseen.map(async (item) => {
      const detail = endpoints.inlineDetails ? item : await this.jsonRequest(endpoints.detail(item.id));
      return this.normalizeMessage(account, item, detail);
    }));
    return {
      stage: "completed",
      message: `发现 ${messages.length} 封新邮件，其中 ${messages.filter((item) => item.codeItem).length} 条验证码`,
      messages,
      items: messages.map((item) => item.codeItem).filter(Boolean),
    };
  }
}
