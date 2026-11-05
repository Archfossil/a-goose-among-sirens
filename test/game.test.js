'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Room } = require('../src/game');
const { parseSong } = require('../src/media');

// Deterministic RNG so games are reproducible.
function seeded(seed = 42) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRoom(n = 4, mode = 'loose', settings = {}) {
  const room = new Room('TEST', { rng: seeded() });
  for (let i = 0; i < n; i++) room.addPlayer(`p${i}`, `Player${i}`);
  room.setMode(mode);
  room.setSettings(settings);
  return room;
}

const yt = (i) => `https://youtu.be/abcdefghi${String(i).padStart(2, '0')}`;

// ---------- lobby ----------

test('lobby rules: names, min players, mode lock', () => {
  const room = new Room('TEST');
  room.addPlayer('a', 'Ann');
  assert.throws(() => room.addPlayer('b', 'ann'), /already took/);
  assert.throws(() => room.addPlayer('c', '   '), /name/);
  room.addPlayer('b', 'Bo');
  assert.throws(() => room.start(), /at least 3/);
  room.addPlayer('c', 'Cy');
  room.start();
  assert.equal(room.phase, 'submit');
  assert.throws(() => room.addPlayer('d', 'Di'), /in progress/);
  assert.throws(() => room.setMode('king'), /lobby/);
});

test('settings are clamped', () => {
  const room = makeRoom(3);
  room.setSettings({ promptsPerPlayer: 99, secretRounds: -4, kingCycles: 'x' });
  assert.deepEqual(room.settings, { promptsPerPlayer: 3, kingCycles: 1, secretRounds: 1, timers: false, family: false });
});

// ---------- A Goose is Loose! ----------

test('A Goose is Loose: full game, scoring and secrecy', () => {
  const room = makeRoom(3, 'loose', { promptsPerPlayer: 2 });
  room.start();

  // Each player sees only their own prompts; host sees none.
  const v0 = room.view('p0');
  assert.equal(v0.prompts.length, 2);
  assert.equal(room.view(null).prompts, undefined);

  // Every player gets distinct prompts.
  const all = room.players.flatMap((p) => room.view(p.id).prompts.map((x) => x.text));
  assert.equal(new Set(all).size, all.length);

  let n = 0;
  for (const p of room.players) for (let i = 0; i < 2; i++) room.submit(p.id, i, yt(n++));
  assert.equal(room.phase, 'listen', 'auto-advances once everyone is done');
  assert.equal(room.g.queue.length, 6);
  assert.ok(room.view(null).nowPlaying, 'host has a song to play');

  // Play through every song: everyone guesses the true owner except p2, who guesses wrong.
  const expected = { p0: 0, p1: 0, p2: 0 };
  for (let i = 0; i < 6; i++) {
    const owner = room.g.queue[room.g.index].playerId;
    const hostView = room.view(null);
    assert.equal(hostView.result, undefined, 'owner is not leaked before reveal');
    assert.ok(!JSON.stringify(hostView).includes(`"ownerId"`));
    assert.throws(() => room.guess(owner, owner), /your song/);
    for (const p of room.players) {
      if (p.id === owner) continue;
      const wrong = room.players.find((q) => q.id !== p.id && q.id !== owner).id;
      const target = p.id === 'p2' ? wrong : owner;
      if (target === owner) expected[p.id]++;
      room.guess(p.id, target);
    }
    assert.equal(room.phase, 'reveal');
    assert.equal(room.view(null).result.ownerId, owner);
    room.next();
  }
  assert.equal(room.phase, 'gameover');
  for (const p of room.players) assert.equal(p.score, expected[p.id], p.name);
});

test('A Goose is Loose: host can force past missing submissions', () => {
  const room = makeRoom(3, 'loose', { promptsPerPlayer: 1 });
  room.start();
  room.submit('p0', 0, 'Toxic – Britney Spears');
  room.next();
  assert.equal(room.phase, 'listen');
  assert.equal(room.g.queue.length, 1);
  room.next(); // force reveal with zero guesses
  assert.equal(room.phase, 'reveal');
  room.next();
  assert.equal(room.phase, 'gameover');
});

test('A Goose is Loose: nobody submits -> game over', () => {
  const room = makeRoom(3, 'loose', { promptsPerPlayer: 1 });
  room.start();
  room.next();
  assert.equal(room.phase, 'gameover');
});

// ---------- King Goose ----------

test('King Goose: everyone is King once, King crowns a winner', () => {
  const room = makeRoom(4, 'king');
  room.start();
  const kings = [];
  let n = 0;
  while (room.phase !== 'gameover') {
    const kingId = room.g.cur.kingId;
    kings.push(kingId);
    assert.throws(() => room.submit(kingId, null, yt(n++)), /King/);
    const subjects = room.players.filter((p) => p.id !== kingId);
    for (const p of subjects) room.submit(p.id, null, yt(n++));
    assert.equal(room.phase, 'listen');

    // Owners are hidden from everyone during listening & judging.
    while (room.phase === 'listen') room.next();
    assert.equal(room.phase, 'judge');
    const v = room.view(kingId);
    assert.equal(v.tracks.length, 3);
    assert.ok(v.tracks.every((t) => t.ownerId === undefined));
    assert.throws(() => room.judge(subjects[0].id, v.tracks[0].id), /Only King/);

    const pickEntry = room.entryById(v.tracks[0].id);
    const before = room.getPlayer(pickEntry.playerId).score;
    room.judge(kingId, v.tracks[0].id);
    assert.equal(room.phase, 'reveal');
    assert.equal(room.getPlayer(pickEntry.playerId).score, before + 1);
    assert.equal(room.view(null).winnerId, pickEntry.playerId);
    room.next();
  }
  assert.deepEqual([...kings].sort(), ['p0', 'p1', 'p2', 'p3']);
  assert.equal(room.players.reduce((s, p) => s + p.score, 0), 4);
});

