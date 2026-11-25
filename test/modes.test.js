'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, matchGroups, MODES, GameError } = require('../src/game');
const { parseSong } = require('../src/media');

const NEW_MODES = ['fight', 'fake', 'mind', 'chain', 'hot'];

function room3(mode, settings = {}, rng = () => 0.42) {
  const room = new Room('TEST', { rng });
  ['Ann', 'Bo', 'Cy'].forEach((n, i) => room.addPlayer(`p${i}`, n));
  room.setMode(mode);
  room.setSettings(settings);
  return room;
}

const yt = (i) => `https://youtu.be/abcdefghi${String(i).padStart(2, '0')}`;
const score = (room, id) => room.getPlayer(id).score;
const others = (room, id) => room.players.map((p) => p.id).filter((x) => x !== id);

// ---------- Goose Fight ----------

test('Goose Fight: bracket with a bye, anonymous until the reveal, +1 per win and +2 for the champion', () => {
  const room = room3('fight');
  room.start();
  assert.equal(room.phase, 'submit');
  assert.ok(room.view(null).prompt, 'everyone answers the same prompt');
  room.players.forEach((p, i) => room.submit(p.id, null, yt(i)));
  assert.equal(room.phase, 'listen');

  let v = room.view(null);
  assert.equal(v.stage.label, 'Semifinal');
  assert.ok(v.bye, 'odd song out gets a bye');
  assert.equal(v.match.a.ownerId, undefined, 'pickers stay secret during the fight');
  assert.equal(room.nowPlayingId, v.match.a.id);
  room.next();
  assert.equal(room.nowPlayingId, v.match.b.id, 'second fighter plays');
  room.next();
  assert.equal(room.phase, 'vote');

  const ownerOf = (id) => room.entryById(id).playerId;
  const fighters = [ownerOf(v.match.a.id), ownerOf(v.match.b.id)];
  const voter = room.players.map((p) => p.id).find((id) => !fighters.includes(id));
  assert.throws(() => room.vote(fighters[0], v.match.a.id), /Sit this vote out/);
  assert.throws(() => room.vote(voter, 'nope'), /one of the two/);
  room.vote(voter, v.match.b.id);
  assert.equal(room.phase, 'reveal', 'everyone eligible voted');
  v = room.view(null);
  assert.equal(v.result.winner, v.match.b.id);
  assert.equal(v.result.winnerSide.ownerId, fighters[1], 'owners revealed');
  assert.equal(score(room, fighters[1]), 1);
  assert.equal(v.result.champion, null);

  room.next(); // the final: bye vs winner
  v = room.view(null);
  assert.equal(v.stage.label, 'Final');
  room.next(); room.next();
  const finalists = [ownerOf(v.match.a.id), ownerOf(v.match.b.id)];
  const judge = room.players.map((p) => p.id).find((id) => !finalists.includes(id));
  room.vote(judge, v.match.a.id);
  v = room.view(null);
  assert.equal(v.result.champion, v.match.a.id);
  assert.equal(room.fx.kind, 'crown');
  room.next();
  assert.equal(room.phase, 'gameover');
  const awards = room.awards().map((a) => a.key);
  assert.ok(awards.includes('fighter'));
});

test('Goose Fight: a lone song wins by walkover; ties are settled by a coin flip', () => {
  const room = room3('fight');
  room.start();
  room.submit('p0', null, 'Only Song');
  room.next();
  assert.equal(room.phase, 'reveal');
  assert.equal(room.view(null).result.walkover, true);
  assert.equal(score(room, 'p0'), 2);

  const tie = room3('fight');
  tie.start();
  tie.submit('p0', null, 'A');
  tie.submit('p1', null, 'B');
  tie.next(); // close submissions
  tie.next(); tie.next(); // listen to both
  tie.next(); // nobody voted
  assert.equal(tie.view(null).result.tie, true);
  assert.equal(tie.players.reduce((n, p) => n + p.score, 0), 3, 'the coin-flip winner is champion: 1 + 2');
});

