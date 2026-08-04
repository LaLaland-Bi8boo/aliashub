import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateSplits } from "../account-service.js";
import { createDatabase } from "../db.js";
import { IcloudClient, parseCredentialLine } from "../icloud-client.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

const EMAIL = "base-address@icloud.com";
const SCOPE = "test-scope-token-123456";
const ACCESS_URL = `http://apple55.top/messages/${SCOPE}/${EMAIL}`;
const CREDENTIAL = `${EMAIL}----${ACCESS_URL}`;

function json(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-icloud-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  return {
    db,
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("parses only matching allowlisted iCloud base-mailbox URLs", () => {
  assert.deepEqual(parseCredentialLine(CREDENTIAL), { email: EMAIL, accessUrl: ACCESS_URL });
  assert.throws(
    () => parseCredentialLine(`base-address+tag@icloud.com----${ACCESS_URL}`),
    (error) => error.code === "UNSUPPORTED_ICLOUD_EMAIL",
  );
  assert.throws(
    () => parseCredentialLine(`${EMAIL}----http://example.com/messages/${SCOPE}/${EMAIL}`),
    (error) => error.code === "UNTRUSTED_ICLOUD_MAIL_HOST",
  );
  assert.throws(
    () => parseCredentialLine(`${EMAIL}----http://apple55.top/messages/${SCOPE}/other@icloud.com`),
    (error) => error.code === "ICLOUD_MAIL_URL_MISMATCH",
  );
});

test("encrypts iCloud access URLs and scans new JUNK messages with base64 HTML", async () => {
  const current = fixture();
  const calls = [];
  const encoded = Buffer.from("<html><body><p>你的 ChatGPT 验证码</p><strong>654321</strong></body></html>").toString("base64");
  const icloud = new IcloudClient({
    db: current.db,
    encryptionKey: "test-key",
    fetchFn: async (url) => {
      calls.push(String(url));
      if (String(url).includes("/api/messages/")) {
        return json({ items: [{ id: 42, mailbox: "JUNK", subject: "你的临时 ChatGPT 登录代码", from_address: "notify-openai@example.test", received_at: "2026-08-04 21:50:50" }] });
      }
      if (String(url).includes("/message/42/")) {
        return json({
          body: `data:text/html;charset=utf-8;base64,${encoded}`,
          html: true,
          mailbox: "JUNK",
          subject: "你的临时 ChatGPT 登录代码",
          fromAddress: "notify-openai@example.test",
          receivedAt: "2026-08-04 21:50:50",
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  try {
    const imported = await icloud.importCredential(CREDENTIAL);
    assert.equal(imported.account.provider, "icloud");
    assert.equal(imported.account.oauth_connected, true);
    const stored = current.db.prepare("SELECT * FROM icloud_mailboxes WHERE account_id = ?").get(imported.account.id);
    assert.notEqual(stored.access_url_encrypted, ACCESS_URL);
    assert.equal(icloud.decrypt(stored.access_url_encrypted), ACCESS_URL);
    assert.doesNotMatch(JSON.stringify(current.db.prepare("SELECT * FROM audit_log").all()), /test-scope-token/);

    const account = current.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(imported.account.id);
    const first = await icloud.scanInbox(account);
    assert.equal(first.messages.length, 1);
    assert.equal(first.items[0].code, "654321");
    assert.equal(first.messages[0].receivedAt, "2026-08-04T13:50:50.000Z");
    assert.equal(first.messages[0].webLink, "");

    current.db.prepare(`
      INSERT INTO mail_messages
        (account_id, fingerprint, graph_message_id, subject, received_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(account.id, first.messages[0].fingerprint, first.messages[0].graphMessageId, first.messages[0].subject, first.messages[0].receivedAt, first.messages[0].receivedAt, first.messages[0].receivedAt);
    const second = await icloud.scanInbox(account);
    assert.equal(second.messages.length, 0);
    assert.equal(calls.filter((url) => url.includes("/message/42/")).length, 1);
  } finally {
    current.close();
  }
});

test("exposes the iCloud importer and provider dispatch through AliasHub", async () => {
  const current = fixture();
  const receivedAt = new Date(Date.now() + 5_000).toISOString();
  const runtime = createApp({
    db: current.db,
    dataEncryptionKey: "test-key",
    icloudFetchFn: async (url) => {
      if (String(url).includes("/api/messages/")) {
        return json({ items: [{ id: 81, mailbox: "JUNK", subject: "ChatGPT code 112233", received_at: receivedAt }] });
      }
      return json({ body: "Your ChatGPT verification code is 112233", subject: "ChatGPT code 112233", receivedAt });
    },
  });
  try {
    const imported = await jsonRequest(runtime.app, "/api/icloud/import", {
      method: "POST",
      body: JSON.stringify({ credential: CREDENTIAL }),
    });
    assert.equal(imported.response.status, 201);
    assert.equal(imported.body.account.provider, "icloud");
    const accounts = await jsonRequest(runtime.app, "/api/accounts");
    assert.equal(accounts.body.providers.icloud.supportsPlusAliases, true);
    const account = current.db.prepare("SELECT * FROM source_accounts WHERE provider = 'icloud'").get();
    const scan = await runtime.inbox.scanInbox(account);
    assert.equal(scan.items[0].code, "112233");
    const [split] = generateSplits(current.db, account, { countPerBase: 1, customSuffix: "registration" });
    const mailbox = await runtime.registration.externalEmails({ email: split.address });
    assert.equal(mailbox.emails[0].verification_code, "112233");
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    current.close();
  }
});
