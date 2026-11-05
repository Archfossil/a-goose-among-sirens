// Host / big-screen view: shows the room code, prompts, reveals and scores,
// plays the submitted songs, and drives the WebGL scene.

import {
  h, api, openStream, toast, store, playerById, chip, searchUrls, gooseIcon, modeIcon,
  mountInto, clearKept, syncClock, timerBadge, secondsLeft, copyText, songHref, setlistText, youtubePlaylistUrl, gooseAvatar,
} from './common.js';
import { Scene } from './scene.js';
import { sfx } from './sfx.js';

const SESSION_KEY = 'goose.host';
const scene = new Scene(document.getElementById('bg'));
const $ = (id) => document.getElementById(id);

let session = store.get(SESSION_KEY);
let state = null;
let info = { urls: [] };
let es = null;
let lastFx = null;
let musicKey = null;
let online = true;
let customOpen = false;
let qrLib = null;
let prev = null;          // previous state, to animate what changed
let prevScores = {};
let lastTickLeft = null;

// ---------- boot ----------

async function boot() {
  try { info = await (await fetch('/api/info')).json(); } catch { /* offline is fine */ }
  if (!session) await newRoom();
  connect();
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, button, select')) return;
    if (e.key === 'Enter' || e.key === 'n' || e.key === 'N') { const b = document.querySelector('[data-primary]'); if (b && !b.disabled) b.click(); }
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });
}

async function newRoom() {
  session = await api('/api/create');
  store.set(SESSION_KEY, session);
}

function connect() {
  es?.close();
  es = openStream({ code: session.code, role: 'host', token: session.token }, {
    onState: (s) => { state = s; syncClock(s); render(); },
    events: { react: (r) => { scene.react(r.kind); if (r.kind === 'honk') sfx.honk(); } },
    onStatus: (ok) => { if (ok !== online) { online = ok; renderTop(); } },
    onFatal: async () => {
      // Server restarted or room expired: open a fresh room.
      store.set(SESSION_KEY, null);
      await newRoom();
      lastFx = null;
      connect();
    },
  });
}

async function act(type, extra = {}) {
  try {
    return await api('/api/action', { code: session.code, token: session.token, type, ...extra });
  } catch (err) {
    toast(err.message);
    return null;
  }
}

function joinUrl() {
  const lan = info.urls && info.urls[0];
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return (isLocal && lan) ? lan : location.origin;
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

const name = (id) => playerById(state, id)?.name || 'Someone';

// ---------- render ----------

function render() {
  if (!state) return;
  const s = state;
  scene.setMood(s.phase === 'lobby' ? 'lobby' : s.phase === 'gameover' ? 'gameover' : s.mode);
  scene.setSinging(Boolean(s.nowPlaying) && ['listen', 'reveal', 'judge', 'defend', 'vote'].includes(s.phase));
  const fxN = s.fx ? s.fx.n : 0;
  if (lastFx !== null && fxN !== lastFx && s.fx && s.fx.kind !== 'none') {
    scene.burst(s.fx.kind);
    playFx(s.fx.kind);
  }
  lastFx = fxN;
  if (prev && s.phase === 'lobby' && s.players.length > prev.players.length) sfx.pop();
  titleCard(s);

  renderTop();
  mountInto($('main'), mainView(s));
  renderSide(s);
  $('controls').replaceChildren(...controls(s).filter(Boolean));
  renderMusic(s.nowPlaying);
  prev = s;
}

function playFx(kind) {
  if (kind === 'reveal') sfx.chime();
  else if (kind === 'crown' || kind === 'gameover') sfx.fanfare();
  else if (kind === 'caught') sfx.honk(2);
  else if (kind === 'escaped') sfx.sneak();
}

// Countdown ticks for the last five seconds.
setInterval(() => {
  const left = state?.timer ? secondsLeft(state.timer) : null;
  if (left !== lastTickLeft && left != null && left > 0 && left <= 5) sfx.tick(left <= 3);
  lastTickLeft = left;
}, 200);

// ---------- title cards between rounds ----------

let lastCardKey = null;
let cardTimer = null;

function titleCard(s) {
  const key = `${s.mode}:${s.phase}:${s.round ?? ''}`;
  const changed = key !== lastCardKey;
  const first = lastCardKey === null;
  lastCardKey = key;
  if (!changed || first) return;
  let card = null;
  if (s.phase === 'submit') {
    if (s.mode === 'loose') card = { kicker: 'A Goose is Loose!', title: 'Pick your songs', sub: 'Your secret prompts are on your phones' };
    if (s.mode === 'king') card = { kicker: `Round ${s.round} of ${s.rounds}`, title: `All hail King ${playerById(s, s.kingId)?.name || 'Goose'}`, sub: 'Subjects: pick the soundtrack', player: playerById(s, s.kingId) };
    if (s.mode === 'secret') card = { kicker: `Round ${s.round} of ${s.rounds}`, title: 'A Goose walks among you', sub: 'Check your phone. Don\u2019t say the feeling out loud!' };
  } else if (s.phase === 'judge') card = { kicker: 'King Goose', title: 'Judgement time', sub: 'The crown awaits' };
  else if (s.phase === 'defend') card = { kicker: 'The feeling was', title: s.prompt, sub: 'Make your case!' };
  else if (s.phase === 'vote') card = { kicker: 'Secret Goose', title: 'Who\u2019s the Goose?', sub: 'Vote on your phones' };
  else if (s.phase === 'gameover') card = { kicker: 'That\u2019s a wrap', title: 'Final scores', sub: '' };
  if (!card) {
    // The game moved on (e.g. the King judged instantly): don't let an old card cover the reveal.
    $('titlecard')?.classList.remove('show');
    return;
  }
  let el = $('titlecard');
  if (!el) { el = h('div', { id: 'titlecard', 'aria-live': 'polite' }); document.body.append(el); }
  el.replaceChildren(h('div', { class: 'tc-inner' },
    card.player ? gooseAvatar(card.player, 'tc-avatar') : gooseIcon('tc-goose'),
    h('div', { class: 'kicker' }, card.kicker),
    h('div', { class: 'tc-title' }, card.title),
    card.sub ? h('div', { class: 'tc-sub' }, card.sub) : null));
  el.classList.remove('show');
  void el.offsetWidth; // restart the animation
  el.classList.add('show');
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => el.classList.remove('show'), 2300);
}

