const path = require('path');
const crypto = require('crypto');
const express = require('express');

const WORDS = require('./lib/words');
const { getRoom, setRoom, deleteRoom, USE_REDIS } = require('./lib/store');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------- helpers ------------------------------ */

// No 0/O/1/I — people read these codes out loud across a table.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ONLINE_WINDOW_MS = 25000;
const MAX_PLAYERS = 20;

function makeCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function makeId() {
  return crypto.randomBytes(9).toString('base64url');
}

function cleanName(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

function cleanCode(raw) {
  return String(raw == null ? '' : raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
}

/** A word the room has not had recently. */
function pickWord(room) {
  const recent = room.recentWords || (room.recentWords = []);
  let word = WORDS[crypto.randomInt(WORDS.length)];
  for (let tries = 0; tries < 20 && recent.includes(word); tries++) {
    word = WORDS[crypto.randomInt(WORDS.length)];
  }
  recent.push(word);
  if (recent.length > 20) recent.shift();
  return word;
}

/**
 * Pick the imposter(s): a fresh uniform draw every round, independent of every
 * round before it.
 *
 * Deliberately NOT balanced or rotated. Any rule like "not the same person
 * twice" or "whoever has had it least" is information players can reason
 * about — with a small group it narrows the suspects before anyone has said a
 * word. Streaks are the price of a draw nobody can deduce.
 */
function pickImposters(room, count) {
  const pool = room.players.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

/**
 * Express 4 does not catch rejections from async handlers — an unhandled
 * rejection takes the whole process down, and with it every open room.
 * Every async route goes through here.
 */
function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/** Load the room and the acting player, or send the right error. */
async function load(req, res, { requireHost = false } = {}) {
  const code = cleanCode(req.params.code);
  const room = await getRoom(code);
  if (!room) {
    fail(res, 404, 'Room not found. Check the code.');
    return null;
  }
  const playerId = String((req.body && req.body.playerId) || req.query.playerId || '');
  const player = room.players.find((p) => p.id === playerId);
  if (!player) {
    fail(res, 403, 'You are not in this room.');
    return null;
  }
  if (requireHost && room.hostId !== player.id) {
    fail(res, 403, 'Only the room admin can do that.');
    return null;
  }
  player.lastSeen = Date.now();
  return { room, player };
}

/** Remove a player and keep the room coherent. Returns true if room still exists. */
async function removePlayer(room, targetId) {
  room.players = room.players.filter((p) => p.id !== targetId);

  if (room.players.length === 0) {
    await deleteRoom(room.code);
    return false;
  }

  if (room.hostId === targetId) room.hostId = room.players[0].id;

  delete room.votes[targetId];
  for (const voterId of Object.keys(room.votes)) {
    if (room.votes[voterId] === targetId) delete room.votes[voterId];
  }

  // A round without its imposter (or with too few people) can't be finished.
  if (room.phase !== 'lobby' && room.phase !== 'results') {
    const imposterGone = room.imposterIds.some(
      (id) => !room.players.some((p) => p.id === id)
    );
    if (imposterGone || room.players.length < 3) {
      resetToLobby(room);
    } else if (room.phase === 'voting') {
      maybeCloseVoting(room);
    }
  }

  await setRoom(room);
  return true;
}

function resetToLobby(room) {
  room.phase = 'lobby';
  room.word = null;
  room.imposterIds = [];
  room.votes = {};
  room.result = null;
}

function tallyAndFinish(room) {
  const counts = new Map(room.players.map((p) => [p.id, 0]));
  for (const targetId of Object.values(room.votes)) {
    if (counts.has(targetId)) counts.set(targetId, counts.get(targetId) + 1);
  }

  const tally = room.players
    .map((p) => ({ playerId: p.id, name: p.name, votes: counts.get(p.id) || 0 }))
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));

  const top = tally.length ? tally[0].votes : 0;
  const leaders = tally.filter((t) => t.votes === top && top > 0);
  const tie = leaders.length !== 1;
  const eliminatedId = tie ? null : leaders[0].playerId;

  room.result = {
    tally,
    tie,
    eliminatedId,
    caught: Boolean(eliminatedId && room.imposterIds.includes(eliminatedId)),
    imposterIds: room.imposterIds.slice(),
    word: room.word,
    votesCast: Object.keys(room.votes).length,
    playerCount: room.players.length
  };
  room.phase = 'results';
}

function maybeCloseVoting(room) {
  if (room.phase !== 'voting') return;
  const everyoneVoted = room.players.every((p) => room.votes[p.id]);
  if (everyoneVoted) tallyAndFinish(room);
}

/** What a single player is allowed to see. Never leaks roles mid-round. */
function viewFor(room, playerId) {
  const now = Date.now();
  const me = room.players.find((p) => p.id === playerId) || null;
  const inRound = room.phase === 'reveal' || room.phase === 'voting';
  const isImposter = me ? room.imposterIds.includes(me.id) : false;

  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    imposterCount: room.imposterCount,
    hostId: room.hostId,
    updatedAt: room.updatedAt,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId,
      online: now - p.lastSeen < ONLINE_WINDOW_MS,
      hasVoted: room.phase === 'voting' ? Boolean(room.votes[p.id]) : false
    })),
    you: me && {
      id: me.id,
      name: me.name,
      isHost: me.id === room.hostId,
      role: inRound || room.phase === 'results' ? (isImposter ? 'imposter' : 'crew') : null,
      word: inRound && !isImposter ? room.word : null,
      votedFor: room.phase === 'voting' ? room.votes[me.id] || null : null
    },
    votesCast: room.phase === 'voting' ? Object.keys(room.votes).length : 0,
    result: room.phase === 'results' ? room.result : null
  };
}

