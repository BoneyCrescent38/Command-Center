import assert from "node:assert/strict";
import test from "node:test";
import { createCommandCenterServer } from "../server/index.mjs";
import { dashboardPayloadFixture } from "./fixtures/dashboard-payload.mjs";

let capturedLoginBody;

const fakeFetch = async (url, options = {}) => {
  const pathname = new URL(url).pathname;
  if (pathname === "/api/auth/status") {
    return Response.json({ authenticated: true });
  }
  if (pathname === "/api/auth/login") {
    capturedLoginBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ authenticated: true }), {
      headers: { "content-type": "application/json", "set-cookie": "dashboard_session=test-session; HttpOnly; Path=/" },
    });
  }
  if (pathname === "/api/auth/logout") {
    return new Response(JSON.stringify({ authenticated: false }), {
      headers: { "content-type": "application/json", "set-cookie": "dashboard_session=; Max-Age=0; Path=/" },
    });
  }
  if (pathname === "/health") {
    return Response.json({ status: "ok", version: "test", build: "upstream" });
  }
  if (pathname === "/api/dashboard") {
    assert.equal(options.headers.Cookie, "dashboard_session=test-session");
    return Response.json(dashboardPayloadFixture);
  }
  return Response.json({}, { status: 404 });
};

test("server serves shell and no-store sanitized dashboard API", async (context) => {
  const server = createCommandCenterServer({
    host: "127.0.0.1",
    port: 0,
    dashboardBaseUrl: "http://127.0.0.1:4317",
    dashboardCookieName: "dashboard_session",
    dashboardTimeoutMs: 500,
    fetchImpl: fakeFetch,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;

  const health = await fetch(base + "/health");
  assert.equal((await health.json()).status, "ok");
  assert.match(health.headers.get("cache-control"), /no-store/);

  const shell = await fetch(base + "/");
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /Command Center/);

  const session = await fetch(base + "/api/dashboard/session", {
    headers: { Cookie: "theme=dark; dashboard_session=test-session" },
  });
  assert.deepEqual(await session.json(), { authenticated: true });

  const login = await fetch(base + "/api/dashboard/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ pin: "1234" }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /^dashboard_session=/);
  assert.deepEqual(capturedLoginBody, { pin: "1234", remember: true });

  const data = await fetch(base + "/api/dashboard/data", {
    headers: { Cookie: "theme=dark; dashboard_session=test-session" },
  });
  const snapshot = await data.json();
  assert.equal(snapshot.projects[0].name, "Command Center");
  assert.equal(snapshot.stats.onHold, 1);
  assert.deepEqual(snapshot.codexUsage.windows.map((window) => window.poolLabel), ["Generell Codex / Work", "Codex Spark"]);
  assert.equal(snapshot.services[1].id, "google-sheet");
  assert.equal(JSON.stringify(snapshot).includes("must-not-leak"), false);
  assert.match(data.headers.get("cache-control"), /no-store/);

  const rejected = await fetch(base + "/api/dashboard/login", {
    method: "POST",
    headers: { Origin: "http://attacker.invalid", "Content-Type": "application/json" },
    body: JSON.stringify({ pin: "nope" }),
  });
  assert.equal(rejected.status, 403);
});
