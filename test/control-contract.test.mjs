import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("controller keeps tray, PID ownership, and hidden PowerShell contracts", async () => {
  const [source, launcher, visualBasicLauncher, startup, shortcut, build, stopScript] = await Promise.all([
    readFile(new URL("../host/CommandCenter.Control/Program.cs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-control.cmd", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-control.vbs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-control.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/install-control-shortcut.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/build-control.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/stop.ps1", import.meta.url), "utf8"),
  ]);
  assert.match(source, /NotifyIcon/);
  assert.match(source, /eventArgs\.Cancel = true;\s*HideToTray\(\)/s);
  assert.match(source, /Application\.Exit\(\)/);
  assert.match(source, /GetOwnedPid\("server", "node"\)/);
  assert.match(source, /GetOwnedPid\("host", "CommandCenter\.Host"\)/);
  assert.match(source, /String\.Equals\(process\.ProcessName, expectedProcessName/);
  assert.doesNotMatch(source, /GetProcessesByName\("node"\)/);
  assert.match(source, /GetOwnedPid\("host", "CommandCenter\.Host"\)[\s\S]*Arguments = "\/PID " \+ exactPid \+ " \/T \/F"/);
  assert.match(source, /-NoProfile -ExecutionPolicy Bypass -File/);
  assert.match(source, /control-operation\.lock/);
  assert.match(source, /EventWaitHandle\.OpenExisting\("Local\\\\KristianLiverod\.CommandCenter\.Host\.Stop\." \+ exactPid\)/);
  assert.match(source, /CommandCenter\.Control\.Show/);
  assert.match(source, /Icon\.ExtractAssociatedIcon\(Application\.ExecutablePath\)/);
  assert.match(launcher, /start-control\.vbs/);
  assert.match(visualBasicLauncher, /ExecutionPolicy Bypass/);
  assert.match(visualBasicLauncher, /shell\.Run command, 0, False/);
  assert.match(startup, /control-startup\.log/);
  assert.match(startup, /Windows\.Forms\.MessageBox/);
  assert.match(startup, /if \(\$Tray\)[\s\S]*-ArgumentList "--tray"[\s\S]*else[\s\S]*Start-Process -FilePath \$executable -WorkingDirectory/s);
  assert.doesNotMatch(startup, /-ArgumentList \$arguments/);
  assert.match(shortcut, /command-center-control\.ico/);
  assert.match(shortcut, /System32\\wscript\.exe/);
  assert.match(build, /win32icon:\$icon/);
  assert.doesNotMatch(stopScript, /\?\?/);
});

test("controller autostart is opt-in and full exit does not stop Command Center", async () => {
  const source = await readFile(new URL("../host/CommandCenter.Control/Program.cs", import.meta.url), "utf8");
  assert.match(source, /Start with Windows/);
  assert.match(source, /CheckedChanged \+= OnStartWithWindowsChanged/);
  assert.match(source, /key\.SetValue\(AutoStartValueName/);
  assert.match(source, /key\.DeleteValue\(AutoStartValueName, false\)/);
  assert.match(source, /private void ExitController\(\)[\s\S]*Application\.Exit\(\)/);
  assert.doesNotMatch(source, /private void ExitController\(\)[\s\S]{0,300}ExecuteActionAsync/);
});