/* -------------------------------- routes ------------------------------ */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, storage: USE_REDIS ? 'redis' : 'memory' });
});

// Create a room. The creator is the admin.
app.post('/api/rooms', wrap(async (req, res) => {
  const name = cleanName(req.body && req.body.name);
  if (!name) return fail(res, 400, 'Enter your name first.');

  let code = makeCode();
  for (let i = 0; i < 12 && (await getRoom(code)); i++) code = makeCode();
  if (await getRoom(code)) return fail(res, 503, 'Could not create a room, try again.');

  const playerId = makeId();
  const room = {
    code,
    createdAt: Date.now(),
    hostId: playerId,
    phase: 'lobby',
    round: 0,
    imposterCount: 1,
    players: [{ id: playerId, name, lastSeen: Date.now() }],
    word: null,
    imposterIds: [],
    votes: {},
    result: null
  };
  await setRoom(room);
  res.json({ code, playerId, state: viewFor(room, playerId) });
}));

// Join an existing room (or re-join with an id you already hold).
app.post('/api/rooms/:code/join', wrap(async (req, res) => {
  const code = cleanCode(req.params.code);
  const name = cleanName(req.body && req.body.name);
  const existingId = String((req.body && req.body.playerId) || '');
  if (!name) return fail(res, 400, 'Enter your name first.');
  if (code.length !== 4) return fail(res, 400, 'Room codes are 4 characters.');

  const room = await getRoom(code);
  if (!room) return fail(res, 404, 'No room with that code.');

  const known = room.players.find((p) => p.id === existingId);
  if (known) {
    known.name = name;
    known.lastSeen = Date.now();
    await setRoom(room);
    return res.json({ code, playerId: known.id, state: viewFor(room, known.id) });
  }

  if (room.players.length >= MAX_PLAYERS) return fail(res, 409, 'That room is full.');
  if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return fail(res, 409, 'Someone in there is already using that name.');
  }
  if (room.phase !== 'lobby') {
    return fail(res, 409, 'That round is already running — wait for the next one.');
  }

  const playerId = makeId();
  room.players.push({ id: playerId, name, lastSeen: Date.now() });
  await setRoom(room);
  res.json({ code, playerId, state: viewFor(room, playerId) });
}));

// Poll for state. Also doubles as the presence heartbeat.
app.get('/api/rooms/:code', wrap(async (req, res) => {
  const code = cleanCode(req.params.code);
  const room = await getRoom(code);
  if (!room) return fail(res, 404, 'Room not found.');

  const playerId = String(req.query.playerId || '');
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return fail(res, 403, 'You are not in this room.');

  player.lastSeen = Date.now();
  await setRoom(room);
  res.json({ state: viewFor(room, playerId) });
}));

