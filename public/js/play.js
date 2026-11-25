// Phone controller: join a room, pick songs, guess, judge and vote.

import {
  h, api, openStream, toast, store, playerById, chip, searchUrls, gooseIcon, modeIcon,
  mountInto, clearKept, syncClock, timerBadge, copyText, songHref, setlistText, youtubePlaylistUrl, REACTIONS,
  gooseAvatar, HAT_LABELS, ACCESSORY_LABELS, FEATHER_LABELS, FEATHER_SWATCH, DARK_FEATHERS, FACE_LABELS, shareLink, shareToast,
  RATINGS,
} from './common.js';
import { updateListening, isDeviceMuted } from './listen.js';
import { sfx } from './sfx.js';

const SESSION_KEY = 'goose.player';
const NAME_KEY = 'goose.name';
const app = document.getElementById('app');
const statusEl = document.getElementById('status');

let session = store.get(SESSION_KEY);
let state = null;
let es = null;
let wakeLock = null;
let prevPhaseKey = null;

// ---------- boot / join ----------

function boot() {
  const params = new URLSearchParams(location.search);
  const urlCode = (params.get('code') || '').toUpperCase();
  if (session && (!urlCode || urlCode === session.code)) connect();
  else showJoin(null, urlCode);
}

function showJoin(error, prefillCode) {
  state = null;
  es?.close();
  statusEl.hidden = true;
  document.body.classList.remove('has-reactions');
  updateListening(null);
  const codeIn = h('input', {
    id: 'code', name: 'code', required: true, maxlength: 4, autocomplete: 'off', autocapitalize: 'characters',
    spellcheck: 'false', placeholder: 'ABCD', class: 'code-input', value: prefillCode || session?.code || '',
  });
  const nameIn = h('input', { id: 'name', name: 'name', required: true, maxlength: 16, autocomplete: 'nickname', placeholder: 'Your name', value: store.get(NAME_KEY) || '' });
  const btn = h('button', { class: 'btn primary big', type: 'submit' }, 'Join the flock');
  codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  const form = h('form', {
    class: 'join-form',
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const res = await api('/api/join', { code: codeIn.value, name: nameIn.value });
        session = { code: res.code, playerId: res.playerId, token: res.token };
        store.set(SESSION_KEY, session);
        store.set(NAME_KEY, res.name);
        if (res.audience) toast('A game is already going. You\u2019re in the audience until the next one!');
        requestWakeLock();
        connect();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    },
  },
  h('label', { for: 'code' }, 'Room code'), codeIn,
  h('label', { for: 'name' }, 'Name'), nameIn,
  btn);

  mount(
    h('header', { class: 'phone-hero' },
      gooseIcon('hero-goose'),
      h('h1', null, 'A Goose ', h('em', null, 'Among'), ' Sirens'),
      h('p', null, 'The party game where your music taste gives you away.')),
    error ? h('p', { class: 'error' }, error) : null,
    h('section', { class: 'card' }, form),
    h('p', { class: 'fine' }, 'Hosting? Open ', h('a', { href: '/host' }, '/host'), ' on the TV or laptop with the speakers.'),
  );
  // Only auto-focus on devices with a real keyboard; on phones it would pop the keyboard over the hero.
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) (codeIn.value ? nameIn : codeIn).focus();
}

function connect() {
  es?.close();
  es = openStream({ code: session.code, role: 'player', id: session.playerId, token: session.token }, {
    onState: (s) => { state = s; syncClock(s); render(); },
    onStatus: (ok) => { statusEl.hidden = ok; },
    events: { react: remoteReaction },
    onFatal: (msg, data) => {
      const code = session?.code;
      session = null;
      store.set(SESSION_KEY, null);
      if (data?.left && msg === 'You left the room') { showJoin(null, code); toast('You left the room. Honk honk!'); }
      else showJoin(msg, code);
    },
  });
}

async function act(type, extra = {}) {
  return api('/api/action', { code: session.code, playerId: session.playerId, token: session.token, type, ...extra });
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported / denied */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && session) requestWakeLock(); });

// ---------- mounting (keeps typed text across live updates) ----------

function mount(...nodes) { mountInto(app, nodes); }

// ---------- render ----------

function render() {
  const s = state;
  if (!s || !s.me) return;
  haptics(s);
  mount(meBar(s), s.isAudience ? audienceView(s) : view(s), s.canReact ? reactionBar() : null);
  refreshPreviews();
  document.body.classList.toggle('has-reactions', Boolean(s.canReact));
  updateListening(s);
}

// Big thumb-friendly reaction buttons; they float up on the TV.
function reactionBar() {
  return h('nav', { class: 'reactions', 'aria-label': 'Reactions' }, REACTIONS.map((r) => h('button', {
    class: `react${r.kind === 'honk' ? ' honk' : ''}`,
    'aria-label': r.label,
    onclick: (e) => {
      const b = e.currentTarget;
      b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
      // Honk right away, inside the tap (phones only allow sound from a tap); the server echo is skipped.
      if (r.kind === 'honk' && state?.settings?.venue === 'remote' && !isDeviceMuted()) {
        const ctx = sfx.ensure();
        if (ctx && ctx.state !== 'running') ctx.resume().then(() => sfx.honk(), () => {}); else sfx.honk();
      }
      act('react', { kind: r.kind }).catch(() => {});
    },
  }, r.glyph)));
}

// Remote games have no shared TV: show everyone's reactions floating up here, and honk out loud.
function remoteReaction(r) {
  if (state?.settings?.venue !== 'remote') return;
  const def = REACTIONS.find((x) => x.kind === r.kind);
  if (!def) return;
  if (r.kind === 'honk' && r.from !== state.me?.id && !isDeviceMuted()) sfx.honk();
  if (document.querySelectorAll('.react-float').length > 24) return;
  const el = h('div', {
    class: `react-float${r.kind === 'honk' ? ' honk' : ''}`,
    'aria-hidden': 'true',
    style: { left: `${8 + Math.random() * 78}%`, '--c': r.color || 'var(--accent)' },
  }, h('span', { class: 'rf-glyph' }, def.glyph), r.name ? h('span', { class: 'rf-name' }, r.name) : null);
  el.addEventListener('animationend', () => el.remove());
  document.body.append(el);
}

