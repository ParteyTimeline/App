'use strict';

// Works whether the app is served at the domain root or reverse-proxied
// under a sub-path (e.g. https://host/partey/) — every request is built
// relative to wherever this page itself was actually loaded from.
const BASE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';

// Set by the Android app on every URL it loads this page at — both the
// host's own view (?local=1&role=host) and a Nearby peer's tunnel view or
// the LAN/QR link handed to another device (?local=1&role=guest). Nothing
// else ever adds this param, so its absence means "real self-hosted/online
// use", which keeps the account system (see auth.* below).
const LOCAL_PARAMS = new URLSearchParams(location.search);
const LOCAL_MODE = LOCAL_PARAMS.has('local');
const LOCAL_ROLE = LOCAL_PARAMS.get('role'); // 'host' | 'guest' | null

let ME = null;
let VIEW = 'loading'; // loading | auth | localName | lobby | room
let PLAYLISTS = [];
let TARGET = 8;
let TEAM_COUNT = 3;
let BONUS_MODE = 'vote'; // 'vote' | 'typein'
let NO_DUPLICATE_YEARS = false;
let STEAL_INTENT_SEC = 4;
let STEAL_PLACE_SEC = 10;
let STEAL_TIE_MODE = 'block'; // 'block' | 'void'
let SHUFFLE_TEAM_ORDER = true;
let AUTH_MODE = 'login'; // login | register
let AUTH_ERROR = '';
let LOBBY_ERROR = '';
let LOBBY_NOTE = '';
let ADDING_PLAYLIST = false;
let IMPORTING_PLAYLIST = false;
let MANAGE_RETURN_VIEW = 'lobby'; // where "back" on the manage-playlists screen goes
let RENAMING_PLAYLIST_ID = null;
let PLAYLIST_ACTION_BUSY = null; // id of a playlist mid delete/clear-cache request, to avoid a double-tap race
let ADMIN_VERIFIED = false; // this tab entered the shared admin password this session
let ADMIN_LOGIN_ERROR = '';

// Only ever returns a real value in the Android app's own host-role WebView
// — see GameWebViewActivity.kt's AndroidLocalBridge.getControlToken(),
// which itself only ever answers with the real secret when ITS OWN
// Activity was constructed with role == "host" (see NodeRuntime.kt's
// controlToken and server.js's admin gate). Deliberately NOT cached in a
// JS variable at page load: a device can go from hosting to joining
// someone else's game without a full process restart, and re-reading the
// native side fresh on every call — rather than trusting a value read
// once — means a stale token from an earlier host session can never leak
// into a later guest session, whatever JS-level state happens to survive.
// The bridge call itself is synchronous and cheap, so there's no reason to
// cache it. Lets the device that's actually hosting manage its own
// playlist library without typing the shared admin password every time,
// while every other viewer — guest, LAN/QR browser, or a normal online
// player — still needs it.
function localControlToken() {
  if (!(LOCAL_MODE && LOCAL_ROLE === 'host')) return null;
  try {
    return (window.AndroidLocalBridge && window.AndroidLocalBridge.getControlToken && window.AndroidLocalBridge.getControlToken()) || null;
  } catch (e) {
    return null;
  }
}

let ROOM_STATE = null;
let WS = null;
let MY_ROOM_PLAYLISTS = new Set(); // this viewer's own picks for the CURRENT room
let myPlaylistsInitialized = false; // seeded once from server state per room-join
let BONUS_TYPEIN_ARTIST = ''; // viewer-local draft, typein bonus mode
let BONUS_TYPEIN_TITLE = '';
let lastCardKeyForUi = null; // resets the two flags above on every new card
let scrolledForKey = null; // avoids re-scrolling on every re-render of the same 'placed' moment

// Once a card is committed, the other teams need to actually SEE the
// neighboring cards to judge whether they disagree with the spot — don't
// make them scroll the rail themselves to find it.
function maybeScrollToLockedGap() {
  if (!ROOM_STATE || !ROOM_STATE.currentCard || ROOM_STATE.phase !== 'placed') return;
  const key = ROOM_STATE.currentCard.id + ':placed';
  if (scrolledForKey === key) return;
  scrolledForKey = key;
  requestAnimationFrame(() => {
    const el = document.getElementById('locked-gap-marker');
    if (el) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  });
}

// Same idea while still drafting: a team can have several people on their
// own phones looking at the same timeline, and whoever isn't the one
// currently tapping gaps should still see where a teammate just pointed —
// not just after it's locked in.
let scrolledForSelectedKey = null;
function maybeScrollToSelectedGap() {
  if (!ROOM_STATE || !ROOM_STATE.currentCard || ROOM_STATE.phase !== 'listening') return;
  if (ROOM_STATE.selectedGap === null || ROOM_STATE.selectedGap === undefined) return;
  if (!ME) return;
  // Other teams don't get to see the draft while it's still being decided —
  // only once it's locked in (phase 'placed', handled by
  // maybeScrollToLockedGap). This one is teammates-only.
  const active = ROOM_STATE.teams[ROOM_STATE.turnIndex];
  if (!active || !active.members.includes(ME.username)) return;
  const key = ROOM_STATE.currentCard.id + ':' + ROOM_STATE.selectedGap;
  if (scrolledForSelectedKey === key) return;
  scrolledForSelectedKey = key;
  requestAnimationFrame(() => {
    const el = document.getElementById('selected-gap-marker');
    if (el) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  });
}
let wsErrorMsg = '';
let currentRoomCode = null;
let lastLoadedCardId = null;
let wsRetryTimer = null;
let countdownTicker = null;

// Steal/bonus-vote windows show a live "Xs" countdown computed from an
// absolute deadline the server sends — needs its own tick to actually
// count down between state broadcasts, which otherwise only arrive when
// someone acts or a window's timeout fires server-side. Patches just the
// number's text node directly instead of calling render() — a full
// innerHTML rebuild every 500ms was resetting scroll position and
// restarting the vinyl-spin CSS animation out from under the user.
function updateCountdownDisplays() {
  if (!ROOM_STATE) return;
  const deadline = ROOM_STATE.stealDeadline || ROOM_STATE.bonusDeadline;
  if (!deadline) return;
  const remain = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  document.querySelectorAll('.countdown-num').forEach((el) => { el.textContent = remain; });
}

function ensureCountdownTicker() {
  const needed = !!(ROOM_STATE && (ROOM_STATE.stealDeadline || ROOM_STATE.bonusDeadline));
  if (needed && !countdownTicker) {
    countdownTicker = setInterval(updateCountdownDisplays, 500);
  } else if (!needed && countdownTicker) {
    clearInterval(countdownTicker);
    countdownTicker = null;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Always points at our own /api/track/:id/cover (see server.js) rather
// than a raw Deezer/Spotify CDN URL directly — a Nearby peer's tunnel only
// proxies requests to this same server, not arbitrary internet hosts, so a
// direct external URL would never load for a peer regardless of caching.
// That endpoint serves a locally cached copy inline when there is one (see
// the "download for offline" prefetch), redirects to the live CDN URL
// otherwise (fine for normal online use), or 404s when there's no known
// cover at all (e.g. a YouTube-derived track) — any of which can also just
// fail to load (dead link, no internet), so either way this renders a
// stand-in on error: the track's own first letter large in the background
// with the year badged over it, sized/positioned by whichever container
// class is passed in (.chip or .flipcard-back).
function coverLetter(title, artist) {
  const s = String(title || artist || '').trim();
  return s ? s[0].toUpperCase() : '?';
}

function renderCoverFallback(letter, year, cls) {
  return `<div class="${cls} cover-fb"><span class="cf-letter">${esc(letter)}</span><span class="cf-year tab">${esc(String(year))}</span></div>`;
}

function renderCover(id, title, artist, year, cls) {
  const letter = coverLetter(title, artist);
  return `<img class="${cls}" src="${esc(BASE)}api/track/${esc(id)}/cover" alt="" data-fallback-letter="${esc(letter)}" data-fallback-year="${esc(String(year))}" onerror="ptCoverFallback(this)">`;
}

// Called from the inline onerror= above when a cover URL 404s/fails to
// load at runtime, online or offline alike. Builds the replacement via
// safe DOM APIs (not outerHTML/innerHTML) since this runs against a live
// node rather than the usual server-string-template render path.
function ptCoverFallback(imgEl) {
  const div = document.createElement('div');
  div.className = `${imgEl.getAttribute('class') || ''} cover-fb`;
  const letterSpan = document.createElement('span');
  letterSpan.className = 'cf-letter';
  letterSpan.textContent = imgEl.dataset.fallbackLetter || '?';
  const yearSpan = document.createElement('span');
  yearSpan.className = 'cf-year tab';
  yearSpan.textContent = imgEl.dataset.fallbackYear || '';
  div.append(letterSpan, yearSpan);
  imgEl.replaceWith(div);
}

async function api(method, path, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  const localToken = localControlToken();
  if (localToken) headers['X-Local-Control-Token'] = localToken;
  const res = await fetch(BASE + path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || t('api.genericError', { status: res.status }));
    if (data && data.code) err.code = data.code;
    if (data && data.params) err.params = data.params;
    throw err;
  }
  return data;
}

// The server sends a stable `code` (+ optional `params`) alongside its
// German fallback `error` text — see server.js's res.status(...).json({error,
// code}) calls. Translate via that code when we recognize it (covers both
// languages); an error the dictionary doesn't know about (or one with no
// code at all) still shows its raw German text rather than nothing.
function apiErrorMessage(e) {
  if (e.code) {
    const key = 'apiErr.' + e.code;
    if ((STRINGS[LANG] && key in STRINGS[LANG]) || key in STRINGS.de) return t(key, e.params);
  }
  return e.message;
}

function getAudio() { return document.getElementById('player'); }

// Tracks whether the designated audio device is currently playing, as seen
// from a device that has no local audio of its own (kept in sync via the
// 'audioState' broadcasts below). Irrelevant when there's no audio host —
// then every device just reads its own <audio> element directly.
let remotePlaying = false;

// Keeps the audio-host device's screen from auto-locking, which on most
// mobile browsers is what actually kills playback (and definitely blocks
// a remotely-requested play() once the screen has gone dark). Doesn't stop
// someone from manually pressing the power button, but that's not the
// common case at a party — screen timeout is.
let wakeLock = null;
async function updateWakeLock() {
  const iAmHost = !!(ROOM_STATE && ME && ROOM_STATE.audioHost === ME.username);
  if (iAmHost && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* e.g. tab not visible right now — retried on visibilitychange */ }
  } else if (!iAmHost && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') updateWakeLock();
});

