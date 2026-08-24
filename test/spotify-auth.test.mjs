import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createSpotifyClient, SPOTIFY_SCOPES } from "../server/spotify.mjs";

test("Spotify auth uses PKCE, persists protected refresh state, and refreshes without a client secret", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "command-center-spotify-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  let clock = Date.now();
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const body = new URLSearchParams(options.body);
    if (body.get("grant_type") === "authorization_code") {
      return Response.json({ access_token: "access-one", refresh_token: "refresh-one", token_type: "Bearer", expires_in: 3600, scope: SPOTIFY_SCOPES.join(" ") });
    }
    return Response.json({ access_token: "access-two", token_type: "Bearer", expires_in: 3600, scope: SPOTIFY_SCOPES.join(" ") });
  };
  const tokenProtector = {
    protect: (value) => Buffer.from("protected:" + value).toString("base64"),
    unprotect: (value) => Buffer.from(value, "base64").toString("utf8").replace(/^protected:/, ""),
  };
  const config = {
    spotifyClientId: "client-id",
    spotifyRedirectUri: "http://127.0.0.1:4337/api/spotify/callback",
    spotifyTokenFile: path.join(directory, "tokens.json"),
    spotifyPocLogFile: path.join(directory, "events.jsonl"),
  };
  const spotify = createSpotifyClient(config, { fetchImpl, tokenProtector, now: () => clock });

  const authorization = new URL(spotify.createAuthorizationUrl());
  assert.equal(authorization.searchParams.get("client_id"), "client-id");
  assert.equal(authorization.searchParams.get("redirect_uri"), config.spotifyRedirectUri);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorization.searchParams.get("code_challenge"));
  assert.deepEqual(authorization.searchParams.get("scope").split(" "), [...SPOTIFY_SCOPES]);

  await spotify.completeAuthorization({ code: "auth-code", state: authorization.searchParams.get("state") });
  const firstBody = new URLSearchParams(calls[0].options.body);
  assert.equal(firstBody.get("code_verifier")?.length > 40, true);
  assert.equal(firstBody.has("client_secret"), false);
  const stored = await readFile(config.spotifyTokenFile, "utf8");
  assert.equal(stored.includes("access-one"), false);
  assert.equal(stored.includes("refresh-one"), false);
  assert.equal(spotify.status().authenticated, true);

  clock += 3_700_000;
  const refreshed = await spotify.getAccessToken();
  assert.equal(refreshed.accessToken, "access-two");
  const refreshBody = new URLSearchParams(calls[1].options.body);
  assert.equal(refreshBody.get("refresh_token"), "refresh-one");
  assert.equal(refreshBody.has("client_secret"), false);
});
