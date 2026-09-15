const crypto = require('crypto');
const http = require('http');
const path = require('path');

const express = require('express');
const session = require('express-session');

const auth = require('./src/auth');
const store = require('./src/store');
const deezer = require('./src/deezer');
const spotify = require('./src/spotify');
const youtube = require('./src/youtube');
const { streamPreview, createClip } = require('./src/youtube-audio');
const audioCache = require('./src/audio-cache');
const coverCache = require('./src/cover-cache');
const rooms = require('./src/rooms');
const attachWebSocket = require('./src/ws');

function detectSource(url) {
  const u = String(url || '');
  if (/open\.spotify\.com/i.test(u)) return 'spotify';
  if (/youtube\.com|youtu\.be/i.test(u)) return 'youtube';
  if (/deezer\.com|dzcdn|^\d+$/i.test(u.trim())) return 'deezer';
  return null;
}

// A pasted Exportify CSV or a bulk paste of copied Spotify track links both
// land in the same textbox as a normal playlist URL — tell them apart by
// what the pasted blob actually looks like.
function detectPasteKind(text) {
  if (spotify.looksLikeExportifyCsv(text)) return 'exportify-csv';
  const ids = spotify.extractTrackIdsFromText(text);
  if (ids.length > 1) return 'spotify-tracklist';
  return null;
}

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn(
    'WARNUNG: SESSION_SECRET ist nicht gesetzt — alle Logins gehen beim nächsten Neustart verloren. ' +
      'Setze SESSION_SECRET in der Umgebung (siehe README) für den Dauerbetrieb.'
  );
}

const app = express();
app.disable('x-powered-by');
// Needed so secure-cookie sessions work behind a reverse proxy: without
// this, Express sees the proxy's plain-HTTP connection to us and never
// sets the cookie at all, even though the browser only ever sees HTTPS.
app.set('trust proxy', 1);
app.use(express.json());

const sessionParser = session({
  name: 'partey.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 3600 * 1000,
    secure: process.env.COOKIE_SECURE === '1',
  },
});
app.use(sessionParser);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- auth ----------

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  try {
    auth.register(username, password);
    req.session.user = username;
    res.json({ username });
  } catch (e) {
    const messages = {
      invalid_username: 'Nutzername: 3–20 Zeichen, nur Buchstaben/Zahlen/_/-',
      weak_password: 'Passwort braucht mindestens 6 Zeichen',
      exists: 'Nutzername ist schon vergeben',
    };
    const code = messages[e.code] ? e.code : 'register_failed';
    res.status(400).json({ error: messages[e.code] || 'Registrierung fehlgeschlagen', code });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!auth.verify(username, password)) {
    return res.status(401).json({ error: 'Nutzername oder Passwort falsch', code: 'invalid_credentials' });
  }
  req.session.user = store.getUser(username).username;
  res.json({ username: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated', code: 'not_authenticated' });
  res.json({ username: req.session.user });
});

// ---------- playlist library ----------

app.get('/api/playlists', auth.requireAuth, (req, res) => {
  res.json(
    store.listPlaylists().map((p) => ({
      id: p.id,
      name: p.name,
      count: p.tracks.length,
      addedBy: p.addedBy,
      addedAt: p.addedAt,
      status: p.status || 'ready',
      progress: p.progress,
      note: p.note,
      error: p.error,
      errorCode: p.errorCode,
      cacheStatus: p.cacheStatus,
      cacheProgress: p.cacheProgress,
      cacheNote: p.cacheNote,
      cacheNoteParams: p.cacheNoteParams,
    }))
  );
});

// Big imports (a pasted list of a few thousand Spotify track links, say)
// can take 20-90+ minutes end to end because of Deezer's throttling — far
// too long for one HTTP request. So: the route creates a placeholder
// playlist row immediately and returns; the actual work runs in the
// background and updates that same row's status/progress/tracks as it
// goes. The client just polls GET /api/playlists to watch it finish.
const importsInFlight = new Set(); // lockKey strings, to reject a double-tap on the same input

