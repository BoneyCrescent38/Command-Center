# Kristian Liverød Command Center

V0 is a touch-first modular command shell for the 2560 x 720 Corsair Xeneon Edge. It runs alongside Project Dashboard through a narrow, sanitized server-side adapter. The existing Dashboard PWA and `dashboard.liverod.app` remain independent.

## Current V0

- Fixed touch rail with Project Dashboard, Spotify, Skole, and Gaming.
- Real Dashboard module with login, session, live snapshot, retry, and offline states.
- Registry-driven placeholders for the other three apps.
- One UI shared by the direct shell, exact-size preview, and native Windows host.
- Borderless WebView2 host with deterministic monitor diagnostics.
- Reversible autostart scripts that are prepared but not installed.

## Requirements and preview

Windows 10/11 with the built-in Windows PowerShell 5.1, Node.js 20+, and Microsoft Edge WebView2 Runtime. There are no npm runtime dependencies and Command Center does not require a separate PowerShell 7 installation.

```powershell
.\scripts\start-preview.ps1
```

Open `http://127.0.0.1:4337` for the direct shell or `http://127.0.0.1:4337/preview` for the same UI in an actual 2560 x 720 content viewport.

## Project Dashboard connection

The server calls `http://127.0.0.1:4317` by default. The browser only calls Command Center on port 4337.

```powershell
$env:PROJECT_DASHBOARD_URL = "http://127.0.0.1:4317"
$env:PROJECT_DASHBOARD_COOKIE_NAME = "dashboard_session"
$env:PROJECT_DASHBOARD_TIMEOUT_MS = "2500"
```

The existing PIN is passed through the allowlisted login route and never stored. Only the configured session cookie is relayed. Do not copy Dashboard `.env.local`, credentials, PINs, or sessions here.

## Native host

```powershell
.\scripts\test-host.ps1
.\scripts\start-host.ps1
.\scripts\stop.ps1
```

The host is borderless, has no browser chrome, does not use TopMost, and is hidden from the normal taskbar and Alt+Tab list. Close it with `Ctrl+Shift+Q` or the stop script.

## Autostart gate

Permanent autostart is deliberately not active.

```powershell
# Only after physical acceptance
.\scripts\install-autostart.ps1

# Reversible
.\scripts\remove-autostart.ps1
```

See [architecture](docs/ARCHITECTURE.md), [Windows host operations](docs/WINDOWS_HOST.md), and the governing [project plan](docs/PROJECT_PLAN.md).
