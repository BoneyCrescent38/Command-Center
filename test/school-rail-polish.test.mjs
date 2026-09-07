import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const schoolSource = await readFile(
  new URL("../public/modules/school.js", import.meta.url),
  "utf8",
);

test("the wider app rail contains its active marker inside the separator", () => {
  assert.match(styles, /--rail:\s*160px;/);
  assert.match(styles, /\.app-rail\s*\{[^}]*padding:\s*14px 16px;/s);
  assert.match(styles, /\.app-nav-button\.active::before\s*\{[^}]*left:\s*4px;/s);
  assert.doesNotMatch(styles, /\.app-nav-button\.active::before\s*\{[^}]*(?:left:\s*-|translateX\(-)/s);
});

test("course detail keeps one canonical course-color accent", () => {
  assert.doesNotMatch(schoolSource, /school-course-plan-mark/);
  assert.doesNotMatch(styles, /\.school-course-plan-mark\s*\{/);
  assert.match(
    styles,
    /\.school-course-plan\s*\{[^}]*border-left:\s*5px solid var\(--course-color,\s*var\(--cyan\)\);/s,
  );
  assert.match(
    styles,
    /\.school-course-plan-header\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\);/s,
  );
});