async function runImport(playlistId, { source, url, pasteKind, pasteText }) {
  const setProgress = (done, total) => store.updatePlaylist(playlistId, { progress: { done, total } });
  try {
    let tracks, defaultName, note;

    if (pasteKind === 'exportify-csv') {
      const queries = spotify.parseExportifyCsv(pasteText);
      const match = await deezer.matchExternalTracks(queries, setProgress);
      tracks = match.tracks;
      defaultName = `Spotify-Export (${queries.length} Songs)`;
      note = `${match.matched} von ${match.total} Songs gefunden (${match.spotify} Spotify, ${match.deezer} Deezer, ${match.youtube} YouTube)`;
    } else if (pasteKind === 'spotify-tracklist') {
      const ids = spotify.extractTrackIdsFromText(pasteText);
      const infos = await deezer.mapLimit(ids, 3, 120, (id) => spotify.fetchTrackEmbedInfo(id), (d, t) => setProgress(Math.round(d / 2), t * 2));
      const queries = infos.filter(Boolean);
      const match = await deezer.matchExternalTracks(queries, (d, t) => setProgress(ids.length + d, ids.length * 2));
      tracks = match.tracks;
      defaultName = `Spotify-Auswahl (${ids.length} Songs)`;
      note = `${match.matched} von ${ids.length} eingefügten Songs gefunden (${match.spotify} Spotify, ${match.deezer} Deezer, ${match.youtube} YouTube)`;
    } else if (source === 'deezer') {
      const playlistId = await deezer.resolveToPlaylistId(url);
      const meta = await deezer.fetchPlaylistMeta(playlistId);
      tracks = await deezer.buildPlaylistTracks(playlistId, setProgress);
      defaultName = meta.title;
      if (meta.nb_tracks && tracks.length < meta.nb_tracks) {
        note = `${tracks.length} von ${meta.nb_tracks} Songs abspielbar (Rest ohne passende Vorschau oder Metadaten nach Deezer-, Spotify- und YouTube-Prüfung)`;
      }
    } else if (source === 'spotify') {
      const spotifyId = spotify.extractPlaylistId(url);
      const embed = await spotify.fetchPlaylistTracks(spotifyId);
      const match = await deezer.matchExternalTracks(embed.queries, setProgress);
      tracks = match.tracks;
      defaultName = embed.name;
      note = `${match.matched} von ${embed.total ?? match.total} Songs gefunden (${match.spotify} Spotify, ${match.deezer} Deezer, ${match.youtube} YouTube)${embed.fallback ? ' (vollständiger Spotify-Abruf fehlgeschlagen; Embed-Fallback)' : ''}${embed.truncated ? ' (nur die ersten 100 der Spotify-Playlist wurden gelesen — für mehr: Songs in Spotify markieren, kopieren und hier einfügen, oder als CSV exportieren)' : ''}`;
    } else if (source === 'youtube') {
      const yt = await youtube.fetchPlaylistQueries(url);
      const match = await youtube.matchPlaylistTracks(yt.queries, setProgress);
      tracks = match.tracks;
      defaultName = yt.name;
      note = `${match.matched} von ${match.total} Videos auf MusicBrainz gefunden (Audio von YouTube)${yt.truncated ? ' (nur die ersten 300 der YouTube-Playlist wurden gelesen)' : ''}`;
    }

    if (!tracks || tracks.length === 0) {
      store.updatePlaylist(playlistId, { status: 'failed', error: 'Keine abspielbaren Songs gefunden', errorCode: 'no_playable_songs' });
      return;
    }
    const patch = { status: 'ready', tracks, note };
    if (!store.getPlaylist(playlistId).nameWasGiven && defaultName) patch.name = defaultName;
    store.updatePlaylist(playlistId, patch);
  } catch (e) {
    store.updatePlaylist(playlistId, { status: 'failed', error: e.message || 'Import fehlgeschlagen', errorCode: 'import_failed' });
  }
}

