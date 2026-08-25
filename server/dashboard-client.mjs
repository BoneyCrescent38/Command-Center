const SAFE_TEXT_LIMIT = 600;

const text = (value, fallback = "") =>
  typeof value === "string" ? value.slice(0, SAFE_TEXT_LIMIT) : fallback;

const number = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

const optionalNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const safePercent = (value) => {
  const parsed = optionalNumber(value);
  return parsed === null ? null : Math.max(0, Math.min(100, parsed));
};

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
  type: text(service?.type),
  status: text(service?.status, "unknown"),
  detail: text(service?.detail || service?.message),
  version: text(service?.version),
  source: text(service?.source),
  safeErrorCode: text(service?.safeErrorCode),
  checkedAt: safeDate(service?.checkedAt || service?.lastCheckedAt),
  lastSuccessAt: safeDate(service?.lastSuccessAt),
});

const safeUsageWindow = (window, parentStatus) => ({
  poolLabel: text(window?.poolLabel),
  durationLabel: text(window?.durationLabel || window?.label),
  usedPercent: safePercent(window?.usedPercent),
  remainingPercent: safePercent(window?.remainingPercent),
  resetsAt: safeDate(window?.resetsAt),
  status: text(window?.status || parentStatus, "unknown"),
});

const safeCodexUsage = (usage) => {
  const status = text(usage?.status || usage?.source?.status, "unknown");
  const windows = Array.isArray(usage?.windows)
    ? usage.windows
      .slice(0, 8)
      .map((window) => safeUsageWindow(window, status))
      .filter((window) => window.poolLabel || window.durationLabel)
    : [];

  return {
    status,
    label: text(usage?.label || usage?.planType || usage?.plan || usage?.source?.label, "Codex Usage"),
    fetchedAt: safeDate(usage?.fetchedAt),
    windows,
    creditsRemaining: optionalNumber(usage?.creditsRemaining),
    resetCreditsAvailable: optionalNumber(usage?.resetCreditsAvailable),
    safeErrorCode: text(usage?.safeErrorCode),
    usedPercent: safePercent(usage?.usedPercent ?? usage?.percentUsed),
    remainingPercent: safePercent(usage?.remainingPercent),
    resetsAt: safeDate(usage?.resetsAt || usage?.resetAt),
  };
};

const schoolInteger = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
  const parsed = optionalNumber(value);
  return parsed === null ? null : Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
};

const safeSchoolSource = (source) => ({
  status: text(source?.status, "unavailable"),
  type: text(source?.type, "unknown"),
  label: text(source?.label, "Skole utilgjengelig"),
  writable: boolean(source?.writable),
  updatedAt: safeDate(source?.updatedAt),
  lastAttemptAt: safeDate(source?.lastAttemptAt),
  refreshIntervalSeconds: number(source?.refreshIntervalSeconds),
  safeErrorCode: text(source?.safeErrorCode),
});

const safeSchoolCourse = (course) => ({
  id: text(course?.id),
  code: text(course?.code),
  name: text(course?.name, "Ukjent fag"),
  semester: text(course?.semester),
  workMode: text(course?.workMode),
  inWeeklyPlan: boolean(course?.inWeeklyPlan),
  fixedSessions: number(course?.fixedSessions),
  status: text(course?.status),
  note: text(course?.note),
  tone: text(course?.tone, "default"),
});

const safeSchoolTimetable = (entry) => ({
  id: text(entry?.id),
  weekday: schoolInteger(entry?.weekday, 1, 7),
  startTime: /^\d{2}:\d{2}$/.test(text(entry?.startTime)) ? text(entry.startTime) : "",
  endTime: /^\d{2}:\d{2}$/.test(text(entry?.endTime)) ? text(entry.endTime) : "",
  courseId: text(entry?.courseId),
  kind: text(entry?.kind || entry?.type),
  fixed: boolean(entry?.fixed),
  location: text(entry?.location),
  active: entry?.active !== false,
  note: text(entry?.note),
  course: entry?.course ? safeSchoolCourse(entry.course) : null,
});