// ---------- Fake Prompt ----------

test('Fake Prompt: write fakes, find the real prompt, score for finding it and for fooling others', () => {
  const room = room3('fake');
  room.start();
  room.players.forEach((p, i) => room.submit(p.id, 0, yt(i)));
  assert.equal(room.phase, 'write');
  const entry = room.fakeEntry();
  const owner = entry.playerId;
  const [a, b] = others(room, owner);

  assert.equal(room.view(a).realPrompt, undefined, 'writers never see the real prompt');
  assert.equal(room.view(owner).realPrompt, entry.prompt, 'the picker knows it');
  assert.throws(() => room.writeFake(owner, 'Something'), /your song/);
  assert.throws(() => room.writeFake(a, entry.prompt.toUpperCase()), /basically the real prompt/);
  room.writeFake(a, 'What song plays at a goose funeral?');
  room.writeFake(b, 'What song do you hum in the shower?');
  assert.equal(room.phase, 'vote');

  const v = room.view(a);
  assert.equal(v.choices.length, 3);
  assert.ok(v.choices.every((c) => c.real === undefined && c.authors === undefined), 'no spoilers');
  const mine = v.choices.find((c) => c.mine);
  assert.throws(() => room.vote(a, mine.id), /own fake/);
  const real = room.g.cur.choices.find((c) => c.real);
  const bFake = room.g.cur.choices.find((c) => c.authors.includes(b));
  assert.throws(() => room.vote(owner, real.id), /No voting/);
  room.vote(a, real.id);
  room.vote(b, room.g.cur.choices.find((c) => c.authors.includes(a)).id);
  assert.equal(room.phase, 'reveal');
  assert.equal(score(room, a), 2 + 1, 'found the real one, and fooled b');
  assert.equal(score(room, b), 0);
  assert.ok(room.view(b).choices.find((c) => c.id === bFake.id).authors.includes(b), 'authors revealed');
});

test('Fake Prompt: identical fakes merge; with no fakes the vote is skipped', () => {
  const room = room3('fake');
  room.start();
  room.players.forEach((p, i) => room.submit(p.id, 0, yt(i)));
  const owner = room.fakeEntry().playerId;
  const [a, b] = others(room, owner);
  room.writeFake(a, 'A song for ducks');
  room.writeFake(b, 'a song for DUCKS!');
  assert.equal(room.g.cur.choices.length, 2, 'real + one merged fake');
  room.vote(a, room.g.cur.choices.find((c) => c.real).id);
  room.vote(b, room.g.cur.choices.find((c) => c.real).id);
  room.next(); // next song
  assert.equal(room.phase, 'write');
  room.next(); // nobody wrote anything
  assert.equal(room.phase, 'reveal');
});

// ---------- Flock Mind ----------

test('Flock Mind: matching picks by link, song or artist (but not by a shared word)', () => {
  const mk = (id, song) => ({ id, playerId: id, song });
  const ytSong = { ...parseSong(yt(1)), title: 'The Killers - Mr. Brightside (Official Music Video)', artist: 'TheKillersVEVO' };
  const spSong = { ...parseSong('spotify:track:0eGsygTp906u18L0Oimnem'), title: 'Mr. Brightside', artist: 'The Killers' };
  const entries = [
    mk('a', parseSong('mr brightside - the killers')),
    mk('b', ytSong),
    mk('c', spSong),
    mk('d', parseSong('Hello - Adele')),
    mk('e', parseSong('Earth, Wind & Fire - September')),
    mk('f', parseSong('Ring of Fire - Johnny Cash')),
    mk('g', parseSong(yt(1))), // same video as b, title not looked up yet
  ];
  const groups = matchGroups(entries);
  assert.deepEqual(groups[0].sort(), ['a', 'b', 'c', 'g']);
  assert.ok(groups.some((g) => g.length === 1 && g[0] === 'e'));
  assert.ok(groups.some((g) => g.length === 1 && g[0] === 'f'));
});

