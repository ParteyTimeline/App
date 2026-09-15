# Partey Timeline — Server

*English | [Deutsch](README.de.md)*

Self-hosted Hitster/[HitStar](https://github.com/Born2Root/HitStar) clone: no printing, no
QR codes. Players log in with their own account, form teams (2 or more, any number), and
each plays from their own phone — a team shares one timeline, and every team member can
join in on the group's turn/guess.

Playlists come from **Deezer, Spotify, or YouTube** and are saved to the library when
added. During the game they're drawn with **equal weight**: a playlist with 300 songs
doesn't come up more often than one with 15 — contributing more songs gives no advantage.

## How the playlist sources work

- **Deezer**: uses its own preview first. If that's missing, the app checks matching
  alternative Deezer releases, then Spotify previews, and finally YouTube.
- **Spotify**: reads public playlists in full, page by page, via SpotAPI, without a
  Spotify login or a dedicated API client. First it checks the preview of the original
  Spotify ID from the public embed page. Then it follows up with matching Deezer
  releases, further Spotify matches, and finally YouTube with MusicBrainz metadata.
  The import summary counts Spotify, Deezer, and YouTube songs separately.
  Spotify track links and Exportify CSVs also keep any existing Spotify IDs.
  If SpotAPI isn't available, the playlist embed page is used instead; that yields at
  most 100 songs, and the import summary explicitly names the fallback.
  Spotify preview URLs are loaded fresh at playback time; not every track has one.
- **YouTube**: reads up to 300 videos via `yt-dlp`. Title and artist are recognized from
  the video metadata and matched against MusicBrainz. Only unambiguous, matching hits
  with a release year are kept; title, artist, and year come from MusicBrainz.
  The audio comes directly from the original YouTube video, independent of Deezer.
  On first playback, `yt-dlp` and `ffmpeg` generate a 30-second MP3 clip (the first 30
  seconds). This can cause a short loading delay. Up to 32 clips stay in memory; no audio
  files are stored permanently.
  Private, restricted, or removed videos may not be playable despite matching metadata.
  Existing YouTube playlists keep their previous Deezer tracks; to switch to the new
  flow, remove the playlist from the library and re-import it.

Adding playlists can take a while (Deezer throttles very aggressively under too many
parallel requests — the import therefore runs deliberately slowly with retries; roughly
20–80s for ~100 songs).

## Running locally

```bash
npm install
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm start
```

Then runs on `http://localhost:3000`. Without `SESSION_SECRET` the server still starts
(with a warning), but all logins are lost on the next restart. YouTube playlist imports
additionally need a current `yt-dlp[default]` and `ffmpeg` on the `PATH`, and YouTube
audio extraction additionally needs Node.js 22 or newer
([yt-dlp runtime requirements](https://github.com/yt-dlp/yt-dlp/wiki/EJS)); the Docker
image already includes these. For full Spotify playlists, also install
`python3 -m pip install "spotapi==1.2.8" pymongo redis`. These two extra packages fix
missing import dependencies of SpotAPI; no MongoDB or Redis server is actually needed.
Docker already includes these packages. Deezer import and the Spotify embed fallback
work without Python.

## With Docker

```bash
cp .env.example .env
# open .env and set SESSION_SECRET (the command for that is in a comment in the file)
docker compose up -d --build
```

By default the container only binds to `127.0.0.1:4001` (not publicly reachable) —
meant to sit behind a reverse proxy, see below. User and playlist data live in
`./data/store.json` (bind mount, survives container restarts). **Active logins do
not** — sessions only live in the process's memory; after a restart everyone has to log
in again (accounts themselves are preserved).

### Using the published image instead of building

Every `android-v*` release also publishes a matching image to GitHub Container
Registry — pulling `ghcr.io/parteytimeline/app` skips building the `Dockerfile`
yourself:

```bash
docker run -d --name partey-timeline \
  --env-file .env \
  -p 127.0.0.1:4001:3000 \
  -v "$(pwd)/data:/app/data" \
  ghcr.io/parteytimeline/app:latest
```

`:latest` always points at the newest release; pin a specific version instead with
e.g. `ghcr.io/parteytimeline/app:0.5.1` (the tag matches the app's `android-vX.Y.Z`
release, without the `android-v` prefix). With `docker-compose.yml`, replace `build: .`
with `image: ghcr.io/parteytimeline/app:latest` to get the same effect.

## Configuration

All options (see `.env.example` for details and examples):

| Variable | Required? | Purpose |
|---|---|---|
| `SESSION_SECRET` | for permanent operation | Without it, all logins are lost on the next restart |
| `COOKIE_SECURE` | no (default `0`) | Set to `1` as soon as the app runs over HTTPS |
| `PORT` | no (default `3000`) | only relevant without Docker |
| `MUSICBRAINZ_USER_AGENT` | recommended | Identifies the instance to MusicBrainz (see their API etiquette) |
| `ADMIN_PASSWORD_HASH` | for playlist management | bcrypt hash of the admin password that gates renaming/deleting/importing playlists (see `.env.example`); without it, that screen is unavailable. Not needed on the Android app's own host device, which authenticates itself automatically |

## Reverse proxy (optional)

For public domain access, a plain nginx reverse proxy in front of the container is
enough. `deploy/nginx.example.conf` shows an example for running the app under a
subpath of an existing domain (e.g. `https://your-domain.example/partey/`) — the
`Upgrade`/`Connection` headers are not optional there; without them the WebSocket
connection that carries the game state breaks. If the app instead runs on its own
(sub)domain, a simple `location / { proxy_pass ...; }` block with the same headers is
enough.

## Playing offline (pre-downloading previews)

In the playlist library, each playlist has a "📥 download for offline" button — this
downloads all preview clips once and stores them under `data/audio-cache/`. After that,
`/api/track/:id/preview` is served from the local cache instead of redirecting to
Deezer/Spotify or generating live from YouTube — useful on a shaky connection, and a
prerequisite for playing completely offline via the Android app (see below).

## Android app: play with nearby friends, no server at all

The `android/` directory contains an Android app that lets one phone host the server
locally, with other phones connecting **without a shared Wi-Fi network** (Nearby
Connections, works even if the host only has mobile data) — or, if the host happens to
be on Wi-Fi, via a plain browser and QR code (also works for iPhones/laptops, no app
install needed). Details, setup, and known limitations:
[`android/README.md`](android/README.md).

### Tutorial: download, install, and start a game

1. **Download the APK.** Grab `app-release.apk` from the
   [latest release](https://github.com/ParteyTimeline/App/releases/latest) on the
   Android phone that will act as the host, and open the downloaded file.
2. **Allow the install.** Since this isn't a Play Store app, Android will ask you to
   allow installing "unknown apps" the first time — for a general, source-independent
   walkthrough of that step, see How-To Geek's
   [How to Sideload Apps on Android](https://www.howtogeek.com/313433/how-to-sideload-apps-on-android/).
   Confirm the install once that's allowed.
3. **Grant the permissions the app asks for** (Bluetooth, nearby devices, location) —
   these are required by Android's Nearby Connections API itself, not something this
   app collects data through; without them nearby phones can't be discovered.
4. **On the host phone**, open the app and tap through to start hosting. It will show
   either a Nearby Connections screen (for other Android phones to join) or, if you're
   on Wi-Fi, an IP address and QR code (for any device on the same network, including
   iPhones and laptops, to join via browser).
5. **On joining devices**: other Android phones need the same APK installed and can
   then find the host over Nearby Connections; anyone on the same Wi-Fi can instead
   just scan the QR code or open the shown address in a browser — no install needed for
   that path.
6. **Play.** Everyone enters a name, forms teams, and the host starts the round — see
   [`android/README.md`](android/README.md) for the underlying architecture and known
   limitations (e.g. no YouTube playback on the host, peers needing their own internet
   for un-cached Deezer/Spotify previews).

## Known limitations

- Rooms (running games) only live in memory — a server restart ends all running rounds
  (accounts/playlists are preserved).
- SpotAPI uses unofficial Spotify endpoints that can change. The embed fallback yields
  at most 100 songs. Full imports are capped at 10,000 entries.
- YouTube title recognition and MusicBrainz matching don't guarantee a 100% hit rate.
  MusicBrainz queries are rate-limited to roughly one request per second.
- YouTube can block audio requests; `yt-dlp` needs to be kept up to date.
- `npm audit` shows a moderate `qs` DoS advisory (a transitive dependency of `express`);
  there's currently no patched version. Low risk for this app (no complex query strings
  from strangers), but worth keeping an eye on.

## Legal notice

This project is an unofficial, non-commercial fan project, inspired by
[HitStar](https://github.com/Born2Root/HitStar) (itself a fan implementation of the game
mechanics of *Hitster*). It has no connection to, and is not endorsed by, Hitster A/S or
its rights holders.

The app uses Deezer's public API and previews, Spotify's public playlist metadata via
SpotAPI or embed pages, and MusicBrainz metadata. For YouTube, playlist metadata and
audio are retrieved via `yt-dlp`; `ffmpeg` then creates short in-memory game clips from
them. Anyone self-hosting this app is responsible for keeping their own use (private,
non-commercial) in line with each platform's terms of service and the law applicable in
their own jurisdiction.

## License

[MIT](LICENSE)
