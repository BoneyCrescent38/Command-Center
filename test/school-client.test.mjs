import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sanitizeSchoolSnapshot, sanitizeSchoolWeek } from "../server/dashboard-client.mjs";
import { nextSchoolAction, sortSchoolDeadlines } from "../public/modules/school.js";
import { schoolSnapshotFixture, schoolWeekFixture } from "./fixtures/school-payload.mjs";

test("school sanitizer keeps the actual schema and removes credentials", () => {
  const snapshot = sanitizeSchoolSnapshot(schoolSnapshotFixture);
  assert.equal(snapshot.source.status, "fresh");
  assert.equal(snapshot.source.writable, true);
  assert.equal(snapshot.courses[0].tone, "analog");
  assert.equal(snapshot.courses[0].color, "#7c9cff");
  assert.equal(snapshot.studyPlans[0].checkpoints[0].title, "Les kapittel");
  assert.equal(snapshot.deadlines[1].progress, 50);
  assert.equal(snapshot.examPeriods[0].startWeek, 40);
  assert.equal(JSON.stringify(snapshot).includes("must-not-leak"), false);
  assert.equal(Object.hasOwn(snapshot.source, "missingConfiguration"), false);

  const week = sanitizeSchoolWeek(schoolWeekFixture);
  assert.equal(week.days.length, 7);
  assert.equal(week.days[3].timetable[0].course.name, "Analog elektronikk");
  assert.equal(JSON.stringify(week).includes("credentials"), false);
});

test("next school action is deterministic and excludes completed work", () => {
  const sorted = sortSchoolDeadlines(schoolSnapshotFixture.deadlines, "2026-08-24");
  assert.deepEqual(sorted.map((item) => item.id), ["DL-OVERDUE", "DL-HIGH"]);
  const action = nextSchoolAction(schoolSnapshotFixture, "2026-08-24");
  assert.equal(action.deadline.id, "DL-OVERDUE");
  assert.equal(action.reason, "Forfalt med 1 d");
});

test("SchoolModule stays same-origin, server-confirmed, touch-first, and read-only aware", async () => {
  const source = await readFile(new URL("../public/modules/school.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(source, /4317|PROJECT_DASHBOARD_URL/);
  assert.match(source, /\/api\/school\/week/);
  assert.match(source, /await requestJson\(url, options\)/);
  assert.match(source, /schoolSnapshot = result\.school/);
  assert.match(source, /\/api\/school\/study-checkpoints\//);
  assert.match(source, /day\.date === schoolWeek\.today/);
  assert.doesNotMatch(source, /day\.today \? " is-today"/);
  assert.match(source, /courseToneClass/);
  assert.doesNotMatch(source, /style="--course-color/);
  assert.match(source, /window\.confirm/);
  assert.match(source, /source\.writable/);
  assert.match(source, /\[0, 25, 50, 75, 100\]/);
  assert.match(css, /\.school-view[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.school-columns[^}]*grid-template-columns/s);
});
