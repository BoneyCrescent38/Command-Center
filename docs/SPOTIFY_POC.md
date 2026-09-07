# Spotify playback proof-of-concept

This module exists only to decide the playback architecture for the physical Xeneon WebView2 host. It is not the final Spotify interface.

## Local configuration

Register this exact redirect URI in Spotify Developer Dashboard:

`http://127.0.0.1:4337/api/spotify/callback`

Configure `.env.local`, which is ignored by Git:

```dotenv
SPOTIFY_CLIENT_ID=
SPOTIFY_REDIRECT_URI=http://127.0.0.1:4337/api/spotify/callback
```

The integration uses Authorization Code with PKCE and does not use a Client Secret. The refresh token is encrypted with Windows DPAPI for the current user and stored in `.runtime/spotify-tokens.json`. POC events contain no tokens and are written to `.runtime/spotify-poc.jsonl`.

## Required scopes

`streaming user-read-email user-read-private user-read-playback-state user-read-currently-playing user-modify-playback-state`

Spotify Premium is required for Web Playback SDK and player control.

## Physical test

1. Authenticate through `/api/spotify/auth/start`.
2. Open Spotify in the Command Center rail on the physical WebView2 host.
3. Confirm `ready` and a device ID.
4. Press `Aktiver Plan A` after starting any real Spotify playback context.
5. Verify at least 20 to 30 seconds of audio and exercise play, pause, previous, next, seek, and volume.
6. Inspect the on-screen diagnostics and `.runtime/spotify-poc.jsonl` for `initialization_error`, `authentication_error`, `account_error`, `playback_error`, EME, media, and autoplay errors.

If WebView2 cannot initialize EME playback, use the server-side Connect endpoints under `/api/spotify/player/*` to validate Plan B without adding a final UI.
