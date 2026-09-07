import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSpotifyBridge, sanitizeSpotifyBridgeState } from "../server/spotify-bridge.mjs";

const stream = () => {
  const request = new EventEmitter();
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  response.output = "";
  response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
  response.write = (chunk) => { response.output += chunk; return true; };
  response.flushHeaders = () => {};
  return { request, response };
};

test("Spotify bridge sanitizes realtime SDK state", () => {
  const state = sanitizeSpotifyBridgeState({
    trackId: "track-1",
    trackName: "Real track",
    artists: ["Artist"],
    album: "Album",
    albumArt: "https://i.scdn.co/image/cover",
    isPlaying: true,
    position: 1200,
    duration: 240000,
    volume: 55,
    deviceId: "device-1",
    deviceName: "Command Center Xeneon",
    deviceReady: true,
    activationRequired: true,
    accessToken: "must-not-pass",
  }, 1000);
  assert.equal(state.track.name, "Real track");
  assert.equal(state.device.ready, true);
  assert.equal(state.activationRequired, true);
  assert.equal(state.updatedAt, 1000);
  assert.equal("accessToken" in state, false);
});

test("Spotify bridge pushes SDK state and controls over local SSE", () => {
  const bridge = createSpotifyBridge({ now: () => 2000 });
  const edge = stream();
  const xeneon = stream();
  bridge.openStream(edge.request, edge.response, "edge");
  bridge.openStream(xeneon.request, xeneon.response, "xeneon");
  bridge.updateState({ trackName: "Track", isPlaying: true, deviceId: "edge-1", deviceReady: true });
  const accepted = bridge.dispatchControl({ command: "seek", position: 9000 });
  assert.equal(accepted.accepted, true);
  assert.equal(bridge.snapshot().state.position, 9000);
  assert.match(edge.response.output, /event: control/);
  assert.match(edge.response.output, /"command":"seek"/);
  assert.match(xeneon.response.output, /event: state/);
  bridge.acknowledge({ requestId: accepted.requestId, command: "seek", ok: false, message: "failed" });
  assert.equal(bridge.snapshot().state.position, 0);
  assert.equal(bridge.snapshot().available, true);
  edge.request.emit("close");
  xeneon.request.emit("close");
});

test("Spotify bridge sends one authoritative expected toggle state to Edge", () => {
  const bridge = createSpotifyBridge({ now: () => 3000 });
  const edge = stream();
  bridge.openStream(edge.request, edge.response, "edge");
  bridge.updateState({ isPlaying: true, deviceId: "edge-1", deviceReady: true });
  bridge.dispatchControl({ command: "toggle" });
  assert.equal(bridge.snapshot().state.isPlaying, false);
  assert.match(edge.response.output, /"isPlaying":false/);
  edge.request.emit("close");
});

test("Spotify bridge remains available while the hidden Edge SSE client is connected", () => {
  let time = 1000;
  const bridge = createSpotifyBridge({ now: () => time });
  const edge = stream();
  bridge.openStream(edge.request, edge.response, "edge");
  bridge.updateState({ deviceId: "edge-1", deviceReady: true });
  time += 300000;
  assert.equal(bridge.snapshot().available, true);
  edge.request.emit("close");
  assert.equal(bridge.snapshot().available, false);
});

test("Spotify bridge can require a real Edge activation without exposing credentials", () => {
  const bridge = createSpotifyBridge({ now: () => 4000 });
  const edge = stream();
  bridge.openStream(edge.request, edge.response, "edge");
  bridge.updateState({ deviceId: "edge-1", deviceReady: true, activationRequired: false });
  bridge.setActivationRequired({ required: true, message: "Audio session missing", accessToken: "blocked" });
  assert.equal(bridge.snapshot().state.activationRequired, true);
  assert.match(edge.response.output, /event: activation/);
  assert.doesNotMatch(edge.response.output, /blocked/);
  edge.request.emit("close");
});
