import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const models = await readFile(new URL("../host/CommandCenter.Control/ServiceModels.cs", import.meta.url), "utf8");
const adapters = await readFile(new URL("../host/CommandCenter.Control/ServiceAdapters.cs", import.meta.url), "utf8");
const previewControl = await readFile(new URL("../scripts/command-center-kif-preview.ps1", import.meta.url), "utf8");

test("KIF preview control uses one canonical environment definition", () => {
  const commandCenterContract = `${models}\n${adapters}\n${previewControl}`;
  assert.doesNotMatch(commandCenterContract, /KIF-Vanskebygger-App-v3/i);
  assert.match(models, /kif-v3\.4-bredde-foundation/);
  assert.match(models, /KIF-Vanskebygger-App/);
  assert.match(models, /kif-server\.pid/);
  assert.match(models, /start_v3_preview\.ps1/);
  assert.match(adapters, /definition\.Root/);
  assert.match(adapters, /definition\.PidPath/);
  assert.match(adapters, /definition\.LauncherPath/);
});

test("KIF preview control fails closed around PID and listener ownership", () => {
  assert.match(previewControl, /Get-NetTCPConnection/);
  assert.match(previewControl, /PidFilePid/);
  assert.match(previewControl, /ExpectedCommandLine/);
  assert.match(previewControl, /ownsProductionPort/);
  assert.match(previewControl, /Refusing to stop a KIF Test process without exact ownership verification/);
  assert.match(previewControl, /process identity changed during stop verification/);
  assert.match(previewControl, /powershell\.exe[\s\S]*-File \$LauncherPath/);
});
