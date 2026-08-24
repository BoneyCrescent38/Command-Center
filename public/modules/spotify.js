const FALLBACK_POLL_MS = 5000;
const POSITION_TICK_MS = 250;
const COMMAND_RESYNC_MS = 350;
const VOLUME_DEBOUNCE_MS = 140;

let rootElement;
let updateHeader;
let deviceId = "";
let playbackPollTimer;
let positionTimer;
let currentState;
let lastPlaybackSignature = "";
let volumeDebounceTimer;
let volumeInteractionUntil = 0;
let seekInteractionUntil = 0;
let mutationPending = 0;
let bridgeSource;
let bridgeAvailable = false;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
})[character]);

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
    cache: "no-store",
  });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
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

const renderShell = () => {
  rootElement.innerHTML = '<section class="spotify-poc">' +
    '<article class="spotify-poc-card spotify-connection"><p class="eyebrow">SPOTIFY CONNECT · A2</p><h2>Playback-motor</h2><span id="spotify-poc-status" class="spotify-poc-state">Synkroniserer</span><dl><div><dt>A2 Edge</dt><dd id="spotify-device">Aventer Edge-player</dd></div><div><dt>Aktiv device</dt><dd id="spotify-active-device">Kontrollerer</dd></div></dl><button id="spotify-transfer" type="button" hidden>Spill på Command Center</button><button id="spotify-devices" type="button">Vis Connect-devices</button></article>' +
    '<article class="spotify-poc-card spotify-player"><div class="spotify-track"><img id="spotify-art" alt="Albumcover" hidden><div><p class="eyebrow">FAKTISK PLAYBACK</p><h2 id="spotify-track">Ingen aktiv avspilling</h2><p id="spotify-artist">Venter på Spotify Web API</p></div></div><div class="spotify-controls"><button data-player="previous" aria-label="Forrige" disabled>|‹</button><button id="spotify-play" data-player="toggle" disabled>Play</button><button data-player="next" aria-label="Neste" disabled>›|</button></div><label class="spotify-range"><span id="spotify-position">0:00 / 0:00</span><input id="spotify-seek" type="range" min="0" max="0" value="0" step="1000" disabled></label><label class="spotify-range"><span>Volum</span><input id="spotify-volume" type="range" min="0" max="100" value="50" disabled></label></article>' +
    '<article class="spotify-poc-card spotify-diagnostics"><div><p class="eyebrow">STATE SOURCE</p><h2>Spotify Web API</h2></div><ul id="spotify-events"></ul></article>' +
  '</section>';
};

const renderConnect = (status) => {
  updateHeader("Spotify POC", { label: status.configured ? "OAuth kreves" : "Mangler konfig", tone: "warning" });
  rootElement.innerHTML = '<section class="center-state"><article class="offline-card"><p class="eyebrow">SPOTIFY POC</p><h2>' + escapeHtml(status.configured ? "Koble til Spotify" : "Spotify Client ID mangler") + '</h2><p>Authorization Code med PKCE. Ingen Client Secret eller PIN lagres i browseren.</p>' + (status.configured ? '<button id="spotify-auth" type="button">Autentiser med Spotify</button>' : "") + '</article></section>';
  rootElement.querySelector("#spotify-auth")?.addEventListener("click", () => window.location.assign("/api/spotify/auth/start"));
};

const normalizePlayback = (playback) => {
  if (!playback?.item) return null;
  return {
    trackId: String(playback.item.id || playback.item.uri || ""),
    track: String(playback.item.name || "Ukjent spor"),
    artists: (playback.item.artists || []).map((artist) => String(artist.name || "")).filter(Boolean),
    albumArt: String(playback.item.album?.images?.[0]?.url || ""),
    isPlaying: Boolean(playback.is_playing),
    position: Number(playback.progress_ms) || 0,
    duration: Number(playback.item.duration_ms) || 0,
    device: {
      id: String(playback.device?.id || ""),
      name: String(playback.device?.name || "Ukjent device"),
      volume: Number(playback.device?.volume_percent) || 0,
    },
    syncedAt: Date.now(),
  };
};

