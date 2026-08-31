import { spawn } from "node:child_process";
import path from "node:path";

const audioError = (message, status = 503, code = "audio_output_unavailable") => Object.assign(new Error(message), { status, code });
const SSE_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" };
const WATCH_RESTART_MS = 1000;

const sanitizeStatus = (value = {}) => {
  const speakersAvailable = Boolean(value.speakersAvailable);
  const headsetAvailable = Boolean(value.headsetAvailable);
  const inferredAvailability = speakersAvailable && headsetAvailable
    ? "ready"
    : (!speakersAvailable && !headsetAvailable ? "waiting_for_outputs" : (!speakersAvailable ? "waiting_for_speakers" : "waiting_for_headset"));
  return {
    configured: Boolean(value.configured),
    ready: Boolean(value.ready ?? (speakersAvailable && headsetAvailable)),
    availability: ["ready", "waiting_for_outputs", "waiting_for_speakers", "waiting_for_headset"].includes(value.availability) ? value.availability : inferredAvailability,
    active: ["speakers", "headset", "other"].includes(value.active) ? value.active : "other",
    defaultName: String(value.defaultName || "").slice(0, 160),
    speakersAvailable,
    headsetAvailable,
    speakersName: String(value.speakersName || "Speakers").slice(0, 160),
    headsetName: String(value.headsetName || "Headset").slice(0, 160),
  };
};

const runPowerShell = (root, action) => new Promise((resolve, reject) => {
  const script = path.join(root, "scripts", "audio-output.ps1");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    child.kill();
    reject(audioError("Windows-lydtjenesten brukte for lang tid"));
  }, 6000);
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", () => {
    clearTimeout(timer);
    reject(audioError("Windows-lydtjenesten kunne ikke startes"));
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      const notConfigured = /not configured|mangler/i.test(stderr);
      reject(audioError(notConfigured ? "Lydutganger er ikke konfigurert" : "Windows-lydutgangen kunne ikke endres", 503, notConfigured ? "audio_output_not_configured" : "audio_output_unavailable"));
      return;
    }
    try { resolve(sanitizeStatus(JSON.parse(stdout))); }
    catch { reject(audioError("Windows-lydtjenesten returnerte ugyldig status")); }
  });
});

const watchPowerShell = (root, { onStatus, onExit }) => {
  const script = path.join(root, "scripts", "audio-output.ps1");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", "Watch"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  let stopped = false;
  let exited = false;
  const finish = (error) => {
    if (exited) return;
    exited = true;
    if (!stopped) onExit(error);
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try { onStatus(JSON.parse(line)); } catch {}
      }
      newline = buffer.indexOf("\n");
    }
  });
  child.on("error", () => finish(audioError("Windows-lydvakten kunne ikke startes")));
  child.on("close", (code) => finish(code === 0 ? undefined : audioError("Windows-lydvakten stoppet")));
  return () => {
    stopped = true;
    if (!child.killed) child.kill();
  };
};

export function createAudioOutputService({ root, runner, watcherFactory } = {}) {
  const execute = runner || ((action) => runPowerShell(root, action));
  const createWatcher = watcherFactory || ((handlers) => watchPowerShell(root, handlers));
  const listeners = new Set();
  let snapshot;
  let snapshotSignature = "";
  let stopWatcher;
  let restartTimer;
  let closed = false;

  const publish = (value) => {
    const next = sanitizeStatus(value);
    const signature = JSON.stringify(next);
    snapshot = next;
    if (signature === snapshotSignature) return next;
    snapshotSignature = signature;
    listeners.forEach((listener) => listener(next));
    return next;
  };

  const ensureWatcher = () => {
    if (closed || stopWatcher || listeners.size === 0) return;
    stopWatcher = createWatcher({
      onStatus: publish,
      onExit: () => {
        stopWatcher = undefined;
        if (!closed && listeners.size > 0) {
          clearTimeout(restartTimer);
          restartTimer = setTimeout(ensureWatcher, WATCH_RESTART_MS);
        }
      },
    });
  };

  const status = async () => publish(await execute("Status"));
  const toggle = async () => publish(await execute("Toggle"));
  const openStream = (request, response) => {
    response.writeHead(200, SSE_HEADERS);
    const send = (value) => response.write("event: audio-output\ndata: " + JSON.stringify(value) + "\n\n");
    listeners.add(send);
    if (snapshot) send(snapshot);
    else status().then(send).catch(() => {});
    ensureWatcher();
    const keepAlive = setInterval(() => response.write(": audio-output\n\n"), 20000);
    const release = () => {
      clearInterval(keepAlive);
      listeners.delete(send);
      if (listeners.size === 0 && stopWatcher) {
        stopWatcher();
        stopWatcher = undefined;
      }
    };
    request.once("close", release);
  };

  const close = () => {
    closed = true;
    clearTimeout(restartTimer);
    if (stopWatcher) stopWatcher();
    stopWatcher = undefined;
    listeners.clear();
  };

  return Object.freeze({ status, toggle, openStream, close });
}

export { sanitizeStatus as sanitizeAudioOutputStatus };