// If someone has claimed "audio device" (their phone is the one plugged
// into a speaker), only THAT device actually loads/plays the preview —
// everyone else still gets a working Play button, it just asks the host
// device to (un)pause instead of playing anything locally. One clean
// source of sound at the table instead of three phones fighting each
// other. With no audio host claimed at all, everyone plays locally as
// normal — the right mode when players are in different places.
function isMyDeviceTheAudioHost() {
  const host = ROOM_STATE && ROOM_STATE.audioHost;
  return !host || (ME && host === ME.username);
}

// If this device was the audio host and nobody else has since claimed the
// role, re-claim it automatically — covers a full page reload/app restart,
// not just a brief WebSocket reconnect (the server already tolerates those
// on its own with a grace period). Keyed in localStorage per room so it
// survives a reload but never fights a role someone else deliberately took.
let audioHostReclaimSent = false;
function audioHostStorageKey() {
  return ROOM_STATE ? 'partey_audio_host_' + ROOM_STATE.code : null;
}
function maybeReclaimAudioHost() {
  const key = audioHostStorageKey();
  if (!key || !ME) return;
  try {
    if (ROOM_STATE.audioHost === ME.username) {
      localStorage.setItem(key, '1');
      audioHostReclaimSent = false;
    } else if (ROOM_STATE.audioHost) {
      // someone else is host now — don't auto-reclaim over them later
      localStorage.removeItem(key);
    } else if (localStorage.getItem(key) === '1' && !audioHostReclaimSent) {
      audioHostReclaimSent = true;
      send({ type: 'setAudioHost', enable: true });
    }
  } catch (e) { /* localStorage unavailable (private mode etc.) — just skip */ }
}

function togglePlay() {
  const host = ROOM_STATE && ROOM_STATE.audioHost;
  if (host && ME && host !== ME.username) {
    send({ type: 'audioRequest', action: remotePlaying ? 'pause' : 'play' });
    return;
  }
  const a = getAudio();
  if (!a.src) return;
  if (a.error) a.load();
  if (a.paused) a.play().catch(() => {}); else a.pause();
}

function onCardChanged() {
  const card = ROOM_STATE && ROOM_STATE.currentCard;
  const a = getAudio();
  if (!card || !isMyDeviceTheAudioHost()) {
    a.pause();
    a.removeAttribute('src');
    lastLoadedCardId = null;
    return;
  }
  if (card.id !== lastLoadedCardId) {
    lastLoadedCardId = card.id;
    a.pause();
    a.src = BASE + `api/track/${card.id}/preview`;
    a.currentTime = 0;
  }
}

// ---------------- boot ----------------

async function boot() {
  try {
    const me = await api('GET', 'api/me');
    ME = me;
    await loadPlaylists();
    // Closed tab, dead phone, reopened app — if we're still a member of an
    // in-progress room, jump straight back in instead of the empty lobby.
    let resumed = false;
    try {
      const mine = await api('GET', 'api/my-room');
      if (mine && mine.code) { connectRoom(mine.code); resumed = true; }
    } catch (e) { /* no active room — fall through to the lobby */ }
    if (!resumed) {
      VIEW = 'lobby';
      // A guest with no room to resume into (e.g. just came back from a
      // finished game's "back to lobby") waits here for the host to start
      // the next one — see startLocalGuestPoll().
      if (LOCAL_MODE && LOCAL_ROLE === 'guest') startLocalGuestPoll();
    }
  } catch (e) {
    VIEW = LOCAL_MODE ? 'localName' : 'auth';
  }
  render();
}

// ---------------- local (no-account) play ----------------

async function enterLocalName(name) {
  LOBBY_ERROR = '';
  name = (name || '').trim();
  if (!name) return;
  try {
    const res = await api('POST', 'api/local/join', { name });
    ME = { username: res.username };
    await loadPlaylists();
    if (res.code) {
      connectRoom(res.code);
    } else {
      VIEW = 'lobby';
      if (LOCAL_ROLE === 'guest') startLocalGuestPoll();
    }
  } catch (e) {
    LOBBY_ERROR = apiErrorMessage(e);
  }
  render();
}

let localGuestPollTimer = null;

function stopLocalGuestPoll() {
  clearTimeout(localGuestPollTimer);
  localGuestPollTimer = null;
}

// A local guest who isn't currently in a room (never joined one yet, or
// just left a finished game) has no code to type — instead, poll quietly
// for whatever room this host is currently running and hop straight in
// the moment one exists. Stops itself as soon as VIEW leaves 'lobby'.
function startLocalGuestPoll() {
  stopLocalGuestPoll();
  const tick = async () => {
    if (VIEW !== 'lobby') return;
    try {
      const res = await api('POST', 'api/local/join', { name: ME.username });
      if (res.code) { connectRoom(res.code); return; }
    } catch (e) { /* no active room yet, or it's mid-game — keep waiting */ }
    localGuestPollTimer = setTimeout(tick, 2000);
  };
  tick();
}

let playlistPollTimer = null;

async function loadPlaylists() {
  PLAYLISTS = await api('GET', 'api/playlists');
  const anyPending = PLAYLISTS.some((p) => p.status === 'importing' || p.cacheStatus === 'caching');
  clearTimeout(playlistPollTimer);
  if (anyPending) {
    playlistPollTimer = setTimeout(async () => {
      await loadPlaylists();
      render();
    }, 3000);
  }
}

async function prefetchPlaylist(id) {
  try {
    await api('POST', `api/playlists/${id}/prefetch`, {});
    await loadPlaylists();
    render();
  } catch (e) {
    LOBBY_ERROR = apiErrorMessage(e); render();
  }
}

function renderImportButton() {
  return `<button class="btn ghost small" data-action="importplaylist" ${IMPORTING_PLAYLIST ? 'disabled' : ''} style="margin-top:8px;">
    ${IMPORTING_PLAYLIST ? `<span class="spinner"></span> ${t('playlist.importing')}` : t('playlist.import')}
  </button>`;
}

// A dynamically-created <input type="file"> rather than one baked into the
// template: every render() replaces the DOM via innerHTML, which would
// wipe out any in-progress file selection on a template-based input the
// instant state changes (e.g. IMPORTING_PLAYLIST flipping true right after
// the user picks a file).
function triggerPlaylistImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.gz,.tar.gz,application/gzip';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (file) importPlaylist(file);
  };
  input.click();
}

