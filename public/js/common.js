// Small shared helpers for the host and phone screens. All user text goes through
// text nodes (never innerHTML), so song names and player names can't inject markup.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
        }
      } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export async function api(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/**
 * Live room state over Server-Sent Events.
 * EventSource reconnects by itself, but phones are rough on connections: iOS can freeze a
 * backgrounded tab and leave a socket silently dead. So we also run a watchdog (the server
 * sends a ping every 20s) and reconnect when the page becomes visible or the network returns.
 */
export function openStream(params, { onState, onFatal, onStatus, events = {} }) {
  const url = `/api/events?${new URLSearchParams(params)}`;
  let es = null;
  let closed = false;
  let lastSeen = Date.now();
  let retryTimer = null;

  const connect = () => {
    if (closed) return;
    clearTimeout(retryTimer);
    es?.close();
    es = new EventSource(url);
    lastSeen = Date.now();
    es.addEventListener('state', (e) => { lastSeen = Date.now(); onStatus?.(true); onState(JSON.parse(e.data)); });
    es.addEventListener('ping', () => { lastSeen = Date.now(); onStatus?.(true); });
    es.addEventListener('open', () => { lastSeen = Date.now(); onStatus?.(true); });
    for (const [name, fn] of Object.entries(events)) {
      es.addEventListener(name, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
    }
    es.addEventListener('fatal', (e) => {
      let data = {};
      try { data = JSON.parse(e.data); } catch { /* keep default */ }
      stop();
      onFatal?.(data.error || 'Disconnected', data);
    });
    es.addEventListener('error', () => {
      onStatus?.(false);
      // CLOSED means the browser gave up (e.g. server restarting); try again ourselves.
      if (es.readyState === 2) retryTimer = setTimeout(connect, 2000);
    });
  };

  const revive = () => {
    if (closed) return;
    if (document.visibilityState === 'visible' && (es.readyState !== 1 || Date.now() - lastSeen > 25000)) connect();
  };
  const watchdog = setInterval(() => {
    if (!closed && Date.now() - lastSeen > 50000) { onStatus?.(false); connect(); }
  }, 5000);
  document.addEventListener('visibilitychange', revive);
  window.addEventListener('online', revive);
  window.addEventListener('pageshow', revive);

  function stop() {
    closed = true;
    clearInterval(watchdog);
    clearTimeout(retryTimer);
    document.removeEventListener('visibilitychange', revive);
    window.removeEventListener('online', revive);
    window.removeEventListener('pageshow', revive);
    es?.close();
  }

  connect();
  return { close: stop };
}

let toastTimer = null;
export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

export const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* private mode etc. */ }
  },
};

export function playerById(state, id) {
  return state.players.find((p) => p.id === id) || null;
}

export function chip(player, extra = '') {
  if (!player) return h('span', { class: 'chip ghost' }, 'someone');
  return h('span', { class: `chip ${extra}`.trim(), style: { '--c': player.color } }, player.name);
}

export function searchUrls(text) {
  const q = encodeURIComponent(text || '');
  return {
    youtube: `https://music.youtube.com/search?q=${q}`,
    youtubeWeb: `https://www.youtube.com/results?search_query=${q}`,
    spotify: `https://open.spotify.com/search/${q}`,
  };
}

// The goose emoji (U+1FABF) is missing on older systems (e.g. macOS < 13.3), so we draw our own.
const INK = '#1f1430';
// Feather colors: [body, wing line, eye].
const FEATHER_FILL = {
  white: ['#fbf8f1', '#c4c4cc', INK],
  grey: ['#c3c6cf', '#8d909c', INK],
  brown: ['#c08a5b', '#8a5f3a', INK],
  black: ['#3d3b47', '#67657a', '#fbf8f1'],
  gold: ['#f6c94e', '#c8962a', INK],
  pink: ['#ffb3cf', '#e07aa2', INK],
  red: ['#e8615a', '#b03b36', INK],
  orange: ['#ffa24c', '#cc7224', INK],
  mint: ['#9ee6c4', '#5fb592', INK],
  blue: ['#8ec5ff', '#5a92d4', INK],
  purple: ['#b79cf0', '#8668c9', INK],
  navy: ['#34417a', '#5b6aa8', '#fbf8f1'],
};
export const FEATHER_LABELS = {
  white: 'White', grey: 'Grey', brown: 'Brown', black: 'Black', gold: 'Golden',
  pink: 'Pink', red: 'Red', orange: 'Orange', mint: 'Mint', blue: 'Sky blue', purple: 'Lavender', navy: 'Midnight',
};
// Feathers dark enough to need light details (eye, swatch checkmark).
export const DARK_FEATHERS = new Set(['black', 'navy']);
export const FEATHER_SWATCH = Object.fromEntries(Object.entries(FEATHER_FILL).map(([k, v]) => [k, v[0]]));

