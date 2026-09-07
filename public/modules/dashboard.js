import { patchRootHtml, shouldPatchMarkup } from "./dom-reconcile.js";

const POLL_INTERVAL_MS = 20000;
const REQUEST_TIMEOUT_MS = 6000;
const MAIN_CODEX_POOL = "generell codex / work";

let rootElement;
let updateHeader;
let pollTimer;
let activeController;
let dashboardSnapshot;
let dashboardView = "dashboard";
let kifSnapshot;
let kifFilter = "open";
let kifArea = "all";
let kifEditingNr;
let kifWritePending;
let kifMessage;
let lastDashboardMarkup = "";
let lastDashboardHeaderSignature = "";

const setDashboardHeader = (...args) => {
  const signature = JSON.stringify(args);
  if (signature === lastDashboardHeaderSignature) return;
  lastDashboardHeaderSignature = signature;
  updateHeader(...args);
};

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]);

const requestJson = async (url, options = {}) => {
  activeController?.abort();
  activeController = new AbortController();
  const timeout = window.setTimeout(() => activeController.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      headers: { Accept: "application/json", ...(options.headers || {}) },
      cache: "no-store",
      signal: activeController.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.message || "Forespørselen feilet");
      error.status = response.status;
      error.code = body.code;
      throw error;
    }
    return body;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Tjenesten svarte ikke. Prøv igjen.");
      timeoutError.code = "timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
};

const statusTone = (status) => {
  const value = String(status || "").toLowerCase();
  if (/ok|fresh|live|healthy|up|aktiv/.test(value)) return "ok";
  if (/warning|stale|degraded|vent/.test(value)) return "warning";
  if (/error|down|offline|unavailable|feil/.test(value)) return "error";
  return "neutral";
};

const formatPercent = (value) => Math.round(Number(value) || 0) + "%";

const optionalPercent = (value) =>
  value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? Math.max(0, Math.min(100, Math.round(Number(value))))
    : null;

const formatResetTime = (value) => {
  if (!value) return "";
  const resetTime = new Date(value);
  if (Number.isNaN(resetTime.getTime())) return "";
  return "Nullstilles " + new Intl.DateTimeFormat("nb-NO", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(resetTime);
};

export const usageWindowMarkup = (window) => {
  const resetTime = formatResetTime(window.resetsAt);
  const used = optionalPercent(window.usedPercent);
  const remaining = optionalPercent(window.remainingPercent);
  const progressValue = remaining ?? 0;
  const progressNow = remaining === null ? "" : ' aria-valuenow="' + remaining + '"';
  const progressLabel = remaining === null ? "ukjent gjenværende kapasitet" : remaining + " prosent igjen";
  return '<div class="usage-pool">' +
    '<div class="usage-pool-top">' +
      '<div class="usage-window-copy"><strong>' + escapeHtml(window.durationLabel || "Rate limit") + '</strong><small>' + escapeHtml(resetTime || window.status || "") + '</small></div>' +
      '<div class="usage-values"><b>' + escapeHtml(remaining === null ? "–" : remaining + "%") + '</b><span>igjen</span></div>' +
    '</div>' +
    '<div class="usage-progress" role="progressbar" aria-label="' + escapeHtml((window.durationLabel || "Rate limit") + ": " + progressLabel) + '"' + progressNow + ' aria-valuemin="0" aria-valuemax="100"><i style="width:' + progressValue + '%"></i></div>' +
    '<div class="usage-used">' + escapeHtml(used === null ? "Brukt –" : used + "% brukt") + '</div>' +
  '</div>';
};

const formatUsageMetric = (value) => {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "–";
  return new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 2 }).format(Number(value));
};

export const usageAccountMetricsMarkup = (usage = {}) =>
  '<dl class="usage-account-metrics" aria-label="Konto og kvoter">' +
    '<div><dt>ChatGPT credits</dt><dd>' + escapeHtml(formatUsageMetric(usage.creditsRemaining)) + '</dd></div>' +
    '<div><dt>Kvotereset</dt><dd>' + escapeHtml(formatUsageMetric(usage.resetCreditsAvailable)) + '</dd></div>' +
  '</dl>';