test('Flock Mind: +1 for every other player who matched you', () => {
  const room = room3('mind', { mindRounds: 2 });
  room.start();
  room.submit('p0', null, 'Mr Brightside - The Killers');
  room.submit('p1', null, 'The Killers – Mr. Brightside');
  room.submit('p2', null, 'Wonderwall - Oasis');
  assert.equal(room.phase, 'reveal');
  assert.deepEqual([score(room, 'p0'), score(room, 'p1'), score(room, 'p2')], [1, 1, 0]);
  const v = room.view(null);
  assert.equal(v.groups[0].length, 2);
  assert.equal(room.nowPlayingId, v.groups[0][0].id, 'the flock favorite plays');
  room.next();
  assert.equal(room.phase, 'submit');
  assert.equal(room.view(null).round, 2);
  room.next(); // nobody picked: skip the round
  assert.equal(room.phase, 'gameover');
  assert.ok(room.awards().some((a) => a.key === 'hive'));
});

// ---------- Goose Chain ----------

test('Goose Chain: first link is free, links are voted on, broken chains cost a point and reset', () => {
  const room = room3('chain', { chainLaps: 2 });
  room.start();
  const first = room.g.cur.pickerId;
  assert.throws(() => room.submit(others(room, first)[0], null, 'x'), /not your turn/);
  room.submit(first, null, 'Fire - Bruce Springsteen');
  assert.equal(room.phase, 'listen', 'a fresh chain needs no vote');
  assert.equal(room.view(null).chainLength, 1);
  room.next();

  const second = room.g.cur.pickerId;
  assert.notEqual(second, first);
  assert.equal(room.view(null).prev.display, 'Fire - Bruce Springsteen');
  room.submit(second, null, 'Ring of Fire - Johnny Cash');
  assert.equal(room.phase, 'vote');
  assert.throws(() => room.vote(second, 'yes'), /own link/);
  for (const id of others(room, second)) room.vote(id, 'yes');
  assert.equal(room.phase, 'reveal');
  assert.equal(room.view(null).result.held, true);
  assert.equal(score(room, second), 1);
  assert.equal(room.view(null).chainLength, 2);
  room.next();

  const third = room.g.cur.pickerId;
  room.submit(third, null, 'Baby Shark');
  for (const id of others(room, third)) room.vote(id, 'no');
  assert.equal(room.view(null).result.held, false);
  assert.equal(room.fx.kind, 'caught');
  assert.equal(score(room, third), 0, 'never below zero');
  assert.equal(room.view(null).chainLength, 0);
  assert.equal(room.view(null).best, 2);
  room.next();
  assert.equal(room.g.cur.prevId, null, 'next goose starts fresh');
});

// ---------- Honk Take ----------

test('Honk Take: guess the DJ’s rating; exact +2 (and +1 to the DJ), one off +1', () => {
  const room = room3('hot');
  room.start();
  const dj = room.g.cur.pickerId;
  const [a, b] = others(room, dj);
  assert.ok(room.view(a).prompt, 'everyone sees the prompt');
  room.submit(dj, null, yt(3));
  assert.equal(room.phase, 'rate');
  assert.throws(() => room.rate(a, 6), /1 to 5/);
  room.rate(a, 4);
  room.rate(b, 3);
  assert.equal(room.view(null).ratings, undefined, 'ratings stay secret until the reveal');
  room.rate(dj, 4);
  assert.equal(room.phase, 'reveal');
  assert.deepEqual(room.view(null).result, { truth: 4, exact: [a], close: [b] });
  assert.equal(score(room, a), 2);
  assert.equal(score(room, b), 1);
  assert.equal(score(room, dj), 1);
});

test('Honk Take: a DJ who never rates scores nobody', () => {
  const room = room3('hot');
  room.start();
  const dj = room.g.cur.pickerId;
  room.submit(dj, null, 'Song');
  for (const id of others(room, dj)) room.rate(id, 5);
  room.next();
  assert.equal(room.view(null).result.truth, null);
  assert.ok(room.players.every((p) => p.score === 0));
});

