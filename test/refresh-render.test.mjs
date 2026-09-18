import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  shouldPatchMarkup,
  syncElementAttributes,
} from "../public/modules/dom-reconcile.js";

const source = (name) => readFileSync(new URL(`../public/modules/${name}`, import.meta.url), "utf8");

const styleDeclaration = (properties = {}) => {
  const values = new Map(Object.entries(properties));
  return {
    get length() { return values.size; },
    item(index) { return [...values.keys()][index] || ""; },
    getPropertyValue(property) { return values.get(property)?.value || ""; },
    getPropertyPriority(property) { return values.get(property)?.priority || ""; },
    setProperty(property, value, priority = "") { values.set(property, { value, priority }); },
    removeProperty(property) { values.delete(property); },
  };
};

const progressFill = (remaining) => {
  const attributes = new Map([
    ["style", `width:${remaining}%`],
    ["aria-valuenow", String(remaining)],
  ]);
  const style = styleDeclaration({ width: { value: `${remaining}%`, priority: "" } });
  return {
    style,
    get attributes() {
      return [...attributes].map(([name, value]) => ({ name, value }));
    },
    hasAttribute(name) { return attributes.has(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    setAttribute(name, value) {
      assert.notEqual(name, "style", "runtime style must be reconciled through CSSOM");
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === "style") {
        for (const property of Array.from({ length: style.length }, (_, index) => style.item(index))) {
          style.removeProperty(property);
        }
      }
    },
  };
};

test("markup comparison skips identical background snapshots", () => {
  assert.equal(shouldPatchMarkup("<p>Live</p>", "<p>Live</p>"), false);
  assert.equal(shouldPatchMarkup("<p>Live</p>", "<p>Oppdatert</p>"), true);
});

test("mounted capacity progress reconciles width and ARIA on every live update", () => {
  const mountedFill = progressFill(100);

  for (const remaining of [100, 83, 50, 1, 0]) {
    const desiredFill = progressFill(remaining);
    syncElementAttributes(mountedFill, desiredFill);
    assert.equal(mountedFill.style.getPropertyValue("width"), `${remaining}%`);
    assert.equal(mountedFill.getAttribute("aria-valuenow"), String(remaining));
  }
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