// ---------- scoreboard with rank animation + score pops ----------

function renderSide(s) {
  const side = $('side');
  const before = new Map([...side.querySelectorAll('li[data-id]')].map((li) => [li.dataset.id, li.getBoundingClientRect().top]));
  side.replaceChildren(scoreboard(s));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const li of side.querySelectorAll('li[data-id]')) {
    const was = before.get(li.dataset.id);
    if (was == null || reduce) continue;
    const dy = was - li.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 550, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  prevScores = Object.fromEntries(s.players.map((p) => [p.id, p.score]));
}

function renderTop() {
  if (!state) return;
  const url = joinUrl().replace(/^https?:\/\//, '');
  $('top').replaceChildren(...[
    h('div', { class: 'logo' }, gooseIcon('logo-goose'), ' A Goose ', h('em', null, 'Among'), ' Sirens'),
    state.phase === 'lobby' ? null : h('div', { class: 'mode-pill with-icon' }, modeIcon(state.mode), state.modeInfo.name),
    h('div', { class: 'joinbar' },
      online ? null : h('span', { class: 'offline' }, 'Reconnecting…'),
      h('span', null, 'Join at ', h('strong', null, url)),
      h('span', { class: 'code-pill' }, state.code),
    ),
  ].filter(Boolean));
}

function mainView(s) {
  switch (s.phase) {
    case 'lobby': return lobbyView(s);
    case 'gameover': return gameoverView(s);
    default:
      if (s.mode === 'loose') return looseView(s);
      if (s.mode === 'king') return kingView(s);
      return secretView(s);
  }
}

function panel(cls, ...kids) { return h('section', { class: `panel ${cls || ''}` }, ...kids); }
function kicker(text) { return h('div', { class: 'kicker' }, text); }
function bigPrompt(text) { return h('blockquote', { class: 'big-prompt' }, text); }

function progress(s, ids) {
  const ready = new Set(s.ready);
  return h('div', { class: 'progress' }, ids.map((id) => {
    const p = playerById(s, id);
    return chip(p, ready.has(id) ? 'done' : 'pending');
  }));
}

// ----- lobby -----

function lobbyView(s) {
  const url = joinUrl().replace(/^https?:\/\//, '');
  const join = panel('join-card',
    h('div', { class: 'join-step' }, 'Grab your phone and go to'),
    h('div', { class: 'join-url' }, url),
    h('div', { class: 'join-step' }, 'then enter the room code'),
    h('div', { class: 'room-code' }, s.code),
    qrCode(`${joinUrl()}/?code=${s.code}`),
    s.players.length ? h('div', { class: 'flock' }, s.players.map((p, i) => h('div', { class: 'flock-goose', style: { '--i': String(i) } },
      gooseAvatar(p), h('span', null, p.name)))) : null,
  );
  const modes = panel('',
    h('h2', null, 'Pick a game'),
    h('div', { class: 'modes' }, s.modes.map((m) => h('button', {
      class: `mode-card${m.key === s.mode ? ' selected' : ''}`,
      'aria-pressed': m.key === s.mode ? 'true' : 'false',
      onclick: () => act('setMode', { mode: m.key }),
    },
    modeIcon(m.key, 'mode-emoji'),
    h('div', { class: 'mode-name' }, m.name),
    h('div', { class: 'mode-short' }, m.short),
    h('p', null, m.rules)))),
    settingsRow(s),
  );
  return [join, modes, customPanel(s)];
}

function settingsRow(s) {
  const opt = {
    loose: { key: 'promptsPerPlayer', label: 'Prompts per player', values: [1, 2, 3] },
    king: { key: 'kingCycles', label: 'Turns as King each', values: [1, 2, 3] },
    secret: { key: 'secretRounds', label: 'Rounds', values: [3, 5, 8, 12] },
  }[s.mode];
  const cur = s.settings[opt.key];
  return h('div', { class: 'settings' },
    h('span', { class: 'settings-label' }, opt.label),
    h('div', { class: 'segmented', role: 'group', 'aria-label': opt.label }, opt.values.map((v) => h('button', {
      class: v === cur ? 'on' : '',
      'aria-pressed': v === cur ? 'true' : 'false',
      onclick: () => act('setSettings', { settings: { [opt.key]: v } }),
    }, String(v)))),
    h('span', { class: 'settings-label' }, 'Timers'),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Timers' }, [false, true].map((v) => h('button', {
      class: s.settings.timers === v ? 'on' : '',
      'aria-pressed': s.settings.timers === v ? 'true' : 'false',
      title: v ? 'Countdowns for picking songs, guessing, judging and voting' : 'No countdowns: the host moves things along',
      onclick: () => act('setSettings', { settings: { timers: v } }),
    }, v ? 'On' : 'Off'))),
    h('span', { class: 'settings-label' }, 'Family mode'),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Family mode' }, [false, true].map((v) => h('button', {
      class: s.settings.family === v ? 'on' : '',
      'aria-pressed': s.settings.family === v ? 'true' : 'false',
      title: v ? 'Skip the crude and dark built-in prompts' : 'All built-in prompts',
      onclick: () => act('setSettings', { settings: { family: v } }),
    }, v ? 'On' : 'Off'))),
  );
}

