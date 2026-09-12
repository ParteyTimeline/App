'use strict';

// Works whether the app is served at the domain root or reverse-proxied
// under a sub-path (e.g. https://host/partey/) — every request is built
// relative to wherever this page itself was actually loaded from.
const BASE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';

let ME = null;
let VIEW = 'loading'; // loading | auth | lobby | room
let PLAYLISTS = [];
let TARGET = 8;
let TEAM_COUNT = 3;
let BONUS_MODE = 'vote'; // 'vote' | 'typein'
let NO_DUPLICATE_YEARS = false;
let STEAL_INTENT_SEC = 4;
let STEAL_PLACE_SEC = 10;
let STEAL_TIE_MODE = 'block'; // 'block' | 'void'
let AUTH_MODE = 'login'; // login | register
let AUTH_ERROR = '';
let LOBBY_ERROR = '';
let LOBBY_NOTE = '';
let ADDING_PLAYLIST = false;

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

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `Fehler ${res.status}`);
  return data;
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
    if (!resumed) VIEW = 'lobby';
  } catch (e) {
    VIEW = 'auth';
  }
  render();
}

let playlistPollTimer = null;

async function loadPlaylists() {
  PLAYLISTS = await api('GET', 'api/playlists');
  const anyImporting = PLAYLISTS.some((p) => p.status === 'importing');
  clearTimeout(playlistPollTimer);
  if (anyImporting) {
    playlistPollTimer = setTimeout(async () => {
      await loadPlaylists();
      render();
    }, 3000);
  }
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
    AUTH_ERROR = e.message;
  }
  render();
}

async function doLogout() {
  try { await api('POST', 'api/logout'); } catch (e) {}
  disconnectWs();
  ME = null; VIEW = 'auth'; ROOM_STATE = null; currentRoomCode = null;
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
    LOBBY_NOTE = 'Import gestartet — läuft im Hintergrund weiter, Fortschritt siehe Liste oben.';
    await loadPlaylists();
  } catch (e) {
    LOBBY_ERROR = e.message;
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
    });
    connectRoom(code);
  } catch (e) {
    LOBBY_ERROR = e.message; render();
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
    LOBBY_ERROR = e.message; render();
  }
}

function leaveRoom() {
  disconnectWs();
  ROOM_STATE = null; currentRoomCode = null; VIEW = 'lobby';
  loadPlaylists().then(render);
  render();
}

// ---------------- websocket / room ----------------

function connectRoom(code) {
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
    } else if (msg.type === 'error') {
      const known = {
        spot_taken: 'Diese Lücke hat schon ein anderes Team gewettet.',
        already_challenged: 'Euer Team hat für diese Karte schon gewettet.',
        no_tokens: 'Keine Tokens mehr übrig.',
        cannot_challenge_own_turn: 'Ihr könnt nicht gegen euren eigenen Zug wetten.',
        no_playlists_selected: 'Noch niemand hat Playlisten ausgewählt.',
        need_more_teams: 'Mindestens 2 Teams brauchen je 1 Spieler.',
      };
      wsErrorMsg = known[msg.message] || '';
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
    return `<button class="btn small ghost" data-action="claimaudio">🔊 Dieses Handy als Ton-Gerät festlegen (mit Box verbinden)</button>`;
  }
  if (host === ME.username) {
    return `<div class="audio-host-note">🔊 Ton läuft auf diesem Gerät <button class="btn small ghost" data-action="releaseaudio">Beenden</button></div>`;
  }
  return `<div class="audio-host-note">🔊 Ton läuft auf <strong>${esc(host)}</strong>s Gerät</div>`;
}

// ---------------- render ----------------

function render() {
  const app = document.getElementById('app');
  if (VIEW === 'loading') app.innerHTML = '';
  else if (VIEW === 'auth') app.innerHTML = renderAuth();
  else if (VIEW === 'lobby') app.innerHTML = renderLobby();
  else if (VIEW === 'room') app.innerHTML = renderRoom();
  bindEvents();
}

