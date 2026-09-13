const { execFile } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const musicbrainz = require('./musicbrainz');
const { sameSong } = require('./song-match');

// SpotAPI reads full public playlists without an API client or user login.
// The embed reader remains a fallback with an explicit truncation warning.
const EMBED_TRACK_LIMIT = 100; // the embed payload only ships the first page

function extractPlaylistId(url) {
  const m = String(url).match(/playlist[/:]([a-zA-Z0-9]{15,25})/);
  if (!m) throw new Error('Das ist kein Spotify-Playlist-Link');
  return m[1];
}

function cleanTitle(raw) {
  return String(raw || '')
    .replace(/\s*-\s*(Radio Edit|Extended( Mix)?|Original Mix|Single( Version)?)\s*$/i, '')
    .trim();
}

async function fetchEmbedTracks(playlistId) {
  const res = await fetch(`https://open.spotify.com/embed/playlist/${playlistId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ParteyTimeline/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('Spotify-Playlist nicht erreichbar (Status ' + res.status + ')');
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Spotify-Seite konnte nicht gelesen werden (privat oder Format geändert?)');
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    throw new Error('Spotify-Antwort war kein gültiges JSON');
  }
  const entity = data && data.props && data.props.pageProps && data.props.pageProps.state && data.props.pageProps.state.data && data.props.pageProps.state.data.entity;
  if (!entity || !Array.isArray(entity.trackList)) {
    throw new Error('Playlist ist privat oder leer');
  }
  return {
    name: entity.name || `Spotify-Playlist ${playlistId}`,
    truncated: entity.trackList.length >= EMBED_TRACK_LIMIT,
    queries: entity.trackList
      .filter((t) => t.title)
      .map((t) => ({ spotifyId: extractTrackIdsFromText(t.uri || '')[0], title: cleanTitle(t.title), artist: t.subtitle || '' })),
  };
}

// --- Full playlist reads, no Python/native deps needed --------------------
// Ported from spotapi==1.2.8's PublicPlaylist/BaseClient (the same library
// scripts/spotify-playlist.py used to call). spotapi talks to Spotify's own
// internal web-player API via a TLS-fingerprint-spoofing HTTP client
// (curl_cffi, which bundles a compiled curl-impersonate binary — no Android
// build exists, which is why the Android-hosted server could never use the
// full read and silently fell back to the 100-track embed reader below).
// Verified against the live API: plain fetch() with matching headers works
// fine for this persisted-query endpoint without any TLS spoofing, so this
// runs identically in Node everywhere — the Docker server and the Android
// app's embedded nodejs-mobile runtime alike.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PARTNER_API = 'https://api-partner.spotify.com/pathfinder/v1/query';

// Spotify's own client-side TOTP secret (obfuscated in their JS), proving to
// /api/token that the request comes from a real client. This is the same
// hardcoded fallback spotapi itself uses when it can't reach a community
// feed of freshly-rotated secrets — unlike spotapi we don't try that feed at
// all (one less third-party dependency); if Spotify ever rotates this and
// breaks it, this whole path fails closed to the Python/embed fallbacks below.
const TOTP_VERSION = 61;
const TOTP_SECRET_BYTES = [44, 55, 47, 42, 70, 40, 34, 114, 76, 74, 50, 111, 120, 97, 75, 76, 94, 102, 43, 69, 49, 120, 118, 80, 64, 78];

function currentTotp() {
  const transformed = TOTP_SECRET_BYTES.map((b, i) => b ^ ((i % 33) + 9));
  // spotapi base32-encodes this and hands it to pyotp, which base32-decodes
  // it right back before hashing — that round trip is lossless and thus a
  // no-op, so the real HMAC key is just these bytes' ASCII digit string.
  const key = Buffer.from(transformed.join(''), 'ascii');
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(bin % 1e6).padStart(6, '0');
}

function extractSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

function parseCookie(setCookieHeaders, name) {
  for (const header of setCookieHeaders) {
    const m = header.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}

// Module-scoped so the (slow) handshake — session, access token, client
// token, persisted-query hash — is paid once per process and reused/renewed
// across imports, not redone per playlist.
const partnerSession = {
  clientVersion: null, jsBundleUrl: null, cookie: '',
  accessToken: null, accessTokenExpiresAt: 0, clientId: null, clientToken: null,
  hashCache: new Map(),
};

async function partnerFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: { 'User-Agent': CHROME_UA, ...(partnerSession.cookie ? { Cookie: partnerSession.cookie } : {}), ...opts.headers },
    signal: AbortSignal.timeout(15000),
  });
}

async function ensureSession() {
  if (partnerSession.clientVersion && partnerSession.jsBundleUrl) return;
  const res = await partnerFetch('https://open.spotify.com/');
  const spt = parseCookie(extractSetCookies(res), 'sp_t');
  if (spt) partnerSession.cookie = `sp_t=${spt}`;
  const html = await res.text();
  const cfgMatch = html.match(/<script id="appServerConfig" type="text\/plain">([^<]+)<\/script>/);
  if (!cfgMatch) throw new Error('Spotify appServerConfig nicht gefunden (Format geändert?)');
  partnerSession.clientVersion = JSON.parse(Buffer.from(cfgMatch[1], 'base64').toString('utf8')).clientVersion;
  const jsLinks = [...html.matchAll(/https:\/\/[^"']+\.js/g)].map((m) => m[0]);
  partnerSession.jsBundleUrl = jsLinks.find((l) => l.includes('web-player/web-player') && l.endsWith('.js'));
  if (!partnerSession.clientVersion || !partnerSession.jsBundleUrl) throw new Error('Spotify-Seite konnte nicht gelesen werden (Format geändert?)');
}

async function ensureAccessToken() {
  await ensureSession();
  if (partnerSession.accessToken && Date.now() + 30000 < partnerSession.accessTokenExpiresAt) return;
  const totp = currentTotp();
  const params = new URLSearchParams({ reason: 'init', productType: 'web-player', totp, totpVer: String(TOTP_VERSION), totpServer: totp });
  const res = await partnerFetch(`https://open.spotify.com/api/token?${params}`);
  if (!res.ok) throw new Error('Spotify-Token-Anfrage fehlgeschlagen (Status ' + res.status + ')');
  const json = await res.json();
  if (!json.accessToken) throw new Error('Spotify hat keinen Access-Token geliefert');
  partnerSession.accessToken = json.accessToken;
  partnerSession.clientId = json.clientId;
  partnerSession.accessTokenExpiresAt = Number(json.accessTokenExpirationTimestampMs) || 0;
  partnerSession.clientToken = null; // a fresh access token needs a matching fresh client-token
}

async function ensureClientToken() {
  await ensureAccessToken();
  if (partnerSession.clientToken) return;
  const res = await partnerFetch('https://clienttoken.spotify.com/v1/clienttoken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_data: {
        client_version: partnerSession.clientVersion,
        client_id: partnerSession.clientId,
        js_sdk_data: {
          device_brand: 'unknown', device_model: 'unknown', os: 'linux', os_version: '',
          device_id: parseCookie([partnerSession.cookie], 'sp_t') || '', device_type: 'computer',
        },
      },
    }),
  });
  const json = await res.json();
  if (json.response_type !== 'RESPONSE_GRANTED_TOKEN_RESPONSE') throw new Error('Spotify Client-Token abgelehnt');
  partnerSession.clientToken = json.granted_token.token;
}