app.post('/api/playlists', auth.requireAuth, async (req, res) => {
  const { url, name } = req.body || {};
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'Playlist-Link oder eingefügte Liste fehlt', code: 'missing_playlist_url' });
  }

  const pasteKind = detectPasteKind(url);
  let source = null;
  let sourceKey = null;

  if (pasteKind === 'exportify-csv') {
    sourceKey = 'paste-csv:' + crypto.createHash('sha1').update(url).digest('hex');
  } else if (pasteKind === 'spotify-tracklist') {
    const ids = spotify.extractTrackIdsFromText(url).sort();
    sourceKey = 'paste-tracks:' + crypto.createHash('sha1').update(ids.join(',')).digest('hex');
  } else {
    source = detectSource(url);
    if (!source) {
      return res.status(400).json({
        error: 'Nicht erkannt — Link (Deezer/Spotify/YouTube), Exportify-CSV oder kopierte Spotify-Songliste einfügen',
        code: 'unrecognized_playlist_format',
      });
    }
    try {
      if (source === 'deezer') sourceKey = 'deezer:' + (await deezer.resolveToPlaylistId(url));
      else if (source === 'spotify') sourceKey = 'spotify:' + spotify.extractPlaylistId(url);
      else if (source === 'youtube') sourceKey = 'youtube:' + youtube.extractPlaylistId(url);
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Link konnte nicht gelesen werden', code: 'playlist_link_failed' });
    }
  }

  const existing = store.findPlaylistBySourceKey(sourceKey);
  if (existing && existing.status !== 'failed') {
    return res.status(409).json({
      error: `Ist schon in der Bibliothek: „${existing.name}"`,
      code: 'already_in_library',
      params: { name: existing.name },
    });
  }
  if (importsInFlight.has(sourceKey)) {
    return res.status(409).json({ error: 'Wird gerade schon importiert — kurz warten.', code: 'already_importing' });
  }

  const playlist = {
    id: existing ? existing.id : crypto.randomUUID(),
    source: source || (pasteKind === 'exportify-csv' ? 'spotify-csv' : 'spotify-paste'),
    sourceKey,
    name: name || 'Wird geladen …',
    nameWasGiven: !!name,
    addedBy: req.session.user,
    addedAt: Date.now(),
    tracks: [],
    status: 'importing',
    progress: { done: 0, total: 0 },
  };
  store.addPlaylist(playlist);
  res.json({ id: playlist.id, status: 'importing' });

  importsInFlight.add(sourceKey);
  runImport(playlist.id, { source, url, pasteKind, pasteText: url }).finally(() => importsInFlight.delete(sourceKey));
});

// Downloads every track's preview audio to data/audio-cache/ up front, so a
// round can be played later with zero internet access (offline Nearby-Play,
// or just resilience against a flaky connection). Reuses the same async
// job + progress pattern as playlist import (see runImport above) — the
// client polls GET /api/playlists to watch it finish.
const prefetchInFlight = new Set(); // playlist ids currently caching

async function fetchUrlBytes(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('Leere Antwort');
  return buf;
}

// Fetches the actual preview audio for a track id, whichever service it
// belongs to (Deezer-native tracks store a bare numeric id; the others are
// prefixed strings already).
async function fetchAudioBytes(id) {
  if (id.startsWith('spotify:')) return fetchUrlBytes(await spotify.getFreshPreviewUrl(id.slice(8)));
  if (id.startsWith('youtube:')) return createClip(id.slice(8), new AbortController().signal);
  return fetchUrlBytes(await deezer.getFreshPreviewUrl(id));
}

// A track's primary source can lose its preview after the fact (previews
// get swapped out, region-locked, or removed) even though it played fine
// when the playlist was first imported. Rather than mark it permanently
// unavailable, search the OTHER services for the same title/artist and use
// whichever one still has a working preview — same idea as the original
// import's matching cascade (src/deezer.js's matchSong), just re-entered
// from whichever source wasn't the track's original one. YouTube needs
// yt-dlp, which the Android host doesn't bundle (see android/README.md);
// createClip just fails fast there, so trying it is a harmless no-op on
// that platform rather than a case that needs special-casing here.
async function findFallbackAudio(t) {
  const query = { title: t.t, artist: t.a };
  const attempts = String(t.id).startsWith('spotify:')
    ? [() => deezer.matchViaSearch(query), () => youtube.findSongPreview(query)]
    : [() => spotify.findSongPreview(query, { search: true }), () => youtube.findSongPreview(query)];
  for (const attempt of attempts) {
    let candidate;
    try { candidate = await attempt(); } catch (e) { continue; }
    if (!candidate) continue;
    try { return await fetchAudioBytes(String(candidate.id)); } catch (e) { /* try the next source */ }
  }
  throw new Error('Keine Vorschau in einer anderen Quelle gefunden');
}