async function importPlaylist(file) {
  IMPORTING_PLAYLIST = true; LOBBY_ERROR = ''; LOBBY_NOTE = ''; render();
  try {
    const buf = await file.arrayBuffer();
    const headers = { 'Content-Type': 'application/gzip' };
    // This is a raw fetch(), not the shared api() helper — needs the same
    // local-control-token attachment api() does, since /api/playlists/import
    // is admin-gated (see server.js's requireAdmin) and the Android host
    // authenticates via this token instead of a password.
    const localToken = localControlToken();
    if (localToken) headers['X-Local-Control-Token'] = localToken;
    const res = await fetch(BASE + 'api/playlists/import', {
      method: 'POST',
      headers,
      body: buf,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || t('api.genericError', { status: res.status }));
      if (data && data.code) err.code = data.code;
      if (data && data.params) err.params = data.params;
      throw err;
    }
    LOBBY_NOTE = t('playlist.importedNote', { name: data.name, tracks: data.tracksImported, audio: data.audioRestored, covers: data.coverRestored });
    await loadPlaylists();
  } catch (e) {
    LOBBY_ERROR = apiErrorMessage(e);
  }
  IMPORTING_PLAYLIST = false;
  render();
}

function showManagePlaylists() {
  MANAGE_RETURN_VIEW = VIEW === 'room' ? 'room' : 'lobby';
  RENAMING_PLAYLIST_ID = null;
  LOBBY_ERROR = ''; LOBBY_NOTE = '';
  // The Android host is already authenticated via its own control token (see
  // localControlToken() above) — everyone else needs the shared admin
  // password, once per tab.
  if (ADMIN_VERIFIED || localControlToken()) {
    VIEW = 'managePlaylists';
  } else {
    ADMIN_LOGIN_ERROR = '';
    VIEW = 'adminLogin';
  }
  render();
}

async function adminLogin(password) {
  ADMIN_LOGIN_ERROR = '';
  try {
    await api('POST', 'api/admin/login', { password });
    ADMIN_VERIFIED = true;
    VIEW = 'managePlaylists';
  } catch (e) {
    ADMIN_LOGIN_ERROR = apiErrorMessage(e);
  }
  render();
}

function renderAdminLogin() {
  return `
  <div class="auth-wrap">
    ${renderHeader()}
    <div class="card">
      <h2>${t('admin.title')}</h2>
      <p class="lead">${t('admin.lead')}</p>
      ${ADMIN_LOGIN_ERROR ? `<div class="error-msg">${esc(ADMIN_LOGIN_ERROR)}</div>` : ''}
      <form data-form="adminlogin">
        <div class="field">
          <input type="password" name="password" placeholder="${esc(t('admin.passwordPlaceholder'))}" autocomplete="current-password" required autofocus>
        </div>
        <button class="btn primary block" type="submit">${t('admin.submit')}</button>
      </form>
      <button class="btn ghost small" data-action="backfrommanage" style="margin-top:10px;">${t('playlist.cancel')}</button>
    </div>
  </div>`;
}

async function renamePlaylist(id, name) {
  if (!name.trim()) return;
  try {
    await api('PATCH', `api/playlists/${id}`, { name: name.trim() });
    RENAMING_PLAYLIST_ID = null;
    await loadPlaylists();
  } catch (e) {
    LOBBY_ERROR = apiErrorMessage(e);
  }
  render();
}

async function clearPlaylistCache(id) {
  if (PLAYLIST_ACTION_BUSY) return;
  PLAYLIST_ACTION_BUSY = id; render();
  try {
    await api('DELETE', `api/playlists/${id}/cache`);
    await loadPlaylists();
  } catch (e) {
    LOBBY_ERROR = apiErrorMessage(e);
  }
  PLAYLIST_ACTION_BUSY = null;
  render();
}

async function deletePlaylist(id, name) {
  if (PLAYLIST_ACTION_BUSY) return;
  if (!confirm(t('playlist.deleteConfirm', { name }))) return;
  PLAYLIST_ACTION_BUSY = id; render();
  try {
    await api('DELETE', `api/playlists/${id}`);
    await loadPlaylists();
  } catch (e) {
    LOBBY_ERROR = apiErrorMessage(e);
  }
  PLAYLIST_ACTION_BUSY = null;
  render();
}

function renderManagePlaylists() {
  const localToken = localControlToken();
  const rows = PLAYLISTS.map((p) => {
    const busy = PLAYLIST_ACTION_BUSY === p.id;
    const nameHtml = RENAMING_PLAYLIST_ID === p.id
      ? `<input type="text" id="renameInput" class="manage-rename-input" value="${esc(p.name)}" autofocus>
         <button class="btn small gold" data-action="saverename" data-id="${esc(p.id)}">${t('playlist.save')}</button>
         <button class="btn small ghost" data-action="cancelrename">${t('playlist.cancel')}</button>`
      : `<span class="pname">${esc(p.name)}</span>
         <button class="btn small ghost" data-action="startrename" data-id="${esc(p.id)}">${t('playlist.rename')}</button>`;
    const hasCache = p.cacheStatus === 'ready' || p.cacheStatus === 'partial';
    return `
    <div class="playlist-row manage-row">
      ${nameHtml}
      <span class="pmeta">${t('playlist.meta', { count: p.count, addedBy: esc(p.addedBy) })}</span>
      ${renderCacheStatus(p)}
      <div class="manage-row-actions">
        <a class="btn ghost small" href="${esc(BASE)}api/playlists/${esc(p.id)}/export${localToken ? '?localToken=' + encodeURIComponent(localToken) : ''}">${t('playlist.export')}</a>
        ${hasCache ? `<button class="btn ghost small" data-action="clearcache" data-id="${esc(p.id)}" ${busy ? 'disabled' : ''}>${t('playlist.clearCache')}</button>` : ''}
        <button class="btn ghost small danger" data-action="deleteplaylist" data-id="${esc(p.id)}" data-name="${esc(p.name)}" ${busy ? 'disabled' : ''}>${t('playlist.delete')}</button>
      </div>
    </div>`;
  }).join('');

  return `
  ${renderHeader()}
  ${LOBBY_ERROR ? `<div class="error-msg">${esc(LOBBY_ERROR)}</div>` : ''}
  ${LOBBY_NOTE ? `<div class="hint-msg" style="margin-bottom:16px;">${esc(LOBBY_NOTE)}</div>` : ''}
  <div class="card">
    <h2>${t('playlist.manageTitle')}</h2>
    <p class="lead">${t('playlist.manageLead')}</p>
    ${renderImportButton()}
    <div class="playlist-list manage-list">${PLAYLISTS.length ? rows : `<p class="hint-msg">${t('playlist.empty')}</p>`}</div>
    <button class="btn ghost" data-action="backfrommanage">${t('playlist.back')}</button>
  </div>`;
}

// ---------------- auth actions ----------------

async function doAuth(mode, username, password) {
  AUTH_ERROR = '';
  try {
    const data = await api('POST', mode === 'login' ? 'api/login' : 'api/register', { username, password });
    ME = data;
    VIEW = 'lobby';
    await loadPlaylists();
  } catch (e) {
    AUTH_ERROR = apiErrorMessage(e);
  }
  render();
}

async function doLogout() {
  stopLocalGuestPoll();
  try { await api('POST', 'api/logout'); } catch (e) {}
  disconnectWs();
  ME = null; VIEW = LOCAL_MODE ? 'localName' : 'auth'; ROOM_STATE = null; currentRoomCode = null;
  render();
}

// ---------------- lobby actions ----------------

async function addPlaylist(url) {
  if (!url.trim()) return;
  ADDING_PLAYLIST = true; LOBBY_ERROR = ''; LOBBY_NOTE = ''; render();
  try {
    await api('POST', 'api/playlists', { url: url.trim() });
    const input = document.getElementById('newPlaylistUrl');
    if (input) input.value = '';
    LOBBY_NOTE = t('lobby.importStarted');
    await loadPlaylists();
  } catch (e) {
    LOBBY_ERROR = apiErrorMessage(e);
  }
  ADDING_PLAYLIST = false;
  render();
}

async function createRoom(name) {
  LOBBY_ERROR = '';
  try {
    const { code } = await api('POST', 'api/rooms', {
      name, target: TARGET, teamCount: TEAM_COUNT, bonusMode: BONUS_MODE, noDuplicateYears: NO_DUPLICATE_YEARS,
      stealIntentTimeoutSec: STEAL_INTENT_SEC, stealPlaceTimeoutSec: STEAL_PLACE_SEC, stealTieMode: STEAL_TIE_MODE,
      shuffleTeamOrder: SHUFFLE_TEAM_ORDER,
    });
    connectRoom(code);
  } catch (e) {
    LOBBY_ERROR = apiErrorMessage(e); render();
  }
}

async function joinRoom(code) {
  LOBBY_ERROR = '';
  code = code.trim().toUpperCase();
  if (!code) return;
  try {
    await api('POST', `api/rooms/${code}/join`, {});
    connectRoom(code);
  } catch (e) {
    LOBBY_ERROR = apiErrorMessage(e); render();
  }
}