const isActiveProject = (project) => /active|aktiv|in_progress|pågår/i.test(project.status);
const isOnHoldProject = (project) => /hold|vent|on_hold/i.test(project.status);

const normalizeProjectIdentity = (value) => String(value || "")
  .toLocaleLowerCase("nb-NO")
  .normalize("NFKD")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

export const isKifProject = (project) => {
  const identities = [project?.id, project?.name].map(normalizeProjectIdentity);
  return identities.some((identity) => identity === "kif-vanskebygger" || identity === "kif-vanskebygger-app");
};

const kifNumberCompare = (left, right) => String(left?.nr || "").localeCompare(String(right?.nr || ""), "nb-NO", { numeric: true });

export const sortKifItems = (items = []) => [...items].sort(kifNumberCompare);

export const filterKifItems = (items = [], filter = "open", area = "all") => {
  const filtered = items.filter((item) => {
    if (area !== "all" && item.area !== area) return false;
    if (filter === "done") return item.done;
    if (item.done) return false;
    if (filter === "open") return true;
    return item.statusCode === filter;
  });
  return sortKifItems(filtered);
};

export async function commitKifMutation(currentSnapshot, mutation) {
  try {
    return { ok: true, snapshot: await mutation(), error: null };
  } catch (error) {
    return { ok: false, snapshot: currentSnapshot, error };
  }
}

export const resolveKifScrollTop = (state, anchorContentTop, scrollHeight, clientHeight) => {
  const maximum = Math.max(0, Number(scrollHeight) - Number(clientHeight));
  const anchored = Number.isFinite(anchorContentTop) && Number.isFinite(state?.anchorOffset)
    ? anchorContentTop - state.anchorOffset
    : Number(state?.scrollTop) || 0;
  return Math.max(0, Math.min(maximum, anchored));
};

const captureKifScrollState = () => {
  const list = rootElement?.querySelector(".kif-check-list");
  if (!list) return null;
  const listRect = list.getBoundingClientRect();
  const anchor = [...list.querySelectorAll("[data-kif-open]")]
    .find((row) => row.getBoundingClientRect().bottom > listRect.top + 1);
  const anchorRect = anchor?.getBoundingClientRect();
  return {
    scrollTop: list.scrollTop,
    anchorNr: anchor?.dataset.kifOpen,
    anchorOffset: anchorRect ? anchorRect.top - listRect.top : null,
  };
};

const restoreKifScrollState = (state) => {
  const list = rootElement?.querySelector(".kif-check-list");
  if (!list) return;
  if (!state) {
    list.scrollTop = 0;
    return;
  }
  const anchor = [...list.querySelectorAll("[data-kif-open]")]
    .find((row) => row.dataset.kifOpen === state.anchorNr);
  const listRect = list.getBoundingClientRect();
  const anchorRect = anchor?.getBoundingClientRect();
  const anchorContentTop = anchorRect ? anchorRect.top - listRect.top + list.scrollTop : null;
  list.scrollTop = resolveKifScrollTop(state, anchorContentTop, list.scrollHeight, list.clientHeight);
};

export const selectMainUsageWindows = (windows = []) =>
  windows.filter((window) => String(window?.poolLabel || "").trim().toLowerCase() === MAIN_CODEX_POOL);

export const selectVisibleProjects = (projects = []) => {
  const activeProjects = projects.filter(isActiveProject).slice(0, 8);
  const onHoldProjects = projects.filter(isOnHoldProject);
  if (activeProjects.length || onHoldProjects.length) {
    return activeProjects.length < 8 && onHoldProjects.length
      ? [...activeProjects, onHoldProjects[0]]
      : activeProjects;
  }
  return projects.slice(0, 8);
};

export const formatProjectBadge = (activeCount, shownActiveCount) => {
  const total = Math.max(0, Number(activeCount) || 0);
  return total > shownActiveCount
    ? total + " aktive · " + shownActiveCount + " vist"
    : total + " aktive";
};

const selectFocus = (projects) =>
  projects.find((project) => /høy|high|kritisk/i.test(project.priority)) ||
  projects.find((project) => /active|aktiv|in_progress|pågår/i.test(project.status)) ||
  projects[0];

