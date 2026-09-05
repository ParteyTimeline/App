const { execFile } = require('child_process');

function extractPlaylistId(url) {
  const m = String(url).match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : url;
}

function ytdlpFlatPlaylist(url) {
  return new Promise((resolve, reject) => {
    execFile(
      'yt-dlp',
      ['--flat-playlist', '-J', '--no-warnings', '--playlist-end', '300', url],
      { maxBuffer: 1024 * 1024 * 64, timeout: 90000 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') return reject(new Error('yt-dlp ist auf dem Server nicht installiert'));
          // Surface yt-dlp's own reason (e.g. "This channel does not have a
          // videos tab", "Video unavailable") instead of a generic message —
          // it's usually specific enough to explain what's wrong with the link.
          const reasonMatch = String(stderr || '').match(/ERROR:\s*(.+)/);
          const reason = reasonMatch ? reasonMatch[1].trim() : null;
          return reject(new Error(reason ? `YouTube: ${reason}` : 'YouTube-Link konnte nicht gelesen werden'));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error('yt-dlp-Ausgabe konnte nicht gelesen werden'));
        }
      }
    );
  });
}

// Video titles are free text, not structured song data — this is a best-
// effort "Artist - Title" heuristic. Anything that fails to match on
// Deezer afterwards is simply dropped and reported in the import summary.
function cleanVideoTitle(raw) {
  let s = String(raw || '');
  s = s.split('|')[0];
  s = s.replace(/[([]\s*(official\s*)?(music\s*)?(lyric\s*)?(video|audio|visualizer)\s*[)\]]/gi, '');
  s = s.replace(/\b(HD|4K|HQ)\b/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

function splitArtistTitle(cleaned) {
  const m = cleaned.match(/^(.{1,60}?)\s[-–—]\s(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: '', title: cleaned };
}

async function fetchPlaylistQueries(url) {
  const data = await ytdlpFlatPlaylist(url);
  const entries = (data.entries || []).filter((e) => e && e.title);
  if (entries.length === 0) {
    const hasListParam = /[?&]list=/.test(url);
    throw new Error(
      hasListParam
        ? 'Keine Videos in dieser Playlist gefunden (leer oder privat?)'
        : 'Keine Videos gefunden — ist das wirklich ein Playlist-Link? Kanal-Links (z. B. „/c/Name" oder „/@Name") funktionieren nicht, es braucht einen Link mit „…playlist?list=…" oder „…&list=…".'
    );
  }
  return {
    name: data.title || 'YouTube-Playlist',
    truncated: entries.length >= 300,
    queries: entries.map((e) => splitArtistTitle(cleanVideoTitle(e.title))),
  };
}

module.exports = { extractPlaylistId, fetchPlaylistQueries };