function leaveRoom() {
  disconnectWs();
  ROOM_STATE = null; currentRoomCode = null; VIEW = 'lobby';
  loadPlaylists().then(render);
  // The host starting a fresh round next needs its local guests to hop
  // back in without anyone retyping a code — see startLocalGuestPoll().
  if (LOCAL_MODE && LOCAL_ROLE === 'guest') startLocalGuestPoll();
  render();
}

// ---------------- websocket / room ----------------

function connectRoom(code) {
  stopLocalGuestPoll();
  currentRoomCode = code;
  myPlaylistsInitialized = false;
  audioHostReclaimSent = false;
  scrolledForKey = null;
  scrolledForSelectedKey = null;
  clearTimeout(wsRetryTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  WS = new WebSocket(`${proto}://${location.host}${BASE}`);
  WS.onopen = () => WS.send(JSON.stringify({ type: 'subscribe', room: code }));
  WS.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'state') {
      ROOM_STATE = msg.state;
      VIEW = 'room';
      if (!myPlaylistsInitialized) {
        myPlaylistsInitialized = true;
        const mine = (ROOM_STATE.playerSelections && ROOM_STATE.playerSelections[ME.username]) || [];
        MY_ROOM_PLAYLISTS = new Set(mine.map((p) => p.id));
      }
      maybeReclaimAudioHost();
      onCardChanged();
      updateWakeLock();
      ensureCountdownTicker();
      render();
      maybeScrollToLockedGap();
      maybeScrollToSelectedGap();
    } else if (msg.type === 'audioCommand') {
      // I'm the audio host — someone else's Play/Pause tap arrived as a request.
      const a = getAudio();
      if (a.src) { if (msg.action === 'play') a.play().catch(() => {}); else a.pause(); }
    } else if (msg.type === 'audioState') {
      // Relayed from the host device so my Play/Pause icon stays accurate
      // even though the sound isn't coming from my device.
      remotePlaying = !!msg.playing;
      render();
    } else if (msg.type === 'hostStopped') {
      // Local/Nearby only (see server.js's /api/local/host-control) — the
      // host explicitly stopped hosting while I was in their room. Land
      // back on the same "waiting for the host" screen already used
      // between rounds, rather than the plain WS auto-reconnect (which
      // would just resubscribe to the same, now-abandoned room) — the
      // right fallback for a non-Android browser guest (LAN/QR join),
      // which has no native app screen to return to.
      leaveRoom();
      // The Android app's own WebView (host or guest) additionally has an
      // actual start screen to fall back to — see GameWebViewActivity's
      // AndroidLocalBridge — rather than sitting on the web "waiting"
      // screen with no way back to Nearby hosting/joining at all.
      if (window.AndroidLocalBridge && window.AndroidLocalBridge.hostStopped) {
        window.AndroidLocalBridge.hostStopped();
      }
    } else if (msg.type === 'error') {
      const known = ['spot_taken', 'already_challenged', 'no_tokens', 'cannot_challenge_own_turn', 'no_playlists_selected', 'need_more_teams'];
      wsErrorMsg = known.includes(msg.message) ? t('err.' + msg.message) : '';
      if (wsErrorMsg) {
        render();
        setTimeout(() => { wsErrorMsg = ''; render(); }, 4000);
      }
    }
  };
  WS.onclose = () => {
    if (VIEW === 'room' && currentRoomCode) {
      wsRetryTimer = setTimeout(() => connectRoom(currentRoomCode), 1500);
    }
  };
}

function disconnectWs() {
  clearTimeout(wsRetryTimer);
  if (WS) { WS.onclose = null; WS.close(); WS = null; }
}

function send(msg) { if (WS && WS.readyState === 1) WS.send(JSON.stringify(msg)); }

function myTeam(s) { return s.teams.find((t) => t.members.includes(ME.username)); }

function renderAudioControl(s) {
  const host = s.audioHost;
  if (!host) {
    return `<button class="btn small ghost" data-action="claimaudio">${t('audio.claim')}</button>`;
  }
  if (host === ME.username) {
    return `<div class="audio-host-note">${t('audio.playingHere')} <button class="btn small ghost" data-action="releaseaudio">${t('audio.stop')}</button></div>`;
  }
  return `<div class="audio-host-note">${t('audio.playingOn', { host: `<strong>${esc(host)}</strong>` })}</div>`;
}

// ---------------- render ----------------

function render() {
  const app = document.getElementById('app');
  if (VIEW === 'loading') app.innerHTML = '';
  else if (VIEW === 'auth') app.innerHTML = renderAuth();
  else if (VIEW === 'localName') app.innerHTML = renderLocalName();
  else if (VIEW === 'lobby') app.innerHTML = renderLobby();
  else if (VIEW === 'room') app.innerHTML = renderRoom();
  else if (VIEW === 'managePlaylists') app.innerHTML = renderManagePlaylists();
  else if (VIEW === 'adminLogin') app.innerHTML = renderAdminLogin();
  bindEvents();
}

function renderLangSwitch() {
  return SUPPORTED_LANGS.map((l) => `<button class="lang-opt ${l === LANG ? 'active' : ''}" data-action="setlang" data-lang="${l}">${l.toUpperCase()}</button>`).join('');
}

function renderHeader(extra) {
  return `
  <header class="top">
    <div class="brand">
      <div class="mark">PARTEY<span class="hot">TIMELINE</span></div>
      <span class="sub">${t('app.subtitle')}</span>
    </div>
    <div class="lang-switch">${renderLangSwitch()}</div>
    ${ME ? `<div class="who"><span class="name">${esc(ME.username)}</span><button class="btn small ghost" data-action="logout">${t('header.logout')}</button></div>` : ''}
  </header>
  ${extra || ''}`;
}

function renderAuth() {
  return `
  <div class="auth-wrap">
    ${renderHeader()}
    <div class="card">
      <h2>${AUTH_MODE === 'login' ? t('auth.loginTitle') : t('auth.registerTitle')}</h2>
      <p class="lead">${t('auth.lead')}</p>
      <div class="auth-tabs">
        <button class="${AUTH_MODE === 'login' ? 'active' : ''}" data-action="authmode" data-mode="login">${t('auth.tabLogin')}</button>
        <button class="${AUTH_MODE === 'register' ? 'active' : ''}" data-action="authmode" data-mode="register">${t('auth.tabRegister')}</button>
      </div>
      ${AUTH_ERROR ? `<div class="error-msg">${esc(AUTH_ERROR)}</div>` : ''}
      <form data-form="auth">
        <div class="field">
          <label class="field-label">${t('auth.username')}</label>
          <input type="text" name="username" autocomplete="username" required maxlength="20">
        </div>
        <div class="field">
          <label class="field-label">${t('auth.password')}</label>
          <input type="password" name="password" autocomplete="${AUTH_MODE === 'login' ? 'current-password' : 'new-password'}" required minlength="6">
        </div>
        <button class="btn primary block" type="submit">${AUTH_MODE === 'login' ? t('auth.submitLogin') : t('auth.submitRegister')}</button>
      </form>
    </div>
  </div>`;
}

function renderLocalName() {
  return `
  <div class="auth-wrap">
    ${renderHeader()}
    <div class="card">
      <h2>${t('local.title')}</h2>
      <p class="lead">${t(LOCAL_ROLE === 'guest' ? 'local.leadGuest' : 'local.leadHost')}</p>
      ${LOBBY_ERROR ? `<div class="error-msg">${esc(LOBBY_ERROR)}</div>` : ''}
      <form data-form="localname">
        <div class="field">
          <input type="text" name="name" autocomplete="off" required maxlength="20" placeholder="${esc(t('local.namePlaceholder'))}">
        </div>
        <button class="btn primary block" type="submit">${t('local.submit')}</button>
      </form>
    </div>
  </div>`;
}