const serviceMarkup = (service) => {
  const tone = statusTone(service.status);
  return '<li class="service-row">' +
    '<span class="status-dot ' + tone + '"></span>' +
    '<div><strong>' + escapeHtml(service.name) + '</strong><small>' + escapeHtml(service.detail || service.status) + '</small></div>' +
    '<span class="service-state ' + tone + '">' + escapeHtml(service.status || "Ukjent") + '</span>' +
  '</li>';
};

const projectMarkup = (project, kifSummary) => {
  const kif = isKifProject(project);
  const tag = kif ? "button" : "li";
  const attributes = kif ? ' type="button" data-project-deep-view="kif" aria-label="Åpne KIF Checklist"' : "";
  const secondary = kif && kifSummary?.source?.status !== "unavailable"
    ? '<span class="project-kif-status">' + escapeHtml(kifSummary?.stats?.open ?? 0) + ' åpne · ' + escapeHtml(kifSummary?.stats?.needsCheck ?? 0) + ' må sjekkes</span>'
    : "";
  return '<' + tag + ' class="project-row' + (kif ? ' project-row-button' : '') + '"' + attributes + '>' +
    '<div class="project-leading">' +
      '<span class="priority-mark ' + statusTone(project.priority) + '"></span>' +
      '<div><strong>' + escapeHtml(project.name) + '</strong><small>' + escapeHtml(project.area) + ' · ' + escapeHtml(project.status) + '</small></div>' +
    '</div>' +
    '<div class="project-progress">' +
      '<span>' + formatPercent(project.progress) + '</span>' +
      '<i><b style="width:' + Math.max(0, Math.min(100, Number(project.progress) || 0)) + '%"></b></i>' +
    '</div>' +
    '<p>' + escapeHtml(project.nextStep || "Neste steg er ikke registrert") + secondary + '</p>' +
  '</' + tag + '>';
};

const renderLogin = () => {
  lastDashboardMarkup = "";
  setDashboardHeader("Project Dashboard", { label: "Innlogging kreves", tone: "warning" });
  rootElement.innerHTML =
    '<section class="center-state">' +
      '<form id="dashboard-login" class="login-card">' +
        '<p class="eyebrow">SIKKER TILGANG</p>' +
        '<h2>Koble til Project Dashboard</h2>' +
        '<p>Bruk den eksisterende Dashboard-PIN-en. Den sendes videre og lagres aldri her.</p>' +
        '<label for="dashboard-pin">PIN</label>' +
        '<div class="login-row">' +
          '<input id="dashboard-pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required>' +
          '<button type="submit">Åpne</button>' +
        '</div>' +
        '<p id="login-error" class="form-error" role="alert"></p>' +
      '</form>' +
    '</section>';

  rootElement.querySelector("#dashboard-login").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const error = form.querySelector("#login-error");
    button.disabled = true;
    button.textContent = "Kobler til…";
    error.textContent = "";
    try {
      const result = await requestJson("/api/dashboard/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: new FormData(form).get("pin"), remember: true }),
      });
      form.reset();
      if (result.authenticated) await loadDashboard();
      else error.textContent = "Innloggingen ble ikke godkjent.";
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      button.disabled = false;
      button.textContent = "Åpne";
    }
  });
};

const renderOffline = (message) => {
  lastDashboardMarkup = "";
  setDashboardHeader("Project Dashboard", { label: "Frakoblet", tone: "error" });
  rootElement.innerHTML =
    '<section class="center-state">' +
      '<article class="offline-card">' +
        '<p class="eyebrow">TILKOBLING</p>' +
        '<h2>Dashboard er ikke tilgjengelig</h2>' +
        '<p>' + escapeHtml(message) + '</p>' +
        '<button id="dashboard-retry" type="button">Prøv igjen</button>' +
      '</article>' +
    '</section>';
  rootElement.querySelector("#dashboard-retry").addEventListener("click", bootstrap);
};

const KIF_FILTERS = [
  { id: "open", label: "Åpne", stat: "open" },
  { id: "in_progress", label: "Pågår", stat: "inProgress" },
  { id: "needs_check", label: "Må sjekkes", stat: "needsCheck" },
  { id: "remaining", label: "Gjenstår", stat: "remaining" },
  { id: "done", label: "Ferdig", stat: "done" },
];

