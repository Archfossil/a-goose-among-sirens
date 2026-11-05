'use strict';
// Turns whatever a player typed into a playable song reference.
// Supported: YouTube / YouTube Music links, Spotify links or URIs, or plain "Song – Artist" text.

const { GameError } = require('./errors');

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_TYPES = new Set(['track', 'album', 'playlist', 'episode']);
const BARE_URL = /^(www\.|m\.)?(youtube\.com|youtu\.be|music\.youtube\.com|open\.spotify\.com)\//i;

function parseTime(t) {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = String(t).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

function youtube(id, start) {
  return { kind: 'youtube', id, start: start || 0, url: `https://www.youtube.com/watch?v=${id}`, title: null, artist: null, display: 'YouTube track' };
}

function spotify(type, id) {
  return { kind: 'spotify', type, id, start: 0, url: `https://open.spotify.com/${type}/${id}`, title: null, artist: null, display: `Spotify ${type}` };
}

function parseSong(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new GameError('Paste a link or type a song name');
  if (raw.length > 300) throw new GameError('That is a very long song name');

  const uri = raw.match(/^spotify:(track|album|playlist|episode):([A-Za-z0-9]{22})$/);
  if (uri) return spotify(uri[1], uri[2]);

  const looksLikeUrl = /^https?:\/\//i.test(raw) || BARE_URL.test(raw);
  if (looksLikeUrl) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      throw new GameError("That link doesn't look right");
    }
    const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');

    if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
      let id = url.searchParams.get('v');
      if (!id) {
        const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
        if (m) id = m[1];
      }
      if (id && YT_ID.test(id)) return youtube(id, parseTime(url.searchParams.get('t') || url.searchParams.get('start')));
      throw new GameError("Couldn't find a video in that YouTube link");
    }
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      if (YT_ID.test(id)) return youtube(id, parseTime(url.searchParams.get('t')));
      throw new GameError("Couldn't find a video in that YouTube link");
    }
    if (host === 'open.spotify.com') {
      const m = url.pathname.match(/^\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode)\/([A-Za-z0-9]+)/i);
      if (m && SPOTIFY_TYPES.has(m[1].toLowerCase()) && SPOTIFY_ID.test(m[2])) return spotify(m[1].toLowerCase(), m[2]);
      throw new GameError("Couldn't find a track in that Spotify link");
    }
    throw new GameError('Only YouTube or Spotify links work — or just type the song name');
  }

  const text = raw.replace(/\s+/g, ' ').slice(0, 120);
  return { kind: 'text', text, start: 0, url: null, title: text, artist: null, display: text };
}

/** Best-effort title lookup through public oEmbed endpoints. Mutates the song; resolves true if it changed. */
async function enrichSong(song, { timeoutMs = 4000, fetchImpl = globalThis.fetch } = {}) {
  if (!song || song.kind === 'text' || song.title || typeof fetchImpl !== 'function') return false;
  const endpoint = song.kind === 'youtube'
    ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(song.url)}`
    : `https://open.spotify.com/oembed?url=${encodeURIComponent(song.url)}`;
  try {
    const res = await fetchImpl(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const data = await res.json();
    if (!data || typeof data.title !== 'string' || !data.title.trim()) return false;
    song.title = data.title.trim().slice(0, 140);
    song.artist = typeof data.author_name === 'string' ? data.author_name.trim().slice(0, 80) : null;
    song.display = song.kind === 'youtube' || !song.artist ? song.title : `${song.title} — ${song.artist}`;
    return true;
  } catch {
    return false;
  }
}

module.exports = { parseSong, enrichSong, parseTime };
