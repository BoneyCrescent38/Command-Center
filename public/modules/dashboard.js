const POLL_INTERVAL_MS = 20000;
const REQUEST_TIMEOUT_MS = 6000;

let rootElement;
let updateHeader;
let pollTimer;
let activeController;

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

const selectFocus = (projects) =>
  projects.find((project) => /høy|high|kritisk/i.test(project.priority)) ||
  projects.find((project) => /active|aktiv/i.test(project.status)) ||
  projects[0];

const serviceMarkup = (service) => {
  const tone = statusTone(service.status);
  return '<li class="service-row">' +
    '<span class="status-dot ' + tone + '"></span>' +
    '<div><strong>' + escapeHtml(service.name) + '</strong><small>' + escapeHtml(service.detail || service.status) + '</small></div>' +
    '<span class="service-state ' + tone + '">' + escapeHtml(service.status || "Ukjent") + '</span>' +
  '</li>';
};

const projectMarkup = (project) =>
  '<li class="project-row">' +
    '<div class="project-leading">' +
      '<span class="priority-mark ' + statusTone(project.priority) + '"></span>' +
      '<div><strong>' + escapeHtml(project.name) + '</strong><small>' + escapeHtml(project.area) + ' · ' + escapeHtml(project.status) + '</small></div>' +
    '</div>' +
    '<div class="project-progress">' +
      '<span>' + formatPercent(project.progress) + '</span>' +
      '<i><b style="width:' + Math.max(0, Math.min(100, Number(project.progress) || 0)) + '%"></b></i>' +
    '</div>' +
    '<p>' + escapeHtml(project.nextStep || "Neste steg er ikke registrert") + '</p>' +
  '</li>';

const renderLogin = () => {
  updateHeader("Project Dashboard", { label: "Innlogging kreves", tone: "warning" });
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
        body: JSON.stringify({ pin: new FormData(form).get("pin") }),
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
  updateHeader("Project Dashboard", { label: "Frakoblet", tone: "error" });
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

const renderDashboard = (snapshot) => {
  const projects = snapshot.projects || [];
  const focus = selectFocus(projects);
  const sourceTone = statusTone(snapshot.source?.status);
  const services = snapshot.services?.length
    ? snapshot.services
    : [{ name: "Project Dashboard", status: snapshot.upstreamHealth?.status || "unknown", detail: snapshot.upstreamHealth?.ok ? "Tilkoblet" : "Ukjent" }];

  updateHeader("Project Dashboard", {
    label: snapshot.source?.label || "Sanitert live-data",
    tone: sourceTone,
  });

  rootElement.innerHTML =
    '<section class="dashboard-grid">' +
      '<article class="cc-card capacity-card">' +
        '<div class="card-heading"><div><p class="eyebrow">KAPASITET</p><h2>Arbeidsflate</h2></div><span class="mini-badge">' + escapeHtml(snapshot.source?.status || "Ukjent") + '</span></div>' +
        '<div class="metric-strip">' +
          '<div><strong>' + escapeHtml(snapshot.stats?.active ?? 0) + '</strong><span>aktive</span></div>' +
          '<div><strong>' + escapeHtml(snapshot.stats?.onHold ?? 0) + '</strong><span>på vent</span></div>' +
          '<div><strong>' + formatPercent(snapshot.stats?.averageProgress) + '</strong><span>snitt</span></div>' +
        '</div>' +
        '<div class="usage-line"><span>Codex</span><b>' + formatPercent(snapshot.codexUsage?.usedPercent) + '</b></div>' +
      '</article>' +

      '<article class="cc-card focus-card">' +
        '<div class="card-heading"><div><p class="eyebrow">DAGENS RETNING</p><h2>' + escapeHtml(focus?.name || "Ingen aktiv retning") + '</h2></div><span class="mini-badge warm">' + escapeHtml(focus?.priority || "Fokus") + '</span></div>' +
        '<p class="focus-next">' + escapeHtml(focus?.nextStep || "Velg neste tydelige leveranse i Project Dashboard.") + '</p>' +
        '<div class="focus-meta"><span>' + escapeHtml(focus?.area || "Command Center") + '</span><strong>' + formatPercent(focus?.progress) + '</strong></div>' +
      '</article>' +

      '<article class="cc-card attention-card">' +
        '<div class="card-heading"><div><p class="eyebrow">LIVE SIGNALER</p><h2>Systemstatus</h2></div><span class="pulse-ring ' + (snapshot.upstreamHealth?.ok ? "ok" : "error") + '"></span></div>' +
        '<ul class="service-list compact">' + services.slice(0, 3).map(serviceMarkup).join("") + '</ul>' +
      '</article>' +

      '<article class="cc-card projects-card">' +
        '<div class="card-heading"><div><p class="eyebrow">PROSJEKTER</p><h2>Aktivt arbeid</h2></div><span class="mini-badge">' + projects.length + ' totalt</span></div>' +
        '<ul class="project-list">' + (projects.slice(0, 4).map(projectMarkup).join("") || '<li class="empty-row">Ingen prosjekter i det saniterte snapshotet.</li>') + '</ul>' +
      '</article>' +

      '<article class="cc-card services-card">' +
        '<div class="card-heading"><div><p class="eyebrow">TJENESTER</p><h2>Drift</h2></div><button id="dashboard-refresh" class="icon-action" type="button" aria-label="Oppdater">↻</button></div>' +
        '<ul class="service-list">' + services.slice(0, 5).map(serviceMarkup).join("") + '</ul>' +
        '<button id="dashboard-logout" class="quiet-action" type="button">Logg ut av Dashboard</button>' +
      '</article>' +
    '</section>';

  rootElement.querySelector("#dashboard-refresh").addEventListener("click", loadDashboard);
  rootElement.querySelector("#dashboard-logout").addEventListener("click", async () => {
    try {
      await requestJson("/api/dashboard/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } finally {
      renderLogin();
    }
  });
};

async function loadDashboard() {
  try {
    const snapshot = await requestJson("/api/dashboard/data");
    renderDashboard(snapshot);
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(loadDashboard, POLL_INTERVAL_MS);
  } catch (error) {
    if (error.status === 401) renderLogin();
    else renderOffline(error.message);
  }
}

async function bootstrap() {
  updateHeader("Project Dashboard", { label: "Kobler til", tone: "neutral" });
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
    updateHeader = setHeader;
    bootstrap();
  },
  unmount() {
    window.clearTimeout(pollTimer);
    activeController?.abort();
    rootElement = undefined;
    updateHeader = undefined;
  },
};