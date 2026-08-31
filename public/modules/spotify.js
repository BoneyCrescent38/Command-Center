const FALLBACK_POLL_MS = 5000;
const POSITION_TICK_MS = 250;
const COMMAND_RESYNC_MS = 350;
const VOLUME_DEBOUNCE_MS = 140;
const QUEUE_REFRESH_MS = 30000;

let rootElement;
let updateHeader;
let deviceId = "";
let playbackPollTimer;
let positionTimer;
let queueTimer;
let currentState;
let queueItems = [];
let audioOutput;
let lastPlaybackSignature = "";
let volumeDebounceTimer;
let volumeDragging = false;
let volumeDraft;
let seekInteractionUntil = 0;
let mutationPending = 0;
let bridgeSource;
let audioOutputSource;
let bridgeAvailable = false;
let engineReady = false;
let activationRequired = false;

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
};

const userMessage = (error) => {
  if (error?.status === 401 || ["spotify_auth_required", "spotify_reauth_required"].includes(error?.code)) return "Spotify-tilgangen må fornyes";
  if (error?.code === "audio_output_not_configured") return "Lydutganger er ikke konfigurert";
  if (error?.code === "audio_output_unavailable") return "Windows-lydutgangen er ikke tilgjengelig";
  return "Spotify er midlertidig utilgjengelig";
};

const setStatus = (label, tone = "neutral") => {
  updateHeader?.("Spotify", { label, tone });
  const status = rootElement?.querySelector("#spotify-status");
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
  rootElement.innerHTML = `<section class="spotify-v1">
    <article class="spotify-cover-card">
      <div class="spotify-cover-wrap">
        <img id="spotify-art" alt="Albumcover" hidden>
        <div id="spotify-art-placeholder" class="spotify-cover-placeholder"><span>SP</span><strong>Spotify</strong></div>
      </div>
    </article>
    <article class="spotify-control-card">
      <div class="spotify-now-heading">
        <p class="eyebrow">SPILLER NÅ</p>
        <span id="spotify-status" class="spotify-v1-state">Synkroniserer</span>
      </div>
      <div class="spotify-track-copy">
        <h2 id="spotify-track">Ingen aktiv avspilling</h2>
        <p id="spotify-artist">Velg musikk fra Spotify</p>
        <p id="spotify-album"></p>
      </div>
      <div class="spotify-device-row">
        <span id="spotify-active-device">Spotify Engine starter</span>
        <button id="spotify-transfer" type="button" hidden>Spill på Command Center</button>
      </div>
      <div class="spotify-v1-controls">
        <button data-player="previous" aria-label="Forrige spor" disabled>Forrige</button>
        <button id="spotify-play" class="spotify-primary-control" data-player="toggle" disabled>Play</button>
        <button data-player="next" aria-label="Neste spor" disabled>Neste</button>
      </div>
      <label class="spotify-timeline">
        <input id="spotify-seek" type="range" min="0" max="0" value="0" step="1000" disabled>
        <span><b id="spotify-elapsed">0:00</b><b id="spotify-duration">0:00</b></span>
      </label>
      <label class="spotify-volume">
        <span>Spotify-volum <b id="spotify-volume-value">50%</b></span>
        <input id="spotify-volume" type="range" min="0" max="100" value="50" disabled>
      </label>
    </article>
    <aside class="spotify-side-column">
      <article class="spotify-queue-card">
        <div class="spotify-panel-heading"><p class="eyebrow">NESTE</p><span id="spotify-queue-count"></span></div>
        <ol id="spotify-queue"><li class="spotify-empty-row">Ingen queue tilgjengelig</li></ol>
      </article>
      <article class="spotify-output-card">
        <div><p class="eyebrow">WINDOWS LYD</p><h3 id="spotify-output-name">Kontrollerer lydutgang</h3><p id="spotify-output-detail">Ctrl + Alt + F10</p></div>
        <button id="spotify-output-toggle" type="button" disabled>Bytt lydutgang</button>
      </article>
    </aside>
  </section>`;
};

