import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Dashboard KIF deep-view is touch-first, internally scrollable, and does not remount the shell", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../public/modules/dashboard.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(source, /data-project-deep-view="kif"/);
  assert.match(source, /data-service-deep-view=/);
  assert.match(source, /const SERVICE_DEEP_VIEWS = new Map/);
  assert.match(source, /const openKifView/);
  assert.match(source, /← Drift/);
  assert.match(source, /renderDashboard\(dashboardSnapshot\)/);
  assert.match(source, /data-kif-filter/);
  assert.match(source, /maxlength="4000"/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /commitKifMutation\(previousSnapshot/);
  assert.match(source, /const scrollState = preserveScroll \? captureKifScrollState\(\) : null/);
  assert.match(source, /restoreKifScrollState\(scrollState\)/);
  assert.match(source, /renderKif\(\{ preserveScroll: false \}\)/);
  assert.match(source, /resetScroll: true/);
  assert.match(source, /source\.writable === true/);
  assert.doesNotMatch(source, /127\.0\.0\.1:4317|spreadsheets\.googleapis\.com/);
  assert.match(styles, /\.kif-workspace\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/);
  assert.match(styles, /\.kif-check-list\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /\.kif-check-item\s*\{[^}]*min-height:\s*104px/);
  assert.match(styles, /\.kif-item-title strong\s*\{[^}]*font-size:\s*19px/);
  assert.match(styles, /\.service-row-button\s*\{[^}]*min-height:\s*46px/);
  assert.match(styles, /html, body\s*\{[^}]*overflow:\s*hidden/);
});
