import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  formatProjectBadge,
  selectMainUsageWindows,
  selectVisibleProjects,
} from "../public/modules/dashboard.js";

const activeProject = (index) => ({ id: `active-${index}`, status: "in_progress" });

test("capacity selects only real Generell Codex / Work windows", () => {
  const windows = [
    { id: "work-5h", poolLabel: "Generell Codex / Work", durationLabel: "5 timer" },
    { id: "spark", poolLabel: "Codex Spark", durationLabel: "Ukesgrense" },
    { id: "work-week", poolLabel: "Generell Codex / Work", durationLabel: "Ukesgrense" },
  ];

  assert.deepEqual(selectMainUsageWindows(windows).map((window) => window.id), ["work-5h", "work-week"]);
});

test("project surface shows eight active projects before an optional on-hold project", () => {
  const tenActive = Array.from({ length: 10 }, (_, index) => activeProject(index));
  const onHold = { id: "hold", status: "on_hold" };
  const capped = selectVisibleProjects([...tenActive, onHold]);
  assert.equal(capped.length, 8);
  assert.ok(capped.every((project) => project.status === "in_progress"));
  assert.equal(formatProjectBadge(10, capped.length), "10 aktive · 8 vist");

  const withRoom = selectVisibleProjects([...tenActive.slice(0, 7), onHold]);
  assert.equal(withRoom.length, 8);
  assert.equal(withRoom.at(-1).id, "hold");
});

test("dashboard cards keep project stats and services in separate surfaces", async () => {
  const source = await readFile(new URL("../public/modules/dashboard.js", import.meta.url), "utf8");
  const capacity = source.slice(source.indexOf('class="cc-card capacity-card'), source.indexOf('class="cc-card focus-card'));
  const overview = source.slice(source.indexOf('class="cc-card attention-card'), source.indexOf('class="cc-card projects-card'));
  const operations = source.slice(source.indexOf('class="cc-card services-card'));

  assert.match(capacity, /mainUsageWindows\.map/);
  assert.doesNotMatch(capacity, /snapshot\.stats/);
  assert.match(source, /class="usage-progress"/);
  assert.match(source, /% brukt/);
  assert.match(source, /%"\) \+ '<\/b><span>igjen/);
  assert.match(overview, /Prosjektoversikt/);
  assert.match(overview, /stats\?\.active/);
  assert.match(overview, /stats\?\.done/);
  assert.doesNotMatch(overview, /serviceMarkup/);
  assert.match(operations, /services\.slice\(0, 5\)\.map\(serviceMarkup\)/);
});

test("dashboard login requests persistence without storing the PIN", async () => {
  const source = await readFile(new URL("../public/modules/dashboard.js", import.meta.url), "utf8");
  assert.match(source, /remember: true/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/);
});
