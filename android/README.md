# Partey Timeline — Nearby (Android)

*English | [Deutsch](README.de.md)*

Android app for playing with nearby friends **without a hosted server**. One phone
("host") starts the existing Node server locally, embedded, and holds the game state
(same as normal web operation); other phones connect to it in two ways:

- **Nearby Connections** (Bluetooth/Wi-Fi Direct): works **without a shared Wi-Fi
  network**, and even if the host only has mobile data — also needs the app on the
  joining devices (Android only).
- **Browser on the same Wi-Fi**: if the host happens to be on Wi-Fi, the app shows an IP
  address and a QR code — any device on the same network (including iPhone/laptop) can
  then join normally via browser, with no app install at all.

The web UI (`public/`) runs unchanged in a WebView — `public/app.js` already builds its
WebSocket URL and fetch paths relative to `location.host`/`location.pathname`, which is
why a plain **TCP byte tunnel** (no HTTP/WS parsing) is enough as a bridge to the host.

## Architecture (short version)

```
Host phone: embedded Node server (nodejs-mobile) on 127.0.0.1:3000
            ↕ TCP
   HostTunnelServer  ←── Mux over Nearby Connections ──→  PeerTunnelClient
   (tunnel/Tunnel.kt)   (two STREAM payloads = one         (tunnel/Tunnel.kt)
                         full-duplex link, see               ↕
                         nearby/NearbyHost.kt)          local port → WebView (peer)
```

`tunnel/MuxProtocol.kt` + `tunnel/Tunnel.kt` are pure Kotlin/JVM with no Android imports
and can be checked with `./gradlew test` (`MuxProtocolTest`, `TunnelIntegrationTest`) —
see below. `nearby/NearbyHost.kt`/`NearbyPeer.kt` are the Android-specific glue to the
Nearby Connections API (two STREAM payloads per connection, one per direction, exactly
like in Google's official `NearbyConnectionsWalkieTalkie` sample).

On the host, `HostForegroundService` (and the embedded Node runtime inside it) runs in
its own `:host` process (`android:process` in `AndroidManifest.xml`), not the app's main
process — nodejs-mobile's embedded Node can't be cleanly restarted within one process, so
this is what lets "stop hosting" (from the app or the notification's action button) end
with an actual `Process.killProcess()`: a real clean slate, rather than the server quietly
staying up for the rest of the app's lifetime. `MainActivity`/`GameWebViewActivity` (main
process) talk to it via `HostIpcContract.kt` (broadcasts for events) and
`ControlTokenProvider.kt` (a `ContentProvider` for the host-control security token) —
same-process object references don't cross a process boundary.

## Setup

1. **Fetch the libnode binaries** (not in Git, ~55 MB, three ABIs):
   ```bash
   ../scripts/fetch-libnode.sh
   ```
2. Open in Android Studio (`android/` as the project). The first Gradle sync
   automatically installs NDK 26.1.10909125 and CMake 3.22.1 if needed.
3. The `:app:syncNodeProject` task copies `server.js`/`src/`/`public/`/`package.json`/
   `node_modules` fresh from the repo root into `app/src/main/assets/nodejs-project/`
   on every build — no manual copying needed, no server code duplication in the
   Android project.
4. Install on **two real Android devices** (Nearby Connections needs real BLE/Wi-Fi
   Direct radios — doesn't work reliably in standard emulators, see below).

## Permissions

Nearby Connections' permission model has changed several times across Android
versions; `nearby/NearbyPermissions.kt` and the manifest mirror Google's own reference
code 1:1 (`android/connectivity-samples`, `NearbyConnectionsWalkieTalkie`):
Bluetooth scan/advertise/connect + `NEARBY_WIFI_DEVICES` from Android 13, location from
Android 12 or older depending on OS version.

## What's reliably tested — and what isn't

- **`tunnel/` verified via unit tests**: `MuxProtocolTest` (framing/edge cases) and
  `TunnelIntegrationTest` (host+peer over a real loopback socket, several parallel
  connections, payload larger than one internal buffer) run as plain JVM tests, no
  Android dependency. Run with `./gradlew test`.
- **The rest of the app (Kotlin/resources/manifest/Gradle setup including NDK/CMake)
  was built via `gradle assembleDebug` in an isolated Docker environment** (Android SDK
  34, NDK 26.1.10909125, real libnode binaries) — compiled and packaged successfully
  into an APK. That verifies the code is compilable, **not** that Nearby Connections,
  the embedded Node server, or the WebView actually work correctly at runtime.
- **No automated device-farm/CI coverage for real-device behavior** (Nearby
  Connections, the embedded Node server, the WebView): no Android emulator with
  hardware acceleration is available in this development environment (no
  `/dev/kvm`), and Nearby Connections needs real Bluetooth/Wi-Fi Direct radios
  anyway, which no emulator reliably reproduces. In practice, the core flows
  (hosting/joining, the Nearby tunnel, host-control, playlist import/export) have
  instead been verified by hand on real devices via `adb` before each release — but
  that's manual testing, not a repeatable automated suite. **Still worth a manual
  playthrough before your first real game night** if you're building your own fork
  (login, room, team, drawing/placing a song, audio — with and without a shared
  Wi-Fi network, see the checklist in the main project context).

## Known limitations

- **No YouTube import/playback on the host phone**: `yt-dlp`/`ffmpeg` are external
  binaries that aren't built in here. Deezer and Spotify playlists work fully
  (including offline cache, see the main README). A `data/store.json` brought along
  with YouTube playlists will import fine, but playback will fail.
- **Peers still need their own internet access for Deezer/Spotify previews** (a 302
  redirect straight to the respective CDN, bypassing the tunnel) — unless the playlist
  was already cached on the host via "download previews"; then everything runs purely
  over the tunnel or the LAN, even with no internet at all.
- **Only the host holds a foreground notification** (`HostForegroundService`) — peers
  only run for the app's own lifetime; if the app is sent to the background on a peer
  device, the connection can drop.
- Many simultaneous peers under load is deliberately not part of this first
  version.

## Reconnecting after a dropped connection

A Nearby link can drop for reasons that have nothing to do with the game — walking a
few meters out of Bluetooth/Wi-Fi Direct range, the OS briefly suspending radios, a
peer's screen locking. Since the actual game state lives server-side behind the host's
session cookie (see `/api/local/join` in `server.js`), a fresh tunnel is functionally
indistinguishable from the old one to the web app, so both sides recover automatically
instead of forcing a manual rejoin from the start screen:

- **Peer side** (`nearby/NearbyPeer.kt`): an unexpected disconnect (not one the app
  itself requested) triggers automatic retries with exponential backoff (1s, 2s, 4s,
  8s, capped, up to 20 attempts — a few minutes total) against the same host, matching
  by endpoint ID first and falling back to matching by display name if the host's own
  ID happened to change. `GameWebViewActivity` shows a "reconnecting…" banner during
  this and reloads the WebView against the new tunnel port once reconnected — the local
  port a `PeerTunnelClient` binds can differ from the one before the drop. If all
  attempts are exhausted, it shows a failure message and returns to the start screen.
- **Host side** (`nearby/NearbyHost.kt`): advertising itself keeps running across peer
  disconnects, so a reconnecting peer just looks like a fresh incoming connection —
  no host-side bookkeeping needed for that. The one thing that does get retried with the
  same backoff is advertising itself failing to (re)start (e.g. a transient GMS/Bluetooth
  error), so the host doesn't silently become invisible to new or reconnecting peers.
