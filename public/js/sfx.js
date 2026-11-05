// Tiny synthesized sound effects for the host screen (Web Audio, no files).
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

  /** A (very) goose-like honk: buzzy detuned saws, falling pitch, nasal band-pass. */
  honk(times = 1) {
    const ctx = this.ready();
    if (!ctx) return;
    const now = performance.now();
    if (now - this.lastHonk < 250) return;
    this.lastHonk = now;
    for (let i = 0; i < times; i++) {
      const t0 = ctx.currentTime + i * 0.22;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1100;
      bp.Q.value = 2.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.9, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.17);
      bp.connect(g).connect(this.master);
      for (const detune of [-14, 9]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.detune.value = detune;
        o.frequency.setValueAtTime(470, t0);
        o.frequency.exponentialRampToValueAtTime(320, t0 + 0.16);
        o.connect(bp);
        o.start(t0);
        o.stop(t0 + 0.2);
      }
    }
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