// Expressions, drawn around the eye (48.6, 11.6). "E" is replaced with the eye color.
const FACE_SVG = {
  normal: '<circle cx="48.6" cy="11.6" r="1.5" fill="E"/>',
  happy: '<path d="M47 12.4 Q48.6 9.8 50.2 12.4" fill="none" stroke="E" stroke-width="1.3" stroke-linecap="round"/>',
  angry: '<circle cx="48.8" cy="12" r="1.4" fill="E"/><path d="M46.4 8.6 L51.2 10.4" stroke="E" stroke-width="1.4" stroke-linecap="round"/>',
  sleepy: '<path d="M47 11.6 Q48.6 13.2 50.2 11.6" fill="none" stroke="E" stroke-width="1.3" stroke-linecap="round"/><text x="53" y="5" font-size="5" font-weight="700" font-family="sans-serif" fill="#a0c4ff" stroke="none">z</text>',
  starry: `<path d="M48.6 8.9 L49.4 10.8 L51.4 11 L49.9 12.3 L50.3 14.3 L48.6 13.3 L46.9 14.3 L47.3 12.3 L45.8 11 L47.8 10.8 Z" fill="#ffd166" stroke="${INK}" stroke-width=".5" stroke-linejoin="round"/>`,
};
export const FACE_LABELS = { normal: 'Classic', happy: 'Happy', angry: 'Angry', sleepy: 'Sleepy', starry: 'Starstruck' };

function gooseBody(feathers = 'white', face = 'normal') {
  const [fill, wing, eye] = FEATHER_FILL[feathers] || FEATHER_FILL.white;
  return `
  <g fill="${INK}" stroke="${INK}">
    <line x1="40" y1="40" x2="45.5" y2="15" stroke-width="11" stroke-linecap="round"/>
    <circle cx="47" cy="13" r="7.4"/>
    <ellipse cx="13" cy="37" rx="8.4" ry="5.4" transform="rotate(-20 13 37)"/>
    <ellipse cx="30" cy="42" rx="21.4" ry="12.4"/>
  </g>
  <g fill="${fill}" stroke="${fill}">
    <line x1="40" y1="40" x2="45.5" y2="15" stroke-width="7.5" stroke-linecap="round"/>
    <circle cx="47" cy="13" r="6" stroke="none"/>
    <ellipse cx="13" cy="37" rx="7" ry="4" transform="rotate(-20 13 37)" stroke="none"/>
    <ellipse cx="30" cy="42" rx="20" ry="11" stroke="none"/>
  </g>
  <ellipse cx="27" cy="41" rx="12" ry="5" fill="none" stroke="${wing}" stroke-width="1.6"/>
  <path d="M52 10.5 L62 13.5 L52 16.5 Z" fill="#f99a26" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/>
  ${(FACE_SVG[face] || FACE_SVG.normal).replaceAll('"E"', `"${eye}"`)}`;
}
const GOOSE_BODY = gooseBody();
const GOOSE_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">${GOOSE_BODY}</svg>`;

