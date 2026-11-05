// WebGL backdrop for the host screen: a sea at dusk, two sirens singing from their
// rocks, and a very unbothered goose bobbing on the waves. Raw WebGL, no libraries.
//   - Background: one full-screen fragment shader (2D signed-distance shapes).
//   - Particles: gl.POINTS for feathers (bursts on reveals) and music notes (while songs play).

const QUAD_VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const SCENE_FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uTop;
uniform vec3 uBot;
uniform vec3 uSea;
uniform vec3 uAccent;
uniform float uSing;
uniform float uStars;
uniform float uHonk;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(float x) { float i = floor(x); float f = fract(x); return mix(hash(vec2(i, 1.7)), hash(vec2(i + 1.0, 1.7)), f * f * (3.0 - 2.0 * f)); }
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a; vec2 ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float sdEll(vec2 p, vec2 r) { return (length(p / r) - 1.0) * min(r.x, r.y); }
float fillA(float d, float aa) { return 1.0 - smoothstep(-aa, aa, d); }

float wave(float x, float i) {
  return 0.010 * sin(x * 8.0 + uTime * (0.8 + 0.25 * i) + i * 1.7)
       + 0.006 * sin(x * 15.0 - uTime * (1.2 + 0.2 * i) + i * 3.1)
       + 0.003 * sin(x * 29.0 + uTime * 2.0 + i * 5.0);
}
float layerY(float x, float i, float horizon) { return horizon - i * 0.055 - i * i * 0.018 + wave(x, i) * (1.0 + i * 0.8); }

float siren(vec2 p, float t) {
  float d = sdEll(p - vec2(0.0, 0.06), vec2(0.02, 0.048));                 // torso
  d = min(d, length(p - vec2(0.006, 0.125)) - 0.019);                      // head
  d = min(d, sdSeg(p, vec2(0.0, 0.03), vec2(0.055, 0.0)) - 0.019);         // tail
  d = min(d, sdSeg(p, vec2(0.055, 0.0), vec2(0.1, 0.02)) - 0.010);
  d = min(d, sdEll(p - vec2(0.112, 0.032), vec2(0.02, 0.008)));            // fin
  for (int i = 0; i < 3; i++) {                                             // hair in the wind
    float fi = float(i);
    vec2 a = vec2(-0.004, 0.138 - fi * 0.008);
    vec2 b = vec2(-0.05 - 0.008 * fi, 0.085 - fi * 0.014 + 0.01 * sin(t * 1.7 + fi * 1.3));
    d = min(d, sdSeg(p, a, b) - 0.0055);
  }
  d = min(d, sdSeg(p, vec2(0.012, 0.09), vec2(0.045, 0.125 + 0.012 * sin(t * 1.3))) - 0.0055); // arm, mid-serenade
  return d;
}

