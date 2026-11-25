'use strict';
// Server-authoritative game logic for every mode (the three from the design doc, plus five newer ones).
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
const TIMERS = { perSong: 75, guess: 30, judge: 45, vote: 40, write: 60, rate: 30 };
const REACTIONS = ['fire', 'laugh', 'cry', 'mindblown', 'skull', 'heart', 'honk'];
const REACT_PHASES = ['listen', 'reveal', 'judge', 'defend', 'vote', 'write', 'rate'];
const MAX_CUSTOM = 60;
const MAX_AUDIENCE = 50;
const AUDIENCE_COLOR = '#d7c9e6';
// Fields that make up a room's saved state (everything except runtime plumbing).
const SAVED_FIELDS = ['code', 'players', 'audience', 'mode', 'settings', 'phase', 'g', 'nowPlayingId', 'nowPlayingAt', 'fx', 'fxCount',
  'entryCount', 'version', 'gameNo', 'history', 'custom', 'customCount', 'stats', 'favorites'];
const HATS = ['none', 'crown', 'tophat', 'party', 'beanie', 'flower', 'headphones', 'cowboy',
  'pirate', 'wizard', 'viking', 'chef', 'halo', 'bucket', 'propeller'];
// Worn together with a hat. (Shades and the bow tie used to be hats; old saves are migrated.)
const ACCESSORIES = ['none', 'shades', 'heartshades', 'monocle', 'bowtie', 'scarf', 'chain'];
const FEATHERS = ['white', 'grey', 'brown', 'black', 'gold', 'pink', 'red', 'orange', 'mint', 'blue', 'purple', 'navy'];
const FACES = ['normal', 'happy', 'angry', 'sleepy', 'starry'];
const LOOK_DEFAULTS = { accessory: 'none', feathers: 'white', face: 'normal' };
const LOOK_OPTIONS = { accessory: ACCESSORIES, feathers: FEATHERS, face: FACES };

/** Fill in / repair the cosmetic fields of a player or audience member. */
function normalizeLook(p) {
  if (ACCESSORIES.includes(p.hat) && !HATS.includes(p.hat)) { p.accessory = p.accessory && p.accessory !== 'none' ? p.accessory : p.hat; p.hat = 'none'; }
  if (!HATS.includes(p.hat)) p.hat = 'none';
  for (const [k, list] of Object.entries(LOOK_OPTIONS)) if (!list.includes(p[k])) p[k] = LOOK_DEFAULTS[k];
  return p;
}

const lookOf = (p) => ({ hat: p.hat, accessory: p.accessory, feathers: p.feathers, face: p.face });

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
  fight: {
    key: 'fight',
    name: 'Goose Fight',
    short: 'Song battles, last song standing',
    minPlayers: 3,
    rules: 'Everyone answers the same prompt. The songs face off two at a time in a bracket and the room votes for the winner of each fight (you can’t vote in your own). +1 for every fight your song wins, and +2 more for the last song standing.',
  },
  fake: {
    key: 'fake',
    name: 'Fake Prompt',
    short: 'Bluff the prompt behind the song',
    minPlayers: 3,
    rules: 'Everyone answers secret prompts with songs. When a song plays, everyone else writes a fake prompt it could have answered. Then find the real prompt among the fakes. +2 for finding it, +1 every time someone falls for your fake.',
  },
  mind: {
    key: 'mind',
    name: 'Flock Mind',
    short: 'Think like the flock',
    minPlayers: 3,
    rules: 'Everyone gets the same prompt and tries to pick the song the rest of the flock will pick. Picks that share a song or an artist match up. +1 for every other player who matched you.',
  },
  chain: {
    key: 'chain',
    name: 'Goose Chain',
    short: 'Link song to song',
    minPlayers: 3,
    rules: 'Take turns adding a song to one long chain. Each song must link to the one before it (a shared word, artist, decade, vibe… explain it out loud!). Everyone else votes if the link holds. +1 for a good link, but break the chain and you lose a point and the next goose starts fresh.',
  },
  hot: {
    key: 'hot',
    name: 'Honk Take',
    short: 'How much do they really love it?',
    minPlayers: 2,
    rules: 'Take turns as the DJ. The DJ plays a song for a prompt and secretly rates it from 1 (hate it) to 5 (love it). Everyone else guesses the DJ’s rating. +2 for an exact guess, +1 for one off, and the DJ gets +1 for every exact guess.',
  },
};

// Which prompt list (and custom-prompt bucket) each mode deals from. Goose Chain has no prompts.
const PROMPT_KINDS = ['loose', 'king', 'secret', 'mind', 'hot'];
const MODE_PROMPTS = { loose: 'loose', king: 'king', secret: 'secret', fight: 'loose', fake: 'loose', mind: 'mind', hot: 'hot', chain: null };
const PROMPT_LIST = { loose: 'LOOSE', king: 'KING', secret: 'SECRET', mind: 'MIND', hot: 'HOT' };
const MAX_FAKE = 120;

for (const m of Object.values(MODES)) m.prompts = MODE_PROMPTS[m.key];

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