const normalizeBridgeState = (state) => {
  if (!state?.track?.id && !state?.track?.name) return null;
  return {
    trackId: String(state.track.id || ""),
    track: String(state.track.name || "Ukjent spor"),
    artists: Array.isArray(state.track.artists) ? state.track.artists.map(String) : [],
    albumArt: String(state.track.albumArt || ""),
    isPlaying: Boolean(state.isPlaying),
    position: Number(state.position) || 0,
    duration: Number(state.duration) || 0,
    device: {
      id: String(state.device?.id || ""),
      name: String(state.device?.name || "Command Center Xeneon"),
      volume: Number(state.volume) || 0,
    },
    syncedAt: Date.now(),
  };
};

const currentPosition = () => {
  if (!currentState) return 0;
  const elapsed = currentState.isPlaying ? Date.now() - currentState.syncedAt : 0;
  return Math.min(currentState.duration, currentState.position + elapsed);
};

const renderPosition = () => {
  if (!rootElement || !currentState) return;
  const position = currentPosition();
  const seek = rootElement.querySelector("#spotify-seek");
  if (Date.now() > seekInteractionUntil) seek.value = String(position);
  rootElement.querySelector("#spotify-position").textContent = formatTime(position) + " / " + formatTime(currentState.duration);
};

const renderPlayback = () => {
  if (!rootElement) return;
  const transfer = rootElement.querySelector("#spotify-transfer");
  const edge = rootElement.querySelector("#spotify-device");
  const activeDevice = rootElement.querySelector("#spotify-active-device");
  const controls = rootElement.querySelectorAll("[data-player], #spotify-seek, #spotify-volume");
  edge.textContent = deviceId ? "Command Center Xeneon · Klar" : "Ikke registrert";
  if (!currentState) {
    activeDevice.textContent = "Ingen aktiv device";
    rootElement.querySelector("#spotify-track").textContent = "Ingen aktiv avspilling";
    rootElement.querySelector("#spotify-artist").textContent = "Venter på Spotify Web API";
    rootElement.querySelector("#spotify-art").hidden = true;
    rootElement.querySelector("#spotify-play").textContent = "Play";
    controls.forEach((element) => { element.disabled = true; });
    transfer.hidden = !deviceId;
    transfer.disabled = !deviceId;
    setPocStatus(deviceId ? "A2 klar · ingen aktiv playback" : "Start Edge-spilleren", deviceId ? "neutral" : "warning");
    return;
  }

  const isEdgeActive = Boolean(deviceId && currentState.device.id === deviceId);
  activeDevice.textContent = currentState.device.name + (isEdgeActive ? " · Aktiv" : " · Aktiv ekstern device");
  rootElement.querySelector("#spotify-track").textContent = currentState.track;
  rootElement.querySelector("#spotify-artist").textContent = currentState.artists.join(", ") || "Ukjent artist";
  const image = rootElement.querySelector("#spotify-art");
  image.hidden = !currentState.albumArt;
  if (currentState.albumArt) image.src = currentState.albumArt;
  const seek = rootElement.querySelector("#spotify-seek");
  seek.max = String(currentState.duration);
  if (Date.now() > volumeInteractionUntil) rootElement.querySelector("#spotify-volume").value = String(currentState.device.volume);
  rootElement.querySelector("#spotify-play").textContent = currentState.isPlaying ? "Pause" : "Play";
  controls.forEach((element) => { element.disabled = !currentState.device.id; });
  transfer.hidden = !deviceId || isEdgeActive;
  transfer.disabled = !deviceId || isEdgeActive;
  setPocStatus(isEdgeActive ? "Command Center Xeneon · Aktiv" : currentState.device.name + " · Aktiv", isEdgeActive ? "success" : "neutral");
  renderPosition();
};

const playbackSignature = (state) => state ? [state.trackId, state.isPlaying, state.device.id].join(":") : "none";

const applyPlaybackState = (nextState, source = "bridge") => {
  const nextSignature = playbackSignature(nextState);
  if (lastPlaybackSignature && nextSignature !== lastPlaybackSignature) {
    report(source === "bridge" ? "realtime_playback_change" : "external_playback_change", source === "bridge" ? "Edge SDK pushet ny playback-state" : "Playback ble endret fra en Spotify-klient", {
      track: nextState?.track || "none",
      playing: nextState?.isPlaying || false,
      device: nextState?.device.name || "none",
    });
  }
  currentState = nextState;
  lastPlaybackSignature = nextSignature;
  renderPlayback();
  return currentState;
};