// Hats sit on the head (center 47,13). "C" is replaced with the player's color.
const S = `stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"`;
const HAT_SVG = {
  none: '',
  crown: `<path d="M40.5 8 L41.5 0 L44.5 4.5 L47 -1.5 L49.5 4.5 L52.5 0 L53.5 8 Z" fill="#ffd166" ${S}/><circle cx="47" cy="5.2" r="1.3" fill="C"/>`,
  tophat: `<rect x="41.5" y="-5" width="11" height="11" rx="1" fill="${INK}"/><rect x="41.5" y="2" width="11" height="2.4" fill="C"/><rect x="38" y="5.5" width="18" height="2.6" rx="1.3" fill="${INK}"/>`,
  party: `<path d="M41 8 L47.5 -8 L54 7 Z" fill="C" ${S}/><path d="M43.4 3 L52.2 2.2 M45.4 -2 L50.2 -2.4" stroke="#fff" stroke-width="1.4" opacity=".8"/><circle cx="47.5" cy="-8" r="2.3" fill="#fff" ${S}/>`,
  beanie: `<path d="M40 9 C40 0 54 0 54 9 Z" fill="C" ${S}/><rect x="39.5" y="7" width="15" height="3.4" rx="1.6" fill="C" ${S}/><circle cx="47" cy="1" r="2.4" fill="#fff" ${S}/>`,
  flower: `<g fill="C" ${S}><circle cx="41.5" cy="3.5" r="2.4"/><circle cx="45" cy="5.5" r="2.4"/><circle cx="43.6" cy="9.2" r="2.4"/><circle cx="39.4" cy="9" r="2.4"/><circle cx="38.2" cy="5.2" r="2.4"/></g><circle cx="41.7" cy="6.6" r="1.9" fill="#ffd166" ${S}/>`,
  headphones: `<path d="M39.5 14 C39.5 1.5 55 1.5 55 12" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/><rect x="36.6" y="11" width="5.4" height="7.4" rx="2.2" fill="C" ${S}/><rect x="52.4" y="7.6" width="4.4" height="6" rx="2" fill="C" ${S}/>`,
  cowboy: `<path d="M36 7.4 C40 9.6 54 9.6 58 6.4 C56.4 10 37.8 11.2 36 7.4 Z" fill="#8b5a2b" ${S}/><path d="M41 8.2 C41 0 44 1 47 2.6 C50 1 53 0 53 8.2 Z" fill="#a0692f" ${S}/><rect x="41.3" y="5.4" width="11.5" height="1.9" fill="C"/>`,
  pirate: `<path d="M37.5 8.4 C39 -0.5 55 -0.5 56.5 8.4 C51 6 43 6 37.5 8.4 Z" fill="${INK}" ${S}/><path d="M39.6 6.6 C44 4.9 50 4.9 54.4 6.6" fill="none" stroke="C" stroke-width="1.2"/><circle cx="47" cy="2.6" r="1.5" fill="#fff"/><path d="M45.6 4.8 L48.4 4.8" stroke="#fff" stroke-width=".8"/>`,
  wizard: `<path d="M41 8.4 L48.6 -9.4 L53.8 8 Z" fill="#5b4bb7" ${S}/><rect x="38" y="6.8" width="18" height="2.8" rx="1.4" fill="#5b4bb7" ${S}/><rect x="41.4" y="5" width="12" height="1.8" fill="C"/><path d="M47.4 -1.4 l.6 1.3 1.4.2 -1 1 .2 1.4 -1.2 -.7 -1.2.7 .2 -1.4 -1 -1 1.4 -.2 Z" fill="#ffd166"/>`,
  viking: `<path d="M40.6 5.4 C37 4.4 35.4 0 36.4 -3.4 C37.6 -0.4 39.6 1.4 41.8 2.2 Z M53.4 5.4 C57 4.4 58.6 0 57.6 -3.4 C56.4 -0.4 54.4 1.4 52.2 2.2 Z" fill="#f4ecd8" ${S}/><path d="M40 9 C40 0.6 54 0.6 54 9 Z" fill="#9aa3ad" ${S}/><rect x="39.5" y="7.2" width="15" height="2.8" rx="1.2" fill="C" ${S}/><path d="M47 1.4 V7" stroke="${INK}" stroke-width=".9"/>`,
  chef: `<path d="M41.5 8.6 V3.2 C37.6 3 37.8 -3.4 42 -2.4 C42.6 -6.6 47.6 -6.6 48.2 -3 C49.8 -6.6 55.2 -5 53.6 -1 C57 0 56 4 52.5 3.6 V8.6 Z" fill="#fff" ${S}/><rect x="41.5" y="5.8" width="11" height="1.8" fill="C"/>`,
  halo: `<ellipse cx="47" cy="-1.5" rx="8" ry="2.6" fill="none" stroke="C" stroke-width="1" opacity=".55"/><ellipse cx="47" cy="-1.5" rx="6.6" ry="1.9" fill="none" stroke="#ffd166" stroke-width="1.8"/>`,
  bucket: `<path d="M41.2 8 L42.6 1.4 C44.4 0.4 49.6 0.4 51.4 1.4 L52.8 8 Z" fill="C" ${S}/><path d="M37.4 9.2 C40 6.6 54 6.6 56.6 9.2 C55 10.8 39 10.8 37.4 9.2 Z" fill="C" ${S}/><path d="M42 5.6 C45 6.2 49 6.2 52 5.6" fill="none" stroke="${INK}" stroke-width=".7" stroke-dasharray="1 .8"/>`,
  propeller: `<path d="M40 9 C40 0.4 54 0.4 54 9 Z" fill="C" ${S}/><path d="M43.4 2.2 L44.6 8.8 M50.6 2.2 L49.4 8.8" stroke="#fff" stroke-width="1.2" opacity=".75"/><rect x="46.4" y="-2.6" width="1.2" height="3.6" fill="${INK}"/><ellipse cx="43.4" cy="-2.8" rx="3.6" ry="1.1" fill="#ef476f" ${S}/><ellipse cx="50.6" cy="-2.8" rx="3.6" ry="1.1" fill="#06d6a0" ${S}/><circle cx="47" cy="-2.8" r="1" fill="#ffd166" ${S}/>`,
};
export const HAT_LABELS = {
  none: 'No hat', crown: 'Crown', tophat: 'Top hat', party: 'Party hat', beanie: 'Beanie',
  flower: 'Flower', headphones: 'Headphones', cowboy: 'Cowboy hat', pirate: 'Pirate hat', wizard: 'Wizard hat',
  viking: 'Viking helmet', chef: 'Chef hat', halo: 'Halo', bucket: 'Bucket hat', propeller: 'Propeller cap',
};

