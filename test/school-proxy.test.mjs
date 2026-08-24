import assert from "node:assert/strict";
import test from "node:test";
import { createCommandCenterServer } from "../server/index.mjs";
import { schoolSnapshotFixture, schoolWeekFixture } from "./fixtures/school-payload.mjs";

const cookie = "dashboard_session=school-test";

test("school proxy covers authenticated reads, CRUD, failures, and origin safety", async (context) => {
  const upstreamCalls = [];
  const fakeFetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    upstreamCalls.push({ pathname: parsed.pathname, search: parsed.search, method, body, headers: options.headers });
    if (parsed.pathname === "/api/auth/status") return Response.json({ authenticated: true });
    if (parsed.pathname.startsWith("/api/school") && options.headers?.Cookie !== cookie) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (parsed.pathname === "/api/school" && method === "GET") return Response.json(schoolSnapshotFixture);
    if (parsed.pathname === "/api/school/week") return Response.json(schoolWeekFixture);
    if (body?.title === "FAIL") return Response.json({ error: "school_write_failed" }, { status: 503 });
    if (method === "DELETE") return Response.json({ school: schoolSnapshotFixture, deletedId: decodeURIComponent(parsed.pathname.split("/").pop()) });
    if (parsed.pathname.includes("exam-periods")) return Response.json({ school: schoolSnapshotFixture, saved: schoolSnapshotFixture.examPeriods[0] });
    if (parsed.pathname.endsWith("/settings")) return Response.json({ school: schoolSnapshotFixture, saved: schoolSnapshotFixture.settings });
    return Response.json({ school: schoolSnapshotFixture, saved: schoolSnapshotFixture.deadlines[1] });
  };

  const server = createCommandCenterServer({ host: "127.0.0.1", port: 0, dashboardBaseUrl: "http://127.0.0.1:4317", dashboardCookieName: "dashboard_session", dashboardTimeoutMs: 500, fetchImpl: fakeFetch });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const headers = { Cookie: cookie, Origin: base, "Content-Type": "application/json" };

  const unauthorized = await fetch(base + "/api/school");
  assert.equal(unauthorized.status, 401);

  const snapshot = await (await fetch(base + "/api/school", { headers: { Cookie: cookie } })).json();
  assert.equal(snapshot.source.writable, true);
  assert.equal(JSON.stringify(snapshot).includes("must-not-leak"), false);

  const week = await (await fetch(base + "/api/school/week?date=2026-08-24", { headers: { Cookie: cookie } })).json();
  assert.equal(week.week, 35);
  assert.equal(upstreamCalls.find((call) => call.pathname === "/api/school/week").search, "?date=2026-08-24");

  const deadline = schoolSnapshotFixture.deadlines[1];
  const create = await fetch(base + "/api/school/deadlines", { method: "POST", headers, body: JSON.stringify(deadline) });
  assert.equal(create.status, 201);
  assert.equal((await create.json()).saved.id, deadline.id);

  for (const [path, method, body] of [
    ["/api/school/deadlines/DL-HIGH", "PATCH", { progress: 75, status: "in_progress" }],
    ["/api/school/deadlines/DL-HIGH", "DELETE", null],
    ["/api/school/exam-periods", "POST", schoolSnapshotFixture.examPeriods[0]],
    ["/api/school/exam-periods/EXAM-1", "PATCH", { status: "Bekreftet" }],
    ["/api/school/exam-periods/EXAM-1", "DELETE", null],
    ["/api/school/settings", "PATCH", schoolSnapshotFixture.settings],
  ]) {
    const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, method === "POST" ? 201 : 200, method + " " + path);
  }

  const failed = await fetch(base + "/api/school/deadlines/DL-HIGH", { method: "PATCH", headers, body: JSON.stringify({ title: "FAIL" }) });
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).code, "school_write_failed");

  const rejected = await fetch(base + "/api/school/deadlines", { method: "POST", headers: { ...headers, Origin: "http://attacker.invalid" }, body: JSON.stringify(deadline) });
  assert.equal(rejected.status, 403);

  const mutationCalls = upstreamCalls.filter((call) => !["GET", "HEAD"].includes(call.method));
  assert.equal(mutationCalls.every((call) => call.headers.Cookie === cookie), true);
  assert.equal(mutationCalls.every((call) => call.headers.Origin === "http://127.0.0.1:4317"), true);
});
