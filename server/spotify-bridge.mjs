const CONTROL_COMMANDS = new Set(["toggle", "previous", "next", "seek", "volume"]);
const MAX_CLIENTS_PER_ROLE = 4;

const text = (value, maximum = 180) => String(value ?? "").slice(0, maximum);
const number = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value) || 0));

const albumArt = (value) => {
  try {
    const url = new URL(String(value || ""));
    const allowed = url.protocol === "https:" && (
      url.hostname === "i.scdn.co" ||
      url.hostname.endsWith(".scdn.co") ||
      url.hostname.endsWith(".spotifycdn.com")
    );
    return allowed ? url.href.slice(0, 600) : "";
  } catch {
    return "";
  }
};

export const sanitizeSpotifyBridgeState = (input = {}, now = Date.now()) => {
  const artists = Array.isArray(input.artists) ? input.artists : [input.artist];
  return {
    track: {
      id: text(input.trackId, 120),
      name: text(input.trackName, 240),
      artists: artists.map((artist) => text(artist, 160)).filter(Boolean).slice(0, 8),
      album: text(input.album, 240),
      albumArt: albumArt(input.albumArt),
    },
    isPlaying: Boolean(input.isPlaying),
    position: number(input.position, 0, 86_400_000),
    duration: number(input.duration, 0, 86_400_000),
    volume: number(input.volume, 0, 100),
    activationRequired: Boolean(input.activationRequired),
    device: {
      id: text(input.deviceId, 160),
      name: text(input.deviceName, 160) || "Command Center Xeneon",
      ready: Boolean(input.deviceReady),
    },
    updatedAt: now,
  };
};

const sseMessage = (event, data, id) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createSpotifyBridge(options = {}) {
  const now = options.now || (() => Date.now());
  const clients = { edge: new Set(), xeneon: new Set() };
  let state = null;
  let edgeReady = false;
  let sequence = 0;
  let stateRevision = 0;
  const pendingControls = new Map();

  const snapshot = () => ({
    available: edgeReady && clients.edge.size > 0 && Boolean(state),
    edgeReady,
    edgeClients: clients.edge.size,
    xeneonClients: clients.xeneon.size,
    state,
  });

  const send = (client, event, data) => {
    if (client.response.destroyed || client.response.writableEnded) return false;
    client.response.write(sseMessage(event, data, ++sequence));
    return true;
  };

  const broadcast = (role, event, data) => {
    for (const client of clients[role]) if (!send(client, event, data)) clients[role].delete(client);
  };

  const broadcastBridge = () => broadcast("xeneon", "bridge", snapshot());

  const openStream = (request, response, role) => {
    if (!(role in clients)) throw Object.assign(new Error("Ugyldig bridge-rolle"), { status: 400, code: "spotify_bridge_role_invalid" });
    if (clients[role].size >= MAX_CLIENTS_PER_ROLE) throw Object.assign(new Error("For mange lokale bridge-klienter"), { status: 429, code: "spotify_bridge_client_limit" });
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();
    const client = { response, heartbeat: undefined };
    clients[role].add(client);
    send(client, "bridge", snapshot());
    if (role === "xeneon" && state) send(client, "state", state);
    client.heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 10000);
    const close = () => {
      clearInterval(client.heartbeat);
      clients[role].delete(client);
      if (role === "edge" && clients.edge.size === 0) {
        edgeReady = false;
        broadcastBridge();
      }
    };
    request.once("close", close);
    response.once?.("close", close);
  };

  const updateState = (input) => {
    state = sanitizeSpotifyBridgeState(input, now());
    stateRevision += 1;
    pendingControls.clear();
    edgeReady = state.device.ready;
    broadcast("xeneon", "state", state);
    broadcastBridge();
    return snapshot();
  };

  const dispatchControl = (input = {}) => {
    const command = text(input.command, 24);
    if (!CONTROL_COMMANDS.has(command)) throw Object.assign(new Error("Ugyldig Spotify-kontroll"), { status: 400, code: "spotify_bridge_control_invalid" });
    if (!snapshot().available) throw Object.assign(new Error("Edge realtime bridge er ikke tilgjengelig"), { status: 409, code: "spotify_bridge_unavailable" });
    const control = { requestId: String(++sequence), command };
    if (command === "seek") control.position = number(input.position, 0, 86_400_000);
    if (command === "volume") control.volume = number(input.volume, 0, 100);
    if (state && (command === "toggle" || command === "seek" || command === "volume")) {
      const previous = state;
      const optimistic = {
        ...state,
        track: { ...state.track, artists: [...state.track.artists] },
        device: { ...state.device },
        updatedAt: now(),
      };
      if (command === "toggle") {
        optimistic.isPlaying = !state.isPlaying;
        control.isPlaying = optimistic.isPlaying;
      }
      if (command === "seek") optimistic.position = control.position;
      if (command === "volume") optimistic.volume = control.volume;
      state = optimistic;
      stateRevision += 1;
      pendingControls.set(control.requestId, { previous, revision: stateRevision });
      broadcast("xeneon", "state", state);
    }
    broadcast("edge", "control", control);
    return { accepted: true, requestId: control.requestId, command };
  };

  const acknowledge = (input = {}) => {
    const acknowledgement = {
      requestId: text(input.requestId, 40),
      command: text(input.command, 24),
      ok: Boolean(input.ok),
      message: text(input.message, 240),
    };
    const pending = pendingControls.get(acknowledgement.requestId);
    pendingControls.delete(acknowledgement.requestId);
    if (!acknowledgement.ok && pending?.revision === stateRevision) {
      state = { ...pending.previous, updatedAt: now() };
      stateRevision += 1;
      broadcast("xeneon", "state", state);
    }
    broadcast("xeneon", "ack", acknowledgement);
    return acknowledgement;
  };

  const setActivationRequired = (input = {}) => {
    const activation = {
      required: Boolean(input.required),
      message: text(input.message, 240),
    };
    if (state) {
      state = { ...state, activationRequired: activation.required, updatedAt: now() };
      stateRevision += 1;
      broadcast("xeneon", "state", state);
    }
    broadcast("edge", "activation", activation);
    broadcastBridge();
    return snapshot();
  };

  return { acknowledge, dispatchControl, openStream, setActivationRequired, snapshot, updateState };
}
