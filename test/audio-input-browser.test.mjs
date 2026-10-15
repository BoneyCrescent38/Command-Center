import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCommandCenterServer } from "../server/index.mjs";
import { createAudioInputService } from "../server/audio-input.mjs";
import { createSpotifyBridge } from "../server/spotify-bridge.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const executable = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
  .filter(Boolean).map((base) => path.join(base, "Microsoft", "Edge", "Application", "msedge.exe")).find(existsSync);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const cdpConnect = async (url) => {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data));
    const entry = pending.get(payload.id);
    if (!entry) return;
    pending.delete(payload.id);
    clearTimeout(entry.timer);
    if (payload.error) entry.reject(new Error(payload.error.message)); else entry.resolve(payload.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const sequence = ++id;
    const timer = setTimeout(() => { pending.delete(sequence); reject(new Error(method + " timed out")); }, 5000);
    pending.set(sequence, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: sequence, method, params }));
  });
  return { send, close: () => ws.close(), async evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  } };
};

test("Windows input touch UI stays in 2560x720, follows SSE and preserves focused buttons", {
  skip: process.platform === "win32" && executable && typeof WebSocket === "function" ? false : "Microsoft Edge is required",
  timeout: 60000,
}, async () => {
  const devices = [
    { id: "capture-a", name: "Microphone (Wireless headset)", available: true },
    { id: "capture-b", name: "Microphone (Webcam)", available: true },
    { id: "capture-c", name: "Virtual microphone with an exceptionally long Windows endpoint display name that must truncate gracefully", available: true },
  ];
  let current = { activeId: "capture-c", devices };
  let handlers;
  let failWrite = false;
  const writes = [];
  const audioInput = createAudioInputService({
    runner: async (action, id) => {
      if (action === "Set") {
        if (failWrite) throw Object.assign(new Error("disconnected"), { code: "audio_input_target_unavailable", status: 409 });
        writes.push(id);
        current = { ...current, activeId: id };
      }
      return current;
    }, watcherFactory: (next) => { handlers = next; return () => {}; },
  });
  const bridge = createSpotifyBridge();
  bridge.updateState({ deviceId: "fixture-edge", deviceName: "Preview Spotify", deviceReady: true, trackId: "fixture", trackName: "Spotify layout fixture", artists: ["Preview"], album: "Read-only fixture", duration: 180000, position: 30000, isPlaying: true, volume: 55 });
  const server = createCommandCenterServer({ audioInputService: audioInput, spotifyBridge: bridge, audioOutputService: {
    status: async () => ({ configured: true, ready: true, active: "headset", defaultName: "Headphones (Wireless headset)", speakersAvailable: true, headsetAvailable: true }),
    openStream: (_request, response) => { response.writeHead(200, { "Content-Type": "text/event-stream" }); response.end('event: audio-output\ndata: {"configured":true,"active":"headset","speakersAvailable":true,"headsetAvailable":true}\n\n'); },
    close() {},
  }, spotifyClient: {
    status: () => ({ configured: true, authenticated: true, deviceId: "fixture-edge" }),
    recordEvent: () => ({}),
    getPlayerData: async (resource) => resource === "queue" ? { queue: Array.from({ length: 4 }, (_, i) => ({ name: "Queue fixture " + i, artists: ["Preview"], id: String(i) })) } : {},
  } });
  const port = await listen(server);
  const probe = http.createServer();
  const debugPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const profile = await mkdtemp(path.join(os.tmpdir(), "command-center-input-test-"));
  const edge = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, "--window-size=2560,720", "--force-device-scale-factor=1", `http://127.0.0.1:${port}/?app=spotify`], { windowsHide: true, stdio: "ignore" });
  let cdp;
  try {
    let page;
    for (let i = 0; i < 100 && !page; i += 1) {
      await wait(100);
      try { page = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((target) => target.type === "page" && target.url.includes(`:${port}/`)); } catch {}
    }
    assert.ok(page?.webSocketDebuggerUrl, "isolated Edge browser did not start");
    cdp = await cdpConnect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 2560, height: 720, deviceScaleFactor: 1, mobile: false });
    for (let i = 0; i < 100; i += 1) {
      if (await cdp.evaluate("document.querySelectorAll('.spotify-input-device').length === 3")) break;
      await wait(50);
    }
    const layout = await cdp.evaluate(`(() => {
      const rect = element => { const r = element.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom, right:r.right }; };
      const list = document.querySelector('.spotify-input-devices');
      return { viewport:[innerWidth,innerHeight], document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],
        card:rect(document.querySelector('.spotify-output-card')), buttons:[...list.children].map(rect),
        inputScroll:list.scrollHeight > list.clientHeight,
        queueClipped:document.querySelector('#spotify-queue').scrollHeight > document.querySelector('#spotify-queue').clientHeight,
        selected:[...list.children].filter(b=>b.getAttribute('aria-pressed') === 'true').map(b=>b.dataset.deviceId),
        playback:rect(document.querySelector('.spotify-v1-controls')), volume:rect(document.querySelector('#spotify-volume')) };
    })()`);
    assert.deepEqual(layout.viewport, [2560, 720]);
    assert.deepEqual(layout.document, [2560, 720]);
    assert.equal(layout.inputScroll, false);
    assert.equal(layout.queueClipped, false, "queue must not be clipped by the microphone area: " + JSON.stringify(layout));
    assert.deepEqual(layout.selected, ["capture-c"]);
    assert.equal(await cdp.evaluate("document.querySelector('#spotify-play').disabled"), false);
    assert.equal(await cdp.evaluate("document.querySelector('#spotify-play').textContent"), "Pause");
    assert.equal(await cdp.evaluate("document.querySelector('#spotify-volume').disabled"), false);
    for (const rect of [...layout.buttons, layout.card, layout.playback, layout.volume]) {
      assert.ok(rect.x >= 0 && rect.right <= 2560 && rect.y >= 0 && rect.bottom <= 720, JSON.stringify(rect));
    }
    for (const button of layout.buttons) assert.ok(button.height >= 44, "touch target must be at least 44px");
    await cdp.evaluate("window.inputErrors=[]; window.inputCsp=[]; addEventListener('error',e=>inputErrors.push(e.message)); addEventListener('securitypolicyviolation',e=>inputCsp.push(e.effectiveDirective)); window.savedInput=document.querySelector('[data-device-id=\"capture-a\"]'); savedInput.focus()");
    current = { ...current, activeId: "capture-b" };
    handlers.onStatus(current);
    await wait(100);
    assert.deepEqual(await cdp.evaluate("({active:document.querySelector('.spotify-input-device[aria-pressed=true]').dataset.deviceId, same:savedInput===document.querySelector('[data-device-id=\"capture-a\"]'), focused:document.activeElement===savedInput})"), { active: "capture-b", same: true, focused: true });
    // These clicks reach only the injected fake, never a real Windows Set operation.
    await cdp.evaluate("savedInput.click()");
    await wait(200);
    assert.deepEqual(writes, ["capture-a"]);
    assert.equal(await cdp.evaluate("document.querySelector('.spotify-input-device[aria-pressed=true]').dataset.deviceId"), "capture-a");
    failWrite = true;
    await cdp.evaluate("document.querySelector('[data-device-id=\"capture-b\"]').click()");
    await wait(200);
    assert.equal(await cdp.evaluate("document.querySelector('.spotify-input-device[aria-pressed=true]').dataset.deviceId"), "capture-a");
    assert.match(await cdp.evaluate("document.querySelector('#spotify-input-status').textContent"), /koblet fra/);
    current = { activeId: "", devices: [] };
    handlers.onStatus(current);
    await wait(100);
    assert.equal(await cdp.evaluate("document.querySelectorAll('.spotify-input-device').length"), 0);
    assert.match(await cdp.evaluate("document.querySelector('#spotify-input-status').textContent"), /Ingen tilgjengelige/);
    current = { activeId: "capture-c", devices };
    handlers.onStatus(current);
    await wait(100);
    assert.equal(await cdp.evaluate("document.querySelectorAll('.spotify-input-device').length"), 3);
    assert.equal(await cdp.evaluate("document.querySelector('.spotify-input-device[aria-pressed=true]').title"), devices[2].name);
    assert.deepEqual(await cdp.evaluate("({errors:inputErrors,csp:inputCsp})"), { errors: [], csp: [] });
    await mkdir(path.join(root, ".runtime"), { recursive: true });
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(root, ".runtime", "audio-input-layout.png"), Buffer.from(shot.data, "base64"));
    await cdp.evaluate("document.querySelector('[data-app=\"gaming\"]').click()");
    await wait(100);
    assert.equal(await cdp.evaluate("document.querySelector('#spotify-input') === null"), true);
  } finally {
    await cdp?.send("Browser.close").catch(() => {});
    cdp?.close();
    edge.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await wait(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
});
