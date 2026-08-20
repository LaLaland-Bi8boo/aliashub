import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, createSourceAccount, nowIso, setSetting } from "../db.js";
import { IcloudLinkClient, parseIcloudLinkCredentialLine } from "../icloud-link.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

const EMAIL = "base-address@icloud.com";
const SCOPE = "test-scope-token-123456";
const ACCESS_URL = `http://apple55.top/messages/${SCOPE}/${EMAIL}`;
const CANONICAL_ACCESS_URL = `https://apple55.top/messages/${SCOPE}/${EMAIL}`;
const LINLANYU_URL = `https://msg.linlanyu.com/messages/${SCOPE}/${EMAIL}`;
const ICMAIL_URL = "https://icmail.2790cake.cn/mail/djEhI0-iiJ2H6C57S_6aPiLP6gzA9iBoG-Vv1PqswRgEI9kQb0j2CX0hU7tppPW3laK0sKTgN5tDbXVZWl4Ig1t57vfDXV2RF_T4Pbu_Ub5VDpSzkeHue-Rltx3FnQ3Oe-lrHvCV2TROvcd6qsCDyS4BlgzFw-8STMiLf1FCAhLGWCNDQ_J1";
const CREDENTIAL = `${EMAIL}----${ACCESS_URL}`;

function json(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function html(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => data,
  };
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-icloud-link-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  t.after(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db };
}

test("parses legacy and arbitrary iCloud pickup URL formats", () => {
  assert.deepEqual(parseIcloudLinkCredentialLine(CREDENTIAL), {
    email: EMAIL,
    accessUrl: CANONICAL_ACCESS_URL,
  });
  assert.deepEqual(parseIcloudLinkCredentialLine(`${EMAIL}----${LINLANYU_URL}`), {
    email: EMAIL,
    accessUrl: LINLANYU_URL,
  });
  assert.deepEqual(parseIcloudLinkCredentialLine(
    `${EMAIL}----http://mailbox.test/messages/${SCOPE}/${EMAIL}`,
    { allowedHosts: "mailbox.test" },
  ), {
    email: EMAIL,
    accessUrl: `http://mailbox.test/messages/${SCOPE}/${EMAIL}`,
  });
  assert.deepEqual(parseIcloudLinkCredentialLine(`${EMAIL}----${ICMAIL_URL}`), {
    email: EMAIL,
    accessUrl: ICMAIL_URL,
  });
  assert.throws(
    () => parseIcloudLinkCredentialLine(`base-address+tag@icloud.com----${ACCESS_URL}`),
    (error) => error.code === "UNSUPPORTED_ICLOUD_LINK_EMAIL",
  );
  assert.deepEqual(parseIcloudLinkCredentialLine(
    `${EMAIL}----https://example.com/mail/random-token?source=icloud#inbox`,
  ), {
    email: EMAIL,
    accessUrl: "https://example.com/mail/random-token?source=icloud#inbox",
  });
  assert.throws(
    () => parseIcloudLinkCredentialLine(`${EMAIL}----http://apple55.top/messages/${SCOPE}/other@icloud.com`),
    (error) => error.code === "ICLOUD_LINK_URL_MISMATCH",
  );
});

test("imports arbitrary pickup pages with JSON message lists", async (t) => {
  const { db } = fixture(t);
  const client = new IcloudLinkClient({
    db,
    encryptionKey: "test-key",
    fetchFn: async (url) => {
      assert.equal(String(url), ICMAIL_URL);
      return json({ items: [{ id: "mail-1", subject: "ChatGPT code 445566", body: "Use 445566" }] });
    },
  });
  const imported = await client.importCredential(`${EMAIL}----${ICMAIL_URL}`);
  const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(imported.account.id);
  const scanned = await client.scanInbox(account);
  assert.equal(scanned.items[0].code, "445566");
});

