// Tiny synthesized sound effects (Web Audio, no files). Used on the host screen, and for
// honks on phones in everyone-remote games.
// Kept short and fairly quiet so they sit on top of the music instead of fighting it.

const STORE_KEY = 'goose.sfx';

class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.lastHonk = 0;
    try { this.enabled = localStorage.getItem(STORE_KEY) !== 'off'; } catch { this.enabled = true; }
    // Browsers only allow audio after a user gesture: unlock on the first one.
    const unlock = () => { this.ensure(); this.ctx?.resume?.(); };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.22;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  setEnabled(on) {
    this.enabled = on;
    try { localStorage.setItem(STORE_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
    if (on) this.chime();
  }

  ready() {
    if (!this.enabled) return null;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running') return null;
    return ctx;
  }

  tone(freq, start, dur, { type = 'sine', gain = 0.6, slideTo = null, attack = 0.01 } = {}) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /**
   * A goose honk: a breathy "h", then a nasal, raspy "ONK" whose pitch jumps up and sags.
   * Buzzy oscillators -> fast amplitude flutter (the rasp) -> soft clipping (grit) -> formant
   * filters (the nasal "aw"). Each honk is slightly different so a flurry doesn't sound robotic.
   */
  honk(times = 1) {
    const ctx = this.ready();
    if (!ctx) return;
    const now = performance.now();
    if (now - this.lastHonk < 250) return;
    this.lastHonk = now;
    let t = ctx.currentTime + 0.01;
    for (let i = 0; i < times; i++) {
      const vary = 0.92 + Math.random() * 0.16;
      const len = 0.22 + Math.random() * 0.08;
      this.honkOnce(t, vary, len);
      t += len + 0.09 + Math.random() * 0.05;
    }
  }

  honkOnce(t0, vary, len) {
    const ctx = this.ctx;
    const end = t0 + len;

    // Voice chain: grit -> highpass -> two nasal formants -> lowpass -> envelope.
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.gritCurve();
    shaper.oversample = '2x';
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 280;
    const f1 = ctx.createBiquadFilter();
    f1.type = 'peaking';
    f1.frequency.value = 1050 * vary;
    f1.Q.value = 2.6;
    f1.gain.value = 13;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'peaking';
    f2.frequency.value = 2500 * vary;
    f2.Q.value = 3.5;
    f2.gain.value = 9;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(0.55, t0 + 0.018);
    env.gain.setValueAtTime(0.55, t0 + 0.05);
    env.gain.exponentialRampToValueAtTime(0.42, end - 0.07);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    shaper.connect(hp).connect(f1).connect(f2).connect(lp).connect(env).connect(this.master);

    // The rasp: the voice flutters ~70 times a second.
    const flutter = ctx.createGain();
    flutter.gain.value = 0.65;
    const lfo = ctx.createOscillator();
    lfo.type = 'triangle';
    lfo.frequency.value = 62 + Math.random() * 18;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.35;
    lfo.connect(lfoDepth).connect(flutter.gain);
    flutter.connect(shaper);

    // The voice: buzzy, slightly detuned, pitch "hONK" — up fast, then a sag.
    const base = 390 * vary;
    const voices = [['sawtooth', -9, 0.55], ['sawtooth', 11, 0.55], ['square', 0, 0.3]];
    for (const [type, detune, level] of voices) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      o.frequency.setValueAtTime(base * 0.8, t0);
      o.frequency.exponentialRampToValueAtTime(base * 1.28, t0 + 0.045);
      o.frequency.exponentialRampToValueAtTime(base * 1.08, t0 + len * 0.6);
      o.frequency.exponentialRampToValueAtTime(base * 0.86, end);
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(flutter);
      o.start(t0);
      o.stop(end + 0.02);
    }
    lfo.start(t0);
    lfo.stop(end + 0.02);

    // The breathy "h" at the start.
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer();
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 1900;
    nf.Q.value = 0.9;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.exponentialRampToValueAtTime(0.35, t0 + 0.01);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
    noise.connect(nf).connect(ng).connect(this.master);
    noise.start(t0);
    noise.stop(t0 + 0.08);
  }

  noiseBuffer() {
    if (this.noise) return this.noise;
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.1), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    return buf;
  }

  gritCurve() {
    if (this.grit) return this.grit;
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(2.4 * x) / Math.tanh(2.4);
    }
    this.grit = curve;
    return curve;
  }

  /** Bright little arpeggio for reveals. */
  chime() {
    if (!this.ready()) return;
    [659.25, 830.61, 987.77, 1318.5].forEach((f, i) => this.tone(f, i * 0.07, 0.45, { type: 'triangle', gain: 0.35 }));
  }

  /** Royal fanfare for a crowning / the final scores. */
  fanfare() {
    if (!this.ready()) return;
    const notes = [[523.25, 0], [523.25, 0.12], [523.25, 0.24], [698.46, 0.36], [880, 0.6], [1046.5, 0.84]];
    notes.forEach(([f, t], i) => this.tone(f, t, i === notes.length - 1 ? 0.8 : 0.2, { type: 'square', gain: 0.18 }));
    this.tone(261.63, 0.84, 0.8, { type: 'triangle', gain: 0.3 });
  }

  /** Sneaky descending slide: the Secret Goose got away. */
  sneak() {
    if (!this.ready()) return;
    [783.99, 659.25, 554.37, 440].forEach((f, i) => this.tone(f, i * 0.11, 0.18, { type: 'triangle', gain: 0.3 }));
    this.tone(220, 0.48, 0.5, { type: 'sine', gain: 0.35, slideTo: 110 });
  }

  /** Quiet clock tick for the last seconds of a countdown. */
  tick(urgent = false) {
    if (!this.ready()) return;
    this.tone(urgent ? 1760 : 1320, 0, 0.05, { type: 'square', gain: 0.12, attack: 0.002 });
  }

  /** Soft "plip" when someone joins. */
  pop() {
    if (!this.ready()) return;
    this.tone(520, 0, 0.12, { type: 'sine', gain: 0.4, slideTo: 1040 });
  }
}

export const sfx = new Sfx();