async function runPrefetch(playlistId) {
  const playlist = store.getPlaylist(playlistId);
  if (!playlist) return;
  const missing = playlist.tracks.filter((t) => !audioCache.isCached(t.id));
  store.updatePlaylist(playlistId, { cacheStatus: 'caching', cacheProgress: { done: 0, total: missing.length } });
  let failed = 0;
  await deezer.mapLimit(missing, 2, 250, async (t) => {
    const id = String(t.id);
    try {
      audioCache.cacheFromBuffer(id, await fetchAudioBytes(id));
    } catch (ePrimary) {
      try {
        audioCache.cacheFromBuffer(id, await findFallbackAudio(t));
      } catch (eFallback) {
        failed++;
      }
    }
    // Best-effort and separate from the audio failure count above: a
    // missing cover just falls back to a generated placeholder client-side
    // (see public/app.js's renderCover), it's not a "track unavailable" case.
    if (t.cover && !coverCache.isCached(id)) {
      try { await coverCache.cacheFromUrl(id, t.cover); } catch (e) { /* ignore, falls back client-side */ }
    }
  }, (done, total) => store.updatePlaylist(playlistId, { cacheProgress: { done, total } }));
  store.updatePlaylist(playlistId, {
    cacheStatus: failed === 0 ? 'ready' : failed === missing.length ? 'failed' : 'partial',
    // cacheNote stays as a German fallback for anything reading the API
    // directly; the web/Android UI prefers cacheNoteParams (see i18n.js's
    // cache.partialNote / cache.failedNote) so it can show this in English too.
    cacheNote: failed ? `${missing.length - failed} von ${missing.length} fehlenden Vorschauen zwischengespeichert (${failed} nicht verfügbar)` : undefined,
    cacheNoteParams: failed ? { cached: missing.length - failed, total: missing.length, unavailable: failed } : undefined,
  });
}

