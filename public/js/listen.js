// "Everyone remote" mode: each player's own device plays the music, synced to the host.
//
// One persistent YouTube player per device (via the IFrame API) so that once the browser
// has allowed sound, later songs keep playing without another tap. Each song seeks to
// where the host is (server start time + elapsed), so everyone hears the same moment.
// Spotify can't be started by a page, so Spotify songs show their own player to tap.

import { h, store, searchUrls, serverNow } from './common.js';

const MUTE_KEY = 'goose.deviceMuted';
const GAME_PHASES = new Set(['submit', 'listen', 'reveal', 'judge', 'defend', 'vote']);

let dock = null;
let ui = null;               // persistent child elements
let yt = null;               // YT.Player
let ytReady = null;          // Promise<YT.Player>
let ytState = -1;
let playingKey = null;
let checkTimer = null;
let lastNp = null;
let active = false;
let muted = store.get(MUTE_KEY) === true;
let otherKey = null;

function ensureDock() {
  if (dock) return;
  dock = h('section', { id: 'listen-dock', class: 'card', 'aria-label': 'Music on this device', hidden: true });
  ui = {
    head: h('div', { class: 'ld-head' }),
    video: h('div', { class: 'ld-video', hidden: true }, h('div', { id: 'ld-yt' })),
    other: h('div', { class: 'ld-other' }),
    tap: h('button', { class: 'btn primary big ld-tap', hidden: true, onclick: tapToPlay }, '▶ Tap to play the music'),
    note: h('p', { class: 'fine left ld-note' }),
  };
  dock.append(ui.head, ui.tap, ui.video, ui.other, ui.note);
  document.getElementById('app').after(dock);
}

/** Call with every new state (or null when leaving the room). */
export function updateListening(state) {
  ensureDock();
  const remote = Boolean(state && state.settings && state.settings.venue === 'remote');
  const inGame = Boolean(state && GAME_PHASES.has(state.phase));
  active = remote && inGame;
  dock.hidden = !(remote && state.phase !== 'gameover');
  document.body.classList.toggle('has-dock', !dock.hidden);
  if (!remote || !state) { stopAll(); return; }

  lastNp = state.nowPlaying || null;
  renderHead(state);
  if (!active) { stopAll(); renderIdle('Music will play right here on your device once the songs start. Turn your volume up!'); return; }
  sync();
}

function renderHead(state) {
  ui.head.replaceChildren(
    h('div', null,
      h('div', { class: 'kicker' }, '\u{1F3A7} Playing on your device'),
      h('div', { class: 'ld-title' }, lastNp ? lastNp.song.display : (state.phase === 'lobby' ? 'Everyone-remote game' : 'Waiting for the next song…'))),
    h('button', {
      class: 'btn small ghost', 'aria-pressed': muted ? 'true' : 'false',
      onclick: () => { muted = !muted; store.set(MUTE_KEY, muted); applyMute(); renderHead(state); },
    }, muted ? '\u{1F507} Unmute' : '\u{1F50A} Mute'));
}

function renderIdle(text) {
  ui.video.hidden = true;
  ui.tap.hidden = true;
  ui.other.replaceChildren();
  otherKey = null;
  ui.note.textContent = text;
}

function sync() {
  const np = lastNp;
  const key = np ? `${np.entryId}:${np.startedAt}` : null;
  if (!np) { stopAll(); renderIdle('Next song coming up…'); return; }
  if (key === playingKey) return;
  playingKey = key;
  clearTimeout(checkTimer);
  ui.tap.hidden = true;

  if (np.song.kind === 'youtube') {
    ui.other.replaceChildren();
    otherKey = null;
    ui.video.hidden = false;
    ui.note.textContent = 'Synced with the host. Use your device’s volume buttons.';
    loadYouTube().then((player) => {
      if (playingKey !== key) return;
      player.loadVideoById({ videoId: np.song.id, startSeconds: position(np) });
      applyMute();
      // Browsers (iPhones especially) may refuse to start sound on their own: offer a tap.
      checkTimer = setTimeout(() => {
        if (playingKey !== key) return;
        if (ytState !== 1 && ytState !== 3) showTap('\u25B6 Tap to play the music');
        // Some phones let the video start but force it silent: catch that too.
        else if (!muted && yt.isMuted && yt.isMuted()) showTap('\u{1F50A} Tap for sound');
      }, 3000);
    });
    return;
  }

  pauseYouTube();
  ui.video.hidden = true;
  if (otherKey === key) return;
  otherKey = key;
  if (np.song.kind === 'spotify') {
    const src = `https://open.spotify.com/embed/${encodeURIComponent(np.song.type)}/${encodeURIComponent(np.song.id)}?utm_source=generator`;
    ui.other.replaceChildren(h('iframe', { class: 'ld-spotify', src, title: 'Spotify player', allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture', loading: 'lazy' }));
    ui.note.textContent = 'Spotify can’t start by itself: tap ▶ in the player. (30-second preview unless you’re logged in to Spotify.)';
  } else {
    const u = searchUrls(np.song.text);
    ui.other.replaceChildren(h('div', { class: 'np-links' },
      h('a', { href: u.youtubeWeb, target: '_blank', rel: 'noopener' }, 'Search YouTube ↗'),
      h('a', { href: u.spotify, target: '_blank', rel: 'noopener' }, 'Search Spotify ↗')));
    ui.note.textContent = 'This song was typed in by hand. Open it to listen along.';
  }
}

/** Seconds into the song the host is at right now. */
function position(np) {
  const elapsed = np.startedAt ? Math.max(0, (serverNow() - np.startedAt) / 1000) : 0;
  return (Number(np.song.start) || 0) + elapsed;
}

function showTap(label) {
  ui.tap.textContent = label;
  ui.tap.hidden = false;
}

function tapToPlay() {
  // Runs inside a tap, so the browser allows sound from here on.
  ui.tap.hidden = true;
  if (!yt || !lastNp || lastNp.song.kind !== 'youtube') return;
  yt.seekTo(position(lastNp), true);
  if (!muted) yt.unMute();
  yt.playVideo();
}

function applyMute() {
  if (!yt || typeof yt.mute !== 'function') return;
  if (muted) yt.mute(); else yt.unMute();
}

function pauseYouTube() {
  clearTimeout(checkTimer);
  if (yt && typeof yt.pauseVideo === 'function') yt.pauseVideo();
}

function stopAll() {
  playingKey = null;
  otherKey = null;
  pauseYouTube();
  if (ui) { ui.other.replaceChildren(); ui.tap.hidden = true; }
}

function loadYouTube() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    const create = () => {
      yt = new window.YT.Player('ld-yt', {
        width: '100%',
        height: '100%',
        host: 'https://www.youtube-nocookie.com',
        playerVars: { playsinline: 1, rel: 0, autoplay: 1, origin: location.origin },
        events: {
          onReady: () => resolve(yt),
          onStateChange: (e) => {
            ytState = e.data;
            if (ytState === 1) ui.tap.hidden = true;
          },
          onError: () => {
            ui.tap.hidden = true;
            ui.note.replaceChildren('This video can’t play outside YouTube. ',
              lastNp ? h('a', { href: lastNp.song.url, target: '_blank', rel: 'noopener' }, 'Open it on YouTube ↗') : null);
          },
        },
      });
    };
    if (window.YT && window.YT.Player) { create(); return; }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); create(); };
    const sc = document.createElement('script');
    sc.src = 'https://www.youtube.com/iframe_api';
    sc.onerror = () => { ui.note.textContent = 'Couldn’t load the YouTube player. Check your connection.'; };
    document.head.append(sc);
  });
  return ytReady;
}