const CUSTOM_HINTS = {
  loose: { label: 'prompt', placeholder: 'What song would you play at a goose wedding?' },
  king: { label: 'scenario', placeholder: 'King Goose gets stuck in a revolving door for three days.' },
  secret: { label: 'feeling', placeholder: 'Hangry' },
};

function customPanel(s) {
  const list = s.custom[s.mode];
  const hint = CUSTOM_HINTS[s.mode];
  const key = `custom-${s.mode}`;
  const details = h('details', { class: 'panel custom', open: customOpen, ontoggle: (e) => { customOpen = e.currentTarget.open; } },
    h('summary', null, h('h2', null, `Your own ${hint.label}s`), h('span', { class: 'count' }, list.length ? `${list.length} added` : 'optional')),
    h('p', { class: 'muted' }, `Custom ${hint.label}s are dealt first. Players can suggest them from their phones while they wait.`),
    h('form', {
      class: 'inline-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const text = e.currentTarget.querySelector('input').value.trim();
        if (!text) return;
        if (await act('addPrompt', { mode: s.mode, text })) clearKept($('main'), key);
      },
    },
    h('input', { type: 'text', 'data-keep': key, placeholder: hint.placeholder, maxlength: s.mode === 'secret' ? 30 : 220, 'aria-label': `New ${hint.label}` }),
    h('button', { class: 'btn primary', type: 'submit' }, 'Add')),
    h('div', { class: 'pack-row' },
      h('span', { class: 'settings-label' }, 'Bonus packs'),
      s.packs.map((pk) => h('button', { class: 'btn small ghost', onclick: async () => { const r = await act('addPack', { key: pk.key }); if (r) toast(`Added ${r.added} prompts from ${pk.name}`); } }, `+ ${pk.name}`)),
      h('span', { class: 'pack-spacer' }),
      h('button', { class: 'btn small ghost', onclick: () => exportPack(s), title: 'Download your custom prompts as a file' }, 'Export'),
      h('label', { class: 'btn small ghost file-btn', title: 'Load a prompt pack file' }, 'Import',
        h('input', { type: 'file', accept: '.json,application/json', onchange: (e) => importPack(e.currentTarget) }))),
    list.length ? h('ul', { class: 'custom-list' }, list.map((c) => h('li', null,
      h('span', { class: 'custom-text' }, c.text),
      c.by ? h('span', { class: 'muted', title: 'Suggested by a player' }, 'from a phone') : null,
      h('button', { class: 'btn small ghost', 'aria-label': 'Remove', title: 'Remove', onclick: () => act('removePrompt', { id: c.id }) }, '\u2715'),
    ))) : null,
  );
  return details;
}

