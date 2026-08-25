const SDK_URL = "https://sdk.scdn.co/spotify-player.js";
const DEVICE_NAME = "Command Center Xeneon";
const TIMEOUT_MS = 15000;

const elements = {
  summary: document.querySelector("#summary"),
  sdk: document.querySelector("#sdk-status"),
  device: document.querySelector("#device-id"),
  playback: document.querySelector("#playback-status"),
  activate: document.querySelector("#activate"),
  events: document.querySelector("#events"),
};

let player;
let deviceId = "";
let lastPlaybackSignature = "";
let releaseLifetime = () => {};
const lifetime = new Promise((resolve) => { releaseLifetime = resolve; });
let bridgeSource;
let bridgeHeartbeat;
let bridgeSnapshot;
let bridgeSnapshotAt = 0;
let localControlExpectation;
let activationRequired = false;
let activationInProgress = false;

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || `HTTP ${response.status}`), { code: body.code });
  return body;
};

const report = async (type, message, details = {}) => {
  const item = document.createElement("li");
  item.textContent = `${type.toUpperCase()}: ${message}`;
  if (/error|failed|timeout|violation/.test(type)) item.className = "error";
  else if (/ready|connected|supported|playing/.test(type)) item.className = "ok";
  elements.events.prepend(item);
  try {
    await requestJson("/api/spotify/poc/events", { method: "POST", body: JSON.stringify({ type, message, details: { ...details, engine: "edge-a2" } }) });
  } catch {}
};

const sendBridgeSnapshot = (snapshot) => requestJson("/api/spotify/bridge/state", {
  method: "POST",
  body: JSON.stringify(snapshot),
});

const publishBridgeState = async (state, ready = true, overrides = {}) => {
  const track = state?.track_window?.current_track;
  const volume = player ? await player.getVolume().catch(() => 0) : 0;
  bridgeSnapshot = {
    trackId: track?.id || track?.uri || "",
    trackName: track?.name || "",
    artists: (track?.artists || []).map((artist) => artist.name),
    album: track?.album?.name || "",
    albumArt: track?.album?.images?.[0]?.url || "",
    isPlaying: overrides.isPlaying ?? Boolean(state && !state.paused),
    position: overrides.position ?? (Number(state?.position) || 0),
    duration: Number(state?.duration) || 0,
    volume: Math.round(volume * 100),
    activationRequired,
    deviceId,
    deviceName: DEVICE_NAME,
    deviceReady: ready,
  };
  bridgeSnapshotAt = Date.now();
  await sendBridgeSnapshot(bridgeSnapshot);
};

const publishCurrentBridgeState = async () => publishBridgeState(await player?.getCurrentState(), Boolean(deviceId));

const setActivationRequired = async (required, message = "") => {
  activationRequired = Boolean(required);
  document.body.classList.toggle("activation-required", activationRequired);
  elements.activate.textContent = activationRequired ? "Aktiver Spotify-lyd" : "Aktiver lyd og overfør playback";
  if (activationRequired) {
    elements.activate.disabled = !deviceId;
    elements.summary.textContent = message || "Spotify trenger ett trykk for å aktivere lyd.";
  }
  await publishCurrentBridgeState();
};

const waitForPlayingState = async (timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await player.getCurrentState();
    if (state && !state.paused) return state;
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error("Spotify playback startet ikke etter aktivering");
};

const advanceBridgeSnapshot = () => {
  if (!bridgeSnapshot) return;
  const now = Date.now();
  if (bridgeSnapshot.isPlaying) {
    bridgeSnapshot.position = Math.min(
      bridgeSnapshot.duration || Number.MAX_SAFE_INTEGER,
      bridgeSnapshot.position + Math.max(0, now - bridgeSnapshotAt),
    );
  }
  bridgeSnapshotAt = now;
};

const publishCachedBridgeState = async () => {
  if (!bridgeSnapshot) return publishCurrentBridgeState();
  advanceBridgeSnapshot();
  await sendBridgeSnapshot(bridgeSnapshot);
};

const publishOptimisticBridgeControl = async (control) => {
  if (!bridgeSnapshot) return;
  advanceBridgeSnapshot();
  localControlExpectation = {
    until: Date.now() + 1200,
  };
  if (control.command === "toggle") {
    bridgeSnapshot.isPlaying = Boolean(control.isPlaying);
    localControlExpectation.isPlaying = bridgeSnapshot.isPlaying;
  }
  if (control.command === "seek") {
    bridgeSnapshot.position = Number(control.position) || 0;
    localControlExpectation.position = bridgeSnapshot.position;
  }
  if (control.command === "volume") {
    bridgeSnapshot.volume = Number(control.volume) || 0;
    localControlExpectation.volume = bridgeSnapshot.volume;
  }
  await sendBridgeSnapshot(bridgeSnapshot);
};