test('King Goose: host can replay heard songs but not peek ahead', () => {
  const room = makeRoom(3, 'king');
  room.start();
  const kingId = room.g.cur.kingId;
  room.players.filter((p) => p.id !== kingId).forEach((p, i) => room.submit(p.id, null, yt(i)));
  const q = room.g.cur.queue;
  assert.throws(() => room.play(q[1].id), /hasn/);
  room.next();
  room.play(q[0].id);
  assert.equal(room.view(null).nowPlaying.entryId, q[0].id);
});

// ---------- Secret Goose ----------

test('Secret Goose: goose never sees the prompt until reveal; scoring', () => {
  const room = makeRoom(4, 'secret', { secretRounds: 2 });
  room.start();

  // Round 1: everyone catches the goose.
  let goose = room.g.cur.gooseId;
  const prompt = room.g.cur.prompt;
  assert.equal(room.view(goose).prompt, undefined);
  assert.equal(room.view(goose).isGoose, true);
  assert.equal(room.view(null).prompt, undefined, 'host screen is public: no prompt yet');
  const other = room.players.find((p) => p.id !== goose).id;
  assert.equal(room.view(other).prompt, prompt);

  room.players.forEach((p, i) => room.submit(p.id, null, yt(i)));
  assert.equal(room.phase, 'listen');
  while (room.phase === 'listen') room.next();
  assert.equal(room.phase, 'defend');
  assert.equal(room.view(goose).prompt, prompt, 'revealed at defend');
  assert.equal(room.view(null).gooseId, undefined, 'goose identity still hidden');
  room.next();
  assert.equal(room.phase, 'vote');
  assert.throws(() => room.vote(goose, goose), /other players/);
  for (const p of room.players) {
    room.vote(p.id, p.id === goose ? other : goose);
  }
  assert.equal(room.phase, 'reveal');
  assert.equal(room.g.cur.result.caught, true);
  for (const p of room.players) assert.equal(p.score, p.id === goose ? 0 : 1);

  // Round 2: nobody catches the (new) goose -> goose +2.
  room.next();
  const goose2 = room.g.cur.gooseId;
  assert.notEqual(goose2, goose, 'goose rotates');
  const before = room.getPlayer(goose2).score;
  room.players.forEach((p, i) => room.submit(p.id, null, yt(i + 10)));
  while (room.phase === 'listen') room.next();
  room.next(); // defend -> vote
  const scapegoat = room.players.find((p) => p.id !== goose2).id;
  for (const p of room.players) room.vote(p.id, p.id === scapegoat ? goose2 : scapegoat);
  // Only the scapegoat voted for the goose: 1 of 3 -> escaped.
  assert.equal(room.g.cur.result.caught, false);
  assert.equal(room.getPlayer(goose2).score, before + 2);
  room.next();
  assert.equal(room.phase, 'gameover');
});

test('back to lobby resets the game', () => {
  const room = makeRoom(3, 'secret');
  room.start();
  room.backToLobby();
  assert.equal(room.phase, 'lobby');
  assert.equal(room.g, null);
  room.setMode('king');
  room.start();
  assert.equal(room.phase, 'submit');
});

// ---------- media ----------

test('parseSong understands YouTube, Spotify and plain text', () => {
  const a = parseSong('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s');
  assert.equal(a.kind, 'youtube'); assert.equal(a.id, 'dQw4w9WgXcQ'); assert.equal(a.start, 43);
  assert.equal(parseSong('youtu.be/dQw4w9WgXcQ?t=1m5s').start, 65);
  assert.equal(parseSong('https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=xyz').id, 'dQw4w9WgXcQ');
  assert.equal(parseSong('https://m.youtube.com/shorts/dQw4w9WgXcQ').id, 'dQw4w9WgXcQ');

  const s = parseSong('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=abc');
  assert.equal(s.kind, 'spotify'); assert.equal(s.type, 'track'); assert.equal(s.id, '4uLU6hMCjMI75M1A2tKUQC');
  assert.equal(parseSong('spotify:album:4uLU6hMCjMI75M1A2tKUQC').type, 'album');

  const t = parseSong('  Toxic   –  Britney Spears ');
  assert.equal(t.kind, 'text'); assert.equal(t.display, 'Toxic – Britney Spears');

  assert.throws(() => parseSong(''), /Paste/);
  assert.throws(() => parseSong('https://evil.example.com/x'), /YouTube or Spotify/);
  assert.throws(() => parseSong('https://youtube.com/watch?v=<script>'), /YouTube/);
  assert.throws(() => parseSong('https://open.spotify.com/artist/4uLU6hMCjMI75M1A2tKUQC'), /Spotify/);
});