const syncPlayback = async (reason = "poll") => {
  if (reason === "poll" && mutationPending > 0) return currentState;
  const [status, playback] = await Promise.all([
    requestJson("/api/spotify/status"),
    requestJson("/api/spotify/player/playback"),
  ]);
  deviceId = String(status.deviceId || deviceId || "");
  return applyPlaybackState(normalizePlayback(playback), reason === "poll" ? "fallback" : reason);
};

const delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const sendPlayerCommand = async (command, body = {}, targetDeviceId = currentState?.device.id || deviceId) => {
  mutationPending += 1;
  try {
    if (bridgeAvailable && ["toggle", "previous", "next", "seek", "volume"].includes(command)) {
      const bridgeBody = { command };
      if (command === "seek") bridgeBody.position = Number(body.positionMs) || 0;
      if (command === "volume") bridgeBody.volume = Number(body.volumePercent) || 0;
      await requestJson("/api/spotify/bridge/control", { method: "POST", body: JSON.stringify(bridgeBody) });
      return;
    }
    await requestJson(`/api/spotify/player/${command}`, {
      method: "POST",
      body: JSON.stringify({ ...body, deviceId: targetDeviceId }),
    });
    await delay(COMMAND_RESYNC_MS);
    await syncPlayback(command);
  } finally {
    mutationPending = Math.max(0, mutationPending - 1);
  }
};

const connectRealtimeBridge = () => {
  bridgeSource?.close();
  bridgeSource = new EventSource("/api/spotify/bridge/stream?role=xeneon");
  bridgeSource.addEventListener("bridge", (event) => {
    const bridge = JSON.parse(event.data || "{}");
    bridgeAvailable = Boolean(bridge.available);
    if (bridge.state?.device?.id) deviceId = String(bridge.state.device.id);
    if (bridge.state) applyPlaybackState(normalizeBridgeState(bridge.state), "bridge");
    if (!bridgeAvailable && currentState) setPocStatus("Realtime frakoblet · Web API fallback", "warning");
  });
  bridgeSource.addEventListener("state", (event) => {
    const state = JSON.parse(event.data || "{}");
    bridgeAvailable = Boolean(state.device?.ready);
    if (state.device?.id) deviceId = String(state.device.id);
    applyPlaybackState(normalizeBridgeState(state), "bridge");
  });
  bridgeSource.addEventListener("ack", (event) => {
    const acknowledgement = JSON.parse(event.data || "{}");
    if (!acknowledgement.ok) {
      bridgeAvailable = false;
      report("realtime_control_error", acknowledgement.message || "Edge SDK avviste kontrollen", { command: acknowledgement.command || "unknown" });
      syncPlayback("bridge_ack_fallback").catch(() => {});
    }
  });
  bridgeSource.onerror = () => {
    bridgeAvailable = false;
    setPocStatus("Realtime kobler til på nytt", "warning");
  };
};

const setOptimisticPlaying = (isPlaying) => {
  if (!currentState) return;
  currentState = { ...currentState, isPlaying, position: currentPosition(), syncedAt: Date.now() };
  renderPlayback();
};

const setOptimisticSeek = (position) => {
  if (!currentState) return;
  currentState = { ...currentState, position: Math.min(currentState.duration, Math.max(0, position)), syncedAt: Date.now() };
  renderPosition();
};

const commitVolume = async (volume) => {
  if (!currentState) return;
  currentState.device.volume = volume;
  try {
    await sendPlayerCommand("volume", { volumePercent: volume });
  } catch (error) {
    await syncPlayback("volume_rollback").catch(() => {});
    await report("control_error", error.message, { control: "volume" });
  }
};

