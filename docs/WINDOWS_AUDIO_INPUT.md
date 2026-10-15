# Windows default microphone

Spotify's Windows Lyd panel shows the active Windows capture endpoints and the
current Multimedia default microphone. Names and IDs come from Core Audio; no
device-name mapping or local microphone configuration is required.

`scripts/audio-input.ps1` supports `Status`, `Watch` and `Set -DeviceId <id>` under
Windows PowerShell 5.1. Discovery uses `EnumAudioEndpoints(Capture, ACTIVE)` and
`IMMEndpoint.GetDataFlow`. Selection checks the target again immediately before
calling the existing IPolicyConfig mechanism for Console, Multimedia and
Communications, and confirms all three defaults afterward. It does not record
audio, request browser microphone permission, or change mute/volume.

`server/audio-input.mjs` exposes only endpoint ID, display name, availability and
default state. Writes are serialized and reject invalid, unknown or unavailable
targets. One owned PowerShell watcher serves all SSE subscribers. Core Audio
notifications trigger fresh enumeration for default, device and property changes;
unchanged snapshots are not broadcast. Watcher failure publishes unavailable state
and retries after one second while subscribers remain. The watcher is stopped
when the final subscriber disconnects or the server closes.

API:

- `GET /api/audio-input`: current sanitized status, never cached.
- `GET /api/audio-input/stream`: initial status and `audio-input` SSE updates.
- `POST /api/audio-input/default`: `{ "deviceId": "<active capture endpoint>" }`,
  with the same same-origin mutation protection as audio-output.

The microphone buttons follow SSE updates without replacing the Spotify page or
unchanged buttons. Full device names remain available through title and accessible
labels. The existing output toggle, hotkey and audio-output configuration are
independent.

Applications configured to use Windows default input normally follow the switch.
Applications pinned to a particular microphone can keep using it. No individual
application settings are changed.

Automated switching tests inject fakes. The browser regression runs in a separate
Edge profile at exactly 2560 x 720, with the production CSP, and checks touch target
sizes, overflow, SSE updates, focus, failure recovery and module cleanup. Real
hardware verification before acceptance is limited to Status and Watch. Real
microphone selection is reserved for manual preview acceptance.