const safeSchoolDeadline = (deadline) => ({
  id: text(deadline?.id),
  courseId: text(deadline?.courseId),
  title: text(deadline?.title, "Uten tittel"),
  type: text(deadline?.type, "other"),
  typeLabel: text(deadline?.typeLabel || deadline?.type, "Annet"),
  startDate: safeDate(deadline?.startDate),
  dueDate: safeDate(deadline?.dueDate),
  priority: text(deadline?.priority, "medium"),
  status: text(deadline?.status, "open"),
  estimatedHours: optionalNumber(deadline?.estimatedHours),
  progress: Math.max(0, Math.min(100, number(deadline?.progress))),
  note: text(deadline?.note),
  createdAt: safeDate(deadline?.createdAt),
  updatedAt: safeDate(deadline?.updatedAt),
  course: deadline?.course ? safeSchoolCourse(deadline.course) : null,
});

const safeSchoolExamPeriod = (period) => ({
  id: text(period?.id),
  name: text(period?.name, "Eksamen"),
  year: schoolInteger(period?.year, 2020, 2100),
  startWeek: schoolInteger(period?.startWeek, 1, 53),
  endWeek: schoolInteger(period?.endWeek, 1, 53),
  active: boolean(period?.active),
  status: text(period?.status),
  note: text(period?.note),
});

const safeSchoolSettings = (settings) => ({
  year: schoolInteger(settings?.year, 2020, 2100),
  startDate: safeDate(settings?.startDate),
  endDate: safeDate(settings?.endDate),
  timezone: text(settings?.timezone, "Europe/Oslo"),
});

export function sanitizeSchoolSnapshot(payload = {}) {
  return {
    schemaVersion: schoolInteger(payload?.schemaVersion, 1, 100) || 1,
    updatedAt: safeDate(payload?.updatedAt),
    courses: (Array.isArray(payload?.courses) ? payload.courses : []).slice(0, 40).map(safeSchoolCourse).filter((item) => item.id),
    timetable: (Array.isArray(payload?.timetable) ? payload.timetable : []).slice(0, 100).map(safeSchoolTimetable).filter((item) => item.id),
    deadlines: (Array.isArray(payload?.deadlines) ? payload.deadlines : []).slice(0, 150).map(safeSchoolDeadline).filter((item) => item.id),
    examPeriods: (Array.isArray(payload?.examPeriods) ? payload.examPeriods : []).slice(0, 24).map(safeSchoolExamPeriod).filter((item) => item.id),
    settings: safeSchoolSettings(payload?.settings),
    source: safeSchoolSource(payload?.source),
  };
}

export function sanitizeSchoolWeek(payload = {}) {
  return {
    requestedDate: safeDate(payload?.requestedDate),
    startDate: safeDate(payload?.startDate),
    endDate: safeDate(payload?.endDate),
    year: schoolInteger(payload?.year, 2020, 2100),
    week: schoolInteger(payload?.week, 1, 53),
    today: safeDate(payload?.today),
    updatedAt: safeDate(payload?.updatedAt),
    source: safeSchoolSource(payload?.source),
    examPeriods: (Array.isArray(payload?.examPeriods) ? payload.examPeriods : []).slice(0, 24).map(safeSchoolExamPeriod),
    days: (Array.isArray(payload?.days) ? payload.days : []).slice(0, 7).map((day) => ({
      date: safeDate(day?.date),
      weekday: schoolInteger(day?.weekday, 1, 7),
      today: boolean(day?.today),
      timetable: (Array.isArray(day?.timetable) ? day.timetable : []).slice(0, 12).map(safeSchoolTimetable),
      deadlines: (Array.isArray(day?.deadlines) ? day.deadlines : []).slice(0, 20).map(safeSchoolDeadline),
    })),
  };
}

const sanitizeSchoolMutation = (payload, type) => ({
  school: sanitizeSchoolSnapshot(payload?.school),
  saved: type === "deadline"
    ? safeSchoolDeadline(payload?.saved)
    : type === "exam"
      ? safeSchoolExamPeriod(payload?.saved)
      : type === "settings"
        ? safeSchoolSettings(payload?.saved)
        : undefined,
  deletedId: text(payload?.deletedId),
  idempotent: boolean(payload?.idempotent),
});

