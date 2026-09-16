const crypto = require('crypto');

// In-memory game rooms. A room lives only as long as the process runs —
// that's fine for a live party session; it is not meant to survive restarts.
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const TEAM_COLORS = ['#FF4D6D', '#0E8A8A', '#FFB627', '#7A3B57', '#3B6E8F', '#B5601C', '#4C956C', '#9C6ADE'];
const MIN_TEAMS = 2;
const MAX_TEAMS = TEAM_COLORS.length;
const STARTING_TOKENS = 2; // official "Original" mode
const MAX_TOKENS = 5; // official cap
const DEFAULT_INTENT_TIMEOUT_MS = 4000;
const DEFAULT_PLACE_TIMEOUT_MS = 10000;
const BONUS_VOTE_TIMEOUT_MS = 10000;
const AUDIO_HOST_GRACE_MS = 8000; // survive a routine reconnect blip (screen lock, brief drop)

function genCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function err(code) {
  return Object.assign(new Error(code), { code });
}

// --- fuzzy text match, for the "type in title+artist" bonus mode ---------
function normalizeGuess(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/\b(feat|ft|featuring)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}
function fuzzyMatch(guess, actual) {
  const g = normalizeGuess(guess);
  const a = normalizeGuess(actual);
  if (!g || !a) return false;
  if (g === a || a.includes(g) || g.includes(a)) return true;
  const dist = levenshtein(g, a);
  return dist <= Math.max(1, Math.floor(a.length * 0.25));
}

const DEFAULT_TEAM_NAMES = ['Team Rot', 'Team Teal', 'Team Gold', 'Team Wein', 'Team Blau', 'Team Karamell', 'Team Grün', 'Team Lila'];

function createRoom({ name, hostUsername, target, teamCount, bonusMode, noDuplicateYears, stealIntentTimeoutMs, stealPlaceTimeoutMs, stealTieMode, shuffleTeamOrder }) {
  let code;
  do {
    code = genCode();
  } while (rooms.has(code));

  const nTeams = Math.min(MAX_TEAMS, Math.max(MIN_TEAMS, teamCount || 3));
  const teams = [];
  for (let i = 0; i < nTeams; i++) {
    teams.push({ id: `t${i}`, name: DEFAULT_TEAM_NAMES[i], color: TEAM_COLORS[i], members: [], timeline: [], misses: 0, tokens: STARTING_TOKENS });
  }

  const room = {
    code,
    name: name || `${hostUsername}s Runde`,
    hostUsername,
    // Each PLAYER (not the host, not a playlist) picks their own playlists
    // during the lobby: username -> [{id, name, tracks}]. Built into
    // per-team-then-per-player pools at startGame().
    playerSelections: {},
    target: Math.min(20, Math.max(4, target || 8)),
    // How the "we also know title+artist" bonus is verified:
    //  - 'vote': the OTHER teams vote yes/no after the reveal (needs people
    //    in the same room able to hear the claim — local play).
    //  - 'typein': the active team types their guess before the reveal and
    //    the server fuzzy-matches it automatically (works for remote play,
    //    nobody has to trust anybody).
    bonusMode: bonusMode === 'typein' ? 'typein' : 'vote',
    // If on, a draw never offers a year already present in the drawing
    // team's own timeline (removes the "free" wider tie-acceptance window
    // for that coincidence). Off by default — same as always.
    noDuplicateYears: !!noDuplicateYears,
    stealIntentTimeoutMs: Math.min(30000, Math.max(1000, stealIntentTimeoutMs || DEFAULT_INTENT_TIMEOUT_MS)),
    stealPlaceTimeoutMs: Math.min(60000, Math.max(1000, stealPlaceTimeoutMs || DEFAULT_PLACE_TIMEOUT_MS)),
    // Two teams both wanting to bet on the SAME spot:
    //  - 'block' (default, original behavior): the second team to try it
    //    gets rejected and must bet somewhere else instead.
    //  - 'void': both are allowed to bet the same spot; if it turns out to
    //    be the genuinely correct one, the tie means NEITHER team steals
    //    the card (both spent a token for nothing) — no one is forced into
    //    a guaranteed-wrong guess just because someone clicked first, but
    //    clashing with another team costs you the steal either way.
    stealTieMode: stealTieMode === 'void' ? 'void' : 'block',
    // Randomizes which team goes first (and the turn order after that) once
    // at startGame(), so the team array's creation order — otherwise always
    // team 0 first, every single game — doesn't quietly hand the same team
    // a first-move advantage round after round. On by default.
    shuffleTeamOrder: shuffleTeamOrder !== false,
    teams,
    turnIndex: 0,
    // lobby -> ready -> listening -> placed -> revealed -> gameover
    phase: 'lobby',
    currentCard: null,
    selectedGap: null,
    lastResult: null,

    // --- steal flow (phase 'placed') ---
    // 'intent' (deciding who wants to steal) -> 'placing' (those teams pick
    // a spot) -> null (resolved). Cleared on every draw().
    stealStage: null,
    stealIntents: {}, // teamId -> 'wants' | 'passed', intent stage only
    stealPlacements: [], // [{teamId, gap}], placing stage only, submission order
    stealEligibleTeamIds: [],
    stealWantTeamIds: [],
    stealDeadline: null, // ms epoch, for clients to render a countdown
    stealTimer: null,

    // --- bonus (title+artist) ---
    bonusClaimed: false, // vote mode: active team claims it, before reveal
    bonusGuess: null, // typein mode: {artist, title}, before reveal
    bonusResolved: null, // null | true | false — final outcome, either mode
    bonusVoteStage: false, // vote mode: are we in the post-reveal voting window?
    bonusVotes: {}, // vote mode: teamId -> boolean
    bonusVoteEligibleTeamIds: [],
    bonusDeadline: null,
    bonusVoteTimer: null,

    pools: {},
    sockets: new Set(),
    createdAt: Date.now(),
    // Optional: one device (plugged into a speaker) plays audio for the
    // whole table instead of everyone's phone trying to play it locally.
    audioHost: null,
    audioHostGraceTimer: null,
  };
  rooms.set(code, room);
  addPlayer(room, hostUsername);
  return room;
}