// A buzz when something happens that you might be looking away for.
function haptics(s) {
  const key = `${s.phase}:${s.round ?? ''}:${s.current?.number ?? ''}`;
  if (prevPhaseKey && key !== prevPhaseKey && navigator.vibrate) {
    try {
      if (s.phase === 'reveal' || s.phase === 'gameover') navigator.vibrate([40, 60, 40]);
      else if (['submit', 'judge', 'vote', 'write', 'rate'].includes(s.phase)) navigator.vibrate(60);
    } catch { /* ignore */ }
  }
  prevPhaseKey = key;
}

function meBar(s) {
  const between = s.phase === 'lobby' || s.phase === 'gameover';
  return h('header', { class: 'me-bar', style: { '--c': s.me.color } },
    gooseAvatar(s.me, 'head me-avatar'),
    h('span', { class: 'me-name' }, s.me.name),
    timerBadge(s.timer),
    s.isAudience ? h('span', { class: 'me-room' }, 'Audience')
      : s.phase === 'lobby' ? h('span', { class: 'me-room' }, `Room ${s.code}`) : h('span', { class: 'me-score' }, `${s.me.score} pt${s.me.score === 1 ? '' : 's'}`),
    between ? h('button', {
      class: 'btn small ghost', 'aria-label': 'Leave room',
      onclick: async () => {
        if (!confirm('Leave this room?')) return;
        try { await act('leave'); } catch (err) { toast(err.message); }
      },
    }, 'Leave') : null,
  );
}

function inviteCard(s) {
  const url = `${location.origin}/?code=${s.code}`;
  return card(
    h('h2', null, 'Invite friends'),
    h('p', { class: 'fine left' }, 'Send them the link. It drops them straight into this room.'),
    h('div', { class: 'invite-row' },
      h('code', { class: 'invite-url' }, url.replace(/^https?:\/\//, '')),
      h('button', { class: 'btn primary', onclick: async () => shareToast(await shareLink(url), url) }, navigator.share ? 'Share' : 'Copy link')));
}

let lookTab = 'hat';
const LOOK_TABS = [
  { key: 'hat', label: 'Hat' },
  { key: 'accessory', label: 'Extras' },
  { key: 'feathers', label: 'Feathers' },
  { key: 'face', label: 'Face' },
];

function hatPicker(s) {
  const me = s.me;
  const setLook = async (look) => { try { await act('setLook', { look }); } catch (err) { toast(err.message); } };
  // One grid of goose headshots per tab; each option previews on your own goose.
  const grid = (label, options, current, labels, preview, choose) => h('div', { class: 'hat-grid', role: 'radiogroup', 'aria-label': label },
    options.map((opt) => h('button', {
      class: `hat${opt === current ? ' selected' : ''}`,
      role: 'radio',
      'aria-checked': opt === current ? 'true' : 'false',
      'aria-label': labels[opt] || opt,
      title: labels[opt] || opt,
      onclick: () => { if (opt !== current) choose(opt); },
    }, gooseAvatar({ ...me, ...preview(opt) }, 'head'))));

  let body;
  if (lookTab === 'accessory') {
    body = grid('Accessory', s.accessories || [], me.accessory, ACCESSORY_LABELS, (a) => ({ accessory: a }), (accessory) => setLook({ accessory }));
  } else if (lookTab === 'feathers') {
    body = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Feathers' }, (s.feathers || []).map((f) => h('button', {
      class: `swatch feather${DARK_FEATHERS.has(f) ? ' dark' : ''}${f === me.feathers ? ' selected' : ''}`,
      style: { '--c': FEATHER_SWATCH[f] || '#fff' },
      role: 'radio',
      'aria-checked': f === me.feathers ? 'true' : 'false',
      'aria-label': FEATHER_LABELS[f] || f,
      title: FEATHER_LABELS[f] || f,
      onclick: () => { if (f !== me.feathers) setLook({ feathers: f }); },
    })));
  } else if (lookTab === 'face') {
    // Glasses would hide the eyes, so the previews leave them off.
    const eyewear = ['shades', 'heartshades', 'monocle'].includes(me.accessory);
    body = grid('Expression', s.faces || [], me.face, FACE_LABELS, (face) => ({ face, accessory: eyewear ? 'none' : me.accessory }), (face) => setLook({ face }));
  } else {
    body = grid('Hat', s.hats, me.hat, HAT_LABELS, (hat) => ({ hat }), async (hat) => { try { await act('setHat', { hat }); } catch (err) { toast(err.message); } });
  }

  return card(
    h('h2', null, 'Your goose'),
    h('div', { class: 'look-preview' }, gooseAvatar(me, 'look-big')),
    nameEditor(s),
    s.isAudience ? null : colorPicker(s),
    h('div', { class: 'segmented look-tabs', role: 'tablist', 'aria-label': 'Customize' }, LOOK_TABS.map((t) => h('button', {
      class: t.key === lookTab ? 'on' : '',
      role: 'tab',
      'aria-selected': t.key === lookTab ? 'true' : 'false',
      onclick: () => { lookTab = t.key; render(); },
    }, t.label))),
    body,
  );
}

function nameEditor(s) {
  const key = 'rename';
  return h('form', {
    class: 'input-row rename-row',
    onsubmit: async (e) => {
      e.preventDefault();
      const input = e.currentTarget.querySelector('input');
      const name = input.value.trim();
      if (!name || name === s.me.name) return;
      try {
        const res = await act('rename', { name });
        store.set(NAME_KEY, res.name);
        clearKept(app, key);
        input.blur();
        toast(`You're now ${res.name}`);
      } catch (err) { toast(err.message); }
    },
  },
  h('input', { type: 'text', 'data-keep': key, maxlength: 16, placeholder: s.me.name, 'aria-label': 'New name', autocomplete: 'nickname', enterkeyhint: 'done' }),
  h('button', { class: 'btn primary', type: 'submit' }, 'Rename'));
}