app.post('/api/playlists/:id/prefetch', auth.requireAuth, (req, res) => {
  const playlist = store.getPlaylist(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist nicht gefunden', code: 'playlist_not_found' });
  if (playlist.status !== 'ready') return res.status(400).json({ error: 'Playlist ist noch nicht fertig importiert', code: 'playlist_not_ready' });
  if (prefetchInFlight.has(req.params.id)) return res.status(409).json({ error: 'Wird schon heruntergeladen', code: 'already_downloading' });
  prefetchInFlight.add(req.params.id);
  res.json({ status: 'caching' });
  runPrefetch(req.params.id).finally(() => prefetchInFlight.delete(req.params.id));
});

// YouTube clips are streamed on demand; Deezer tracks use fresh signed previews.
// A locally cached copy (see /prefetch above) always wins, since it needs no
// network at all and works after the original signed URL has expired.
app.get('/api/track/:id/preview', auth.requireAuth, async (req, res) => {
  if (audioCache.isCached(req.params.id)) {
    return audioCache.serveCached(req.params.id, req, res);
  }
  if (req.params.id.startsWith('youtube:')) {
    const known = store.listPlaylists().some((p) => p.tracks.some((t) => t.id === req.params.id));
    if (!known) return res.status(404).send('Song nicht gefunden');
    return streamPreview(req.params.id.slice(8), req, res);
  }
  try {
    const url = req.params.id.startsWith('spotify:')
      ? await spotify.getFreshPreviewUrl(req.params.id.slice(8))
      : await deezer.getFreshPreviewUrl(req.params.id);
    res.redirect(302, url);
  } catch (e) {
    res.status(404).send('Keine Vorschau verfügbar');
  }
});

function findTrackCoverUrl(id) {
  for (const p of store.listPlaylists()) {
    // Deezer-native tracks store a bare numeric id (see server.js's other
    // id.startsWith('spotify:'/'youtube:') checks) — req.params.id is
    // always a string, so this needs a loose/string-normalized compare,
    // not ===, to ever match those.
    const t = p.tracks.find((t) => String(t.id) === id);
    if (t) return t.cover || null;
  }
  return null;
}

// The client always points its <img> here (see public/app.js's renderCover)
// rather than at the raw Deezer/Spotify CDN URL directly, so a Nearby
// peer's tunnel — which only proxies requests to this same server, not
// arbitrary internet hosts — has a chance of ever seeing a cover at all.
// A locally cached copy (see /prefetch above) is served inline and needs
// no network; otherwise this redirects to the live CDN URL, which works
// fine for normal online use but not over a Nearby tunnel with no cover
// cached — the client's onerror handler renders a generated placeholder
// either way, so a 404 here (no known cover, e.g. a YouTube-derived track)
// is an expected, harmless outcome, not an error to fix.
app.get('/api/track/:id/cover', auth.requireAuth, (req, res) => {
  if (coverCache.isCached(req.params.id)) {
    return coverCache.serveCached(req.params.id, res);
  }
  const url = findTrackCoverUrl(req.params.id);
  if (!url) return res.status(404).send('Kein Cover verfügbar');
  res.redirect(302, url);
});

// ---------- rooms ----------

app.post('/api/rooms', auth.requireAuth, (req, res) => {
  const { name, target, teamCount, bonusMode, noDuplicateYears, stealIntentTimeoutSec, stealPlaceTimeoutSec, stealTieMode } = req.body || {};
  // No playlists here anymore — everyone who joins picks their own once
  // they're in the lobby (see WS 'selectPlaylists'), so contributions are
  // weighted per player, not per playlist someone happened to add first.
  const room = rooms.createRoom({
    name,
    hostUsername: req.session.user,
    target: parseInt(target, 10) || 8,
    teamCount: parseInt(teamCount, 10) || 3,
    bonusMode: bonusMode === 'typein' ? 'typein' : 'vote',
    noDuplicateYears: !!noDuplicateYears,
    stealIntentTimeoutMs: (parseInt(stealIntentTimeoutSec, 10) || 4) * 1000,
    stealPlaceTimeoutMs: (parseInt(stealPlaceTimeoutSec, 10) || 10) * 1000,
    stealTieMode: stealTieMode === 'void' ? 'void' : 'block',
  });
  res.json({ code: room.code });
});

app.post('/api/rooms/:code/join', auth.requireAuth, (req, res) => {
  const room = rooms.getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Raum nicht gefunden', code: 'room_not_found' });
  const alreadyIn = room.teams.some((t) => t.members.includes(req.session.user));
  // Once the game has started, only people already on a team may "join"
  // again (a reconnect after a closed tab / dead phone) — brand new
  // latecomers are still turned away.
  if (!alreadyIn && room.phase !== 'lobby') {
    return res.status(400).json({ error: 'Das Spiel läuft schon', code: 'game_already_started' });
  }
  try {
    rooms.addPlayer(room, req.session.user); // no-op if already a member
  } catch (e) {
    const code = e.code === 'room_full' ? 'room_full' : 'join_failed';
    return res.status(400).json({ error: e.code === 'room_full' ? 'Raum ist voll' : 'Beitritt fehlgeschlagen', code });
  }
  rooms.broadcast(room);
  res.json({ code: room.code });
});

// ---------- local (no-account) play ----------
//
// For Nearby/LAN play there are no accounts and no room code to type: a
// device just picks a display name and is dropped into whichever room
// this host is currently running (see rooms.mostRecentRoom()). The
// session cookie IS the identity here — once a name is claimed, only
// requests carrying that same cookie can act as it, so a second device
// can't hijack someone else's name, and the original device transparently
// resumes under it (including into a room the host starts *after* this
// one, e.g. the next round) without retyping anything.
app.post('/api/local/join', (req, res) => {
  const room = rooms.mostRecentRoom();

  if (req.session.user) {
    if (!room) return res.json({ username: req.session.user, code: null });
    const already = room.teams.some((t) => t.members.includes(req.session.user));
    if (!already) {
      if (room.phase !== 'lobby') {
        return res.status(400).json({ error: 'Das Spiel läuft schon', code: 'game_already_started' });
      }
      rooms.addPlayer(room, req.session.user);
      rooms.broadcast(room);
    }
    return res.json({ username: req.session.user, code: room.code });
  }

  const name = String((req.body || {}).name || '').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: 'Name fehlt', code: 'name_required' });

  if (room) {
    if (room.teams.some((t) => t.members.includes(name))) {
      return res.status(400).json({ error: 'Name ist schon vergeben', code: 'name_taken' });
    }
    if (room.phase !== 'lobby') {
      return res.status(400).json({ error: 'Das Spiel läuft schon', code: 'game_already_started' });
    }
  }

  req.session.user = name;
  if (room) {
    rooms.addPlayer(room, name);
    rooms.broadcast(room);
  }
  res.json({ username: name, code: room ? room.code : null });
});

app.get('/api/rooms/:code', auth.requireAuth, (req, res) => {
  const room = rooms.getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Raum nicht gefunden', code: 'room_not_found' });
  res.json(rooms.publicState(room, req.session.user));
});

// So a reopened app can find its way back into an in-progress game without
// anyone having to type the room code again.
app.get('/api/my-room', auth.requireAuth, (req, res) => {
  const room = rooms.findRoomForUser(req.session.user);
  res.json({ code: room ? room.code : null });
});

const server = http.createServer(app);
attachWebSocket(server, sessionParser);

server.listen(PORT, () => {
  console.log(`Partey Timeline Server läuft auf http://localhost:${PORT}`);
});