/** Case/accent/punctuation-insensitive form of a phrase, for "is this the same text?" checks. */
function looseKey(text) {
  return String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const NOISE_WORDS = /\b(official|music|video|audio|lyrics?|hd|hq|4k|remaster(ed)?|topic|visuali[sz]er|version|live|explicit|clean|mv)\b/g;

/** Song + artist names a pick is "about", plus its link id. Two picks match if they share any. */
function songKeys(song) {
  const keys = new Set();
  if (song.kind !== 'text' && song.id) keys.add(`${song.kind}:${song.id}`);
  const raw = [song.title, song.artist, song.kind === 'text' ? song.text : null].filter(Boolean);
  for (const r of raw) {
    const parts = String(r).replace(/\(.*?\)|\[.*?\]/g, ' ').split(/\s+[-–—|]\s+|\s+by\s+|\s*\/\s*/i);
    for (const p of parts) {
      const k = looseKey(p).replace(/\b(feat|ft|featuring)\b.*$/, '').replace(NOISE_WORDS, ' ')
        .replace(/vevo$/, '').replace(/\s+/g, ' ').trim().replace(/^the /, '');
      if (k.length >= 2) keys.add(`t:${k}`);
    }
  }
  return keys;
}

/** Group entries whose picks share a song or artist (transitively). Biggest groups first. */
function matchGroups(entries) {
  const parent = entries.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map();
  entries.forEach((e, i) => {
    for (const k of songKeys(e.song)) {
      if (owner.has(k)) parent[find(i)] = find(owner.get(k)); else owner.set(k, i);
    }
  });
  const groups = new Map();
  entries.forEach((e, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e.id);
  });
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

class Room {
  constructor(code, { rng = Math.random, clock = REAL_CLOCK } = {}) {
    this.code = code;
    this.rng = rng;
    this.clock = clock;
    this.players = [];
    this.mode = 'loose';
    this.settings = {
      promptsPerPlayer: 3, kingCycles: 1, secretRounds: 3, timers: false, family: false, venue: 'room',
      fightRounds: 1, fakePrompts: 1, mindRounds: 5, chainLaps: 2, hotCycles: 1,
    };
    this.phase = 'lobby';
    this.g = null;            // per-game state
    this.nowPlayingId = null; // entry the host screen should be playing
    this.nowPlayingAt = null; // when it started (server clock), so phones can join in sync
    this.npSeen = null;
    this.fx = null;           // last celebratory event, for host visuals
    this.fxCount = 0;
    this.entryCount = 0;
    this.version = 0;
    this.gameNo = 0;
    this.history = [];        // every song played this game, for the end-of-game setlist
    this.custom = { loose: [], king: [], secret: [], mind: [], hot: [] };
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
  touch() {
    this.version++;
    // Stamp the moment a new song starts; phones listening along seek to match the TV.
    if (this.nowPlayingId !== this.npSeen) {
      this.npSeen = this.nowPlayingId;
      this.nowPlayingAt = this.nowPlayingId ? this.clock.now() : null;
    }
    this.syncTimer();
    this.onChange();
  }
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
    return ['loose', 'fake', 'chain'].includes(this.mode) ? this.g.queue : (this.g.cur ? this.g.cur.queue : []);
  }
  entryById(id) { return this.currentQueue().find((e) => e.id === id) || null; }

  // ---------- lobby ----------
  cleanName(rawName, exceptId = null) {
    const name = String(rawName ?? '').trim().replace(/\s+/g, ' ').slice(0, 16);
    if (!name) throw new GameError('Pick a name first');
    const taken = [...this.players, ...this.audience].some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());
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
    const member = normalizeLook({ id, name, color: AUDIENCE_COLOR, hat: HATS.includes(hat) ? hat : 'none', connected: false });
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
      const p = this.getPlayer(a.id);
      p.connected = a.connected;
      for (const k of Object.keys(LOOK_OPTIONS)) p[k] = a[k];
      normalizeLook(p);
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
    const player = normalizeLook({ id, name, color, hat: pick, score: 0, connected: false });
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

  /** Change your name, but only between games, so nobody's identity shifts mid-round. */
  rename(id, rawName) {
    const p = this.getPlayer(id) || this.getAudience(id);
    if (!p) throw new GameError('You are not in this room', 403);
    if (this.phase !== 'lobby' && this.phase !== 'gameover') throw new GameError('You can change your name before the next game starts');
    p.name = this.cleanName(rawName, id);
    this.touch();
    return p.name;
  }

  /** Pick your goose's color. Colors stay unique so everyone is easy to tell apart on the TV. */
  setColor(id, color) {
    const p = this.getPlayer(id);
    if (!p) throw new GameError(this.getAudience(id) ? 'You\u2019ll pick a color when you join the next game' : 'You are not in this room', 403);
    if (this.phase !== 'lobby' && this.phase !== 'gameover') throw new GameError('You can change your color before the next game starts');
    if (!COLORS.includes(color)) throw new GameError('Unknown color');
    const owner = this.players.find((q) => q.id !== id && q.color === color);
    if (owner) throw new GameError(`${owner.name} already has that color`);
    p.color = color;
    this.touch();
  }

  setHat(id, hat) {
    const p = this.getPlayer(id) || this.getAudience(id);
    if (!p) throw new GameError('You are not in this room', 403);
    if (!HATS.includes(hat)) throw new GameError('Unknown hat');
    p.hat = hat;
    this.touch();
  }

  /** Change any of: accessory, feathers, face. Cosmetic only, so allowed any time (like hats). */
  setLook(id, look) {
    const p = this.getPlayer(id) || this.getAudience(id);
    if (!p) throw new GameError('You are not in this room', 403);
    if (!look || typeof look !== 'object') throw new GameError('Nothing to change');
    const next = {};
    for (const [k, list] of Object.entries(LOOK_OPTIONS)) {
      if (!has(look, k)) continue;
      if (!list.includes(look[k])) throw new GameError(`Unknown ${k}`);
      next[k] = look[k];
    }
    if (!Object.keys(next).length) throw new GameError('Nothing to change');
    Object.assign(p, next);
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
    if (has(s, 'fightRounds')) this.settings.fightRounds = clampInt(s.fightRounds, 1, 3, 1);
    if (has(s, 'fakePrompts')) this.settings.fakePrompts = clampInt(s.fakePrompts, 1, 2, 1);
    if (has(s, 'mindRounds')) this.settings.mindRounds = clampInt(s.mindRounds, 1, 12, 5);
    if (has(s, 'chainLaps')) this.settings.chainLaps = clampInt(s.chainLaps, 1, 3, 2);
    if (has(s, 'hotCycles')) this.settings.hotCycles = clampInt(s.hotCycles, 1, 3, 1);
    if (has(s, 'timers')) this.settings.timers = Boolean(s.timers);
    if (has(s, 'family')) this.settings.family = Boolean(s.family);
    // 'room': everyone hears the TV. 'remote': every player's own device plays the music.
    if (has(s, 'venue')) this.settings.venue = s.venue === 'remote' ? 'remote' : 'room';
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
    this.stats = {
      correct: {}, fooled: {}, crowns: {}, escapes: {}, catches: {}, reactsSent: {}, reacts: {},
      fights: {}, forged: {}, matches: {}, links: {}, reads: {},
    };
    this.gameNo++;
    const starts = {
      loose: () => this.startLoose(), king: () => this.startKing(), secret: () => this.startSecret(),
      fight: () => this.startFight(), fake: () => this.startFake(), mind: () => this.startMind(),
      chain: () => this.startChain(), hot: () => this.startHot(),
    };
    starts[this.mode]();
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
    const cur = g.cur || {};
    if (this.phase === 'submit') {
      if (this.mode === 'loose' || this.mode === 'fake') return g.subs[pid].every(Boolean);
      if (this.mode === 'king' && pid === cur.kingId) return true;
      if ((this.mode === 'chain' || this.mode === 'hot') && pid !== cur.pickerId) return true;
      return Boolean(cur.subs[pid]);
    }
    if (this.phase === 'listen' && this.mode === 'loose') {
      return pid === g.queue[g.index].playerId || has(g.guesses, pid);
    }
    if (this.mode === 'fake' && (this.phase === 'write' || this.phase === 'vote')) {
      if (pid === this.fakeEntry().playerId) return true;
      return has(this.phase === 'write' ? cur.fakes : cur.votes, pid);
    }
    if (this.mode === 'fight' && this.phase === 'vote') {
      if (cur.match.some((id) => this.entryById(id).playerId === pid)) return true;
      return has(cur.votes, pid);
    }
    if (this.mode === 'chain' && this.phase === 'vote') return pid === cur.pickerId || has(cur.votes, pid);
    if (this.mode === 'hot' && this.phase === 'rate') return has(cur.ratings, pid);
    if (this.phase === 'vote') return has(cur.votes, pid);
    return false;
  }

  tracksReadiness() {
    return ['submit', 'vote', 'write', 'rate'].includes(this.phase) || (this.phase === 'listen' && this.mode === 'loose');
  }

  allDone() { return this.players.every((p) => this.isDone(p.id)); }

  // ---------- shared actions ----------
  submit(pid, slot, input) {
    this.mustPlayer(pid);
    if (this.phase !== 'submit') throw new GameError('Song picks are closed right now');
    const g = this.g;
    let song;
    if (this.mode === 'loose' || this.mode === 'fake') {
      const arr = g.subs[pid];
      const i = Number(slot);
      if (!Number.isInteger(i) || i < 0 || i >= arr.length) throw new GameError('Unknown prompt');
      song = parseSong(input);
      arr[i] = song;
    } else {
      if (this.mode === 'king' && pid === g.cur.kingId) throw new GameError('The King doesn’t pick this round. Sit back and judge!');
      if ((this.mode === 'chain' || this.mode === 'hot') && pid !== g.cur.pickerId) throw new GameError('It’s not your turn to pick');
      song = parseSong(input);
      g.cur.subs[pid] = song;
    }
    if (this.allDone()) this.closeSubmissions();
    this.touch();
    return song;
  }

  closeSubmissions() {
    const g = this.g;
    if (this.mode === 'fight') return this.closeFight();
    if (this.mode === 'mind') return this.closeMind();
    if (this.mode === 'chain') return this.closeChain();
    if (this.mode === 'hot') return this.closeHot();
    if (this.mode === 'loose' || this.mode === 'fake') {
      const entries = [];
      for (const p of this.players) {
        g.subs[p.id].forEach((song, i) => { if (song) entries.push(this.makeEntry(p.id, song, g.assignments[p.id][i])); });
      }
      if (!entries.length) return this.endGame();
      g.queue = spreadOwners(entries, this.rng);
      this.recordHistory(g.queue);
      g.index = 0;
      return this.mode === 'fake' ? this.beginFakeSong() : this.beginLooseSong();
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
    } else if (this.mode === 'fight') this.nextFight();
    else if (this.mode === 'fake') this.nextFake();
    else if (this.mode === 'mind') this.nextMindRound();
    else if (this.mode === 'chain') this.nextChain();
    else if (this.mode === 'hot') this.nextHot();
    else if (this.mode === 'loose') {
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
    if (!['listen', 'reveal', 'judge', 'defend', 'vote', 'write', 'rate'].includes(this.phase)) throw new GameError('Nothing to play right now');
    const entry = this.entryById(entryId);
    if (!entry) throw new GameError('Unknown song');
    // During anonymous listening, only allow songs that have already been heard.
    if (this.phase === 'listen' && ['king', 'secret'].includes(this.mode)) {
      const idx = this.g.cur.queue.indexOf(entry);
      if (idx > this.g.cur.index) throw new GameError('That song hasn’t come up yet');
    }
    this.nowPlayingId = entry.id;
    this.npSeen = null; // a replay restarts the song, even if it's the same one
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
    if (this.phase !== 'vote') throw new GameError('No voting right now');
    if (this.mode === 'fight') return this.voteFight(pid, target);
    if (this.mode === 'fake') return this.voteFake(pid, target);
    if (this.mode === 'chain') return this.voteChain(pid, target);
    if (this.mode !== 'secret') throw new GameError('No voting right now');
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

  /** Turn order for the "take turns" modes: everyone once per lap, no one twice in a row. */
  turnOrder(laps) {
    const ids = this.players.map((p) => p.id);
    const order = [];
    for (let c = 0; c < laps; c++) {
      const s = shuffle(ids, this.rng);
      if (order.length && s[0] === order[order.length - 1]) s.push(s.shift());
      order.push(...s);
    }
    return order;
  }

  /** Move to the next turn whose player is still here; false when the order is used up. */
  advanceTurn() {
    const g = this.g;
    g.round++;
    while (g.round < g.order.length && !this.getPlayer(g.order[g.round])) g.round++;
    return g.round < g.order.length;
  }

  // ---------- Goose Fight ----------
  startFight() {
    this.g = { round: -1, rounds: this.settings.fightRounds, deck: [], cur: null };
    this.nextFightRound();
  }

  nextFightRound() {
    const g = this.g;
    g.round++;
    if (g.round >= g.rounds) return this.endGame();
    g.cur = {
      prompt: this.drawPrompt(PROMPTS.LOOSE, 'loose'), subs: {}, queue: [],
      alive: [], winners: [], bye: null, stage: 0, stageSize: 0, match: null, matchNo: 0, playIdx: 0, votes: {}, result: null,
    };
    this.phase = 'submit';
    this.nowPlayingId = null;
  }

  closeFight() {
    const cur = this.g.cur;
    const entries = this.players.filter((p) => cur.subs[p.id]).map((p) => this.makeEntry(p.id, cur.subs[p.id], cur.prompt));
    if (!entries.length) return this.nextFightRound();
    cur.queue = shuffle(entries, this.rng);
    this.recordHistory(cur.queue);
    cur.alive = cur.queue.map((e) => e.id);
    return this.beginFightStage();
  }

  /** A new bracket round from the songs still alive. An odd song out gets a bye. */
  beginFightStage() {
    const cur = this.g.cur;
    cur.stage++;
    cur.winners = [];
    cur.bye = null;
    cur.stageSize = cur.alive.length;
    if (cur.alive.length > 1 && cur.alive.length % 2 === 1) {
      cur.bye = cur.alive.pop();
      cur.winners.push(cur.bye);
    }
    return this.beginFightMatch();
  }

  beginFightMatch() {
    const cur = this.g.cur;
    cur.votes = {};
    cur.result = null;
    if (cur.alive.length < 2) {
      // Only one song in the whole fight: it wins by walkover.
      const id = cur.alive.shift();
      cur.match = null;
      this.addPoints(this.entryById(id).playerId, 2);
      cur.result = { winner: id, loser: null, tally: {}, tie: false, champion: id, walkover: true };
      this.phase = 'reveal';
      this.nowPlayingId = id;
      this.emitFx('crown');
      return;
    }
    cur.match = [cur.alive.shift(), cur.alive.shift()];
    cur.matchNo++;
    cur.playIdx = 0;
    this.phase = 'listen';
    this.nowPlayingId = cur.match[0];
  }

  voteFight(pid, target) {
    const cur = this.g.cur;
    if (!cur.match.includes(target)) throw new GameError('Pick one of the two songs');
    if (cur.match.some((id) => this.entryById(id).playerId === pid)) throw new GameError('Your song is in this fight! Sit this vote out.');
    cur.votes[pid] = target;
    if (this.allDone()) this.revealFight();
    this.touch();
  }

  revealFight() {
    const cur = this.g.cur;
    const [a, b] = cur.match;
    const tally = { [a]: 0, [b]: 0 };
    for (const t of Object.values(cur.votes)) if (has(tally, t)) tally[t]++;
    const tie = tally[a] === tally[b];
    const winner = tie ? (this.rng() < 0.5 ? a : b) : (tally[a] > tally[b] ? a : b);
    const owner = this.entryById(winner).playerId;
    this.addPoints(owner, 1);
    this.bump('fights', [owner]);
    cur.winners.push(winner);
    const champion = cur.alive.length === 0 && cur.winners.length === 1;
    if (champion) this.addPoints(owner, 2);
    cur.result = { winner, loser: winner === a ? b : a, tally, tie, champion: champion ? winner : null, walkover: false };
    this.phase = 'reveal';
    this.nowPlayingId = winner; // victory lap
    this.emitFx(champion ? 'crown' : 'reveal');
  }

  nextFight() {
    const cur = this.g.cur;
    if (this.phase === 'listen') {
      if (cur.playIdx === 0) { cur.playIdx = 1; this.nowPlayingId = cur.match[1]; } else this.phase = 'vote';
    } else if (this.phase === 'vote') this.revealFight();
    else if (this.phase === 'reveal') {
      if (cur.result.champion) return this.nextFightRound();
      if (cur.alive.length >= 2) return this.beginFightMatch();
      cur.alive = [...cur.winners, ...cur.alive];
      return this.beginFightStage();
    }
  }

  // ---------- Fake Prompt ----------
  startFake() {
    const n = this.settings.fakePrompts;
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
    this.g = { assignments, subs, deck, queue: [], index: 0, cur: null };
    this.phase = 'submit';
  }

  fakeEntry() { return this.g.queue.find((e) => e.id === this.g.cur.entryId); }

  beginFakeSong() {
    const g = this.g;
    const entry = g.queue[g.index];
    g.cur = { entryId: entry.id, fakes: {}, choices: null, votes: {}, result: null };
    this.phase = 'write';
    this.nowPlayingId = entry.id;
  }

  writeFake(pid, raw) {
    this.mustPlayer(pid);
    if (this.mode !== 'fake' || this.phase !== 'write') throw new GameError('No fake prompts right now');
    const entry = this.fakeEntry();
    if (pid === entry.playerId) throw new GameError('That’s your song. Just look innocent!');
    const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (text.length < 4) throw new GameError('Write a little more');
    if (text.length > MAX_FAKE) throw new GameError(`Keep it under ${MAX_FAKE} characters`);
    if (looseKey(text) === looseKey(entry.prompt)) throw new GameError('Whoa, that’s basically the real prompt! Write a different one.');
    this.g.cur.fakes[pid] = text;
    if (this.allDone()) this.openFakeVote();
    this.touch();
  }

  openFakeVote() {
    const cur = this.g.cur;
    const entry = this.fakeEntry();
    const byKey = new Map();
    const add = (text, author) => {
      const k = looseKey(text);
      if (!byKey.has(k)) byKey.set(k, { text, authors: [], real: false });
      const c = byKey.get(k);
      if (author) c.authors.push(author); else c.real = true;
    };
    add(entry.prompt, null);
    for (const [pid, t] of Object.entries(cur.fakes)) add(t, pid);
    cur.choices = shuffle([...byKey.values()], this.rng).map((c, i) => ({ id: `f${i}`, ...c }));
    if (cur.choices.length < 2) return this.revealFake(); // nobody wrote a fake
    this.phase = 'vote';
  }

  voteFake(pid, choiceId) {
    const cur = this.g.cur;
    if (pid === this.fakeEntry().playerId) throw new GameError('You know the real one. No voting!');
    const choice = cur.choices.find((c) => c.id === choiceId);
    if (!choice) throw new GameError('Pick one of the prompts');
    if (choice.authors.includes(pid)) throw new GameError('That’s your own fake!');
    cur.votes[pid] = choiceId;
    if (this.allDone()) this.revealFake();
    this.touch();
  }

  revealFake() {
    const cur = this.g.cur;
    const found = [];
    for (const [pid, id] of Object.entries(cur.votes)) {
      const c = cur.choices.find((x) => x.id === id);
      if (!c) continue;
      if (c.real) { found.push(pid); this.addPoints(pid, 2); } else {
        for (const a of c.authors) { this.addPoints(a, 1); this.bump('forged', [a]); }
      }
    }
    this.bump('correct', found);
    cur.result = { found, realId: (cur.choices.find((c) => c.real) || {}).id || null };
    this.phase = 'reveal';
    this.emitFx('reveal');
  }

  nextFake() {
    const g = this.g;
    if (this.phase === 'write') this.openFakeVote();
    else if (this.phase === 'vote') this.revealFake();
    else if (this.phase === 'reveal') {
      g.index++;
      if (g.index < g.queue.length) this.beginFakeSong(); else this.endGame();
    }
  }

  // ---------- Flock Mind ----------
  startMind() {
    this.g = { round: -1, rounds: this.settings.mindRounds, deck: [], cur: null };
    this.nextMindRound();
  }

  nextMindRound() {
    const g = this.g;
    g.round++;
    if (g.round >= g.rounds) return this.endGame();
    g.cur = { prompt: this.drawPrompt(PROMPTS.MIND, 'mind'), subs: {}, queue: [], groups: null };
    this.phase = 'submit';
    this.nowPlayingId = null;
  }

  closeMind() {
    const cur = this.g.cur;
    const entries = this.players.filter((p) => cur.subs[p.id]).map((p) => this.makeEntry(p.id, cur.subs[p.id], cur.prompt));
    if (!entries.length) return this.nextMindRound();
    cur.queue = entries;
    this.recordHistory(entries);
    cur.groups = matchGroups(entries);
    for (const group of cur.groups) {
      const ids = group.map((id) => entries.find((e) => e.id === id).playerId);
      for (const pid of ids) this.addPoints(pid, group.length - 1);
      this.bump('matches', ids, group.length - 1);
    }
    this.phase = 'reveal';
    this.nowPlayingId = cur.groups[0][0]; // the flock's favorite
    this.emitFx(cur.groups[0].length > 1 ? 'reveal' : 'none');
  }

  // ---------- Goose Chain ----------
  startChain() {
    this.g = { order: this.turnOrder(this.settings.chainLaps), round: -1, queue: [], chain: [], best: 0, cur: null };
    this.nextChainTurn();
  }

  nextChainTurn() {
    const g = this.g;
    if (!this.advanceTurn()) return this.endGame();
    const prevId = g.chain.length ? g.chain[g.chain.length - 1] : null;
    g.cur = { pickerId: g.order[g.round], subs: {}, prevId, entryId: null, votes: {}, result: null };
    this.phase = 'submit';
    this.nowPlayingId = prevId; // keep the last link playing for inspiration
  }

  closeChain() {
    const g = this.g;
    const cur = g.cur;
    const song = cur.subs[cur.pickerId];
    if (!song) return this.nextChainTurn(); // skipped turn: the chain stays intact
    const prev = cur.prevId ? g.queue.find((e) => e.id === cur.prevId) : null;
    const e = this.makeEntry(cur.pickerId, song, prev ? `Linked from “${prev.song.display}”` : 'Started a new chain');
    g.queue.push(e);
    this.recordHistory([e]);
    cur.entryId = e.id;
    this.nowPlayingId = e.id;
    if (!prev) {
      // The first song of a chain needs no vote.
      g.chain = [e.id];
      g.best = Math.max(g.best, 1);
      cur.result = { held: true, start: true, yes: 0, no: 0, length: 1 };
      this.phase = 'listen';
    } else this.phase = 'vote';
  }

  voteChain(pid, target) {
    const cur = this.g.cur;
    if (pid === cur.pickerId) throw new GameError('You can’t judge your own link!');
    if (target !== 'yes' && target !== 'no') throw new GameError('Vote yes or no');
    cur.votes[pid] = target === 'yes';
    if (this.allDone()) this.revealChain();
    this.touch();
  }

  revealChain() {
    const g = this.g;
    const cur = g.cur;
    const votes = Object.values(cur.votes);
    const yes = votes.filter(Boolean).length;
    const no = votes.length - yes;
    const held = yes >= no; // ties get the benefit of the doubt
    if (held) {
      g.chain.push(cur.entryId);
      g.best = Math.max(g.best, g.chain.length);
      this.addPoints(cur.pickerId, 1);
      this.bump('links', [cur.pickerId]);
    } else {
      const p = this.getPlayer(cur.pickerId);
      if (p) p.score = Math.max(0, p.score - 1);
      g.chain = [];
    }
    cur.result = { held, start: false, yes, no, length: g.chain.length };
    this.phase = 'reveal';
    this.emitFx(held ? 'reveal' : 'caught');
  }

  nextChain() {
    if (this.phase === 'vote') this.revealChain();
    else this.nextChainTurn();
  }

  // ---------- Honk Take ----------
  startHot() {
    this.g = { order: this.turnOrder(this.settings.hotCycles), round: -1, deck: [], cur: null };
    this.nextHotRound();
  }

  nextHotRound() {
    const g = this.g;
    if (!this.advanceTurn()) return this.endGame();
    g.cur = { pickerId: g.order[g.round], prompt: this.drawPrompt(PROMPTS.HOT, 'hot'), subs: {}, queue: [], ratings: {}, result: null };
    this.phase = 'submit';
    this.nowPlayingId = null;
  }

  closeHot() {
    const cur = this.g.cur;
    const song = cur.subs[cur.pickerId];
    if (!song) return this.nextHotRound();
    const e = this.makeEntry(cur.pickerId, song, cur.prompt);
    cur.queue = [e];
    this.recordHistory(cur.queue);
    this.phase = 'rate';
    this.nowPlayingId = e.id;
  }

  rate(pid, value) {
    this.mustPlayer(pid);
    if (this.mode !== 'hot' || this.phase !== 'rate') throw new GameError('No rating right now');
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new GameError('Rate it from 1 to 5');
    this.g.cur.ratings[pid] = n;
    if (this.allDone()) this.revealHot();
    this.touch();
  }

  revealHot() {
    const cur = this.g.cur;
    const truth = has(cur.ratings, cur.pickerId) ? cur.ratings[cur.pickerId] : null;
    const exact = [];
    const close = [];
    if (truth != null) {
      for (const [pid, r] of Object.entries(cur.ratings)) {
        if (pid === cur.pickerId) continue;
        const d = Math.abs(r - truth);
        if (d === 0) { exact.push(pid); this.addPoints(pid, 2); this.addPoints(cur.pickerId, 1); } else if (d === 1) { close.push(pid); this.addPoints(pid, 1); }
      }
    }
    this.bump('reads', exact);
    cur.result = { truth, exact, close };
    this.phase = 'reveal';
    this.emitFx('reveal');
  }

  nextHot() {
    if (this.phase === 'rate') this.revealHot();
    else if (this.phase === 'reveal') this.nextHotRound();
  }

  recordHistory(queue) {
    for (const e of queue) this.history.push({ entryId: e.id, playerId: e.playerId, prompt: e.prompt, song: e.song, mode: this.mode });
  }

  bump(stat, ids, n = 1) {
    if (!this.stats || n <= 0) return;
    const t = this.stats[stat] || (this.stats[stat] = {});
    for (const id of ids) t[id] = (t[id] || 0) + n;
  }

  /** Superlatives for the end screen. Ties share an award; zero counts never win. */
  awards() {
    const st = this.stats;
    if (!st) return [];
    const top = (table) => {
      const entries = Object.entries(table || {}).filter(([, n]) => n > 0);
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
    add('fighter', 'Heavyweight', st.fights, (n) => `won ${plural(n, 'fight')}`);
    add('forger', 'Master Forger', st.forged, (n) => `fooled ${plural(n, 'goose', 'geese')} with fake prompts`);
    add('hive', 'Hive Mind', st.matches, (n) => plural(n, 'match', 'matches'));
    add('linker', 'Missing Link', st.links, (n) => `forged ${plural(n, 'link')}`);
    add('reader', 'Mind Reader', st.reads, (n) => plural(n, 'exact guess', 'exact guesses'));
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
      case 'submit': {
        const songs = this.mode === 'loose' ? this.settings.promptsPerPlayer : this.mode === 'fake' ? this.settings.fakePrompts : 1;
        return songs * TIMERS.perSong * 1000;
      }
      case 'listen': return this.mode === 'loose' ? TIMERS.guess * 1000 : 0;
      case 'judge': return TIMERS.judge * 1000;
      case 'vote': return TIMERS.vote * 1000;
      case 'write': return TIMERS.write * 1000;
      case 'rate': return TIMERS.rate * 1000;
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
    if (!has(MODE_PROMPTS, mode)) throw new GameError('Unknown game mode');
    const kind = MODE_PROMPTS[mode];
    if (!kind) throw new GameError(`${MODES[mode].name} doesn’t use prompts`);
    const text = String(rawText ?? '').trim().replace(/\s+/g, ' ');
    const max = kind === 'secret' ? 30 : 220;
    if (text.length < (kind === 'secret' ? 2 : 8)) throw new GameError(kind === 'secret' ? 'Type a feeling' : 'That prompt is a bit short');
    if (text.length > max) throw new GameError(`Keep it under ${max} characters`);
    const list = this.custom[kind];
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

  /** Bulk-add prompts ({loose:[], king:[], secret:[], mind:[], hot:[]}); skips duplicates and invalid ones. */
  importPack(pack) {
    if (!pack || typeof pack !== 'object') throw new GameError('That pack file looks empty');
    let added = 0;
    for (const mode of PROMPT_KINDS) {
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
    for (const mode of PROMPT_KINDS) out[mode] = this.custom[mode].map((c) => c.text);
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
    room.npSeen = room.nowPlayingId; // keep the saved start time
    room.settings = { ...new Room('x').settings, ...room.settings };
    room.custom = { loose: [], king: [], secret: [], mind: [], hot: [], ...room.custom };
    for (const p of [...room.players, ...room.audience]) { p.connected = false; normalizeLook(p); }
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
    this.onEvent('react', { kind, color: p.color, name: p.name, from: pid });
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
      players: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color, ...lookOf(p), score: p.score, connected: p.connected })),
      hats: HATS,
      accessories: ACCESSORIES,
      feathers: FEATHERS,
      faces: FACES,
      colors: COLORS,
      ready: this.tracksReadiness() ? this.players.filter((p) => this.isDone(p.id)).map((p) => p.id) : [],
      fx: this.fx,
      timer: this.deadline ? { deadline: this.deadline, now: this.clock.now() } : null,
      now: this.clock.now(),
      // The song itself is public (the TV shows it); never who picked it.
      nowPlaying: this.nowPlayingView(),
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
    v.audience = this.audience.map((a) => ({ id: a.id, name: a.name, ...lookOf(a), connected: a.connected }));
    if (isHost) {
      v.modes = Object.values(MODES);
      v.packs = Object.entries(PROMPTS.PACKS).map(([key, p]) => ({ key, name: p.name }));
      v.custom = this.custom;
    } else if (this.getAudience(pid)) {
      // Audience members see what the TV shows (public info only) and can react.
      const a = this.getAudience(pid);
      v.me = { id: a.id, name: a.name, color: a.color, ...lookOf(a), score: 0 };
      v.isAudience = true;
      v.mySuggestions = [];
      if (this.g && this.phase !== 'gameover') Object.assign(v, this.modeView(null, true));
      return v;
    } else {
      const me = this.getPlayer(pid);
      v.me = me ? { id: me.id, name: me.name, color: me.color, ...lookOf(me), score: me.score } : null;
      v.mySuggestions = Object.entries(this.custom).flatMap(([mode, list]) => list.filter((c) => c.by === pid).map((c) => ({ mode, text: c.text })));
    }
    if (this.g && this.phase !== 'gameover') Object.assign(v, this.modeView(pid, isHost));
    return v;
  }

  modeView(pid, isHost) {
    switch (this.mode) {
      case 'loose': return this.looseView(pid, isHost);
      case 'king': return this.kingView(pid, isHost);
      case 'secret': return this.secretView(pid, isHost);
      case 'fight': return this.fightView(pid, isHost);
      case 'fake': return this.fakeView(pid, isHost);
      case 'mind': return this.mindView(pid, isHost);
      case 'chain': return this.chainView(pid, isHost);
      case 'hot': return this.hotView(pid, isHost);
      default: return {};
    }
  }

  fightView(pid, isHost) {
    const g = this.g;
    const c = g.cur;
    const reveal = this.phase === 'reveal';
    const v = { round: g.round + 1, rounds: g.rounds, prompt: c.prompt };
    if (!isHost) v.mySong = songView(c.subs[pid]);
    const side = (id) => {
      const e = this.entryById(id);
      return { id, display: e.song.display, ownerId: reveal ? e.playerId : undefined };
    };
    if (c.stageSize) {
      v.stage = { number: c.stage, label: c.stageSize <= 2 ? 'Final' : c.stageSize <= 4 ? 'Semifinal' : c.stageSize <= 8 ? 'Quarterfinal' : `Round ${c.stage}` };
      v.left = c.alive.length + c.winners.length + (reveal || !c.match ? 0 : 2);
      v.bye = c.bye ? side(c.bye) : null;
    }
    if (c.match) {
      v.match = { number: c.matchNo, a: side(c.match[0]), b: side(c.match[1]), playing: this.phase === 'listen' ? c.playIdx : null };
      if (!isHost) {
        const mine = c.match.find((id) => this.entryById(id).playerId === pid);
        v.myEntry = mine || null;
        v.myVote = c.votes[pid] || null;
      }
    }
    if (reveal) {
      v.result = { ...c.result, winnerSide: side(c.result.winner), loserSide: c.result.loser ? side(c.result.loser) : null };
      v.votes = { ...c.votes };
    }
    return v;
  }

  fakeView(pid, isHost) {
    const g = this.g;
    const v = { promptsPerPlayer: this.settings.fakePrompts, total: g.queue.length, index: g.index };
    if (this.phase === 'submit') {
      if (!isHost) v.prompts = g.assignments[pid].map((text, i) => ({ text, song: songView(g.subs[pid][i]) }));
      return v;
    }
    const c = g.cur;
    const e = this.fakeEntry();
    const reveal = this.phase === 'reveal';
    v.current = { number: g.index + 1, display: e.song.display };
    if (!isHost) {
      v.isMine = e.playerId === pid;
      if (v.isMine || reveal) v.realPrompt = e.prompt;
      v.myFake = c.fakes[pid] || null;
      v.myVote = c.votes[pid] || null;
    }
    if (c.choices) {
      v.choices = c.choices.map((ch) => ({
        id: ch.id, text: ch.text,
        mine: !isHost && ch.authors.includes(pid),
        ...(reveal ? { real: ch.real, authors: ch.authors } : {}),
      }));
    }
    if (reveal) {
      v.realPrompt = e.prompt;
      v.ownerId = e.playerId;
      v.votes = { ...c.votes };
      v.result = c.result;
    }
    return v;
  }

  mindView(pid, isHost) {
    const g = this.g;
    const c = g.cur;
    const v = { round: g.round + 1, rounds: g.rounds, prompt: c.prompt };
    if (!isHost) v.mySong = songView(c.subs[pid]);
    if (this.phase === 'reveal' && c.groups) {
      v.groups = c.groups.map((ids) => ids.map((id) => {
        const e = this.entryById(id);
        return { id, display: e.song.display, ownerId: e.playerId };
      }));
    }
    return v;
  }

  chainView(pid, isHost) {
    const g = this.g;
    const c = g.cur;
    const byId = (id) => g.queue.find((e) => e.id === id);
    const link = (e) => ({ id: e.id, display: e.song.display, ownerId: e.playerId });
    const v = { round: g.round + 1, rounds: g.order.length, pickerId: c.pickerId, chainLength: g.chain.length, best: g.best };
    v.chain = g.chain.slice(-6).map((id) => link(byId(id)));
    if (c.prevId) v.prev = link(byId(c.prevId));
    if (c.entryId) v.current = link(byId(c.entryId));
    if (!isHost) {
      v.isPicker = pid === c.pickerId;
      if (v.isPicker) v.mySong = songView(c.subs[pid]);
      v.myVote = has(c.votes, pid) ? (c.votes[pid] ? 'yes' : 'no') : null;
    }
    if (this.phase === 'reveal' || (this.phase === 'listen' && c.result)) v.result = c.result;
    return v;
  }

  hotView(pid, isHost) {
    const g = this.g;
    const c = g.cur;
    const v = { round: g.round + 1, rounds: g.order.length, pickerId: c.pickerId, prompt: c.prompt };
    if (c.queue.length) v.current = { id: c.queue[0].id, display: c.queue[0].song.display };
    if (!isHost) {
      v.isPicker = pid === c.pickerId;
      if (v.isPicker) v.mySong = songView(c.subs[pid]);
      v.myRating = c.ratings[pid] || null;
    }
    if (this.phase === 'reveal') {
      v.ratings = { ...c.ratings };
      v.result = c.result;
    }
    return v;
  }

  nowPlayingView() {
    const entry = this.entryById(this.nowPlayingId);
    if (!entry) return null;
    return { entryId: entry.id, number: this.currentQueue().indexOf(entry) + 1, startedAt: this.nowPlayingAt, song: songView(entry.song) };
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

module.exports = { MAX_AUDIENCE, Room, MODES, MIN_PLAYERS, SWAPS_PER_GAME, MAX_PLAYERS, TIMERS, REACTIONS, HATS, ACCESSORIES, FEATHERS, FACES, GameError, shuffle, matchGroups };
