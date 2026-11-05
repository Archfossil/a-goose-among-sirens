'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, TIMERS } = require('../src/game');

/** Manual clock: timers only fire when the test advances time. */
function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    set: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clear: (id) => { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.has(id)) { timers.delete(id); t.fn(); }
      }
    },
    pending: () => timers.size,
  };
}

function room3(mode, settings = {}, clock = fakeClock()) {
  const room = new Room('TEST', { clock, rng: () => 0.42 });
  ['Ann', 'Bo', 'Cy'].forEach((n, i) => room.addPlayer(`p${i}`, n));
  room.setMode(mode);
  room.setSettings(settings);
  return { room, clock };
}

const yt = (i) => `https://youtu.be/abcdefghi${String(i).padStart(2, '0')}`;

test('timers are off by default', () => {
  const { room, clock } = room3('loose');
  room.start();
  assert.equal(room.view(null).timer, null);
  assert.equal(clock.pending(), 0);
});

test('timers auto-advance submit -> listen -> reveal in A Goose is Loose', () => {
  const { room, clock } = room3('loose', { timers: true, promptsPerPlayer: 1 });
  room.start();
  const t = room.view('p0').timer;
  assert.ok(t, 'phones see the countdown');
  assert.equal(t.deadline - t.now, TIMERS.perSong * 1000);

  room.submit('p0', 0, yt(1));
  room.submit('p1', 0, yt(2));
  clock.advance(TIMERS.perSong * 1000 - 1);
  assert.equal(room.phase, 'submit');
  clock.advance(1);
  assert.equal(room.phase, 'listen', 'stragglers are skipped when time runs out');
  assert.equal(room.g.queue.length, 2);

  // Guess timer restarts for each song.
  assert.equal(room.view(null).timer.deadline - clock.now(), TIMERS.guess * 1000);
  clock.advance(TIMERS.guess * 1000);
  assert.equal(room.phase, 'reveal');
  assert.equal(room.view(null).timer, null, 'reveal is not timed');
  room.next();
  assert.equal(room.phase, 'listen');
  assert.equal(room.view(null).timer.deadline - clock.now(), TIMERS.guess * 1000);
});

test('host can add 30 seconds', () => {
  const { room, clock } = room3('secret', { timers: true });
  room.start();
  const before = room.deadline;
  room.extendTimer(30);
  assert.equal(room.deadline, before + 30000);
  clock.advance(TIMERS.perSong * 1000);
  assert.equal(room.phase, 'submit', 'extension honoured');
  clock.advance(30000);
  // Nobody submitted -> round skipped; round 2 starts with a fresh timer.
  assert.equal(room.phase, 'submit');
  assert.equal(room.g.round, 1);
});

test('a stale timer never advances a later phase', () => {
  const { room, clock } = room3('king', { timers: true });
  room.start();
  const king = room.g.cur.kingId;
  room.players.filter((p) => p.id !== king).forEach((p, i) => room.submit(p.id, null, yt(i)));
  assert.equal(room.phase, 'listen');
  assert.equal(room.deadline, null, 'King listening is host-paced');
  clock.advance(10 * 60 * 1000);
  assert.equal(room.phase, 'listen');
  room.next(); room.next();
  assert.equal(room.phase, 'judge');
  clock.advance(TIMERS.judge * 1000);
  assert.equal(room.phase, 'reveal', 'King ran out of time: no crown');
  assert.equal(room.g.cur.pick, null);
});

test('back to lobby cancels a running timer', () => {
  const { room, clock } = room3('loose', { timers: true });
  room.start();
  room.backToLobby();
  assert.equal(clock.pending(), 0);
  clock.advance(10 * 60 * 1000);
  assert.equal(room.phase, 'lobby');
});

test('custom prompts are dealt before built-in ones', () => {
  const { room } = room3('loose', { promptsPerPlayer: 1 });
  room.addPrompt('loose', 'What song would you play at a goose wedding?', 'p1');
  room.addPrompt('loose', '  What song   would the sirens request?  ');
  assert.throws(() => room.addPrompt('loose', 'what song would you play at a GOOSE wedding?'), /already/);
  assert.throws(() => room.addPrompt('loose', 'short'), /short/);
  assert.throws(() => room.addPrompt('nope', 'What song is this?'), /mode/);
  assert.deepEqual(room.view('p1').mySuggestions, [{ mode: 'loose', text: 'What song would you play at a goose wedding?' }]);
  assert.equal(room.view(null).custom.loose.length, 2);

  room.start();
  const dealt = room.players.map((p) => room.view(p.id).prompts[0].text);
  assert.ok(dealt.includes('What song would you play at a goose wedding?'));
  assert.ok(dealt.includes('What song would the sirens request?'));
  assert.throws(() => room.addPrompt('loose', 'What song plays mid-game?'), /between games/);
});