// The persisted-query hash for an operation is scraped out of the web-player
// JS bundle, same as spotapi does — it's a stable value per Spotify release,
// not a secret, just an implementation detail of their GraphQL setup.
async function partHash(operationName) {
  if (partnerSession.hashCache.has(operationName)) return partnerSession.hashCache.get(operationName);
  await ensureSession();
  const raw = await (await partnerFetch(partnerSession.jsBundleUrl)).text();
  const marker = `"${operationName}","query","`;
  const idx = raw.indexOf(marker);
  if (idx === -1) throw new Error(`Spotify-Query-Hash für "${operationName}" nicht im Haupt-Bundle gefunden`);
  const hash = raw.slice(idx + marker.length).split('"')[0];
  partnerSession.hashCache.set(operationName, hash);
  return hash;
}

async function partnerQuery(operationName, variables, _retried = false) {
  await ensureClientToken();
  const hash = await partHash(operationName);
  const params = new URLSearchParams({
    operationName,
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
  });
  const res = await partnerFetch(`${PARTNER_API}?${params}`, {
    headers: {
      Authorization: 'Bearer ' + partnerSession.accessToken,
      'Client-Token': partnerSession.clientToken,
      'Spotify-App-Version': partnerSession.clientVersion,
      'Content-Type': 'application/json;charset=UTF-8',
    },
  });
  if (res.status === 401 && !_retried) {
    partnerSession.accessToken = null;
    return partnerQuery(operationName, variables, true);
  }
  if (!res.ok) throw new Error(`Spotify-Query "${operationName}" fehlgeschlagen (Status ${res.status})`);
  return res.json();
}