// Any room member picks their own playlist(s) during the lobby — replaces
// the previous selection outright. `playlists` are already-resolved
// {id, name, tracks} objects (server.js looks them up by id).
function setPlayerPlaylists(room, username, playlists) {
  if (room.phase !== 'lobby') throw err('bad_phase');
  if (!room.teams.some((t) => t.members.includes(username))) throw err('not_in_room');
  room.playerSelections[username] = playlists;
}

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase());
}

// For reconnects: someone whose phone died mid-game, closed the tab, or
// just reopened the app needs to find their way back without a room code.
// Picks the most recently created room they're a member of, in case they
// somehow ended up in more than one.
function findRoomForUser(username) {
  let best = null;
  for (const room of rooms.values()) {
    if (room.teams.some((t) => t.members.includes(username))) {
      if (!best || room.createdAt > best.createdAt) best = room;
    }
  }
  return best;
}

// For Nearby/local play, where there are no accounts and no room codes to
// type: at most one room is ever active on a given host device at a time,
// so "the room a new arrival should join" just means whichever one was
// created most recently (see /api/local/join in server.js).
function mostRecentRoom() {
  let best = null;
  for (const room of rooms.values()) {
    if (!best || room.createdAt > best.createdAt) best = room;
  }
  return best;
}

function findPlayerTeam(room, username) {
  return room.teams.find((t) => t.members.includes(username));
}

// New players join whichever team currently has the fewest members
// (ties -> lowest team index), so a room fills out evenly without anyone
// having to coordinate who goes where.
function addPlayer(room, username) {
  if (findPlayerTeam(room, username)) return;
  let target = room.teams[0];
  for (const t of room.teams) if (t.members.length < target.members.length) target = t;
  target.members.push(username);
}

function switchTeam(room, username, teamId) {
  if (room.phase !== 'lobby') throw err('bad_phase');
  const team = room.teams.find((t) => t.id === teamId);
  if (!team) throw err('team_not_found');
  const current = findPlayerTeam(room, username);
  if (!current) throw err('not_in_room');
  if (current.id === teamId) return;
  current.members = current.members.filter((u) => u !== username);
  team.members.push(username);
}

