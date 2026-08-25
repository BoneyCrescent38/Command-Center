import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardClient, sanitizeKifPatch, sanitizeKifSnapshot } from "../server/dashboard-client.mjs";
import { commitKifMutation, filterKifItems, isKifProject, resolveKifScrollTop, sortKifItems } from "../public/modules/dashboard.js";
import { kifPayloadFixture, staleKifPayloadFixture } from "./fixtures/kif-payload.mjs";

test("KIF sanitizer keeps only the contracted snapshot, stats, and live source", () => {
  const snapshot = sanitizeKifSnapshot(kifPayloadFixture);
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.items.length, 4);
  assert.equal(snapshot.items[0].nr, "12");
  assert.deepEqual(snapshot.stats, { open: 3, inProgress: 1, needsCheck: 1, remaining: 1, done: 1, total: 4 });
  assert.deepEqual(snapshot.source, { status: "fresh", label: "KIF Masterliste – live", writable: true, lastSuccessAt: "2026-08-25T12:00:00.000Z", safeErrorCode: "" });
  assert.equal(serialized.includes("rowNumber"), false);
  assert.equal(serialized.includes("privateNote"), false);
  assert.equal(serialized.includes("credentials"), false);
  assert.equal(serialized.includes("snapshotVersion"), false);
});

test("KIF sanitizer preserves stale data as explicitly read-only", () => {
  const snapshot = sanitizeKifSnapshot(staleKifPayloadFixture);
  assert.equal(snapshot.items.length, 4);
  assert.equal(snapshot.source.status, "stale");
  assert.equal(snapshot.source.writable, false);
  assert.equal(snapshot.source.safeErrorCode, "cached_snapshot");
});

test("KIF filters and deterministic sorting cover open and status views", () => {
  const items = sanitizeKifSnapshot(kifPayloadFixture).items;
  assert.deepEqual(filterKifItems(items, "open").map((item) => item.nr), ["3", "8", "12"]);
  assert.deepEqual(filterKifItems(items, "needs_check").map((item) => item.nr), ["12"]);
  assert.deepEqual(filterKifItems(items, "in_progress").map((item) => item.nr), ["3"]);
  assert.deepEqual(filterKifItems(items, "remaining").map((item) => item.nr), ["8"]);
  assert.deepEqual(filterKifItems(items, "done").map((item) => item.nr), ["2"]);
  assert.deepEqual(filterKifItems(items, "open", "Admin").map((item) => item.nr), ["8", "12"]);
  assert.equal(sortKifItems(items)[0].nr, "2");
});

test("every KIF filter keeps canonical numeric masterlist order", () => {
  const numbers = ["101", "10", "2", "100", "36", "9"];
  const expected = ["2", "9", "10", "36", "100", "101"];
  const active = numbers.map((nr, index) => ({ nr, done: false, area: "Admin", statusCode: ["in_progress", "needs_check", "remaining"][index % 3] }));
  assert.deepEqual(sortKifItems(active).map((item) => item.nr), expected);
  assert.deepEqual(filterKifItems(active, "open").map((item) => item.nr), expected);
  assert.deepEqual(filterKifItems(active, "open", "Admin").map((item) => item.nr), expected);
  for (const filter of ["in_progress", "needs_check", "remaining"]) {
    const visible = filterKifItems(active, filter).map((item) => Number(item.nr));
    assert.deepEqual(visible, [...visible].sort((left, right) => left - right));
  }
  const done = active.map((item) => ({ ...item, done: true }));
  assert.deepEqual(filterKifItems(done, "done").map((item) => item.nr), expected);
});

test("only deterministic KIF identities receive the deep-view action", () => {
  assert.equal(isKifProject({ id: "kif-vanskebygger-app", name: "KIF Vanskebygger – app" }), true);
  assert.equal(isKifProject({ id: "something-else", name: "KIF Vanskebygger" }), true);
  assert.equal(isKifProject({ id: "dashboard", name: "Project Dashboard" }), false);
  assert.equal(isKifProject({ id: "kif-summary", name: "KIF status" }), false);
});

test("KIF mutation helper preserves the exact prior snapshot on write failure", async () => {
  const snapshot = sanitizeKifSnapshot(kifPayloadFixture);
  const success = await commitKifMutation(snapshot, async () => ({ ...snapshot, marker: "confirmed" }));
  assert.equal(success.ok, true);
  assert.equal(success.snapshot.marker, "confirmed");
  const failure = await commitKifMutation(snapshot, async () => { throw new Error("write failed"); });
  assert.equal(failure.ok, false);
  assert.equal(failure.snapshot, snapshot);
  assert.equal(failure.error.message, "write failed");
});

test("KIF scroll restoration follows the visible anchor and clamps shorter snapshots", () => {
  const state = { scrollTop: 1_240, anchorNr: "85", anchorOffset: -18 };
  assert.equal(resolveKifScrollTop(state, 1_222, 4_000, 500), 1_240);
  assert.equal(resolveKifScrollTop(state, null, 4_000, 500), 1_240);
  assert.equal(resolveKifScrollTop(state, null, 620, 500), 120);
  assert.equal(resolveKifScrollTop({ scrollTop: -20 }, null, 620, 500), 0);
});

test("KIF patch allowlist matches upstream and enforces its 4000 character limit", () => {
  assert.deepEqual(sanitizeKifPatch({ done: true }), { done: true });
  assert.deepEqual(sanitizeKifPatch({ comment: "a\r\nb\0" }), { comment: "a\nb" });
  assert.throws(() => sanitizeKifPatch({ status: "done" }), /Kun ferdig/);
  assert.throws(() => sanitizeKifPatch({ comment: "x".repeat(4001) }), /4000/);
});

test("KIF client forwards remembered session, sanitizes reads, and restricts writes", async () => {
  const calls = [];
  const cookie = "dashboard_session=kif-test";
  const client = createDashboardClient({ dashboardBaseUrl: "http://127.0.0.1:4317", dashboardCookieName: "dashboard_session", dashboardTimeoutMs: 500 }, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/auth/status")) return Response.json({ authenticated: true });
    if (options.method === "PATCH") return Response.json(kifPayloadFixture);
    return Response.json(kifPayloadFixture);
  });
  assert.deepEqual(await client.session(cookie), { authenticated: true });
  assert.equal((await client.kif(cookie)).source.writable, true);
  await client.updateKif(cookie, "12", { done: true, comment: "Kontrollert" });
  const patch = calls.find((call) => call.options.method === "PATCH");
  assert.match(patch.url, /\/api\/kif-masterlist\/12$/);
  assert.equal(patch.options.headers.Cookie, cookie);
  assert.equal(patch.options.headers.Origin, "http://127.0.0.1:4317");
  assert.deepEqual(JSON.parse(patch.options.body), { done: true, comment: "Kontrollert" });
  await assert.rejects(client.updateKif(cookie, "12", { priority: "high" }), (error) => error.code === "invalid_kif_patch");
});