test("imports direct single-message JSON pickup links", async (t) => {
  const { db } = fixture(t);
  const client = new IcloudLinkClient({
    db,
    encryptionKey: "test-key",
    fetchFn: async () => json({
      email: EMAIL,
      found: true,
      message: {
        uid: "icmail-uid-1",
        code: "926423",
        subject: "Your temporary ChatGPT verification code",
        text: "Your verification code is 926423",
        html: "<p>Your verification code is <strong>926423</strong></p>",
        from: "noreply@openai.com",
        timestamp: "2026-08-20T14:59:08.000Z",
      },
    }),
  });
  const imported = await client.importCredential(`${EMAIL}----${ICMAIL_URL}`);
  const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(imported.account.id);
  const scanned = await client.scanInbox(account);
  assert.equal(scanned.items[0].code, "926423");
  assert.equal(scanned.messages[0].senderAddress, "noreply@openai.com");
});

test("encrypts iCloud access URLs and scans base64 HTML without using registration proxy options", async (t) => {
  const { db } = fixture(t);
  const calls = [];
  const encoded = Buffer.from("<html><body><p>你的 ChatGPT 验证码</p><strong>654321</strong></body></html>").toString("base64");
  const client = new IcloudLinkClient({
    db,
    encryptionKey: "test-key",
    fetchFn: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/api/messages/")) {
        return json({ items: [{ id: 42, subject: "你的临时 ChatGPT 登录代码", received_at: "2026-08-04 21:50:50" }] });
      }
      if (String(url).includes("/message/42/")) {
        return json({
          body: `data:text/html;charset=utf-8;base64,${encoded}`,
          html: true,
          subject: "你的临时 ChatGPT 登录代码",
          fromAddress: "notify-openai@example.test",
          receivedAt: "2026-08-04 21:50:50",
        });
      }
      throw new Error("Unexpected iCloud link request");
    },
  });

  const imported = await client.importCredential(CREDENTIAL);
  assert.equal(imported.account.provider, "icloud_link");
  assert.equal(imported.account.credential_connected, true);
  assert.equal(imported.account.oauth_connected, false);
  const stored = db.prepare("SELECT * FROM icloud_mailboxes WHERE account_id = ?").get(imported.account.id);
  assert.notEqual(stored.access_url_encrypted, ACCESS_URL);
  assert.equal(client.decrypt(stored.access_url_encrypted), CANONICAL_ACCESS_URL);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM audit_log").all()), /test-scope-token/);

  const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(imported.account.id);
  const scan = await client.scanInbox(account);
  assert.equal(scan.items[0].code, "654321");
  assert.equal(scan.messages[0].receivedAt, "2026-08-04T13:50:50.000Z");
  assert.ok(calls.every(({ options }) => !("agent" in options) && !("dispatcher" in options) && !("proxy" in options)));
  assert.ok(calls.every(({ url }) => url.startsWith("https://apple55.top/")));
  assert.ok(calls.some(({ url }) => new URL(url).pathname === `/api/messages/${SCOPE}/${EMAIL}`));
  assert.ok(calls.some(({ url }) => new URL(url).pathname === `/message/42/${SCOPE}/${EMAIL}`));
  assert.ok(calls.every(({ options }) => options.redirect === "error"));
});

test("falls back to the server-rendered mailbox page when the legacy list API returns 404", async (t) => {
  const { db } = fixture(t);
  const calls = [];
  const client = new IcloudLinkClient({
    db,
    encryptionKey: "test-key",
    fetchFn: async (url, options) => {
      const parsed = new URL(url);
      calls.push({ url: String(url), options });
      if (parsed.pathname.startsWith("/api/messages/")) return json({}, 404);
      if (parsed.pathname.startsWith("/messages/")) {
        return html(`<!doctype html><div class="list" id="message-list">
          <a class="item active" href="#mail-73" data-id="73">
            <div class="subject">OpenAI code &amp; notice <span>(spam)</span></div>
            <div class="time">2026-08-07 15:47:55</div>
            <div class="from">noreply@example.test</div>
          </a>
        </div>`);
      }
      if (parsed.pathname === `/message/73/${SCOPE}/${EMAIL}`) {
        return json({
          body: "Your OpenAI verification code is 778899",
          subject: "OpenAI code & notice",
          fromAddress: "noreply@example.test",
          receivedAt: "2026-08-07 15:47:55",
        });
      }
      throw new Error(`Unexpected request: ${parsed.pathname}`);
    },
  });

  const imported = await client.importCredential(CREDENTIAL);
  const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(imported.account.id);
  const scan = await client.scanInbox(account);
  assert.equal(scan.items[0].code, "778899");
  assert.equal(scan.messages[0].senderAddress, "noreply@example.test");
  assert.ok(calls.some(({ options }) => options.headers.Accept === "text/html"));
  assert.ok(calls.every(({ options }) => options.redirect === "error"));
});

