import { spawn } from "node:child_process";
import path from "node:path";

const audioError = (message, status = 503, code = "audio_output_unavailable") => Object.assign(new Error(message), { status, code });

const sanitizeStatus = (value = {}) => ({
  configured: Boolean(value.configured),
  active: ["speakers", "headset", "other"].includes(value.active) ? value.active : "other",
  defaultName: String(value.defaultName || "").slice(0, 160),
  speakersAvailable: Boolean(value.speakersAvailable),
  headsetAvailable: Boolean(value.headsetAvailable),
  speakersName: String(value.speakersName || "Speakers").slice(0, 160),
  headsetName: String(value.headsetName || "Headset").slice(0, 160),
});

const runPowerShell = (root, action) => new Promise((resolve, reject) => {
  const script = path.join(root, "scripts", "audio-output.ps1");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
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
    try {
      resolve(sanitizeStatus(JSON.parse(stdout)));
    } catch {
      reject(audioError("Windows-lydtjenesten returnerte ugyldig status"));
    }
  });
});

export function createAudioOutputService({ root, runner } = {}) {
  const execute = runner || ((action) => runPowerShell(root, action));
  return Object.freeze({
    status: async () => sanitizeStatus(await execute("Status")),
    toggle: async () => sanitizeStatus(await execute("Toggle")),
  });
}

export { sanitizeStatus as sanitizeAudioOutputStatus };
