'use strict';
// A Goose Among Sirens — zero-dependency game server.
// Serves the host screen + phone controller, keeps rooms in memory,
// and pushes live state to every screen over Server-Sent Events.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Room, GameError } = require('./src/game');
const { enrichSong, parseSong } = require('./src/media');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024; // prompt-pack imports can be a few dozen KB
// Rooms are saved to disk so a restart (or crash) doesn't end everyone's game. PERSIST=0 turns it off.
const PERSIST = process.env.PERSIST !== '0';
const DATA_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'rooms.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const ROUTES = { '/': '/play.html', '/play': '/play.html', '/join': '/play.html', '/host': '/host.html' };

/** code -> { room, hostToken, playerTokens: Map<id, token>, streams: Set, touched } */
const sessions = new Map();

const newToken = () => crypto.randomBytes(16).toString('hex');
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels: no accidental words
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!sessions.has(c)) return c;
  }
}

function createSession() {
  return registerSession(new Room(newCode()), newToken(), new Map(), Date.now());
}

function registerSession(room, hostToken, playerTokens, touched) {
  const s = { room, hostToken, playerTokens, streams: new Set(), touched };
  room.onChange = () => { broadcast(s); scheduleSave(); };
  // Reactions are fire-and-forget: only the host screen needs them.
  room.onEvent = (type, data) => {
    for (const st of s.streams) if (st.role === 'host') sendEvent(st, type, data);
  };
  sessions.set(room.code, s);
  scheduleSave();
  return s;
}

// ---------- persistence ----------

let saveTimer = null;
function scheduleSave() {
  if (!PERSIST) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

function saveNow() {
  if (!PERSIST) return;
  clearTimeout(saveTimer);
  try {
    const data = [...sessions.values()].map((s) => ({
      room: s.room.toJSON(), hostToken: s.hostToken, playerTokens: [...s.playerTokens], touched: s.touched,
    }));
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, DATA_FILE); // atomic: never leave a half-written file
  } catch (err) {
    console.warn('Could not save rooms:', err.message);
  }
}

function loadSaved() {
  if (!PERSIST) return 0;
  let list;
  try {
    list = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Ignoring unreadable saved rooms:', err.message);
    return 0;
  }
  let n = 0;
  for (const item of Array.isArray(list) ? list : []) {
    try {
      if (!item || Date.now() - item.touched > ROOM_TTL_MS || sessions.has(item.room.code)) continue;
      registerSession(Room.fromJSON(item.room), item.hostToken, new Map(item.playerTokens), item.touched);
      n++;
    } catch (err) {
      console.warn('Skipping a saved room:', err.message);
    }
  }
  return n;
}

function getSession(code) {
  const s = sessions.get(String(code || '').trim().toUpperCase());
  if (!s) throw new GameError('No room with that code', 404);
  s.touched = Date.now();
  return s;
}

function sendEvent(stream, event, data) {
  stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(s) {
  s.touched = Date.now();
  for (const st of s.streams) sendEvent(st, 'state', s.room.view(st.role === 'host' ? null : st.playerId));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new GameError('Request too large', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(body && typeof body === 'object' ? body : {});
      } catch {
        reject(new GameError('Bad JSON'));
      }
    });
    req.on('error', reject);
  });
}

function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) urls.push(`http://${i.address}:${PORT}`);
    }
  }
  return urls;
}

// ---------- API ----------

function handleEvents(req, res, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const code = url.searchParams.get('code');
  const role = url.searchParams.get('role') === 'host' ? 'host' : 'player';
  const token = url.searchParams.get('token');
  const playerId = url.searchParams.get('id');
  const s = sessions.get(String(code || '').toUpperCase());
  const fatal = (error) => { sendEvent({ res }, 'fatal', { error }); res.end(); };

  if (!s) return fatal('That room has closed');
  if (role === 'host' && token !== s.hostToken) return fatal('Not the host of this room');
  const member = playerId && (s.room.getPlayer(playerId) || s.room.getAudience(playerId));
  if (role === 'player' && (!playerId || s.playerTokens.get(playerId) !== token || !member)) {
    return fatal('You are no longer in this room');
  }

  const stream = { res, role, playerId: role === 'player' ? playerId : null };
  s.streams.add(stream);
  sendEvent(stream, 'state', s.room.view(stream.playerId));
  if (role === 'player') s.room.setConnected(playerId, true);

  req.on('close', () => {
    s.streams.delete(stream);
    if (role === 'player' && ![...s.streams].some((st) => st.playerId === playerId)) {
      s.room.setConnected(playerId, false);
    }
  });
}

function handleCreate() {
  const s = createSession();
  return { code: s.room.code, token: s.hostToken };
}

function handleJoin(body) {
  const s = getSession(body.code);
  const { playerId, token } = body;
  const existing = playerId && (s.room.getPlayer(playerId) || s.room.getAudience(playerId));
  if (existing && token && s.playerTokens.get(playerId) === token) {
    return { code: s.room.code, playerId, token, name: existing.name, audience: Boolean(s.room.getAudience(playerId)) };
  }
  const id = crypto.randomBytes(6).toString('hex');
  const { player, audience } = s.room.join(id, body.name, body.hat);
  const tok = newToken();
  s.playerTokens.set(id, tok);
  scheduleSave();
  return { code: s.room.code, playerId: id, token: tok, name: player.name, audience };
}