function exportPack(s) {
  const pack = { name: 'A Goose Among Sirens prompt pack', version: 1 };
  for (const mode of ['loose', 'king', 'secret']) pack[mode] = s.custom[mode].map((c) => c.text);
  const total = pack.loose.length + pack.king.length + pack.secret.length;
  if (!total) return toast('Add some prompts first');
  const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: 'goose-prompts.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importPack(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  if (file.size > 60 * 1024) return toast('That file is too big for a prompt pack');
  let pack;
  try { pack = JSON.parse(await file.text()); } catch { return toast('That isn\u2019t a prompt pack file'); }
  const r = await act('importPack', { pack });
  if (r) toast(`Imported ${r.added} prompts`);
}

// QR code for joining. Uses qrcode-generator from a CDN; if offline, the URL + code still work.
function qrCode(url) {
  const box = h('div', { class: 'qr', 'aria-label': 'QR code to join' });
  const draw = () => {
    try {
      const qr = qrLib(0, 'M');
      qr.addData(url);
      qr.make();
      const n = qr.getModuleCount();
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `-2 -2 ${n + 4} ${n + 4}`);
      svg.setAttribute('shape-rendering', 'crispEdges');
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      const bg = document.createElementNS(NS, 'rect');
      Object.entries({ x: -2, y: -2, width: n + 4, height: n + 4, fill: '#fff', rx: 1.5 }).forEach(([k, v]) => bg.setAttribute(k, v));
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', '#1a1030');
      svg.append(bg, path);
      box.replaceChildren(svg, h('div', { class: 'qr-cap' }, 'or scan me'));
    } catch (err) {
      console.warn('QR failed', err);
    }
  };
  if (qrLib) draw();
  else loadQrLib().then(() => { if (qrLib && box.isConnected) draw(); });
  return box;
}

let qrLoading = null;
function loadQrLib() {
  if (!qrLoading) {
    qrLoading = new Promise((resolve) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
      sc.onload = () => { qrLib = window.qrcode || null; resolve(); if (state?.phase === 'lobby') render(); };
      sc.onerror = () => resolve();
      document.head.append(sc);
    });
  }
  return qrLoading;
}

// ----- A Goose is Loose! -----

function looseView(s) {
  if (s.phase === 'submit') {
    return panel('center',
      kicker('Check your phones'),
      h('h1', null, 'Pick your songs!'),
      h('p', { class: 'lede' }, `Everyone has ${s.promptsPerPlayer} secret prompt${s.promptsPerPlayer > 1 ? 's' : ''}. Answer each with a song. Paste a YouTube or Spotify link, or just type it in.`),
      progress(s, s.players.map((p) => p.id)),
    );
  }
  const c = s.current;
  if (s.phase === 'listen') {
    return panel('center',
      kicker(`Song ${c.number} of ${s.total}`),
      bigPrompt(c.prompt),
      h('h2', { class: 'ask' }, 'Who is the Goose behind this song?'),
      h('p', { class: 'lede' }, 'Lock in your guess on your phone.'),
      progress(s, s.players.map((p) => p.id)),
    );
  }
  // reveal
  const r = s.result;
  const owner = playerById(s, r.ownerId);
  const guessers = Object.keys(r.guesses);
  return panel('center reveal',
    kicker(`Song ${c.number} of ${s.total}`),
    bigPrompt(c.prompt),
    h('div', { class: 'reveal-line' }, 'It was ', chip(owner, 'huge'), '!'),
    h('p', { class: 'lede' }, h('strong', null, `${owner?.name || 'The Goose'}, explain yourself.`), ' Why this song?'),
    h('ul', { class: 'guess-list' }, guessers.length ? guessers.map((gid) => h('li', { class: r.guesses[gid] === r.ownerId ? 'right' : 'wrong' },
      chip(playerById(s, gid)), h('span', { class: 'arrow' }, 'guessed'), chip(playerById(s, r.guesses[gid])),
      h('span', { class: 'mark' }, r.guesses[gid] === r.ownerId ? '+1' : '✗'),
    )) : h('li', { class: 'muted' }, 'Nobody guessed!')),
  );
}

