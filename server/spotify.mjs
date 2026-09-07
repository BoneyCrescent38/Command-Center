import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_URL = "https://api.spotify.com/v1";
export const SPOTIFY_SCOPES = Object.freeze([
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-modify-playback-state",
]);

const spotifyError = (message, status, code) => Object.assign(new Error(message), { status, code });
const base64Url = (value) => Buffer.from(value).toString("base64url");

const runDpapi = (mode, value) => {
  const protect = mode === "protect";
  const script = protect
    ? "Add-Type -AssemblyName System.Security;$plain=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($plain);$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($result))"
    : "Add-Type -AssemblyName System.Security;$cipher=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($cipher);$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($result))";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: value,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) {
    throw spotifyError("Spotify-tokenlageret kunne ikke åpnes", 500, "spotify_token_protection_failed");
  }
  return result.stdout;
};

const defaultTokenProtector = Object.freeze({
  protect: (value) => runDpapi("protect", value),
  unprotect: (value) => runDpapi("unprotect", value),
});

const sanitizeEvent = (event = {}) => {
  const type = /^[a-z0-9_:-]{1,64}$/i.test(String(event.type || "")) ? String(event.type) : "unknown";
  const message = String(event.message || "").slice(0, 500);
  const details = {};
  for (const [key, value] of Object.entries(event.details || {}).slice(0, 16)) {
    if (/^[a-z0-9_-]{1,48}$/i.test(key) && ["string", "number", "boolean"].includes(typeof value)) {
      details[key] = typeof value === "string" ? value.slice(0, 300) : value;
    }
  }
  return { type, message, details, at: new Date().toISOString() };
};

const sanitizeQueueTrack = (track = {}) => ({
  id: String(track.id || track.uri || "").slice(0, 180),
  name: String(track.name || "Ukjent spor").slice(0, 300),
  artists: Array.isArray(track.artists) ? track.artists.map((artist) => String(artist?.name || "").slice(0, 200)).filter(Boolean).slice(0, 8) : [],
  album: String(track.album?.name || "").slice(0, 300),
  albumArt: String(track.album?.images?.[0]?.url || "").slice(0, 500),
  duration: Math.max(0, Number(track.duration_ms) || 0),
});

export const sanitizeSpotifyQueue = (payload = {}) => ({
  currentlyPlaying: payload.currently_playing ? sanitizeQueueTrack(payload.currently_playing) : null,
  queue: Array.isArray(payload.queue) ? payload.queue.slice(0, 8).map(sanitizeQueueTrack) : [],
});

