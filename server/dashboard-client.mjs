const SAFE_TEXT_LIMIT = 600;

const text = (value, fallback = "") =>
  typeof value === "string" ? value.slice(0, SAFE_TEXT_LIMIT) : fallback;

const number = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

const boolean = (value) => value === true;

const safeDate = (value) => {
  const candidate = text(value);
  return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : "";
};

const safeSource = (source) => ({
  type: text(source?.type, "unknown"),
  status: text(source?.status, "unknown"),
  label: text(source?.label, "Ikke tilgjengelig"),
  writable: boolean(source?.writable),
  lastSuccessAt: safeDate(source?.lastSuccessAt),
  lastAttemptAt: safeDate(source?.lastAttemptAt),
  refreshIntervalSeconds: number(source?.refreshIntervalSeconds),
  safeErrorCode: text(source?.safeErrorCode),
});

const safeProject = (project) => ({
  id: text(project?.id),
  name: text(project?.name, "Uten navn"),
  area: text(project?.area, "Ukjent"),
  status: text(project?.status, "Ukjent"),
  priority: text(project?.priority),
  progress: Math.max(0, Math.min(100, number(project?.progress))),
  nextStep: text(project?.nextStep),
  updatedAt: safeDate(project?.updatedAt),
  attentionReasons: Array.isArray(project?.attentionReasons)
    ? project.attentionReasons.slice(0, 4).map((item) => text(item)).filter(Boolean)
    : [],
});

const safeService = (service) => ({
  id: text(service?.id || service?.key),
  name: text(service?.name || service?.label, "Tjeneste"),
  status: text(service?.status, "unknown"),
  detail: text(service?.detail || service?.message),
  checkedAt: safeDate(service?.checkedAt || service?.lastCheckedAt),
});

const safeCodexUsage = (usage) => ({
  status: text(usage?.status || usage?.source?.status, "unknown"),
  label: text(usage?.label || usage?.plan || usage?.source?.label, "Codex Usage"),
  usedPercent: Math.max(0, Math.min(100, number(usage?.usedPercent ?? usage?.percentUsed))),
  remainingPercent: Math.max(0, Math.min(100, number(usage?.remainingPercent))),
  resetsAt: safeDate(usage?.resetsAt || usage?.resetAt),
});

export function sanitizeDashboardSnapshot(payload = {}, health = {}) {
  const projects = Array.isArray(payload.projects) ? payload.projects.map(safeProject).filter((item) => item.id || item.name) : [];
  const servicesInput = Array.isArray(payload.serviceStatus)
    ? payload.serviceStatus
    : Array.isArray(payload.serviceStatus?.services)
      ? payload.serviceStatus.services
      : Array.isArray(payload.services)
        ? payload.services
        : [];

  return {
    schemaVersion: text(payload.schemaVersion, "command-center-v0"),
    generatedAt: safeDate(payload.generatedAt) || new Date().toISOString(),
    projects,
    stats: {
      active: number(payload.stats?.active, projects.filter((item) => /active|aktiv/i.test(item.status)).length),
      onHold: number(payload.stats?.onHold, projects.filter((item) => /hold|vent/i.test(item.status)).length),
      done: number(payload.stats?.done),
      averageProgress: Math.max(0, Math.min(100, number(payload.stats?.averageProgress))),
    },
    source: safeSource(payload.source),
    codexUsage: safeCodexUsage(payload.codexUsage),
    services: servicesInput.map(safeService).slice(0, 12),
    upstreamHealth: {
      ok: health?.ok === true || health?.status === "ok",
      status: text(health?.status, health?.ok === true ? "ok" : "unknown"),
      version: text(health?.version),
      build: text(health?.build),
    },
  };
}

export function extractCookie(cookieHeader, cookieName) {
  if (!cookieHeader || !cookieName) return "";
  const prefix = cookieName + "=";
  const match = String(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return match || "";
}

const safeError = (status, code, message) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

export function createDashboardClient(config, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");

  const request = async (pathname, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.dashboardTimeoutMs);
    try {
      return await fetchImpl(config.dashboardBaseUrl + pathname, {
        method: options.method || "GET",
        headers: options.headers,
        body: options.body,
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw safeError(504, "dashboard_timeout", "Project Dashboard svarte ikke innen tidsfristen");
      throw safeError(503, "dashboard_unavailable", "Project Dashboard er ikke tilgjengelig");
    } finally {
      clearTimeout(timer);
    }
  };

  const requestJson = async (pathname, options = {}) => {
    const response = await request(pathname, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw safeError(response.status, text(body?.code, "dashboard_request_failed"), text(body?.message, "Project Dashboard avviste forespørselen"));
    }
    return { response, body };
  };

  const authHeaders = (cookieHeader, includeJson = false) => {
    const headers = { Accept: "application/json" };
    const cookie = extractCookie(cookieHeader, config.dashboardCookieName);
    if (cookie) headers.Cookie = cookie;
    if (includeJson) {
      headers["Content-Type"] = "application/json";
      headers.Origin = config.dashboardBaseUrl;
      headers["Sec-Fetch-Site"] = "same-origin";
    }
    return headers;
  };

  return {
    async session(cookieHeader) {
      const { body } = await requestJson("/api/auth/status", { headers: authHeaders(cookieHeader) });
      return { authenticated: body?.authenticated === true };
    },

    async login(pin) {
      const { response, body } = await requestJson("/api/auth/login", {
        method: "POST",
        headers: authHeaders("", true),
        body: JSON.stringify({ pin: String(pin || "") }),
      });
      return {
        authenticated: body?.authenticated === true,
        setCookie: response.headers.getSetCookie?.()[0] || response.headers.get("set-cookie") || "",
      };
    },

    async logout(cookieHeader) {
      const { response } = await requestJson("/api/auth/logout", {
        method: "POST",
        headers: authHeaders(cookieHeader, true),
        body: "{}",
      });
      return { setCookie: response.headers.getSetCookie?.()[0] || response.headers.get("set-cookie") || "" };
    },

    async dashboard(cookieHeader) {
      const headers = authHeaders(cookieHeader);
      const [dashboardResult, healthResult] = await Promise.allSettled([
        requestJson("/api/dashboard", { headers }),
        requestJson("/health", { headers: { Accept: "application/json" } }),
      ]);

      if (dashboardResult.status === "rejected") throw dashboardResult.reason;
      const health = healthResult.status === "fulfilled" ? healthResult.value.body : {};
      return sanitizeDashboardSnapshot(dashboardResult.value.body, health);
    },
  };
}