// Any player can claim/release this — it's a convenience toggle for "my
// phone is the one plugged into the speaker", not a privileged role.
function setAudioHost(room, username, enable) {
  if (enable) {
    if (!room.teams.some((t) => t.members.includes(username))) throw err('not_in_room');
    clearTimeout(room.audioHostGraceTimer);
    room.audioHost = username;
  } else if (room.audioHost === username) {
    clearTimeout(room.audioHostGraceTimer);
    room.audioHost = null;
  }
}

// Called when the audio-host's last open socket disconnects. Doesn't clear
// the role immediately — a dropped WebSocket is routine (screen lock, brief
// network hiccup, app backgrounded) and the same device reconnects itself
// within a second or two in the normal case. Only give up the role if
// nobody with that username is back within the grace window.
function scheduleAudioHostGraceCheck(room, username, broadcastFn) {
  if (room.audioHost !== username) return;
  clearTimeout(room.audioHostGraceTimer);
  room.audioHostGraceTimer = setTimeout(() => {
    const stillGone = !room.teams.some((t) => t.members.includes(username)) || room.audioHost !== username;
    if (stillGone) return;
    const hasOpenSocket = [...room.sockets].some((s) => s.__username === username);
    if (!hasOpenSocket) {
      room.audioHost = null;
      broadcastFn(room);
    }
  }, AUDIO_HOST_GRACE_MS);
}

function startGame(room, username) {
  if (room.hostUsername !== username) throw err('not_host');
  if (room.phase !== 'lobby') throw err('bad_phase');
  // Empty teams never get a turn — drop them for this game rather than
  // stalling on a team nobody joined.
  room.teams = room.teams.filter((t) => t.members.length > 0);
  if (room.teams.length < 2) throw err('need_more_teams');
  // Randomize turn order once, here — not on every reshuffle/redraw — so it
  // stays fixed for the rest of this game. Team identity (name/color) stays
  // with each team object; only the array position (i.e. turnIndex order)
  // changes.
  if (room.shuffleTeamOrder) room.teams = shuffle(room.teams);

  // Build per-player pools, but first dedupe by track id ACROSS THE WHOLE
  // ROOM: two people might have the same song in their own playlists (very
  // likely for a shared "party hits" taste), and without this a song could
  // be drawn twice in one game — once from each of their pools. Every track
  // id ends up owned by exactly one (randomly chosen, among whoever has it)
  // player, so it can only ever be drawn once, period.
  const perMemberTracks = {};
  for (const t of room.teams) {
    for (const member of t.members) {
      const selection = room.playerSelections[member] || [];
      perMemberTracks[member] = [].concat(...selection.map((p) => p.tracks));
    }
  }
  const byTrackId = new Map(); // id -> { track, owners: [username,...] }
  for (const [username_, tracks] of Object.entries(perMemberTracks)) {
    for (const track of tracks) {
      if (!byTrackId.has(track.id)) byTrackId.set(track.id, { track, owners: [] });
      byTrackId.get(track.id).owners.push(username_);
    }
  }
  const finalTracks = {};
  for (const u of Object.keys(perMemberTracks)) finalTracks[u] = [];
  for (const { track, owners } of byTrackId.values()) {
    const chosen = owners[crypto.randomInt(owners.length)];
    finalTracks[chosen].push(track);
  }

  // Stratified pools: drawing a card first picks a TEAM (uniformly, among
  // teams with any drawable song left), then a PLAYER within that team
  // (uniformly), then a song from theirs. A team with three contributing
  // members carries no more weight in the overall game than a team with
  // one — and within a team, no single member dominates either.
  room.pools = {};
  for (const [u, tracks] of Object.entries(finalTracks)) {
    if (tracks.length) room.pools[u] = shuffle(tracks);
  }
  if (Object.keys(room.pools).length === 0) throw err('no_playlists_selected');

  for (const t of room.teams) {
    const starter = drawFromPools(room);
    if (starter) t.timeline.push(starter);
  }
  room.phase = 'ready';
}

function remainingCount(room) {
  return Object.values(room.pools).reduce((s, q) => s + q.length, 0);
}

function pickOnce(room) {
  const eligibleTeams = room.teams.filter((t) => t.members.some((m) => room.pools[m] && room.pools[m].length > 0));
  if (eligibleTeams.length === 0) return null;
  const team = eligibleTeams[crypto.randomInt(eligibleTeams.length)];
  const eligibleMembers = team.members.filter((m) => room.pools[m] && room.pools[m].length > 0);
  const member = eligibleMembers[crypto.randomInt(eligibleMembers.length)];
  return { member, card: room.pools[member].pop() };
}

