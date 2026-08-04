import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, createSourceAccount, nowIso } from "../db.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

const ACCESS_TOKEN = "test-access-token-secret";
const SESSION_TOKEN = "test-session-token-secret";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-token-backup-test-"));
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  return {
    db,
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("captures encrypted registration tokens and exposes them only through explicit export", async () => {
  const current = fixture();
  const account = {
    id: 27,
    platform: "chatgpt",
    email: "registered@example.com",
    user_id: "user-27",
    credentials: [
      { key: "access_token", value: ACCESS_TOKEN },
      { key: "session_token", value: SESSION_TOKEN },
      { key: "account_id", value: "workspace-27" },
    ],
    display_status: "registered",
    plan_state: "free",
    created_at: nowIso(),
  };
  let remoteAvailable = true;
  let deleted = false;
  const client = {
    async listAccounts() {
      if (!remoteAvailable) throw new Error("remote unavailable");
      return { total: deleted ? 0 : 1, items: deleted ? [] : [account] };
    },
    async getAccount() {
      if (!remoteAvailable) throw new Error("remote unavailable");
      return deleted ? null : account;
    },
    async deleteAccount() {
      deleted = true;
      return { ok: true };
    },
  };
  const timestamp = nowIso();
  current.db.prepare(`
    INSERT INTO registration_jobs
      (email, external_task_id, external_account_id, status, stage, created_at, updated_at, finished_at)
    VALUES (?, ?, ?, 'completed', 'completed', ?, ?, ?)
  `).run(account.email, "task-27", String(account.id), timestamp, timestamp, timestamp);
  const runtime = createApp({
    db: current.db,
    registrationClient: client,
    dataEncryptionKey: "backup-test-key",
  });
  try {
    const list = await jsonRequest(runtime.app, "/api/registration/accounts");
    assert.equal(list.response.status, 200);
    assert.equal(list.body.items[0].token_backup_available, true);
    assert.doesNotMatch(JSON.stringify(list.body), new RegExp(`${ACCESS_TOKEN}|${SESSION_TOKEN}`));

    const stored = current.db.prepare("SELECT * FROM registered_account_backups WHERE external_account_id = ?").get(String(account.id));
    assert.ok(stored);
    assert.notEqual(stored.access_token_encrypted, ACCESS_TOKEN);
    assert.notEqual(stored.session_token_encrypted, SESSION_TOKEN);
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(`${ACCESS_TOKEN}|${SESSION_TOKEN}`));

    remoteAvailable = false;
    const copied = await jsonRequest(runtime.app, `/api/registration/accounts/${account.id}/access-token`);
    assert.equal(copied.response.status, 200);
    assert.equal(copied.body.access_token, ACCESS_TOKEN);

    const exported = await jsonRequest(runtime.app, "/api/registration/accounts/token-backup");
    assert.equal(exported.response.status, 200);
    assert.equal(exported.response.headers["cache-control"], "no-store");
    assert.match(exported.response.headers["content-disposition"], /attachment/);
    assert.deepEqual(exported.body.accounts[0], {
      external_account_id: String(account.id),
      email: account.email,
      access_token: ACCESS_TOKEN,
      session_token: SESSION_TOKEN,
      user_id: account.user_id,
      account_id: "workspace-27",
      captured_at: stored.captured_at,
      updated_at: stored.updated_at,
    });

    const selected = await jsonRequest(runtime.app, "/api/registration/accounts/token-backup?ids=27");
    assert.equal(selected.response.status, 200);
    assert.equal(selected.body.accounts.length, 1);
    assert.equal(selected.body.accounts[0].external_account_id, "27");

    const invalidSelection = await jsonRequest(runtime.app, "/api/registration/accounts/token-backup?ids=invalid");
    assert.equal(invalidSelection.response.status, 400);
    assert.equal(invalidSelection.body.error, "请选择有效的注册账号");

    assert.throws(
      () => runtime.registration.persistRegisteredAccountBackup({ ...account, email: "different@example.com" }),
      (error) => error.code === "ACCOUNT_BACKUP_IDENTITY_MISMATCH",
    );

    remoteAvailable = true;
    const removed = await jsonRequest(runtime.app, `/api/registration/accounts/${account.id}`, { method: "DELETE" });
    assert.equal(removed.response.status, 200);
    assert.equal(removed.body.deleted, 1);
    assert.equal(current.db.prepare("SELECT COUNT(*) AS count FROM registered_account_backups").get().count, 0);
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    current.close();
  }
});

test("exports selected iCloud registration aliases with their original mailbox URL", async () => {
  const current = fixture();
  const accessUrl = "http://apple55.top/messages/test-token/base_mailbox@icloud.com";
  const icloudAccount = createSourceAccount(current.db, {
    provider: "icloud",
    email: "base_mailbox@icloud.com",
  });
  const outlookAccount = createSourceAccount(current.db, {
    provider: "microsoft",
    email: "other@example.com",
  });
  const runtime = createApp({
    db: current.db,
    dataEncryptionKey: "mailbox-export-test-key",
  });
  const timestamp = nowIso();
  current.db.prepare(`
    INSERT INTO icloud_mailboxes (account_id, access_url_encrypted, credential_updated_at)
    VALUES (?, ?, ?)
  `).run(icloudAccount.id, runtime.icloud.encrypt(accessUrl), timestamp);
  const insertJob = current.db.prepare(`
    INSERT INTO registration_jobs
      (account_id, email, external_task_id, external_account_id, status, stage, created_at, updated_at, finished_at)
    VALUES (?, ?, ?, ?, 'completed', 'completed', ?, ?, ?)
  `);
  insertJob.run(icloudAccount.id, "base_mailbox+first@icloud.com", "task-31", "31", timestamp, timestamp, timestamp);
  insertJob.run(icloudAccount.id, "base_mailbox+second@icloud.com", "task-32", "32", timestamp, timestamp, timestamp);
  insertJob.run(outlookAccount.id, "other+tag@example.com", "task-33", "33", timestamp, timestamp, timestamp);

  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/registration/accounts/mailbox-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [31, 32, 33] }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-disposition"), /attachment; filename="aliashub-icloud-mailboxes-\d{4}-\d{2}-\d{2}\.txt"/);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("x-aliashub-exported"), "2");
    assert.equal(response.headers.get("x-aliashub-skipped"), "1");
    assert.equal(await response.text(), [
      `base_mailbox+first@icloud.com----${accessUrl}`,
      `base_mailbox+second@icloud.com----${accessUrl}`,
      "",
    ].join("\n"));

    const unavailable = await fetch(`http://127.0.0.1:${port}/api/registration/accounts/mailbox-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [33] }),
    });
    assert.equal(unavailable.status, 404);
    assert.equal((await unavailable.json()).error, "所选账号没有可导出的 iCloud 取件地址");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    current.close();
  }
});
