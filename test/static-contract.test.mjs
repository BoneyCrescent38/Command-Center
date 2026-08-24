import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("target shell keeps exact preview, touch rail, and bounded viewport", async () => {
  const [html, css, previewCss] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/preview.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /app-rail/);
  assert.match(css, /min-height: 76px/);
  assert.match(css, /overflow: hidden/);
  assert.match(previewCss, /width: 2560px/);
  assert.match(previewCss, /height: 720px/);
});

test("Windows host contract is borderless, tool-window based, and diagnostics capable", async () => {
  const source = await readFile(new URL("../host/CommandCenter.Host/Program.cs", import.meta.url), "utf8");
  assert.match(source, /FormBorderStyle\.None/);
  assert.match(source, /WsExToolWindow/);
  assert.match(source, /ShowInTaskbar = false/);
  assert.match(source, /COMMAND_CENTER_DISPLAY_HINT/);
  assert.match(source, /exact-resolution/);
  assert.match(source, /display5-fallback/);
  assert.match(source, /--diagnostics-file/);
});