function renderHeader(extra) {
  return `
  <header class="top">
    <div class="brand">
      <div class="mark">PARTEY<span class="hot">TIMELINE</span></div>
      <span class="sub">eigener Server · Team-Modus</span>
    </div>
    ${ME ? `<div class="who"><span class="name">${esc(ME.username)}</span><button class="btn small ghost" data-action="logout">Logout</button></div>` : ''}
  </header>
  ${extra || ''}`;
}

function renderAuth() {
  return `
  <div class="auth-wrap">
    ${renderHeader()}
    <div class="card">
      <h2>${AUTH_MODE === 'login' ? 'Einloggen' : 'Account erstellen'}</h2>
      <p class="lead">Server-Version von Partey Timeline: jede:r loggt sich mit eigenem Account ein und spielt in Teams, jeder auf dem eigenen Handy.</p>
      <div class="auth-tabs">
        <button class="${AUTH_MODE === 'login' ? 'active' : ''}" data-action="authmode" data-mode="login">Login</button>
        <button class="${AUTH_MODE === 'register' ? 'active' : ''}" data-action="authmode" data-mode="register">Registrieren</button>
      </div>
      ${AUTH_ERROR ? `<div class="error-msg">${esc(AUTH_ERROR)}</div>` : ''}
      <form data-form="auth">
        <div class="field">
          <label class="field-label">Nutzername</label>
          <input type="text" name="username" autocomplete="username" required maxlength="20">
        </div>
        <div class="field">
          <label class="field-label">Passwort</label>
          <input type="password" name="password" autocomplete="${AUTH_MODE === 'login' ? 'current-password' : 'new-password'}" required minlength="6">
        </div>
        <button class="btn primary block" type="submit">${AUTH_MODE === 'login' ? '▶ Einloggen' : '▶ Account erstellen'}</button>
      </form>
    </div>
  </div>`;
}

// Shared between the pre-room lobby (read-only) and the waiting room
// (checkboxes, per-player selection) — `selected` is null for read-only.
function renderPlaylistList(selected) {
  if (!PLAYLISTS.length) return `<p class="hint-msg">Noch keine Playlist in der Bibliothek — füg unten die erste hinzu.</p>`;
  return PLAYLISTS.map((p) => {
    if (p.status === 'importing') {
      const pct = (p.progress && p.progress.total) ? Math.min(100, (p.progress.done / p.progress.total) * 100) : 0;
      return `
      <div class="playlist-row importing">
        <span class="spinner"></span>
        <span class="pname">${esc(p.name)}</span>
        <span class="pmeta">${p.progress && p.progress.total ? `${p.progress.done}/${p.progress.total}` : 'startet …'}</span>
        <div class="import-bar"><i style="width:${pct}%"></i></div>
      </div>`;
    }
    if (p.status === 'failed') {
      return `
      <div class="playlist-row failed">
        <span class="pname">${esc(p.name)}</span>
        <span class="pmeta">Fehlgeschlagen: ${esc(p.error || 'unbekannter Fehler')}</span>
      </div>`;
    }
    if (selected) {
      return `
      <label class="playlist-row">
        <input type="checkbox" data-action="toggleplaylist" data-id="${esc(p.id)}" ${selected.has(p.id) ? 'checked' : ''}>
        <span class="pname">${esc(p.name)}</span>
        <span class="pmeta">${p.count} Songs · ${esc(p.addedBy)}</span>
      </label>`;
    }
    return `
    <div class="playlist-row">
      <span class="pname">${esc(p.name)}</span>
      <span class="pmeta">${p.count} Songs · ${esc(p.addedBy)}</span>
    </div>`;
  }).join('');
}

