'use strict';
// Server-authoritative game logic for all three modes in the design doc.
// A Room is a pure state machine: no networking, so it is easy to test.

const PROMPTS = require('./prompts');
const { parseSong } = require('./media');
const { GameError } = require('./errors');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;
// Goose is Loose: how many unanswered prompts each player may trade in per game.
const SWAPS_PER_GAME = 2;
const COLORS = [
  '#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#ff9f1c',
  '#f72585', '#90be6d', '#e9c46a', '#a0c4ff', '#ffadad', '#caffbf',
];

// Optional countdowns (seconds). Submit time scales with how many songs a player owes.
const TIMERS = { perSong: 75, guess: 30, judge: 45, vote: 40 };
const REACTIONS = ['fire', 'laugh', 'cry', 'mindblown', 'skull', 'heart', 'honk'];
const REACT_PHASES = ['listen', 'reveal', 'judge', 'defend', 'vote'];
const MAX_CUSTOM = 60;
const MAX_AUDIENCE = 50;
const AUDIENCE_COLOR = '#d7c9e6';
// Fields that make up a room's saved state (everything except runtime plumbing).
const SAVED_FIELDS = ['code', 'players', 'audience', 'mode', 'settings', 'phase', 'g', 'nowPlayingId', 'fx', 'fxCount',
  'entryCount', 'version', 'gameNo', 'history', 'custom', 'customCount', 'stats', 'favorites'];
const HATS = ['none', 'crown', 'tophat', 'party', 'beanie', 'flower', 'headphones', 'shades', 'bowtie', 'cowboy'];

const REAL_CLOCK = {
  now: () => Date.now(),
  set: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
  clear: (t) => clearTimeout(t),
};

const MODES = {
  loose: {
    key: 'loose',
    name: 'A Goose is Loose!',
    short: 'Guess whose song it is',
    rules: 'Everyone answers secret prompts with songs. The songs play in random order with their prompt on screen, and everyone guesses who picked it. +1 for every correct guess. After each reveal, the Goose explains themselves.',
  },
  king: {
    key: 'king',
    name: 'King Goose',
    short: 'Soundtrack the King’s life',
    minPlayers: 2,
    rules: 'Players take turns as King Goose. The King gets a ridiculous scenario and everyone else picks its soundtrack. The songs play anonymously, then the King crowns the best one. The winner gets +1.',
  },
  secret: {
    key: 'secret',
    name: 'Secret Goose',
    short: 'Sniff out the bluffer',
    rules: 'Everyone gets the same one-word feeling except the Secret Goose, who picks a song blind. After the songs play, the feeling and the pickers are revealed. Everyone defends their pick, then votes for the Goose. +1 for catching them, and +2 to the Goose if they escape.',
  },
};

