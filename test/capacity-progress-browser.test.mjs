import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
const edgeCandidates = [
  path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
].filter(Boolean);
const edgeExecutable = edgeCandidates.find(existsSync);
const browserAvailable = process.platform === "win32" && edgeExecutable && typeof WebSocket === "function";

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

const closeServer = (server) => new Promise((resolve) => server.close(resolve));
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const reservePort = async () => {
  const probe = http.createServer();
  const port = await listen(probe);
  await closeServer(probe);
  return port;
};

const connectCdp = async (url) => {
  const socket = new WebSocket(url);
  await Promise.race([new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  }), wait(5_000).then(() => { throw new Error("CDP WebSocket did not open"); })]);
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("CDP WebSocket closed"));
    }
    pending.clear();
  });
  return {
    close: () => socket.close(),
    send(method, params = {}) {
      const id = ++sequence;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, 5_000);
        pending.set(id, { resolve, reject, timer });
      });
    },
  };
};

const evaluate = async (cdp, expression) => {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result.value;
};

const paeth = (left, up, upLeft) => {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  return upDistance <= diagonalDistance ? up : upLeft;
};

const decodePng = (buffer) => {
  assert.equal(buffer.subarray(1, 4).toString("ascii"), "PNG");
  let offset = 8;
  let width;
  let height;
  let colorType;
  const compressed = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "browser screenshot must use 8-bit PNG channels");
      colorType = data[9];
    } else if (type === "IDAT") compressed.push(data);
    else if (type === "IEND") break;
  }
  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(bytesPerPixel, `unsupported PNG color type ${colorType}`);
  const inflated = inflateSync(Buffer.concat(compressed));
  const stride = width * bytesPerPixel;
  const rows = [];
  let inputOffset = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset++];
    const source = inflated.subarray(inputOffset, inputOffset + stride);
    inputOffset += stride;
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = previous[x] || 0;
      const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      const prediction = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : filter === 4 ? paeth(left, up, upLeft)
                : NaN;
      assert.ok(Number.isFinite(prediction), `unsupported PNG filter ${filter}`);
      row[x] = (source[x] + prediction) & 255;
    }
    rows.push(row);
    previous = row;
  }
  return { width, height, bytesPerPixel, rows };
};

const renderedFillPercent = (png) => {
  const image = decodePng(png);
  const row = image.rows[Math.floor(image.height / 2)];
  let fillPixels = 0;
  for (let x = 0; x < image.width; x += 1) {
    const offset = x * image.bytesPerPixel;
    const red = row[offset];
    const green = row[offset + 1];
    const blue = row[offset + 2];
    if (red >= 45 && green >= 125 && blue >= 125) fillPixels += 1;
  }
  return (fillPixels / image.width) * 100;
};