// Mirrors spotapi's PublicPlaylist.paginate_playlist (343 tracks/page) and
// fetch_playlist's filtering: skip episodes/local files and any track with
// no credited artists (can't build a query for those).
async function fetchFullPlaylistNode(playlistId) {
  const PAGE = 343;
  let offset = 0;
  let total = null;
  let name = null;
  const queries = [];
  while (total === null || offset < total) {
    const data = await partnerQuery('fetchPlaylist', { uri: `spotify:playlist:${playlistId}`, offset, limit: PAGE, enableWatchFeedEntrypoint: false });
    const content = data?.data?.playlistV2?.content;
    if (!content || !Number.isInteger(content.totalCount)) throw new Error('Spotify-Playlist-Antwort ungültig');
    if (total !== null && content.totalCount !== total) throw new Error('Playlist hat sich während des Imports geändert; bitte erneut versuchen');
    total = content.totalCount;
    name = data.data.playlistV2.name || name;
    const items = Array.isArray(content.items) ? content.items : [];
    if (!items.length && offset < total) throw new Error('Unvollständige Spotify-Playlist-Antwort');
    for (const item of items) {
      const track = item?.itemV2?.data;
      if (!track || track.__typename !== 'Track' || !track.name) continue;
      const artists = (track.artists?.items || []).map((a) => a.profile?.name).filter(Boolean);
      if (!artists.length) continue;
      queries.push({ spotifyId: (track.uri || '').split(':').pop(), title: track.name, artist: artists.join(', ') });
    }
    offset += items.length;
  }
  return { name: name || `Spotify-Playlist ${playlistId}`, queries, total, skipped: total - queries.length, truncated: false };
}

async function fetchPlaylistTracksViaPython(playlistId) {
  return new Promise((resolve, reject) => {
    execFile('python3', [path.join(__dirname, '..', 'scripts', 'spotify-playlist.py'), playlistId],
      { timeout: 180000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(error);
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      });
  });
}

function finalizePlaylistResult(result) {
  if (!Array.isArray(result.queries) || !Number.isInteger(result.total) ||
      result.total < result.queries.length || !result.queries.every((q) =>
        typeof q.title === 'string' && typeof q.artist === 'string')) {
    throw new Error('Ungültige Spotify-Antwort');
  }
  return { ...result, queries: result.queries.map((q) => ({ ...q, title: cleanTitle(q.title) })) };
}

// Tries the pure-Node full read first (works everywhere, including the
// Android host, which has no Python at all); the Docker deployment then
// falls back to the battle-tested Python/spotapi script if that fails for
// any reason (this call is a no-op failure on Android — no python3 there
// either — so it falls through to the embed reader same as before); the
// embed reader (max 100 tracks) is the last resort either way.
async function fetchPlaylistTracks(playlistId) {
  if (!/^[a-zA-Z0-9]{22}$/.test(playlistId)) throw new Error('Ungültige Spotify-Playlist-ID');
  try {
    return finalizePlaylistResult(await fetchFullPlaylistNode(playlistId));
  } catch (eNode) {
    try {
      return finalizePlaylistResult(await fetchPlaylistTracksViaPython(playlistId));
    } catch (ePython) {
      const fallback = await fetchEmbedTracks(playlistId);
      return { ...fallback, fallback: true };
    }
  }
}

// --- Bulk track-link paste ------------------------------------------------
// Spotify has no "copy as text table" feature — selecting tracks and
// copying only puts track links/URIs on the clipboard, one per line. That's
// still enough: each individual track's public embed page
// (open.spotify.com/embed/track/<id>) exposes title, artist(s) AND release
// date with no login and no 100-item cap, since it's a single-track page.
// This is how a friend without Spotify Premium (who can't create a
// developer app under Spotify's Feb-2026 rules) can still hand over an
// arbitrarily large PERSONAL playlist: select all in Spotify, copy, paste
// the resulting link list into the "add playlist" field.
function extractTrackIdsFromText(text) {
  const ids = new Set();
  const re = /spotify:track:([a-zA-Z0-9]{22})|open\.spotify\.com\/track\/([a-zA-Z0-9]{22})/g;
  let m;
  while ((m = re.exec(String(text || '')))) ids.add(m[1] || m[2]);
  return [...ids];
}

