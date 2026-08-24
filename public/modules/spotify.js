const SDK_URL = "https://sdk.scdn.co/spotify-player.js";
const SDK_LOAD_TIMEOUT_MS = 15000;

let rootElement;
let updateHeader;
let player;
let deviceId = "";
let diagnosticsTimer;
let currentState;
let mediaErrorHandler;
let rejectionHandler;
let securityPolicyHandler;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
})[character]);

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || "Spotify-forespørselen feilet"), { status: response.status, code: body.code });
  return body;
};

const report = async (type, message = "", details = {}) => {
  try {
    await requestJson("/api/spotify/poc/events", { method: "POST", body: JSON.stringify({ type, message, details }) });
  } catch {}
  const list = rootElement?.querySelector("#spotify-events");
  if (list) {
    const item = document.createElement("li");
    item.innerHTML = '<strong>' + escapeHtml(type) + '</strong><span>' + escapeHtml(message || "Registrert") + '</span>';
    list.prepend(item);
    while (list.children.length > 12) list.lastElementChild.remove();
  }
};

const setPocStatus = (label, tone = "neutral") => {
  updateHeader?.("Spotify POC", { label, tone });
  const status = rootElement?.querySelector("#spotify-poc-status");
  if (status) {
    status.textContent = label;
    status.dataset.tone = tone;
  }
};

const formatTime = (milliseconds) => {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
};

const updatePlayback = (state) => {
  currentState = state;
  if (!rootElement || !state) return;
  const track = state.track_window?.current_track;
  rootElement.querySelector("#spotify-track").textContent = track?.name || "Ingen aktiv avspilling";
  rootElement.querySelector("#spotify-artist").textContent = (track?.artists || []).map((artist) => artist.name).join(", ") || "Venter på ekte Spotify-state";
  const image = rootElement.querySelector("#spotify-art");
  const source = track?.album?.images?.[0]?.url || "";
  image.hidden = !source;
  if (source) image.src = source;
  const duration = Number(state.duration) || 0;
  const position = Number(state.position) || 0;
  const seek = rootElement.querySelector("#spotify-seek");
  seek.max = String(duration);
  seek.value = String(Math.min(duration, position));
  rootElement.querySelector("#spotify-position").textContent = formatTime(position) + " / " + formatTime(duration);
  rootElement.querySelector("#spotify-play").textContent = state.paused ? "Spill" : "Pause";
};

const renderShell = () => {
  rootElement.innerHTML = '<section class="spotify-poc">' +
    '<article class="spotify-poc-card spotify-connection"><p class="eyebrow">ARKITEKTURTEST</p><h2>Web Playback SDK</h2><span id="spotify-poc-status" class="spotify-poc-state">Initialiserer</span><dl><div><dt>WebView2</dt><dd id="spotify-eme">Kontrollerer EME</dd></div><div><dt>Device ID</dt><dd id="spotify-device">Ikke klar</dd></div></dl><button id="spotify-transfer" type="button" disabled>Aktiver Plan A</button><button id="spotify-devices" type="button">Test Connect-devices</button></article>' +
    '<article class="spotify-poc-card spotify-player"><div class="spotify-track"><img id="spotify-art" alt="Albumcover" hidden><div><p class="eyebrow">FAKTISK PLAYBACK</p><h2 id="spotify-track">Ingen aktiv avspilling</h2><p id="spotify-artist">Venter på ekte Spotify-state</p></div></div><div class="spotify-controls"><button data-player="previous" aria-label="Forrige">|‹</button><button id="spotify-play" data-player="toggle">Spill</button><button data-player="next" aria-label="Neste">›|</button></div><label class="spotify-range"><span id="spotify-position">0:00 / 0:00</span><input id="spotify-seek" type="range" min="0" max="0" value="0" step="1000"></label><label class="spotify-range"><span>Volum</span><input id="spotify-volume" type="range" min="0" max="100" value="50"></label></article>' +
    '<article class="spotify-poc-card spotify-diagnostics"><div><p class="eyebrow">WEBVIEW2 / DRM</p><h2>Diagnostikk</h2></div><ul id="spotify-events"></ul></article>' +
  '</section>';
};

const renderConnect = (status) => {
  updateHeader("Spotify POC", { label: status.configured ? "OAuth kreves" : "Mangler konfig", tone: "warning" });
  rootElement.innerHTML = '<section class="center-state"><article class="offline-card"><p class="eyebrow">SPOTIFY POC</p><h2>' + escapeHtml(status.configured ? "Koble til Spotify" : "Spotify Client ID mangler") + '</h2><p>Authorization Code med PKCE. Ingen Client Secret eller PIN lagres i browseren.</p>' + (status.configured ? '<button id="spotify-auth" type="button">Autentiser med Spotify</button>' : "") + '</article></section>';
  rootElement.querySelector("#spotify-auth")?.addEventListener("click", () => window.location.assign("/api/spotify/auth/start"));
};