// ----- King Goose -----

function kingView(s) {
  const king = playerById(s, s.kingId);
  const header = [kicker(`Round ${s.round} of ${s.rounds}`), h('div', { class: 'king-line' }, '\u{1F451} ', chip(king, 'huge'), ' is King Goose')];
  const others = s.players.filter((p) => p.id !== s.kingId).map((p) => p.id);
  if (s.phase === 'submit') {
    return panel('center', ...header, bigPrompt(s.prompt),
      h('p', { class: 'lede' }, 'Loyal subjects: choose the soundtrack for this moment on your phones.'),
      progress(s, others));
  }
  if (s.phase === 'listen') {
    return panel('center', ...header, bigPrompt(s.prompt),
      h('h2', { class: 'ask' }, `Soundtrack ${s.track.number} of ${s.track.total}`),
      h('p', { class: 'lede' }, 'Your Majesty, listen closely. You’ll judge after the last one.'));
  }
  if (s.phase === 'judge') {
    return panel('center', ...header, bigPrompt(s.prompt),
      h('h2', { class: 'ask' }, `${king?.name || 'The King'} is choosing a winner…`),
      trackList(s, s.tracks, { replay: true }));
  }
  // reveal
  const winner = playerById(s, s.winnerId);
  return panel('center reveal', ...header, bigPrompt(s.prompt),
    winner ? h('div', { class: 'reveal-line' }, 'The crown goes to ', chip(winner, 'huge'), '!')
      : h('div', { class: 'reveal-line' }, 'The King abstained. No points this round.'),
    trackList(s, s.tracks, { owners: true, highlight: s.pick, replay: true }));
}

function trackList(s, tracks, { owners = false, highlight = null, replay = false } = {}) {
  return h('ol', { class: 'tracks' }, tracks.map((t) => h('li', {
    class: [t.id === highlight ? 'winner' : '', s.nowPlaying?.entryId === t.id ? 'playing' : ''].join(' ').trim(),
  },
  h('span', { class: 'track-num' }, `#${t.number}`),
  h('span', { class: 'track-title' }, t.display),
  owners && t.ownerId ? chip(playerById(s, t.ownerId)) : null,
  replay ? h('button', { class: 'btn small ghost', onclick: () => act('play', { entryId: t.id }), 'aria-label': `Play track ${t.number}` }, s.nowPlaying?.entryId === t.id ? '♫' : '▶') : null,
  )));
}

// ----- Secret Goose -----