function drawFromPools(room, excludeYears) {
  if (!excludeYears || excludeYears.size === 0) {
    const picked = pickOnce(room);
    return picked ? picked.card : null;
  }
  // "No duplicate years": try a bounded number of draws for a card whose
  // year isn't already in the active team's timeline, setting colliding
  // ones aside and restoring them afterward so they're still in play for
  // other turns.
  const setAside = [];
  let result = null;
  for (let i = 0; i < 200; i++) {
    const picked = pickOnce(room);
    if (!picked) break;
    if (!excludeYears.has(picked.card.y)) { result = picked.card; break; }
    setAside.push(picked);
  }
  for (const { member, card } of setAside) {
    room.pools[member] = room.pools[member] || [];
    room.pools[member].push(card);
  }
  if (!result) {
    const picked = pickOnce(room);
    result = picked ? picked.card : null;
  }
  return result;
}

function activeTeam(room) {
  return room.teams[room.turnIndex];
}

function assertTurn(room, username) {
  const t = activeTeam(room);
  if (!t || !t.members.includes(username)) throw err('not_your_turn');
}

function clearRoundTimers(room) {
  clearTimeout(room.stealTimer);
  clearTimeout(room.bonusVoteTimer);
  room.stealTimer = null;
  room.bonusVoteTimer = null;
}

function draw(room, username) {
  if (room.phase !== 'ready') throw err('bad_phase');
  assertTurn(room, username);
  clearRoundTimers(room);
  const excludeYears = room.noDuplicateYears
    ? new Set(activeTeam(room).timeline.map((c) => c.y))
    : null;
  const card = drawFromPools(room, excludeYears);
  if (!card) {
    room.phase = 'gameover';
    return;
  }
  room.currentCard = card;
  room.selectedGap = null;
  room.lastResult = null;
  room.stealStage = null;
  room.stealIntents = {};
  room.stealPlacements = [];
  room.stealDeadline = null;
  room.bonusClaimed = false;
  room.bonusGuess = null;
  room.bonusResolved = null;
  room.bonusVoteStage = false;
  room.bonusVotes = {};
  room.bonusDeadline = null;
  room.phase = 'listening';
}

function pickGap(room, username, gap) {
  if (room.phase !== 'listening') throw err('bad_phase');
  assertTurn(room, username);
  if (!Number.isInteger(gap) || gap < 0) throw err('bad_gap');
  room.selectedGap = gap;
}

// Vote mode only: the active team's pre-reveal claim that they also know
// title+artist.
function claimBonus(room, username, claim) {
  if (room.bonusMode !== 'vote') throw err('wrong_bonus_mode');
  if (room.phase !== 'listening') throw err('bad_phase');
  assertTurn(room, username);
  room.bonusClaimed = !!claim;
}

// Type-in mode only: the active team's actual guess, fuzzy-matched
// automatically at reveal time — no one has to trust or hear anyone.
function submitBonusGuess(room, username, artist, title) {
  if (room.bonusMode !== 'typein') throw err('wrong_bonus_mode');
  if (room.phase !== 'listening') throw err('bad_phase');
  assertTurn(room, username);
  const a = String(artist || '').trim().slice(0, 120);
  const t = String(title || '').trim().slice(0, 120);
  room.bonusGuess = (a || t) ? { artist: a, title: t } : null;
}

// Vote mode only: another team's yes/no on whether the claim was true.
function castBonusVote(room, username, correct, broadcastFn) {
  if (room.bonusMode !== 'vote') throw err('wrong_bonus_mode');
  if (!room.bonusVoteStage) throw err('bad_phase');
  const team = findPlayerTeam(room, username);
  if (!team || !room.bonusVoteEligibleTeamIds.includes(team.id)) throw err('not_eligible');
  if (team.id in room.bonusVotes) throw err('already_voted');
  room.bonusVotes[team.id] = !!correct;
  maybeFinalizeBonusVote(room, broadcastFn);
}

function maybeFinalizeBonusVote(room, broadcastFn) {
  const allVoted = room.bonusVoteEligibleTeamIds.every((tid) => tid in room.bonusVotes);
  if (allVoted) {
    clearTimeout(room.bonusVoteTimer);
    finalizeBonusVote(room);
  }
}

