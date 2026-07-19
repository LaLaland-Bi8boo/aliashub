import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../db.js";
import { createApp } from "../index.js";
import { XunmailClient, parseCredentialLine } from "../xunmail-client.js";
import { jsonRequest } from "./http-harness.js";

const EMAIL = "source@outlook.com";
const PASSWORD = "mail-password";
const CLIENT_ID = "client-id";
const REFRESH_TOKEN = "refresh-token";
const CREDENTIAL = `${EMAIL}----${PASSWORD}----${CLIENT_ID}----${REFRESH_TOKEN}`;

function json(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-xunmail-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  return {
    db,
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("parses the four-part Xunmail format without retaining the password", () => {
  assert.deepEqual(parseCredentialLine(CREDENTIAL), {
    email: EMAIL,
    clientId: CLIENT_ID,
    refreshToken: REFRESH_TOKEN,
  });
  assert.throws(() => parseCredentialLine(`${EMAIL}----${PASSWORD}`), (error) => error.code === "INVALID_XUNMAIL_FORMAT");
});

test("validates Xunmail credentials and stores only an encrypted Graph refresh token", async () => {
  const current = fixture();
  const calls = [];
  const xunmail = new XunmailClient({
    db: current.db,
    encryptionKey: "test-key",
    fetchFn: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return json({ count: 4, refresh_token: "rotated-token" });
    },
  });
  try {
    const result = await xunmail.importCredential(CREDENTIAL);
    assert.equal(result.account.email, EMAIL);
    assert.equal(result.account.provider, "xunmail");
    assert.equal(result.account.oauth_connected, true);
    assert.equal(result.account.supports_official_aliases, false);
    assert.equal(calls[0].url, "https://www.xunmail.cn/api/graph/mail-count");
    assert.deepEqual(calls[0].body, {
      email: EMAIL,
      client_id: CLIENT_ID,
      refresh_token: REFRESH_TOKEN,
      mailbox: "INBOX",
    });
    assert.equal(Object.values(calls[0].body).includes(PASSWORD), false);

    const token = current.db.prepare("SELECT * FROM xunmail_tokens WHERE account_id = ?").get(result.account.id);
    assert.equal(token.client_id, CLIENT_ID);
    assert.notEqual(token.refresh_token_encrypted, "rotated-token");
    assert.equal(xunmail.decrypt(token.refresh_token_encrypted), "rotated-token");
    const stored = JSON.stringify({
      accounts: current.db.prepare("SELECT * FROM source_accounts").all(),
      tokens: current.db.prepare("SELECT * FROM xunmail_tokens").all(),
      audit: current.db.prepare("SELECT * FROM audit_log").all(),
    });
    assert.equal(stored.includes(PASSWORD), false);
  } finally {
    current.close();
  }
});

test("scans Xunmail Graph mail into the existing message and verification-code shape", async () => {
  const current = fixture();
  let call = 0;
  const xunmail = new XunmailClient({
    db: current.db,
    encryptionKey: "test-key",
    fetchFn: async (url) => {
      call += 1;
      if (String(url).endsWith("/mail-count")) return json({ count: 1 });
      if (String(url).endsWith("/mail-all")) {
        return json({
          refresh_token: "mail-rotated-token",
          mails: [{
            id: "message-1",
            subject: "Your verification code is 654321",
            body: "Enter 654321 to continue.",
            sender: "Service <service@example.com>",
            to: [EMAIL],
            received_at: "2026-07-19T09:00:00.000Z",
          }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  try {
    const imported = await xunmail.importCredential(CREDENTIAL);
    const account = current.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(imported.account.id);
    const result = await xunmail.scanInbox(account);
    assert.equal(call, 2);
    assert.equal(result.messages.length, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.messages[0].graphMessageId, "message-1");
    assert.equal(result.messages[0].verificationCode, "654321");
    assert.equal(result.items[0].code, "654321");
    const token = current.db.prepare("SELECT * FROM xunmail_tokens WHERE account_id = ?").get(account.id);
    assert.equal(xunmail.decrypt(token.refresh_token_encrypted), "mail-rotated-token");
  } finally {
    current.close();
  }
});

test("refreshes an expired Xunmail token once and retries the inbox request", async () => {
  const current = fixture();
  let mailAttempts = 0;
  const xunmail = new XunmailClient({
    db: current.db,
    encryptionKey: "test-key",
    fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      if (String(url).endsWith("/mail-count")) return json({ count: 0 });
      if (String(url).endsWith("/refresh-token")) {
        assert.equal(body.refresh_token, REFRESH_TOKEN);
        return json({ success: true, refresh_token: "new-refresh-token" });
      }
      if (String(url).endsWith("/mail-all")) {
        mailAttempts += 1;
        return mailAttempts === 1 ? json({ error: "expired" }, 401) : json({ mails: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  try {
    const imported = await xunmail.importCredential(CREDENTIAL);
    const account = current.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(imported.account.id);
    const result = await xunmail.scanInbox(account);
    assert.equal(mailAttempts, 2);
    assert.deepEqual(result.messages, []);
    const token = current.db.prepare("SELECT * FROM xunmail_tokens WHERE account_id = ?").get(account.id);
    assert.equal(xunmail.decrypt(token.refresh_token_encrypted), "new-refresh-token");
  } finally {
    current.close();
  }
});

test("exposes the Xunmail importer through the authenticated AliasHub API", async () => {
  const current = fixture();
  const runtime = createApp({
    db: current.db,
    dataEncryptionKey: "test-key",
    xunmailFetchFn: async () => json({ count: 2 }),
  });
  try {
    const imported = await jsonRequest(runtime.app, "/api/xunmail/import", {
      method: "POST",
      body: JSON.stringify({ credential: CREDENTIAL }),
    });
    assert.equal(imported.response.status, 201);
    assert.equal(imported.body.account.provider, "xunmail");
    assert.equal(imported.body.imported, 1);
    assert.equal(imported.body.failed, 0);
    const accounts = await jsonRequest(runtime.app, "/api/accounts");
    assert.equal(accounts.body.items[0].email, EMAIL);
    assert.equal(accounts.body.providers.xunmail.supportsPlusAliases, true);
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    current.close();
  }
});

test("imports multiple Xunmail lines without exposing their password fields", async () => {
  const current = fixture();
  const seen = [];
  const xunmail = new XunmailClient({
    db: current.db,
    encryptionKey: "test-key",
    fetchFn: async (_url, options) => {
      const body = JSON.parse(options.body);
      seen.push(body);
      return json({ count: 0 });
    },
  });
  const second = "second@hotmail.com----second-password----second-client----second-token";
  try {
    const result = await xunmail.importCredentials(`${CREDENTIAL}\n${second}`);
    assert.equal(result.imported, 2);
    assert.equal(result.failed, 0);
    assert.equal(current.db.prepare("SELECT COUNT(*) AS count FROM source_accounts").get().count, 2);
    assert.equal(JSON.stringify(seen).includes(PASSWORD), false);
    assert.equal(JSON.stringify(seen).includes("second-password"), false);
  } finally {
    current.close();
  }
});