export function createSpotifyClient(config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const tokenProtector = options.tokenProtector || defaultTokenProtector;
  const now = options.now || (() => Date.now());
  const pendingAuth = new Map();
  const events = [];
  let tokenCache;
  let deviceId = "";

  const requireConfiguration = () => {
    if (!config.spotifyClientId) throw spotifyError("Spotify Client ID mangler", 503, "spotify_not_configured");
  };

  const readTokens = () => {
    if (tokenCache !== undefined) return tokenCache;
    if (!existsSync(config.spotifyTokenFile)) return (tokenCache = null);
    try {
      const envelope = JSON.parse(readFileSync(config.spotifyTokenFile, "utf8"));
      tokenCache = JSON.parse(tokenProtector.unprotect(envelope.protected));
      return tokenCache;
    } catch {
      throw spotifyError("Spotify-tokenlageret er ugyldig", 500, "spotify_token_store_invalid");
    }
  };

  const writeTokens = (tokens) => {
    mkdirSync(path.dirname(config.spotifyTokenFile), { recursive: true });
    const envelope = JSON.stringify({ version: 1, protection: "dpapi-current-user", protected: tokenProtector.protect(JSON.stringify(tokens)) });
    const temporary = config.spotifyTokenFile + ".tmp";
    writeFileSync(temporary, envelope, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, config.spotifyTokenFile);
    tokenCache = tokens;
  };

  const tokenRequest = async (parameters) => {
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(parameters).toString(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      throw spotifyError(body.error_description || body.error || "Spotify avviste tokenforespørselen", response.status || 502, "spotify_token_failed");
    }
    return body;
  };

  const storeTokenResponse = (body, previous = {}) => {
    const tokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || previous.refreshToken || "",
      tokenType: body.token_type || previous.tokenType || "Bearer",
      scope: body.scope || previous.scope || SPOTIFY_SCOPES.join(" "),
      expiresAt: now() + Math.max(1, Number(body.expires_in) || 3600) * 1000,
    };
    writeTokens(tokens);
    return tokens;
  };

  const createAuthorizationUrl = () => {
    requireConfiguration();
    const verifier = base64Url(randomBytes(64));
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = base64Url(randomBytes(32));
    const expiresAt = now() + 10 * 60 * 1000;
    for (const [key, entry] of pendingAuth) if (entry.expiresAt <= now()) pendingAuth.delete(key);
    pendingAuth.set(state, { verifier, expiresAt });
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: config.spotifyClientId,
      response_type: "code",
      redirect_uri: config.spotifyRedirectUri,
      scope: SPOTIFY_SCOPES.join(" "),
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
    });
    return url.toString();
  };

  const completeAuthorization = async ({ code, state, error }) => {
    requireConfiguration();
    if (error) throw spotifyError("Spotify-tilgangen ble avvist: " + error, 400, "spotify_access_denied");
    const pending = pendingAuth.get(String(state || ""));
    pendingAuth.delete(String(state || ""));
    if (!pending || pending.expiresAt <= now() || !code) {
      throw spotifyError("Spotify OAuth-state er ugyldig eller utløpt", 400, "spotify_invalid_state");
    }
    const body = await tokenRequest({
      client_id: config.spotifyClientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.spotifyRedirectUri,
      code_verifier: pending.verifier,
    });
    return storeTokenResponse(body);
  };

  const getAccessToken = async () => {
    requireConfiguration();
    const current = readTokens();
    if (!current) throw spotifyError("Spotify er ikke autentisert", 401, "spotify_auth_required");
    if (current.accessToken && current.expiresAt > now() + 60_000) return current;
    if (!current.refreshToken) throw spotifyError("Spotify-sessionen må fornyes", 401, "spotify_reauth_required");
    const body = await tokenRequest({
      client_id: config.spotifyClientId,
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
    });
    return storeTokenResponse(body, current);
  };

  const spotifyApi = async (pathname, options = {}) => {
    const tokens = await getAccessToken();
    const response = await fetchImpl(API_URL + pathname, {
      ...options,
      headers: {
        Authorization: "Bearer " + tokens.accessToken,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw spotifyError(body?.error?.message || "Spotify API svarte med feil", response.status, "spotify_api_failed");
    }
    return body;
  };

  const controlPlayer = async (action, input = {}) => {
    const target = input.deviceId ? "?device_id=" + encodeURIComponent(input.deviceId) : "";
    if (action === "transfer") {
      if (!input.deviceId) throw spotifyError("Spotify device ID mangler", 400, "spotify_device_required");
      return spotifyApi("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [input.deviceId], play: input.play === true }) });
    }
    if (action === "play") return spotifyApi("/me/player/play" + target, { method: "PUT" });
    if (action === "pause") return spotifyApi("/me/player/pause" + target, { method: "PUT" });
    if (action === "next") return spotifyApi("/me/player/next" + target, { method: "POST" });
    if (action === "previous") return spotifyApi("/me/player/previous" + target, { method: "POST" });
    if (action === "seek") {
      const position = Math.max(0, Math.round(Number(input.positionMs) || 0));
      return spotifyApi("/me/player/seek?position_ms=" + position + (input.deviceId ? "&device_id=" + encodeURIComponent(input.deviceId) : ""), { method: "PUT" });
    }
    if (action === "volume") {
      const volume = Math.max(0, Math.min(100, Math.round(Number(input.volumePercent) || 0)));
      return spotifyApi("/me/player/volume?volume_percent=" + volume + (input.deviceId ? "&device_id=" + encodeURIComponent(input.deviceId) : ""), { method: "PUT" });
    }
    if (action === "shuffle") return spotifyApi("/me/player/shuffle?state=" + (input.state === true) + target.replace("?", "&"), { method: "PUT" });
    if (action === "repeat") {
      const state = ["off", "context", "track"].includes(input.state) ? input.state : "off";
      return spotifyApi("/me/player/repeat?state=" + state + target.replace("?", "&"), { method: "PUT" });
    }
    throw spotifyError("Ukjent Spotify-handling", 400, "spotify_action_invalid");
  };

  const getPlayerData = async (resource) => {
    if (resource === "devices") return spotifyApi("/me/player/devices");
    if (resource === "queue") return sanitizeSpotifyQueue(await spotifyApi("/me/player/queue"));
    if (resource === "playback") return spotifyApi("/me/player");
    throw spotifyError("Ukjent Spotify-ressurs", 404, "spotify_resource_invalid");
  };

  const recordEvent = (event) => {
    const clean = sanitizeEvent(event);
    if (clean.type === "ready" && /^[a-z0-9_-]{1,160}$/i.test(String(clean.details.deviceId || ""))) {
      deviceId = String(clean.details.deviceId);
    }
    events.push(clean);
    if (events.length > 80) events.shift();
    try {
      mkdirSync(path.dirname(config.spotifyPocLogFile), { recursive: true });
      appendFileSync(config.spotifyPocLogFile, JSON.stringify(clean) + "\n", "utf8");
    } catch {}
    return clean;
  };

  const status = () => {
    const tokens = config.spotifyClientId ? readTokens() : null;
    return {
      configured: Boolean(config.spotifyClientId),
      authenticated: Boolean(tokens?.refreshToken || (tokens?.accessToken && tokens.expiresAt > now())),
      expiresAt: tokens?.expiresAt || null,
      scopes: String(tokens?.scope || "").split(/\s+/).filter(Boolean),
      redirectUri: config.spotifyRedirectUri,
      deviceId: deviceId || null,
      events: events.slice(-30),
    };
  };

  const clearAuthorization = () => {
    tokenCache = null;
    if (existsSync(config.spotifyTokenFile)) unlinkSync(config.spotifyTokenFile);
  };

  return Object.freeze({
    createAuthorizationUrl,
    completeAuthorization,
    getAccessToken,
    getPlayerData,
    controlPlayer,
    recordEvent,
    status,
    clearAuthorization,
  });
}