function finalizeBonusVote(room) {
  // A team that never votes is counted as "yes" — silence is read as no
  // objection, benefit of the doubt, rather than costing the claim.
  for (const tid of room.bonusVoteEligibleTeamIds) {
    if (!(tid in room.bonusVotes)) room.bonusVotes[tid] = true;
  }
  const votes = Object.values(room.bonusVotes);
  const yes = votes.filter(Boolean).length;
  const no = votes.length - yes;
  const passed = yes >= no; // with silent teams defaulted to yes, only an explicit "no" majority denies it
  room.bonusResolved = passed;
  if (passed) {
    const team = activeTeam(room);
    team.tokens = Math.min(MAX_TOKENS, team.tokens + 1);
  }
  room.bonusVoteStage = false;
  room.bonusDeadline = null;
}

function beginBonusVoteIfNeeded(room, broadcastFn) {
  if (room.bonusMode !== 'vote' || !room.bonusClaimed) return;
  const eligible = room.teams.filter((t) => t.id !== activeTeam(room).id).map((t) => t.id);
  room.bonusVoteEligibleTeamIds = eligible;
  room.bonusVotes = {};
  if (eligible.length === 0) { room.bonusResolved = null; return; } // nobody to vote — leave unresolved, harmless
  room.bonusVoteStage = true;
  room.bonusDeadline = Date.now() + BONUS_VOTE_TIMEOUT_MS;
  room.bonusVoteTimer = setTimeout(() => {
    finalizeBonusVote(room);
    broadcastFn(room);
  }, BONUS_VOTE_TIMEOUT_MS);
}

function resolveTypeinBonus(room, card) {
  if (room.bonusMode !== 'typein' || !room.bonusGuess) return;
  const ok = fuzzyMatch(room.bonusGuess.title, card.t) && fuzzyMatch(room.bonusGuess.artist, card.a);
  room.bonusResolved = ok;
  if (ok) {
    const team = activeTeam(room);
    team.tokens = Math.min(MAX_TOKENS, team.tokens + 1);
  }
}

// --- steal flow: place -> intent window -> (maybe) placement window -> reveal ---

function placeCard(room, username, broadcastFn) {
  if (room.phase !== 'listening') throw err('bad_phase');
  assertTurn(room, username);
  if (room.selectedGap === null) throw err('no_gap');
  room.phase = 'placed';
  beginIntentWindow(room, broadcastFn);
}

function beginIntentWindow(room, broadcastFn) {
  room.stealStage = 'intent';
  room.stealIntents = {};
  room.stealPlacements = [];
  const eligible = room.teams.filter((t) => t.id !== activeTeam(room).id).map((t) => t.id);
  room.stealEligibleTeamIds = eligible;
  if (eligible.length === 0) { resolveAndReveal(room, broadcastFn); return; }
  room.stealDeadline = Date.now() + room.stealIntentTimeoutMs;
  clearTimeout(room.stealTimer);
  room.stealTimer = setTimeout(() => {
    endIntentWindow(room, broadcastFn);
    broadcastFn(room);
  }, room.stealIntentTimeoutMs);
}

function stealIntent(room, username, wants, broadcastFn) {
  if (room.phase !== 'placed' || room.stealStage !== 'intent') throw err('bad_phase');
  const team = findPlayerTeam(room, username);
  if (!team) throw err('not_in_room');
  if (!room.stealEligibleTeamIds.includes(team.id)) throw err('cannot_challenge_own_turn');
  if (room.stealIntents[team.id]) throw err('already_responded');
  if (wants && team.tokens < 1) throw err('no_tokens');
  room.stealIntents[team.id] = wants ? 'wants' : 'passed';
  const allResponded = room.stealEligibleTeamIds.every((tid) => room.stealIntents[tid]);
  if (allResponded) {
    clearTimeout(room.stealTimer);
    endIntentWindow(room, broadcastFn);
  }
}

