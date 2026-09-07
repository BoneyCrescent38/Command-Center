import assert from "node:assert/strict";
import test from "node:test";
import { createCommandCenterServer } from "../server/index.mjs";
import { kifPayloadFixture } from "./fixtures/kif-payload.mjs";

const cookie = "dashboard_session=kif-test";

test("KIF proxy covers auth, safe reads, confirmed writes, failures, and origin safety", async (context) => {
  const upstreamCalls = [];
  const fakeFetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    upstreamCalls.push({ pathname: parsed.pathname, method, body, headers: options.headers });
    if (parsed.pathname === "/api/auth/status") return Response.json({ authenticated: options.headers?.Cookie === cookie });
    if (parsed.pathname.startsWith("/api/kif-masterlist") && options.headers?.Cookie !== cookie) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (body?.comment === "FAIL") return Response.json({ code: "kif_write_failed", message: "KIF kunne ikke lagres" }, { status: 503 });
    if (body?.comment === "BUSY") return Response.json({ code: "kif_write_in_progress", message: "En KIF-skriving pågår" }, { status: 409 });
    return Response.json(kifPayloadFixture);
  };
  const server = createCommandCenterServer({ host: "127.0.0.1", port: 0, dashboardBaseUrl: "http://127.0.0.1:4317", dashboardCookieName: "dashboard_session", dashboardTimeoutMs: 500, fetchImpl: fakeFetch });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const headers = { Cookie: cookie, Origin: base, "Content-Type": "application/json" };

  assert.equal((await fetch(base + "/api/kif-masterlist")).status, 401);
  const read = await fetch(base + "/api/kif-masterlist", { headers: { Cookie: cookie } });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).items.length, 4);
  assert.match(read.headers.get("cache-control"), /no-store/);

  const confirmed = await fetch(base + "/api/kif-masterlist/12", { method: "PATCH", headers, body: JSON.stringify({ done: true }) });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).source.writable, true);

  const comment = await fetch(base + "/api/kif-masterlist/12", { method: "PATCH", headers, body: JSON.stringify({ comment: "Neste steg" }) });
  assert.equal(comment.status, 200);

  const rejectedOrigin = await fetch(base + "/api/kif-masterlist/12", { method: "PATCH", headers: { ...headers, Origin: "http://attacker.invalid" }, body: JSON.stringify({ done: true }) });
  assert.equal(rejectedOrigin.status, 403);
  const rejectedField = await fetch(base + "/api/kif-masterlist/12", { method: "PATCH", headers, body: JSON.stringify({ priority: "high" }) });
  assert.equal(rejectedField.status, 400);
  const failure = await fetch(base + "/api/kif-masterlist/12", { method: "PATCH", headers, body: JSON.stringify({ comment: "FAIL" }) });
  assert.equal(failure.status, 503);
  const busy = await fetch(base + "/api/kif-masterlist/12", { method: "PATCH", headers, body: JSON.stringify({ comment: "BUSY" }) });
  assert.equal(busy.status, 409);

  const mutations = upstreamCalls.filter((call) => call.method === "PATCH");
  assert.equal(mutations.every((call) => call.headers.Cookie === cookie), true);
  assert.equal(mutations.every((call) => call.headers.Origin === "http://127.0.0.1:4317"), true);
  assert.equal(mutations.every((call) => Object.keys(call.body).every((key) => ["done", "comment"].includes(key))), true);
});
