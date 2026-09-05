// No Spotify API credentials are involved. The public embed page
// (open.spotify.com/embed/playlist/<id>) server-renders a __NEXT_DATA__
// JSON blob with the visible track list (title/artist/cover) for anyone,
// logged in or not — the same data a browser shows when you paste a
// playlist link into a chat. We only read that public listing, never any
// account data or protected audio stream. Songs are then matched onto
// Deezer (see deezer.matchExternalTracks) for release year + our own
// preview/cover pipeline.
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
      .map((t) => ({ title: cleanTitle(t.title), artist: t.subtitle || '' })),
  };
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
  const res = await fetch(`https://open.spotify.com/embed/track/${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ParteyTimeline/1.0)' },
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
  const artistIdx = header.findIndex((h) => h.startsWith('artist name'));
  if (titleIdx === -1 || artistIdx === -1) {
    throw new Error('CSV hat nicht die erwarteten Exportify-Spalten (Track Name / Artist Name(s))');
  }
  return rows.slice(1)
    .filter((r) => r[titleIdx])
    .map((r) => ({ title: cleanTitle(r[titleIdx] || ''), artist: (r[artistIdx] || '').split(',')[0].trim() }));
}

module.exports = {
  extractPlaylistId,
  fetchEmbedTracks,
  EMBED_TRACK_LIMIT,
  extractTrackIdsFromText,
  fetchTrackEmbedInfo,
  looksLikeExportifyCsv,
  parseExportifyCsv,
};
