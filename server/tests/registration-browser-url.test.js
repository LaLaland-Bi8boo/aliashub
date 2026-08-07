import assert from "node:assert/strict";
import test from "node:test";
import { browserUrlWithPassword } from "../registration-service.js";

test("browserUrlWithPassword adds an encoded noVNC password fragment", () => {
  assert.equal(
    browserUrlWithPassword(
      "/alias-hub/browser/vnc.html?autoconnect=true&path=alias-hub/browser/websockify",
      "secret +&=#?",
    ),
    "/alias-hub/browser/vnc.html?autoconnect=true&path=alias-hub/browser/websockify#password=secret+%2B%26%3D%23%3F",
  );
});

test("browserUrlWithPassword preserves existing fragment settings", () => {
  assert.equal(
    browserUrlWithPassword("/vnc.html#view_only=true", "new-secret"),
    "/vnc.html#view_only=true&password=new-secret",
  );
});

test("browserUrlWithPassword leaves the URL unchanged without a password", () => {
  assert.equal(browserUrlWithPassword("/vnc.html#view_only=true", ""), "/vnc.html#view_only=true");
});
