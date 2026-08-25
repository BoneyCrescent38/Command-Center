import assert from "node:assert/strict";
import test from "node:test";
import { createCommandCenterServer } from "../server/index.mjs";

test("Spotify POC routes keep OAuth, tokens, diagnostics, and player controls server-side", async (context) => {
  const calls = [];
  const spotifyClient = {
    createAuthorizationUrl: () => "https://accounts.spotify.com/authorize?state=test",
    completeAuthorization: async (input) => calls.push(["callback", input]),
    status: () => ({ configured: true, authenticated: true, scopes: ["streaming"], events: [] }),
    getAccessToken: async () => ({ accessToken: "short-lived", expiresAt: 123 }),
    getPlayerData: async (resource) => ({ resource }),
    controlPlayer: async (action, body) => calls.push(["control", action, body]),
    recordEvent: (event) => (calls.push(["event", event]), { type: event.type, message: event.message, details: {}, at: "now" }),
    clearAuthorization: () => calls.push(["logout"]),
  };
  const audioCalls = [];
  const audioOutputService = {
    status: async () => ({ configured: true, active: "speakers", defaultName: "Speakers", speakersAvailable: true, headsetAvailable: true }),
    toggle: async () => (audioCalls.push("toggle"), { configured: true, active: "headset", defaultName: "Headset", speakersAvailable: true, headsetAvailable: true }),
  };
  const server = createCommandCenterServer({
    host: "127.0.0.1",
    port: 0,
    dashboardBaseUrl: "http://127.0.0.1:4317",
    dashboardCookieName: "dashboard_session",
    dashboardTimeoutMs: 500,
    spotifyClient,
    audioOutputService,
    fetchImpl: async () => Response.json({}, { status: 404 }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;

  const shell = await fetch(base + "/");
  assert.match(shell.headers.get("content-security-policy"), /https:\/\/sdk\.scdn\.co/);
  assert.match(shell.headers.get("permissions-policy"), /encrypted-media/);

  const start = await fetch(base + "/api/spotify/auth/start", { redirect: "manual" });
  assert.equal(start.status, 302);
  assert.match(start.headers.get("location"), /^https:\/\/accounts\.spotify\.com/);

  const callback = await fetch(base + "/api/spotify/callback?code=code&state=state", { redirect: "manual" });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/?app=spotify&spotifyAuth=ok");

  assert.equal((await (await fetch(base + "/api/spotify/status")).json()).authenticated, true);
  assert.equal((await (await fetch(base + "/api/spotify/bridge/status")).json()).audioActivated, false);
  assert.equal((await (await fetch(base + "/api/spotify/token")).json()).accessToken, "short-lived");
  assert.equal((await (await fetch(base + "/api/spotify/player/devices")).json()).resource, "devices");
  assert.equal((await (await fetch(base + "/api/audio-output")).json()).active, "speakers");

  const audioToggle = await fetch(base + "/api/audio-output/toggle", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal((await audioToggle.json()).active, "headset");
  assert.deepEqual(audioCalls, ["toggle"]);

  const transfer = await fetch(base + "/api/spotify/player/transfer", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "device", play: true }),
  });
  assert.equal(transfer.status, 200);
  assert.deepEqual(calls.find((entry) => entry[0] === "control"), ["control", "transfer", { deviceId: "device", play: true }]);

  const rejected = await fetch(base + "/api/spotify/poc/events", {
    method: "POST",
    headers: { Origin: "http://attacker.invalid", "Content-Type": "application/json" },
    body: JSON.stringify({ type: "ready" }),
  });
  assert.equal(rejected.status, 403);
});