test("reads linlanyu query API messages and uses their inline bodies", async (t) => {
  const { db } = fixture(t);
  const email = "linlanyu-source@icloud.com";
  const token = "linlanyu-test-token-1234567890";
  const accessUrl = `https://msg.linlanyu.com/messages/${token}/${email}`;
  const calls = [];
  const client = new IcloudLinkClient({
    db,
    encryptionKey: "test-key",
    fetchFn: async (url, options) => {
      const parsed = new URL(url);
      calls.push({ parsed, options });
      assert.equal(parsed.pathname, "/api/messages");
      assert.equal(parsed.searchParams.get("email"), email);
      assert.equal(parsed.searchParams.get("token"), token);
      assert.equal(parsed.searchParams.get("limit"), "100");
      return json({
        success: true,
        data: {
          count: 1,
          messages: [{
            id: "linlanyu-message-1",
            from: "noreply@openai.com",
            subject: "Your ChatGPT verification code",
            body: "Use code 654321 to continue.",
            html: "<p>Use code <strong>654321</strong> to continue.</p>",
            receivedAt: "2026-08-08T15:40:00.000Z",
          }],
        },
      });
    },
  });

  const imported = await client.importCredential(`${email}----${accessUrl}`);
  const account = db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(imported.account.id);
  const scanned = await client.scanInbox(account);

  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ options }) => options.redirect === "error"));
  assert.equal(scanned.messages.length, 1);
  assert.equal(scanned.messages[0].senderAddress, "noreply@openai.com");
  assert.equal(scanned.messages[0].verificationCode, "654321");
  assert.match(scanned.messages[0].body, /<strong>654321<\/strong>/);
});

test("accepts a valid server-rendered mailbox page before its first message arrives", async (t) => {
  const { db } = fixture(t);
  const client = new IcloudLinkClient({
    db,
    encryptionKey: "test-key",
    fetchFn: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith("/api/messages/")) return json({}, 404);
      if (parsed.pathname.startsWith("/messages/")) {
        return html(`<!doctype html><html><head><title>${EMAIL} 全部邮件</title></head><body>
          <main><div class="layout"><aside class="card"><div class="top">
            <h2>${EMAIL}</h2><div>全部邮件（共 0 封）</div>
          </div><div class="placeholder">暂时没有同步到这个子邮箱的邮件。</div></aside>
          <section><article id="mail-view">请选择一封邮件</article></section></div></main>
        </body></html>`);
      }
      throw new Error(`Unexpected request: ${parsed.pathname}`);
    },
  });

  const imported = await client.importCredential(CREDENTIAL);
  assert.equal(imported.status, "connected");
  assert.equal(imported.account.email, EMAIL);
});

test("rejects unrelated HTML returned for an iCloud pickup link", async (t) => {
  const { db } = fixture(t);
  const client = new IcloudLinkClient({
    db,
    encryptionKey: "test-key",
    fetchFn: async (url) => new URL(url).pathname.startsWith("/api/messages/")
      ? json({}, 404)
      : html("<!doctype html><title>Service unavailable</title><p>Please retry later</p>"),
  });

  await assert.rejects(
    () => client.importCredential(CREDENTIAL),
    (error) => error.code === "INVALID_ICLOUD_LINK_RESPONSE",
  );
});

