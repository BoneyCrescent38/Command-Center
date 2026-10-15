import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAudioInputService, sanitizeAudioInputStatus } from "../server/audio-input.mjs";

const devices = [
  { id: "capture-a", name: "Webcam input", available: true },
  { id: "capture-b", name: "Headset input", available: true },
];
const snapshot = (activeId = "capture-a", list = devices) => ({ activeId, devices: list, secret: "must-not-leak" });
const stream = (service) => {
  const request = new EventEmitter();
  const response = new EventEmitter();
  const chunks = [];
  response.writeHead = (status, headers) => {
    assert.equal(status, 200);
    assert.equal(headers["Cache-Control"], "no-store");
    assert.equal(headers["Content-Type"], "text/event-stream; charset=utf-8");
  };
  response.write = (chunk) => chunks.push(chunk);
  service.openStream(request, response);
  return { chunks, close: () => response.emit("close") };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("capture discovery exposes available inputs, derives the default, and strips extra fields", () => {
  const result = sanitizeAudioInputStatus(snapshot("capture-b", [
    ...devices,
    { id: "disabled", name: "Disabled input", available: false },
    { id: "unplugged", name: "Unplugged input", available: false },
    { id: "not-confirmed", name: "Unknown", available: "true" },
    { ...devices[0], active: true, endpointInfo: "must-not-leak" },
    { id: "malformed\n", available: true },
  ]));
  assert.deepEqual(result, {
    ready: true, activeId: "capture-b", activeName: "Headset input",
    devices: devices.map((device) => ({ ...device, active: device.id === "capture-b" })),
  });
  assert.deepEqual(sanitizeAudioInputStatus(null), { ready: false, activeId: "", activeName: "", devices: [] });
  assert.equal(sanitizeAudioInputStatus(snapshot("unknown")).activeId, "");
});

test("default input A -> B -> A uses one validated Capture target per write", async () => {
  let current = snapshot();
  const writes = [];
  const service = createAudioInputService({ runner: async (action, id) => {
    if (action === "Set") { writes.push(id); current = snapshot(id); }
    return current;
  } });
  assert.equal((await service.status()).activeId, "capture-a");
  assert.equal((await service.setDefault("capture-b")).activeId, "capture-b");
  assert.equal((await service.setDefault("capture-a")).activeId, "capture-a");
  assert.deepEqual(writes, ["capture-b", "capture-a"]);
});

test("unknown, disabled, unplugged and invalid inputs never reach the mutation runner", async () => {
  const calls = [];
  const service = createAudioInputService({ runner: async (action) => {
    calls.push(action);
    return snapshot("capture-a", [...devices, { id: "disabled", available: false }, { id: "unplugged", available: false }]);
  } });
  for (const id of ["unknown", "disabled", "unplugged", "render-speakers"]) {
    await assert.rejects(service.setDefault(id), { status: 409, code: "audio_input_target_unavailable" });
  }
  for (const id of [undefined, null, {}, "", "x\n", "x".repeat(257)]) {
    await assert.rejects(service.setDefault(id), { status: 400, code: "audio_input_invalid_device" });
  }
  assert.equal(calls.includes("Set"), false);
});

test("input lost between validation and Set fails closed and does not claim success", async () => {
  const service = createAudioInputService({ runner: async (action) => {
    if (action === "Set") throw Object.assign(new Error("disconnected"), { status: 409, code: "audio_input_target_unavailable" });
    return snapshot();
  } });
  await assert.rejects(service.setDefault("capture-b"), { code: "audio_input_target_unavailable" });
  assert.equal((await service.status()).activeId, "capture-a");
});

test("unconfirmed Set is rejected and queued writes cannot overlap", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const service = createAudioInputService({ runner: async (action, id) => {
    if (action === "Status") return snapshot();
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await flush();
    inFlight -= 1;
    return snapshot(id);
  } });
  await Promise.all([service.setDefault("capture-b"), service.setDefault("capture-a")]);
  assert.equal(maxInFlight, 1);
  const wrong = createAudioInputService({ runner: async () => snapshot() });
  await assert.rejects(wrong.setDefault("capture-b"), { code: "audio_input_unavailable" });
});

test("one Core Audio watcher pushes default, added, removed and state changes to all SSE clients", async () => {
  let handlers;
  let starts = 0;
  let stops = 0;
  const service = createAudioInputService({ runner: async () => snapshot(), watcherFactory: (next) => {
    handlers = next;
    starts += 1;
    return () => { stops += 1; };
  } });
  const a = stream(service);
  const b = stream(service);
  await flush();
  assert.equal(starts, 1);
  for (const next of [snapshot("capture-b"), snapshot("capture-b", [...devices, { id: "capture-c", name: "Third", available: true }]), snapshot("capture-a", [devices[0]]), snapshot("capture-a", [{ ...devices[0], available: false }]), snapshot()]) {
    const before = a.chunks.length;
    handlers.onStatus(next);
    assert.ok(a.chunks.length > before);
    assert.equal(a.chunks.at(-1), b.chunks.at(-1));
    assert.doesNotMatch(a.chunks.at(-1), /must-not-leak/);
    handlers.onStatus(next);
    assert.equal(a.chunks.length, before + 1, "unchanged events are deduplicated");
  }
  a.close();
  assert.equal(stops, 0);
  b.close();
  assert.equal(stops, 1);
  service.close();
});

test("watcher reconnect replaces unavailable state and stops after the last subscriber leaves", async () => {
  let handlers;
  let starts = 0;
  const service = createAudioInputService({ runner: async () => snapshot(), restartMs: 5, watcherFactory: (next) => {
    starts += 1;
    handlers = next;
    return () => {};
  } });
  const client = stream(service);
  await flush();
  handlers.onExit();
  assert.match(client.chunks.at(-1), /"ready":false/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(starts, 2);
  handlers.onStatus(snapshot("capture-b"));
  assert.match(client.chunks.at(-1), /"activeId":"capture-b"/);
  client.close();
  service.close();
});

test("slow startup status cannot overwrite a newer default-device notification", async () => {
  let finish;
  let handlers;
  const service = createAudioInputService({ runner: () => new Promise((resolve) => { finish = resolve; }), watcherFactory: (next) => { handlers = next; return () => {}; } });
  const client = stream(service);
  handlers.onStatus(snapshot("capture-b"));
  finish(snapshot("capture-a"));
  await flush();
  assert.match(client.chunks.at(-1), /"activeId":"capture-b"/);
  client.close();
  service.close();
});

test("Core Audio helper validates active Capture immediately before setting all three roles", async () => {
  const source = await readFile(new URL("../scripts/audio-input.ps1", import.meta.url), "utf8");
  assert.match(source, /EnumAudioEndpoints\(EDataFlow.Capture, 1/);
  assert.match(source, /GetDataFlow\(out flow\) == 0 && flow == EDataFlow.Capture/);
  assert.match(source, /GetDevice\(id, out device\).*\!IsActiveCapture\(device\)/);
  for (const role of ["Console", "Multimedia", "Communications"]) assert.match(source, new RegExp(`SetDefaultEndpoint\\(id, ERole\\.${role}\\)`));
  assert.match(source, /if \(flow == EDataFlow.Capture\) owner.Signal/);
  for (const event of ["OnDeviceAdded", "OnDeviceRemoved", "OnDeviceStateChanged", "OnPropertyValueChanged"]) assert.match(source, new RegExp(event + "[^\\n]+owner.Signal"));
  assert.match(source, /ChangeEvent.WaitOne\(\)/);
  assert.doesNotMatch(source, /SetMute|SetMasterVolume|GetUserMedia|Start-Sleep|\?\?/i);
});
