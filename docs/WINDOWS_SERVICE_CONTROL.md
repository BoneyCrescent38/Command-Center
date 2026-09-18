# Windows Service Control

Command Center Control is the local service HUD for the fixed Windows installation. It reports and controls four explicit service identities without becoming a general process manager.

## Services and policies

| Service | Endpoint | Lifecycle adapter | Startup policy |
| --- | --- | --- | --- |
| Command Center | 127.0.0.1:4337 | Existing CommandCenterRuntime | ControlManaged, initially off |
| Project Dashboard | 127.0.0.1:4317 | Existing Dashboard scripts | ExternallyManaged |
| KIF Production | 127.0.0.1:8000 | Trusted KIF contract | ExternallyManaged |
| KIF Test | 127.0.0.1:8126 | Trusted KIF contract | ManualOnly |
| Skaperverksted RFID | 127.0.0.1:8787 | Trusted `-ManualTest` scripts | ManualOnly |

The global Start Control with Windows setting remains separate from per-service startup policy and defaults to off. Start configured services only starts production services whose policy is ControlManaged and whose local setting is enabled. It cannot start KIF Test.

Project Dashboard and KIF Production keep their existing Scheduled Tasks exactly as installed. Control reports those external policies but never migrates, replaces, or duplicates them. Cloudflared remains an independently managed Windows service and appears as a read-only Dashboard component.

## KIF trust boundary

Command Center never accepts an arbitrary executable or PowerShell path from the UI. The ignored local file .runtime\control\kif-adapter.json may contain only a root path. That root must resolve below the sibling Turn directory and must expose the exact file scripts\command-center-service.ps1.

The default trusted source is Turn\kif-v3.4-bredde-foundation. The adapter returns stable logical service IDs, so a new KIF Test branch or commit does not require a Command Center UI change.

KIF Production lifecycle actions request explicit elevation and validate the existing production Scheduled Task plus the owned Python process identity. Automated tests are status-only for production. KIF Test lifecycle is constrained to the fixed test runtime and port 8126.

Skaperverksted RFID uses the same built-in Windows PowerShell 5.1 `ProcessRunner` as Dashboard and KIF. Its adapter always passes `-ManualTest`; health remains fail-closed on the script's verified process, executable, launch mode, listener PID and fixed `127.0.0.1:8787` evidence. It never invokes the RFID production Scheduled Task or requests elevation.

RFID lifecycle actions retain the per-service registry lock until the trusted
PowerShell wrapper completes or fails. Restart invokes one trusted Restart script;
its internal Stop/Start steps do not reacquire the registry lock. A background
service can inherit redirected pipe handles, so the shared runner drains both
streams concurrently and allows at most one additional second for EOF after the
wrapper exits. It then detaches its readers, preserving the wrapper exit code and
leaving the service process running. It never waits for service-lifetime pipe EOF
or kills service descendants to finish an action. Wrapper execution timeouts are
still enforced separately.

The RFID card stays busy across health refreshes until the action's `finally`
clears its pending state. A healthy listener alone cannot unlock its buttons.
Policy regressions cover inherited pipes, CLIXML, wrapper failure/timeout,
same-service action exclusion, and RFID pending-state refreshes without operating
real services.

## Runtime files

Control-owned state is bounded to .runtime\control:

- service-autostart.json stores only allowed ControlManaged service settings.
- service-control.log records bounded status/action diagnostics without credentials.
- kif-adapter.json optionally selects the trusted KIF adapter root.

Spotify tokens and Dashboard credentials remain in their existing encrypted or ignored stores and are not copied into the controller.

## Daily use

Launch Command Center Control from the existing desktop shortcut. Closing the window hides it to the notification area. The tray menu can reopen Control, start configured services, or exit only the controller.

A normal Command Center Restart preserves a healthy Spotify Edge engine, then restarts only the Command Center server and Xeneon host. Project Dashboard and both KIF environments have independent card actions and are never implicitly restarted by that operation.

## Release verification

Run scripts\test-service-control.ps1 for policy and KIF identity tests, then scripts\test-control.ps1 for the existing controller behavior. Do not pass ExerciseRuntime while production services are live. KIF Production lifecycle must never be part of unattended verification.
