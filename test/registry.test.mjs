import assert from "node:assert/strict";
import test from "node:test";
import { appRegistry } from "../public/app-registry.js";
import { SpotifyModule } from "../public/modules/spotify.js";

test("registry exposes Dashboard, Spotify, and School as real modules", () => {
  assert.deepEqual(appRegistry.map((entry) => entry.id), ["dashboard", "spotify", "school", "gaming"]);
  assert.equal(new Set(appRegistry.map((entry) => entry.id)).size, appRegistry.length);
  for (const entry of appRegistry) {
    assert.equal(typeof entry.module.mount, "function");
    assert.equal(typeof entry.module.unmount, "function");
  }
  assert.equal(appRegistry.find((entry) => entry.id === "spotify").module, SpotifyModule);
});