// Shared between the pre-room lobby (read-only) and the waiting room
// (checkboxes, per-player selection) — `selected` is null for read-only.
function renderPlaylistList(selected) {
  if (!PLAYLISTS.length) return `<p class="hint-msg">${t('playlist.empty')}</p>`;
  return PLAYLISTS.map((p) => {
    if (p.status === 'importing') {
      const pct = (p.progress && p.progress.total) ? Math.min(100, (p.progress.done / p.progress.total) * 100) : 0;
      return `
      <div class="playlist-row importing">
        <span class="spinner"></span>
        <span class="pname">${esc(p.name)}</span>
        <span class="pmeta">${p.progress && p.progress.total ? `${p.progress.done}/${p.progress.total}` : t('playlist.starting')}</span>
        <div class="import-bar"><i style="width:${pct}%"></i></div>
      </div>`;
    }
    if (p.status === 'failed') {
      const reason = p.errorCode && `playlistErr.${p.errorCode}` in STRINGS.de ? t(`playlistErr.${p.errorCode}`) : (p.error || t('playlist.unknownError'));
      return `
      <div class="playlist-row failed">
        <span class="pname">${esc(p.name)}</span>
        <span class="pmeta">${t('playlist.failedPrefix')}${esc(reason)}</span>
      </div>`;
    }
    const cacheHtml = renderCacheStatus(p);
    const metaHtml = t('playlist.meta', { count: p.count, addedBy: esc(p.addedBy) });
    if (selected) {
      return `
      <label class="playlist-row">
        <input type="checkbox" data-action="toggleplaylist" data-id="${esc(p.id)}" ${selected.has(p.id) ? 'checked' : ''}>
        <span class="pname">${esc(p.name)}</span>
        <span class="pmeta">${metaHtml}</span>
        ${cacheHtml}
      </label>`;
    }
    return `
    <div class="playlist-row">
      <span class="pname">${esc(p.name)}</span>
      <span class="pmeta">${metaHtml}</span>
      ${cacheHtml}
    </div>`;
  }).join('');
}

// "Vorschauen herunterladen" — lets a playlist be made available for
// completely offline play (see POST /api/playlists/:id/prefetch), useful
// both for a flaky connection and for the Android Nearby-Play mode where
// peers may have no internet access at all.
function renderCacheStatus(p) {
  if (p.cacheStatus === 'caching') {
    const pct = (p.cacheProgress && p.cacheProgress.total) ? Math.min(100, (p.cacheProgress.done / p.cacheProgress.total) * 100) : 0;
    const progressText = p.cacheProgress ? `${p.cacheProgress.done}/${p.cacheProgress.total}` : '…';
    return `<div class="import-bar" title="${t('cache.downloading', { progress: progressText })}"><i style="width:${pct}%"></i></div>`;
  }
  if (p.cacheStatus === 'ready') {
    return `<span class="pmeta" title="${esc(p.cacheNote || '')}">${t('cache.offlineReady')}</span>`;
  }
  if (p.cacheStatus === 'partial' || p.cacheStatus === 'failed') {
    const note = p.cacheNoteParams ? t('cache.partialNote', p.cacheNoteParams)
      : p.cacheNote || (p.cacheStatus === 'partial' ? t('cache.partialDefault') : t('cache.failedDefault'));
    return `
      <span class="pmeta">📥 ${esc(note)}</span>
      <button class="btn ghost small" data-action="prefetchplaylist" data-id="${esc(p.id)}">${t('cache.retry')}</button>`;
  }
  return `<button class="btn ghost small" data-action="prefetchplaylist" data-id="${esc(p.id)}">${t('cache.download')}</button>`;
}

function renderLobby() {
  // A local guest never creates or types a code — they're just waiting for
  // the host to (re)start a game; startLocalGuestPoll() picks it up the
  // moment one exists.
  if (LOCAL_MODE && LOCAL_ROLE === 'guest') {
    return `
    ${renderHeader()}
    <div class="card" style="text-align:center;">
      <h2>${t('local.waitingTitle')}</h2>
      <p class="lead">${t('local.waitingLead')}</p>
    </div>`;
  }

  const plHtml = renderPlaylistList(null);

  const targets = [6, 8, 10, 12];
  const targetHtml = targets.map((n) => `
    <button class="target-opt ${n === TARGET ? 'active' : ''}" data-action="target" data-t="${n}">${t('lobby.cardsButton', { t: n })}</button>`).join('');

  const teamCounts = [2, 3, 4, 5, 6];
  const teamHtml = teamCounts.map((n) => `
    <button class="target-opt ${n === TEAM_COUNT ? 'active' : ''}" data-action="teamcount" data-t="${n}">${t('lobby.teamsButton', { t: n })}</button>`).join('');

  return `
  ${renderHeader()}
  ${LOBBY_ERROR ? `<div class="error-msg">${esc(LOBBY_ERROR)}</div>` : ''}
  ${LOBBY_NOTE ? `<div class="hint-msg" style="margin-bottom:16px;">${esc(LOBBY_NOTE)}</div>` : ''}
  <div class="lobby-grid">
    <div class="card">
      <h2>${t('lobby.createTitle')}</h2>
      <p class="lead">${t('lobby.createLead')}</p>

      <div class="section-title">${t('lobby.libraryTitle')}</div>
      <div class="playlist-list">${plHtml}</div>

      <div class="add-playlist-row">
        <textarea id="newPlaylistUrl" rows="2" placeholder="${esc(t('lobby.addPlaceholder'))}"></textarea>
        <button class="btn ${ADDING_PLAYLIST ? 'ghost' : 'gold'}" data-action="addplaylist" ${ADDING_PLAYLIST ? 'disabled' : ''}>
          ${ADDING_PLAYLIST ? `<span class="spinner"></span> ${t('playlist.starting')}` : t('lobby.addButton')}
        </button>
      </div>
      <p class="hint-msg">${t('lobby.spotifyHint')}</p>
      <button class="btn ghost small" data-action="showmanageplaylists" style="margin-top:12px;margin-bottom:22px;">${t('playlist.manageLink')}</button>

      <div class="field-label">${t('lobby.teamCountLabel')}</div>
      <div class="target-row">${teamHtml}</div>

      <div class="field-label">${t('lobby.targetLabel')}</div>
      <div class="target-row">${targetHtml}</div>

      <div class="field-label">${t('lobby.bonusLabel')}</div>
      <div class="target-row">
        <button class="target-opt ${BONUS_MODE === 'vote' ? 'active' : ''}" data-action="bonusmode" data-mode="vote">${t('lobby.bonusVote')}</button>
        <button class="target-opt ${BONUS_MODE === 'typein' ? 'active' : ''}" data-action="bonusmode" data-mode="typein">${t('lobby.bonusTypein')}</button>
      </div>
      <p class="hint-msg" style="margin-top:-10px;">${t('lobby.bonusHint')}</p>

      <label class="bonus-check" style="margin:14px 0;">
        <input type="checkbox" data-action="toggledupyears" ${NO_DUPLICATE_YEARS ? 'checked' : ''}>
        ${t('lobby.dupYears')}
      </label>

      <label class="bonus-check" style="margin:14px 0;">
        <input type="checkbox" data-action="toggleshuffleorder" ${SHUFFLE_TEAM_ORDER ? 'checked' : ''}>
        ${t('lobby.shuffleTeamOrder')}
      </label>

      <div class="field-label">${t('lobby.stealIntentLabel')}</div>
      <div class="target-row">
        ${[3, 4, 6, 8].map((s) => `<button class="target-opt ${s === STEAL_INTENT_SEC ? 'active' : ''}" data-action="stealintentsec" data-t="${s}">${s}s</button>`).join('')}
      </div>
      <div class="field-label">${t('lobby.stealPlaceLabel')}</div>
      <div class="target-row">
        ${[5, 10, 15, 20].map((s) => `<button class="target-opt ${s === STEAL_PLACE_SEC ? 'active' : ''}" data-action="stealplacesec" data-t="${s}">${s}s</button>`).join('')}
      </div>
      <div class="field-label">${t('lobby.stealTieLabel')}</div>
      <div class="target-row">
        <button class="target-opt ${STEAL_TIE_MODE === 'block' ? 'active' : ''}" data-action="stealtiemode" data-mode="block">${t('lobby.stealTieBlock')}</button>
        <button class="target-opt ${STEAL_TIE_MODE === 'void' ? 'active' : ''}" data-action="stealtiemode" data-mode="void">${t('lobby.stealTieVoid')}</button>
      </div>

      <form data-form="createroom">
        <div class="field">
          <label class="field-label">${t('lobby.roomNameLabel')}</label>
          <input type="text" name="name" placeholder="${esc(t('lobby.roomNamePlaceholder', { username: ME.username }))}" maxlength="40">
        </div>
        <button class="btn primary block" type="submit">${t('lobby.createButton')}</button>
      </form>
    </div>

    ${LOCAL_MODE ? '' : `
    <div class="card">
      <h2>${t('lobby.joinTitle')}</h2>
      <p class="lead">${t('lobby.joinLead')}</p>
      <form data-form="joinroom">
        <div class="field join-row">
          <input type="text" name="code" placeholder="${t('lobby.codePlaceholder')}" maxlength="4">
          <button class="btn primary" type="submit">${t('lobby.joinButton')}</button>
        </div>
      </form>
    </div>`}
  </div>
  <footer class="credit">${t('lobby.footer')}</footer>`;
}