const KIF_COMMENT_LIMIT = 4_000;

const safeKifNr = (value) => String(value ?? "").trim().replace(/^#/, "").slice(0, 24);

const safeKifItem = (item) => ({
  nr: safeKifNr(item?.nr),
  done: boolean(item?.done),
  area: text(item?.area),
  point: text(item?.point),
  status: text(item?.status),
  statusCode: text(item?.statusCode),
  priority: text(item?.priority),
  priorityCode: text(item?.priorityCode),
  version: text(item?.version),
  comment: typeof item?.comment === "string" ? item.comment.slice(0, KIF_COMMENT_LIMIT) : "",
});

const safeKifCount = (value) => Math.max(0, Math.min(100_000, Math.trunc(number(value))));

export function sanitizeKifSnapshot(payload = {}) {
  const items = (Array.isArray(payload?.items) ? payload.items : [])
    .slice(0, 2_000)
    .map(safeKifItem)
    .filter((item) => item.nr);
  const active = items.filter((item) => !item.done);
  const stats = payload?.stats || {};
  return {
    items,
    stats: {
      open: safeKifCount(stats.open ?? active.length),
      inProgress: safeKifCount(stats.inProgress ?? active.filter((item) => item.statusCode === "in_progress").length),
      needsCheck: safeKifCount(stats.needsCheck ?? active.filter((item) => item.statusCode === "needs_check").length),
      remaining: safeKifCount(stats.remaining ?? active.filter((item) => item.statusCode === "remaining").length),
      done: safeKifCount(stats.done ?? items.filter((item) => item.done).length),
      total: safeKifCount(stats.total ?? items.length),
    },
    source: {
      status: text(payload?.source?.status, "unavailable"),
      label: text(payload?.source?.label, "KIF Masterliste utilgjengelig"),
      writable: boolean(payload?.source?.writable),
      lastSuccessAt: safeDate(payload?.source?.lastSuccessAt),
      safeErrorCode: text(payload?.source?.safeErrorCode),
    },
  };
}

export function sanitizeKifPatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw safeError(400, "invalid_kif_patch", "Ugyldig KIF-oppdatering");
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !["done", "comment"].includes(key))) throw safeError(400, "invalid_kif_patch", "Kun ferdig og kommentar kan endres");
  const patch = {};
  if (Object.hasOwn(value, "done")) {
    if (typeof value.done !== "boolean") throw safeError(400, "invalid_kif_patch", "Ferdig må være true eller false");
    patch.done = value.done;
  }
  if (Object.hasOwn(value, "comment")) {
    if (typeof value.comment !== "string" || value.comment.length > KIF_COMMENT_LIMIT) throw safeError(400, "invalid_kif_patch", "Kommentaren kan være opptil 4000 tegn");
    patch.comment = value.comment.replace(/\r\n?/g, "\n").replace(/\0/g, "");
  }
  return patch;
}

