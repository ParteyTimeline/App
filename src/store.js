const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// A playlist import/prefetch job (see server.js's runImport/runPrefetch)
// only lives as an in-memory Promise plus a Set entry (importsInFlight/
// prefetchInFlight) — a process restart mid-job loses both, but the
// persisted 'importing'/'caching' status survives in store.json. Without
// this, a restarted server left that row stuck forever: the UI kept
// polling a job nothing is running anymore, and re-submitting the same
// source was permanently rejected as "already_in_library" (only a
// 'failed' status is ever allowed to retry — see /api/playlists' existing
// check). Reconcile any such abandoned job to 'failed' right on load so
// it's both visible as broken and retryable.
function reconcileAbandonedJobs(data) {
  for (const p of Object.values(data.playlists || {})) {
    if (p.status === 'importing') {
      p.status = 'failed';
      p.error = 'Import wurde durch einen Serverneustart unterbrochen';
      p.errorCode = 'import_interrupted';
    }
    if (p.cacheStatus === 'caching') {
      p.cacheStatus = 'failed';
      p.cacheNote = 'Download wurde durch einen Serverneustart unterbrochen';
    }
  }
  return data;
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
    return reconcileAbandonedJobs(JSON.parse(raw));
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