const acknowledgeControl = (control, ok, message = "") => requestJson("/api/spotify/bridge/ack", {
  method: "POST",
  body: JSON.stringify({ requestId: control.requestId, command: control.command, ok, message }),
}).catch(() => {});

const executeBridgeControl = async (control) => {
  try {
    await publishOptimisticBridgeControl(control);
    if (control.command === "toggle") await player.togglePlay();
    else if (control.command === "previous") await player.previousTrack();
    else if (control.command === "next") await player.nextTrack();
    else if (control.command === "seek") await player.seek(Number(control.position) || 0);
    else if (control.command === "volume") await player.setVolume((Number(control.volume) || 0) / 100);
    else throw new Error("Ukjent bridge-kontroll");
    await acknowledgeControl(control, true);
  } catch (error) {
    await acknowledgeControl(control, false, error.message);
    await publishCurrentBridgeState().catch(() => {});
    await report("edge_bridge_control_error", error.message, { command: control.command || "unknown" });
  }
};

const connectBridge = () => {
  bridgeSource?.close();
  bridgeSource = new EventSource("/api/spotify/bridge/stream?role=edge");
  bridgeSource.addEventListener("control", (event) => executeBridgeControl(JSON.parse(event.data || "{}")));
  bridgeSource.addEventListener("activation", (event) => {
    const activation = JSON.parse(event.data || "{}");
    setActivationRequired(Boolean(activation.required), activation.message || "Spotify trenger ett trykk for å aktivere lyd.")
      .catch((error) => report("edge_bridge_state_error", error.message));
  });
  bridgeSource.onerror = () => report("edge_bridge_reconnecting", "Local realtime bridge kobler til på nytt");
};

const loadSdk = () => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeout);
    if (error) reject(error);
    else resolve(window.Spotify);
  };
  const timeout = window.setTimeout(() => finish(new Error("SDK timeout")), TIMEOUT_MS);
  window.onSpotifyWebPlaybackSDKReady = () => {
    report("edge_sdk_callback", "SDK ready callback mottatt", { playerPresent: Boolean(window.Spotify?.Player) });
    finish(window.Spotify?.Player ? null : new Error("Spotify.Player mangler"));
  };
  const script = document.createElement("script");
  script.src = SDK_URL;
  script.async = true;
  script.addEventListener("load", () => report("edge_sdk_script_loaded", "SDK-script lastet", { playerPresent: Boolean(window.Spotify?.Player) }), { once: true });
  script.addEventListener("error", () => finish(new Error("SDK-script kunne ikke lastes")), { once: true });
  document.head.append(script);
});

document.addEventListener("securitypolicyviolation", (event) => report("edge_csp_violation", "CSP blokkerte ressurs", {
  blockedUri: event.blockedURI || "unknown",
  directive: event.effectiveDirective || event.violatedDirective || "unknown",
}));
window.addEventListener("unhandledrejection", (event) => report("edge_unhandled_rejection", event.reason?.message || String(event.reason || "Ukjent feil")));

