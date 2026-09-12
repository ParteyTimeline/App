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
const { streamPreview } = require('./src/youtube-audio');
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
    res.status(400).json({ error: messages[e.code] || 'Registrierung fehlgeschlagen' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!auth.verify(username, password)) {
    return res.status(401).json({ error: 'Nutzername oder Passwort falsch' });
  }
  req.session.user = store.getUser(username).username;
  res.json({ username: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated' });
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
      store.updatePlaylist(playlistId, { status: 'failed', error: 'Keine abspielbaren Songs gefunden' });
      return;
    }
    const patch = { status: 'ready', tracks, note };
    if (!store.getPlaylist(playlistId).nameWasGiven && defaultName) patch.name = defaultName;
    store.updatePlaylist(playlistId, patch);
  } catch (e) {
    store.updatePlaylist(playlistId, { status: 'failed', error: e.message || 'Import fehlgeschlagen' });
  }
}

app.post('/api/playlists', auth.requireAuth, async (req, res) => {
  const { url, name } = req.body || {};
  if (!url || !url.trim()) return res.status(400).json({ error: 'Playlist-Link oder eingefügte Liste fehlt' });

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
      return res.status(400).json({ error: 'Nicht erkannt — Link (Deezer/Spotify/YouTube), Exportify-CSV oder kopierte Spotify-Songliste einfügen' });
    }
    try {
      if (source === 'deezer') sourceKey = 'deezer:' + (await deezer.resolveToPlaylistId(url));
      else if (source === 'spotify') sourceKey = 'spotify:' + spotify.extractPlaylistId(url);
      else if (source === 'youtube') sourceKey = 'youtube:' + youtube.extractPlaylistId(url);
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Link konnte nicht gelesen werden' });
    }
  }

  const existing = store.findPlaylistBySourceKey(sourceKey);
  if (existing && existing.status !== 'failed') {
    return res.status(409).json({ error: `Ist schon in der Bibliothek: „${existing.name}"` });
  }
  if (importsInFlight.has(sourceKey)) {
    return res.status(409).json({ error: 'Wird gerade schon importiert — kurz warten.' });
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

// YouTube clips are streamed on demand; Deezer tracks use fresh signed previews.
app.get('/api/track/:id/preview', auth.requireAuth, async (req, res) => {
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
  if (!room) return res.status(404).json({ error: 'Raum nicht gefunden' });
  const alreadyIn = room.teams.some((t) => t.members.includes(req.session.user));
  // Once the game has started, only people already on a team may "join"
  // again (a reconnect after a closed tab / dead phone) — brand new
  // latecomers are still turned away.
  if (!alreadyIn && room.phase !== 'lobby') {
    return res.status(400).json({ error: 'Das Spiel läuft schon' });
  }
  try {
    rooms.addPlayer(room, req.session.user); // no-op if already a member
  } catch (e) {
    return res.status(400).json({ error: e.code === 'room_full' ? 'Raum ist voll' : 'Beitritt fehlgeschlagen' });
  }
  rooms.broadcast(room);
  res.json({ code: room.code });
});

app.get('/api/rooms/:code', auth.requireAuth, (req, res) => {
  const room = rooms.getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Raum nicht gefunden' });
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