// Accessories are worn with any hat. "C" is the player's color.
const ACCESSORY_SVG = {
  none: '',
  shades: `<path d="M43.6 9.4 h5.2 v3.2 a2.2 2.2 0 0 1 -2.2 2.2 h-0.8 a2.2 2.2 0 0 1 -2.2 -2.2 z M49.8 9.4 h4.6 v2.8 a2.2 2.2 0 0 1 -2.2 2.2 h-0.2 a2.2 2.2 0 0 1 -2.2 -2.2 z" fill="${INK}"/><path d="M40.6 10 L43.6 9.6 M48.8 10 h1" stroke="${INK}" stroke-width="1.3"/><path d="M44.6 10.6 l1.6 0" stroke="C" stroke-width="1" stroke-linecap="round"/>`,
  heartshades: `<g fill="#ef476f"><circle cx="47.3" cy="10.6" r="1.7"/><circle cx="49.9" cy="10.6" r="1.7"/><path d="M45.7 11.3 L51.5 11.3 L48.6 14.6 Z"/></g><path d="M40.6 10.2 L45.6 10.4" stroke="${INK}" stroke-width="1.2"/><circle cx="47" cy="10.2" r=".5" fill="#fff"/>`,
  monocle: `<circle cx="48.6" cy="11.6" r="2.7" fill="#fff" fill-opacity=".25" stroke="#ffd166" stroke-width="1"/><path d="M48 14.3 Q46.4 20 49.6 25" fill="none" stroke="#ffd166" stroke-width=".7"/>`,
  bowtie: `<path d="M35.5 29.5 L41.5 33 L35.5 36.5 Z M47.5 29.5 L41.5 33 L47.5 36.5 Z" fill="C" ${S}/><circle cx="41.5" cy="33" r="1.9" fill="C" ${S}/>`,
  scarf: `<path d="M37.6 28.2 Q42.6 32.6 47.8 27.8 L48.6 31.4 Q42.6 36.6 36.8 31.8 Z" fill="C" ${S}/><path d="M39.6 31.8 L37.6 39.6 L41.4 39 L42.4 32.8 Z" fill="C" ${S}/><path d="M38.2 37.4 L41.6 36.8" stroke="#fff" stroke-width=".9" opacity=".7"/>`,
  chain: `<path d="M38 30.6 Q42.4 37.6 47.4 30" fill="none" stroke="#ffd166" stroke-width="1.5" stroke-dasharray="1.5 .7"/><circle cx="42.6" cy="35.8" r="2" fill="#ffd166" ${S}/>`,
};
export const ACCESSORY_LABELS = {
  none: 'Nothing', shades: 'Shades', heartshades: 'Heart glasses', monocle: 'Monocle', bowtie: 'Bow tie', scarf: 'Scarf', chain: 'Gold chain',
};
// These replace the collar, since they already show the player's color around the neck.
const NECKWEAR = new Set(['bowtie', 'scarf']);

