import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../db.js";
import { createApp } from "../index.js";
import { jsonRequest } from "./http-harness.js";

test("reverse-proxy auth check reuses an authenticated AliasHub session", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliashub-auth-test-"));
  const previous = {
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
    secret: process.env.SESSION_SECRET,
  };
  process.env.ADMIN_USERNAME = "proxy-admin";
  process.env.ADMIN_PASSWORD = "proxy-password";
  process.env.SESSION_SECRET = "proxy-session-secret";
  const db = createDatabase({ filename: path.join(directory, "test.db"), seedDemo: false });
  const runtime = createApp({ db });
  try {
    const denied = await jsonRequest(runtime.app, "/api/auth/check");
    assert.equal(denied.response.status, 401);
    assert.equal(denied.body.code, "AUTH_REQUIRED");

    const login = await jsonRequest(runtime.app, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "proxy-admin", password: "proxy-password" }),
    });
    assert.equal(login.response.status, 200);
    const cookie = String(login.response.headers["set-cookie"] || "").split(";")[0];
    assert.match(cookie, /^aliashub_session=/);

    const allowed = await jsonRequest(runtime.app, "/api/auth/check", { headers: { cookie } });
    assert.equal(allowed.response.status, 204);
    assert.deepEqual(allowed.body, {});
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (previous.username === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = previous.username;
    if (previous.password === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous.password;
    if (previous.secret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.secret;
  }
});