const renderConnect = (status) => {
  updateHeader("Spotify", { label: status.configured ? "Koble til" : "Mangler konfig", tone: "warning" });
  rootElement.innerHTML = '<section class="center-state"><article class="offline-card"><p class="eyebrow">SPOTIFY</p><h2>' +
    escapeHtml(status.configured ? "Koble til Spotify" : "Spotify Client ID mangler") +
    '</h2><p>Sikker lokal Spotify-tilkobling med PKCE. Ingen Client Secret lagres.</p>' +
    (status.configured ? '<button id="spotify-auth" type="button">Koble til Spotify</button>' : "") +
    '</article></section>';
  rootElement.querySelector("#spotify-auth")?.addEventListener("click", () => window.location.assign("/api/spotify/auth/start"));
};

const normalizePlayback = (playback) => {
  if (!playback?.item) return null;
  return {
    trackId: String(playback.item.id || playback.item.uri || ""),
    track: String(playback.item.name || "Ukjent spor"),
    artists: (playback.item.artists || []).map((artist) => String(artist.name || "")).filter(Boolean),
    album: String(playback.item.album?.name || ""),
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
    album: String(state.track.album || ""),
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
  rootElement.querySelector("#spotify-elapsed").textContent = formatTime(position);
  rootElement.querySelector("#spotify-duration").textContent = formatTime(currentState.duration);
};

const renderQueue = () => {
  const list = rootElement?.querySelector("#spotify-queue");
  if (!list) return;
  rootElement.querySelector("#spotify-queue-count").textContent = queueItems.length ? String(queueItems.length) + " spor" : "";
  if (!queueItems.length) {
    list.innerHTML = '<li class="spotify-empty-row">Ingen queue tilgjengelig</li>';
    return;
  }
  list.innerHTML = queueItems.slice(0, 4).map((item) => `<li>
    ${item.albumArt ? `<img src="${escapeHtml(item.albumArt)}" alt="">` : '<span class="spotify-queue-art"></span>'}
    <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.artists.join(", ") || "Ukjent artist")}</small></span>
  </li>`).join("");
};

const renderAudioOutput = () => {
  const name = rootElement?.querySelector("#spotify-output-name");
  const detail = rootElement?.querySelector("#spotify-output-detail");
  const button = rootElement?.querySelector("#spotify-output-toggle");
  if (!name || !detail || !button) return;
  if (!audioOutput?.configured) {
    name.textContent = "Lydutgang ikke konfigurert";
    detail.textContent = "Åpne Command Center Control";
    button.disabled = true;
    return;
  }
  const isHeadset = audioOutput.active === "headset";
  const isSpeakers = audioOutput.active === "speakers";
  name.textContent = isHeadset ? "🎧 Headset" : (isSpeakers ? "🔊 Speakers" : audioOutput.defaultName || "Annen lydutgang");
  const waitingText = !audioOutput.speakersAvailable && !audioOutput.headsetAvailable
    ? "Speakers og Headset starter…"
    : (!audioOutput.speakersAvailable ? "Speakers starter…" : (!audioOutput.headsetAvailable ? "Headset starter…" : ""));
  detail.textContent = waitingText || audioOutput.defaultName || "Ctrl + Alt + F10";
  button.textContent = isHeadset ? "Bytt til Speakers" : "Bytt til Headset";
  button.disabled = !audioOutput.speakersAvailable || !audioOutput.headsetAvailable;
};

const renderPlayback = () => {
  if (!rootElement) return;
  const transfer = rootElement.querySelector("#spotify-transfer");
  const controls = rootElement.querySelectorAll("[data-player], #spotify-seek, #spotify-volume");
  if (!currentState) {
    rootElement.querySelector("#spotify-track").textContent = "Ingen aktiv avspilling";
    rootElement.querySelector("#spotify-artist").textContent = engineReady ? "Velg musikk fra Spotify" : "Spotify Engine starter";
    rootElement.querySelector("#spotify-album").textContent = "";
    rootElement.querySelector("#spotify-active-device").textContent = activationRequired ? "Trenger lydaktivering" : (engineReady ? "Command Center Xeneon · Klar" : "Bridge utilgjengelig");
    rootElement.querySelector("#spotify-art").hidden = true;
    rootElement.querySelector("#spotify-art-placeholder").hidden = false;
    rootElement.querySelector("#spotify-play").textContent = "Play";
    controls.forEach((element) => { element.disabled = true; });
    transfer.hidden = !deviceId;
    transfer.disabled = !deviceId;
    setStatus(activationRequired ? "Aktiver Spotify-lyd" : (engineReady ? "Klar · ingen playback" : "Spotify Engine starter"), activationRequired ? "warning" : "neutral");
    return;
  }

  const isEdgeActive = Boolean(deviceId && currentState.device.id === deviceId);
  rootElement.querySelector("#spotify-active-device").textContent = currentState.device.name + (isEdgeActive ? " · Aktiv" : " · Aktiv device");
  rootElement.querySelector("#spotify-track").textContent = currentState.track;
  rootElement.querySelector("#spotify-artist").textContent = currentState.artists.join(", ") || "Ukjent artist";
  rootElement.querySelector("#spotify-album").textContent = currentState.album;
  const image = rootElement.querySelector("#spotify-art");
  const placeholder = rootElement.querySelector("#spotify-art-placeholder");
  image.hidden = !currentState.albumArt;
  placeholder.hidden = Boolean(currentState.albumArt);
  if (currentState.albumArt && image.src !== currentState.albumArt) image.src = currentState.albumArt;
  const seek = rootElement.querySelector("#spotify-seek");
  seek.max = String(currentState.duration);
  const volumeControl = rootElement.querySelector("#spotify-volume");
  const confirmedVolume = Math.min(100, Math.max(0, Math.round(Number(currentState.device.volume) || 0)));
  const displayedVolume = volumeDragging && Number.isFinite(volumeDraft) ? volumeDraft : confirmedVolume;
  volumeControl.value = String(displayedVolume);
  rootElement.querySelector("#spotify-volume-value").textContent = String(displayedVolume) + "%";
  rootElement.querySelector("#spotify-play").textContent = currentState.isPlaying ? "Pause" : "Play";
  controls.forEach((element) => { element.disabled = !currentState.device.id; });
  transfer.hidden = !deviceId || isEdgeActive;
  transfer.disabled = !deviceId || isEdgeActive;
  setStatus(isEdgeActive ? "Command Center Xeneon · Aktiv" : currentState.device.name + " · Aktiv", isEdgeActive ? "success" : "neutral");
  renderPosition();
};

const playbackSignature = (state) => state ? [state.trackId, state.isPlaying, state.device.id].join(":") : "none";

const applyPlaybackState = (nextState, source = "bridge") => {
  const previousTrackId = currentState?.trackId || "";
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
  if (nextState?.trackId && nextState.trackId !== previousTrackId) refreshQueue().catch(() => {});
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

const refreshQueue = async () => {
  const payload = await requestJson("/api/spotify/player/queue");
  queueItems = Array.isArray(payload.queue) ? payload.queue.map((item) => ({
    id: String(item.id || ""),
    name: String(item.name || "Ukjent spor"),
    artists: Array.isArray(item.artists) ? item.artists.map(String) : [],
    albumArt: String(item.albumArt || ""),
  })) : [];
  renderQueue();
};

const refreshAudioOutput = async () => {
  audioOutput = await requestJson("/api/audio-output");
  renderAudioOutput();
};

const connectAudioOutput = () => {
  audioOutputSource?.close();
  audioOutputSource = new EventSource("/api/audio-output/stream");
  audioOutputSource.addEventListener("audio-output", (event) => {
    try {
      audioOutput = JSON.parse(event.data || "{}");
      renderAudioOutput();
    } catch {}
  });
  audioOutputSource.onerror = () => {
    refreshAudioOutput().catch(() => {});
  };
};

const delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const sendPlayerCommand = async (command, body = {}, targetDeviceId = currentState?.device.id || deviceId) => {
  mutationPending += 1;
  try {
    const localCommand = ["toggle", "previous", "next", "seek", "volume"].includes(command);
    const edgeIsActive = Boolean(deviceId && currentState?.device.id === deviceId);
    if (bridgeAvailable && edgeIsActive && localCommand) {
      const bridgeBody = { command };
      if (command === "seek") bridgeBody.position = Number(body.positionMs) || 0;
      if (command === "volume") bridgeBody.volume = Number(body.volumePercent) || 0;
      await requestJson("/api/spotify/bridge/control", { method: "POST", body: JSON.stringify(bridgeBody) });
      return;
    }
    const apiCommand = command === "toggle" ? (body.isPlaying ? "play" : "pause") : command;
    await requestJson(`/api/spotify/player/${apiCommand}`, {
      method: "POST",
      body: JSON.stringify({ ...body, deviceId: targetDeviceId }),
    });
    await delay(COMMAND_RESYNC_MS);
    await syncPlayback(command);
  } finally {
    mutationPending = Math.max(0, mutationPending - 1);
  }
};

const applyBridgeSnapshot = (snapshot) => {
  bridgeAvailable = Boolean(snapshot?.available);
  engineReady = Boolean(snapshot?.state?.device?.ready);
  activationRequired = Boolean(snapshot?.state?.activationRequired);
  if (snapshot?.state?.device?.id) deviceId = String(snapshot.state.device.id);
  const next = normalizeBridgeState(snapshot?.state);
  if (next) applyPlaybackState(next, "bridge");
  else {
    if (!currentState || currentState.device.id === deviceId) applyPlaybackState(null, "bridge");
    syncPlayback("external_discovery").catch(() => renderPlayback());
  }
};

const connectRealtimeBridge = () => {
  bridgeSource?.close();
  bridgeSource = new EventSource("/api/spotify/bridge/stream?role=xeneon");
  bridgeSource.addEventListener("bridge", (event) => applyBridgeSnapshot(JSON.parse(event.data || "{}")));
  bridgeSource.addEventListener("state", (event) => applyBridgeSnapshot({ available: true, state: JSON.parse(event.data || "{}") }));
  bridgeSource.addEventListener("ack", (event) => {
    const acknowledgement = JSON.parse(event.data || "{}");
    if (!acknowledgement.ok) {
      bridgeAvailable = false;
      syncPlayback("bridge_ack_fallback").catch(() => setStatus("Kontrollen kunne ikke bekreftes", "warning"));
    }
  });
  bridgeSource.onerror = () => {
    bridgeAvailable = false;
    setStatus("Kobler til Spotify Engine", "warning");
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
  try {
    await sendPlayerCommand("volume", { volumePercent: volume });
  } catch (error) {
    await syncPlayback("volume_rollback").catch(() => {});
    setStatus(userMessage(error), "warning");
  }
};

const bindControls = () => {
  rootElement.querySelector("#spotify-transfer").addEventListener("click", async () => {
    try {
      await sendPlayerCommand("transfer", { play: true }, deviceId);
      await delay(COMMAND_RESYNC_MS);
      await syncPlayback("transfer");
    } catch (error) { setStatus(userMessage(error), "warning"); }
  });
  rootElement.querySelector("[data-player='toggle']").addEventListener("click", async () => {
    if (!currentState) return;
    const nextPlaying = !currentState.isPlaying;
    setOptimisticPlaying(nextPlaying);
    try {
      await sendPlayerCommand("toggle", { isPlaying: nextPlaying });
    } catch (error) {
      await syncPlayback("toggle_rollback").catch(() => {});
      setStatus(userMessage(error), "warning");
    }
  });
  rootElement.querySelector("[data-player='previous']").addEventListener("click", () => sendPlayerCommand("previous").then(() => delay(500)).then(refreshQueue).catch((error) => setStatus(userMessage(error), "warning")));
  rootElement.querySelector("[data-player='next']").addEventListener("click", () => sendPlayerCommand("next").then(() => delay(500)).then(refreshQueue).catch((error) => setStatus(userMessage(error), "warning")));
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
      setStatus(userMessage(error), "warning");
    }
  });
  const volume = rootElement.querySelector("#spotify-volume");
  const beginVolumeInteraction = (event) => {
    volumeDragging = true;
    volumeDraft = Number(volume.value) || 0;
    if (event?.pointerId !== undefined) volume.setPointerCapture?.(event.pointerId);
  };
  const updateVolumeDraft = (value) => {
    volumeDraft = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
    volume.value = String(volumeDraft);
    rootElement.querySelector("#spotify-volume-value").textContent = String(volumeDraft) + "%";
  };
  const finishVolumeInteraction = () => {
    if (!volumeDragging) return;
    volumeDragging = false;
    const finalVolume = Number.isFinite(volumeDraft) ? volumeDraft : (Number(volume.value) || 0);
    window.clearTimeout(volumeDebounceTimer);
    commitVolume(finalVolume).finally(() => { volumeDraft = undefined; });
  };
  volume.addEventListener("pointerdown", beginVolumeInteraction);
  volume.addEventListener("input", (event) => {
    if (!volumeDragging) beginVolumeInteraction();
    updateVolumeDraft(event.target.value);
    window.clearTimeout(volumeDebounceTimer);
    volumeDebounceTimer = window.setTimeout(() => commitVolume(volumeDraft), VOLUME_DEBOUNCE_MS);
  });
  volume.addEventListener("pointerup", finishVolumeInteraction);
  volume.addEventListener("pointercancel", finishVolumeInteraction);
  volume.addEventListener("change", finishVolumeInteraction);
  rootElement.querySelector("#spotify-output-toggle").addEventListener("click", async () => {
    const button = rootElement.querySelector("#spotify-output-toggle");
    button.disabled = true;
    try {
      audioOutput = await requestJson("/api/audio-output/toggle", { method: "POST", body: "{}" });
      renderAudioOutput();
    } catch (error) {
      setStatus(userMessage(error), "warning");
      button.disabled = false;
    }
  });
};

