// Procedural foley with the Web Audio API. No samples are loaded.
//
//  scratch: looping pink noise -> band-pass (centre follows pen speed) -> peaking "tooth"
//           filter -> gain (follows pen speed), plus a sparse crackle layer for paper fibre.
//  thud:    a pitched-down sine body + resonant low-passed noise when a terrace pops up.
//  pop / splash / rustle: short one-shots for planting, river carving and undo.

/** Paul Kellet's refined pink-noise filter, written into a looping buffer. */
export function fillPinkNoise(out, rand = Math.random) {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const white = rand() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  return out;
}

/** Map pen speed (CSS px per ms) to scratch parameters. Exported for tests. */
export function scratchParams(v) {
  const s = Math.min(1, Math.max(0, v / 2.2));
  return {
    gain: s < 0.01 ? 0 : 0.05 + 0.4 * Math.sqrt(s),
    freq: 1400 + 4200 * s,
    q: 1.6 - 0.8 * s,
  };
}

export class PaperSynth {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this._unlocked = false;
    this._muted = false;
  }

  /** Mute or unmute every sound (the Options panel). */
  get muted() {
    return this._muted;
  }

  set muted(m) {
    this._muted = !!m;
    if (this.out) this.out.gain.value = this._muted ? 0 : 0.9;
  }

  /** Create / resume the AudioContext. Must run inside a user gesture (first touch). */
  unlock() {
    if (!this.enabled) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      this.enabled = false;
      return;
    }
    if (!this.ctx) {
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        this.enabled = false;
        return;
      }
      this._build();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this._unlocked = true;
  }

  get ready() {
    return !!this.ctx && this._unlocked && this.ctx.state !== 'closed';
  }

  _build() {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 2;
    this.pink = ctx.createBuffer(1, len, ctx.sampleRate);
    fillPinkNoise(this.pink.getChannelData(0));
    this.white = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const w = this.white.getChannelData(0);
    for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1;

    this.master = ctx.createDynamicsCompressor();
    this.master.threshold.value = -14;
    this.master.ratio.value = 4;
    this.out = ctx.createGain();
    this.out.gain.value = this._muted ? 0 : 0.9;
    this.master.connect(this.out).connect(ctx.destination);

    // Continuous nib scratch.
    const src = ctx.createBufferSource();
    src.buffer = this.pink;
    src.loop = true;
    this.band = ctx.createBiquadFilter();
    this.band.type = 'bandpass';
    this.band.frequency.value = 2200;
    this.band.Q.value = 1.2;
    const tooth = ctx.createBiquadFilter();
    tooth.type = 'peaking';
    tooth.frequency.value = 5200;
    tooth.gain.value = 6;
    tooth.Q.value = 2;
    this.scratchGain = ctx.createGain();
    this.scratchGain.gain.value = 0;
    src.connect(this.band).connect(tooth).connect(this.scratchGain).connect(this.master);
    src.start();

    // Fibre crackle: white noise through a high band, amplitude-gated by a random LFO.
    const crk = ctx.createBufferSource();
    crk.buffer = this.white;
    crk.loop = true;
    const crkBand = ctx.createBiquadFilter();
    crkBand.type = 'highpass';
    crkBand.frequency.value = 6500;
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0;
    crk.connect(crkBand).connect(this.crackleGain).connect(this.master);
    crk.start();
  }

  /** Called on every pointer move while drawing. */
  scratch(v) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const p = scratchParams(v);
    this.scratchGain.gain.setTargetAtTime(p.gain, t, 0.03);
    this.band.frequency.setTargetAtTime(p.freq, t, 0.05);
    this.band.Q.setTargetAtTime(p.q, t, 0.05);
    this.crackleGain.gain.setTargetAtTime(p.gain * (Math.random() < 0.3 ? 0.35 : 0.04), t, 0.01);
  }

  /** Pen lifted. */
  lift() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.scratchGain.gain.setTargetAtTime(0, t, 0.04);
    this.crackleGain.gain.setTargetAtTime(0, t, 0.02);
  }

  _noiseBurst({ type = 'lowpass', freq = 400, q = 1, gain = 0.5, attack = 0.005, decay = 0.3, sweepTo = null, when = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + decay);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + attack + decay + 0.05);
  }

  _tone({ freq = 80, to = 45, gain = 0.6, decay = 0.4, type = 'sine', when = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(to, t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  /** Warm resonant thud when a terrace rises. strength 0..1 (bigger loops = deeper). */
  thud(strength = 0.5) {
    if (!this.ready) return;
    const s = Math.min(1, Math.max(0.15, strength));
    this._tone({ freq: 95 - 30 * s, to: 42, gain: 0.45 + 0.4 * s, decay: 0.35 + 0.25 * s });
    this._noiseBurst({ type: 'lowpass', freq: 260, q: 9, gain: 0.35 + 0.3 * s, decay: 0.28 + 0.2 * s, sweepTo: 90 });
    // cardboard "tok" on top
    this._noiseBurst({ type: 'bandpass', freq: 900, q: 3, gain: 0.12, decay: 0.06 });
  }

  /** Stone foundation settling: two short knocks. */
  knock() {
    if (!this.ready) return;
    this._tone({ freq: 160, to: 90, gain: 0.35, decay: 0.12, type: 'triangle' });
    this._tone({ freq: 140, to: 80, gain: 0.25, decay: 0.12, type: 'triangle', when: 0.09 });
    this._noiseBurst({ type: 'bandpass', freq: 1300, q: 4, gain: 0.15, decay: 0.05 });
  }

  /** Paper cutout snapping upright. */
  pop(i = 0) {
    if (!this.ready) return;
    const w = i * 0.045;
    this._noiseBurst({ type: 'bandpass', freq: 2600 + Math.random() * 900, q: 5, gain: 0.22, decay: 0.035, when: w });
    this._tone({ freq: 520 + Math.random() * 120, to: 300, gain: 0.08, decay: 0.07, type: 'triangle', when: w });
  }

  /** Water filling a carved channel. */
  splash() {
    if (!this.ready) return;
    this._noiseBurst({ type: 'lowpass', freq: 1800, q: 1.5, gain: 0.25, attack: 0.04, decay: 0.7, sweepTo: 300 });
  }

  /** Page rustle for undo / clear. */
  rustle(big = false) {
    if (!this.ready) return;
    this._noiseBurst({ type: 'bandpass', freq: 3200, q: 0.8, gain: big ? 0.3 : 0.18, attack: 0.02, decay: big ? 0.5 : 0.22, sweepTo: 1200 });
  }
}
