import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const start = fs.readFileSync(new URL("../scripts/start-spotify-edge.ps1", import.meta.url), "utf8");
const stop = fs.readFileSync(new URL("../scripts/stop-spotify-edge.ps1", import.meta.url), "utf8");
const windowMode = fs.readFileSync(new URL("../scripts/set-spotify-edge-window.ps1", import.meta.url), "utf8");
const engine = fs.readFileSync(new URL("../scripts/start-spotify-engine.ps1", import.meta.url), "utf8");
const edgePlayer = fs.readFileSync(new URL("../public/spotify-edge-player.js", import.meta.url), "utf8");
const startHost = fs.readFileSync(new URL("../scripts/start-host.ps1", import.meta.url), "utf8");
const stopAll = fs.readFileSync(new URL("../scripts/stop.ps1", import.meta.url), "utf8");
const audioProbe = fs.readFileSync(new URL("../scripts/test-spotify-edge-audio.ps1", import.meta.url), "utf8");

test("Spotify Edge lifecycle is isolated to the dedicated profile and player URL", () => {
  for (const source of [start, stop, windowMode]) {
    assert.match(source, /KristianLiverod\\CommandCenter\\SpotifyEdge/);
    assert.match(source, /spotify-edge-player\.html/);
  }

  assert.doesNotMatch(stop, /taskkill|Stop-Process\s+-Name/i);
  assert.match(stop, /ownedRoot\.Count -eq 0/);
  assert.match(start, /already running/);
  assert.match(engine, /127\.0\.0\.1:4337\/health/);
});

test("Command Center controller scripts own Spotify engine lifecycle", () => {
  assert.match(startHost, /start-spotify-engine\.ps1/);
  assert.match(stopAll, /stop-spotify-edge\.ps1/);
  assert.match(startHost, /-WindowMode Hidden/);
  assert.match(stopAll, /PreserveSpotifyEdge/);
  assert.match(windowMode, /TargetXeneon/);
  assert.match(windowMode, /ActivationFlow/);
  assert.match(windowMode, /SetHostMode/);
  assert.match(windowMode, /DISPLAY5/);
  assert.match(windowMode, /\$ownedRoot \| ForEach-Object/);
  assert.match(audioProbe, /CommandCenterSpotifyAudioProbe/);
  assert.match(audioProbe, /KristianLiverod\\CommandCenter\\SpotifyEdge/);
  assert.doesNotMatch(audioProbe, /Stop-Process|taskkill/);
});

test("Edge controls maintain local realtime state without Web API polling", () => {
  assert.match(edgePlayer, /publishOptimisticBridgeControl/);
  assert.match(edgePlayer, /publishCachedBridgeState/);
  assert.match(edgePlayer, /localControlExpectation/);
  assert.match(edgePlayer, /Date\.now\(\) \+ 1200/);
  assert.match(edgePlayer, /player_state_changed/);
  assert.doesNotMatch(edgePlayer, /\/api\/spotify\/player\/playback/);
});