function secretView(s) {
  const header = kicker(`Round ${s.round} of ${s.rounds}`);
  const all = s.players.map((p) => p.id);
  if (s.phase === 'submit') {
    return panel('center', header,
      h('h1', null, 'A secret feeling is on your phones'),
      h('p', { class: 'lede' }, 'Everyone got the same one-word feeling, except the ', h('strong', null, 'Secret Goose'), ', who has to pick a song blind. Pick a song that captures it. Don’t say it out loud!'),
      progress(s, all));
  }
  if (s.phase === 'listen') {
    return panel('center', header,
      h('h1', null, `Track ${s.track.number} of ${s.track.total}`),
      h('p', { class: 'lede' }, 'What feeling ties these songs together? And which one doesn’t belong?'));
  }
  if (s.phase === 'defend' || s.phase === 'vote') {
    return panel('center', header,
      h('div', { class: 'kicker' }, 'The feeling was'),
      h('div', { class: 'feeling' }, s.prompt),
      s.phase === 'defend'
        ? h('p', { class: 'lede' }, 'Everyone, make your case for why your song fits. One of you never saw the feeling…')
        : h('h2', { class: 'ask' }, 'Vote on your phones: who is the Secret Goose?'),
      trackList(s, s.tracks, { owners: true, replay: true }),
      s.phase === 'vote' ? progress(s, all) : null);
  }
  // reveal
  const goose = playerById(s, s.gooseId);
  const r = s.result;
  return panel('center reveal', header,
    h('div', { class: 'kicker' }, `The feeling was “${s.prompt}”`),
    h('div', { class: 'reveal-line' }, 'The Secret Goose was ', chip(goose, 'huge'), '!'),
    h('p', { class: 'verdict' }, r.caught ? 'Caught! Honk of shame.' : `${goose?.name || 'The Goose'} escaped and gets +2!`),
    h('ul', { class: 'guess-list' }, Object.keys(s.votes).map((vid) => h('li', { class: s.votes[vid] === s.gooseId && vid !== s.gooseId ? 'right' : 'wrong' },
      chip(playerById(s, vid)), h('span', { class: 'arrow' }, 'voted'), chip(playerById(s, s.votes[vid])),
      h('span', { class: 'mark' }, vid === s.gooseId ? 'decoy vote' : s.votes[vid] === s.gooseId ? '+1' : '✗'),
    ))));
}

// ----- game over -----

function gameoverView(s) {
  const ranked = [...s.players].sort((a, b) => b.score - a.score);
  const top = ranked[0]?.score ?? 0;
  const winners = ranked.filter((p) => p.score === top);
  return [panel('center reveal',
    kicker('Final scores'),
    h('h1', null, top === 0 ? 'Nobody scored! Honk of shame.' : winners.length > 1 ? 'It\u2019s a tie!' : 'The Siren Song Champion'),
    top === 0 ? null : h('div', { class: 'winners' }, winners.map((w) => h('div', { class: 'champ' }, gooseAvatar({ ...w, hat: 'crown' }, 'xl'), chip(w, 'huge')))),
    h('ol', { class: 'podium' }, ranked.map((p, i) => h('li', null,
      h('span', { class: 'rank' }, `${i + 1}`), gooseAvatar(p, 'sm'), chip(p), h('span', { class: 'pts' }, `${p.score} pt${p.score === 1 ? '' : 's'}`)))),
  ), songOfTheNight(s), awardsPanel(s), setlistPanel(s)];
}

const AWARD_ICONS = { ears: '\u{1F442}', disguise: '\u{1F978}', royal: '\u{1F451}', bluffer: '\u{1F92B}', detective: '\u{1F50E}', hype: '\u{1F4E3}', crowd: '\u{1F525}' };

function awardsPanel(s) {
  const awards = s.awards || [];
  if (!awards.length) return null;
  return panel('awards',
    kicker('Superlatives'),
    h('div', { class: 'award-grid' }, awards.map((a, i) => h('div', { class: 'award', style: { '--i': String(i) } },
      h('div', { class: 'award-icon', 'aria-hidden': 'true' }, AWARD_ICONS[a.key] || '\u2B50'),
      h('div', { class: 'award-title' }, a.title),
      h('div', { class: 'award-who' }, a.playerIds.map((id) => chip(playerById(s, id)))),
      h('div', { class: 'award-detail' }, a.detail)))));
}

function songOfTheNight(s) {
  const list = s.playlist || [];
  if (!list.length) return null;
  const winners = list.filter((t) => s.songOfTheNight.includes(t.entryId));
  if (!winners.length) {
    return panel('sotn waiting-votes', kicker('Song of the Night'),
      h('p', { class: 'lede' }, 'Heart your favorite song on your phone. (Not your own!)'));
  }
  return panel('sotn', kicker(winners.length > 1 ? 'Songs of the Night (tie)' : 'Song of the Night'),
    winners.map((t) => h('div', { class: 'sotn-song' },
      gooseAvatar(playerById(s, t.playerId) || {}, 'head'),
      h('div', null,
        h('a', { class: 'sotn-title', href: songHref(t.song), target: '_blank', rel: 'noopener' }, t.song.display),
        h('div', { class: 'muted' }, 'picked by ', h('strong', null, playerById(s, t.playerId)?.name || 'someone'), ` \u00B7 \u2764\uFE0F ${t.favs}`)))),
    h('div', { class: 'fine left' }, `${s.favoritesIn} vote${s.favoritesIn === 1 ? '' : 's'} in. Keep hearting on your phones!`));
}