function colorPicker(s) {
  const owners = new Map(s.players.filter((p) => p.id !== s.me.id).map((p) => [p.color, p.name]));
  return h('div', null,
    h('div', { class: 'kicker' }, 'Color'),
    h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Goose color' }, s.colors.map((c) => {
      const owner = owners.get(c);
      const mine = c === s.me.color;
      return h('button', {
        class: `swatch${mine ? ' selected' : ''}`,
        style: { '--c': c },
        role: 'radio',
        'aria-checked': mine ? 'true' : 'false',
        'aria-label': owner ? `Color taken by ${owner}` : mine ? 'Your color' : 'Pick this color',
        title: owner ? `Taken by ${owner}` : '',
        disabled: Boolean(owner),
        onclick: async () => { if (mine) return; try { await act('setColor', { color: c }); } catch (err) { toast(err.message); } },
      }, owner ? h('span', { class: 'swatch-taken' }, owner.slice(0, 1).toUpperCase()) : null);
    })));
}

function card(...kids) { return h('section', { class: 'card' }, ...kids); }
function waiting(title, sub) {
  return card(h('div', { class: 'waiting' }, gooseIcon('bob'), h('h2', null, title), sub ? h('p', null, sub) : null));
}

// Late joiners: watch along (same info as the TV), react, and get seated next game.
function audienceView(s) {
  const lines = [];
  const name = (id) => playerById(s, id)?.name || 'someone';
  if (s.phase === 'lobby') lines.push(h('p', null, 'The flock is full, so you\u2019re watching this one. You\u2019ll get a seat as soon as one opens up.'));
  else if (s.mode === 'loose' && s.current) {
    lines.push(h('div', { class: 'kicker' }, `Song ${s.current.number} of ${s.total}`), h('p', { class: 'prompt' }, s.current.prompt));
    if (s.result) lines.push(h('h2', null, 'It was ', chip(playerById(s, s.result.ownerId)), '!'));
  } else if (s.mode === 'king' && s.prompt) {
    lines.push(h('div', { class: 'kicker' }, `\u{1F451} King ${name(s.kingId)}`), h('p', { class: 'prompt' }, s.prompt));
    if (s.phase === 'reveal') lines.push(h('h2', null, s.winnerId ? ['The crown goes to ', chip(playerById(s, s.winnerId))] : 'No winner this round'));
  } else if (s.mode === 'secret') {
    lines.push(h('div', { class: 'kicker' }, `Round ${s.round} of ${s.rounds}`));
    if (s.prompt) lines.push(h('div', { class: 'feeling small' }, s.prompt));
    if (s.gooseId) lines.push(h('h2', null, 'The Goose was ', chip(playerById(s, s.gooseId))));
    if (!s.prompt) lines.push(h('p', null, 'Everyone has a secret feeling\u2026 except one goose. Watch closely!'));
  } else if (s.mode === 'fight' && s.prompt) {
    lines.push(h('div', { class: 'kicker' }, `\u{1F94A} Round ${s.round} of ${s.rounds}${s.stage ? ` \u00B7 ${s.stage.label}` : ''}`), h('p', { class: 'prompt' }, s.prompt));
    if (s.result?.winnerSide) lines.push(h('h2', null, chip(playerById(s, s.result.winnerSide.ownerId)), s.result.champion ? ' is the champion!' : ' wins the fight!'));
  } else if (s.mode === 'fake' && s.current) {
    lines.push(h('div', { class: 'kicker' }, `Song ${s.current.number} of ${s.total}`), h('p', { class: 'prompt' }, s.realPrompt || 'What was the prompt? Watch the fakes roll in\u2026'));
  } else if (s.mode === 'mind' && s.prompt) {
    lines.push(h('div', { class: 'kicker' }, `\u{1F9E0} Round ${s.round} of ${s.rounds}`), h('p', { class: 'prompt' }, s.prompt));
  } else if (s.mode === 'chain' && s.pickerId) {
    lines.push(h('div', { class: 'kicker' }, `\u{1F517} Chain of ${s.chainLength} \u00B7 ${name(s.pickerId)}\u2019s turn`));
    if (s.current) lines.push(h('p', { class: 'prompt' }, s.current.display));
  } else if (s.mode === 'hot' && s.prompt) {
    lines.push(h('div', { class: 'kicker' }, `\u{1F336}\uFE0F DJ ${name(s.pickerId)}`), h('p', { class: 'prompt' }, s.prompt));
  }
  if (!lines.length) lines.push(h('p', null, 'Watch the big screen!'));
  if (s.phase === 'gameover') {
    return [
      card(h('div', { class: 'waiting' }, gooseAvatar(s.me, 'bob'), h('h2', null, 'That\u2019s a wrap!'), h('p', null, 'You\u2019ve got a seat in the next game.'))),
      setlist(s),
    ];
  }
  return [
    card(h('div', { class: 'waiting' }, gooseAvatar(s.me, 'bob'), h('h2', null, 'You\u2019re in the audience'), h('p', null, 'React to the songs below. You\u2019ll join the flock next game.'))),
    card(...lines),
    s.phase === 'lobby' ? hatPicker(s) : null,
  ];
}

function view(s) {
  if (s.phase === 'lobby') {
    return [
      card(h('div', { class: 'waiting' }, gooseAvatar(s.me, 'bob'), h('h2', null, 'You\u2019re in!'), h('p', null, 'Waiting for the host to start the game.'))),
      card(h('div', { class: 'kicker' }, 'Up next'), h('h2', { class: 'with-icon' }, modeIcon(s.mode), s.modeInfo.name), h('p', null, s.modeInfo.rules)),
      hatPicker(s),
      inviteCard(s),
      suggestCard(s),
    ];
  }
  if (s.phase === 'gameover') return gameover(s);
  if (s.mode === 'loose') return loose(s);
  if (s.mode === 'king') return king(s);
  if (s.mode === 'fight') return fight(s);
  if (s.mode === 'fake') return fake(s);
  if (s.mode === 'mind') return mind(s);
  if (s.mode === 'chain') return chain(s);
  if (s.mode === 'hot') return hot(s);
  return secret(s);
}

