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
  assert.match(css, /\.app-nav-button\.active::before[^}]*left: 4px/s);
  assert.doesNotMatch(css, /\.app-nav-button\.active::before[^}]*left:\s*-/s);
  assert.doesNotMatch(css, /\.app-nav-button\.active::before[^}]*translate(?:X|Y)?\(\s*-/s);
  assert.match(css, /\.services-card \.service-row[^}]*min-height: 46px/s);
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
  assert.match(source, /webView\.KeyDown \+= OnKeyDown/);
  assert.match(source, /eventArgs\.Control && eventArgs\.Shift && eventArgs\.KeyCode == Keys\.Q/);
  assert.match(source, /Environment\.SpecialFolder\.LocalApplicationData/);
  assert.match(source, /"KristianLiverod", "CommandCenter", "WebView2"/);
});

test("stop script remains PowerShell 5.1 compatible without weakening ownership checks", async () => {
  const source = await readFile(new URL("../scripts/stop.ps1", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\?\?/);
  assert.match(source, /absoluteOwnerMatch/);
  assert.match(source, /relativeServerMatch/);
  assert.match(source, /GetFileName\(\$process\.ExecutablePath\)/);
});

test("RFID control uses the shared Windows PowerShell runner", async () => {
  const [adapters, models] = await Promise.all([
    readFile(new URL("../host/CommandCenter.Control/ServiceAdapters.cs", import.meta.url), "utf8"),
    readFile(new URL("../host/CommandCenter.Control/ServiceModels.cs", import.meta.url), "utf8"),
  ]);
  const rfidAdapter = adapters.match(/internal sealed class SkaperverkstedRfidServiceAdapter[\s\S]*?internal sealed class ProjectDashboardServiceAdapter/)[0];
  assert.match(rfidAdapter, /ProcessRunner\.RunPowerShellAsync/);
  assert.doesNotMatch(rfidAdapter, /ResolvePwshExecutable|pwsh\.exe|PowerShell 7/);
  assert.match(models, /WindowsPowerShell", "v1\.0", "powershell\.exe"/);
  assert.match(models, /cliXml \? "-OutputFormat XML "/);
});