const bindControls = () => {
  rootElement.querySelector("#spotify-transfer").addEventListener("click", async () => {
    try {
      await sendPlayerCommand("transfer", { play: true }, deviceId);
      await report("transfer_complete", "Playback er flyttet til Command Center Xeneon", { deviceId });
    } catch (error) { await report("transfer_error", error.message, { code: error.code || "transfer_failed" }); }
  });
  rootElement.querySelector("#spotify-devices").addEventListener("click", async () => {
    try {
      const result = await requestJson("/api/spotify/player/devices");
      await report("connect_devices", (result.devices || []).map((item) => item.name).join(", ") || "Ingen devices", { count: (result.devices || []).length });
    } catch (error) { await report("connect_error", error.message, { code: error.code || "devices_failed" }); }
  });
  rootElement.querySelector("[data-player='toggle']").addEventListener("click", async () => {
    if (!currentState) return;
    const nextPlaying = !currentState.isPlaying;
    setOptimisticPlaying(nextPlaying);
    try {
      await sendPlayerCommand(nextPlaying ? "play" : "pause");
    } catch (error) {
      await syncPlayback("toggle_rollback").catch(() => {});
      await report("control_error", error.message, { control: "toggle" });
    }
  });
  rootElement.querySelector("[data-player='previous']").addEventListener("click", () => sendPlayerCommand("previous").catch((error) => report("control_error", error.message, { control: "previous" })));
  rootElement.querySelector("[data-player='next']").addEventListener("click", () => sendPlayerCommand("next").catch((error) => report("control_error", error.message, { control: "next" })));
  const seek = rootElement.querySelector("#spotify-seek");
  seek.addEventListener("input", (event) => {
    seekInteractionUntil = Date.now() + 1200;
    setOptimisticSeek(Number(event.target.value) || 0);
  });
  seek.addEventListener("change", async (event) => {
    const positionMs = Number(event.target.value) || 0;
    setOptimisticSeek(positionMs);
    try {
      await sendPlayerCommand("seek", { positionMs });
    } catch (error) {
      await syncPlayback("seek_rollback").catch(() => {});
      await report("control_error", error.message, { control: "seek" });
    }
  });
  const volume = rootElement.querySelector("#spotify-volume");
  volume.addEventListener("input", (event) => {
    const volumePercent = Number(event.target.value) || 0;
    volumeInteractionUntil = Date.now() + 1200;
    if (currentState) currentState.device.volume = volumePercent;
    window.clearTimeout(volumeDebounceTimer);
    volumeDebounceTimer = window.setTimeout(() => commitVolume(volumePercent), VOLUME_DEBOUNCE_MS);
  });
  volume.addEventListener("change", (event) => {
    const volumePercent = Number(event.target.value) || 0;
    volumeInteractionUntil = Date.now() + 1200;
    window.clearTimeout(volumeDebounceTimer);
    commitVolume(volumePercent);
  });
};

const bootstrap = async () => {
  updateHeader("Spotify POC", { label: "Kontrollerer auth", tone: "neutral" });
  rootElement.innerHTML = '<div class="loading-state"><span></span><p>Kontrollerer Spotify OAuth…</p></div>';
  try {
    const status = await requestJson("/api/spotify/status");
    if (!status.authenticated) return renderConnect(status);
    renderShell();
    bindControls();
    connectRealtimeBridge();
    const bridge = await requestJson("/api/spotify/bridge/status");
    bridgeAvailable = Boolean(bridge.available);
    if (bridge.state?.device?.id) deviceId = String(bridge.state.device.id);
    if (bridge.state) applyPlaybackState(normalizeBridgeState(bridge.state), "bridge");
    else await syncPlayback("bootstrap_fallback");
    playbackPollTimer = window.setInterval(() => {
      if (!bridgeAvailable) syncPlayback("poll").catch((error) => setPocStatus(error.message, "error"));
    }, FALLBACK_POLL_MS);
    positionTimer = window.setInterval(renderPosition, POSITION_TICK_MS);
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
    window.clearInterval(playbackPollTimer);
    window.clearInterval(positionTimer);
    window.clearTimeout(volumeDebounceTimer);
    bridgeSource?.close();
    bridgeSource = undefined;
    bridgeAvailable = false;
    deviceId = "";
    currentState = undefined;
    lastPlaybackSignature = "";
    volumeInteractionUntil = 0;
    seekInteractionUntil = 0;
    mutationPending = 0;
    rootElement = undefined;
    updateHeader = undefined;
  },
};