// ---------- all modes ----------

test('new modes: custom prompts go to the right list; Goose Chain has none', () => {
  const room = new Room('X');
  assert.equal(MODES.fight.prompts, 'loose');
  assert.equal(MODES.fake.prompts, 'loose');
  room.addPrompt('fight', 'What song plays during a pillow fight?');
  assert.equal(room.custom.loose.length, 1);
  room.addPrompt('mind', 'A song about the ocean');
  room.addPrompt('hot', 'A song you sing in the car');
  assert.equal(room.custom.mind.length, 1);
  assert.equal(room.custom.hot.length, 1);
  assert.throws(() => room.addPrompt('chain', 'Anything at all'), /doesn’t use prompts/);
  const out = room.exportPack();
  assert.deepEqual(out.mind, ['A song about the ocean']);
  const other = new Room('Y');
  assert.equal(other.importPack(out), 3);
  const back = Room.fromJSON(JSON.parse(JSON.stringify(new Room('Z').toJSON())));
  assert.deepEqual(back.custom.hot, []);
});

test('new modes: minimum players are enforced', () => {
  for (const mode of NEW_MODES) {
    const room = new Room('MIN');
    room.setMode(mode);
    room.addPlayer('a', 'Ann');
    room.addPlayer('b', 'Bo');
    if (MODES[mode].minPlayers > 2) assert.throws(() => room.start(), /at least 3/, mode);
    else room.start();
  }
});

function play(room, { participate }) {
  let n = 0;
  for (let steps = 0; room.phase !== 'gameover'; steps++) {
    assert.ok(steps < 400, `${room.mode} got stuck in ${room.phase}`);
    const before = `${room.version}`;
    if (participate) {
      const v = room.view(null);
      for (const p of room.players) {
        try {
          if (room.phase === 'submit') {
            const pv = room.view(p.id);
            if (pv.prompts) pv.prompts.forEach((_, i) => room.submit(p.id, i, yt(++n % 90)));
            else room.submit(p.id, null, `Song ${++n} - Artist ${n % 3}`);
          } else if (room.phase === 'write') room.writeFake(p.id, `Fake prompt number ${++n}`);
          else if (room.phase === 'rate') room.rate(p.id, 1 + (n++ % 5));
          else if (room.phase === 'vote') {
            const pv = room.view(p.id);
            if (room.mode === 'fight') room.vote(p.id, v.match.a.id);
            else if (room.mode === 'fake') room.vote(p.id, pv.choices.find((c) => !c.mine).id);
            else if (room.mode === 'chain') room.vote(p.id, n++ % 2 ? 'yes' : 'no');
          }
        } catch (err) {
          if (!(err instanceof GameError)) throw err;
        }
        if (room.phase === 'gameover') return;
      }
    }
    if (`${room.version}` === before || !participate) {
      if (room.phase !== 'gameover') room.next();
    }
  }
}

test('every new mode plays to the end, with or without anyone taking part, and survives a restart', () => {
  for (const mode of NEW_MODES) {
    for (const participate of [true, false]) {
      let seed = 7;
      const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const room = room3(mode, {}, rng);
      room.addPlayer('p3', 'Di');
      room.addPlayer('p4', 'Ed');
      room.start();
      play(room, { participate });
      assert.equal(room.phase, 'gameover', `${mode} finished`);
      assert.ok(room.view('p0').playlist, 'setlist available');

      // Mid-game save/restore.
      const again = room3(mode, {}, rng);
      again.start();
      if (participate) for (const p of again.players) { try { again.submit(p.id, again.view(p.id).prompts ? 0 : null, yt(5)); } catch { /* not their turn */ } }
      const back = Room.fromJSON(JSON.parse(JSON.stringify(again.toJSON())));
      const strip = ({ now, timer, ...rest }) => rest;
      assert.deepEqual(strip(back.view('p1')), strip(again.view('p1')));
      play(back, { participate });
      assert.equal(back.phase, 'gameover');
    }
  }
});
