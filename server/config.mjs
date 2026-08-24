import process from "node:process";

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
  });
}