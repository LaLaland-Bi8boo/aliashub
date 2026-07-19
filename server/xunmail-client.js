import crypto from "node:crypto";
import { publicAccount } from "./account-service.js";
import { codeFromText, normalizeMicrosoftEmail } from "./address-generator.js";
import { audit, createSourceAccount, nowIso } from "./db.js";

const DEFAULT_BASE_URL = "https://www.xunmail.cn";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAIL_BODY_LIMIT = 100_000;
const EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/gi;

function errorWithStatus(message, status = 502, code = "XUNMAIL_ERROR") {
  return Object.assign(new Error(message), { status, code });
}

function scalar(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function firstValue(...values) {
  return values.map(scalar).find((value) => value.trim())?.trim() || "";
}

function emailFrom(value) {
  const matches = scalar(value).match(EMAIL_PATTERN) || [];
  return matches.map((item) => normalizeMicrosoftEmail(item)).find(Boolean) || "";
}

function addressesFrom(value) {
  const values = Array.isArray(value) ? value : [value];
  const output = [];
  values.forEach((item) => {
    const name = typeof item === "object" && item ? firstValue(item.name, item.displayName) : "";
    const address = emailFrom(typeof item === "object" && item ? firstValue(item.address, item.email, item.emailAddress) : item);
    if (address && !output.some((entry) => entry.address === address)) output.push({ name, address });
  });
  return output;
}

function parseCredentialLine(value) {
  const raw = scalar(value).trim();
  const parts = raw.split("----");
  if (parts.length < 4) {
    throw errorWithStatus("Xunmail 格式应为：邮箱----密码----client_id----refresh_token", 400, "INVALID_XUNMAIL_FORMAT");
  }
  const email = normalizeMicrosoftEmail(parts.shift());
  const password = parts.shift().trim();
  const clientId = parts.shift().trim();
  const refreshToken = parts.join("----").trim().replace(/[\uFF01-\uFF5E]/g, (character) => (
    String.fromCharCode(character.charCodeAt(0) - 0xfee0)
  ));
  if (!email) throw errorWithStatus("只支持 Outlook、Hotmail、Live 和 MSN 邮箱", 422, "UNSUPPORTED_XUNMAIL_EMAIL");
  if (!password) throw errorWithStatus("Xunmail 格式中的密码字段不能为空", 400, "INVALID_XUNMAIL_FORMAT");
  if (!clientId || !refreshToken) throw errorWithStatus("client_id 和 refresh_token 不能为空", 400, "INVALID_XUNMAIL_FORMAT");
  return { email, clientId, refreshToken };
}

function tokenFrom(data) {
  return firstValue(data?.refresh_token, data?.refreshToken, data?.data?.refresh_token, data?.data?.refreshToken);
}

function mailArray(data) {
  if (Array.isArray(data?.mails)) return data.mails;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.inbox)) return data.inbox;
  if (Array.isArray(data?.data?.mails)) return data.data.mails;
  return [];
}

