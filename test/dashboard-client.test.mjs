import assert from "node:assert/strict";
import test from "node:test";
import {
  createDashboardClient,
  extractCookie,
  sanitizeDashboardSnapshot,
} from "../server/dashboard-client.mjs";

test("snapshot sanitizer allowlists compact fields and drops unknown secrets", () => {
  const result = sanitizeDashboardSnapshot({
    private_key: "must-not-leak",
    projects: [{
      id: "p1",
      name: "Command Center",
      area: "Work",
      status: "Aktiv",
      priority: "Høy",
      progress: 42,
      nextStep: "Ship V0",
      hiddenCredential: "must-not-leak",
    }],
    stats: { active: 1, averageProgress: 42 },
    source: { type: "google_sheets", status: "fresh", label: "Live", internalPath: "secret" },
    serviceStatus: [{ id: "dash", name: "Dashboard", status: "ok", token: "must-not-leak" }],
  }, { status: "ok", version: "1.2.2", internal: "must-not-leak" });

  const serialized = JSON.stringify(result);
  assert.equal(result.projects[0].name, "Command Center");
  assert.equal(result.upstreamHealth.ok, true);
  assert.equal(serialized.includes("must-not-leak"), false);
  assert.equal(serialized.includes("private_key"), false);
});

test("cookie extraction forwards only the configured dashboard session", () => {
  assert.equal(extractCookie("theme=dark; dashboard_session=abc123; other=value", "dashboard_session"), "dashboard_session=abc123");
  assert.equal(extractCookie("theme=dark", "dashboard_session"), "");
});

test("client login sends PIN only in body and relays set-cookie", async () => {
  let captured;
  const client = createDashboardClient({
    dashboardBaseUrl: "http://127.0.0.1:4317",
    dashboardCookieName: "dashboard_session",
    dashboardTimeoutMs: 500,
  }, async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ authenticated: true }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "dashboard_session=session-value; HttpOnly; Path=/" },
    });
  });

  const result = await client.login("1234");
  assert.equal(captured.url, "http://127.0.0.1:4317/api/auth/login");
  assert.equal(captured.options.headers.Origin, "http://127.0.0.1:4317");
  assert.deepEqual(JSON.parse(captured.options.body), { pin: "1234" });
  assert.match(result.setCookie, /^dashboard_session=/);
});

test("client timeout is isolated behind a safe error code", async () => {
  const client = createDashboardClient({
    dashboardBaseUrl: "http://127.0.0.1:4317",
    dashboardCookieName: "dashboard_session",
    dashboardTimeoutMs: 10,
  }, async (_url, options) => {
    await new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  });
  await assert.rejects(client.session(""), (error) => error.code === "dashboard_timeout" && error.status === 504);
});