const pick = (table, key, fallback) => (Object.prototype.hasOwnProperty.call(table, key) ? key : fallback);

/**
 * A player's goose: feathers, expression, collar in their color, accessory and hat.
 * Small sizes ("head" in cls) crop to a headshot so the hat stays readable.
 */
export function gooseAvatar(player, cls = '') {
  const head = /(^|\s)(head|sm)(\s|$)/.test(cls);
  const color = /^#[0-9a-f]{6}$/i.test(player?.color || '') ? player.color : '#ffd166';
  // Older saves stored shades / bow tie as hats.
  const legacy = player?.hat === 'shades' || player?.hat === 'bowtie';
  const hat = pick(HAT_SVG, player?.hat, 'none');
  const acc = pick(ACCESSORY_SVG, legacy && (!player.accessory || player.accessory === 'none') ? player.hat : player?.accessory, 'none');
  const feathers = pick(FEATHER_FILL, player?.feathers, 'white');
  const face = pick(FACE_SVG, player?.face, 'normal');
  const collar = NECKWEAR.has(acc) ? '' : `<path d="M38.4 31.2 Q42.6 34.6 46.8 30.6" fill="none" stroke="${color}" stroke-width="3.2" stroke-linecap="round"/>`;
  const span = document.createElement('span');
  span.className = `goose-avatar ${cls}`.trim();
  span.setAttribute('aria-hidden', 'true');
  // Constant markup + a validated hex color + whitelisted keys: no user text reaches innerHTML.
  const paint = (svg) => svg.replaceAll('"C"', `"${color}"`);
  span.innerHTML = `<svg viewBox="${head ? '30 -10 34 47' : '-2 -11 68 77'}" focusable="false">${gooseBody(feathers, face)}${collar}${paint(ACCESSORY_SVG[acc])}${paint(HAT_SVG[hat])}</svg>`;
  return span;
}

export function gooseIcon(cls = '') {
  const span = document.createElement('span');
  span.className = `goose-icon ${cls}`.trim();
  span.innerHTML = GOOSE_SVG; // constant markup, no user data
  return span;
}

const MODE_GLYPHS = { king: '\u{1F451}', secret: '\u{1F92B}', fight: '\u{1F94A}', fake: '\u{1F3AD}', mind: '\u{1F9E0}', chain: '\u{1F517}', hot: '\u{1F336}\uFE0F' };

export function modeIcon(key, cls = '') {
  if (key === 'loose') return gooseIcon(cls);
  return h('span', { class: `mode-glyph ${cls}`.trim(), 'aria-hidden': 'true' }, MODE_GLYPHS[key] || '\u{1F3B5}');
}

// ---------- re-rendering without losing what people are typing ----------