const bootstrap = async () => {
  updateHeader("Spotify", { label: "Kontrollerer tilgang", tone: "neutral" });
  rootElement.innerHTML = '<div class="loading-state"><span></span><p>Kobler til Spotify…</p></div>';
  try {
    const status = await requestJson("/api/spotify/status");
    if (!status.authenticated) return renderConnect(status);
    renderShell();
    bindControls();
    connectRealtimeBridge();
    connectAudioOutput();
    const bridge = await requestJson("/api/spotify/bridge/status");
    applyBridgeSnapshot(bridge);
    await Promise.allSettled([refreshQueue(), refreshAudioOutput()]);
    playbackPollTimer = window.setInterval(() => {
      const edgeIsActive = Boolean(deviceId && currentState?.device.id === deviceId);
      if (!bridgeAvailable || !currentState || !edgeIsActive || !currentState.isPlaying) {
        syncPlayback("poll").catch((error) => setStatus(userMessage(error), "warning"));
      }
    }, FALLBACK_POLL_MS);
    queueTimer = window.setInterval(() => refreshQueue().catch(() => {}), QUEUE_REFRESH_MS);
    positionTimer = window.setInterval(renderPosition, POSITION_TICK_MS);
  } catch (error) {
    if (!rootElement?.querySelector("#spotify-status")) renderShell();
    setStatus(userMessage(error), error?.status === 401 ? "warning" : "error");
    report("bootstrap_error", error.message, { code: error.code || "spotify_bootstrap_failed" });
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
    window.clearInterval(queueTimer);
    window.clearTimeout(volumeDebounceTimer);
    bridgeSource?.close();
    audioOutputSource?.close();
    bridgeSource = undefined;
    audioOutputSource = undefined;
    bridgeAvailable = false;
    engineReady = false;
    activationRequired = false;
    deviceId = "";
    currentState = undefined;
    queueItems = [];
    audioOutput = undefined;
    lastPlaybackSignature = "";
    volumeDragging = false;
    volumeDraft = undefined;
    seekInteractionUntil = 0;
    mutationPending = 0;
    rootElement = undefined;
    updateHeader = undefined;
  },
};
