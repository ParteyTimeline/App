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
function reconcileAbandonedJobs(playlistsObj) {
  for (const p of Object.values(playlistsObj || {})) {
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
  return playlistsObj;
}

// users/playlists are Maps, not plain objects, specifically so a lookup by
// an attacker/user-controlled key (a login username, a playlist ID straight
// from a route param) can NEVER resolve to an inherited Object.prototype
// member instead of undefined — `({})['constructor']` returns the Object
// function (truthy, no `.passwordHash`/`.tracks`, breaking every caller
// that assumes "found or undefined"); `new Map().get('constructor')`
// always just returns undefined. This is the same confusion class as
// rooms.js's playerSelections/pools (see auth.isReservedUsername) but at
// the root data store itself, reachable by ANY lookup key, not only ones
// that were validated as a fresh username on the way in.
function loadStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ users: {}, playlists: {} }, null, 2));
    return { users: new Map(), playlists: new Map() };
  }
  const raw = fs.readFileSync(STORE_FILE, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('data/store.json ist beschädigt: ' + e.message);
  }
  reconcileAbandonedJobs(data.playlists);
  return {
    users: new Map(Object.entries(data.users || {})),
    playlists: new Map(Object.entries(data.playlists || {})),
  };
}

const store = loadStore();
let writeQueued = false;

function persist() {
  if (writeQueued) return;
  writeQueued = true;
  setImmediate(() => {
    writeQueued = false;
    const tmp = STORE_FILE + '.tmp';
    const serializable = { users: Object.fromEntries(store.users), playlists: Object.fromEntries(store.playlists) };
    fs.writeFileSync(tmp, JSON.stringify(serializable, null, 2));
    fs.renameSync(tmp, STORE_FILE);
  });
}

module.exports = {
  getUser(username) {
    if (typeof username !== 'string') return undefined;
    return store.users.get(username.toLowerCase());
  },
  createUser(username, passwordHash) {
    const key = username.toLowerCase();
    if (store.users.has(key)) throw Object.assign(new Error('exists'), { code: 'exists' });
    const user = { username, passwordHash, createdAt: Date.now() };
    store.users.set(key, user);
    persist();
    return user;
  },
  listPlaylists() {
    return [...store.playlists.values()];
  },
  getPlaylist(id) {
    return store.playlists.get(id);
  },
  findPlaylistBySourceKey(sourceKey) {
    return [...store.playlists.values()].find((p) => p.sourceKey === sourceKey);
  },
  addPlaylist(playlist) {
    store.playlists.set(playlist.id, playlist);
    persist();
    return playlist;
  },
  updatePlaylist(id, patch) {
    const p = store.playlists.get(id);
    if (!p) return undefined;
    Object.assign(p, patch);
    persist();
    return p;
  },
  removePlaylist(id) {
    store.playlists.delete(id);
    persist();
  },
};