const loadSdk = () => {
  if (window.Spotify?.Player) return Promise.resolve(window.Spotify);
  if (window.__commandCenterSpotifySdk) return window.__commandCenterSpotifySdk;
  const loading = new Promise((resolve, reject) => {
    let scriptLoaded = false;
    let callbackFired = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (error) reject(error);
      else resolve(window.Spotify);
    };
    const timeout = window.setTimeout(() => {
      const state = { scriptLoaded, callbackFired, playerPresent: Boolean(window.Spotify?.Player) };
      report("sdk_loader_timeout", "Spotify SDK ble ikke klar innen 15 sekunder", state);
      finish(Object.assign(new Error("Spotify SDK stoppet under lasting"), { code: "spotify_sdk_timeout" }));
    }, SDK_LOAD_TIMEOUT_MS);
    window.onSpotifyWebPlaybackSDKReady = () => {
      callbackFired = true;
      const playerPresent = Boolean(window.Spotify?.Player);
      report("sdk_ready_callback", "window.onSpotifyWebPlaybackSDKReady ble kalt", { playerPresent });
      finish(playerPresent ? null : Object.assign(new Error("Spotify SDK callback mangler Player"), { code: "spotify_player_missing" }));
    };
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.addEventListener("load", () => {
      scriptLoaded = true;
      const playerPresent = Boolean(window.Spotify?.Player);
      report("sdk_script_loaded", "Spotify SDK-script lastet og kjørt", { playerPresent });
      if (playerPresent) finish();
    }, { once: true });
    script.addEventListener("error", () => {
      report("sdk_script_error", "Nettleseren kunne ikke laste Spotify SDK-scriptet", { url: SDK_URL });
      finish(Object.assign(new Error("Spotify SDK-script kunne ikke lastes"), { code: "spotify_sdk_script_error" }));
    }, { once: true });
    document.head.append(script);
  });
  window.__commandCenterSpotifySdk = loading.catch((error) => {
    window.__commandCenterSpotifySdk = undefined;
    throw error;
  });
  return window.__commandCenterSpotifySdk;
};

const testEme = async () => {
  const supported = typeof navigator.requestMediaKeySystemAccess === "function";
  rootElement.querySelector("#spotify-eme").textContent = supported ? "EME API tilgjengelig" : "EME API mangler";
  await report("environment", supported ? "EME API tilgjengelig" : "EME API mangler", { emeApi: supported, userAgent: navigator.userAgent.slice(0, 280) });
  if (!supported) return;
  try {
    await navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{
      initDataTypes: ["cenc"],
      audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
    }]);
    rootElement.querySelector("#spotify-eme").textContent = "Widevine tilgjengelig";
    await report("eme_supported", "Widevine media key system tilgjengelig");
  } catch (error) {
    rootElement.querySelector("#spotify-eme").textContent = "Widevine avvist";
    await report("eme_error", error.message, { name: error.name });
  }
};

const enableControls = () => rootElement?.querySelectorAll("[data-player], #spotify-transfer, #spotify-seek, #spotify-volume").forEach((element) => { element.disabled = false; });

const installRuntimeDiagnostics = () => {
  mediaErrorHandler = (event) => {
    if (event.target instanceof HTMLMediaElement) {
      report("media_error", event.target.error?.message || "HTML media error", { code: event.target.error?.code || 0 });
    }
  };
  rejectionHandler = (event) => report("unhandled_rejection", event.reason?.message || String(event.reason || "Ukjent promise-feil"));
  securityPolicyHandler = (event) => report("csp_violation", "CSP blokkerte en Spotify-ressurs", {
    blockedUri: event.blockedURI || "unknown",
    directive: event.effectiveDirective || event.violatedDirective || "unknown",
    disposition: event.disposition || "enforce",
  });
  document.addEventListener("error", mediaErrorHandler, true);
  window.addEventListener("unhandledrejection", rejectionHandler);
  document.addEventListener("securitypolicyviolation", securityPolicyHandler);
};

