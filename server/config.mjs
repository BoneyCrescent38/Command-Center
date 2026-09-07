import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const name of [".env", ".env.local"]) {
  const file = path.join(root, name);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

const normalizeBaseUrl = (value) => {
  const candidate = value || "http://127.0.0.1:4317";
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("PROJECT_DASHBOARD_URL must use http or https");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
};

export function loadConfig(overrides = {}) {
  const env = process.env;
  return Object.freeze({
    host: overrides.host || env.COMMAND_CENTER_HOST || "127.0.0.1",
    port: overrides.port ?? integer(env.COMMAND_CENTER_PORT, 4337, 1, 65535),
    dashboardBaseUrl: overrides.dashboardBaseUrl || normalizeBaseUrl(env.PROJECT_DASHBOARD_URL),
    dashboardCookieName: overrides.dashboardCookieName || env.PROJECT_DASHBOARD_COOKIE_NAME || "dashboard_session",
    dashboardTimeoutMs: overrides.dashboardTimeoutMs ?? integer(env.PROJECT_DASHBOARD_TIMEOUT_MS, 2500, 250, 15000),
    spotifyClientId: overrides.spotifyClientId ?? env.SPOTIFY_CLIENT_ID ?? "",
    spotifyRedirectUri: overrides.spotifyRedirectUri || env.SPOTIFY_REDIRECT_URI || "http://127.0.0.1:4337/api/spotify/callback",
    spotifyTokenFile: overrides.spotifyTokenFile || path.join(root, ".runtime", "spotify-tokens.json"),
    spotifyPocLogFile: overrides.spotifyPocLogFile || path.join(root, ".runtime", "spotify-poc.jsonl"),
  });
}
