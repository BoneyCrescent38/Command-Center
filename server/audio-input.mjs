import { spawn } from "node:child_process";
import path from "node:path";

const audioError = (message, status = 503, code = "audio_input_unavailable") => Object.assign(new Error(message), { status, code });
const text = (value, length) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, length) : "";

export function sanitizeAudioInputStatus(value = {}) {
  const devices = [];
  const ids = new Set();
  for (const device of Array.isArray(value?.devices) ? value.devices : []) {
    const id = text(device?.id, 256);
    if (!id || id !== device.id || device.available !== true || ids.has(id)) continue;
    ids.add(id);
    devices.push({ id, name: text(device.name, 160) || "Mikrofon", available: true, active: id === value.activeId });
  }
  const active = devices.find((device) => device.active);
  return { ready: devices.length > 0, activeId: active?.id || "", activeName: active?.name || "", devices };
}

const runPowerShell = (root, action, deviceId) => new Promise((resolve, reject) => {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "audio-input.ps1"), "-Action", action];
  if (deviceId) args.push("-DeviceId", deviceId);
  const child = spawn("powershell.exe", args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => { child.kill(); reject(audioError("Mikrofontjenesten brukte for lang tid")); }, 6000);
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.once("error", () => { clearTimeout(timer); reject(audioError("Mikrofontjenesten kunne ikke startes")); });
  child.once("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) return reject(/capture_target_unavailable/.test(stderr)
      ? audioError("Mikrofonen er ikke lenger tilgjengelig", 409, "audio_input_target_unavailable")
      : audioError("Windows kunne ikke bekrefte mikrofonstatus"));
    try { resolve(JSON.parse(stdout)); } catch { reject(audioError("Mikrofontjenesten returnerte ugyldig status")); }
  });
});

const watchPowerShell = (root, { onStatus, onExit }) => {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "audio-input.ps1"), "-Action", "Watch"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  let stopped = false;
  let exited = false;
  const finish = () => { if (!exited && !stopped) onExit(); exited = true; };
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) { try { onStatus(JSON.parse(line)); } catch {} }
    }
  });
  child.stderr.resume();
  child.once("error", finish);
  child.once("close", finish);
  return () => { stopped = true; child.kill(); };
};

export function createAudioInputService({ root, runner, watcherFactory, restartMs = 1000 } = {}) {
  const execute = runner || ((action, deviceId) => runPowerShell(root, action, deviceId));
  const createWatcher = watcherFactory || ((handlers) => watchPowerShell(root, handlers));
  const clients = new Set();
  let snapshot;
  let signature = "";
  let revision = 0;
  let stopWatcher;
  let restartTimer;
  let closed = false;
  let mutation = Promise.resolve();
  const publish = (value) => {
    const next = sanitizeAudioInputStatus(value);
    const nextSignature = JSON.stringify(next);
    snapshot = next;
    revision += 1;
    if (nextSignature !== signature) {
      signature = nextSignature;
      clients.forEach((send) => send(next));
    }
    return next;
  };
  const status = async () => {
    const before = revision;
    const result = await execute("Status");
    // A slower Status subprocess must not overwrite a newer watcher event.
    return before === revision ? publish(result) : snapshot;
  };
  const setDefault = (deviceId) => {
    const operation = mutation.then(async () => {
      if (typeof deviceId !== "string" || !deviceId || deviceId.length > 256 || /[\u0000-\u001f\u007f]/.test(deviceId))
        throw audioError("Ugyldig mikrofon", 400, "audio_input_invalid_device");
      const current = sanitizeAudioInputStatus(await execute("Status"));
      if (!current.devices.some((device) => device.id === deviceId))
        throw audioError("Mikrofonen er ikke tilgjengelig", 409, "audio_input_target_unavailable");
      // The PowerShell helper rechecks Capture + ACTIVE immediately before SetDefaultEndpoint.
      const changed = sanitizeAudioInputStatus(await execute("Set", deviceId));
      if (changed.activeId !== deviceId) throw audioError("Windows bekreftet ikke mikrofonbyttet");
      return publish(changed);
    });
    mutation = operation.catch(() => {});
    return operation;
  };
  const ensureWatcher = () => {
    if (closed || stopWatcher || clients.size === 0) return;
    try {
      stopWatcher = createWatcher({
        onStatus: publish,
        onExit: () => {
          stopWatcher = undefined;
          publish({});
          if (!closed && clients.size) restartTimer = setTimeout(ensureWatcher, restartMs);
        },
      });
    } catch {
      publish({});
      if (!closed && clients.size) restartTimer = setTimeout(ensureWatcher, restartMs);
    }
  };
  const openStream = (request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
    const send = (value) => response.write("event: audio-input\ndata: " + JSON.stringify(value) + "\n\n");
    clients.add(send);
    if (snapshot) send(snapshot);
    ensureWatcher();
    status().catch(() => { if (clients.has(send)) publish({}); });
    const keepAlive = setInterval(() => response.write(": audio-input\n\n"), 20000);
    const release = () => {
      clearInterval(keepAlive);
      clients.delete(send);
      if (!clients.size) {
        clearTimeout(restartTimer);
        stopWatcher?.();
        stopWatcher = undefined;
      }
    };
    response.once("close", release);
  };
  const close = () => {
    closed = true;
    clearTimeout(restartTimer);
    stopWatcher?.();
    stopWatcher = undefined;
    clients.clear();
  };
  return Object.freeze({ status, setDefault, openStream, close });
}
