# Windows host operations

## Preview

```powershell
.\scripts\start-preview.ps1
```

Open `http://127.0.0.1:4337/preview`. It is the real shell in an exact 2560 x 720 content viewport, scaled to the browser.

## Build and diagnostics

```powershell
.\scripts\test-host.ps1
```

The script downloads the pinned SDK when needed, compiles the host, starts hidden diagnostics with `Start-Process -Wait`, and verifies a 2560 x 720 selection.

Verified current result:

- Device: `\\.\DISPLAY5`
- Device ID: `MONITOR\CRXED00`
- Bounds: `0,1440,2560,720`
- Reason: `exact-resolution`

Device metadata remains the first selection strategy; DISPLAY5 is a later fallback.

## Manual physical start and stop

1. Confirm extended desktop and 2560 x 720 on the Xeneon.
2. Run `.\scripts\test-host.ps1`.
3. Run `.\scripts\start-host.ps1`.
4. Confirm the borderless window opens on the target.
5. Stop with `Ctrl+Shift+Q` or `.\scripts\stop.ps1`.

The host starts the loopback server first and records its own PID. If WebView2 or navigation fails, it shows a local retry state.

`stop.ps1` reads only this checkout's PID files. It checks absolute ownership first. The server fallback additionally requires `node.exe` and the exact relative `server/index.mjs` token, so it cannot terminate arbitrary Node processes.

## Autostart

No permanent autostart is installed.

```powershell
# After physical acceptance only
.\scripts\install-autostart.ps1
Get-ScheduledTask -TaskName "Kristian Liverod Command Center"

# Rollback
.\scripts\remove-autostart.ps1
.\scripts\stop.ps1
```

The task points only to this repository's `scripts/start-host.ps1`. Project Dashboard remains independent.