function renderRoom() {
  const s = ROOM_STATE;
  if (!s) return '<p>Lade Raum …</p>';
  if (s.phase === 'lobby') return renderRoomLobby(s);
  if (s.phase === 'gameover') return renderGameOver(s);
  return renderGamePlay(s);
}

function memberSongCount(s, username) {
  const sel = s.playerSelections[username] || [];
  return sel.reduce((sum, p) => sum + p.count, 0);
}

function renderRoomLobby(s) {
  const isHost = ME.username === s.hostUsername;
  const mine = myTeam(s);
  const teamCards = s.teams.map((team) => `
    <div class="team-card" style="border-color:${team.id === (mine && mine.id) ? team.color : 'var(--line)'}">
      <div class="team-card-head"><span class="dot" style="background:${team.color}"></span>${esc(team.name)}</div>
      <div class="team-members">${team.members.length ? team.members.map((m) => `<span class="member-chip">${esc(m)}${m === s.hostUsername ? ' 👑' : ''} · ${memberSongCount(s, m)} 🎵</span>`).join('') : `<span class="hint-msg">${t('room.noTeamYet')}</span>`}</div>
      ${team.id === (mine && mine.id)
        ? `<span class="hint-msg">${t('room.yourTeam')}</span>`
        : `<button class="btn small ghost" data-action="jointeam" data-team="${team.id}">${t('room.switchHere')}</button>`}
    </div>
  `).join('');

  const nonEmptyTeams = s.teams.filter((t) => t.members.length > 0).length;
  const anySongsSelected = Object.values(s.playerSelections).some((sel) => sel.length > 0);
  const canStart = nonEmptyTeams >= 2 && anySongsSelected;

  const myPicksHtml = renderPlaylistList(MY_ROOM_PLAYLISTS);

  return `
  ${renderHeader()}
  ${LOBBY_ERROR ? `<div class="error-msg">${esc(LOBBY_ERROR)}</div>` : ''}
  ${LOBBY_NOTE ? `<div class="hint-msg" style="margin-bottom:16px;">${esc(LOBBY_NOTE)}</div>` : ''}
  ${wsErrorMsg ? `<div class="error-msg">${esc(wsErrorMsg)}</div>` : ''}
  <div class="card" style="text-align:center;">
    <h2>${t('room.waitingTitle')}</h2>
    <p class="lead" style="margin-left:auto;margin-right:auto;">${t(LOCAL_MODE ? 'room.waitingLeadLocal' : 'room.waitingLead')}</p>
    ${LOCAL_MODE ? '' : `<div class="room-code">${esc(s.code)}</div>`}
    <p class="hint-msg">${t('room.targetInfo', { target: s.target })}</p>
    <div class="team-grid">${teamCards}</div>
    <div style="margin-bottom:18px;">${renderAudioControl(s)}</div>
    ${isHost
      ? `<button class="btn primary" data-action="startgame" ${canStart ? '' : 'disabled'}>${t('room.startGame')}</button>
         ${nonEmptyTeams < 2 ? `<p class="hint-msg">${t('room.needTwoTeams')}</p>` : ''}
         ${nonEmptyTeams >= 2 && !anySongsSelected ? `<p class="hint-msg">${t('room.needPlaylists')}</p>` : ''}`
      : `<p class="waiting-banner">${t('room.waitingForHost', { host: esc(s.hostUsername) })}</p>`}
    <div style="margin-top:18px;"><button class="btn ghost small" data-action="leaveroom">${t('room.leaveRoom')}</button></div>
  </div>

  <div class="card" style="text-align:left;margin-top:18px;">
    <h2>${t('room.yourPlaylistsTitle')}</h2>
    <p class="lead">${t('room.yourPlaylistsLead')}</p>
    <div class="playlist-list">${myPicksHtml}</div>
    <div class="add-playlist-row">
      <textarea id="newPlaylistUrl" rows="2" placeholder="${esc(t('room.addPlaylistPlaceholder'))}"></textarea>
      <button class="btn ${ADDING_PLAYLIST ? 'ghost' : 'gold'}" data-action="addplaylist" ${ADDING_PLAYLIST ? 'disabled' : ''}>
        ${ADDING_PLAYLIST ? `<span class="spinner"></span> ${t('playlist.starting')}` : t('lobby.addButton')}
      </button>
    </div>
    ${LOCAL_MODE && LOCAL_ROLE === 'guest' ? '' : `<button class="btn ghost small" data-action="showmanageplaylists">${t('playlist.manageLink')}</button>`}
  </div>`;
}