const SUGGEST = {
  loose: { what: 'prompt', placeholder: 'What song would you play at a goose wedding?' },
  king: { what: 'scenario', placeholder: 'King Goose gets stuck in a revolving door.' },
  secret: { what: 'feeling', placeholder: 'Hangry' },
  mind: { what: 'prompt', placeholder: 'A song everyone knows from a car commercial' },
  hot: { what: 'prompt', placeholder: 'A song you\u2019d play at your own roast' },
};

function suggestCard(s) {
  const kind = s.modeInfo.prompts;
  if (!kind) return null; // Goose Chain has no prompts
  const sg = SUGGEST[kind];
  const key = `suggest-${kind}`;
  const mine = s.mySuggestions.filter((m) => m.mode === kind);
  return card(
    h('h2', null, `Bored? Suggest a ${sg.what}`),
    h('p', { class: 'fine left' }, 'Your suggestions get mixed into the game (anonymously).'),
    h('form', {
      class: 'input-row',
      onsubmit: async (e) => {
        e.preventDefault();
        const text = e.currentTarget.querySelector('input').value.trim();
        if (!text) return;
        try { await act('suggest', { text }); clearKept(app, key); toast('Added!'); } catch (err) { toast(err.message); }
      },
    },
    h('input', { type: 'text', 'data-keep': key, placeholder: sg.placeholder, maxlength: kind === 'secret' ? 30 : 220, 'aria-label': `Suggest a ${sg.what}` }),
    h('button', { class: 'btn primary', type: 'submit' }, 'Add')),
    mine.length ? h('ul', { class: 'phone-tracks' }, mine.map((m) => h('li', null, h('span', { class: 'check' }, '\u2713'), m.text))) : null,
  );
}

// ----- song picker -----

function songForm({ key, slot, current, cta = 'Lock it in' }) {
  const input = h('input', {
    type: 'text', 'data-keep': key, 'aria-label': 'Song link or name',
    placeholder: 'Link or “Song – Artist”',
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'send',
  });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, current ? 'Change pick' : cta);
  input.addEventListener('input', () => schedulePreview(key));
  input.addEventListener('paste', () => setTimeout(() => schedulePreview(key, 0), 0));
  const openSearch = (which) => {
    const q = (app.querySelector(`[data-keep="${CSS.escape(key)}"]`)?.value || '').trim();
    if (/^https?:|spotify:/i.test(q)) return toast('Type a song name to search for');
    window.open(searchUrls(q)[which], '_blank', 'noopener');
  };
  return h('form', {
    class: 'song-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const live = e.currentTarget.querySelector('input');
      const val = live.value.trim();
      if (!val) return toast('Paste a link or type a song name');
      btn.disabled = true;
      try {
        await act('submit', { slot, song: val });
        const now = app.querySelector(`[data-keep="${CSS.escape(key)}"]`);
        if (now) now.value = '';
        if (navigator.vibrate) navigator.vibrate(30);
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
      }
    },
  },
  current ? h('div', { class: 'picked' }, h('span', { class: 'check' }, '✓'), h('span', null, current.display)) : null,
  h('div', { class: 'input-row' }, input, btn),
  h('div', { class: 'preview', 'data-preview-for': key, 'aria-live': 'polite' }),
  h('div', { class: 'search-row' },
    h('span', null, 'Need the link?'),
    h('button', { type: 'button', class: 'linkish', onclick: () => openSearch('youtube') }, 'YouTube Music ↗'),
    h('button', { type: 'button', class: 'linkish', onclick: () => openSearch('spotify') }, 'Spotify ↗')),
  );
}

// ----- link preview: "is this the right song?" before you lock it in -----

const previewCache = new Map();
const previewTimers = {};

function schedulePreview(key, delay = 500) {
  clearTimeout(previewTimers[key]);
  previewTimers[key] = setTimeout(() => resolvePreview(key), delay);
}

async function resolvePreview(key) {
  const input = app.querySelector(`[data-keep="${CSS.escape(key)}"]`);
  const value = (input?.value || '').trim();
  if (!value || !/[./:]/.test(value) || previewCache.has(value)) { refreshPreviews(); return; }
  previewCache.set(value, { pending: true });
  refreshPreviews();
  try {
    previewCache.set(value, await api('/api/resolve', { song: value }));
  } catch {
    previewCache.delete(value);
  }
  refreshPreviews();
}

function refreshPreviews() {
  for (const box of app.querySelectorAll('[data-preview-for]')) {
    const input = app.querySelector(`[data-keep="${CSS.escape(box.dataset.previewFor)}"]`);
    const r = previewCache.get((input?.value || '').trim());
    box.className = 'preview';
    if (!r || r.kind === 'text') { box.replaceChildren(); continue; }
    if (r.pending) { box.replaceChildren('Looking it up\u2026'); continue; }
    if (!r.ok) { box.classList.add('bad'); box.replaceChildren('\u26A0\uFE0F ', r.error); continue; }
    box.classList.add('good');
    box.replaceChildren('\u{1F3B5} ', r.display ? h('strong', null, r.display) : `${r.kind === 'youtube' ? 'YouTube' : 'Spotify'} link looks good`);
  }
}

function playerButtons(s, { exclude, selected, onPick }) {
  return h('div', { class: 'pick-grid' }, s.players.filter((p) => p.id !== exclude).map((p) => h('button', {
    class: `pick${p.id === selected ? ' selected' : ''}`,
    style: { '--c': p.color },
    'aria-pressed': p.id === selected ? 'true' : 'false',
    onclick: async () => {
      try { await onPick(p.id); if (navigator.vibrate) navigator.vibrate(20); } catch (err) { toast(err.message); }
    },
  }, p.name)));
}

// ----- A Goose is Loose! -----