test('custom feelings feed Secret Goose; host can remove prompts', () => {
  const { room } = room3('secret');
  const a = room.addPrompt('secret', 'Hangry');
  room.addPrompt('secret', 'Sonder');
  room.removePrompt(a.id);
  assert.throws(() => room.removePrompt(a.id), /Unknown/);
  room.start();
  assert.equal(room.g.cur.prompt, 'Sonder');
});

test('reactions are forwarded, validated and rate limited', () => {
  const { room, clock } = room3('king');
  const events = [];
  room.onEvent = (type, data) => events.push({ type, ...data });
  room.start();
  assert.throws(() => room.react('p0', 'fire'), /music/);
  const king = room.g.cur.kingId;
  room.players.filter((p) => p.id !== king).forEach((p, i) => room.submit(p.id, null, yt(i)));
  assert.equal(room.react('p0', 'honk'), true);
  assert.equal(room.react('p0', 'fire'), false, 'too fast');
  clock.advance(400);
  assert.equal(room.react('p0', 'fire'), true);
  assert.throws(() => room.react('p0', '<img>'), /Unknown/);
  assert.deepEqual(events.map((e) => e.kind), ['honk', 'fire']);
  assert.equal(events[0].name, 'Ann');
});

test('game over includes the full setlist with pickers', () => {
  const { room } = room3('loose', { promptsPerPlayer: 1 });
  room.start();
  room.players.forEach((p, i) => room.submit(p.id, 0, yt(i)));
  while (room.phase !== 'gameover') room.next();
  const v = room.view('p2');
  assert.equal(v.playlist.length, 3);
  assert.deepEqual(new Set(v.playlist.map((t) => t.playerId)), new Set(['p0', 'p1', 'p2']));
  assert.ok(v.playlist.every((t) => t.song.kind === 'youtube' && t.prompt));
  room.start();
  assert.equal(room.view(null).playlist, undefined);
  assert.equal(room.history.length, 0, 'new game, new setlist');
});

test('hats: auto-assigned, changeable, validated', () => {
  const { room } = room3('loose');
  const hats = room.players.map((p) => p.hat);
  assert.equal(new Set(hats).size, 3, 'everyone starts with a different hat');
  assert.ok(!hats.includes('none'));
  room.setHat('p0', 'crown');
  assert.equal(room.view(null).players[0].hat, 'crown');
  assert.equal(room.view('p0').me.hat, 'crown');
  assert.throws(() => room.setHat('p0', '<svg>'), /Unknown hat/);
});

test('players can leave between games but not mid-game', () => {
  const { room } = room3('loose');
  room.addPlayer('p3', 'Dee');
  room.start();
  assert.throws(() => room.leave('p3'), /once this game ends/);
  room.backToLobby();
  room.leave('p3');
  assert.equal(room.players.length, 3);
});

test('awards at game over reflect what happened', () => {
  const { room, clock } = room3('loose', { promptsPerPlayer: 1 });
  room.start();
  room.players.forEach((p, i) => room.submit(p.id, 0, yt(i)));
  // Every song: Bo always guesses right; Ann and Cy guess wrong where possible.
  while (room.phase !== 'gameover') {
    if (room.phase === 'listen') {
      const owner = room.g.queue[room.g.index].playerId;
      room.react('p0', 'fire'); clock.advance(500); room.react('p0', 'fire'); clock.advance(500);
      for (const p of room.players) {
        if (p.id === owner) continue;
        const wrong = room.players.find((q) => q.id !== p.id && q.id !== owner).id;
        room.guess(p.id, p.id === 'p1' ? owner : wrong);
      }
    } else room.next();
  }
  const awards = Object.fromEntries(room.view(null).awards.map((a) => [a.key, a]));
  assert.deepEqual(awards.ears.playerIds, ['p1']);
  assert.equal(awards.ears.detail, '2 correct guesses');
  assert.deepEqual(awards.hype.playerIds, ['p0']);
  assert.ok(awards.crowd, 'most-reacted song gets an award');
  assert.equal(awards.royal, undefined, 'no King Goose awards in this mode');
  assert.ok(room.view(null).playlist.every((t) => t.reactions === 2));
});