const start = async () => {
  const auth = await requestJson("/api/spotify/status");
  if (!auth.authenticated) throw new Error("Spotify OAuth mangler");
  const Spotify = await loadSdk();
  elements.sdk.textContent = "Player tilgjengelig";
  await report("edge_player_available", "Spotify.Player er tilgjengelig");
  player = new Spotify.Player({
    name: DEVICE_NAME,
    volume: 0.55,
    getOAuthToken: async (callback) => {
      try {
        const token = await requestJson("/api/spotify/token");
        callback(token.accessToken);
        await report("edge_token_ready", "Access token levert til Edge-player", { expiresAt: token.expiresAt || 0 });
      } catch (error) {
        await report("edge_authentication_error", error.message, { code: error.code || "token_failed" });
      }
    },
  });
  for (const type of ["initialization_error", "authentication_error", "account_error", "playback_error"]) {
    player.addListener(type, ({ message }) => report(`edge_${type}`, message || type));
  }
  player.addListener("autoplay_failed", async ({ message }) => {
    await report("edge_autoplay_failed", message || "Browser prevented autoplay due to lack of interaction");
    await setActivationRequired(true, "Trykk for å aktivere Spotify-lyd på Command Center.");
  });
  player.addListener("ready", ({ device_id }) => {
    deviceId = device_id;
    elements.device.textContent = deviceId;
    elements.activate.disabled = false;
    elements.sdk.textContent = "Ready";
    elements.summary.textContent = "Edge er registrert som Spotify Connect-device.";
    report("ready", "Edge-player er klar", { deviceId, deviceName: DEVICE_NAME });
    publishCurrentBridgeState().catch((error) => report("edge_bridge_state_error", error.message));
  });
  player.addListener("not_ready", ({ device_id }) => {
    report("edge_not_ready", "Edge-device er offline", { deviceId: device_id });
    publishBridgeState(null, false).catch(() => {});
  });
  player.addListener("player_state_changed", (state) => {
    if (!state) return report("edge_player_state_empty", "Tom playback-state");
    const track = state.track_window?.current_track;
    const trackId = track?.id || track?.uri || "";
    const expectation = localControlExpectation;
    const overrides = {};
    if (expectation && Date.now() <= expectation.until) {
      if (expectation.isPlaying !== undefined && Boolean(!state.paused) !== expectation.isPlaying) {
        overrides.isPlaying = expectation.isPlaying;
      }
      if (expectation.position !== undefined && Math.abs(Number(state.position) - expectation.position) > 2000) {
        overrides.position = expectation.position;
      }
    } else {
      localControlExpectation = undefined;
    }
    elements.playback.textContent = `${state.paused ? "Pause" : "Spiller"} · ${track?.name || "Ukjent"} · ${Math.round(state.position / 1000)} / ${Math.round(state.duration / 1000)} sek`;
    const signature = `${track?.id || track?.uri || "unknown"}:${state.paused}`;
    if (signature !== lastPlaybackSignature) {
      lastPlaybackSignature = signature;
      report(state.paused ? "edge_paused" : "edge_playing", track?.name || "Playback oppdatert", { position: state.position, duration: state.duration });
    }
    publishBridgeState(state, true, overrides).catch((error) => report("edge_bridge_state_error", error.message));
  });
  connectBridge();
  window.clearInterval(bridgeHeartbeat);
  bridgeHeartbeat = window.setInterval(() => publishCachedBridgeState().catch(() => {}), 5000);
  const connected = await player.connect();
  await report(connected ? "edge_connected" : "edge_connect_failed", `player.connect() returnerte ${connected}`);
  if (!connected) throw new Error("Edge-player kunne ikke koble til");
};

const activateAudio = async () => {
  if (activationInProgress || !activationRequired || !player || !deviceId) return;
  activationInProgress = true;
  elements.activate.disabled = true;
  try {
    await report("edge_activation_tap", "Fysisk aktivering mottatt");
    await player.activateElement();
    await report("edge_media_activated", "Media activation godkjent");
    await requestJson("/api/spotify/player/transfer", { method: "POST", body: JSON.stringify({ deviceId, play: true }) });
    await report("edge_transfer_requested", "Playback overføres til Edge-device", { deviceId });
    const playingState = await waitForPlayingState();
    await publishBridgeState(playingState, true);
    await setActivationRequired(false);
    elements.summary.textContent = "Spotify-lyd er aktiv. Playeren skjules automatisk.";
  } catch (error) {
    await report("edge_transfer_error", error.message, { code: error.code || "transfer_failed" });
    await setActivationRequired(true, "Aktivering mislyktes. Trykk for å prøve igjen.");
    elements.activate.disabled = false;
  } finally {
    activationInProgress = false;
  }
};

elements.activate.addEventListener("click", activateAudio);
document.addEventListener("pointerdown", (event) => {
  if (!activationRequired) return;
  event.preventDefault();
  activateAudio();
}, { capture: true });

const launchSinglePlayer = async () => {
  if (!navigator.locks?.request) {
    await report("edge_lock_unavailable", "Web Locks API mangler; fortsetter med launcher-eierskap");
    await start();
    return lifetime;
  }
  return navigator.locks.request("command-center-spotify-edge-player", { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) {
      elements.sdk.textContent = "Allerede aktiv";
      elements.summary.textContent = "En annen A2-player bruker allerede den dedikerte Edge-profilen.";
      await report("edge_duplicate_blocked", "En ekstra Edge-player ble blokkert av profil-låsen");
      return;
    }
    await report("edge_lock_acquired", "Eksklusiv A2-player-lås er aktiv");
    await start();
    await lifetime;
  });
};

launchSinglePlayer().catch((error) => {
  elements.sdk.textContent = "Feil";
  elements.summary.textContent = error.message;
  report("edge_bootstrap_error", error.message, { code: error.code || "edge_bootstrap_failed" });
});

const disconnect = () => {
  window.clearInterval(bridgeHeartbeat);
  bridgeSource?.close();
  const offline = JSON.stringify({ deviceId, deviceName: DEVICE_NAME, deviceReady: false, activationRequired: false });
  navigator.sendBeacon?.("/api/spotify/bridge/state", new Blob([offline], { type: "application/json" }));
  player?.disconnect();
  releaseLifetime();
};
window.addEventListener("pagehide", disconnect, { once: true });
window.addEventListener("beforeunload", disconnect, { once: true });