function loose(s) {
  if (s.phase === 'submit') {
    const done = s.prompts.every((p) => p.song);
    return [
      done ? waiting('All your songs are in!', 'You can still change them until everyone finishes.') : null,
      ...s.prompts.map((p, i) => card(
        h('div', { class: 'prompt-head' },
          h('div', { class: 'kicker' }, `Prompt ${i + 1} of ${s.prompts.length}`),
          !p.song && s.swapsLeft > 0 ? h('button', {
            type: 'button', class: 'linkish swap-btn',
            title: 'Trade this prompt for a different one',
            onclick: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              try {
                const r = await act('swapPrompt', { slot: i });
                toast(r.swapsLeft ? `New prompt! ${r.swapsLeft} swap${r.swapsLeft === 1 ? '' : 's'} left` : 'New prompt! That was your last swap');
              } catch (err) {
                toast(err.message);
                btn.disabled = false;
              }
            },
          }, `\u{1F504} Swap (${s.swapsLeft} left)`) : null),
        h('p', { class: 'prompt' }, p.text),
        songForm({ key: `loose-${i}-${p.text}`, slot: i, current: p.song }),
      )),
    ];
  }
  const c = s.current;
  if (s.phase === 'listen') {
    if (s.isMine) {
      return [card(h('div', { class: 'kicker' }, `Song ${c.number} of ${s.total}`), h('p', { class: 'prompt' }, c.prompt)),
        waiting('This one’s yours!', 'Keep a straight face…')];
    }
    return [
      card(h('div', { class: 'kicker' }, `Song ${c.number} of ${s.total}`), h('p', { class: 'prompt' }, c.prompt)),
      card(h('h2', null, 'Whose song is this?'),
        playerButtons(s, { exclude: s.me.id, selected: s.myGuess, onPick: (id) => act('guess', { target: id }) }),
        s.myGuess ? h('p', { class: 'fine' }, 'Locked in. You can change it until the reveal.') : null),
    ];
  }
  // reveal
  const owner = playerById(s, s.result.ownerId);
  if (s.isMine) return waiting('Your turn to explain!', `Tell everyone why you picked “${c.display}”.`);
  const right = s.result.guesses[s.me.id] === s.result.ownerId;
  const guessed = s.result.guesses[s.me.id];
  return card(h('div', { class: 'result' },
    h('div', { class: 'big-emoji' }, right ? '\u{1F389}' : guessed ? '\u{1F635}' : '\u{1F937}'),
    h('h2', null, 'It was ', chip(owner), '!'),
    h('p', null, right ? '+1, nice ears!' : guessed ? 'Not this time.' : 'You didn’t guess.')));
}

// ----- King Goose -----

function king(s) {
  const kingP = playerById(s, s.kingId);
  const scenario = card(h('div', { class: 'kicker' }, `Round ${s.round} of ${s.rounds} · \u{1F451} ${kingP?.name}`), h('p', { class: 'prompt' }, s.prompt));
  if (s.phase === 'submit') {
    if (s.isKing) return [waiting('You are King Goose!', 'Read your scenario out loud. Your subjects are choosing its soundtrack.'), scenario];
    return [scenario, card(h('h2', null, 'Choose the soundtrack'), songForm({ key: `king-${s.round}`, current: s.mySong, cta: 'Offer to the King' }))];
  }
  if (s.phase === 'listen') {
    return [scenario, waiting(`Soundtrack ${s.track.number} of ${s.track.total}`, s.isKing ? 'Listen closely, Your Majesty.' : 'Shh. The King is listening.')];
  }
  if (s.phase === 'judge') {
    if (!s.isKing) return [scenario, waiting('The King is deliberating…', 'Bow respectfully.')];
    return [scenario, card(h('h2', null, 'Crown the best soundtrack'),
      h('div', { class: 'pick-list' }, s.tracks.map((t) => h('button', {
        class: 'pick wide',
        onclick: async () => {
          if (!confirm(`Crown track #${t.number}?`)) return;
          try { await act('judge', { entryId: t.id }); } catch (err) { toast(err.message); }
        },
      }, h('span', { class: 'track-num' }, `#${t.number}`), ' ', t.display))))];
  }
  // reveal
  const winner = playerById(s, s.winnerId);
  const mine = s.winnerId === s.me.id;
  return [scenario, card(h('div', { class: 'result' },
    h('div', { class: 'big-emoji' }, mine ? '\u{1F451}' : '\u{1F3B5}'),
    winner ? h('h2', null, chip(winner), mine ? ' (you!) won +1' : ' won the crown') : h('h2', null, 'No winner this round'),
  ))];
}

// ----- Secret Goose -----

function secret(s) {
  const head = h('div', { class: 'kicker' }, `Round ${s.round} of ${s.rounds}`);
  if (s.phase === 'submit') {
    if (s.isGoose) {
      return [card(head, h('div', { class: 'role goose' }, '\u{1F92B} You are the Secret Goose'),
        h('p', null, 'Everyone else got a secret one-word feeling. You didn’t. Pick any song, then bluff like your life depends on it.')),
      card(songForm({ key: `secret-${s.round}`, current: s.mySong, cta: 'Pick blind' }))];
    }
    return [card(head, h('div', { class: 'kicker' }, 'Your secret feeling'), h('div', { class: 'feeling small' }, s.prompt),
      h('p', { class: 'fine' }, 'Don’t say it out loud. One player doesn’t know it!')),
    card(h('h2', null, 'Pick a song that feels like this'), songForm({ key: `secret-${s.round}`, current: s.mySong }))];
  }
  if (s.phase === 'listen') {
    return [card(head, s.isGoose ? h('div', { class: 'role goose' }, '\u{1F92B} You’re the Goose. Listen for clues!') : h('div', null, 'Feeling: ', h('strong', null, s.prompt))),
      waiting(`Track ${s.track.number} of ${s.track.total}`, 'Which song doesn’t belong?')];
  }
  if (s.phase === 'defend') {
    return [card(head, h('div', { class: 'kicker' }, 'The feeling was'), h('div', { class: 'feeling small' }, s.prompt)),
      waiting('Make your case!', s.isGoose ? 'Now you know the feeling. Bluff! Explain how your song totally fits.' : 'Explain why your song fits. Who sounds like they’re making it up?'),
      whoPicked(s)];
  }
  if (s.phase === 'vote') {
    return [card(head, h('h2', null, 'Who is the Secret Goose?'),
      s.isGoose ? h('p', { class: 'fine' }, 'Vote for someone else to blend in.') : null,
      playerButtons(s, { exclude: s.me.id, selected: s.myVote, onPick: (id) => act('vote', { target: id }) })),
      whoPicked(s)];
  }
  // reveal
  const goose = playerById(s, s.gooseId);
  let msg;
  if (s.isGoose) msg = s.result.caught ? 'They caught you!' : 'You escaped! +2';
  else msg = s.result.catchers.includes(s.me.id) ? 'You sniffed them out! +1' : 'They fooled you.';
  return card(head, h('div', { class: 'result' },
    s.result.caught ? gooseIcon('big-emoji') : h('div', { class: 'big-emoji' }, '\u{1F92B}'),
    h('h2', null, 'The Goose was ', chip(goose)),
    h('p', null, msg)));
}

