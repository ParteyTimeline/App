const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) {
    const initial = { users: {}, playlists: {} };
    fs.writeFileSync(STORE_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const raw = fs.readFileSync(STORE_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('data/store.json ist beschädigt: ' + e.message);
  }
}

const store = loadStore();
let writeQueued = false;

function persist() {
  if (writeQueued) return;
  writeQueued = true;
  setImmediate(() => {
    writeQueued = false;
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, STORE_FILE);
  });
}

module.exports = {
  getUser(username) {
    return store.users[username.toLowerCase()];
  },
  createUser(username, passwordHash) {
    const key = username.toLowerCase();
    if (store.users[key]) throw Object.assign(new Error('exists'), { code: 'exists' });
    store.users[key] = { username, passwordHash, createdAt: Date.now() };
    persist();
    return store.users[key];
  },
  listPlaylists() {
    return Object.values(store.playlists);
  },
  getPlaylist(id) {
    return store.playlists[id];
  },
  findPlaylistBySourceKey(sourceKey) {
    return Object.values(store.playlists).find((p) => p.sourceKey === sourceKey);
  },
  addPlaylist(playlist) {
    store.playlists[playlist.id] = playlist;
    persist();
    return playlist;
  },
  updatePlaylist(id, patch) {
    const p = store.playlists[id];
    if (!p) return undefined;
    Object.assign(p, patch);
    persist();
    return p;
  },
  removePlaylist(id) {
    delete store.playlists[id];
    persist();
  },
};
