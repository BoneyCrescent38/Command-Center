import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("RFID is a canonical offline-openable TEST service with ManualTest ownership", async () => {
  const [models, adapter] = await Promise.all([
    readFile(new URL("../host/CommandCenter.Control/ServiceModels.cs", import.meta.url), "utf8"),
    readFile(new URL("../host/CommandCenter.Control/RfidServiceAdapter.cs", import.meta.url), "utf8"),
  ]);

  assert.match(models, /SkaperverkstedRfid\s*=\s*"http:\/\/127\.0\.0\.1:8787\/"/);
  assert.match(models, /Add\(new SkaperverkstedRfidServiceAdapter\(\)\)/);
  assert.match(adapter, /Environment\s*\{\s*get\s*\{\s*return LocalServiceEnvironment\.Test/);
  assert.match(adapter, /OpenUrl\s*\{\s*get\s*\{\s*return ServiceOpenUrls\.SkaperverkstedRfid/);
  assert.match(adapter, /AutoStartPolicy\.ManualOnly/);
  assert.match(adapter, /Start-Skaperverksted\.ps1/);
  assert.match(adapter, /Stop-Skaperverksted\.ps1/);
  assert.match(adapter, /Restart-Skaperverksted\.ps1/);
  assert.match(adapter, /Test-SkaperverkstedHealth\.ps1/);
  assert.match(adapter, /"-ManualTest"/);
  assert.match(adapter, /ManualTestOwnershipVerified/);
  assert.match(adapter, /ListenerProcessId == ProcessId/);
  assert.doesNotMatch(adapter, /ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask/);
});