const kifSourceCopy = (source) => {
  if (source?.status === "fresh" && source?.writable) return "Google Sheet · Live";
  if (source?.status === "stale") return "Siste snapshot · Read-only";
  return source?.label || "KIF utilgjengelig";
};

const kifItemMarkup = (item, writable) => {
  const pending = String(kifWritePending || "") === String(item.nr);
  const status = item.status || item.statusCode || "Ukjent";
  return '<article class="kif-check-item' + (pending ? ' saving' : '') + '" data-kif-open="' + escapeHtml(item.nr) + '" tabindex="0">' +
    '<button class="kif-done-toggle' + (item.done ? ' checked' : '') + '" type="button" data-kif-toggle="' + escapeHtml(item.nr) + '" aria-pressed="' + String(item.done) + '"' + (!writable || pending ? ' disabled' : '') + '><span>' + (item.done ? "✓" : "") + '</span><small>' + (item.done ? "Ferdig" : "Marker ferdig") + '</small></button>' +
    '<div class="kif-item-copy"><div class="kif-item-title"><span>#' + escapeHtml(item.nr) + '</span><strong>' + escapeHtml(item.point || "Uten punkttekst") + '</strong></div>' +
      '<div class="kif-item-meta"><span>' + escapeHtml(item.area || "Uten område") + '</span><span class="kif-status-code ' + statusTone(item.statusCode) + '">' + escapeHtml(status) + '</span>' + (item.priority ? '<span>' + escapeHtml(item.priority) + '</span>' : '') + (item.version ? '<span>' + escapeHtml(item.version) + '</span>' : '') + '</div>' +
      '<p class="kif-comment-preview">' + escapeHtml(item.comment || "Ingen kommentar eller neste steg") + '</p></div>' +
    '<div class="kif-item-action"><button type="button" data-kif-comment="' + escapeHtml(item.nr) + '">Kommentar</button>' + (pending ? '<span>Lagrer…</span>' : '') + '</div>' +
  '</article>';
};

const kifDrawerMarkup = (snapshot) => {
  if (!kifEditingNr) return "";
  const item = snapshot.items.find((candidate) => String(candidate.nr) === String(kifEditingNr));
  if (!item) return "";
  const writable = snapshot.source?.writable === true;
  const pending = String(kifWritePending || "") === String(item.nr);
  return '<div class="kif-drawer-backdrop" data-kif-dismiss="true"><aside class="kif-drawer" role="dialog" aria-modal="true" aria-labelledby="kif-drawer-title">' +
    '<div class="kif-drawer-heading"><div><p class="eyebrow">KIF-PUNKT #' + escapeHtml(item.nr) + '</p><h2 id="kif-drawer-title">' + escapeHtml(item.point || "Uten punkttekst") + '</h2></div><button type="button" data-kif-close aria-label="Lukk">×</button></div>' +
    '<dl class="kif-details"><div><dt>Område</dt><dd>' + escapeHtml(item.area || "–") + '</dd></div><div><dt>Status</dt><dd>' + escapeHtml(item.status || "–") + '</dd></div><div><dt>Prioritet</dt><dd>' + escapeHtml(item.priority || "–") + '</dd></div><div><dt>Versjon</dt><dd>' + escapeHtml(item.version || "–") + '</dd></div></dl>' +
    (!writable ? '<p class="kif-readonly">Read-only: viser siste tilgjengelige snapshot.</p>' : '') +
    '<form id="kif-edit-form"><label for="kif-comment">Kommentar / neste steg</label><textarea id="kif-comment" maxlength="4000"' + (!writable || pending ? ' disabled' : '') + '>' + escapeHtml(item.comment) + '</textarea>' +
      '<label class="kif-drawer-done"><input id="kif-done" type="checkbox"' + (item.done ? ' checked' : '') + (!writable || pending ? ' disabled' : '') + '><span>Ferdig</span></label>' +
      '<div class="kif-drawer-actions"><button type="button" class="quiet-action" data-kif-close>Avbryt</button><button type="submit"' + (!writable || pending ? ' disabled' : '') + '>' + (pending ? "Lagrer…" : "Lagre") + '</button></div></form>' +
  '</aside></div>';
};