function renderLobby() {
  const plHtml = renderPlaylistList(null);

  const targets = [6, 8, 10, 12];
  const targetHtml = targets.map((t) => `
    <button class="target-opt ${t === TARGET ? 'active' : ''}" data-action="target" data-t="${t}">${t} Karten</button>`).join('');

  const teamCounts = [2, 3, 4, 5, 6];
  const teamHtml = teamCounts.map((t) => `
    <button class="target-opt ${t === TEAM_COUNT ? 'active' : ''}" data-action="teamcount" data-t="${t}">${t} Teams</button>`).join('');

  return `
  ${renderHeader()}
  ${LOBBY_ERROR ? `<div class="error-msg">${esc(LOBBY_ERROR)}</div>` : ''}
  ${LOBBY_NOTE ? `<div class="hint-msg" style="margin-bottom:16px;">${esc(LOBBY_NOTE)}</div>` : ''}
  <div class="lobby-grid">
    <div class="card">
      <h2>Neuen Raum erstellen</h2>
      <p class="lead">Playlisten wählt jede:r Mitspieler:in gleich im Warteraum selbst — Songs werden <strong>pro Spieler:in gleich gewichtet</strong> gezogen, nicht pro Playlist. Wer drei Playlisten beisteuert, hat dadurch keinen Vorteil gegenüber wer nur eine hat.</p>

      <div class="section-title">Playlist-Bibliothek</div>
      <div class="playlist-list">${plHtml}</div>

      <div class="add-playlist-row">
        <textarea id="newPlaylistUrl" rows="2" placeholder="Playlist-Link (Deezer/Spotify/YouTube) — oder: in Spotify alle Songs markieren &amp; kopieren und hier einfügen, oder eine Exportify-CSV reinpasten"></textarea>
        <button class="btn ${ADDING_PLAYLIST ? 'ghost' : 'gold'}" data-action="addplaylist" ${ADDING_PLAYLIST ? 'disabled' : ''}>
          ${ADDING_PLAYLIST ? '<span class="spinner"></span> startet …' : '+ Hinzufügen'}
        </button>
      </div>
      <p class="hint-msg" style="margin-top:-10px;margin-bottom:22px;">Große eigene Spotify-Playlist ohne Premium? Songs in Spotify mit Strg/Cmd+A markieren, kopieren (Strg/Cmd+C) und die kopierte Liste hier einfügen — umgeht das 100-Songs-Limit der normalen Link-Vorschau.</p>

      <div class="field-label">Anzahl Teams</div>
      <div class="target-row">${teamHtml}</div>

      <div class="field-label">Ziel</div>
      <div class="target-row">${targetHtml}</div>

      <div class="field-label">Titel &amp; Interpret-Bonus prüfen</div>
      <div class="target-row">
        <button class="target-opt ${BONUS_MODE === 'vote' ? 'active' : ''}" data-action="bonusmode" data-mode="vote">🗳️ Abstimmen (lokal)</button>
        <button class="target-opt ${BONUS_MODE === 'typein' ? 'active' : ''}" data-action="bonusmode" data-mode="typein">⌨️ Eintippen (online)</button>
      </div>
      <p class="hint-msg" style="margin-top:-10px;">Abstimmen: andere Teams stimmen nach der Aufdeckung ab, ob's stimmte (alle im selben Raum). Eintippen: automatischer Abgleich, kein Vertrauen nötig — für Online-Runden.</p>

      <label class="bonus-check" style="margin:14px 0;">
        <input type="checkbox" data-action="toggledupyears" ${NO_DUPLICATE_YEARS ? 'checked' : ''}>
        Keine doppelten Jahre pro Team (kein "geschenktes" Jahr-Duplikat)
      </label>

      <div class="field-label">Steal: Zeit zum Entscheiden ("will stehlen?")</div>
      <div class="target-row">
        ${[3, 4, 6, 8].map((s) => `<button class="target-opt ${s === STEAL_INTENT_SEC ? 'active' : ''}" data-action="stealintentsec" data-t="${s}">${s}s</button>`).join('')}
      </div>
      <div class="field-label">Steal: Zeit zum Platzieren (nur wer stehlen will)</div>
      <div class="target-row">
        ${[5, 10, 15, 20].map((s) => `<button class="target-opt ${s === STEAL_PLACE_SEC ? 'active' : ''}" data-action="stealplacesec" data-t="${s}">${s}s</button>`).join('')}
      </div>
      <div class="field-label">Steal: zwei Teams wählen dieselbe Lücke</div>
      <div class="target-row">
        <button class="target-opt ${STEAL_TIE_MODE === 'block' ? 'active' : ''}" data-action="stealtiemode" data-mode="block">Blockieren (2. Team muss anders wählen)</button>
        <button class="target-opt ${STEAL_TIE_MODE === 'void' ? 'active' : ''}" data-action="stealtiemode" data-mode="void">Erlauben, bei Gleichstand bekommt keiner was</button>
      </div>

      <form data-form="createroom">
        <div class="field">
          <label class="field-label">Raumname (optional)</label>
          <input type="text" name="name" placeholder="${esc(ME.username)}s Runde" maxlength="40">
        </div>
        <button class="btn primary block" type="submit">▶ Raum erstellen</button>
      </form>
    </div>

    <div class="card">
      <h2>Raum beitreten</h2>
      <p class="lead">Hat jemand schon einen Raum erstellt? Code eingeben — ihr werdet automatisch gleichmäßig auf die Teams verteilt und könnt in der Lobby noch wechseln.</p>
      <form data-form="joinroom">
        <div class="field join-row">
          <input type="text" name="code" placeholder="CODE" maxlength="4">
          <button class="btn primary" type="submit">Beitreten</button>
        </div>
      </form>
    </div>
  </div>
  <footer class="credit">Audio via Deezer &amp; YouTube · YouTube-Metadaten via MusicBrainz · inspiriert von
    <a href="https://github.com/Born2Root/HitStar" target="_blank" rel="noopener">Born2Root/HitStar</a> &amp; Hitster</footer>`;
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
  const teamCards = s.teams.map((t) => `
    <div class="team-card" style="border-color:${t.id === (mine && mine.id) ? t.color : 'var(--line)'}">
      <div class="team-card-head"><span class="dot" style="background:${t.color}"></span>${esc(t.name)}</div>
      <div class="team-members">${t.members.length ? t.members.map((m) => `<span class="member-chip">${esc(m)}${m === s.hostUsername ? ' 👑' : ''} · ${memberSongCount(s, m)} 🎵</span>`).join('') : '<span class="hint-msg">noch niemand</span>'}</div>
      ${t.id === (mine && mine.id)
        ? `<span class="hint-msg">✓ dein Team</span>`
        : `<button class="btn small ghost" data-action="jointeam" data-team="${t.id}">Hierher wechseln</button>`}
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
    <h2>Warteraum</h2>
    <p class="lead" style="margin-left:auto;margin-right:auto;">Raumcode teilen, alle geben ihn unter „Raum beitreten" ein.</p>
    <div class="room-code">${esc(s.code)}</div>
    <p class="hint-msg">Ziel: ${s.target} Karten · Songs werden gleich gewichtet pro Spieler:in gezogen</p>
    <div class="team-grid">${teamCards}</div>
    <div style="margin-bottom:18px;">${renderAudioControl(s)}</div>
    ${isHost
      ? `<button class="btn primary" data-action="startgame" ${canStart ? '' : 'disabled'}>▶ Spiel starten</button>
         ${nonEmptyTeams < 2 ? '<p class="hint-msg">Mindestens 2 Teams brauchen je 1 Spieler</p>' : ''}
         ${nonEmptyTeams >= 2 && !anySongsSelected ? '<p class="hint-msg">Noch niemand hat Playlisten ausgewählt</p>' : ''}`
      : `<p class="waiting-banner">Warte, bis ${esc(s.hostUsername)} das Spiel startet …</p>`}
    <div style="margin-top:18px;"><button class="btn ghost small" data-action="leaveroom">Raum verlassen</button></div>
  </div>

  <div class="card" style="text-align:left;margin-top:18px;">
    <h2>Deine Playlisten</h2>
    <p class="lead">Wähl aus, welche deiner Playlisten mitspielen sollen — jede:r im Raum entscheidet für sich selbst.</p>
    <div class="playlist-list">${myPicksHtml}</div>
    <div class="add-playlist-row">
      <textarea id="newPlaylistUrl" rows="2" placeholder="Neue Playlist zur Bibliothek hinzufügen (Link oder eingefügte Liste) …"></textarea>
      <button class="btn ${ADDING_PLAYLIST ? 'ghost' : 'gold'}" data-action="addplaylist" ${ADDING_PLAYLIST ? 'disabled' : ''}>
        ${ADDING_PLAYLIST ? '<span class="spinner"></span> startet …' : '+ Hinzufügen'}
      </button>
    </div>
  </div>`;
}

function renderGamePlay(s) {
  const active = s.teams[s.turnIndex];
  const mine = myTeam(s);
  const isMyTurn = !!(mine && mine.id === active.id);
  const rightInfo = `<div class="who"><span class="name tab">Stapel: ${s.deckRemaining}</span></div>`;

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
        ? `<button class="btn primary" data-action="draw">🎵 Karte ziehen</button>`
        : `<p class="waiting-banner">${esc(active.name)} zieht die nächste Karte …</p>`}
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
            <input type="text" placeholder="Interpret" data-action="bonusartist" value="${esc(BONUS_TYPEIN_ARTIST)}">
            <input type="text" placeholder="Titel" data-action="bonustitle" value="${esc(BONUS_TYPEIN_TITLE)}">
            <span class="hint-msg">Optional, wird automatisch abgeglichen (+1 🪙 bei Treffer)</span>
          </div>`;
      } else {
        bonusInputHtml = `<label class="bonus-check">
           <input type="checkbox" data-action="togglebonus" ${s.bonusClaimed ? 'checked' : ''}>
           🎤 Wir wissen auch Titel &amp; Interpret (+1 🪙, andere stimmen danach ab)
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
          stealHtml = `<p class="waiting-banner">⏱ <span class="countdown-num">${remain}</span>s — andere Teams entscheiden, ob sie stehlen wollen …</p>`;
        } else if (s.stealRespondedTeamIds.includes(mine.id)) {
          stealHtml = `<p class="waiting-banner">⏱ <span class="countdown-num">${remain}</span>s — warte auf die anderen Teams …</p>`;
        } else {
          stealHtml = `
            <p class="hint-msg">⏱ <span class="countdown-num">${remain}</span>s: Stehlen versuchen? Kostet 1 🪙 (ihr habt ${mine.tokens}).</p>
            <div class="stage-actions">
              <button class="btn gold small" data-action="stealwant" ${mine.tokens < 1 ? 'disabled' : ''}>🎯 Will stehlen</button>
              <button class="btn ghost small" data-action="stealpass">✅ Kein Steal</button>
            </div>`;
        }
      } else if (s.stealStage === 'placing') {
        if (mine.id === active.id) {
          stealHtml = `<p class="waiting-banner">⏱ <span class="countdown-num">${remain}</span>s — ${s.stealWantTeamIds.length} Team(s) versuchen zu stehlen …</p>`;
        } else if (s.stealWantTeamIds.includes(mine.id) && !s.stealPlacedTeamIds.includes(mine.id)) {
          stealHtml = `
            <p class="hint-msg">⏱ <span class="countdown-num">${remain}</span>s: Wählt die Lücke in ${esc(active.name)}s Zeitleiste, wo die Karte eurer Meinung nach wirklich hingehört:</p>
            <div class="rail-scroll compact"><div class="rail">${renderRail(active, true, null, 'challenge')}</div></div>`;
        } else {
          stealHtml = `<p class="waiting-banner">⏱ <span class="countdown-num">${remain}</span>s — warte auf Steal-Versuche …</p>`;
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
           <span>⏱ <span class="countdown-num">${remain}</span>s: Titel &amp; Interpret wirklich richtig?</span>
           <button class="btn small gold" data-action="bonusvote" data-correct="1">Ja, +1 🪙</button>
           <button class="btn small ghost" data-action="bonusvote" data-correct="0">Nein</button>
         </div>`;
      } else {
        bonusVoteHtml = `<p class="waiting-banner">⏱ <span class="countdown-num">${remain}</span>s — Abstimmung läuft …</p>`;
      }
    }
    const bonusDone = (s.bonusClaimed || s.bonusGuessSubmitted) && !s.bonusVoteStage && s.bonusResolved !== null;
    const bonusResultHtml = (revealed && bonusDone)
      ? `<p class="hint-msg">🎤 Titel/Interpret: ${s.bonusResolved ? 'richtig ✓ (+1 🪙)' : 'falsch'}</p>`
      : '';

    let resultHtml = '';
    if (revealed) {
      const stolenTeam = s.lastResult.stolenBy ? s.teams.find((t) => t.id === s.lastResult.stolenBy) : null;
      resultHtml = `
        <div class="result-banner ${s.lastResult.correct ? 'ok' : 'no'}">
          ${s.lastResult.correct
            ? '🎉 Richtig einsortiert!'
            : stolenTeam
              ? `🥷 Daneben — ${esc(stolenTeam.name)} hat die Karte gestohlen! (Jahr war ${s.lastResult.card.y})`
              : '❌ Leider daneben — Jahr war ' + s.lastResult.card.y}
        </div>`;
    }

    stageHtml = `
      <div class="player-zone">
        <div class="discwrap">
          <span class="disc ${isPlaying ? 'vinylspin' : ''}"></span>
          <button class="play-btn" data-action="toggleplay" aria-label="${isPlaying ? 'Pause' : 'Play'}">${isPlaying ? '❚❚' : '▶'}</button>
        </div>
        ${iAmHostDevice
          ? `<div class="progress"><i style="width:${pct}%"></i></div><span class="player-hint">${getAudio().error ? 'Audio nicht verfügbar – zum Wiederholen Play drücken' : '30-Sekunden-Anspieler'}</span>`
          : `<span class="player-hint">🔊 spielt auf ${esc(s.audioHost)}s Gerät</span>`}
      </div>
      ${renderAudioControl(s)}

      <div class="flipcard ${revealed ? 'flipped' : ''}"><div class="flipcard-inner">
        <div class="flipcard-face flipcard-front"><div class="q vinylspin">?</div></div>
        <div class="flipcard-face flipcard-back">
          ${revealed ? `
            <img src="${esc(c.cover || '')}" alt="">
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
            ? `<div class="stage-actions"><button class="btn gold" data-action="next">Weiter →</button></div>`
            : (!isMyTurn && !s.bonusVoteStage ? `<p class="waiting-banner">${esc(active.name)} macht weiter …</p>` : ''))
        : placed
          ? stealHtml
          : isMyTurn ? `
            ${bonusInputHtml}
            <div class="stage-actions">
              <button class="btn primary" data-action="placecard" ${s.selectedGap === null ? 'disabled' : ''}>An gewählter Stelle platzieren</button>
            </div>
          ` : `<p class="waiting-banner">${esc(active.name)} hört rein und rät …</p>`}
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

  const boardHtml = s.teams.map((t, i) => `
    <div class="p ${i === s.turnIndex ? 'active' : ''}">
      <div class="nm"><span>${esc(t.name)} <small style="opacity:.6;">(${t.members.length})</small></span><span class="tokens tab">🪙${t.tokens}</span></div>
      <div class="p-score"><b class="tab">${t.timeline.length}</b><span>/ ${s.target} Karten · ${t.misses} Fehler</span></div>
      <div class="bar"><i style="width:${Math.min(100, (t.timeline.length / s.target) * 100)}%; background:${t.color}"></i></div>
    </div>
  `).join('');

  // Everyone can always browse every team's timeline, not just the active
  // one — otherwise you're stuck staring at a progress bar while waiting.
  const otherTeamsHtml = s.teams.filter((t) => t.id !== active.id).map((t) => `
    <div class="other-team-block">
      <div class="other-team-head">
        <span class="dot" style="background:${t.color}"></span><strong>${esc(t.name)}</strong>
        <span class="tab" style="margin-left:auto;opacity:.7;">${t.timeline.length}/${s.target}</span>
      </div>
      <div class="rail-scroll compact"><div class="rail">${renderRail(t, false, null)}</div></div>
    </div>
  `).join('');

  return `
  ${renderHeader(rightInfo)}
  ${errorHtml}
  <div class="turn-banner">
    <div class="whoturn"><span class="dot">●</span> ${esc(active.name)} ist dran</div>
    <div class="goal tab">Ziel: ${s.target} Karten</div>
  </div>

  <div class="stage">${stageHtml}</div>

  <div class="timeline-head">
    <h3>${esc(active.name)}s Zeitleiste</h3>
    <span>${active.timeline.length} Karte${active.timeline.length === 1 ? '' : 'n'} · ${active.misses} Fehlversuch${active.misses === 1 ? '' : 'e'}</span>
  </div>
  <div class="rail-scroll"><div class="rail">${railHtml}</div></div>

  <div class="board">${boardHtml}</div>

  ${otherTeamsHtml ? `<div class="section-title" style="margin-top:22px;">Andere Zeitleisten</div>${otherTeamsHtml}` : ''}`;
}

function renderRail(team, interactive, selectedGap, action, lockedGap) {
  action = action || 'gap';
  const tl = team.timeline;
  let html = '';
  for (let g = 0; g <= tl.length; g++) {
    if (interactive) {
      const isSelected = selectedGap === g;
      html += `<button class="gap-slot ${isSelected ? 'selected' : ''}" ${isSelected ? 'id="selected-gap-marker"' : ''} data-action="${action}" data-g="${g}" aria-label="Hier einsortieren"><span class="plus">+</span></button>`;
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
      html += `<div class="chip"><img src="${esc(c.cover || '')}" alt=""><div class="ct">${esc(c.t)}</div><div class="cy tab">${c.y}</div></div>`;
    }
  }
  return html;
}

function renderGameOver(s) {
  // Same card count AND same miss count = genuinely tied, not "2nd vs 3rd"
  // — a plain index-based rank silently broke ties by array order alone.
  const tied = (a, b) => a.timeline.length === b.timeline.length && a.misses === b.misses;
  const sorted = s.teams.slice().sort((a, b) => b.timeline.length - a.timeline.length || a.misses - b.misses);
  const winners = sorted.filter((t) => tied(t, sorted[0]));

  let rank = 1;
  const standings = sorted.map((t, i) => {
    if (i > 0 && !tied(t, sorted[i - 1])) rank = i + 1;
    return `<div><span>${rank}. ${esc(t.name)}</span><span class="tab">${t.timeline.length} Karten · ${t.misses} Fehler</span></div>`;
  }).join('');

  const winnerHeading = winners.length > 1
    ? `${winners.map((t) => esc(t.name)).join(' &amp; ')} <span class="win-name">gewinnen gemeinsam!</span>`
    : `${esc(winners[0].name)} <span class="win-name">gewinnt!</span>`;
  const winnerSub = winners.length > 1
    ? `mit je ${winners[0].timeline.length} richtig einsortierten Songs — echter Gleichstand`
    : `mit ${winners[0].timeline.length} richtig einsortierten Songs (${winners[0].members.map(esc).join(', ')})`;

  return `
  ${renderHeader()}
  <div class="over-card">
    <div class="trophy">🏆</div>
    <h2>${winnerHeading}</h2>
    <p style="opacity:.75">${winnerSub}</p>
    <div class="standings">${standings}</div>
    <button class="btn primary" data-action="leaveroom">🔁 Zurück zur Lobby</button>
  </div>`;
}

// ---------------- events ----------------

function bindEvents() {
  const app = document.getElementById('app');

  app.onclick = (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'authmode') { AUTH_MODE = btn.dataset.mode; AUTH_ERROR = ''; render(); }
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
    else if (action === 'target') { TARGET = parseInt(btn.dataset.t, 10); render(); }
    else if (action === 'teamcount') { TEAM_COUNT = parseInt(btn.dataset.t, 10); render(); }
    else if (action === 'bonusmode') { BONUS_MODE = btn.dataset.mode; render(); }
    else if (action === 'toggledupyears') { NO_DUPLICATE_YEARS = btn.checked; render(); }
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