function endIntentWindow(room, broadcastFn) {
  const wantIds = room.stealEligibleTeamIds.filter((tid) => room.stealIntents[tid] === 'wants');
  if (wantIds.length === 0) {
    resolveAndReveal(room, broadcastFn);
    return;
  }
  room.stealStage = 'placing';
  room.stealWantTeamIds = wantIds;
  room.stealDeadline = Date.now() + room.stealPlaceTimeoutMs;
  clearTimeout(room.stealTimer);
  room.stealTimer = setTimeout(() => {
    resolveAndReveal(room, broadcastFn);
    broadcastFn(room);
  }, room.stealPlaceTimeoutMs);
}

// Any team that opted "wants to steal" bets one token on a different spot
// in the ACTIVE team's timeline before the reveal. The token is spent the
// moment you bet it, win or lose — matches the official rule.
function challenge(room, username, gap, broadcastFn) {
  if (room.phase !== 'placed' || room.stealStage !== 'placing') throw err('bad_phase');
  const team = findPlayerTeam(room, username);
  if (!team) throw err('not_in_room');
  if (!room.stealWantTeamIds.includes(team.id)) throw err('not_eligible');
  if (room.stealPlacements.some((c) => c.teamId === team.id)) throw err('already_challenged');
  const active = activeTeam(room);
  if (!Number.isInteger(gap) || gap < 0 || gap > active.timeline.length) throw err('bad_gap');
  if (room.stealTieMode === 'block' && room.stealPlacements.some((c) => c.gap === gap)) throw err('spot_taken');
  team.tokens -= 1;
  room.stealPlacements.push({ teamId: team.id, gap });
  const allPlaced = room.stealWantTeamIds.every((tid) => room.stealPlacements.some((c) => c.teamId === tid));
  if (allPlaced) {
    clearTimeout(room.stealTimer);
    resolveAndReveal(room, broadcastFn);
  }
}

function resolveAndReveal(room, broadcastFn) {
  clearTimeout(room.stealTimer);
  room.stealTimer = null;
  const team = activeTeam(room);
  const tl = team.timeline;
  const g = Math.min(room.selectedGap, tl.length);
  const card = room.currentCard;
  const spotOk = (gap, timeline) => {
    const before = gap > 0 ? timeline[gap - 1].y : -Infinity;
    const after = gap < timeline.length ? timeline[gap].y : Infinity;
    return card.y >= before && card.y <= after;
  };
  const correct = spotOk(g, tl);

  let stolenBy = null;
  if (!correct) {
    const correctBets = room.stealPlacements.filter((c) => spotOk(c.gap, tl));
    if (correctBets.length === 1) {
      stolenBy = correctBets[0].teamId;
    } else if (correctBets.length > 1) {
      // Only possible in 'void' mode (multiple teams allowed to bet the
      // same spot) — a genuine tie on the right answer means neither
      // steals; both already paid their token for the attempt.
      stolenBy = null;
    }
  }

  room.lastResult = { correct, card, stolenBy, challenges: room.stealPlacements };
  if (correct) {
    tl.splice(g, 0, card);
  } else if (stolenBy) {
    const thief = room.teams.find((t) => t.id === stolenBy);
    let idx = 0;
    while (idx < thief.timeline.length && thief.timeline[idx].y < card.y) idx++;
    thief.timeline.splice(idx, 0, card);
    team.misses++;
  } else {
    team.misses++;
  }
  room.stealStage = null;
  room.stealDeadline = null;
  room.phase = 'revealed';

  resolveTypeinBonus(room, card);
  beginBonusVoteIfNeeded(room, broadcastFn);
}

function next(room, username) {
  if (room.phase !== 'revealed') throw err('bad_phase');
  assertTurn(room, username);
  if (room.bonusVoteStage) throw err('bonus_unresolved');
  // A steal means the THIEF's timeline is the one that grew this turn, not
  // the active team's — check whichever team actually received the card.
  const winner = room.lastResult && room.lastResult.stolenBy
    ? room.teams.find((t) => t.id === room.lastResult.stolenBy)
    : activeTeam(room);
  if (winner.timeline.length >= room.target) {
    room.phase = 'gameover';
    return;
  }
  if (remainingCount(room) === 0) {
    room.phase = 'gameover';
    return;
  }
  room.turnIndex = (room.turnIndex + 1) % room.teams.length;
  room.currentCard = null;
  room.selectedGap = null;
  room.lastResult = null;
  room.stealStage = null;
  room.stealIntents = {};
  room.stealPlacements = [];
  room.stealDeadline = null;
  room.bonusClaimed = false;
  room.bonusGuess = null;
  room.bonusResolved = null;
  room.bonusVoteStage = false;
  room.bonusVotes = {};
  room.bonusDeadline = null;
  room.phase = 'ready';
}