float goose(vec2 p, out float beak, out float wing, out float eye) {
  float d = sdEll(p, vec2(0.075, 0.036));                                  // body
  d = min(d, sdEll(p - vec2(-0.062, 0.016), vec2(0.026, 0.014)));          // tail
  d = min(d, sdSeg(p, vec2(0.048, 0.008), vec2(0.066, 0.09)) - 0.011);     // neck
  d = min(d, length(p - vec2(0.072, 0.098)) - 0.019);                      // head
  beak = sdSeg(p, vec2(0.086, 0.097), vec2(0.116, 0.09)) - 0.0065;
  wing = abs(sdEll(p - vec2(-0.008, 0.008), vec2(0.048, 0.019))) - 0.0018;
  eye = length(p - vec2(0.078, 0.104)) - 0.0042;
  return d;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float asp = uRes.x / uRes.y;
  float aa = 1.5 / uRes.y;
  float horizon = -0.08;
  float t = uTime;

  // sky + stars
  vec3 col = mix(uBot, uTop, smoothstep(horizon, 0.5, p.y));
  vec2 cell = floor(p * 160.0);
  float h = hash(cell);
  vec2 cp = fract(p * 160.0) - 0.5;
  float star = step(0.993, h) * (1.0 - smoothstep(0.05, 0.35, length(cp)))
             * (0.55 + 0.45 * sin(t * 2.3 + h * 60.0)) * smoothstep(0.0, 0.3, p.y - horizon);
  col += vec3(star) * uStars;

  // sun / moon with retro cut lines
  vec2 sunP = vec2(0.0, 0.1);
  float sd = length(p - sunP);
  col += uAccent * 0.45 * exp(-sd * 5.0) * (1.0 + 0.5 * uSing);
  vec3 sunCol = mix(uAccent, vec3(1.0, 0.98, 0.92), 0.5);
  float stripes = step(0.35, fract((p.y - sunP.y) * 26.0 + t * 0.12));
  float cut = p.y < sunP.y ? mix(1.0, stripes, smoothstep(sunP.y, sunP.y - 0.13, p.y)) : 1.0;
  col = mix(col, sunCol, fillA(sd - 0.13, aa) * cut);

  // rocks, sirens, and their song
  for (int k = 0; k < 2; k++) {
    float s = k == 0 ? -1.0 : 1.0;
    float cx = s * 0.36 * asp;
    float rx = (p.x - cx) / 0.17;
    float hgt = 0.1 * (1.0 - rx * rx) + 0.012 * vnoise(p.x * 45.0 + s * 9.0) + 0.006 * vnoise(p.x * 120.0);
    float rockMask = step(abs(rx), 1.0) * fillA(p.y - (horizon + hgt), aa);
    vec3 rockCol = mix(uTop * 0.35, uBot * 0.3, 0.4) + 0.02;
    col = mix(col, rockCol, rockMask);

    vec2 base = vec2(cx - s * 0.03, horizon + 0.085);
    vec2 q = p - base;
    q.x *= -s;                       // face the middle of the bay
    float sdS = siren(q, t + s);
    col = mix(col, rockCol * 0.55, fillA(sdS, aa));
    col += uAccent * 0.35 * fillA(abs(sdS) - 0.0012, aa);

    vec2 head = base + vec2(-s * 0.006, 0.125);
    vec2 rp = p - head;
    float r = length(rp);
    float toward = smoothstep(0.0, 0.6, dot(rp / max(r, 1e-4), normalize(vec2(-s, 0.25))));
    float rings = pow(0.5 + 0.5 * sin(r * 70.0 - t * 7.0), 10.0) * smoothstep(0.45, 0.03, r) * toward;
    col += uAccent * rings * uSing * 0.9;
  }

  // back wave layer + sun glitter
  float y0 = layerY(p.x, 0.0, horizon);
  vec3 seaTop = mix(uSea, uBot, 0.35);
  if (p.y < y0) {
    col = seaTop;
    float glit = smoothstep(0.16, 0.0, abs(p.x - sunP.x) - (horizon - p.y) * 0.25);
    float sparkle = pow(0.5 + 0.5 * sin(p.y * 260.0 + sin(p.x * 55.0 + t * 1.5) * 3.0 + t * 2.0), 12.0);
    col += uAccent * glit * sparkle * 0.7;
  }
  col = mix(col, mix(seaTop, vec3(1.0), 0.5), fillA(abs(p.y - y0) - 0.0012, aa) * 0.5);

  // the goose, drifting between the rocks, riding the second wave
  float gs = 1.6;
  float gx = sin(t * 0.11) * 0.22 * asp;
  float dir = cos(t * 0.11) >= 0.0 ? 1.0 : -1.0;
  float gy = layerY(gx, 1.0, horizon) + 0.018 + 0.05 * uHonk;
  float slope = (layerY(gx + 0.01, 1.0, horizon) - layerY(gx - 0.01, 1.0, horizon)) / 0.02;
  float ang = atan(slope) * 0.8;
  float ca = cos(ang);
  float sa = sin(ang);
  vec2 gp = p - vec2(gx, gy);
  gp = vec2(ca * gp.x + sa * gp.y, -sa * gp.x + ca * gp.y);
  gp.x *= dir;
  gp /= gs;
  float beak; float wing; float eye;
  float gd = goose(gp, beak, wing, eye);
  float ga = aa / gs;
  vec3 ink = vec3(0.12, 0.08, 0.16);
  col = mix(col, ink, fillA(gd - 0.005, ga));
  col = mix(col, vec3(0.97, 0.96, 0.93), fillA(gd, ga));
  col = mix(col, vec3(0.76, 0.76, 0.80), fillA(wing, ga));
  col = mix(col, vec3(0.98, 0.6, 0.15), fillA(beak, ga));
  col = mix(col, ink, fillA(eye, ga));

  // front wave layers (cover the goose's paddling feet)
  for (int i = 1; i < 4; i++) {
    float fi = float(i);
    float yi = layerY(p.x, fi, horizon);
    vec3 lc = mix(uSea, uSea * 0.35, fi / 3.0) + uAccent * 0.05 * (1.0 - fi / 3.0);
    if (p.y < yi) col = lc;
    col = mix(col, mix(lc, vec3(1.0), 0.6), fillA(abs(p.y - yi) - 0.0015, aa) * 0.45);
  }

  vec2 uv = gl_FragCoord.xy / uRes;
  col *= 0.72 + 0.28 * pow(16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y), 0.25);
  gl_FragColor = vec4(col, 1.0);
}
`;

const POINT_VERT = `
attribute vec2 aPos;
attribute float aSize;
attribute vec4 aColor;
attribute float aKind;
uniform vec2 uView;
uniform float uScale;
varying vec4 vColor;
varying float vKind;
void main() {
  vec2 c = aPos / uView * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  gl_PointSize = aSize * uScale;
  vColor = aColor;
  vKind = aKind;
}
`;

const POINT_FRAG = `
precision mediump float;
uniform sampler2D uAtlas;
uniform float uAtlasN;
varying vec4 vColor;
varying float vKind;
void main() {
  if (vKind > 1.5) {
    // reaction sprite from the emoji atlas
    float idx = floor(vKind - 2.0 + 0.5);
    vec4 t = texture2D(uAtlas, vec2((gl_PointCoord.x + idx) / uAtlasN, gl_PointCoord.y));
    gl_FragColor = vec4(t.rgb, t.a * vColor.a);
    return;
  }
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float a;
  if (vKind < 0.5) {
    // feather: soft ellipse with a quill line
    a = 1.0 - smoothstep(0.6, 1.0, length(c * vec2(2.2, 1.0)));
    a *= 0.75 + 0.25 * step(0.06, abs(c.x));
  } else {
    // eighth note
    float head = 1.0 - smoothstep(0.30, 0.40, length((c - vec2(-0.15, 0.45)) * vec2(1.0, 1.35)));
    float stem = step(abs(c.x - 0.17), 0.07) * step(-0.85, c.y) * step(c.y, 0.45);
    float flag = step(0.17, c.x) * step(c.x, 0.6) * step(-0.85, c.y) * step(c.y, -0.55 + c.x * 0.3);
    a = max(head, max(stem, flag));
  }
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}
`;

const MOODS = {
  lobby:    { top: '#2b1b4a', bot: '#f28f6b', sea: '#1d3557', accent: '#ffd6a5', stars: 0.45 },
  loose:    { top: '#1a2a6c', bot: '#fd8d3c', sea: '#16425b', accent: '#ffb347', stars: 0.25 },
  king:     { top: '#2d0b45', bot: '#c9a227', sea: '#241e4e', accent: '#ffd700', stars: 0.35 },
  secret:   { top: '#020812', bot: '#12395a', sea: '#061a2b', accent: '#9ad1ff', stars: 1.0 },
  gameover: { top: '#3a0ca3', bot: '#f72585', sea: '#240046', accent: '#ffd166', stars: 0.6 },
};

const FEATHER_SETS = {
  reveal: ['#ffffff', '#ffd166', '#ffadad', '#a0c4ff'],
  crown: ['#ffd700', '#fff1a8', '#ffffff', '#c9a227'],
  caught: ['#06d6a0', '#ffffff', '#caffbf', '#4cc9f0'],
  escaped: ['#ff6b6b', '#ffffff', '#f72585', '#ffd166'],
  gameover: ['#ffd166', '#f72585', '#4cc9f0', '#06d6a0', '#ffffff', '#b388ff'],
};

const MAX_PARTICLES = 700;

// Reaction sprites, baked into one texture atlas (index = order here).
export const REACTION_KINDS = ['fire', 'laugh', 'cry', 'mindblown', 'skull', 'heart', 'honk'];
const REACTION_GLYPHS = ['\u{1F525}', '\u{1F602}', '\u{1F62D}', '\u{1F92F}', '\u{1F480}', '\u2764\uFE0F', null];
const CELL = 128;

function buildAtlas() {
  const c = document.createElement('canvas');
  c.width = CELL * REACTION_KINDS.length;
  c.height = CELL;
  const ctx = c.getContext('2d');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  REACTION_KINDS.forEach((kind, i) => {
    const x = i * CELL + CELL / 2;
    const glyph = REACTION_GLYPHS[i];
    if (glyph) {
      ctx.font = '96px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      ctx.fillText(glyph, x, CELL / 2 + 6);
    } else {
      // HONK! as chunky text (no emoji needed)
      ctx.save();
      ctx.translate(x, CELL / 2);
      ctx.rotate(-0.18);
      ctx.font = '900 36px Fredoka, "Arial Black", sans-serif';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 9;
      ctx.strokeStyle = '#2a1640';
      ctx.strokeText('HONK!', 0, 0);
      ctx.fillStyle = '#ffd166';
      ctx.fillText('HONK!', 0, 0);
      ctx.restore();
    }
  });
  return c;
}
const FLOATS_PER = 8; // x, y, size, r, g, b, a, kind

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function moodToVec(m) {
  return { top: hexToRgb(m.top), bot: hexToRgb(m.bot), sea: hexToRgb(m.sea), accent: hexToRgb(m.accent), stars: m.stars };
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
  return sh;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
  return p;
}

export class Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.particles = [];
    this.sing = 0;
    this.singTarget = 0;
    this.noteAcc = 0;
    this.noteSide = 1;
    this.scale = 1;
    this.slowFrames = 0;
    this.current = moodToVec(MOODS.lobby);
    this.target = moodToVec(MOODS.lobby);
    this.moodName = 'lobby';

    let gl = null;
    try {
      gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });
    } catch { gl = null; }
    if (!gl) { document.body.classList.add('no-webgl'); return; }

    try {
      this.gl = gl;
      this.bg = program(gl, QUAD_VERT, SCENE_FRAG);
      this.pt = program(gl, POINT_VERT, POINT_FRAG);
    } catch (err) {
      console.error('WebGL setup failed:', err);
      document.body.classList.add('no-webgl');
      return;
    }

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.ptBuf = gl.createBuffer();
    this.ptData = new Float32Array(MAX_PARTICLES * FLOATS_PER);

    const U = (prog, names) => Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(prog, n)]));
    this.bgU = U(this.bg, ['uRes', 'uTime', 'uTop', 'uBot', 'uSea', 'uAccent', 'uSing', 'uStars']);
    this.bgA = gl.getAttribLocation(this.bg, 'aPos');
    this.ptU = U(this.pt, ['uView', 'uScale', 'uAtlas', 'uAtlasN']);
    this.bgU.uHonk = gl.getUniformLocation(this.bg, 'uHonk');
    this.honk = 0;
    this.atlas = gl.createTexture();
    this.uploadAtlas();
    // Fonts load late; re-bake once they're ready so HONK! uses the game font.
    document.fonts?.ready.then(() => this.uploadAtlas());
    this.ptA = ['aPos', 'aSize', 'aColor', 'aKind'].map((n) => gl.getAttribLocation(this.pt, n));

    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ok = false; });
    canvas.addEventListener('webglcontextrestored', () => window.location.reload());
    window.addEventListener('resize', () => this.resize());

    this.ok = true;
    this.t0 = performance.now();
    this.last = this.t0;
    this.resize();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  uploadAtlas() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, buildAtlas());
    // Non-power-of-two texture: WebGL 1 needs clamp + no mipmaps.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  /** A player's reaction floats up from the bottom of the screen. */
  react(kind) {
    if (!this.ok) return;
    const idx = REACTION_KINDS.indexOf(kind);
    if (idx < 0) return;
    if (kind === 'honk') this.honk = 1;
    this.spawn({
      x: this.w * (0.15 + Math.random() * 0.6),
      y: this.h + 40,
      vx: (Math.random() - 0.5) * 60,
      vy: -260 - Math.random() * 120,
      size: kind === 'honk' ? 110 : 64 + Math.random() * 18,
      color: [1, 1, 1],
      kind: 2 + idx,
      max: 3.2,
      sway: Math.random() * 6.28,
      gravity: 30,
    });
  }

  resize() {
    if (!this.gl) return;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.pxRatio = Math.min(window.devicePixelRatio || 1, 1.5) * this.scale;
    this.canvas.width = Math.max(1, Math.round(this.w * this.pxRatio));
    this.canvas.height = Math.max(1, Math.round(this.h * this.pxRatio));
  }

  /** Change sky / sea palette: 'lobby' | 'loose' | 'king' | 'secret' | 'gameover'. */
  setMood(name) {
    if (name === this.moodName || !MOODS[name]) return;
    this.moodName = name;
    this.target = moodToVec(MOODS[name]);
  }

  /** Sirens sing (rings + floating notes) while a song is playing. */
  setSinging(on) { this.singTarget = on ? 1 : 0; }

  /** Feather explosion for reveals, crownings, catches and the finale. */
  burst(kind = 'reveal') {
    const colors = FEATHER_SETS[kind] || FEATHER_SETS.reveal;
    const n = kind === 'gameover' ? 260 : 150;
    for (let i = 0; i < n; i++) {
      const c = hexToRgb(colors[i % colors.length]);
      this.spawn({
        x: this.w * (0.5 + (Math.random() - 0.5) * 0.25),
        y: this.h * 0.38,
        vx: (Math.random() - 0.5) * 900,
        vy: -200 - Math.random() * 650,
        size: 10 + Math.random() * 16,
        color: c,
        kind: Math.random() < 0.25 ? 1 : 0,
        max: 2.6 + Math.random() * 1.8,
        sway: Math.random() * 6.28,
        gravity: 520,
      });
    }
  }

  spawn(p) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    p.life = 0;
    this.particles.push(p);
  }

  // Screen position (CSS px) of a siren's head; mirrors the shader's layout math.
  sirenHead(side) {
    const asp = this.w / this.h;
    const px = side * 0.36 * asp - side * 0.03 - side * 0.006;
    const py = -0.08 + 0.085 + 0.125;
    return { x: this.w / 2 + px * this.h, y: this.h / 2 - py * this.h };
  }

  update(dt) {
    const k = 1 - Math.exp(-dt * 1.2);
    for (const key of ['top', 'bot', 'sea', 'accent']) {
      for (let i = 0; i < 3; i++) this.current[key][i] += (this.target[key][i] - this.current[key][i]) * k;
    }
    this.current.stars += (this.target.stars - this.current.stars) * k;
    this.sing += (this.singTarget - this.sing) * (1 - Math.exp(-dt * 2));
    this.honk = Math.max(0, this.honk - dt * 2.5);

    if (this.sing > 0.3) {
      this.noteAcc += dt * 2.2 * this.sing;
      while (this.noteAcc >= 1) {
        this.noteAcc -= 1;
        this.noteSide *= -1;
        const head = this.sirenHead(this.noteSide);
        const acc = this.current.accent;
        this.spawn({
          x: head.x, y: head.y,
          vx: -this.noteSide * (40 + Math.random() * 60), vy: -30 - Math.random() * 40,
          size: 20 + Math.random() * 12,
          color: [acc[0] * 0.5 + 0.5, acc[1] * 0.5 + 0.5, acc[2] * 0.5 + 0.5],
          kind: 1, max: 3.5, sway: Math.random() * 6.28, gravity: -8,
        });
      }
    }

    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life += dt;
      if (p.life >= p.max) { ps.splice(i, 1); continue; }
      p.vy += p.gravity * dt;
      if (p.kind === 0) {           // feathers flutter: heavy drag, capped fall speed
        p.vx *= 1 - Math.min(1, 1.6 * dt);
        if (p.vy > 120) p.vy = 120;
      }
      p.x += (p.vx + Math.sin(p.life * 4 + p.sway) * 40) * dt;
      p.y += p.vy * dt;
    }
  }

  frame(now) {
    requestAnimationFrame(this.frame);
    if (!this.ok) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;

    // Adaptive resolution: if we're dropping frames, render the shader at a lower scale.
    if (dt > 0.024) this.slowFrames++; else this.slowFrames = Math.max(0, this.slowFrames - 1);
    if (this.slowFrames > 45 && this.scale > 0.5) { this.scale = Math.max(0.5, this.scale * 0.8); this.slowFrames = 0; this.resize(); }

    this.update(dt);
    const gl = this.gl;
    const c = this.current;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    gl.disable(gl.BLEND);
    gl.useProgram(this.bg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.bgA);
    gl.vertexAttribPointer(this.bgA, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.bgU.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.bgU.uTime, (now - this.t0) / 1000);
    gl.uniform3fv(this.bgU.uTop, c.top);
    gl.uniform3fv(this.bgU.uBot, c.bot);
    gl.uniform3fv(this.bgU.uSea, c.sea);
    gl.uniform3fv(this.bgU.uAccent, c.accent);
    gl.uniform1f(this.bgU.uSing, this.sing);
    gl.uniform1f(this.bgU.uStars, c.stars);
    gl.uniform1f(this.bgU.uHonk, Math.sin(Math.min(1, this.honk) * Math.PI));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(this.bgA);

    const n = this.particles.length;
    if (!n) return;
    const d = this.ptData;
    for (let i = 0; i < n; i++) {
      const p = this.particles[i];
      const o = i * FLOATS_PER;
      const fade = 1 - Math.pow(p.life / p.max, 2);
      d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.size;
      d[o + 3] = p.color[0]; d[o + 4] = p.color[1]; d[o + 5] = p.color[2]; d[o + 6] = fade;
      d[o + 7] = p.kind;
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.pt);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptBuf);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, n * FLOATS_PER), gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER * 4;
    const [aPos, aSize, aColor, aKind] = this.ptA;
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(aSize); gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(aColor); gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(aKind); gl.vertexAttribPointer(aKind, 1, gl.FLOAT, false, stride, 28);
    gl.uniform2f(this.ptU.uView, this.w, this.h);
    gl.uniform1f(this.ptU.uScale, this.pxRatio);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.uniform1i(this.ptU.uAtlas, 0);
    gl.uniform1f(this.ptU.uAtlasN, REACTION_KINDS.length);
    gl.drawArrays(gl.POINTS, 0, n);
    for (const a of this.ptA) gl.disableVertexAttribArray(a);
  }
}