// Link preview for the phone: what song is this? (Cached; oEmbed lookups are slow-ish.)
const previewCache = new Map();
async function handleResolve(body) {
  let song;
  try {
    song = parseSong(body.song);
  } catch (err) {
    if (err instanceof GameError) return { ok: false, error: err.message };
    throw err;
  }
  if (song.kind === 'text') return { ok: true, kind: 'text', display: song.display };
  const key = song.url;
  if (!previewCache.has(key)) {
    await enrichSong(song, { timeoutMs: 3000 });
    if (previewCache.size > 500) previewCache.delete(previewCache.keys().next().value);
    previewCache.set(key, { ok: true, kind: song.kind, display: song.title ? song.display : null, title: song.title, artist: song.artist });
  }
  return previewCache.get(key);
}

const HOST_ACTIONS = {
  setMode: (room, b) => room.setMode(b.mode),
  setSettings: (room, b) => room.setSettings(b.settings || {}),
  start: (room) => room.start(),
  next: (room) => room.next(),
  play: (room, b) => room.play(b.entryId),
  lobby: (room) => room.backToLobby(),
  extend: (room) => room.extendTimer(30),
  addPrompt: (room, b) => { const c = room.addPrompt(b.mode, b.text); return { id: c.id }; },
  removePrompt: (room, b) => room.removePrompt(b.id),
  addPack: (room, b) => ({ added: room.addPack(b.key) }),
  importPack: (room, b) => ({ added: room.importPack(b.pack) }),
  kick: (room, b, s) => {
    room.removePlayer(b.playerId);
    disconnectPlayer(s, b.playerId, 'The host removed you from the room');
  },
};

function disconnectPlayer(s, playerId, message) {
  s.playerTokens.delete(playerId);
  for (const st of [...s.streams]) {
    if (st.playerId === playerId) {
      sendEvent(st, 'fatal', { error: message, left: true });
      st.res.end();
      s.streams.delete(st);
    }
  }
}

const PLAYER_ACTIONS = {
  setHat: (room, b, s, pid) => room.setHat(pid, b.hat),
  leave: (room, b, s, pid) => { room.leave(pid); disconnectPlayer(s, pid, 'You left the room'); },
  submit: (room, b, s, pid) => {
    const song = room.submit(pid, b.slot, b.song);
    // Look up the real track title in the background, then refresh screens.
    enrichSong(song).then((changed) => { if (changed) room.touch(); });
    return { display: song.display };
  },
  guess: (room, b, s, pid) => room.guess(pid, b.target),
  judge: (room, b, s, pid) => room.judge(pid, b.entryId),
  vote: (room, b, s, pid) => room.vote(pid, b.target),
  favorite: (room, b, s, pid) => room.favorite(pid, b.entryId),
  react: (room, b, s, pid) => ({ ok: room.react(pid, b.kind) }),
  suggest: (room, b, s, pid) => { room.addPrompt(room.mode, b.text, pid); },
};

function handleAction(body) {
  const s = getSession(body.code);
  const type = String(body.type || '');
  if (body.token && body.token === s.hostToken) {
    const fn = Object.prototype.hasOwnProperty.call(HOST_ACTIONS, type) && HOST_ACTIONS[type];
    if (!fn) throw new GameError('Unknown host action');
    return fn(s.room, body, s) || { ok: true };
  }
  const pid = body.playerId;
  if (!pid || s.playerTokens.get(pid) !== body.token) throw new GameError('Not allowed', 403);
  const fn = Object.prototype.hasOwnProperty.call(PLAYER_ACTIONS, type) && PLAYER_ACTIONS[type];
  if (!fn) throw new GameError('Unknown action');
  return fn(s.room, body, s, pid) || { ok: true };
}

// ---------- static files ----------

function serveStatic(req, res, pathname) {
  let rel = ROUTES[pathname] || pathname;
  try { rel = decodeURIComponent(rel); } catch { return json(res, 400, { error: 'Bad path' }); }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'Not found' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/info') return json(res, 200, { urls: lanUrls(), port: PORT });
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await readJson(req);
      if (url.pathname === '/api/create') return json(res, 200, handleCreate());
      if (url.pathname === '/api/join') return json(res, 200, handleJoin(body));
      if (url.pathname === '/api/resolve') return json(res, 200, await handleResolve(body));
      if (url.pathname === '/api/action') return json(res, 200, handleAction(body));
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    return json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (err instanceof GameError) return json(res, err.status || 400, { error: err.message });
    console.error(err);
    return json(res, 500, { error: 'Something went wrong' });
  }
});

// Keep SSE connections alive through proxies / sleepy Wi-Fi, and clean up stale rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, s] of sessions) {
    // A real event (not an SSE comment) so clients can detect a silently dead connection.
    for (const st of s.streams) sendEvent(st, 'ping', { t: now });
    if (!s.streams.size && now - s.touched > ROOM_TTL_MS) { s.room.dispose(); sessions.delete(code); scheduleSave(); }
  }
}, 20000).unref();

if (require.main === module) {
  const restored = loadSaved();
  // Save on the way out (Ctrl+C, docker stop, etc.) so nothing in the last 400ms is lost.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveNow(); process.exit(0); });
  server.listen(PORT, HOST, () => {
    if (restored) console.log(`\n  Restored ${restored} room${restored === 1 ? '' : 's'} from ${path.relative(process.cwd(), DATA_FILE)}`);
    const urls = lanUrls();
    console.log('\n  \u{1FABF}  A Goose Among Sirens is honking!\n');
    console.log(`  Host screen (TV / laptop):  http://localhost:${PORT}/host`);
    for (const u of urls) console.log(`  Players join on phones:    ${u}`);
    if (!urls.length) console.log(`  Players join on phones:    http://<this-computer's-ip>:${PORT}`);
    console.log('');
  });
}

module.exports = { server, sessions };