function renderGamePlay(s) {
  const active = s.teams[s.turnIndex];
  const mine = myTeam(s);
  const isMyTurn = !!(mine && mine.id === active.id);
  const rightInfo = `<div class="who"><span class="name tab">${t('game.deckRemaining', { n: s.deckRemaining })}</span></div>`;

  if (s.currentCard && s.currentCard.id !== lastCardKeyForUi) {
    lastCardKeyForUi = s.currentCard.id;
    BONUS_TYPEIN_ARTIST = '';
    BONUS_TYPEIN_TITLE = '';
  }

  const errorHtml = wsErrorMsg ? `<div class="error-msg">${esc(wsErrorMsg)}</div>` : '';

  let stageHtml = '';
  if (s.phase === 'ready') {
    stageHtml = `
      <div class="flipcard"><div class="flipcard-inner">
        <div class="flipcard-face flipcard-front"><div class="q vinylspin">?</div></div>
        <div class="flipcard-face flipcard-back"></div>
      </div></div>
      ${isMyTurn
        ? `<button class="btn primary" data-action="draw">${t('game.draw')}</button>`
        : `<p class="waiting-banner">${t('game.othersDrawing', { name: esc(active.name) })}</p>`}
    `;
  } else {
    const c = s.currentCard;
    const revealed = s.phase === 'revealed';
    const placed = s.phase === 'placed';
    const iAmHostDevice = isMyDeviceTheAudioHost();
    const a = getAudio();
    const isPlaying = iAmHostDevice ? !!(a && a.src && !a.paused && !a.ended) : remotePlaying;
    const pct = (iAmHostDevice && a && a.duration) ? Math.min(100, (a.currentTime / a.duration) * 100) : 0;
    const secsLeft = (deadline) => deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0;

    // Bonus, before commit: vote mode = a claim checkbox; typein mode = the
    // actual guess, fuzzy-matched automatically at reveal — no waiting on
    // anyone, works for remote play.
    let bonusInputHtml = '';
    if (s.phase === 'listening' && isMyTurn) {
      if (s.bonusMode === 'typein') {
        bonusInputHtml = `
          <div class="bonus-typein">
            <input type="text" placeholder="${t('game.artistPlaceholder')}" data-action="bonusartist" value="${esc(BONUS_TYPEIN_ARTIST)}">
            <input type="text" placeholder="${t('game.titlePlaceholder')}" data-action="bonustitle" value="${esc(BONUS_TYPEIN_TITLE)}">
            <span class="hint-msg">${t('game.typeinHint')}</span>
          </div>`;
      } else {
        bonusInputHtml = `<label class="bonus-check">
           <input type="checkbox" data-action="togglebonus" ${s.bonusClaimed ? 'checked' : ''}>
           ${t('game.bonusCheck')}
         </label>`;
      }
    }

    // Steal window (phase 'placed'): first a short "who wants to try"
    // decision, then — only if someone does — a window for those teams to
    // actually pick a spot. Both end early the moment everyone's answered.
    let stealHtml = '';
    if (placed && mine) {
      const remain = secsLeft(s.stealDeadline);
      if (s.stealStage === 'intent') {
        if (mine.id === active.id) {
          stealHtml = `<p class="waiting-banner">⏱ <span class="countdown-num">${remain}</span>s — ${t('game.stealIntentWaitingOthers')}</p>`;
        } else if (s.stealRespondedTeamIds.includes(mine.id)) {
          stealHtml = `<p class="waiting-banner">⏱ <span class="countdown-num">${remain}</span>s — ${t('game.stealIntentWaitingYou')}</p>`;
        } else {
          stealHtml = `
            <p class="hint-msg">⏱ <span class="countdown-num">${remain}</span>s: ${t('game.stealPrompt', { n: mine.tokens })}</p>
            <div class="stage-actions">
              <button class="btn gold small" data-action="stealwant" ${mine.tokens < 1 ? 'disabled' : ''}>${t('game.stealWant')}</button>
              <button class="btn ghost small" data-action="stealpass">${t('game.stealPass')}</button>
            </div>`;
        }
      } else if (s.stealStage === 'placing') {
        if (mine.id === active.id) {
          stealHtml = `<p class="waiting-banner">⏱ <span class="countdown-num">${remain}</span>s — ${t('game.stealPlacingActive', { n: s.stealWantTeamIds.length })}</p>`;
        } else if (s.stealWantTeamIds.includes(mine.id) && !s.stealPlacedTeamIds.includes(mine.id)) {
          stealHtml = `
            <p class="hint-msg">⏱ <span class="countdown-num">${remain}</span>s: ${t('game.stealPlacingYou', { name: esc(active.name) })}</p>
            <div class="rail-scroll compact"><div class="rail">${renderRail(active, true, null, 'challenge')}</div></div>`;
        } else {
          stealHtml = `<p class="waiting-banner">⏱ <span class="countdown-num">${remain}</span>s — ${t('game.stealPlacingWaiting')}</p>`;
        }
      }
    }

    // Bonus vote (phase 'revealed', vote mode only): the other teams weigh
    // in on whether the pre-reveal claim was actually true.
    let bonusVoteHtml = '';
    if (revealed && s.bonusVoteStage && mine) {
      const remain = secsLeft(s.bonusDeadline);
      if (s.bonusVoteEligibleTeamIds.includes(mine.id) && !s.bonusVotedTeamIds.includes(mine.id)) {
        bonusVoteHtml = `<div class="bonus-resolve">
           <span>⏱ <span class="countdown-num">${remain}</span>s: ${t('game.bonusVoteQuestion')}</span>
           <button class="btn small gold" data-action="bonusvote" data-correct="1">${t('game.bonusVoteYes')}</button>
           <button class="btn small ghost" data-action="bonusvote" data-correct="0">${t('game.bonusVoteNo')}</button>
         </div>`;
      } else {
        bonusVoteHtml = `<p class="waiting-banner">⏱ <span class="countdown-num">${remain}</span>s — ${t('game.bonusVoteWaiting')}</p>`;
      }
    }
    const bonusDone = (s.bonusClaimed || s.bonusGuessSubmitted) && !s.bonusVoteStage && s.bonusResolved !== null;
    const bonusResultHtml = (revealed && bonusDone)
      ? `<p class="hint-msg">${s.bonusResolved ? t('game.bonusResultCorrect') : t('game.bonusResultWrong')}</p>`
      : '';

    let resultHtml = '';
    if (revealed) {
      const stolenTeam = s.lastResult.stolenBy ? s.teams.find((team) => team.id === s.lastResult.stolenBy) : null;
      resultHtml = `
        <div class="result-banner ${s.lastResult.correct ? 'ok' : 'no'}">
          ${s.lastResult.correct
            ? t('game.resultCorrect')
            : stolenTeam
              ? t('game.resultStolen', { team: esc(stolenTeam.name), y: s.lastResult.card.y })
              : t('game.resultWrong', { y: s.lastResult.card.y })}
        </div>`;
    }

    stageHtml = `
      <div class="player-zone">
        <div class="discwrap">
          <span class="disc ${isPlaying ? 'vinylspin' : ''}"></span>
          <button class="play-btn" data-action="toggleplay" aria-label="${isPlaying ? t('game.pause') : t('game.play')}">${isPlaying ? '❚❚' : '▶'}</button>
        </div>
        ${iAmHostDevice
          ? `<div class="progress"><i style="width:${pct}%"></i></div><span class="player-hint">${getAudio().error ? t('game.audioUnavailable') : t('game.previewHint')}</span>`
          : `<span class="player-hint">${t('game.playingOnHost', { host: esc(s.audioHost) })}</span>`}
      </div>
      ${renderAudioControl(s)}

      <div class="flipcard ${revealed ? 'flipped' : ''}"><div class="flipcard-inner">
        <div class="flipcard-face flipcard-front"><div class="q vinylspin">?</div></div>
        <div class="flipcard-face flipcard-back">
          ${revealed ? `
            ${renderCover(c.id, c.t, c.a, c.y, '')}
            <div class="ttl">${esc(c.t)}</div>
            <div class="art">${esc(c.a)}</div>
            <div class="yr tab">${c.y}</div>
          ` : ''}
        </div>
      </div></div>

      ${resultHtml}
      ${bonusVoteHtml}
      ${bonusResultHtml}
      ${revealed
        ? (isMyTurn && !s.bonusVoteStage
            ? `<div class="stage-actions"><button class="btn gold" data-action="next">${t('game.next')}</button></div>`
            : (!isMyTurn && !s.bonusVoteStage ? `<p class="waiting-banner">${t('game.othersContinue', { name: esc(active.name) })}</p>` : ''))
        : placed
          ? stealHtml
          : isMyTurn ? `
            ${bonusInputHtml}
            <div class="stage-actions">
              <button class="btn primary" data-action="placecard" ${s.selectedGap === null ? 'disabled' : ''}>${t('game.placeCard')}</button>
            </div>
          ` : `<p class="waiting-banner">${t('game.othersGuessing', { name: esc(active.name) })}</p>`}
    `;
  }

  const isPlacedOrRevealed = s.phase === 'placed' || s.phase === 'revealed';
  const railHtml = renderRail(
    active,
    s.phase === 'listening' && isMyTurn,
    s.selectedGap,
    'gap',
    isPlacedOrRevealed ? s.selectedGap : null
  );

  const boardHtml = s.teams.map((team, i) => `
    <div class="p ${i === s.turnIndex ? 'active' : ''}">
      <div class="nm"><span>${esc(team.name)} <small style="opacity:.6;">(${team.members.length})</small></span><span class="tokens tab">🪙${team.tokens}</span></div>
      <div class="p-score"><b class="tab">${team.timeline.length}</b><span>/ ${t('gameover.standingsStats', { cards: s.target, misses: team.misses })}</span></div>
      <div class="bar"><i style="width:${Math.min(100, (team.timeline.length / s.target) * 100)}%; background:${team.color}"></i></div>
    </div>
  `).join('');

  // Everyone can always browse every team's timeline, not just the active
  // one — otherwise you're stuck staring at a progress bar while waiting.
  const otherTeamsHtml = s.teams.filter((team) => team.id !== active.id).map((team) => `
    <div class="other-team-block">
      <div class="other-team-head">
        <span class="dot" style="background:${team.color}"></span><strong>${esc(team.name)}</strong>
        <span class="tab" style="margin-left:auto;opacity:.7;">${team.timeline.length}/${s.target}</span>
      </div>
      <div class="rail-scroll compact"><div class="rail">${renderRail(team, false, null)}</div></div>
    </div>
  `).join('');

  return `
  ${renderHeader(rightInfo)}
  ${errorHtml}
  <div class="turn-banner">
    <div class="whoturn"><span class="dot">●</span> ${t('game.turnBanner', { name: esc(active.name) })}</div>
    <div class="goal tab">${t('game.goal', { n: s.target })}</div>
  </div>

  <div class="stage">${stageHtml}</div>

  <div class="timeline-head">
    <h3>${t('game.timelineHead', { name: esc(active.name) })}</h3>
    <span>${tCount('game.cardCount', active.timeline.length)} · ${tCount('game.missCount', active.misses)}</span>
  </div>
  <div class="rail-scroll"><div class="rail">${railHtml}</div></div>

  <div class="board">${boardHtml}</div>

  ${otherTeamsHtml ? `<div class="section-title" style="margin-top:22px;">${t('game.otherTimelines')}</div>${otherTeamsHtml}` : ''}`;
}

function renderRail(team, interactive, selectedGap, action, lockedGap) {
  action = action || 'gap';
  const tl = team.timeline;
  let html = '';
  for (let g = 0; g <= tl.length; g++) {
    if (interactive) {
      const isSelected = selectedGap === g;
      html += `<button class="gap-slot ${isSelected ? 'selected' : ''}" ${isSelected ? 'id="selected-gap-marker"' : ''} data-action="${action}" data-g="${g}" aria-label="${t('game.gapAriaLabel')}"><span class="plus">+</span></button>`;
    } else if (lockedGap === g) {
      // The card was committed here (phase 'placed'/'revealed') — visible to
      // everyone, same as a physical card lying face-down on the table.
      // Scrolled into view automatically (see maybeScrollToLockedGap) so
      // other teams can actually see the neighboring cards before deciding
      // whether to steal, instead of having to scroll the rail themselves.
      html += `<div class="gap-slot" id="locked-gap-marker" style="cursor:default"><span class="plus locked">🂠</span></div>`;
    } else {
      html += `<div class="gap-slot" style="cursor:default"><span class="plus" style="opacity:0.25">·</span></div>`;
    }
    if (g < tl.length) {
      const c = tl[g];
      html += `<div class="chip">${renderCover(c.id, c.t, c.a, c.y, '')}<div class="ct">${esc(c.t)}</div><div class="cy tab">${c.y}</div></div>`;
    }
  }
  return html;
}