export function sanitizeDashboardSnapshot(payload = {}, health = {}) {
  const projectSnapshot = payload.projects && !Array.isArray(payload.projects) && typeof payload.projects === "object"
    ? payload.projects
    : {};
  const projectRows = Array.isArray(projectSnapshot.projects)
    ? projectSnapshot.projects
    : Array.isArray(payload.projects)
      ? payload.projects
      : [];
  const projectStats = projectSnapshot.stats || payload.stats || {};
  const projectSource = projectSnapshot.source || payload.source || {};
  const projects = projectRows.map(safeProject).filter((item) => item.id || item.name);
  const servicesInput = Array.isArray(payload.serviceStatus)
    ? payload.serviceStatus
    : Array.isArray(payload.serviceStatus?.services)
      ? payload.serviceStatus.services
      : Array.isArray(payload.services)
        ? payload.services
        : [];
  const kifSummary = sanitizeKifSnapshot(payload.kifMasterlist);

  return {
    schemaVersion: text(payload.schemaVersion, "command-center-v0"),
    generatedAt: safeDate(payload.generatedAt) || new Date().toISOString(),
    projects,
    stats: {
      active: number(projectStats.active, projects.filter((item) => /active|aktiv|in_progress|pågår/i.test(item.status)).length),
      onHold: number(projectStats.onHold, projects.filter((item) => /hold|vent|on_hold/i.test(item.status)).length),
      done: number(projectStats.done),
      averageProgress: Math.max(0, Math.min(100, number(projectStats.averageProgress))),
    },
    source: safeSource(projectSource),
    kifSummary: { stats: kifSummary.stats, source: kifSummary.source },
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
      throw safeError(response.status, text(body?.code || body?.error, "dashboard_request_failed"), text(body?.message, "Project Dashboard avviste forespørselen"));
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

  const schoolRequest = async (pathname, cookieHeader, options = {}) => {
    const method = options.method || "GET";
    const includeJson = !["GET", "HEAD"].includes(method);
    const { body } = await requestJson(pathname, {
      method,
      headers: authHeaders(cookieHeader, includeJson),
      body: Object.hasOwn(options, "body") ? JSON.stringify(options.body) : undefined,
    });
    return body;
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
        body: JSON.stringify({ pin: String(pin || ""), remember: true }),
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

    async kif(cookieHeader) {
      return sanitizeKifSnapshot(await schoolRequest("/api/kif-masterlist", cookieHeader));
    },

    async updateKif(cookieHeader, nr, value) {
      const normalizedNr = safeKifNr(nr);
      if (!/^\d+$/.test(normalizedNr)) throw safeError(400, "invalid_kif_number", "Ugyldig KIF-nummer");
      const patch = sanitizeKifPatch(value);
      return sanitizeKifSnapshot(await schoolRequest("/api/kif-masterlist/" + encodeURIComponent(normalizedNr), cookieHeader, { method: "PATCH", body: patch }));
    },

    async school(cookieHeader) {
      return sanitizeSchoolSnapshot(await schoolRequest("/api/school", cookieHeader));
    },

    async schoolWeek(cookieHeader, date = "") {
      const query = date ? "?date=" + encodeURIComponent(date) : "";
      return sanitizeSchoolWeek(await schoolRequest("/api/school/week" + query, cookieHeader));
    },

    async createSchoolDeadline(cookieHeader, value) {
      return sanitizeSchoolMutation(await schoolRequest("/api/school/deadlines", cookieHeader, { method: "POST", body: value }), "deadline");
    },

    async updateSchoolDeadline(cookieHeader, id, value) {
      return sanitizeSchoolMutation(await schoolRequest("/api/school/deadlines/" + encodeURIComponent(id), cookieHeader, { method: "PATCH", body: value }), "deadline");
    },

    async deleteSchoolDeadline(cookieHeader, id) {
      return sanitizeSchoolMutation(await schoolRequest("/api/school/deadlines/" + encodeURIComponent(id), cookieHeader, { method: "DELETE" }), "delete");
    },

    async createSchoolExamPeriod(cookieHeader, value) {
      return sanitizeSchoolMutation(await schoolRequest("/api/school/exam-periods", cookieHeader, { method: "POST", body: value }), "exam");
    },

    async updateSchoolExamPeriod(cookieHeader, id, value) {
      return sanitizeSchoolMutation(await schoolRequest("/api/school/exam-periods/" + encodeURIComponent(id), cookieHeader, { method: "PATCH", body: value }), "exam");
    },

    async deleteSchoolExamPeriod(cookieHeader, id) {
      return sanitizeSchoolMutation(await schoolRequest("/api/school/exam-periods/" + encodeURIComponent(id), cookieHeader, { method: "DELETE" }), "delete");
    },

    async updateSchoolSettings(cookieHeader, value) {
      return sanitizeSchoolMutation(await schoolRequest("/api/school/settings", cookieHeader, { method: "PATCH", body: value }), "settings");
    },
  };
}