const scheduleKifPoll = () => {
  window.clearTimeout(pollTimer);
  if (dashboardView === "kif" && !kifEditingNr && !kifWritePending) pollTimer = window.setTimeout(() => loadKif(), POLL_INTERVAL_MS);
};

const renderKif = ({ preserveScroll = true } = {}) => {
  if (!rootElement || !kifSnapshot) return;
  const scrollState = preserveScroll ? captureKifScrollState() : null;
  const source = kifSnapshot.source || {};
  const writable = source.writable === true;
  const areas = [...new Set(kifSnapshot.items.map((item) => item.area).filter(Boolean))].sort((a, b) => a.localeCompare(b, "nb-NO"));
  const items = filterKifItems(kifSnapshot.items, kifFilter, kifArea);
  const sourceText = kifSourceCopy(source);
  setDashboardHeader("KIF Vanskebygger", { label: sourceText, tone: statusTone(source.status) });
  rootElement.innerHTML = '<section class="kif-workspace">' +
    '<header class="kif-workspace-header"><button type="button" class="kif-back" data-kif-back>← Dashboard</button><div><p class="eyebrow">PROJECT DASHBOARD / KIF CHECKLIST</p><h2>KIF Vanskebygger</h2></div><div class="kif-source ' + statusTone(source.status) + '"><span class="status-dot ' + statusTone(source.status) + '"></span><strong>' + escapeHtml(sourceText) + '</strong><button type="button" data-kif-refresh aria-label="Oppdater KIF">↻</button></div></header>' +
    (!writable ? '<p class="kif-source-warning">' + escapeHtml(source.status === "stale" ? "Read-only: viser siste gyldige snapshot." : "KIF-kilden er ikke tilgjengelig for skriving.") + '</p>' : '') +
    (kifMessage ? '<p class="kif-message ' + escapeHtml(kifMessage.tone) + '" role="status">' + escapeHtml(kifMessage.text) + '</p>' : '') +
    '<nav class="kif-filter-bar" aria-label="Filtrer KIF-punkter">' + KIF_FILTERS.map((filter) => '<button type="button" data-kif-filter="' + filter.id + '" class="' + (kifFilter === filter.id ? "active" : "") + '"><strong>' + escapeHtml(kifSnapshot.stats?.[filter.stat] ?? 0) + '</strong><span>' + filter.label + '</span></button>').join("") +
      (areas.length > 1 ? '<label class="kif-area-filter"><span>Område</span><select data-kif-area><option value="all">Alle områder</option>' + areas.map((area) => '<option value="' + escapeHtml(area) + '"' + (kifArea === area ? ' selected' : '') + '>' + escapeHtml(area) + '</option>').join("") + '</select></label>' : '') + '</nav>' +
    '<div class="kif-list-panel"><div class="kif-list-summary"><strong>' + escapeHtml(items.length) + ' punkt' + (items.length === 1 ? "" : "er") + '</strong><span>' + escapeHtml(writable ? "Live write" : "Read-only") + '</span></div><div class="kif-check-list">' + (items.map((item) => kifItemMarkup(item, writable)).join("") || '<div class="kif-empty"><strong>Ingen punkter i dette filteret</strong><span>Velg et annet status- eller områdefilter.</span></div>') + '</div></div>' +
    kifDrawerMarkup(kifSnapshot) + '</section>';

  restoreKifScrollState(scrollState);

  rootElement.querySelector("[data-kif-back]").addEventListener("click", () => {
    dashboardView = "dashboard";
    kifEditingNr = undefined;
    window.clearTimeout(pollTimer);
    renderDashboard(dashboardSnapshot);
    pollTimer = window.setTimeout(loadDashboard, POLL_INTERVAL_MS);
  });
  rootElement.querySelector("[data-kif-refresh]").addEventListener("click", () => loadKif({ force: true, loading: false }));
  rootElement.querySelectorAll("[data-kif-filter]").forEach((button) => button.addEventListener("click", () => { kifFilter = button.dataset.kifFilter; kifMessage = undefined; renderKif({ preserveScroll: false }); }));
  rootElement.querySelector("[data-kif-area]")?.addEventListener("change", (event) => { kifArea = event.target.value; renderKif({ preserveScroll: false }); });
  rootElement.querySelectorAll("[data-kif-open]").forEach((row) => {
    const open = () => { kifEditingNr = row.dataset.kifOpen; window.clearTimeout(pollTimer); renderKif(); rootElement.querySelector("#kif-comment")?.focus(); };
    row.addEventListener("click", (event) => { if (!event.target.closest("button")) open(); });
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  });
  rootElement.querySelectorAll("[data-kif-comment]").forEach((button) => button.addEventListener("click", () => { kifEditingNr = button.dataset.kifComment; window.clearTimeout(pollTimer); renderKif(); rootElement.querySelector("#kif-comment")?.focus(); }));
  rootElement.querySelectorAll("[data-kif-toggle]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const item = kifSnapshot.items.find((candidate) => String(candidate.nr) === button.dataset.kifToggle);
    if (item) mutateKif(item.nr, { done: !item.done }, "Punkt #" + item.nr + (item.done ? " gjenåpnet" : " markert ferdig"));
  }));
  rootElement.querySelectorAll("[data-kif-close]").forEach((button) => button.addEventListener("click", () => { kifEditingNr = undefined; renderKif(); scheduleKifPoll(); }));
  rootElement.querySelector("[data-kif-dismiss]")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) { kifEditingNr = undefined; renderKif(); scheduleKifPoll(); } });
  rootElement.querySelector("#kif-edit-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const item = kifSnapshot.items.find((candidate) => String(candidate.nr) === String(kifEditingNr));
    if (item) mutateKif(item.nr, { comment: rootElement.querySelector("#kif-comment").value, done: rootElement.querySelector("#kif-done").checked }, "Punkt #" + item.nr + " lagret", true);
  });
  scheduleKifPoll();
};

