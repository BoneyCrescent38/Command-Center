import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAudioOutputService, sanitizeAudioOutputStatus } from "../server/audio-output.mjs";
import { sanitizeSpotifyQueue } from "../server/spotify.mjs";

test("Spotify V1 is a realtime touch surface without POC diagnostics", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../public/modules/spotify.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /spotify-v1/);
  assert.match(source, /EventSource\("\/api\/spotify\/bridge\/stream\?role=xeneon"\)/);
  assert.match(source, /POSITION_TICK_MS = 250/);
  assert.match(source, /api\/spotify\/player\/queue/);
  assert.match(source, /api\/audio-output\/toggle/);
  assert.match(source, /EventSource\("\/api\/audio-output\/stream"\)/);
  assert.doesNotMatch(await readFile(new URL("../server/audio-output.mjs", import.meta.url), "utf8"), /\\\\n/);
  assert.match(source, /Spill på Command Center/);
  assert.match(source, /sendPlayerCommand\("toggle"/);
  assert.doesNotMatch(source, /Aktiver Plan A|Widevine|EME_|spotify-events|Vis Connect-devices/);
  assert.doesNotMatch(source, /2500/);
  assert.match(styles, /grid-template-columns: minmax\(390px/);
  assert.match(styles, /spotify-cover-wrap/);
  assert.match(styles, /overflow: hidden/);
});

test("Spotify queue is bounded and sanitized", () => {
  const result = sanitizeSpotifyQueue({
    currently_playing: { id: "now", name: "Now", artists: [{ name: "Artist" }], album: { name: "Album", images: [{ url: "https://i.scdn.co/now" }] } },
    queue: Array.from({ length: 12 }, (_, index) => ({
      id: "track-" + index,
      name: "Track " + index,
      artists: [{ name: "Artist " + index }],
      album: { name: "Album", images: [{ url: "https://i.scdn.co/" + index }] },
      accessToken: "never",
    })),
  });
  assert.equal(result.queue.length, 8);
  assert.equal(result.currentlyPlaying.name, "Now");
  assert.equal("accessToken" in result.queue[0], false);
});

test("audio output service returns only sanitized local status", async () => {
  const service = createAudioOutputService({
    root: "unused",
    runner: async (action) => ({
      configured: true,
      active: action === "Toggle" ? "headset" : "speakers",
      defaultName: "Speakers (Logi Z407)",
      defaultId: "must-not-leak",
      speakersAvailable: true,
      headsetAvailable: true,
    }),
  });
  assert.equal((await service.status()).active, "speakers");
  const toggled = await service.toggle();
  assert.equal(toggled.active, "headset");
  assert.equal("defaultId" in toggled, false);
  assert.deepEqual(sanitizeAudioOutputStatus({ active: "invalid" }).active, "other");
});

test("Windows audio toggle uses Core Audio and no bundled switcher", async () => {
  const script = await readFile(new URL("../scripts/audio-output.ps1", import.meta.url), "utf8");
  assert.match(script, /IPolicyConfig/);
  assert.match(script, /SetDefaultEndpoint/);
  assert.match(script, /IMMNotificationClient/);
  assert.match(script, /OnDefaultDeviceChanged/);
  assert.match(script, /WatchDefaultEndpoint/);
  assert.match(script, /\.runtime\\audio-output\.json/);
  assert.doesNotMatch(script, /nircmd|SoundVolumeView|third.party/i);
});
test("audio output service pushes Core Audio changes over local SSE", async () => {
  let pushWatcherStatus;
  let watcherStopped = false;
  const service = createAudioOutputService({
    root: "unused",
    runner: async () => ({
      configured: true,
      active: "speakers",
      defaultName: "Speakers",
      speakersAvailable: true,
      headsetAvailable: true,
    }),
    watcherFactory: ({ onStatus }) => {
      pushWatcherStatus = onStatus;
      return () => { watcherStopped = true; };
    },
  });
  const request = new EventEmitter();
  const chunks = [];
  const response = {
    writeHead: (status, headers) => {
      assert.equal(status, 200);
      assert.equal(headers["Content-Type"], "text/event-stream; charset=utf-8");
    },
    write: (chunk) => chunks.push(chunk),
  };

  service.openStream(request, response);
  await new Promise((resolve) => setImmediate(resolve));
  pushWatcherStatus({
    configured: true,
    active: "headset",
    defaultName: "Headset",
    speakersAvailable: true,
    headsetAvailable: true,
    defaultId: "must-not-leak",
  });
  assert.match(chunks.join(""), /event: audio-output/);
  assert.match(chunks.join(""), /"active":"headset"/);
  assert.doesNotMatch(chunks.join(""), /must-not-leak/);
  request.emit("close");
  assert.equal(watcherStopped, true);
  service.close();
});