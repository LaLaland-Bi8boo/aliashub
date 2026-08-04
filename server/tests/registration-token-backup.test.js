import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase, nowIso } from "../db.js";
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
