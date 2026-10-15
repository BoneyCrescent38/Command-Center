import assert from "node:assert/strict";
import test from "node:test";
import { createCommandCenterServer } from "../server/index.mjs";
import { createAudioInputService } from "../server/audio-input.mjs";

test("audio input HTTP and SSE validate mutations while leaving output routes independent", async (context) => {
  let currentId = "capture-a";
  let writes = 0;
  let watcher;
  const input = createAudioInputService({
    runner: async (action, id) => {
      if (action === "Set") { currentId = id; writes += 1; }
      return { activeId: currentId, devices: [{ id: "capture-a", name: "Webcam", available: true }, { id: "capture-b", name: "Headset mic", available: true }, { id: "unplugged", available: false }] };
    },
    watcherFactory: (handlers) => { watcher = handlers; return () => {}; },
  });
  let outputToggles = 0;
  const server = createCommandCenterServer({ audioInputService: input, audioOutputService: {
    status: async () => ({ configured: true, ready: true, active: "speakers" }),
    toggle: async () => ({ active: ++outputToggles === 1 ? "headset" : "speakers" }),
    close() {},
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = "http://127.0.0.1:" + server.address().port;
  const initial = await fetch(base + "/api/audio-input");
  assert.match(initial.headers.get("cache-control"), /no-store/);
  assert.equal((await initial.json()).activeId, "capture-a");
  const post = (deviceId, origin = base, fetchSite) => fetch(base + "/api/audio-input/default", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(fetchSite ? { "Sec-Fetch-Site": fetchSite } : {}) }, body: JSON.stringify({ deviceId }),
  });
  assert.equal((await post("capture-b", "http://attacker.invalid")).status, 403);
  assert.equal((await post("capture-b", base, "cross-site")).status, 403);
  assert.equal(writes, 0);
  for (const id of ["unknown", "unplugged", "render-output"]) assert.equal((await post(id)).status, 409);
  assert.equal((await post(null)).status, 400);
  const invalidJson = await fetch(base + "/api/audio-input/default", { method: "POST", headers: { Origin: base }, body: "{" });
  assert.equal(invalidJson.status, 400);
  for (const id of ["capture-b", "capture-a"]) {
    const result = await post(id);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).activeId, id);
  }
  assert.equal(writes, 2);
  const controller = new AbortController();
  const response = await fetch(base + "/api/audio-input/stream", { signal: controller.signal });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: audio-input/);
  watcher.onStatus({ activeId: "capture-b", devices: [{ id: "capture-b", name: "Headset mic", available: true }] });
  let next = "";
  for (let i = 0; i < 3 && !next.includes('"capture-b"'); i += 1) next += new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /"activeId":"capture-b"/);
  await reader.cancel();
  controller.abort();
  assert.equal((await (await fetch(base + "/api/audio-output")).json()).active, "speakers");
  for (const expected of ["headset", "speakers"]) {
    const result = await fetch(base + "/api/audio-output/toggle", { method: "POST", headers: { Origin: base }, body: "{}" });
    assert.equal((await result.json()).active, expected);
  }
  assert.equal(writes, 2, "output toggle must not switch capture endpoints");
});
