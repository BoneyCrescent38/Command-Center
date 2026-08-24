import assert from "node:assert/strict";
import test from "node:test";
import {
  createDashboardClient,
  extractCookie,
  sanitizeDashboardSnapshot,
} from "../server/dashboard-client.mjs";
import { dashboardPayloadFixture } from "./fixtures/dashboard-payload.mjs";

test("sanitizes the current nested dashboard schema with projects, usage pools, and services", () => {
  const result = sanitizeDashboardSnapshot(dashboardPayloadFixture, { status: "ok", version: "1.2.2", internal: "must-not-leak" });

  const serialized = JSON.stringify(result);
  assert.equal(result.projects[0].name, "Command Center");
  assert.equal(result.projects[1].status, "on_hold");
  assert.deepEqual(result.stats, { active: 1, onHold: 1, done: 7, averageProgress: 51 });
  assert.equal(result.source.status, "fresh");
  assert.equal(result.source.type, "google_sheets");
  assert.equal(result.codexUsage.status, "fresh");
  assert.deepEqual(result.codexUsage.windows.map((window) => window.poolLabel), ["Generell Codex / Work", "Codex Spark"]);
  assert.deepEqual(result.codexUsage.windows.map((window) => window.durationLabel), ["Ukesgrense", "Ukesgrense"]);
  assert.deepEqual(result.codexUsage.windows.map((window) => window.remainingPercent), [94, 82]);
  assert.ok(result.codexUsage.windows.every((window) => window.status === "fresh"));
  assert.deepEqual(result.services.map((service) => service.id), ["project-dashboard", "google-sheet", "codex-usage"]);
  assert.equal(result.upstreamHealth.ok, true);
  assert.equal(serialized.includes("must-not-leak"), false);
  assert.equal(serialized.includes("private_key"), false);
});

test("keeps backward-compatible support for the former flat project snapshot", () => {
  const result = sanitizeDashboardSnapshot({
    projects: [{ id: "legacy", name: "Legacy", status: "Aktiv", progress: 25 }],
    stats: { active: 1, onHold: 0, done: 2, averageProgress: 25 },
    source: { type: "fallback", status: "stale", label: "Legacy" },
  });
  assert.equal(result.projects[0].id, "legacy");
  assert.equal(result.stats.active, 1);
  assert.equal(result.source.status, "stale");
  assert.deepEqual(result.codexUsage.windows, []);
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

test("client session forwards only the configured cookie", async () => {
  let forwardedCookie;
  const client = createDashboardClient({
    dashboardBaseUrl: "http://127.0.0.1:4317",
    dashboardCookieName: "dashboard_session",
    dashboardTimeoutMs: 500,
  }, async (_url, options) => {
    forwardedCookie = options.headers.Cookie;
    return Response.json({ authenticated: true });
  });
  assert.deepEqual(await client.session("theme=dark; dashboard_session=session-value; other=value"), { authenticated: true });
  assert.equal(forwardedCookie, "dashboard_session=session-value");
});

test("client isolates an offline upstream behind a safe error", async () => {
  const client = createDashboardClient({ dashboardBaseUrl: "http://127.0.0.1:4317", dashboardCookieName: "dashboard_session", dashboardTimeoutMs: 500 }, async () => {
    throw new Error("ECONNREFUSED");
  });
  await assert.rejects(client.session(""), (error) => error.code === "dashboard_unavailable" && error.status === 503);
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