test("native capacity progress renders live downward and upward patches under production CSP", {
  skip: browserAvailable ? false : "Microsoft Edge with WebSocket support is required",
  timeout: 60_000,
}, async () => {
  const [dashboardSource, reconcileSource, styles, serverSource] = await Promise.all([
    readFile(path.join(root, "public", "modules", "dashboard.js"), "utf8"),
    readFile(path.join(root, "public", "modules", "dom-reconcile.js"), "utf8"),
    readFile(path.join(root, "public", "styles.css"), "utf8"),
    readFile(path.join(root, "server", "index.mjs"), "utf8"),
  ]);
  const csp = serverSource.match(/"Content-Security-Policy":\s*"([^"]+)"/)?.[1];
  assert.ok(csp?.includes("style-src 'self'"), "production CSP must disallow inline styles");

  const runnerSource = `
    import { usageWindowMarkup } from "/modules/dashboard.js";
    import { patchRootHtml } from "/modules/dom-reconcile.js";
    const root = document.querySelector("#capacity-root");
    const violations = [];
    let mountedProgress;
    document.addEventListener("securitypolicyviolation", (event) => violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
    window.applyCapacity = (remaining) => {
      patchRootHtml(root, '<section class="capacity-card"><div class="usage-list">' + usageWindowMarkup({ durationLabel: "Ukesgrense", remainingPercent: remaining, usedPercent: 100 - remaining, status: "fresh" }) + '</div></section>');
      const progress = root.querySelector("progress.usage-progress");
      const sameNode = mountedProgress ? mountedProgress === progress : true;
      if (!mountedProgress) mountedProgress = progress;
      return { sameNode, tagName: progress.tagName, value: progress.value, valueAttribute: progress.getAttribute("value"), ariaNow: progress.getAttribute("aria-valuenow"), inlineStyle: progress.getAttribute("style"), violations: [...violations] };
    };
    window.capacityReady = true;
  `;
  const css = styles + "\nhtml,body{margin:0;background:#020b12}#capacity-root{width:400px;padding:20px}";
  const files = new Map([
    ["/", ["text/html; charset=utf-8", '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="capacity-root"></div><script type="module" src="/runner.js"></script></body></html>']],
    ["/styles.css", ["text/css; charset=utf-8", css]],
    ["/runner.js", ["text/javascript; charset=utf-8", runnerSource]],
    ["/modules/dashboard.js", ["text/javascript; charset=utf-8", dashboardSource]],
    ["/modules/dom-reconcile.js", ["text/javascript; charset=utf-8", reconcileSource]],
  ]);
  const server = http.createServer((request, response) => {
    const file = files.get(new URL(request.url, "http://127.0.0.1").pathname);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": file[0], "Content-Security-Policy": csp, "Cache-Control": "no-store" });
    response.end(file[1]);
  });
  const port = await listen(server);
  const debugPort = await reservePort();
  const profile = await mkdtemp(path.join(os.tmpdir(), "command-center-capacity-"));
  const edge = spawn(edgeExecutable, [
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "--window-size=800,600",
    "--window-position=-32000,-32000",
    "--force-device-scale-factor=1",
    `http://127.0.0.1:${port}/`,
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let edgeStderr = "";
  let edgeExit = null;
  let stage = "launching Edge";
  edge.stderr.on("data", (chunk) => { edgeStderr += String(chunk); });
  edge.on("exit", (code, signal) => { edgeExit = { code, signal }; });
  let cdp;
  try {
    stage = "discovering the Edge page target";
    let page;
    for (let attempt = 0; attempt < 100 && !page; attempt += 1) {
      await wait(100);
      try {
        const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
        page = targets.find((target) => target.type === "page" && target.url.startsWith(`http://127.0.0.1:${port}/`));
      } catch {}
    }
    assert.ok(page?.webSocketDebuggerUrl, "Edge test page did not expose a CDP target");
    stage = "connecting to the Edge page target";
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    stage = "enabling CDP domains";
    await Promise.all([cdp.send("Runtime.enable"), cdp.send("Page.enable"), cdp.send("DOM.enable")]);
    stage = "waiting for the capacity test module";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await evaluate(cdp, "window.capacityReady === true")) break;
      await wait(50);
    }
    assert.equal(await evaluate(cdp, "window.capacityReady === true"), true);

    for (const remaining of [100, 83, 82, 50, 10, 1, 0, 25, 75, 100]) {
      stage = `patching capacity to ${remaining}%`;
      const state = await evaluate(cdp, `window.applyCapacity(${remaining})`);
      assert.equal(state.sameNode, true, `progress node remounted at ${remaining}%`);
      assert.equal(state.tagName, "PROGRESS");
      assert.equal(state.value, remaining);
      assert.equal(state.valueAttribute, String(remaining));
      assert.equal(state.ariaNow, String(remaining));
      assert.equal(state.inlineStyle, null);
      assert.deepEqual(state.violations, []);

      stage = `capturing rendered capacity at ${remaining}%`;
      const documentNode = await cdp.send("DOM.getDocument");
      const progressNode = await cdp.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: ".usage-progress" });
      const box = await cdp.send("DOM.getBoxModel", { nodeId: progressNode.nodeId });
      const quad = box.model.border;
      const x = Math.min(quad[0], quad[2], quad[4], quad[6]);
      const y = Math.min(quad[1], quad[3], quad[5], quad[7]);
      const width = Math.max(quad[0], quad[2], quad[4], quad[6]) - x;
      const height = Math.max(quad[1], quad[3], quad[5], quad[7]) - y;
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x, y, width, height, scale: 1 } });
      const rendered = renderedFillPercent(Buffer.from(screenshot.data, "base64"));
      assert.ok(Math.abs(rendered - remaining) <= 2.5, `rendered fill ${rendered.toFixed(1)}% did not match ${remaining}%`);
    }
  } catch (error) {
    throw new Error(`${stage}: ${error.message}; Edge exit=${JSON.stringify(edgeExit)}; stderr=${edgeStderr.slice(-1000)}`);
  } finally {
    await cdp?.send("Browser.close").catch(() => {});
    cdp?.close();
    edge.kill();
    await wait(300);
    server.closeAllConnections?.();
    await closeServer(server);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
});
