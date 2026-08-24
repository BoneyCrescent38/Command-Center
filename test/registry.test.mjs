import assert from "node:assert/strict";
import test from "node:test";
import { appRegistry } from "../public/app-registry.js";

test("registry exposes one real module and three isolated placeholders", () => {
  assert.deepEqual(appRegistry.map((entry) => entry.id), ["dashboard", "spotify", "school", "gaming"]);
  assert.equal(new Set(appRegistry.map((entry) => entry.id)).size, appRegistry.length);
  for (const entry of appRegistry) {
    assert.equal(typeof entry.module.mount, "function");
    assert.equal(typeof entry.module.unmount, "function");
  }
});