function whoPicked(s) {
  return card(h('div', { class: 'kicker' }, 'Who picked what'),
    h('ul', { class: 'phone-tracks' }, s.tracks.map((t) => h('li', null, chip(playerById(s, t.ownerId)), h('span', null, t.display)))));
}

// ----- shared bits for the newer modes -----

async function tap(type, extra) {
  try { await act(type, extra); if (navigator.vibrate) navigator.vibrate(20); } catch (err) { toast(err.message); }
}

function choiceButtons(items, selected, onPick) {
  return h('div', { class: 'pick-list' }, items.map((it) => h('button', {
    class: `pick wide${it.id === selected ? ' selected' : ''}`,
    style: it.color ? { '--c': it.color } : null,
    disabled: Boolean(it.disabled),
    'aria-pressed': it.id === selected ? 'true' : 'false',
    onclick: () => onPick(it.id),
  }, it.label)));
}

// ----- Goose Fight -----

function fight(s) {
  const head = card(h('div', { class: 'kicker' }, `\u{1F94A} Round ${s.round} of ${s.rounds}${s.stage ? ` \u00B7 ${s.stage.label}` : ''}`), h('p', { class: 'prompt' }, s.prompt));
  if (s.phase === 'submit') {
    return [head, card(h('h2', null, 'Pick your fighter'),
      h('p', { class: 'fine left' }, 'Everyone answers this same prompt. Your song battles the others, two at a time.'),
      songForm({ key: `fight-${s.round}`, current: s.mySong, cta: 'Enter the ring' }))];
  }
  const r = s.result;
  if (s.phase === 'reveal' && r.walkover) return [head, waiting('Walkover!', 'Only one song entered the ring.')];
  const m = s.match;
  if (s.phase === 'listen') {
    return [head, waiting(`Fight ${m.number}`, m.playing === 0 ? `\u{1F534} ${m.a.display}` : `\u{1F535} ${m.b.display}`)];
  }
  if (s.phase === 'vote') {
    if (s.myEntry) return [head, waiting('Your song is in this fight!', 'Sit tight while the flock decides.')];
    return [head, card(h('h2', null, 'Who wins?'),
      choiceButtons([
        { id: m.a.id, label: `\u{1F534} ${m.a.display}`, color: '#ff6b6b' },
        { id: m.b.id, label: `\u{1F535} ${m.b.display}`, color: '#4cc9f0' },
      ], s.myVote, (id) => tap('vote', { target: id })),
      s.myVote ? h('p', { class: 'fine' }, 'Locked in. You can change it until the reveal.') : null)];
  }
  const winner = playerById(s, r.winnerSide.ownerId);
  const mine = r.winnerSide.ownerId === s.me.id;
  const ko = r.loserSide && r.loserSide.ownerId === s.me.id;
  return [head, card(h('div', { class: 'result' },
    h('div', { class: 'big-emoji' }, r.champion ? '\u{1F3C6}' : mine ? '\u{1F94A}' : ko ? '\u{1F635}' : '\u{1F3B5}'),
    h('h2', null, chip(winner), r.champion ? ' is the champion!' : ' wins the fight!'),
    h('p', null, mine ? (r.champion ? '+3 for you!' : '+1 for you!') : ko ? 'Knocked out.' : `\u201C${r.winnerSide.display}\u201D`)))];
}

// ----- Fake Prompt -----

function fake(s) {
  if (s.phase === 'submit') {
    const done = s.prompts.every((p) => p.song);
    return [
      done ? waiting('All your songs are in!', 'You can still change them until everyone finishes.') : null,
      ...s.prompts.map((p, i) => card(
        h('div', { class: 'kicker' }, `Prompt ${i + 1} of ${s.prompts.length}`),
        h('p', { class: 'prompt' }, p.text),
        h('p', { class: 'fine left' }, 'Everyone else will try to fake this prompt. Keep it secret!'),
        songForm({ key: `fake-${i}-${p.text}`, slot: i, current: p.song }))),
    ];
  }
  const c = s.current;
  const head = card(h('div', { class: 'kicker' }, `\u{1F3AD} Song ${c.number} of ${s.total}`), h('p', { class: 'song-now' }, '\u{1F3B5} ', c.display));
  if (s.phase === 'write') {
    if (s.isMine) {
      return [head, card(h('div', { class: 'kicker' }, 'Your real prompt'), h('p', { class: 'prompt' }, s.realPrompt)),
        waiting('This one\u2019s yours!', 'Everyone is writing fake prompts for your song. Keep a straight face\u2026')];
    }
    const key = `fake-write-${c.number}`;
    return [head, card(
      h('h2', null, 'Write a fake prompt'),
      h('p', { class: 'fine left' }, 'What prompt could this song have been answering? Fool the others!'),
      s.myFake ? h('div', { class: 'picked' }, h('span', { class: 'check' }, '\u2713'), h('span', null, s.myFake)) : null,
      h('form', {
        class: 'input-row',
        onsubmit: async (e) => {
          e.preventDefault();
          const text = e.currentTarget.querySelector('input').value.trim();
          if (!text) return;
          try { await act('fake', { text }); clearKept(app, key); } catch (err) { toast(err.message); }
        },
      },
      h('input', { type: 'text', 'data-keep': key, maxlength: 120, placeholder: 'What song would you play at\u2026', 'aria-label': 'Your fake prompt', enterkeyhint: 'send' }),
      h('button', { class: 'btn primary', type: 'submit' }, s.myFake ? 'Change' : 'Submit')))];
  }
  if (s.phase === 'vote') {
    if (s.isMine) return [head, waiting('Watch them squirm', 'Everyone is hunting for your real prompt.')];
    return [head, card(h('h2', null, 'Which is the real prompt?'),
      choiceButtons(s.choices.map((ch) => ({ id: ch.id, label: ch.mine ? `${ch.text} (yours)` : ch.text, disabled: ch.mine })),
        s.myVote, (id) => tap('vote', { target: id })),
      s.myVote ? h('p', { class: 'fine' }, 'Locked in. You can change it until the reveal.') : null)];
  }
  const owner = playerById(s, s.ownerId);
  const found = s.result.found.includes(s.me.id);
  const myChoice = s.choices.find((ch) => ch.authors && ch.authors.includes(s.me.id));
  const fooled = myChoice ? Object.values(s.votes).filter((v) => v === myChoice.id).length : 0;
  let msg;
  if (s.isMine) msg = `${s.result.found.length} of them found it.`;
  else msg = `${found ? '+2, you found it!' : 'You got fooled.'}${fooled ? ` +${fooled} for fooling ${fooled === 1 ? 'someone' : `${fooled} geese`}!` : ''}`;
  return [card(h('div', { class: 'kicker' }, 'The real prompt was'), h('p', { class: 'prompt' }, s.realPrompt),
    h('div', { class: 'result' },
      h('div', { class: 'big-emoji' }, found ? '\u{1F3AF}' : fooled ? '\u{1F3AD}' : '\u{1F92D}'),
      h('h2', null, 'Picked by ', chip(owner)),
      h('p', null, msg)))];
}