// Admin: how many imposters this round.
app.post('/api/rooms/:code/imposters', wrap(async (req, res) => {
  const ctx = await load(req, res, { requireHost: true });
  if (!ctx) return;
  const { room, player } = ctx;
  if (room.phase !== 'lobby' && room.phase !== 'results') {
    return fail(res, 409, 'Finish this round first.');
  }
  const count = Number(req.body && req.body.count);
  if (![1, 2].includes(count)) return fail(res, 400, 'Pick 1 or 2 imposters.');
  room.imposterCount = count;
  await setRoom(room);
  res.json({ state: viewFor(room, player.id) });
}));

// Admin: deal a word and pick the imposter(s).
app.post('/api/rooms/:code/start', wrap(async (req, res) => {
  const ctx = await load(req, res, { requireHost: true });
  if (!ctx) return;
  const { room, player } = ctx;

  if (room.phase === 'reveal' || room.phase === 'voting') {
    return fail(res, 409, 'A round is already running.');
  }
  if (room.players.length < 3) return fail(res, 409, 'You need at least 3 players.');

  const imposterCount = Math.min(room.imposterCount, Math.max(1, room.players.length - 2));
  const picked = pickImposters(room, imposterCount);

  room.round += 1;
  room.phase = 'reveal';
  room.word = pickWord(room);
  room.imposterIds = picked.map((p) => p.id);
  room.votes = {};
  room.result = null;

  await setRoom(room);
  res.json({ state: viewFor(room, player.id) });
}));

// Admin: open voting.
app.post('/api/rooms/:code/open-voting', wrap(async (req, res) => {
  const ctx = await load(req, res, { requireHost: true });
  if (!ctx) return;
  const { room, player } = ctx;
  if (room.phase !== 'reveal') return fail(res, 409, 'Nothing to vote on yet.');
  room.phase = 'voting';
  room.votes = {};
  await setRoom(room);
  res.json({ state: viewFor(room, player.id) });
}));

// Cast (or change) a vote.
app.post('/api/rooms/:code/vote', wrap(async (req, res) => {
  const ctx = await load(req, res);
  if (!ctx) return;
  const { room, player } = ctx;
  if (room.phase !== 'voting') return fail(res, 409, 'Voting is not open.');

  const targetId = String((req.body && req.body.targetId) || '');
  if (targetId === player.id) return fail(res, 400, 'You cannot vote for yourself.');
  if (!room.players.some((p) => p.id === targetId)) return fail(res, 400, 'Unknown player.');

  room.votes[player.id] = targetId;
  maybeCloseVoting(room);
  await setRoom(room);
  res.json({ state: viewFor(room, player.id) });
}));

// Admin: close voting early and show results.
app.post('/api/rooms/:code/close-voting', wrap(async (req, res) => {
  const ctx = await load(req, res, { requireHost: true });
  if (!ctx) return;
  const { room, player } = ctx;
  if (room.phase !== 'voting') return fail(res, 409, 'Voting is not open.');
  tallyAndFinish(room);
  await setRoom(room);
  res.json({ state: viewFor(room, player.id) });
}));

// Admin: back to the lobby (lets new people join).
app.post('/api/rooms/:code/lobby', wrap(async (req, res) => {
  const ctx = await load(req, res, { requireHost: true });
  if (!ctx) return;
  const { room, player } = ctx;
  resetToLobby(room);
  await setRoom(room);
  res.json({ state: viewFor(room, player.id) });
}));

// Admin: remove someone.
app.post('/api/rooms/:code/kick', wrap(async (req, res) => {
  const ctx = await load(req, res, { requireHost: true });
  if (!ctx) return;
  const { room, player } = ctx;
  const targetId = String((req.body && req.body.targetId) || '');
  if (targetId === player.id) return fail(res, 400, 'Use Leave room instead.');
  if (!room.players.some((p) => p.id === targetId)) return fail(res, 400, 'Unknown player.');
  await removePlayer(room, targetId);
  res.json({ state: viewFor(room, player.id) });
}));

// Leave for good.
app.post('/api/rooms/:code/leave', wrap(async (req, res) => {
  const ctx = await load(req, res);
  if (!ctx) return;
  const { room, player } = ctx;
  await removePlayer(room, player.id);
  res.json({ ok: true });
}));

app.use('/api', (req, res) => fail(res, 404, 'Unknown endpoint.'));

// Anything else: hand back the app shell.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something broke on the server.' });
});

module.exports = app;