// ---------- round 4: audience, favorites, family mode, packs, persistence ----------

test('late joiners become audience and are seated at the next game', () => {
  const { room } = room3('loose', { promptsPerPlayer: 1 });
  room.start();
  const r = room.join('late', 'Latecomer');
  assert.equal(r.audience, true);
  assert.throws(() => room.join('dup', 'latecomer'), /already took/);
  const v = room.view('late');
  assert.equal(v.isAudience, true);
  assert.equal(v.prompts, undefined, 'audience never gets private prompts');
  // Audience can react while music plays.
  room.players.forEach((p, i) => room.submit(p.id, 0, yt(i)));
  assert.equal(room.react('late', 'heart'), true);
  assert.throws(() => room.guess('late', 'p0'), /not in this room/);
  while (room.phase !== 'gameover') room.next();
  assert.ok(!room.getPlayer('late'), 'not on the final scoreboard of a game they did not play');
  assert.ok(room.view('late').playlist.length, 'but they get the setlist');
  room.start();
  assert.ok(room.getPlayer('late'), 'seated when the next game starts');
  assert.equal(room.audience.length, 0);
  assert.equal(room.view('late').isAudience, undefined);
});

test('joining between games with a free seat makes you a player', () => {
  const { room } = room3('loose');
  assert.equal(room.join('p9', 'Nine').audience, false);
});

test('Song of the Night: one heart each, not your own, toggles', () => {
  const { room } = room3('loose', { promptsPerPlayer: 1 });
  room.start();
  room.players.forEach((p, i) => room.submit(p.id, 0, yt(i)));
  assert.throws(() => room.favorite('p0', room.g.queue[0].id), /when the game ends/);
  while (room.phase !== 'gameover') room.next();
  const byOwner = Object.fromEntries(room.history.map((h) => [h.playerId, h.entryId]));
  assert.throws(() => room.favorite('p0', byOwner.p0), /own song/);
  room.favorite('p0', byOwner.p2);
  room.favorite('p1', byOwner.p2);
  room.favorite('p2', byOwner.p0);
  let v = room.view('p0');
  assert.deepEqual(v.songOfTheNight, [byOwner.p2]);
  assert.equal(v.myFavorite, byOwner.p2);
  assert.equal(v.playlist.find((t) => t.entryId === byOwner.p2).favs, 2);
  room.favorite('p0', byOwner.p2); // un-heart
  v = room.view('p0');
  assert.equal(v.myFavorite, null);
  assert.equal(v.favoritesIn, 2);
});

test('family mode keeps crude prompts out', () => {
  const { ADULT } = require('../src/prompts');
  const { room } = room3('king', { family: true, kingCycles: 3 });
  room.start();
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add(room.drawPrompt(require('../src/prompts').KING, 'king'));
  for (const t of seen) assert.ok(!ADULT.has(t), t);
});

test('prompt packs: built-in, import with dedupe, export', () => {
  const { room } = room3('loose');
  const n = room.addPack('roadtrip');
  assert.ok(n >= 10);
  assert.throws(() => room.addPack('roadtrip'), /No new prompts/);
  assert.throws(() => room.addPack('__proto__'), /Unknown pack/);
  const added = room.importPack({ loose: ['What song would you play at a goose wedding?', 'x'], king: 'nope', secret: ['Hangry'] });
  assert.equal(added, 2, 'invalid entries are skipped');
  const out = room.exportPack();
  assert.ok(out.loose.includes('What song would you play at a goose wedding?'));
  assert.ok(out.secret.includes('Hangry'));
});

test('rooms survive a save/restore round trip mid-game', () => {
  const { room } = room3('secret', { timers: true });
  room.addPrompt('secret', 'Sonder');
  room.join('aud', 'Audrey');
  room.start();
  room.submit('p0', null, yt(1));
  const saved = JSON.parse(JSON.stringify(room));
  const clock = fakeClock();
  const back = Room.fromJSON(saved, { clock });
  assert.equal(back.phase, 'submit');
  assert.equal(back.g.cur.prompt, room.g.cur.prompt);
  assert.ok(back.g.cur.subs.p0, 'submissions kept');
  assert.ok(back.deadline, 'countdown re-armed');
  assert.ok(back.players.every((p) => !p.connected));
  back.submit('p1', null, yt(2));
  back.submit('p2', null, yt(3));
  back.submit('aud', null, yt(4)); // joined while seats were free, so Audrey is a player
  assert.equal(back.phase, 'listen', 'game continues normally');
});