// ----- Flock Mind -----

function mind(s) {
  const head = card(h('div', { class: 'kicker' }, `\u{1F9E0} Round ${s.round} of ${s.rounds}`), h('p', { class: 'prompt' }, s.prompt));
  if (s.phase === 'submit') {
    return [head, card(h('h2', null, 'What will the flock pick?'),
      h('p', { class: 'fine left' }, 'Score a point for every player who picks the same song or artist as you.'),
      songForm({ key: `mind-${s.round}`, current: s.mySong }))];
  }
  const group = (s.groups || []).find((g) => g.some((p) => p.ownerId === s.me.id));
  const n = group ? group.length - 1 : 0;
  const mates = group ? group.filter((p) => p.ownerId !== s.me.id).map((p) => playerById(s, p.ownerId)?.name).filter(Boolean) : [];
  return [head, card(h('div', { class: 'result' },
    h('div', { class: 'big-emoji' }, n ? '\u{1F9E0}' : '\u{1F9A2}'),
    h('h2', null, group ? (n ? `You matched ${n}! +${n}` : 'Nobody matched you') : 'You sat this one out'),
    mates.length ? h('p', null, `Great minds: ${mates.join(', ')}`) : null))];
}

// ----- Goose Chain -----

function chain(s) {
  const picker = playerById(s, s.pickerId);
  const head = card(h('div', { class: 'kicker' }, `\u{1F517} Turn ${s.round} of ${s.rounds} \u00B7 Chain of ${s.chainLength}`),
    s.prev ? [h('div', { class: 'kicker' }, 'Last link'), h('p', { class: 'prompt' }, s.prev.display)] : h('p', null, 'A brand-new chain starts now.'));
  if (s.phase === 'submit') {
    if (!s.isPicker) return [head, waiting(`${picker?.name || 'Someone'} is picking the next link`, 'How would YOU link it? Get ready to judge.')];
    return [head, card(
      h('div', { class: 'role' }, 'Your turn!'),
      h('h2', null, s.prev ? 'Add a song that links to it' : 'Start the chain with any song'),
      h('p', { class: 'fine left' }, s.prev ? 'A shared word, artist, decade, genre, vibe\u2026 You\u2019ll explain the link out loud.' : 'Pick something with plenty of ways to link to it.'),
      songForm({ key: `chain-${s.round}`, current: s.mySong, cta: 'Add to the chain' }))];
  }
  if (s.phase === 'listen') return [waiting('A new chain begins!', s.current ? s.current.display : '')];
  if (s.phase === 'vote') {
    if (s.isPicker) return [waiting('Explain your link!', `How does \u201C${s.current.display}\u201D link to \u201C${s.prev.display}\u201D?`)];
    return [card(h('div', { class: 'kicker' }, 'From'), h('p', { class: 'prompt' }, s.prev.display),
      h('div', { class: 'kicker' }, `To (${picker?.name || 'their'} pick)`), h('p', { class: 'prompt' }, s.current.display)),
    card(h('h2', null, 'Does the link hold?'),
      h('div', { class: 'pick-grid' }, [['yes', '\u{1F44D} Yes', '#06d6a0'], ['no', '\u{1F44E} No', '#ff6b6b']].map(([v, label, c]) => h('button', {
        class: `pick${s.myVote === v ? ' selected' : ''}`, style: { '--c': c }, 'aria-pressed': s.myVote === v ? 'true' : 'false',
        onclick: () => tap('vote', { target: v }),
      }, label))),
      s.myVote ? h('p', { class: 'fine' }, 'Locked in. You can change it until the reveal.') : null)];
  }
  const r = s.result;
  return [card(h('div', { class: 'result' },
    h('div', { class: 'big-emoji' }, r.held ? '\u{1F517}' : '\u{1F4A5}'),
    h('h2', null, r.held ? 'The chain holds!' : 'Chain broken!'),
    h('p', null, `${r.yes} \u{1F44D} \u00B7 ${r.no} \u{1F44E}`),
    s.isPicker ? h('p', null, r.held ? '+1 for you!' : 'You lose a point.') : null))];
}

// ----- Honk Take -----

