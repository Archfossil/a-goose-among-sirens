// "Everyone remote" mode: each player's own device plays the music, synced to the host.
//
// One persistent YouTube player per device (via the IFrame API) so that once the browser
// has allowed sound, later songs keep playing without another tap. Each song seeks to
// where the host is (server start time + elapsed), so everyone hears the same moment.
// Spotify works the same way through its iFrame API (one persistent embed, loadUri + play).
// Some browsers (Safari especially) still block that without a tap, so a tap button is offered.
// Players can also turn auto-play off: each song then waits for a tap (and still joins in sync).

import { h, store, searchUrls, serverNow } from './common.js';

const MUTE_KEY = 'goose.deviceMuted';
const AUTO_KEY = 'goose.autoplay';
const GAME_PHASES = new Set(['submit', 'listen', 'reveal', 'judge', 'defend', 'vote', 'write', 'rate']);

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
let autoplay = store.get(AUTO_KEY) !== false;
let otherKey = null;
let sp = null;               // Spotify EmbedController
let spReady = null;          // Promise<EmbedController>
let spPlaying = false;
let spLoadedKey = null;      // song key whose content the embed is loading/showing
let spWantKey = null;        // song key that should start playing once the embed is ready

function ensureDock() {
  if (dock) return;
  dock = h('section', { id: 'listen-dock', class: 'card', 'aria-label': 'Music on this device', hidden: true });
  ui = {
    head: h('div', { class: 'ld-head' }),
    video: h('div', { class: 'ld-video', hidden: true }, h('div', { id: 'ld-yt' })),
    spotify: h('div', { class: 'ld-spotify', hidden: true }, h('div', { id: 'ld-sp' })),
    other: h('div', { class: 'ld-other' }),
    tap: h('button', { class: 'btn primary big ld-tap', hidden: true, onclick: tapToPlay }, '▶ Tap to play the music'),
    note: h('p', { class: 'fine left ld-note' }),
  };
  dock.append(ui.head, ui.tap, ui.video, ui.spotify, ui.other, ui.note);
  document.getElementById('app').after(dock);
}

/** True when the player muted this device's game audio. */
export function isDeviceMuted() {
  return muted;
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
    h('div', { class: 'ld-buttons' },
      h('button', {
        class: `btn small ${autoplay ? 'ghost' : 'primary'}`, 'aria-pressed': autoplay ? 'true' : 'false',
        title: autoplay ? 'Songs start by themselves. Tap to make each song wait for you.' : 'Each song waits for a tap. Tap to let songs start by themselves.',
        onclick: () => { autoplay = !autoplay; store.set(AUTO_KEY, autoplay); onAutoplayChange(); renderHead(state); },
      }, autoplay ? '\u23EF Auto-play: On' : '\u23F8 Auto-play: Off'),
      h('button', {
        class: 'btn small ghost', 'aria-pressed': muted ? 'true' : 'false',
        onclick: () => { muted = !muted; store.set(MUTE_KEY, muted); applyMute(); renderHead(state); },
      }, muted ? '\u{1F507} Unmute' : '\u{1F50A} Mute')));
}

/** Auto-play was switched: start a waiting song now, or just let the next song wait. */
function onAutoplayChange() {
  if (!autoplay || !active || !lastNp || muted) return;
  if (!ui.tap.hidden) tapToPlay(); // runs inside the toggle tap, so sound is allowed
}

