#!/usr/bin/env node
// One-off migration: re-checks every track already in the playlist library
// against MusicBrainz's first-release-date and corrects the stored year
// wherever MusicBrainz knows an earlier one (see src/musicbrainz.js for
// why Deezer's own release_date is often wrong — remaster/reissue dates).
//
// Run with the server STOPPED (or right before starting it), so there's no
// risk of the live process's own in-memory copy overwriting this on its
// next unrelated save. From the project root: node scripts/backfill-years.js
const fs = require('fs');
const path = require('path');
const musicbrainz = require('../src/musicbrainz');

const STORE_FILE = path.join(__dirname, '..', 'data', 'store.json');

async function main() {
  const store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  const playlists = Object.values(store.playlists || {});
  const totalTracks = playlists.reduce((s, p) => s + (p.tracks ? p.tracks.length : 0), 0);
  console.log(`${playlists.length} Playlisten, ${totalTracks} Songs — das dauert wegen MusicBrainz' Rate-Limit ca. ${Math.ceil(totalTracks * 1.1 / 60)} Minuten.`);

  let checked = 0;
  let changed = 0;
  for (const playlist of playlists) {
    if (!playlist.tracks) continue;
    for (const track of playlist.tracks) {
      checked++;
      const mbYear = await musicbrainz.getEarliestReleaseYear(track.a, track.t);
      if (mbYear && mbYear < track.y) {
        console.log(`  ${track.a} - ${track.t}: ${track.y} -> ${mbYear}`);
        track.y = mbYear;
        changed++;
      }
      if (checked % 25 === 0) console.log(`... ${checked}/${totalTracks}`);
    }
  }

  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  console.log(`Fertig: ${checked} Songs geprüft, ${changed} Jahr(e) korrigiert.`);
}

main().catch((e) => {
  console.error('Backfill fehlgeschlagen:', e);
  process.exit(1);
});