const initializePlayer = async () => {
  renderShell();
  setPocStatus("Laster SDK", "neutral");
  installRuntimeDiagnostics();
  await testEme();
  const Spotify = await loadSdk();
  if (!Spotify?.Player) throw Object.assign(new Error("window.Spotify.Player mangler"), { code: "spotify_player_missing" });
  await report("sdk_player_available", "window.Spotify.Player er tilgjengelig");
  player = new Spotify.Player({
    name: "Command Center Xeneon",
    volume: 0.5,
    getOAuthToken: async (callback) => {
      try {
        const token = await requestJson("/api/spotify/token");
        await report("sdk_token_ready", "Gyldig access token levert til SDK", { expiresAt: token.expiresAt || 0 });
        callback(token.accessToken);
      } catch (error) {
        await report("authentication_error", error.message, { code: error.code || "token_failed" });
      }
    },
  });
  await report("sdk_player_created", "Spotify.Player ble opprettet");

  for (const type of ["initialization_error", "authentication_error", "account_error", "playback_error"]) {
    player.addListener(type, ({ message }) => {
      setPocStatus(type, "error");
      report(type, message);
    });
  }
  player.addListener("autoplay_failed", () => report("autoplay_failed", "WebView2 blokkerte autoplay"));
  player.addListener("not_ready", ({ device_id }) => {
    setPocStatus("Device frakoblet", "warning");
    report("not_ready", "Spotify-device er ikke klar", { deviceId: device_id });
  });
  player.addListener("ready", ({ device_id }) => {
    deviceId = device_id;
    rootElement.querySelector("#spotify-device").textContent = device_id;
    setPocStatus("Ready · device registrert", "ok");
    enableControls();
    report("ready", "Spotify Web Playback SDK er klar", { deviceId: device_id });
  });
  player.addListener("player_state_changed", (state) => {
    if (!state) return report("player_state_empty", "Spotify returnerte tom playback-state");
    updatePlayback(state);
    report("player_state_changed", state.paused ? "Pause" : "Spiller", { position: state.position, duration: state.duration, track: state.track_window?.current_track?.name || "" });
  });

  rootElement.querySelector("#spotify-transfer").addEventListener("click", async () => {
    try {
      await player.activateElement();
      await requestJson("/api/spotify/player/transfer", { method: "POST", body: JSON.stringify({ deviceId, play: true }) });
      await report("transfer_requested", "Playback overføres til Command Center", { deviceId });
    } catch (error) { await report("transfer_error", error.message, { code: error.code || "transfer_failed" }); }
  });
  rootElement.querySelector("#spotify-devices").addEventListener("click", async () => {
    try {
      const result = await requestJson("/api/spotify/player/devices");
      await report("connect_devices", (result.devices || []).map((item) => item.name).join(", ") || "Ingen devices", { count: (result.devices || []).length });
    } catch (error) { await report("connect_error", error.message, { code: error.code || "devices_failed" }); }
  });
  rootElement.querySelector("[data-player='toggle']").addEventListener("click", () => player.togglePlay());
  rootElement.querySelector("[data-player='previous']").addEventListener("click", () => player.previousTrack());
  rootElement.querySelector("[data-player='next']").addEventListener("click", () => player.nextTrack());
  rootElement.querySelector("#spotify-seek").addEventListener("change", (event) => player.seek(Number(event.target.value) || 0));
  rootElement.querySelector("#spotify-volume").addEventListener("input", (event) => player.setVolume((Number(event.target.value) || 0) / 100));

  setPocStatus("Kobler til Spotify", "neutral");
  const connected = await Promise.race([
    player.connect(),
    new Promise((_, reject) => window.setTimeout(() => reject(Object.assign(new Error("player.connect() svarte ikke innen 15 sekunder"), { code: "spotify_connect_timeout" })), SDK_LOAD_TIMEOUT_MS)),
  ]);
  await report(connected ? "sdk_connected" : "sdk_connect_failed", connected ? "SDK connect returnerte true" : "SDK connect returnerte false");
  setPocStatus(connected ? "Venter på device ID" : "SDK kunne ikke koble til", connected ? "neutral" : "error");
};

const bootstrap = async () => {
  updateHeader("Spotify POC", { label: "Kontrollerer auth", tone: "neutral" });
  rootElement.innerHTML = '<div class="loading-state"><span></span><p>Kontrollerer Spotify OAuth…</p></div>';
  try {
    const status = await requestJson("/api/spotify/status");
    if (!status.authenticated) return renderConnect(status);
    await initializePlayer();
    diagnosticsTimer = window.setInterval(async () => {
      try {
        const next = await requestJson("/api/spotify/status");
        const list = rootElement?.querySelector("#spotify-events");
        if (list && !list.children.length) for (const event of [...next.events].reverse()) report(event.type, event.message, event.details);
      } catch {}
    }, 5000);
  } catch (error) {
    if (!rootElement?.querySelector("#spotify-poc-status")) renderShell();
    setPocStatus(error.message, "error");
    await report("bootstrap_error", error.message, { code: error.code || "spotify_bootstrap_failed" });
  }
};

export const SpotifyModule = {
  id: "spotify",
  mount({ root, setHeader }) {
    rootElement = root;
    updateHeader = setHeader;
    bootstrap();
  },
  unmount() {
    window.clearInterval(diagnosticsTimer);
    document.removeEventListener("error", mediaErrorHandler, true);
    window.removeEventListener("unhandledrejection", rejectionHandler);
    document.removeEventListener("securitypolicyviolation", securityPolicyHandler);
    player?.disconnect();
    player = undefined;
    deviceId = "";
    currentState = undefined;
    rootElement = undefined;
    updateHeader = undefined;
  },
};