test("migrates legacy link-backed iCloud accounts without touching official IMAP accounts", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-icloud-link-migration-test-"));
  const filename = path.join(directory, "test.db");
  let db = createDatabase({ filename, seedDemo: false });
  const linked = createSourceAccount(db, { email: "linked@icloud.com", provider: "icloud" });
  const official = createSourceAccount(db, { email: "official@example.com", provider: "icloud" });
  db.prepare("INSERT INTO icloud_mailboxes (account_id, access_url_encrypted, credential_updated_at) VALUES (?, ?, ?)")
    .run(linked.id, "legacy-encrypted-link", nowIso());
  db.prepare("INSERT INTO icloud_credentials (account_id, username, app_password_encrypted, credential_updated_at) VALUES (?, ?, ?, ?)")
    .run(official.id, "official@icloud.com", "encrypted-password", nowIso());
  db.close();

  db = createDatabase({ filename, seedDemo: false });
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(db.prepare("SELECT provider FROM source_accounts WHERE id = ?").get(linked.id).provider, "icloud_link");
  assert.equal(db.prepare("SELECT provider FROM source_accounts WHERE id = ?").get(official.id).provider, "icloud");
  assert.equal(db.prepare("SELECT access_url_encrypted FROM icloud_mailboxes WHERE account_id = ?").get(linked.id).access_url_encrypted, "legacy-encrypted-link");
});

test("imports link mailboxes, generates plus aliases, serializes registration, and exposes unassigned codes", async (t) => {
  const { db } = fixture(t);
  setSetting(db, "registration_connector_key", "test-connector-key");
  const receivedAt = new Date(Date.now() + 5_000).toISOString();
  const registrationClient = {
    created: [],
    async health() { return { ok: true, configured: true }; },
    async createTask(payload) {
      this.created.push(payload);
      return { task_id: `task-${this.created.length}` };
    },
  };
  const runtime = createApp({
    db,
    dataEncryptionKey: "test-key",
    registrationClient,
    publicBaseUrl: "https://alias.test",
    icloudLinkFetchFn: async (url) => {
      if (String(url).includes("/api/messages/")) {
        return json({ items: [{ id: 81, subject: "ChatGPT code 112233", received_at: receivedAt }] });
      }
      return json({ body: "Your ChatGPT verification code is 112233", subject: "ChatGPT code 112233", receivedAt });
    },
  });

  const imported = await jsonRequest(runtime.app, "/api/icloud-link/import", {
    method: "POST",
    body: JSON.stringify({ credential: CREDENTIAL }),
  });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.body.account.provider, "icloud_link");
  assert.doesNotMatch(JSON.stringify(imported.body), /test-scope-token/);

  const accounts = await jsonRequest(runtime.app, "/api/accounts");
  assert.equal(accounts.body.providers.icloud.supportsPlusAliases, false);
  assert.equal(accounts.body.providers.icloud_link.supportsPlusAliases, true);
  const account = db.prepare("SELECT * FROM source_accounts WHERE provider = 'icloud_link'").get();
  const base = db.prepare("SELECT * FROM addresses WHERE account_id = ? AND kind = 'primary'").get(account.id);
  const jobs = await runtime.registration.createJobs({
    accountId: account.id,
    baseAddressId: base.id,
    count: 2,
    proxySelection: "direct",
    browserMode: "headless",
  });
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => /^base-address\+gpt-[a-z0-9]+@icloud\.com$/.test(job.email)));
  assert.equal(registrationClient.created.length, 2);
  const serialKeys = new Set(registrationClient.created.map((task) => task.extra.registration_serial_key));
  assert.equal(serialKeys.size, 1);
  assert.match([...serialKeys][0], /^icloud-link:[a-f0-9]{24}$/);
  assert.ok(registrationClient.created.every((task) => task.extra.mail_source_provider === "icloud_link"));
  assert.doesNotMatch(JSON.stringify(registrationClient.created), /test-scope-token/);

  const mailbox = await runtime.registration.externalEmails({ email: jobs[0].email });
  assert.equal(mailbox.emails[0].verification_code, "112233");
  assert.equal(db.prepare("SELECT address_id FROM mail_messages WHERE account_id = ?").get(account.id).address_id, null);
});