// `viewerUsername` scopes fields that are secret until commit — currently
// just the active team's own in-progress (not yet placed) gap pick. Without
// this, the raw WebSocket payload leaked it to every other team's browser
// the instant it changed, even though the client only ever rendered it for
// the active team itself. Relying on client-side rendering to hide server
// data isn't real secrecy, so the field itself is nulled out here instead.
function publicState(room, viewerUsername) {
  const active = activeTeam(room);
  const viewerTeam = viewerUsername ? findPlayerTeam(room, viewerUsername) : null;
  const gapVisible = room.phase !== 'listening' || (!!viewerTeam && !!active && viewerTeam.id === active.id);
  return {
    code: room.code,
    name: room.name,
    hostUsername: room.hostUsername,
    target: room.target,
    bonusMode: room.bonusMode,
    noDuplicateYears: room.noDuplicateYears,
    stealIntentTimeoutMs: room.stealIntentTimeoutMs,
    stealPlaceTimeoutMs: room.stealPlaceTimeoutMs,
    stealTieMode: room.stealTieMode,
    phase: room.phase,
    turnIndex: room.turnIndex,
    teams: room.teams.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      members: t.members,
      timeline: t.timeline,
      misses: t.misses,
      tokens: t.tokens,
    })),
    // Metadata is withheld from EVERYONE (not just the guessing team) until
    // reveal — that's the whole game. Only the track id leaks early, so
    // audio can play.
    currentCard:
      room.phase === 'revealed'
        ? room.currentCard
        : room.currentCard
        ? { id: room.currentCard.id }
        : null,
    selectedGap: gapVisible ? room.selectedGap : null,
    stealStage: room.stealStage,
    // Who's responded is visible live (so the table sees the tension); the
    // guessed SPOT stays hidden — same treatment as the card — until
    // reveal, where the full lastResult.challenges carries it.
    stealEligibleTeamIds: room.stealEligibleTeamIds,
    stealRespondedTeamIds: Object.keys(room.stealIntents),
    stealWantTeamIds: room.stealWantTeamIds,
    stealPlacedTeamIds: room.stealPlacements.map((c) => c.teamId),
    stealDeadline: room.stealDeadline,
    bonusClaimed: room.bonusClaimed,
    bonusGuessSubmitted: !!room.bonusGuess,
    bonusResolved: room.bonusResolved,
    bonusVoteStage: room.bonusVoteStage,
    bonusVoteEligibleTeamIds: room.bonusVoteEligibleTeamIds,
    bonusVotedTeamIds: Object.keys(room.bonusVotes),
    bonusDeadline: room.bonusDeadline,
    lastResult: room.lastResult,
    deckRemaining: remainingCount(room),
    // {username: [{id, name, count}]} — what everyone has picked so far,
    // visible to the whole room so it's obvious who still needs to choose.
    playerSelections: Object.fromEntries(
      Object.entries(room.playerSelections).map(([u, sel]) => [
        u,
        sel.map((p) => ({ id: p.id, name: p.name, count: p.tracks.length })),
      ])
    ),
    audioHost: room.audioHost,
  };
}

function broadcast(room) {
  // Per-socket, not one shared message — publicState() scopes some fields
  // to the viewer's own team (see its comment), so each socket needs its
  // own serialization rather than one broadcast payload for the room.
  for (const ws of room.sockets) {
    if (ws.readyState !== 1) continue;
    ws.send(JSON.stringify({ type: 'state', state: publicState(room, ws.__username) }));
  }
}

module.exports = {
  createRoom,
  getRoom,
  findRoomForUser,
  mostRecentRoom,
  addPlayer,
  switchTeam,
  setPlayerPlaylists,
  setAudioHost,
  scheduleAudioHostGraceCheck,
  startGame,
  draw,
  pickGap,
  placeCard,
  stealIntent,
  challenge,
  claimBonus,
  submitBonusGuess,
  castBonusVote,
  next,
  publicState,
  broadcast,
  MIN_TEAMS,
  MAX_TEAMS,
};