function setlistPanel(s) {
  const list = s.playlist || [];
  if (!list.length) return null;
  const yt = youtubePlaylistUrl(list);
  return panel('setlist',
    h('div', { class: 'setlist-head' },
      h('div', null, kicker('Tonight\u2019s setlist'), h('h2', null, `${list.length} song${list.length === 1 ? '' : 's'} from the flock`)),
      h('div', { class: 'setlist-actions' },
        yt ? h('a', { class: 'btn primary', href: yt, target: '_blank', rel: 'noopener' }, '\u25B6 Play all on YouTube') : null,
        h('button', { class: 'btn ghost', onclick: async () => toast(await copyText(setlistText(list, s)) ? 'Setlist copied!' : 'Could not copy') }, 'Copy setlist'))),
    h('ol', { class: 'setlist-list' }, list.map((t) => h('li', null,
      chip(playerById(s, t.playerId)),
      h('div', { class: 'setlist-song' },
        h('a', { href: songHref(t.song), target: '_blank', rel: 'noopener' }, t.song.display),
        h('div', { class: 'setlist-prompt' }, t.prompt)),
      t.favs || t.reactions ? h('span', { class: 'react-count' },
        t.favs ? h('span', { title: `${t.favs} favorites` }, `\u2764\uFE0F ${t.favs} `) : null,
        t.reactions ? h('span', { title: `${t.reactions} reactions` }, `\u{1F525} ${t.reactions}`) : null) : null,
    ))),
  );
}

// ----- side + controls -----

function scoreboard(s) {
  const ranked = s.phase === 'lobby' ? s.players : [...s.players].sort((a, b) => b.score - a.score);
  const ready = new Set(s.ready);
  return panel('scores',
    h('h2', null, s.phase === 'lobby' ? `The flock (${s.players.length}/${s.maxPlayers})` : 'Scores'),
    ranked.length ? h('ul', { class: 'score-list' }, ranked.map((p) => {
      const gained = p.score - (prevScores[p.id] ?? p.score);
      return h('li', { 'data-id': p.id, class: [p.connected ? '' : 'away', gained > 0 ? 'bump' : ''].join(' ').trim() },
      gooseAvatar(p, 'sm'),
      h('span', { class: 'pname' }, p.name),
      gained > 0 ? h('span', { class: 'gain' }, `+${gained}`) : null,
      ready.has(p.id) ? h('span', { class: 'tick', title: 'Ready' }, '✓') : null,
      !p.connected ? h('span', { class: 'away-tag' }, 'away') : null,
      s.phase === 'lobby'
        ? h('button', { class: 'btn small ghost', title: `Remove ${p.name}`, 'aria-label': `Remove ${p.name}`, onclick: () => { if (confirm(`Remove ${p.name}?`)) act('kick', { playerId: p.id }); } }, '✕')
        : h('span', { class: 'pts' }, String(p.score)),
      );
    })) : h('p', { class: 'muted' }, 'Waiting for geese to waddle in…'),
    s.audience.length ? h('div', { class: 'audience' },
      h('div', { class: 'kicker' }, `Audience \u00B7 ${s.audience.length}`),
      h('p', { class: 'muted' }, s.audience.map((a) => a.name).join(', ')),
      h('p', { class: 'fine left' }, 'They react now and join the flock next game.')) : null,
  );
}

function nextLabel(s) {
  const last = (t) => t && t.number >= t.total;
  if (s.phase === 'submit') return 'Start without stragglers';
  if (s.mode === 'loose') {
    if (s.phase === 'listen') return 'Reveal the Goose';
    if (s.phase === 'reveal') return s.current.number >= s.total ? 'Final scores' : 'Next song';
  }
  if (s.mode === 'king') {
    if (s.phase === 'listen') return last(s.track) ? 'To the judging!' : 'Next soundtrack';
    if (s.phase === 'judge') return 'Skip judging';
    if (s.phase === 'reveal') return s.round >= s.rounds ? 'Final scores' : 'Next King';
  }
  if (s.mode === 'secret') {
    if (s.phase === 'listen') return last(s.track) ? 'Reveal the feeling' : 'Next track';
    if (s.phase === 'defend') return 'Start the vote';
    if (s.phase === 'vote') return 'Reveal now';
    if (s.phase === 'reveal') return s.round >= s.rounds ? 'Final scores' : 'Next round';
  }
  return 'Next';
}