function renderIdle(text) {
  ui.video.hidden = true;
  ui.spotify.hidden = true;
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
    pauseSpotify();
    ui.spotify.hidden = true;
    ui.other.replaceChildren();
    otherKey = null;
    ui.video.hidden = false;
    ui.note.textContent = autoplay ? 'Synced with the host. Use your device’s volume buttons.' : 'Auto-play is off. Tap play to jump in, synced with the host.';
    loadYouTube().then((player) => {
      if (playingKey !== key) return;
      if (!autoplay) {
        player.cueVideoById({ videoId: np.song.id, startSeconds: position(np) });
        showTap('\u25B6 Play this song');
        return;
      }
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
  if (np.song.kind === 'spotify') {
    ui.other.replaceChildren();
    otherKey = null;
    ui.spotify.hidden = false;
    ui.note.textContent = autoplay
      ? 'Synced with the host. (30-second preview unless you’re logged in to Spotify.)'
      : 'Auto-play is off. Tap play to jump in. (30-second preview unless you’re logged in to Spotify.)';
    playSpotify(np, key);
    return;
  }

  pauseSpotify();
  ui.spotify.hidden = true;
  if (otherKey === key) return;
  otherKey = key;
  const u = searchUrls(np.song.text);
  ui.other.replaceChildren(h('div', { class: 'np-links' },
    h('a', { href: u.youtubeWeb, target: '_blank', rel: 'noopener' }, 'Search YouTube ↗'),
    h('a', { href: u.spotify, target: '_blank', rel: 'noopener' }, 'Search Spotify ↗')));
  ui.note.textContent = 'This song was typed in by hand. Open it to listen along.';
}

// ---------- Spotify ----------

function spotifyUri(song) {
  return `spotify:${song.type}:${song.id}`;
}

function playSpotify(np, key) {
  loadSpotify(spotifyUri(np.song), key).then((ctrl) => {
    if (playingKey !== key) return;
    const auto = autoplay && !muted;
    spWantKey = auto ? key : null;
    if (spLoadedKey !== key) {
      spLoadedKey = key;
      spPlaying = false;
      // Playback starts on the 'ready' event that follows the load.
      ctrl.loadUri(spotifyUri(np.song), false, Math.floor(position(np)));
    } else if (auto) {
      startSpotify();
    }
    clearTimeout(checkTimer);
    if (!autoplay) { showTap('\u25B6 Play this song'); return; }
    checkTimer = setTimeout(() => {
      if (playingKey === key && !spPlaying && !muted) showTap('▶ Tap to play the music');
    }, 3500);
  }).catch(() => {
    ui.note.textContent = 'Couldn’t load the Spotify player. Check your connection.';
  });
}

/** Seek to where the host is and play. Safe to call repeatedly. */
function startSpotify() {
  if (!sp || !lastNp || lastNp.song.kind !== 'spotify') return;
  sp.play();
  // play() honours the load's start time; a seek keeps late joiners / resumes in sync too.
  const at = Math.floor(position(lastNp));
  if (at > 1) setTimeout(() => { if (sp) sp.seek(at); }, 400);
}

function pauseSpotify() {
  spWantKey = null;
  if (sp && spPlaying) sp.pause();
}

function loadSpotify(firstUri, firstKey) {
  if (spReady) return spReady;
  spLoadedKey = firstKey;
  spReady = new Promise((resolve, reject) => {
    const create = (IFrameAPI) => {
      IFrameAPI.createController(document.getElementById('ld-sp'), { uri: firstUri, width: '100%', height: 152 }, (ctrl) => {
        sp = ctrl;
        ctrl.addListener('ready', () => {
          if (spWantKey && spWantKey === playingKey) startSpotify();
        });
        ctrl.addListener('playback_update', (e) => {
          const d = (e && e.data) || {};
          spPlaying = !d.isPaused && !d.isBuffering;
          if (spPlaying) ui.tap.hidden = true;
        });
        resolve(ctrl);
      });
    };
    if (window.SpotifyIframeApi) { create(window.SpotifyIframeApi); return; }
    const prev = window.onSpotifyIframeApiReady;
    window.onSpotifyIframeApiReady = (api) => { window.SpotifyIframeApi = api; if (prev) prev(api); create(api); };
    const sc = document.createElement('script');
    sc.src = 'https://open.spotify.com/embed/iframe-api/v1';
    sc.async = true;
    sc.onerror = () => { spReady = null; spLoadedKey = null; reject(new Error('Spotify API failed to load')); };
    document.head.append(sc);
  });
  return spReady;
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
  if (!lastNp) return;
  if (lastNp.song.kind === 'spotify') { spWantKey = playingKey; startSpotify(); return; }
  if (!yt || lastNp.song.kind !== 'youtube') return;
  yt.seekTo(position(lastNp), true);
  if (!muted) yt.unMute();
  yt.playVideo();
}

function applyMute() {
  // The Spotify embed has no volume control: muting pauses it, unmuting jumps back in sync.
  if (lastNp && lastNp.song.kind === 'spotify' && playingKey) {
    if (muted) pauseSpotify(); else { spWantKey = playingKey; startSpotify(); }
  }
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
  pauseSpotify();
  if (ui) { ui.other.replaceChildren(); ui.tap.hidden = true; ui.spotify.hidden = true; }
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
