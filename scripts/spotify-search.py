"""Return a bounded list of public Spotify track search candidates."""
import contextlib
import json
import sys

try:
    with contextlib.redirect_stdout(sys.stderr):
        from spotapi import Song
        items = Song().query_songs(sys.argv[1], limit=10)['data']['searchV2']['tracksV2']['items']
        tracks = []
        for item in items:
            track = (item.get('item') or {}).get('data') or {}
            if track.get('__typename') != 'Track':
                continue
            tracks.append({'spotifyId': track.get('uri', '').split(':')[-1],
                           'title': track.get('name', ''),
                           'artist': ', '.join(a.get('profile', {}).get('name', '')
                                              for a in track.get('artists', {}).get('items', []))})
    print(json.dumps(tracks))
except Exception as exc:
    print(f'Spotify search failed: {exc}', file=sys.stderr)
    sys.exit(1)