function controls(s) {
  const fs = h('span', { class: 'ctrl-group' },
    h('button', {
      class: 'btn ghost icon', title: sfx.enabled ? 'Mute sound effects' : 'Turn sound effects on', 'aria-pressed': sfx.enabled ? 'true' : 'false',
      onclick: () => { sfx.setEnabled(!sfx.enabled); render(); },
    }, sfx.enabled ? '\u{1F50A}' : '\u{1F507}'),
    document.fullscreenEnabled ? h('button', { class: 'btn ghost', onclick: toggleFullscreen, title: 'Fullscreen (F)' }, 'Fullscreen') : null);
  if (s.phase === 'lobby') {
    const enough = s.players.length >= s.minPlayers;
    return [
      h('span', { class: 'hint' }, enough ? 'Everyone in? Let’s honk.' : `Need ${s.minPlayers - s.players.length} more player${s.minPlayers - s.players.length === 1 ? '' : 's'} (min ${s.minPlayers})`),
      fs,
      h('button', { class: 'btn primary big', 'data-primary': '', disabled: !enough, onclick: () => act('start') }, `Start ${s.modeInfo.name}`),
    ];
  }
  if (s.phase === 'gameover') {
    return [
      fs,
      h('button', { class: 'btn ghost', onclick: () => act('lobby') }, 'Back to lobby'),
      h('button', { class: 'btn primary big', 'data-primary': '', onclick: () => act('start') }, 'Play again'),
    ];
  }
  return [
    s.timer ? h('div', { class: 'timer-box' },
      timerBadge(s.timer, 'big'),
      h('button', { class: 'btn small ghost', onclick: () => act('extend'), title: 'Add 30 seconds' }, '+30s')) : null,
    h('button', { class: 'btn ghost', onclick: () => { if (confirm('End this game and return to the lobby?')) act('lobby'); } }, 'End game'),
    fs,
    h('button', { class: 'btn primary big', 'data-primary': '', onclick: () => act('next') }, `${nextLabel(s)} ▸`),
  ];
}

// ---------- music ----------

function renderMusic(np) {
  const box = $('music');
  const key = np ? `${np.entryId}:${np.song.kind}:${np.song.id || np.song.text}` : null;
  if (key === musicKey) {
    // Same song: only refresh the caption (titles arrive a moment after submission).
    const cap = box.querySelector('.np-title');
    if (cap && np) cap.textContent = np.song.display;
    return;
  }
  musicKey = key;
  if (!np) { box.replaceChildren(); box.classList.remove('on'); return; }
  box.classList.add('on');
  const song = np.song;
  let player;
  let links;
  if (song.kind === 'youtube') {
    const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(song.id)}?autoplay=1&rel=0&start=${Number(song.start) || 0}`;
    player = h('iframe', { class: 'yt', src, title: 'YouTube player', allow: 'autoplay; encrypted-media; picture-in-picture', allowfullscreen: true });
    links = [h('a', { href: song.url, target: '_blank', rel: 'noopener' }, 'Won’t play? Open on YouTube ↗')];
  } else if (song.kind === 'spotify') {
    const src = `https://open.spotify.com/embed/${encodeURIComponent(song.type)}/${encodeURIComponent(song.id)}?utm_source=generator`;
    player = h('iframe', { class: 'sp', src, title: 'Spotify player', allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture', loading: 'lazy' });
    links = [h('a', { href: song.url, target: '_blank', rel: 'noopener' }, 'Open in Spotify ↗')];
  } else {
    const u = searchUrls(song.text);
    player = h('div', { class: 'text-song' }, h('div', { class: 'np-note' }, '♫'), h('div', null, 'Typed in by hand. Find it and press play:'));
    links = [
      h('a', { href: u.youtubeWeb, target: '_blank', rel: 'noopener' }, 'Search YouTube ↗'),
      h('a', { href: u.spotify, target: '_blank', rel: 'noopener' }, 'Search Spotify ↗'),
    ];
  }
  box.replaceChildren(
    h('div', { class: 'np-head' }, h('span', { class: 'np-badge' }, `Now playing · #${np.number}`)),
    h('div', { class: 'np-title' }, song.display),
    player,
    h('div', { class: 'np-links' }, links),
  );
}

boot().catch((err) => { console.error(err); toast('Could not reach the game server'); });