/** Replace a container's children, keeping values + focus of inputs marked with data-keep. */
export function mountInto(container, nodes) {
  const kept = {};
  let focus = null;
  container.querySelectorAll('[data-keep]').forEach((el) => {
    kept[el.dataset.keep] = el.value;
    if (el === document.activeElement) focus = { key: el.dataset.keep, start: el.selectionStart, end: el.selectionEnd };
  });
  container.replaceChildren(...[nodes].flat(Infinity).filter(Boolean));
  container.querySelectorAll('[data-keep]').forEach((el) => {
    if (kept[el.dataset.keep] != null) el.value = kept[el.dataset.keep];
  });
  if (focus) {
    const el = container.querySelector(`[data-keep="${CSS.escape(focus.key)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(focus.start, focus.end); } catch { /* not a text input */ }
    }
  }
}

/** Clear a data-keep input after a successful submit (it may have been re-rendered meanwhile). */
export function clearKept(container, key) {
  const el = container.querySelector(`[data-keep="${CSS.escape(key)}"]`);
  if (el) el.value = '';
}

// ---------- countdowns ----------

let clockOffset = 0; // server time - local time

/** Call with each state; keeps countdowns in sync even if device clocks disagree. */
export function syncClock(state) {
  const now = state && (state.now ?? state.timer?.now);
  if (typeof now === 'number') clockOffset = now - Date.now();
}

/** The server's clock, as best we know it. */
export function serverNow() { return Date.now() + clockOffset; }

export function timerBadge(timer, cls = '') {
  if (!timer) return null;
  const el = h('span', { class: `timer ${cls}`.trim(), 'data-deadline': timer.deadline, role: 'timer' });
  paintTimer(el);
  return el;
}

export function secondsLeft(timer) {
  return Math.max(0, Math.ceil((timer.deadline - (Date.now() + clockOffset)) / 1000));
}

function paintTimer(el) {
  const left = secondsLeft({ deadline: Number(el.dataset.deadline) });
  const text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('urgent', left <= 10);
}

setInterval(() => document.querySelectorAll('.timer[data-deadline]').forEach(paintTimer), 250);

// ---------- misc ----------

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Plain-http LAN pages are not a "secure context": fall back to a hidden textarea.
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/** Where a setlist entry should link to. */
export function songHref(song) {
  if (song.url) return song.url;
  return searchUrls(song.text || song.display).youtubeWeb;
}

export function setlistText(playlist, state) {
  return playlist.map((t, i) => {
    const who = playerById(state, t.playerId)?.name || 'someone';
    return `${i + 1}. ${t.song.display} (picked by ${who})\n   ${songHref(t.song)}`;
  }).join('\n');
}

export function youtubePlaylistUrl(playlist) {
  const ids = [...new Set(playlist.filter((t) => t.song.kind === 'youtube').map((t) => t.song.id))].slice(0, 50);
  return ids.length ? `https://www.youtube.com/watch_videos?video_ids=${ids.join(',')}` : null;
}

// Honk Take's 1–5 scale.
export const RATINGS = [
  { v: 1, emoji: '\u{1F92E}', label: 'Hate it' },
  { v: 2, emoji: '\u{1F62C}', label: 'Not for me' },
  { v: 3, emoji: '\u{1F610}', label: 'It’s fine' },
  { v: 4, emoji: '\u{1F642}', label: 'Like it' },
  { v: 5, emoji: '\u{1F60D}', label: 'Love it' },
];

export const REACTIONS = [
  { kind: 'fire', glyph: '\u{1F525}', label: 'Fire' },
  { kind: 'laugh', glyph: '\u{1F602}', label: 'Laughing' },
  { kind: 'cry', glyph: '\u{1F62D}', label: 'Crying' },
  { kind: 'mindblown', glyph: '\u{1F92F}', label: 'Mind blown' },
  { kind: 'skull', glyph: '\u{1F480}', label: 'Dead' },
  { kind: 'heart', glyph: '❤️', label: 'Love' },
  { kind: 'honk', glyph: 'HONK!', label: 'Honk' },
];

/**
 * Share a link: the native share sheet on phones/tablets (needs https), otherwise copy it.
 * Resolves to 'shared' | 'copied' | 'cancelled' | 'failed'.
 */
export async function shareLink(url, { title = 'A Goose Among Sirens', text = 'Join my game!' } = {}) {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.share) {
    try { await navigator.share({ title, text, url }); return 'shared'; } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
    }
  }
  return (await copyText(url)) ? 'copied' : 'failed';
}

export function shareToast(result, url) {
  if (result === 'copied') toast('Join link copied! Paste it in your group chat.');
  else if (result === 'failed') toast(`Copy this link: ${url}`);
}