async function fetchTrackEmbedInfo(id) {
  if (!/^[a-zA-Z0-9]{22}$/.test(id)) return null;
  const res = await fetch(`https://open.spotify.com/embed/track/${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ParteyTimeline/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    return null;
  }
  const entity = data && data.props && data.props.pageProps && data.props.pageProps.state && data.props.pageProps.state.data && data.props.pageProps.state.data.entity;
  if (!entity || entity.type !== 'track') return null;
  return {
    spotifyId: id,
    preview: validPreviewUrl(entity.audioPreview?.url),
    releaseDate: entity.releaseDate?.isoString || entity.release_date,
    cover: entity.coverArt?.sources?.[0]?.url || null,
    title: cleanTitle(entity.title || entity.name || ''),
    artist: (entity.artists && entity.artists.map((a) => a.name).join(', ')) || '',
  };
}

// --- Exportify-style CSV ---------------------------------------------------
// exportify.net (an established, actively-maintained third-party tool with
// its own long-registered Spotify app) lets someone log in with their OWN
// free account and export a playlist they own to CSV — no Premium, no app
// of our own needed. We just need to read its columns.
function looksLikeExportifyCsv(text) {
  const head = String(text || '').split(/\r?\n/, 1)[0] || '';
  return /track name/i.test(head) && /artist name/i.test(head);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseExportifyCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV ist leer');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const titleIdx = header.indexOf('track name');
  const uriIdx = header.indexOf('track uri');
  const artistIdx = header.findIndex((h) => h.startsWith('artist name'));
  if (titleIdx === -1 || artistIdx === -1) {
    throw new Error('CSV hat nicht die erwarteten Exportify-Spalten (Track Name / Artist Name(s))');
  }
  return rows.slice(1)
    .filter((r) => r[titleIdx])
    .map((r) => ({ spotifyId: extractTrackIdsFromText(r[uriIdx] || '')[0], title: cleanTitle(r[titleIdx] || ''), artist: (r[artistIdx] || '').split(',')[0].trim() }));
}

function validPreviewUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)scdn\.co$/.test(url.hostname) &&
      url.pathname.startsWith('/mp3-preview/') ? url.href : null;
  } catch (e) { return null; }
}

async function getFreshPreviewUrl(id) {
  const track = await fetchTrackEmbedInfo(id);
  if (!track?.preview) throw new Error('Keine Spotify-Vorschau verfügbar');
  return track.preview;
}

async function searchTracks(query) {
  return new Promise((resolve, reject) => {
    execFile('python3', [path.join(__dirname, '..', 'scripts', 'spotify-search.py'),
      `${query.artist} ${query.title}`], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
    (error, stdout) => {
      if (error) return reject(error);
      try {
        const tracks = JSON.parse(stdout);
        if (!Array.isArray(tracks)) throw new Error('Ungültige Spotify-Suche');
        resolve(tracks.slice(0, 10));
      } catch (e) { reject(e); }
    });
  });
}

async function findSongPreview(query, { search = false } = {}) {
  let candidates;
  if (search) candidates = await searchTracks(query);
  else candidates = query.spotifyId ? [query] : [];
  for (const candidate of candidates) {
    if (!sameSong(query, candidate.title, [candidate.artist])) continue;
    let track;
    try { track = await fetchTrackEmbedInfo(candidate.spotifyId); } catch (e) { continue; }
    if (!track?.preview || !sameSong(query, track.title, [track.artist])) continue;
    let metadata = null;
    try { metadata = await musicbrainz.findRecording(track.artist, track.title); } catch (e) { /* Use catalog date. */ }
    const year = metadata?.y || Number(String(track.releaseDate || '').slice(0, 4));
    if (!Number.isInteger(year) || year <= 1900 || year > new Date().getFullYear()) continue;
    return { id: `spotify:${track.spotifyId}`, t: track.title, a: track.artist,
      y: year, cover: track.cover, ...(metadata?.musicbrainzId ? { musicbrainzId: metadata.musicbrainzId } : {}) };
  }
  return null;
}

module.exports = {
  findSongPreview,
  getFreshPreviewUrl,
  validPreviewUrl,
  extractPlaylistId,
  fetchEmbedTracks,
  fetchPlaylistTracks,
  EMBED_TRACK_LIMIT,
  extractTrackIdsFromText,
  fetchTrackEmbedInfo,
  looksLikeExportifyCsv,
  parseExportifyCsv,
};
