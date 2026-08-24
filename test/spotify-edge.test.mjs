import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const player = readFileSync(new URL("../public/spotify-edge-player.js", import.meta.url), "utf8");
const launcher = readFileSync(new URL("../scripts/start-spotify-edge.ps1", import.meta.url), "utf8");
const dashboardPoc = readFileSync(new URL("../public/modules/spotify.js", import.meta.url), "utf8");

test("Edge A2 player stays real, dedicated, and explicitly activated", () => {
  assert.match(player, /https:\/\/sdk\.scdn\.co\/spotify-player\.js/);
  assert.match(player, /Command Center Xeneon/);
  assert.match(player, /player\.activateElement\(\)/);
  assert.match(player, /api\/spotify\/player\/transfer/);
  assert.match(player, /navigator\.locks/);
  assert.match(player, /edge_duplicate_blocked/);
  assert.doesNotMatch(player, /hardcod|fixture|mock track/i);
});

test("Edge launcher owns only its dedicated profile and never kills generic Edge", () => {
  assert.match(launcher, /KristianLiverod\\CommandCenter\\SpotifyEdge/);
  assert.match(launcher, /--user-data-dir=/);
  assert.match(launcher, /--app=/);
  assert.match(launcher, /CommandLine/);
  assert.doesNotMatch(launcher, /Stop-Process|taskkill|TerminateProcess/);
});

test("Xeneon POC controls the ready Edge device through the server API", () => {
  assert.match(dashboardPoc, /sendPlayerCommand/);
  assert.match(dashboardPoc, /api\/spotify\/player\/playback/);
  assert.match(dashboardPoc, /FALLBACK_POLL_MS = 5000/);
  assert.match(dashboardPoc, /POSITION_TICK_MS = 250/);
  assert.match(dashboardPoc, /VOLUME_DEBOUNCE_MS = 140/);
  assert.match(dashboardPoc, /setOptimisticPlaying/);
  assert.match(dashboardPoc, /setOptimisticSeek/);
  assert.match(dashboardPoc, /mutationPending/);
  assert.match(dashboardPoc, /EventSource\("\/api\/spotify\/bridge\/stream\?role=xeneon"\)/);
  assert.match(dashboardPoc, /bridgeAvailable/);
  assert.match(player, /EventSource\("\/api\/spotify\/bridge\/stream\?role=edge"\)/);
  assert.match(player, /player\.togglePlay\(\)/);
  assert.match(player, /player\.setVolume/);
  assert.match(dashboardPoc, /external_playback_change/);
  assert.match(dashboardPoc, /isPlaying \? "Pause" : "Play"/);
  assert.match(dashboardPoc, /Spill på Command Center/);
  assert.doesNotMatch(dashboardPoc, /Aktiver Plan A|new Spotify\.Player|player_state_changed/);
});