function hot(s) {
  const dj = playerById(s, s.pickerId);
  const head = card(h('div', { class: 'kicker' }, `\u{1F336}\uFE0F Round ${s.round} of ${s.rounds} \u00B7 DJ ${dj?.name || ''}`), h('p', { class: 'prompt' }, s.prompt));
  if (s.phase === 'submit') {
    if (!s.isPicker) return [head, waiting(`${dj?.name || 'The DJ'} is picking\u2026`, 'Get ready to guess how much they love it.')];
    return [head, card(h('div', { class: 'role' }, 'You\u2019re the DJ!'),
      h('p', { class: 'fine left' }, 'Pick a song for this prompt. Then you\u2019ll secretly rate it, and everyone tries to guess your rating.'),
      songForm({ key: `hot-${s.round}`, current: s.mySong, cta: 'Drop it' }))];
  }
  if (s.phase === 'rate') {
    return [head, card(
      h('p', { class: 'song-now' }, '\u{1F3B5} ', s.current.display),
      h('h2', null, s.isPicker ? 'Be honest: how much do you love it?' : `How much does ${dj?.name || 'the DJ'} love it?`),
      h('div', { class: 'rating-row' }, RATINGS.map((r) => h('button', {
        class: `rate-btn${s.myRating === r.v ? ' selected' : ''}`,
        'aria-label': `${r.v}: ${r.label}`, 'aria-pressed': s.myRating === r.v ? 'true' : 'false',
        onclick: () => tap('rate', { value: r.v }),
      }, h('span', { class: 'rate-emoji' }, r.emoji), h('span', { class: 'rate-num' }, String(r.v))))),
      s.myRating ? h('p', { class: 'fine' }, `${RATINGS[s.myRating - 1].label}. You can change it until the reveal.`) : null)];
  }
  const r = s.result;
  const truth = r.truth ? RATINGS[r.truth - 1] : null;
  let msg;
  if (s.isPicker) msg = r.exact.length ? `${r.exact.length} exact guess${r.exact.length === 1 ? '' : 'es'}: +${r.exact.length} for you!` : 'Nobody read you exactly. Mysterious!';
  else if (r.exact.includes(s.me.id)) msg = '+2, mind reader!';
  else if (r.close.includes(s.me.id)) msg = '+1, so close!';
  else msg = s.myRating ? 'Not even close.' : 'You didn\u2019t guess.';
  return [head, card(h('div', { class: 'result' },
    h('div', { class: 'big-emoji' }, truth ? truth.emoji : '\u{1F937}'),
    h('h2', null, truth ? `${dj?.name || 'The DJ'}: ${truth.v}/5 \u00B7 ${truth.label}` : `${dj?.name || 'The DJ'} didn\u2019t rate it`),
    h('p', null, msg)))];
}

// ----- game over -----

function gameover(s) {
  const ranked = [...s.players].sort((a, b) => b.score - a.score);
  const place = ranked.findIndex((p) => p.id === s.me.id) + 1;
  const top = ranked[0]?.score ?? 0;
  const won = s.me.score === top;
  const tied = ranked.filter((p) => p.score === top).length > 1;
  return [
    card(h('div', { class: 'result' },
      won && top > 0 ? h('div', { class: 'big-emoji' }, '\u{1F3C6}') : gooseIcon('big-emoji'),
      h('h2', null, top === 0 ? 'Nobody scored!' : won ? (tied ? 'You tied for first!' : 'You won!') : `You placed #${place}`),
      h('p', null, `${s.me.score} point${s.me.score === 1 ? '' : 's'}`))),
    myAwards(s),
    card(h('ol', { class: 'podium' }, ranked.map((p, i) => h('li', null, h('span', { class: 'rank' }, `${i + 1}`), gooseAvatar(p, 'sm'), chip(p), h('span', { class: 'pts' }, String(p.score)))))),
    setlist(s),
  ];
}

function myAwards(s) {
  const all = s.awards || [];
  if (!all.length) return null;
  const mine = all.filter((a) => a.playerIds.includes(s.me.id));
  return card(
    h('div', { class: 'kicker' }, mine.length ? 'You won an award!' : 'Superlatives'),
    h('ul', { class: 'phone-awards' }, (mine.length ? mine : all).map((a) => h('li', { class: mine.includes(a) ? 'mine' : '' },
      h('strong', null, a.title),
      mine.length ? null : h('span', null, ' \u00B7 ', a.playerIds.map((id) => playerById(s, id)?.name).filter(Boolean).join(' & ')),
      h('div', { class: 'fine left' }, a.detail)))),
  );
}

// The whole point of the game: take home the songs you discovered.
function setlist(s) {
  const list = s.playlist || [];
  if (!list.length) return null;
  const others = list.filter((t) => t.playerId !== s.me.id);
  const yt = youtubePlaylistUrl(others);
  return card(
    h('div', { class: 'kicker' }, 'Songs you discovered tonight'),
    h('p', { class: 'fine left' }, 'Tap \u2661 on your favorite to vote for Song of the Night.'),
    h('ul', { class: 'phone-setlist' }, others.map((t) => h('li', { class: s.myFavorite === t.entryId ? 'fav' : '' },
      chip(playerById(s, t.playerId)),
      h('a', { href: songHref(t.song), target: '_blank', rel: 'noopener' }, t.song.display),
      h('button', {
        class: `heart${s.myFavorite === t.entryId ? ' on' : ''}`,
        'aria-pressed': s.myFavorite === t.entryId ? 'true' : 'false',
        'aria-label': `Favorite ${t.song.display}`,
        onclick: async () => { try { await act('favorite', { entryId: t.entryId }); if (navigator.vibrate) navigator.vibrate(20); } catch (err) { toast(err.message); } },
      }, s.myFavorite === t.entryId ? '\u2764\uFE0F' : '\u2661', t.favs ? h('span', { class: 'heart-n' }, String(t.favs)) : null)))),
    h('div', { class: 'row-buttons' },
      yt ? h('a', { class: 'btn primary', href: yt, target: '_blank', rel: 'noopener' }, '\u25B6 Play on YouTube') : null,
      h('button', { class: 'btn ghost', onclick: async () => toast(await copyText(setlistText(list, s)) ? 'Setlist copied!' : 'Could not copy') }, 'Copy all')),
  );
}

boot();
