"""Read a public Spotify playlist through SpotAPI; stdout is JSON only."""
import contextlib
import json
import re
import sys


def fetch_playlist(playlist_id, client):
    queries = []
    offset = 0
    total = None
    name = None
    while total is None or offset < total:
        playlist = client.get_playlist_info(limit=100, offset=offset)['data']['playlistV2']
        content = playlist['content']
        count = content['totalCount']
        if not isinstance(count, int) or count < 0 or count > 10000:
            raise ValueError('Invalid playlist size')
        if total is not None and count != total:
            raise ValueError('Playlist changed during import; please retry')
        total = count
        name = playlist.get('name') or name
        items = content['items']
        if not isinstance(items, list) or (not items and offset < total):
            raise ValueError('Incomplete Spotify playlist response')
        if offset + len(items) > total:
            raise ValueError('Invalid Spotify pagination')
        for item in items:
            track = (item.get('itemV2') or {}).get('data') or {}
            if track.get('__typename') != 'Track' or not track.get('name'):
                continue  # Episodes, local files and unavailable entries are not songs.
            artists = [a.get('profile', {}).get('name', '') for a in track.get('artists', {}).get('items', [])]
            if not any(artists):
                continue
            queries.append({'spotifyId': track.get('uri', '').split(':')[-1], 'title': track['name'], 'artist': ', '.join(filter(None, artists))})
        offset += len(items)
    return {'name': name or f'Spotify-Playlist {playlist_id}', 'queries': queries,
            'total': total, 'skipped': total - len(queries), 'truncated': False}


if __name__ == '__main__':
    try:
        playlist_id = sys.argv[1]
        if not re.fullmatch(r'[A-Za-z0-9]{22}', playlist_id):
            raise ValueError('Invalid playlist ID')
        with contextlib.redirect_stdout(sys.stderr):
            from spotapi import PublicPlaylist
            result = fetch_playlist(playlist_id, PublicPlaylist(playlist_id))
        print(json.dumps(result))
    except Exception as exc:
        print(f'Spotify import failed: {exc}', file=sys.stderr)
        sys.exit(1)
