import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('playlist', Path(__file__).parents[1] / 'scripts/spotify-playlist.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Client:
    def __init__(self, total=271, empty=False):
        self.total, self.empty, self.offsets = total, empty, []
    def get_playlist_info(self, limit, offset):
        self.offsets.append(offset)
        items = [] if self.empty else [{'itemV2': {'data': {'__typename': 'Track', 'name': f'Song {i}',
            'artists': {'items': [{'profile': {'name': 'Artist'}}]}}}} for i in range(offset, min(offset + limit, self.total))]
        return {'data': {'playlistV2': {'name': 'Test', 'content': {'totalCount': self.total, 'items': items}}}}

class PlaylistTests(unittest.TestCase):
    def test_all_pages(self):
        client = Client()
        result = module.fetch_playlist('test', client)
        self.assertEqual(client.offsets, [0, 100, 200])
        self.assertEqual(len(result['queries']), 271)
        self.assertEqual(result['queries'][-1]['title'], 'Song 270')
        self.assertFalse(result['truncated'])
    def test_incomplete_page_fails(self):
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            module.fetch_playlist('test', Client(empty=True))
    def test_empty_playlist(self):
        self.assertEqual(module.fetch_playlist('test', Client(total=0))['queries'], [])

if __name__ == '__main__':
    unittest.main()
