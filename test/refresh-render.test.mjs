import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shouldPatchMarkup } from "../public/modules/dom-reconcile.js";

const source = (name) => readFileSync(new URL(`../public/modules/${name}`, import.meta.url), "utf8");

test("markup comparison skips identical background snapshots", () => {
  assert.equal(shouldPatchMarkup("<p>Live</p>", "<p>Live</p>"), false);
  assert.equal(shouldPatchMarkup("<p>Live</p>", "<p>Oppdatert</p>"), true);
});

test("School loading state is limited to initial bootstrap", () => {
  const school = source("school.js");
  assert.match(school, /const initialLoad = !schoolSnapshot \|\| !schoolWeek/);
  assert.match(school, /if \(initialLoad\) \{[\s\S]*Laster skoledata/);
  assert.match(school, /if \(schoolSnapshot && schoolWeek\) \{[\s\S]*status: "stale"/);
  assert.match(school, /commitSchoolMarkup/);
  assert.match(school, /20_000/);
});

test("School and Dashboard reconcile changed markup without remounting module roots", () => {
  const helper = source("dom-reconcile.js");
  const school = source("school.js");
  const dashboard = source("dashboard.js");
  assert.match(helper, /reconcileChildren\(root, template\.content\)/);
  assert.doesNotMatch(helper, /root\.innerHTML\s*=/);
  assert.match(school, /patchRootHtml\(rootNode, markup\)/);
  assert.match(dashboard, /patchRootHtml\(rootElement, markup\)/);
  assert.match(dashboard, /dashboardSnapshot && dashboardView === "dashboard"/);
  assert.match(dashboard, /status: "stale"/);
});

test("Spotify retains its existing targeted realtime renderer", () => {
  const spotify = source("spotify.js");
  assert.doesNotMatch(spotify, /dom-reconcile/);
  assert.match(spotify, /renderPlayback/);
  assert.match(spotify, /EventSource/);
});
