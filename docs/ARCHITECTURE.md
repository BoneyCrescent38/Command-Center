# V0 architecture

`docs/PROJECT_PLAN.md` is governing. V0 is a separate runtime and does not modify or replace Project Dashboard.

## Runtime topology

```text
Touch UI / WebView2
        |
        | same origin, 127.0.0.1:4337
        v
Command Center Node server
        |
        | allowlisted server-side HTTP
        v
Project Dashboard 127.0.0.1:4317
```

The loopback server provides static assets, `/health`, `/version.json`, and four named Dashboard routes. There is no generic proxy.

## Registry and modules

`public/app-registry.js` registers modules implementing `mount` and `unmount`. Dashboard is real; Spotify, Skole, and Gaming are isolated placeholders. Navigation switches immediately inside the shell, and Dashboard failure does not block the other modules.

## Dashboard data flow

The browser calls only:

- `GET /api/dashboard/session`
- `POST /api/dashboard/login`
- `POST /api/dashboard/logout`
- `GET /api/dashboard/data`

Auth and API responses use `Cache-Control: no-store`. Mutations require same-origin metadata. The adapter forwards only the configured Dashboard cookie and never persists or logs PINs, cookies, Google credentials, or runtime data.

`sanitizeDashboardSnapshot` allowlists compact projects, aggregate stats, source state, Codex usage, services, and upstream health. Unknown fields are discarded. Timeouts and failures become safe error states with retry.

## Shared 2560 x 720 UI

Browser, preview, and WebView2 share the same HTML, CSS, registry, and modules. `/preview` frames `/` at an actual 2560 x 720 content viewport and scales it visually. At target size the shell has a fixed rail and header, two dashboard rows, 76 px navigation targets, and no page overflow.

## Windows host

The .NET Framework WinForms host uses pinned WebView2 SDK `1.0.4129.50`. SDK and build output live in ignored `.tools/` and `build/host/`.

Window behavior includes `FormBorderStyle.None`, `ShowInTaskbar = false`, `WS_EX_TOOLWINDOW`, removal of `WS_EX_APPWINDOW`, and `TopMost = false`. Browser chrome, context menus, DevTools, status bar, accelerators, and zoom are disabled.

Monitor order:

1. Configured friendly-name/device-ID tokens.
2. Exact 2560 x 720 resolution.
3. `\\.\DISPLAY5`.
4. Primary display.

Current Windows metadata reports the target as `DISPLAY5`, device ID `MONITOR\CRXED00`, and a generic friendly name. Verified selection therefore uses the exact-resolution fallback at `(0, 1440)`.

## Runtime ownership

Ignored `.runtime/` holds PIDs, logs, and diagnostics. Stop logic checks absolute repository identity first. Its server fallback requires the PID from this checkout's PID file, `node.exe`, and the exact relative `server/index.mjs` command token.

Build, tests, preview, and manual host startup do not install autostart.