function shuffle(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Shuffle, but try to avoid the same player's songs playing back to back. */
function spreadOwners(entries, rng) {
  let best = shuffle(entries, rng);
  const clashes = (s) => s.reduce((n, e, i) => n + (i > 0 && s[i - 1].playerId === e.playerId ? 1 : 0), 0);
  let bestScore = clashes(best);
  for (let attempt = 0; attempt < 60 && bestScore > 0; attempt++) {
    const s = shuffle(entries, rng);
    const c = clashes(s);
    if (c < bestScore) { best = s; bestScore = c; }
  }
  return best;
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function songView(song) {
  if (!song) return null;
  const { kind, id, type, start, url, title, artist, display, text } = song;
  return { kind, id, type, start, url, title, artist, display, text };
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

class Room {
  constructor(code, { rng = Math.random, clock = REAL_CLOCK } = {}) {
    this.code = code;
    this.rng = rng;
    this.clock = clock;
    this.players = [];
    this.mode = 'loose';
    this.settings = { promptsPerPlayer: 3, kingCycles: 1, secretRounds: 3, timers: false, family: false };
    this.phase = 'lobby';
    this.g = null;            // per-game state
    this.nowPlayingId = null; // entry the host screen should be playing
    this.fx = null;           // last celebratory event, for host visuals
    this.fxCount = 0;
    this.entryCount = 0;
    this.version = 0;
    this.gameNo = 0;
    this.history = [];        // every song played this game, for the end-of-game setlist
    this.custom = { loose: [], king: [], secret: [] };
    this.audience = [];       // late joiners / overflow: they react now and play next game
    this.favorites = {};      // "Song of the Night" votes at game over: playerId -> entryId
    this.customCount = 0;
    this.lastReact = {};
    this.timer = null;
    this.timerKey = null;
    this.deadline = null;
    this.onChange = () => {};
    this.onEvent = () => {};  // transient events (reactions) that are not part of state
  }

  // ---------- helpers ----------
  touch() { this.version++; this.syncTimer(); this.onChange(); }
  emitFx(kind) { this.fx = { n: ++this.fxCount, kind }; }
  getPlayer(id) { return this.players.find((p) => p.id === id) || null; }
  mustPlayer(id) {
    const p = this.getPlayer(id);
    if (!p) throw new GameError('You are not in this room', 403);
    return p;
  }
  mustLobby() { if (this.phase !== 'lobby') throw new GameError('That can only be changed in the lobby'); }
  addPoints(id, n) { const p = this.getPlayer(id); if (p) p.score += n; }
  /** Built-in prompts shuffled, with the room's custom prompts on top (drawn first). */
  deckFor(list, mode) {
    const builtIn = this.settings.family ? list.filter((t) => !PROMPTS.ADULT.has(t)) : list;
    return [...shuffle(builtIn, this.rng), ...shuffle(this.custom[mode].map((c) => c.text), this.rng)];
  }
  drawPrompt(list, mode) {
    if (!this.g.deck.length) this.g.deck = this.deckFor(list, mode);
    return this.g.deck.pop();
  }
  makeEntry(playerId, song, prompt) { return { id: `e${++this.entryCount}`, playerId, song, prompt }; }
  currentQueue() {
    if (!this.g) return [];
    return this.mode === 'loose' ? this.g.queue : (this.g.cur ? this.g.cur.queue : []);
  }
  entryById(id) { return this.currentQueue().find((e) => e.id === id) || null; }

  // ---------- lobby ----------
  cleanName(rawName) {
    const name = String(rawName ?? '').trim().replace(/\s+/g, ' ').slice(0, 16);
    if (!name) throw new GameError('Pick a name first');
    const taken = [...this.players, ...this.audience].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) throw new GameError('Someone already took that name');
    return name;
  }

  /** Join as a player if a seat is open between games; otherwise join the audience. */
  join(id, rawName, hat) {
    const between = this.phase === 'lobby' || this.phase === 'gameover';
    if (between && this.players.length < MAX_PLAYERS) return { player: this.addPlayer(id, rawName, hat), audience: false };
    return { player: this.addAudience(id, rawName, hat), audience: true };
  }

  addAudience(id, rawName, hat) {
    const name = this.cleanName(rawName);
    if (this.audience.length >= MAX_AUDIENCE) throw new GameError('The room is packed. Try again later!');
    const member = { id, name, color: AUDIENCE_COLOR, hat: HATS.includes(hat) ? hat : 'none', connected: false };
    this.audience.push(member);
    this.touch();
    return member;
  }

  getAudience(id) { return this.audience.find((a) => a.id === id) || null; }

  /** Seat audience members as players (in arrival order) while there is room. */
  promoteAudience() {
    while (this.audience.length && this.players.length < MAX_PLAYERS) {
      const a = this.audience.shift();
      this.addPlayer(a.id, a.name, a.hat === 'none' ? undefined : a.hat, true);
      this.getPlayer(a.id).connected = a.connected;
    }
  }

  addPlayer(id, rawName, hat, promoting = false) {
    if (this.phase !== 'lobby' && this.phase !== 'gameover') throw new GameError('A game is in progress. Hang tight for the next one!');
    if (this.players.length >= MAX_PLAYERS) throw new GameError(`The flock is full (${MAX_PLAYERS} max)`);
    const name = promoting ? rawName : this.cleanName(rawName);
    const used = new Set(this.players.map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[this.players.length % COLORS.length];
    const usedHats = new Set(this.players.map((p) => p.hat));
    const freeHats = HATS.filter((x) => x !== 'none' && !usedHats.has(x));
    const pick = HATS.includes(hat) ? hat : (freeHats.length ? freeHats[Math.floor(this.rng() * freeHats.length)] : 'none');
    const player = { id, name, color, hat: pick, score: 0, connected: false };
    this.players.push(player);
    this.touch();
    return player;
  }

  removePlayer(id) {
    this.mustLobby();
    this.mustPlayer(id);
    this.players = this.players.filter((p) => p.id !== id);
    this.touch();
  }

  /** A player leaves on their own (lobby / game over only, so games never lose a player mid-round). */
  leave(id) {
    if (this.getAudience(id)) {
      this.audience = this.audience.filter((a) => a.id !== id);
      this.touch();
      return;
    }
    if (this.phase !== 'lobby' && this.phase !== 'gameover') throw new GameError('You can leave once this game ends');
    this.mustPlayer(id);
    this.players = this.players.filter((p) => p.id !== id);
    this.touch();
  }

  setHat(id, hat) {
    const p = this.getPlayer(id) || this.getAudience(id);
    if (!p) throw new GameError('You are not in this room', 403);
    if (!HATS.includes(hat)) throw new GameError('Unknown hat');
    p.hat = hat;
    this.touch();
  }

  setConnected(id, connected) {
    const p = this.getPlayer(id) || this.getAudience(id);
    if (p && p.connected !== connected) { p.connected = connected; this.touch(); }
  }

  setMode(mode) {
    this.mustLobby();
    if (!has(MODES, mode)) throw new GameError('Unknown game mode');
    this.mode = mode;
    this.touch();
  }

  setSettings(s = {}) {
    this.mustLobby();
    if (has(s, 'promptsPerPlayer')) this.settings.promptsPerPlayer = clampInt(s.promptsPerPlayer, 1, 3, 3);
    if (has(s, 'kingCycles')) this.settings.kingCycles = clampInt(s.kingCycles, 1, 3, 1);
    if (has(s, 'secretRounds')) this.settings.secretRounds = clampInt(s.secretRounds, 1, 12, 3);
    if (has(s, 'timers')) this.settings.timers = Boolean(s.timers);
    if (has(s, 'family')) this.settings.family = Boolean(s.family);
    this.touch();
  }

  start() {
    if (this.phase !== 'lobby' && this.phase !== 'gameover') throw new GameError('A game is already running');
    this.promoteAudience();
    const min = this.minPlayers();
    if (this.players.length < min) {
      throw new GameError(min > MIN_PLAYERS ? `${MODES[this.mode].name} needs at least ${min} players` : `You need at least ${min} players`);
    }
    for (const p of this.players) p.score = 0;
    this.nowPlayingId = null;
    this.fx = null;
    this.history = [];
    this.favorites = {};
    this.stats = { correct: {}, fooled: {}, crowns: {}, escapes: {}, catches: {}, reactsSent: {}, reacts: {} };
    this.gameNo++;
    if (this.mode === 'loose') this.startLoose();
    else if (this.mode === 'king') this.startKing();
    else this.startSecret();
    this.touch();
  }

  /** The smallest table the selected mode can be played with. */
  minPlayers() { return Math.max(MIN_PLAYERS, MODES[this.mode].minPlayers || 0); }

  backToLobby() {
    this.phase = 'lobby';
    this.promoteAudience();
    this.g = null;
    this.nowPlayingId = null;
    this.fx = null;
    for (const p of this.players) p.score = 0;
    this.touch();
  }

  endGame() {
    this.phase = 'gameover';
    this.nowPlayingId = null;
    this.emitFx('gameover');
  }

  // ---------- readiness ----------
  /** Has this player done what the current phase is waiting on? */
  isDone(pid) {
    const g = this.g;
    if (!g) return false;
    if (this.phase === 'submit') {
      if (this.mode === 'loose') return g.subs[pid].every(Boolean);
      if (this.mode === 'king' && pid === g.cur.kingId) return true;
      return Boolean(g.cur.subs[pid]);
    }
    if (this.phase === 'listen' && this.mode === 'loose') {
      return pid === g.queue[g.index].playerId || has(g.guesses, pid);
    }
    if (this.phase === 'vote') return has(g.cur.votes, pid);
    return false;
  }

  tracksReadiness() {
    return this.phase === 'submit' || this.phase === 'vote' || (this.phase === 'listen' && this.mode === 'loose');
  }

  allDone() { return this.players.every((p) => this.isDone(p.id)); }

  // ---------- shared actions ----------
  submit(pid, slot, input) {
    this.mustPlayer(pid);
    if (this.phase !== 'submit') throw new GameError('Song picks are closed right now');
    const g = this.g;
    let song;
    if (this.mode === 'loose') {
      const arr = g.subs[pid];
      const i = Number(slot);
      if (!Number.isInteger(i) || i < 0 || i >= arr.length) throw new GameError('Unknown prompt');
      song = parseSong(input);
      arr[i] = song;
    } else {
      if (this.mode === 'king' && pid === g.cur.kingId) throw new GameError('The King doesn’t pick this round. Sit back and judge!');
      song = parseSong(input);
      g.cur.subs[pid] = song;
    }
    if (this.allDone()) this.closeSubmissions();
    this.touch();
    return song;
  }

  closeSubmissions() {
    const g = this.g;
    if (this.mode === 'loose') {
      const entries = [];
      for (const p of this.players) {
        g.subs[p.id].forEach((song, i) => { if (song) entries.push(this.makeEntry(p.id, song, g.assignments[p.id][i])); });
      }
      if (!entries.length) return this.endGame();
      g.queue = spreadOwners(entries, this.rng);
      this.recordHistory(g.queue);
      g.index = 0;
      return this.beginLooseSong();
    }
    const cur = g.cur;
    const entries = this.players.filter((p) => cur.subs[p.id]).map((p) => this.makeEntry(p.id, cur.subs[p.id], cur.prompt));
    if (!entries.length) return this.mode === 'king' ? this.nextKingRound() : this.nextSecretRound();
    cur.queue = shuffle(entries, this.rng);
    this.recordHistory(cur.queue);
    cur.index = 0;
    this.phase = 'listen';
    this.nowPlayingId = cur.queue[0].id;
  }

  /** Host "next" button: advances whatever the current phase is. */
  next() {
    if (!this.g || this.phase === 'lobby' || this.phase === 'gameover') throw new GameError('Nothing to advance');
    const g = this.g;
    if (this.phase === 'submit') {
      this.closeSubmissions();
    } else if (this.mode === 'loose') {
      if (this.phase === 'listen') this.revealLoose();
      else if (this.phase === 'reveal') {
        g.index++;
        if (g.index < g.queue.length) this.beginLooseSong(); else this.endGame();
      }
    } else if (this.mode === 'king') {
      const cur = g.cur;
      if (this.phase === 'listen') {
        cur.index++;
        if (cur.index < cur.queue.length) this.nowPlayingId = cur.queue[cur.index].id;
        else this.phase = 'judge';
      } else if (this.phase === 'judge') this.crown(null);
      else if (this.phase === 'reveal') this.nextKingRound();
    } else {
      const cur = g.cur;
      if (this.phase === 'listen') {
        cur.index++;
        if (cur.index < cur.queue.length) this.nowPlayingId = cur.queue[cur.index].id;
        else this.phase = 'defend';
      } else if (this.phase === 'defend') this.phase = 'vote';
      else if (this.phase === 'vote') this.revealSecret();
      else if (this.phase === 'reveal') this.nextSecretRound();
    }
    this.touch();
  }

  /** Host replays a specific song (e.g. while the King deliberates). */
  play(entryId) {
    if (!['listen', 'reveal', 'judge', 'defend', 'vote'].includes(this.phase)) throw new GameError('Nothing to play right now');
    const entry = this.entryById(entryId);
    if (!entry) throw new GameError('Unknown song');
    // During anonymous listening, only allow songs that have already been heard.
    if (this.phase === 'listen' && this.mode !== 'loose') {
      const idx = this.g.cur.queue.indexOf(entry);
      if (idx > this.g.cur.index) throw new GameError('That song hasn’t come up yet');
    }
    this.nowPlayingId = entry.id;
    this.touch();
  }

  // ---------- A Goose is Loose! ----------
  startLoose() {
    const n = this.settings.promptsPerPlayer;
    let deck = this.deckFor(PROMPTS.LOOSE, 'loose');
    const assignments = {};
    const subs = {};
    for (const p of this.players) {
      assignments[p.id] = [];
      for (let i = 0; i < n; i++) {
        if (!deck.length) deck = this.deckFor(PROMPTS.LOOSE, 'loose');
        assignments[p.id].push(deck.pop());
      }
      subs[p.id] = new Array(n).fill(null);
    }
    const swaps = {};
    for (const p of this.players) swaps[p.id] = SWAPS_PER_GAME;
    this.g = { assignments, subs, swaps, deck, queue: [], index: 0, guesses: {}, result: null };
    this.phase = 'submit';
  }

  /** Trade an unanswered prompt for a fresh one from the deck. */
  swapPrompt(pid, slot) {
    this.mustPlayer(pid);
    if (this.mode !== 'loose' || this.phase !== 'submit') throw new GameError('You can only swap prompts while picking songs');
    const g = this.g;
    const i = Number(slot);
    const mine = g.assignments[pid];
    if (!Number.isInteger(i) || i < 0 || i >= mine.length) throw new GameError('Unknown prompt');
    if (g.subs[pid][i]) throw new GameError('You already answered that one. Clear it by picking a new song instead.');
    if (!g.swaps) g.swaps = {};
    if (!has(g.swaps, pid)) g.swaps[pid] = SWAPS_PER_GAME;
    if (g.swaps[pid] <= 0) throw new GameError('No swaps left this game');
    if (!g.deck) g.deck = [];
    // Skip anything this player is already holding so a swap always changes the prompt.
    let next = null;
    for (let tries = 0; tries < 2 && next == null; tries++) {
      if (!g.deck.length) g.deck = this.deckFor(PROMPTS.LOOSE, 'loose');
      const idx = g.deck.findLastIndex((t) => !mine.includes(t));
      if (idx >= 0) next = g.deck.splice(idx, 1)[0];
      else g.deck = [];
    }
    if (next == null) throw new GameError('No other prompts to swap in');
    mine[i] = next;
    g.swaps[pid]--;
    this.touch();
    return { prompt: next, swapsLeft: g.swaps[pid] };
  }

  beginLooseSong() {
    const g = this.g;
    g.guesses = {};
    g.result = null;
    this.phase = 'listen';
    this.nowPlayingId = g.queue[g.index].id;
  }

  guess(pid, target) {
    this.mustPlayer(pid);
    if (this.mode !== 'loose' || this.phase !== 'listen') throw new GameError('No guessing right now');
    const entry = this.g.queue[this.g.index];
    if (pid === entry.playerId) throw new GameError('That’s your song. Act natural!');
    if (target === pid || !this.getPlayer(target)) throw new GameError('Pick one of the other players');
    this.g.guesses[pid] = target;
    if (this.allDone()) this.revealLoose();
    this.touch();
  }

  revealLoose() {
    const g = this.g;
    const entry = g.queue[g.index];
    const correct = Object.keys(g.guesses).filter((id) => g.guesses[id] === entry.playerId);
    for (const id of correct) this.addPoints(id, 1);
    this.bump('correct', correct);
    this.bump('fooled', [entry.playerId], Object.keys(g.guesses).length - correct.length);
    g.result = { ownerId: entry.playerId, correct, guesses: { ...g.guesses } };
    this.phase = 'reveal';
    this.emitFx('reveal');
  }

  // ---------- King Goose ----------
  startKing() {
    const ids = this.players.map((p) => p.id);
    const order = [];
    for (let c = 0; c < this.settings.kingCycles; c++) {
      const s = shuffle(ids, this.rng);
      if (order.length && s[0] === order[order.length - 1]) s.push(s.shift());
      order.push(...s);
    }
    this.g = { order, round: -1, deck: [], cur: null };
    this.nextKingRound();
  }

  nextKingRound() {
    const g = this.g;
    g.round++;
    while (g.round < g.order.length && !this.getPlayer(g.order[g.round])) g.round++;
    if (g.round >= g.order.length) return this.endGame();
    g.cur = { kingId: g.order[g.round], prompt: this.drawPrompt(PROMPTS.KING, 'king'), subs: {}, queue: [], index: 0, pick: null };
    this.phase = 'submit';
    this.nowPlayingId = null;
  }

  judge(pid, entryId) {
    this.mustPlayer(pid);
    if (this.mode !== 'king' || this.phase !== 'judge') throw new GameError('No judging right now');
    if (pid !== this.g.cur.kingId) throw new GameError('Only King Goose may judge');
    const entry = this.entryById(entryId);
    if (!entry) throw new GameError('Unknown song');
    this.crown(entry);
    this.touch();
  }

  crown(entry) {
    const cur = this.g.cur;
    cur.pick = entry ? entry.id : null;
    if (entry) { this.addPoints(entry.playerId, 1); this.bump('crowns', [entry.playerId]); }
    this.phase = 'reveal';
    this.emitFx(entry ? 'crown' : 'none');
  }

  // ---------- Secret Goose ----------
  startSecret() {
    this.g = { order: shuffle(this.players.map((p) => p.id), this.rng), round: -1, rounds: this.settings.secretRounds, deck: [], cur: null };
    this.nextSecretRound();
  }

  nextSecretRound() {
    const g = this.g;
    g.round++;
    if (g.round >= g.rounds) return this.endGame();
    // Rotate through players so everyone gets a turn as the Goose; reshuffle each lap.
    if (g.round > 0 && g.round % g.order.length === 0) {
      const prev = g.order[g.order.length - 1];
      g.order = shuffle(this.players.map((p) => p.id), this.rng);
      if (g.order[0] === prev && g.order.length > 1) g.order.push(g.order.shift());
    }
    const gooseId = g.order[g.round % g.order.length];
    g.cur = { gooseId, prompt: this.drawPrompt(PROMPTS.SECRET, 'secret'), subs: {}, queue: [], index: 0, votes: {}, result: null };
    this.phase = 'submit';
    this.nowPlayingId = null;
  }

  vote(pid, target) {
    this.mustPlayer(pid);
    if (this.mode !== 'secret' || this.phase !== 'vote') throw new GameError('No voting right now');
    if (target === pid || !this.getPlayer(target)) throw new GameError('Vote for one of the other players');
    this.g.cur.votes[pid] = target;
    if (this.allDone()) this.revealSecret();
    this.touch();
  }

  revealSecret() {
    const cur = this.g.cur;
    const nonGoose = this.players.filter((p) => p.id !== cur.gooseId);
    const catchers = nonGoose.filter((p) => cur.votes[p.id] === cur.gooseId).map((p) => p.id);
    for (const id of catchers) this.addPoints(id, 1);
    const caught = catchers.length * 2 > nonGoose.length;
    if (!caught) { this.addPoints(cur.gooseId, 2); this.bump('escapes', [cur.gooseId]); }
    this.bump('catches', catchers);
    cur.result = { catchers, caught };
    this.phase = 'reveal';
    this.emitFx(caught ? 'caught' : 'escaped');
  }

  recordHistory(queue) {
    for (const e of queue) this.history.push({ entryId: e.id, playerId: e.playerId, prompt: e.prompt, song: e.song, mode: this.mode });
  }

  bump(stat, ids, n = 1) {
    if (!this.stats || n <= 0) return;
    const t = this.stats[stat];
    for (const id of ids) t[id] = (t[id] || 0) + n;
  }

  /** Superlatives for the end screen. Ties share an award; zero counts never win. */
  awards() {
    const st = this.stats;
    if (!st) return [];
    const top = (table) => {
      const entries = Object.entries(table).filter(([, n]) => n > 0);
      if (!entries.length) return null;
      const max = Math.max(...entries.map(([, n]) => n));
      return { ids: entries.filter(([, n]) => n === max).map(([id]) => id), n: max };
    };
    const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    const out = [];
    const add = (key, title, table, detail) => {
      const t = top(table);
      // An award everybody shares isn't much of an award.
      if (t && t.ids.length > 1 && t.ids.length >= this.players.length) return;
      if (t) out.push({ key, title, playerIds: t.ids.filter((id) => this.getPlayer(id)), detail: detail(t.n) });
    };
    add('ears', 'Sharpest Ears', st.correct, (n) => plural(n, 'correct guess', 'correct guesses'));
    add('disguise', 'Master of Disguise', st.fooled, (n) => `fooled ${plural(n, 'guesser', 'guessers')}`);
    add('royal', 'Royal Favorite', st.crowns, (n) => `crowned ${plural(n, 'time')}`);
    add('bluffer', 'Smooth Bluffer', st.escapes, (n) => `escaped as the Goose ${plural(n, 'time')}`);
    add('detective', 'Goose Detective', st.catches, (n) => `caught the Goose ${plural(n, 'time')}`);
    add('hype', 'Hype Goose', st.reactsSent, (n) => plural(n, 'reaction'));
    const crowd = top(st.reacts);
    if (crowd) {
      const entries = this.history.filter((h) => crowd.ids.includes(h.entryId));
      const ownerIds = [...new Set(entries.map((h) => h.playerId))].filter((id) => this.getPlayer(id));
      if (ownerIds.length) {
        out.push({ key: 'crowd', title: 'Crowd Pleaser', playerIds: ownerIds, detail: `\u201C${entries[0].song.display}\u201D got ${plural(crowd.n, 'reaction')}` });
      }
    }
    return out.filter((a) => a.playerIds.length);
  }

  // ---------- timers ----------
  phaseKey() {
    const g = this.g || {};
    const cur = g.cur || {};
    return [this.gameNo, this.mode, this.phase, g.index, g.round, cur.index].join(':');
  }

  timedDuration() {
    if (!this.settings.timers || !this.g) return 0;
    switch (this.phase) {
      case 'submit': return (this.mode === 'loose' ? this.settings.promptsPerPlayer : 1) * TIMERS.perSong * 1000;
      case 'listen': return this.mode === 'loose' ? TIMERS.guess * 1000 : 0;
      case 'judge': return TIMERS.judge * 1000;
      case 'vote': return TIMERS.vote * 1000;
      default: return 0;
    }
  }

  /** Called on every state change: (re)arms the countdown whenever the phase moves on. */
  syncTimer() {
    const key = this.phaseKey();
    if (key === this.timerKey) return;
    this.timerKey = key;
    this.stopTimer();
    const ms = this.timedDuration();
    if (ms > 0) {
      this.deadline = this.clock.now() + ms;
      this.timer = this.clock.set(() => this.onTimer(key), ms);
    }
  }

  stopTimer() {
    if (this.timer) this.clock.clear(this.timer);
    this.timer = null;
    this.deadline = null;
  }

  onTimer(key) {
    this.timer = null;
    if (key !== this.phaseKey()) return;
    this.deadline = null;
    try { this.next(); } catch { /* phase already moved on */ }
  }

  extendTimer(seconds = 30) {
    if (!this.timer || !this.deadline) throw new GameError('No timer is running');
    const key = this.timerKey;
    this.clock.clear(this.timer);
    this.deadline += seconds * 1000;
    this.timer = this.clock.set(() => this.onTimer(key), Math.max(0, this.deadline - this.clock.now()));
    this.touch();
  }

  dispose() { this.stopTimer(); this.onChange = () => {}; this.onEvent = () => {}; }

  // ---------- custom prompts ----------
  addPrompt(mode, rawText, by = null, quiet = false) {
    if (this.phase !== 'lobby' && this.phase !== 'gameover') throw new GameError('Add prompts between games');
    if (!has(MODES, mode)) throw new GameError('Unknown game mode');
    const text = String(rawText ?? '').trim().replace(/\s+/g, ' ');
    const max = mode === 'secret' ? 30 : 220;
    if (text.length < (mode === 'secret' ? 2 : 8)) throw new GameError(mode === 'secret' ? 'Type a feeling' : 'That prompt is a bit short');
    if (text.length > max) throw new GameError(`Keep it under ${max} characters`);
    const list = this.custom[mode];
    if (list.length >= MAX_CUSTOM) throw new GameError('That\u2019s plenty of custom prompts!');
    if (list.some((c) => c.text.toLowerCase() === text.toLowerCase())) throw new GameError('That one is already in');
    const prompt = { id: `c${++this.customCount}`, text, by };
    list.push(prompt);
    if (!quiet) this.touch();
    return prompt;
  }

  removePrompt(id) {
    let found = false;
    for (const mode of Object.keys(this.custom)) {
      const before = this.custom[mode].length;
      this.custom[mode] = this.custom[mode].filter((c) => c.id !== id);
      if (this.custom[mode].length !== before) found = true;
    }
    if (!found) throw new GameError('Unknown prompt');
    this.touch();
  }

  // ---------- Song of the Night ----------
  /** At game over, everyone (audience too) hearts one song that isn't their own. Tapping again un-hearts. */
  favorite(pid, entryId) {
    if (!this.getPlayer(pid) && !this.getAudience(pid)) throw new GameError('You are not in this room', 403);
    if (this.phase !== 'gameover') throw new GameError('Favorites open when the game ends');
    const item = this.history.find((h) => h.entryId === entryId);
    if (!item) throw new GameError('Unknown song');
    if (item.playerId === pid) throw new GameError('No hearting your own song!');
    if (this.favorites[pid] === entryId) delete this.favorites[pid];
    else this.favorites[pid] = entryId;
    this.touch();
  }

  favoriteCounts() {
    const counts = {};
    for (const id of Object.values(this.favorites)) counts[id] = (counts[id] || 0) + 1;
    return counts;
  }

  // ---------- prompt packs ----------
  addPack(key) {
    const pack = has(PROMPTS.PACKS, key) && PROMPTS.PACKS[key];
    if (!pack) throw new GameError('Unknown pack');
    return this.importPack(pack);
  }

  /** Bulk-add prompts ({loose:[], king:[], secret:[]}); skips duplicates and invalid ones. */
  importPack(pack) {
    if (!pack || typeof pack !== 'object') throw new GameError('That pack file looks empty');
    let added = 0;
    for (const mode of Object.keys(MODES)) {
      const list = Array.isArray(pack[mode]) ? pack[mode].slice(0, MAX_CUSTOM) : [];
      for (const text of list) {
        try { this.addPrompt(mode, text, null, true); added++; } catch { /* skip */ }
      }
    }
    if (!added) throw new GameError('No new prompts in that pack');
    this.touch();
    return added;
  }

  exportPack() {
    const out = { name: 'A Goose Among Sirens prompt pack', version: 1 };
    for (const mode of Object.keys(MODES)) out[mode] = this.custom[mode].map((c) => c.text);
    return out;
  }

  // ---------- save / restore (survive server restarts) ----------
  toJSON() {
    const out = {};
    for (const k of SAVED_FIELDS) out[k] = this[k];
    return out;
  }

  static fromJSON(data, opts = {}) {
    const room = new Room(data.code, opts);
    for (const k of SAVED_FIELDS) if (has(data, k)) room[k] = data[k];
    room.settings = { ...new Room('x').settings, ...room.settings };
    room.custom = { loose: [], king: [], secret: [], ...room.custom };
    for (const p of [...room.players, ...room.audience]) p.connected = false;
    room.syncTimer(); // a running countdown restarts from full time
    return room;
  }

  // ---------- reactions ----------
  /** Emoji reactions while music plays. Not stored in state: forwarded to the host screen. */
  react(pid, kind) {
    const p = this.getPlayer(pid) || this.getAudience(pid);
    if (!p) throw new GameError('You are not in this room', 403);
    if (!REACTIONS.includes(kind)) throw new GameError('Unknown reaction');
    if (!REACT_PHASES.includes(this.phase)) throw new GameError('Save it for the music!');
    const now = this.clock.now();
    if (now - (this.lastReact[pid] || 0) < 300) return false;
    this.lastReact[pid] = now;
    this.bump('reactsSent', [pid]);
    if (this.nowPlayingId) this.bump('reacts', [this.nowPlayingId]);
    this.onEvent('react', { kind, color: p.color, name: p.name });
    return true;
  }

  // ---------- views (what each screen is allowed to know) ----------
  view(pid = null) {
    const isHost = pid == null;
    const v = {
      code: this.code,
      phase: this.phase,
      mode: this.mode,
      modeInfo: MODES[this.mode],
      settings: { ...this.settings },
      version: this.version,
      minPlayers: this.minPlayers(),
      maxPlayers: MAX_PLAYERS,
      players: this.players.map(({ id, name, color, hat, score, connected }) => ({ id, name, color, hat, score, connected })),
      hats: HATS,
      ready: this.tracksReadiness() ? this.players.filter((p) => this.isDone(p.id)).map((p) => p.id) : [],
      fx: this.fx,
      timer: this.deadline ? { deadline: this.deadline, now: this.clock.now() } : null,
      canReact: REACT_PHASES.includes(this.phase),
    };
    if (this.phase === 'gameover') {
      const reacts = (this.stats && this.stats.reacts) || {};
      v.playlist = this.history.map((h) => ({ entryId: h.entryId, playerId: h.playerId, prompt: h.prompt, mode: h.mode, song: songView(h.song), reactions: reacts[h.entryId] || 0 }));
      v.awards = this.awards();
      const favs = this.favoriteCounts();
      for (const t of v.playlist) t.favs = favs[t.entryId] || 0;
      const best = Math.max(0, ...v.playlist.map((t) => t.favs));
      v.songOfTheNight = best > 0 ? v.playlist.filter((t) => t.favs === best).map((t) => t.entryId) : [];
      v.favoritesIn = Object.keys(this.favorites).length;
      if (!isHost) v.myFavorite = this.favorites[pid] || null;
    }
    v.audience = this.audience.map(({ id, name, hat, connected }) => ({ id, name, hat, connected }));
    if (isHost) {
      v.modes = Object.values(MODES);
      v.packs = Object.entries(PROMPTS.PACKS).map(([key, p]) => ({ key, name: p.name }));
      v.custom = this.custom;
      v.nowPlaying = this.nowPlayingView();
    } else if (this.getAudience(pid)) {
      // Audience members see what the TV shows (public info only) and can react.
      const a = this.getAudience(pid);
      v.me = { id: a.id, name: a.name, color: a.color, hat: a.hat, score: 0 };
      v.isAudience = true;
      v.mySuggestions = [];
      if (this.g && this.phase !== 'gameover') {
        const pub = this.mode === 'loose' ? this.looseView(null, true) : this.mode === 'king' ? this.kingView(null, true) : this.secretView(null, true);
        Object.assign(v, pub);
      }
      return v;
    } else {
      const me = this.getPlayer(pid);
      v.me = me ? { id: me.id, name: me.name, color: me.color, hat: me.hat, score: me.score } : null;
      v.mySuggestions = Object.entries(this.custom).flatMap(([mode, list]) => list.filter((c) => c.by === pid).map((c) => ({ mode, text: c.text })));
    }
    if (this.g && this.phase !== 'gameover') {
      if (this.mode === 'loose') Object.assign(v, this.looseView(pid, isHost));
      else if (this.mode === 'king') Object.assign(v, this.kingView(pid, isHost));
      else Object.assign(v, this.secretView(pid, isHost));
    }
    return v;
  }

  nowPlayingView() {
    const entry = this.entryById(this.nowPlayingId);
    if (!entry) return null;
    return { entryId: entry.id, number: this.currentQueue().indexOf(entry) + 1, song: songView(entry.song) };
  }

  looseView(pid, isHost) {
    const g = this.g;
    const v = { promptsPerPlayer: this.settings.promptsPerPlayer, total: g.queue.length, index: g.index };
    if (this.phase === 'submit' && !isHost) {
      v.prompts = g.assignments[pid].map((text, i) => ({ text, song: songView(g.subs[pid][i]) }));
      v.swapsLeft = g.swaps && has(g.swaps, pid) ? g.swaps[pid] : SWAPS_PER_GAME;
    }
    if (this.phase === 'listen' || this.phase === 'reveal') {
      const e = g.queue[g.index];
      v.current = { prompt: e.prompt, number: g.index + 1, display: e.song.display };
      if (!isHost) {
        v.isMine = e.playerId === pid;
        v.myGuess = g.guesses[pid] || (g.result && g.result.guesses[pid]) || null;
      }
      if (this.phase === 'reveal') v.result = g.result;
    }
    return v;
  }

  kingView(pid, isHost) {
    const g = this.g;
    const c = g.cur;
    const v = { round: g.round + 1, rounds: g.order.length, kingId: c.kingId, prompt: c.prompt };
    if (!isHost) {
      v.isKing = pid === c.kingId;
      v.mySong = songView(c.subs[pid]);
    }
    if (this.phase === 'listen') v.track = { number: c.index + 1, total: c.queue.length };
    if (this.phase === 'judge' || this.phase === 'reveal') {
      const reveal = this.phase === 'reveal';
      v.tracks = c.queue.map((e, i) => ({ id: e.id, number: i + 1, display: e.song.display, ownerId: reveal ? e.playerId : undefined }));
    }
    if (this.phase === 'reveal') {
      v.pick = c.pick;
      const e = c.pick ? this.entryById(c.pick) : null;
      v.winnerId = e ? e.playerId : null;
    }
    return v;
  }

  secretView(pid, isHost) {
    const g = this.g;
    const c = g.cur;
    const revealed = ['defend', 'vote', 'reveal'].includes(this.phase);
    const v = { round: g.round + 1, rounds: g.rounds };
    if (!isHost) {
      v.isGoose = pid === c.gooseId;
      v.mySong = songView(c.subs[pid]);
      if (!v.isGoose || revealed) v.prompt = c.prompt;
    } else if (revealed) {
      v.prompt = c.prompt;
    }
    if (this.phase === 'listen') v.track = { number: c.index + 1, total: c.queue.length };
    if (revealed) v.tracks = c.queue.map((e, i) => ({ id: e.id, number: i + 1, display: e.song.display, ownerId: e.playerId }));
    if (this.phase === 'vote' && !isHost) v.myVote = c.votes[pid] || null;
    if (this.phase === 'reveal') {
      v.gooseId = c.gooseId;
      v.votes = { ...c.votes };
      v.result = c.result;
    }
    return v;
  }
}

module.exports = { MAX_AUDIENCE, Room, MODES, MIN_PLAYERS, SWAPS_PER_GAME, MAX_PLAYERS, TIMERS, REACTIONS, HATS, GameError, shuffle };