async function mutateKif(nr, patch, successText, closeEditor = false) {
  if (kifWritePending || kifSnapshot?.source?.writable !== true) return;
  window.clearTimeout(pollTimer);
  const previousSnapshot = kifSnapshot;
  kifWritePending = String(nr);
  kifMessage = { tone: "neutral", text: "Lagrer punkt #" + nr + "…" };
  renderKif();
  const result = await commitKifMutation(previousSnapshot, () => requestJson("/api/kif-masterlist/" + encodeURIComponent(nr), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
  kifWritePending = undefined;
  kifSnapshot = result.snapshot;
  if (result.ok) {
    if (closeEditor) kifEditingNr = undefined;
    kifMessage = { tone: "ok", text: successText };
  } else {
    kifMessage = { tone: "error", text: result.error?.message || "Punktet kunne ikke lagres. Ingen endring ble beholdt." };
  }
  renderKif();
}

async function loadKif({ force = false, loading = false, resetScroll = false } = {}) {
  if (dashboardView !== "kif") return;
  if (!force && (kifEditingNr || kifWritePending)) return scheduleKifPoll();
  window.clearTimeout(pollTimer);
  if (loading && !kifSnapshot) rootElement.innerHTML = '<section class="center-state"><div class="loading-state"><span></span><p>Henter KIF Checklist…</p></div></section>';
  try {
    kifSnapshot = await requestJson("/api/kif-masterlist");
    kifMessage = undefined;
    renderKif({ preserveScroll: !resetScroll });
  } catch (error) {
    if (error.status === 401) return renderLogin();
    if (kifSnapshot) {
      kifMessage = { tone: "error", text: error.message || "KIF kunne ikke oppdateres. Viser siste snapshot." };
      renderKif();
    } else {
      setDashboardHeader("KIF Vanskebygger", { label: "Ikke tilgjengelig", tone: "error" });
      rootElement.innerHTML = '<section class="center-state"><article class="offline-card"><p class="eyebrow">KIF CHECKLIST</p><h2>KIF-data er ikke tilgjengelig</h2><p>' + escapeHtml(error.message) + '</p><div class="kif-offline-actions"><button type="button" data-kif-back>← Dashboard</button><button type="button" data-kif-retry>Prøv igjen</button></div></article></section>';
      rootElement.querySelector("[data-kif-back]").addEventListener("click", () => { dashboardView = "dashboard"; renderDashboard(dashboardSnapshot); });
      rootElement.querySelector("[data-kif-retry]").addEventListener("click", () => loadKif({ force: true, loading: true }));
    }
  }
}

const openKifView = () => {
  dashboardView = "kif";
  kifFilter = "open";
  kifArea = "all";
  kifEditingNr = undefined;
  kifMessage = undefined;
  window.clearTimeout(pollTimer);
  loadKif({ force: true, loading: true, resetScroll: true });
};

const handleKifEscape = (event) => {
  if (event.key === "Escape" && dashboardView === "kif" && kifEditingNr && !kifWritePending) {
    kifEditingNr = undefined;
    renderKif();
    scheduleKifPoll();
  }
};

const renderDashboard = (snapshot) => {
  dashboardSnapshot = snapshot;
  dashboardView = "dashboard";
  const projects = snapshot.projects || [];
  const focus = selectFocus(projects);
  const sourceTone = statusTone(snapshot.source?.status);
  const usageWindows = snapshot.codexUsage?.windows || [];
  const mainUsageWindows = selectMainUsageWindows(usageWindows);
  const mainPoolName = mainUsageWindows[0]?.poolLabel || "Generell Codex / Work";
  const visibleProjects = selectVisibleProjects(projects);
  const activeProjects = projects.filter(isActiveProject);
  const shownActiveProjects = visibleProjects.filter(isActiveProject).length;
  const activeCount = snapshot.stats?.active ?? activeProjects.length;
  const projectBadge = formatProjectBadge(activeCount, shownActiveProjects);
  const services = snapshot.services?.length
    ? snapshot.services
    : [{ name: "Project Dashboard", status: snapshot.upstreamHealth?.status || "unknown", detail: snapshot.upstreamHealth?.ok ? "Tilkoblet" : "Ukjent" }];

  setDashboardHeader("Project Dashboard", {
    label: snapshot.source?.label || "Sanitert live-data",
    tone: sourceTone,
  });

  const markup = '<section class="dashboard-grid">' +
      '<article class="cc-card capacity-card">' +
        '<div class="card-heading"><div><p class="eyebrow">KAPASITET</p><h2>' + escapeHtml(mainPoolName) + '</h2></div><span class="mini-badge">' + escapeHtml(snapshot.codexUsage?.status || "Ukjent") + '</span></div>' +
        '<div class="usage-list">' + (mainUsageWindows.map(usageWindowMarkup).join("") || '<p class="usage-empty">Hovedkvoten er ikke tilgjengelig</p>') + '</div>' +
        usageAccountMetricsMarkup(snapshot.codexUsage) +
      '</article>' +

      '<article class="cc-card focus-card">' +
        '<div class="card-heading"><div><p class="eyebrow">DAGENS RETNING</p><h2>' + escapeHtml(focus?.name || "Ingen aktiv retning") + '</h2></div><span class="mini-badge warm">' + escapeHtml(focus?.priority || "Fokus") + '</span></div>' +
        '<p class="focus-next">' + escapeHtml(focus?.nextStep || "Velg neste tydelige leveranse i Project Dashboard.") + '</p>' +
        '<div class="focus-meta"><span>' + escapeHtml(focus?.area || "Command Center") + '</span><strong>' + formatPercent(focus?.progress) + '</strong></div>' +
      '</article>' +

      '<article class="cc-card attention-card project-overview-card">' +
        '<div class="card-heading"><div><p class="eyebrow">PROSJEKTER</p><h2>Prosjektoversikt</h2></div><span class="mini-badge">' + escapeHtml(snapshot.source?.status || "Ukjent") + '</span></div>' +
        '<div class="metric-strip overview-metrics">' +
          '<div><strong>' + escapeHtml(snapshot.stats?.active ?? 0) + '</strong><span>aktive</span></div>' +
          '<div><strong>' + escapeHtml(snapshot.stats?.onHold ?? 0) + '</strong><span>på vent</span></div>' +
          '<div><strong>' + escapeHtml(snapshot.stats?.done ?? 0) + '</strong><span>ferdige</span></div>' +
          '<div><strong>' + formatPercent(snapshot.stats?.averageProgress) + '</strong><span>snitt fremdrift</span></div>' +
        '</div>' +
      '</article>' +

      '<article class="cc-card projects-card">' +
        '<div class="card-heading"><div><p class="eyebrow">PROSJEKTER</p><h2>Aktivt arbeid</h2></div><span class="mini-badge">' + escapeHtml(projectBadge) + '</span></div>' +
        '<ul class="project-list">' + (visibleProjects.map((project) => projectMarkup(project, snapshot.kifSummary)).join("") || '<li class="empty-row">Ingen prosjekter i det saniterte snapshotet.</li>') + '</ul>' +
      '</article>' +

      '<article class="cc-card services-card">' +
        '<div class="card-heading"><div><p class="eyebrow">TJENESTER</p><h2>Drift</h2></div><button id="dashboard-refresh" class="icon-action" type="button" aria-label="Oppdater">↻</button></div>' +
        '<ul class="service-list">' + services.slice(0, 5).map(serviceMarkup).join("") + '</ul>' +
        '<button id="dashboard-logout" class="quiet-action" type="button">Logg ut av Dashboard</button>' +
      '</article>' +
    '</section>';

  if (shouldPatchMarkup(lastDashboardMarkup, markup) || !rootElement.querySelector(".dashboard-grid")) {
    patchRootHtml(rootElement, markup);
    lastDashboardMarkup = markup;
  }

  rootElement.querySelector("#dashboard-refresh").addEventListener("click", loadDashboard);
  rootElement.querySelector('[data-project-deep-view="kif"]')?.addEventListener("click", openKifView);
  rootElement.querySelector("#dashboard-logout").onclick = async () => {
    try {
      await requestJson("/api/dashboard/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } finally {
      renderLogin();
    }
  };
};

async function loadDashboard() {
  try {
    const snapshot = await requestJson("/api/dashboard/data");
    renderDashboard(snapshot);
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(loadDashboard, POLL_INTERVAL_MS);
  } catch (error) {
    if (error.status === 401) {
      renderLogin();
      return;
    }

    if (dashboardSnapshot && dashboardView === "dashboard") {
      const projects = dashboardSnapshot.projects;
      dashboardSnapshot = {
        ...dashboardSnapshot,
        source: {
          ...(dashboardSnapshot.source || {}),
          status: "stale",
          stale: true,
        },
        projects: Array.isArray(projects) ? projects : {
          ...(projects || {}),
          source: {
            ...(projects?.source || {}),
            status: "stale",
            stale: true,
          },
        },
      };
      renderDashboard(dashboardSnapshot);
      window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(loadDashboard, POLL_INTERVAL_MS);
      return;
    }

    renderOffline(error.message);
  }
}

async function bootstrap() {
  lastDashboardMarkup = "";
  setDashboardHeader("Project Dashboard", { label: "Kobler til", tone: "neutral" });
  rootElement.innerHTML =
    '<section class="center-state">' +
      '<div class="loading-state"><span></span><p>Henter sikker Dashboard-status…</p></div>' +
    '</section>';
  try {
    const session = await requestJson("/api/dashboard/session");
    if (session.authenticated) await loadDashboard();
    else renderLogin();
  } catch (error) {
    renderOffline(error.message);
  }
}

export const DashboardModule = {
  id: "dashboard",
  mount({ root, setHeader }) {
    rootElement = root;
    lastDashboardMarkup = "";
    lastDashboardHeaderSignature = "";
    updateHeader = setHeader;
    window.addEventListener("keydown", handleKifEscape);
    bootstrap();
  },
  unmount() {
    window.clearTimeout(pollTimer);
    activeController?.abort();
    window.removeEventListener("keydown", handleKifEscape);
    dashboardSnapshot = undefined;
    lastDashboardMarkup = "";
    lastDashboardHeaderSignature = "";
    kifSnapshot = undefined;
    dashboardView = "dashboard";
    kifEditingNr = undefined;
    kifWritePending = undefined;
    rootElement = undefined;
    updateHeader = undefined;
  },
};