function renderGameOver(s) {
  // Same card count AND same miss count = genuinely tied, not "2nd vs 3rd"
  // — a plain index-based rank silently broke ties by array order alone.
  const tied = (a, b) => a.timeline.length === b.timeline.length && a.misses === b.misses;
  const sorted = s.teams.slice().sort((a, b) => b.timeline.length - a.timeline.length || a.misses - b.misses);
  const winners = sorted.filter((team) => tied(team, sorted[0]));

  let rank = 1;
  const standings = sorted.map((team, i) => {
    if (i > 0 && !tied(team, sorted[i - 1])) rank = i + 1;
    return `<div><span>${rank}. ${esc(team.name)}</span><span class="tab">${t('gameover.standingsStats', { cards: team.timeline.length, misses: team.misses })}</span></div>`;
  }).join('');

  const winnerHeading = winners.length > 1
    ? t('gameover.winTogether', { names: winners.map((team) => esc(team.name)).join(' &amp; ') })
    : t('gameover.winSolo', { name: esc(winners[0].name) });
  const winnerSub = winners.length > 1
    ? t('gameover.subTie', { n: winners[0].timeline.length })
    : t('gameover.subSolo', { n: winners[0].timeline.length, members: winners[0].members.map(esc).join(', ') });

  return `
  ${renderHeader()}
  <div class="over-card">
    <div class="trophy">🏆</div>
    <h2>${winnerHeading}</h2>
    <p style="opacity:.75">${winnerSub}</p>
    <div class="standings">${standings}</div>
    <button class="btn primary" data-action="leaveroom">${t('gameover.backToLobby')}</button>
  </div>`;
}

// ---------------- events ----------------

function bindEvents() {
  const app = document.getElementById('app');

  app.onclick = (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'setlang') { setLang(btn.dataset.lang); render(); }
    else if (action === 'authmode') { AUTH_MODE = btn.dataset.mode; AUTH_ERROR = ''; render(); }
    else if (action === 'logout') doLogout();
    else if (action === 'toggleplaylist') {
      const id = btn.dataset.id;
      if (MY_ROOM_PLAYLISTS.has(id)) MY_ROOM_PLAYLISTS.delete(id); else MY_ROOM_PLAYLISTS.add(id);
      send({ type: 'selectPlaylists', playlistIds: Array.from(MY_ROOM_PLAYLISTS) });
      render();
    }
    else if (action === 'addplaylist') {
      const input = document.getElementById('newPlaylistUrl');
      addPlaylist(input.value);
    }
    else if (action === 'prefetchplaylist') {
      e.preventDefault(); // button can sit inside a <label> (selection checkbox) — don't also toggle that
      prefetchPlaylist(btn.dataset.id);
    }
    else if (action === 'importplaylist') {
      triggerPlaylistImport();
    }
    else if (action === 'showmanageplaylists') { showManagePlaylists(); }
    else if (action === 'backfrommanage') { VIEW = MANAGE_RETURN_VIEW; render(); }
    else if (action === 'startrename') { RENAMING_PLAYLIST_ID = btn.dataset.id; render(); }
    else if (action === 'cancelrename') { RENAMING_PLAYLIST_ID = null; render(); }
    else if (action === 'saverename') {
      const input = document.getElementById('renameInput');
      if (input) renamePlaylist(btn.dataset.id, input.value);
    }
    else if (action === 'clearcache') { clearPlaylistCache(btn.dataset.id); }
    else if (action === 'deleteplaylist') { deletePlaylist(btn.dataset.id, btn.dataset.name); }
    else if (action === 'target') { TARGET = parseInt(btn.dataset.t, 10); render(); }
    else if (action === 'teamcount') { TEAM_COUNT = parseInt(btn.dataset.t, 10); render(); }
    else if (action === 'bonusmode') { BONUS_MODE = btn.dataset.mode; render(); }
    else if (action === 'toggledupyears') { NO_DUPLICATE_YEARS = btn.checked; render(); }
    else if (action === 'toggleshuffleorder') { SHUFFLE_TEAM_ORDER = btn.checked; render(); }
    else if (action === 'stealintentsec') { STEAL_INTENT_SEC = parseInt(btn.dataset.t, 10); render(); }
    else if (action === 'stealplacesec') { STEAL_PLACE_SEC = parseInt(btn.dataset.t, 10); render(); }
    else if (action === 'stealtiemode') { STEAL_TIE_MODE = btn.dataset.mode; render(); }
    else if (action === 'startgame') send({ type: 'start' });
    else if (action === 'jointeam') send({ type: 'switchTeam', teamId: btn.dataset.team });
    else if (action === 'claimaudio') send({ type: 'setAudioHost', enable: true });
    else if (action === 'releaseaudio') {
      const key = audioHostStorageKey();
      if (key) { try { localStorage.removeItem(key); } catch (e) {} }
      send({ type: 'setAudioHost', enable: false });
    }
    else if (action === 'leaveroom') leaveRoom();
    else if (action === 'draw') send({ type: 'draw' });
    else if (action === 'gap') send({ type: 'pickGap', gap: parseInt(btn.dataset.g, 10) });
    else if (action === 'placecard') send({ type: 'placeCard' });
    else if (action === 'next') send({ type: 'next' });
    else if (action === 'stealwant') { wsErrorMsg = ''; send({ type: 'stealIntent', wants: true }); }
    else if (action === 'stealpass') { wsErrorMsg = ''; send({ type: 'stealIntent', wants: false }); }
    else if (action === 'challenge') { wsErrorMsg = ''; send({ type: 'challenge', gap: parseInt(btn.dataset.g, 10) }); }
    else if (action === 'bonusvote') send({ type: 'castBonusVote', correct: btn.dataset.correct === '1' });
    else if (action === 'togglebonus') send({ type: 'claimBonus', claim: btn.checked });
    else if (action === 'toggleplay') togglePlay();
  };

  // change (not input) — nobody else ever sees this text (rooms.js only
  // exposes a submitted:true/false flag), so there's no reason to sync on
  // every keystroke, and doing so would rebuild the DOM under the user's
  // cursor via the resulting state broadcast's re-render.
  const bonusArtistEl = app.querySelector('[data-action="bonusartist"]');
  if (bonusArtistEl) bonusArtistEl.onchange = () => {
    BONUS_TYPEIN_ARTIST = bonusArtistEl.value;
    send({ type: 'submitBonusGuess', artist: BONUS_TYPEIN_ARTIST, title: BONUS_TYPEIN_TITLE });
  };
  const bonusTitleEl = app.querySelector('[data-action="bonustitle"]');
  if (bonusTitleEl) bonusTitleEl.onchange = () => {
    BONUS_TYPEIN_TITLE = bonusTitleEl.value;
    send({ type: 'submitBonusGuess', artist: BONUS_TYPEIN_ARTIST, title: BONUS_TYPEIN_TITLE });
  };

  const authForm = app.querySelector('[data-form="auth"]');
  if (authForm) authForm.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(authForm);
    doAuth(AUTH_MODE, fd.get('username'), fd.get('password'));
  };

  const localNameForm = app.querySelector('[data-form="localname"]');
  if (localNameForm) localNameForm.onsubmit = (e) => {
    e.preventDefault();
    enterLocalName(new FormData(localNameForm).get('name'));
  };

  const createForm = app.querySelector('[data-form="createroom"]');
  if (createForm) createForm.onsubmit = (e) => {
    e.preventDefault();
    createRoom(new FormData(createForm).get('name'));
  };

  const joinForm = app.querySelector('[data-form="joinroom"]');
  if (joinForm) joinForm.onsubmit = (e) => {
    e.preventDefault();
    joinRoom(new FormData(joinForm).get('code'));
  };

  const adminLoginForm = app.querySelector('[data-form="adminlogin"]');
  if (adminLoginForm) adminLoginForm.onsubmit = (e) => {
    e.preventDefault();
    adminLogin(new FormData(adminLoginForm).get('password'));
  };
}

(function initAudio() {
  const a = getAudio();
  const reportIfHost = (playing) => {
    if (ROOM_STATE && ME && ROOM_STATE.audioHost === ME.username) send({ type: 'audioState', playing });
  };
  a.addEventListener('play', () => { reportIfHost(true); render(); });
  a.addEventListener('pause', () => { reportIfHost(false); render(); });
  a.addEventListener('error', () => { reportIfHost(false); render(); });
  a.addEventListener('ended', () => { reportIfHost(false); render(); });
  a.addEventListener('timeupdate', () => {
    const bar = document.querySelector('.progress i');
    if (bar && a.duration) bar.style.width = Math.min(100, (a.currentTime / a.duration) * 100) + '%';
  });
})();

boot();