export class XunmailClient {
  constructor({ db, encryptionKey, fetchFn = fetch, baseUrl, requestTimeoutMs } = {}) {
    this.db = db;
    this.fetch = fetchFn;
    this.baseUrl = String(baseUrl || process.env.XUNMAIL_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const configuredTimeout = Number(requestTimeoutMs ?? process.env.XUNMAIL_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.requestTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.floor(configuredTimeout)
      : DEFAULT_REQUEST_TIMEOUT_MS;
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
    const [version, iv, tag, encrypted] = String(value || "").split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) throw errorWithStatus("Xunmail Token 无法解密", 500, "TOKEN_DECRYPT_FAILED");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  }

  async jsonRequest(pathname, body) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      return { response, data };
    } catch (error) {
      if (timedOut) throw errorWithStatus(`Xunmail 请求超时（${this.requestTimeoutMs}ms）`, 504, "XUNMAIL_REQUEST_TIMEOUT");
      throw errorWithStatus(`Xunmail 请求失败：${error.message}`, 502, "XUNMAIL_REQUEST_FAILED");
    } finally {
      clearTimeout(timer);
    }
  }

  requestBody(credentials, extra = {}) {
    return {
      email: credentials.email,
      client_id: credentials.clientId,
      refresh_token: credentials.refreshToken,
      ...extra,
    };
  }

  async mailCount(credentials) {
    return this.jsonRequest("/api/graph/mail-count", this.requestBody(credentials, { mailbox: "INBOX" }));
  }

  async refreshRemoteToken(credentials) {
    const result = await this.jsonRequest("/api/graph/refresh-token", {
      client_id: credentials.clientId,
      refresh_token: credentials.refreshToken,
    });
    const next = tokenFrom(result.data);
    if (!result.response.ok || result.data?.success === false || !next) {
      throw errorWithStatus(result.data?.error || "Xunmail Token 刷新失败", result.response.status || 502, "XUNMAIL_TOKEN_REFRESH_FAILED");
    }
    return next;
  }

  async importCredential(value) {
    const credentials = parseCredentialLine(value);
    credentials.refreshToken = await this.refreshRemoteToken(credentials);
    const countResult = await this.mailCount(credentials);
    if (!countResult.response.ok || countResult.data?.success === false || countResult.data?.error) {
      throw errorWithStatus(countResult.data?.error || "Xunmail 无法验证这组邮箱凭据", countResult.response.status || 502, "XUNMAIL_CREDENTIALS_REJECTED");
    }
    const nextToken = tokenFrom(countResult.data) || credentials.refreshToken;
    let account = this.db.prepare("SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE").get(credentials.email);
    if (account && account.provider !== "xunmail") {
      throw errorWithStatus("这个邮箱已经绑定到其他认证提供商，请先移除原账号", 409, "OAUTH_PROVIDER_MISMATCH");
    }
    if (!account) account = createSourceAccount(this.db, { email: credentials.email, displayName: credentials.email.split("@")[0], provider: "xunmail", officialLimit: 1 });
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO xunmail_tokens (account_id, client_id, refresh_token_encrypted, token_updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          client_id = excluded.client_id,
          refresh_token_encrypted = excluded.refresh_token_encrypted,
          token_updated_at = excluded.token_updated_at
      `).run(account.id, credentials.clientId, this.encrypt(nextToken), now);
      this.db.prepare("UPDATE source_accounts SET status = 'connected', updated_at = ? WHERE id = ?").run(now, account.id);
      audit(this.db, account.id, "account", "Xunmail 格式导入完成", credentials.email, { provider: "xunmail_graph" });
    })();
    return { status: "connected", account: publicAccount(this.db, this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id)) };
  }

  async importCredentials(value) {
    const lines = scalar(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw errorWithStatus("请粘贴至少一行 Xunmail 格式凭据", 400, "XUNMAIL_CREDENTIALS_REQUIRED");
    if (lines.length > 100) throw errorWithStatus("单次最多导入 100 个 Xunmail 邮箱", 400, "XUNMAIL_IMPORT_LIMIT");
    const items = [];
    for (const line of lines) {
      const email = normalizeMicrosoftEmail(line.split("----", 1)[0]) || "";
      try {
        const result = await this.importCredential(line);
        items.push({ email: result.account.email, status: "connected", account: result.account });
      } catch (error) {
        items.push({ email, status: "failed", error: error.message });
      }
    }
    const importedItems = items.filter((item) => item.status === "connected");
    if (!importedItems.length) throw errorWithStatus(items[0]?.error || "Xunmail 邮箱导入失败", 422, "XUNMAIL_IMPORT_FAILED");
    return {
      status: importedItems.length === items.length ? "connected" : "partial",
      account: importedItems[0].account,
      items,
      imported: importedItems.length,
      failed: items.length - importedItems.length,
    };
  }

  credentialsFor(account) {
    const token = this.db.prepare("SELECT * FROM xunmail_tokens WHERE account_id = ?").get(account.id);
    if (!token) throw errorWithStatus("这个 Xunmail 邮箱还没有导入凭据", 409, "XUNMAIL_CREDENTIALS_REQUIRED");
    return { email: account.email, clientId: token.client_id, refreshToken: this.decrypt(token.refresh_token_encrypted) };
  }

  async refreshStoredToken(account, credentials) {
    const nextToken = await this.refreshRemoteToken(credentials);
    this.db.prepare("UPDATE xunmail_tokens SET refresh_token_encrypted = ?, token_updated_at = ? WHERE account_id = ?")
      .run(this.encrypt(nextToken), nowIso(), account.id);
    credentials.refreshToken = nextToken;
    return credentials;
  }

  async fetchAll(credentials) {
    return this.jsonRequest("/api/graph/mail-all", this.requestBody(credentials, { mailbox: "INBOX", top: 100 }));
  }

  normalizeMail(account, mail, index) {
    const senderObject = mail?.from || mail?.sender || {};
    const senderName = firstValue(senderObject?.name, senderObject?.displayName, mail?.sender_name, mail?.from_name);
    const senderAddress = emailFrom(firstValue(senderObject?.address, senderObject?.email, mail?.sender_email, mail?.from_email, mail?.sender));
    const toRecipients = addressesFrom(mail?.to || mail?.to_recipients || mail?.recipients || mail?.recipient);
    const ccRecipients = addressesFrom(mail?.cc || mail?.cc_recipients);
    const recipients = [...new Set([...toRecipients, ...ccRecipients].map((item) => item.address).filter(Boolean))];
    const recipient = recipients.find((value) => normalizeMicrosoftEmail(value)) || "";
    const subject = firstValue(mail?.subject, mail?.title) || "(无主题)";
    const rawBody = firstValue(mail?.body, mail?.content, mail?.text, mail?.html, mail?.body_text);
    const body = rawBody.slice(0, MAIL_BODY_LIMIT);
    const preview = firstValue(mail?.preview, mail?.snippet, body).replace(/\s+/g, " ").slice(0, 500);
    const receivedAt = firstValue(mail?.received_at, mail?.receivedAt, mail?.date, mail?.created_at) || nowIso();
    const suppliedId = firstValue(mail?.id, mail?.message_id, mail?.internet_message_id, mail?.uid);
    const graphMessageId = suppliedId || `xunmail-${crypto.createHash("sha256").update(`${subject}\n${receivedAt}\n${senderAddress}\n${body}`).digest("hex")}`;
    const verificationCode = firstValue(mail?.verification_code, mail?.verificationCode) || codeFromText(`${subject}\n${preview}\n${body}`);
    const sender = senderName || senderAddress || "未知发件人";
    return {
      fingerprint: crypto.createHash("sha256").update(`${account.id}:${graphMessageId}`).digest("hex"),
      graphMessageId,
      internetMessageId: firstValue(mail?.internet_message_id, mail?.message_id),
      senderName,
      senderAddress,
      toRecipients,
      ccRecipients,
      recipients,
      recipient,
      subject,
      preview,
      body,
      bodyContentType: firstValue(mail?.body_content_type, mail?.content_type) || "text",
      bodyTruncated: rawBody.length > MAIL_BODY_LIMIT,
      verificationCode,
      webLink: firstValue(mail?.web_link, mail?.webLink),
      isRead: Boolean(mail?.is_read ?? mail?.isRead ?? false),
      hasAttachments: Boolean(mail?.has_attachments ?? mail?.hasAttachments ?? false),
      receivedAt,
      codeItem: verificationCode ? {
        fingerprint: crypto.createHash("sha256").update(`${account.id}:${graphMessageId}:${verificationCode}`).digest("hex"),
        code: verificationCode,
        sender,
        subject,
        preview: preview.slice(0, 360),
        recipient,
        recipients,
        receivedAt,
      } : null,
    };
  }

  async scanInbox(account) {
    if (account.provider !== "xunmail") throw errorWithStatus("这个邮箱不是 Xunmail 邮箱", 409, "OAUTH_PROVIDER_MISMATCH");
    let credentials = this.credentialsFor(account);
    let result = await this.fetchAll(credentials);
    if (!result.response.ok && [401, 403].includes(result.response.status)) {
      credentials = await this.refreshStoredToken(account, credentials);
      result = await this.fetchAll(credentials);
    }
    if (!result.response.ok || result.data?.success === false || result.data?.error) {
      if ([401, 403].includes(result.response.status)) this.db.prepare("UPDATE source_accounts SET status = 'action_required', updated_at = ? WHERE id = ?").run(nowIso(), account.id);
      throw errorWithStatus(result.data?.error || "Xunmail 无法读取收件箱", result.response.status || 502, "MAIL_READ_FAILED");
    }
    const rotatedToken = tokenFrom(result.data);
    if (rotatedToken && rotatedToken !== credentials.refreshToken) {
      this.db.prepare("UPDATE xunmail_tokens SET refresh_token_encrypted = ?, token_updated_at = ? WHERE account_id = ?")
        .run(this.encrypt(rotatedToken), nowIso(), account.id);
    }
    const messages = mailArray(result.data).map((mail, index) => this.normalizeMail(account, mail, index));
    return {
      stage: "completed",
      message: `发现 ${messages.length} 封邮件，其中 ${messages.filter((item) => item.codeItem).length} 条验证码`,
      messages,
      items: messages.map((item) => item.codeItem).filter(Boolean),
    };
  }
}

export { parseCredentialLine };
