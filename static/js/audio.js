/*
 * Quantum DJ — music engine.
 *
 * A "track set" is { bpm, tracks: [{ name, style, color, play }] }. Each
 * track's play(step, time, out) is called with `this` = Engine on every 16th
 * note and synthesizes its part live with the Web Audio API. A track can
 * instead be given an <audio> element with setMedia(); it is streamed (not
 * decoded into memory) through the same volume / direction controls.
 *
 * The built-in "disco" set has eight original tracks sharing one tempo and one
 * chord loop (Am – F – C – G), so any mix of them still sounds musical.
 * Other sets register themselves in QuantumAudio.TRACK_SETS.
 *
 * The quantum state drives the mixer:
 *   amplitude |a|  -> track volume  (so loudness-power ∝ probability |a|²)
 *   phase φ        -> where the sound comes from around your head:
 *                     0° front, 90° right, 180° behind (muffled), 270° left
 */
(function (root) {
  'use strict';

  const BPM = 118;
  const STEP = 60 / BPM / 4;      // one 16th note
  const LOOP_STEPS = 64;          // 4 bars
  const LOOKAHEAD = 0.12;         // seconds scheduled ahead
  const TICK_MS = 25;

  // Bass roots (MIDI) and triads per bar: Am, F, C, G
  const ROOTS = [45, 41, 48, 43];
  const TRIADS = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
  const PENTA = [57, 60, 62, 64, 67, 69, 72, 74, 76, 79, 81]; // A minor pentatonic

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const hit = (pattern, i) => pattern[i % pattern.length] === 'x';

  const DISCO_TRACKS = [
    { name: 'Neon Disco',      style: 'four-on-the-floor disco', color: '#3987e5' },
    { name: 'Chip Quest',      style: '8-bit video game',        color: '#d95926' },
    { name: 'Lo-Fi Lantern',   style: 'chill lo-fi beats',       color: '#199e70' },
    { name: 'Acid Circuit',    style: 'squelchy acid techno',    color: '#c98500' },
    { name: 'Synthwave Drive', style: '80s synthwave',           color: '#d55181' },
    { name: 'Breakbeat Bloom', style: 'breakbeat & plucks',      color: '#008300' },
    { name: 'Tokyo Pop',       style: 'bright J-pop hook',       color: '#9085e9' },
    { name: 'Deep Space',      style: 'ambient space drift',     color: '#e66767' },
  ];

  class Engine {
    constructor(trackSet) {
      this.set = trackSet;
      this.tracks = trackSet.tracks;
      this.bpm = trackSet.bpm;
      this.stepDur = 60 / this.bpm / 4;  // one 16th note
      this.ctx = null;
      this.running = false;
      this.step = 0;
      this.nextTime = 0;
      this.timer = null;
      this.channels = [];
      this.beatListeners = [];
      this.targetGain = new Array(this.tracks.length).fill(0);
      this.media = new Array(this.tracks.length).fill(null); // { el, out }
    }

    /** Must be called from a user gesture (browser autoplay rules). */
    start() {
      if (!this.ctx) this._build();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (this.running) return;
      this.running = true;
      this.step = 0;
      this.nextTime = this.ctx.currentTime + 0.06;
      this.timer = setInterval(() => this._schedule(), TICK_MS);
      this.media.forEach((m) => { if (m) m.el.play().catch(() => {}); });
    }

    /**
     * Replace track i's synthesized part with an <audio> element (looping is up to
     * the caller). Pass null to go back to the synth. Each element can only ever be
     * attached to one engine.
     */
    setMedia(i, el) {
      const old = this.media[i];
      if (old) {
        old.el.pause();
        if (old.out) old.out.disconnect();
      }
      this.media[i] = el ? { el, out: null } : null;
      if (el && this.ctx) this._connectMedia(i);
      if (el && this.running) el.play().catch(() => {});
    }

    _connectMedia(i) {
      const m = this.media[i];
      const node = this.ctx.createMediaElementSource(m.el);
      m.out = this.ctx.createGain();
      m.out.gain.value = 1.3; // the channel input is 0.5; mastered songs sit near full scale
      node.connect(m.out).connect(this.channels[i].input);
    }

    stop() {
      this.running = false;
      clearInterval(this.timer);
      this.media.forEach((m) => { if (m) m.el.pause(); });
      if (this.ctx) this.ctx.suspend();
    }

    get isRunning() { return this.running; }

    onBeat(fn) { this.beatListeners.push(fn); }

    /**
     * mix: array of { gain (0..1), phaseDeg } per track. Smoothly ramps.
     */
    setMix(mix) {
      mix.forEach((m, i) => { this.targetGain[i] = m.gain; });
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      mix.forEach((m, i) => {
        const ch = this.channels[i];
        const rad = (m.phaseDeg * Math.PI) / 180;
        ch.gain.gain.setTargetAtTime(m.gain, t, 0.06);
        ch.pan.pan.setTargetAtTime(Math.sin(rad) * 0.9, t, 0.08);
        // front (cos=1) open filter, behind (cos=-1) muffled
        const cutoff = 900 * Math.pow(18000 / 900, (1 + Math.cos(rad)) / 2);
        ch.filter.frequency.setTargetAtTime(cutoff, t, 0.08);
      });
    }

    setMasterVolume(v) {
      if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    }

    /** Frequency data for the visualizer (Uint8Array) or null. */
    spectrum() {
      if (!this.analyser) return null;
      this.analyser.getByteFrequencyData(this.freqData);
      return this.freqData;
    }

    // ---------------------------------------------------------------- build
    _build() {
      const Ctx = root.AudioContext || root.webkitAudioContext;
      const ctx = (this.ctx = new Ctx());
      this.master = ctx.createGain();
      this.master.gain.value = 0.8;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.master.connect(comp).connect(this.analyser).connect(ctx.destination);

      // one shared white-noise buffer for drums
      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      this.channels = this.tracks.map((_, i) => {
        const input = ctx.createGain();      // instruments write here
        input.gain.value = 0.5;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 18000;
        const pan = ctx.createStereoPanner();
        const gain = ctx.createGain();
        gain.gain.value = this.targetGain[i];
        input.connect(filter).connect(pan).connect(gain).connect(this.master);
        return { input, filter, pan, gain };
      });
      this.media.forEach((m, i) => { if (m) this._connectMedia(i); });
    }

    _schedule() {
      const ctx = this.ctx;
      while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
        const step = this.step;
        const time = this.nextTime;
        for (let i = 0; i < this.tracks.length; i++) {
          // skip silent tracks to save CPU; they rejoin in sync on the next step
          if (this.targetGain[i] < 0.004 || this.media[i]) continue;
          this.tracks[i].play.call(this, step, time, this.channels[i].input);
        }
        if (step % 4 === 0) {
          const beat = step / 4;
          const delay = Math.max(0, (time - ctx.currentTime) * 1000);
          setTimeout(() => this.beatListeners.forEach((fn) => fn(beat)), delay);
        }
        this.nextTime += this.stepDur;
        this.step = (step + 1) % LOOP_STEPS;
      }
    }

    // ---------------------------------------------------------- instruments
    _env(g, t, peak, attack, decay) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    }

    kick(t, out, level = 1, tight = false) {
      const ctx = this.ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(tight ? 170 : 140, t);
      o.frequency.exponentialRampToValueAtTime(42, t + (tight ? 0.08 : 0.13));
      this._env(g, t, 1.1 * level, 0.002, tight ? 0.22 : 0.36);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 0.45);
    }

    noiseHit(t, out, { type = 'highpass', freq = 7000, q = 1, level = 0.3, decay = 0.05 } = {}) {
      const ctx = this.ctx;
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      this._env(g, t, level, 0.001, decay);
      s.connect(f).connect(g).connect(out);
      s.start(t, Math.random() * 0.5); s.stop(t + decay + 0.05);
    }

    hat(t, out, open = false, level = 0.22) {
      this.noiseHit(t, out, { freq: 8000, level, decay: open ? 0.22 : 0.04 });
    }

    snare(t, out, level = 0.5, decay = 0.18) {
      this.noiseHit(t, out, { type: 'bandpass', freq: 1900, q: 0.8, level, decay });
      this.tone(t, out, 190, 0.08, { type: 'triangle', gain: level * 0.6, release: 0.08 });
    }

    clap(t, out, level = 0.5) {
      for (let k = 0; k < 3; k++) {
        this.noiseHit(t + k * 0.011, out, { type: 'bandpass', freq: 1300, q: 1.5, level, decay: k === 2 ? 0.16 : 0.02 });
      }
    }

    /** Generic synth voice. */
    tone(t, out, freq, dur, o = {}) {
      const ctx = this.ctx;
      const {
        type = 'sawtooth', gain = 0.2, attack = 0.005, release = 0.1,
        cutoff = 0, q = 1, sweep = 0, detune = 0, voices = 1,
      } = o;
      const g = ctx.createGain();
      let node = g;
      if (cutoff) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass'; f.Q.value = q;
        f.frequency.setValueAtTime(cutoff + sweep, t);
        if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff), t + Math.min(dur, 0.25));
        f.connect(g);
        node = f;
      }
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + attack);
      g.gain.setValueAtTime(gain, t + Math.max(attack, dur));
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack, dur) + release);
      g.connect(out);
      const end = t + Math.max(attack, dur) + release + 0.05;
      for (let v = 0; v < voices; v++) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;
        osc.detune.value = voices > 1 ? (v - (voices - 1) / 2) * detune : detune;
        osc.connect(node);
        osc.start(t); osc.stop(end);
      }
    }

    chord(t, out, notes, dur, o) {
      const each = Object.assign({}, o, { gain: (o.gain || 0.2) / Math.sqrt(notes.length) });
      notes.forEach((n) => this.tone(t, out, mtof(n), dur, each));
    }
  }

  // ---------------------------------------------------------------- tracks
  // Each player gets (step 0..63, time, output) with `this` = Engine.
  const PLAYERS = [
    // 0 Neon Disco
    function (s, t, out) {
      const bar = s >> 4, i = s & 15;
      if (i % 4 === 0) this.kick(t, out);
      if (i % 4 === 2) this.hat(t, out, true, 0.16);
      if (i === 4 || i === 12) this.clap(t, out, 0.4);
      if (i % 2 === 0) this.tone(t, out, mtof(ROOTS[bar] + (i % 4 === 2 ? 12 : 0)), STEP * 1.2,
        { type: 'sawtooth', gain: 0.22, cutoff: 900, q: 4, sweep: 600, release: 0.05 });
      if (i === 6 || i === 14) this.chord(t, out, TRIADS[bar].map((n) => n + 12), STEP * 1.5,
        { type: 'sawtooth', gain: 0.22, cutoff: 3000, voices: 2, detune: 12, release: 0.12 });
    },
    // 1 Chip Quest
    function (s, t, out) {
      const bar = s >> 4, i = s & 15;
      if (i === 0 || i === 8 || i === 11) this.kick(t, out, 0.8, true);
      if (i === 4 || i === 12) this.noiseHit(t, out, { freq: 3000, level: 0.35, decay: 0.09 });
      if (i % 2 === 0) this.hat(t, out, false, 0.12);
      const tri = TRIADS[bar];
      const arp = [tri[0], tri[1], tri[2], tri[0] + 12, tri[2], tri[1]];
      this.tone(t, out, mtof(arp[i % arp.length] + 12), STEP * 0.7,
        { type: 'square', gain: 0.07, release: 0.02 });
      if (i % 4 === 0) this.tone(t, out, mtof(ROOTS[bar] + 12), STEP * 3,
        { type: 'triangle', gain: 0.35, release: 0.03 });
    },
    // 2 Lo-Fi Lantern
    function (s, t, out) {
      const bar = s >> 4, i = s & 15;
      const swing = (i % 2 === 1) ? STEP * 0.18 : 0;
      if (hit('x......x..x.....', i)) this.kick(t, out, 0.7);
      if (i === 4 || i === 12) this.snare(t, out, 0.22, 0.12);
      if (i % 2 === 0 || i % 4 === 3) this.hat(t + swing, out, false, 0.07);
      if (i === 0 || i === 7) this.chord(t + swing, out, TRIADS[bar].concat(TRIADS[bar][0] + 14), STEP * 5,
        { type: 'triangle', gain: 0.28, attack: 0.01, release: 0.6, cutoff: 1400 });
      if (i === 0) this.tone(t, out, mtof(ROOTS[bar]), STEP * 10,
        { type: 'sine', gain: 0.45, release: 0.2 });
    },
    // 3 Acid Circuit
    function (s, t, out) {
      const bar = s >> 4, i = s & 15;
      if (i % 4 === 0) this.kick(t, out, 1, true);
      this.hat(t, out, i % 4 === 2, i % 4 === 2 ? 0.12 : 0.06);
      const seq = [0, 0, 12, 0, 3, 0, 10, 12, 0, 7, 0, 12, 3, 15, 0, 10];
      const accent = hit('x..x..x...x..x..', i);
      const base = bar === 1 ? 41 : 45; // tie to Am/F
      this.tone(t, out, mtof(base + seq[i]), STEP * 0.8,
        { type: 'sawtooth', gain: accent ? 0.2 : 0.13, cutoff: 350 + (s % 32) * 45, q: 14,
          sweep: accent ? 2400 : 900, release: 0.04 });
    },
    // 4 Synthwave Drive
    function (s, t, out) {
      const bar = s >> 4, i = s & 15;
      if (i === 0 || i === 8) this.kick(t, out);
      if (i === 4 || i === 12) this.snare(t, out, 0.55, 0.3);
      if (i % 2 === 1) this.hat(t, out, false, 0.06);
      if (i % 2 === 0) this.tone(t, out, mtof(ROOTS[bar]), STEP * 0.9,
        { type: 'sawtooth', gain: 0.2, cutoff: 700, q: 2, release: 0.04 });
      if (i === 0) this.chord(t, out, TRIADS[bar].map((n) => n + 12), STEP * 14,
        { type: 'sawtooth', gain: 0.18, attack: 0.25, release: 0.4, cutoff: 1700, voices: 3, detune: 14 });
    },
    // 5 Breakbeat Bloom
    function (s, t, out) {
      const bar = s >> 4, i = s & 15;
      if (hit('x.........x..x..', i)) this.kick(t, out, 0.9);
      if (i === 4 || i === 12) this.snare(t, out, 0.5);
      if (i === 7 || i === 15) this.snare(t, out, 0.12, 0.06);
      if (i % 2 === 0) this.hat(t, out, false, 0.09);
      const mel = [0, 2, 4, 3, 5, 4, 2, 1, 0, 2, 4, 6, 5, 4, 3, 2];
      if (i % 2 === 0 || i === 3 || i === 11) {
        const n = PENTA[(mel[i] + bar * 2) % PENTA.length];
        this.tone(t, out, mtof(n + 12), STEP * 0.6,
          { type: 'triangle', gain: 0.22, cutoff: 3500, sweep: 3000, release: 0.18 });
      }
      if (i === 0 || i === 10) this.tone(t, out, mtof(ROOTS[bar]), STEP * 3,
        { type: 'square', gain: 0.12, cutoff: 400, release: 0.1 });
    },
    // 6 Tokyo Pop
    function (s, t, out) {
      const bar = s >> 4, i = s & 15;
      if (i % 4 === 0) this.kick(t, out, 0.9);
      if (i === 4 || i === 12) this.clap(t, out, 0.45);
      if (i % 2 === 0) this.hat(t, out, false, 0.08);
      if (i % 4 === 2 || i === 15) this.tone(t, out, mtof(ROOTS[bar] + 12), STEP * 0.8,
        { type: 'square', gain: 0.12, cutoff: 1200, release: 0.05 });
      // hook: [step, midi offset from bar's triad root]
      const hook = [
        [[0, 12], [2, 12], [3, 14], [4, 16], [6, 12], [8, 19], [10, 16], [12, 14], [14, 12]],
        [[0, 12], [2, 16], [4, 19], [6, 21], [8, 19], [10, 16], [12, 19], [14, 21]],
        [[0, 12], [2, 12], [3, 14], [4, 16], [6, 21], [8, 19], [10, 16], [12, 14], [14, 16]],
        [[0, 14], [2, 16], [4, 14], [6, 11], [8, 7], [12, 14], [14, 11]],
      ][bar];
      const note = hook.find(([st]) => st === i);
      if (note) this.tone(t, out, mtof(TRIADS[bar][0] + note[1]), STEP * 1.6,
        { type: 'square', gain: 0.1, cutoff: 4000, voices: 2, detune: 8, release: 0.08 });
    },
    // 7 Deep Space
    function (s, t, out) {
      const bar = s >> 4, i = s & 15;
      if (i === 0) {
        this.tone(t, out, mtof(ROOTS[bar] - 12), STEP * 15, { type: 'sine', gain: 0.55, attack: 0.3, release: 0.4 });
        this.chord(t, out, TRIADS[bar], STEP * 15, { type: 'sine', gain: 0.32, attack: 0.8, release: 0.8, voices: 2, detune: 7 });
      }
      if (i % 4 === 2) this.noiseHit(t, out, { freq: 6000, level: 0.05, decay: 0.12 });
      if (hit('x.....x...x.....', i)) {
        const n = PENTA[(s * 7 + bar * 3) % PENTA.length] + 12;
        this.tone(t, out, mtof(n), 0.02, { type: 'sine', gain: 0.18, release: 1.2 });
        this.tone(t, out, mtof(n) * 2.76, 0.01, { type: 'sine', gain: 0.04, release: 0.5 });
      }
    },
  ];

  DISCO_TRACKS.forEach((t, i) => { t.play = PLAYERS[i]; });

  root.QuantumAudio = {
    Engine,
    TRACK_SETS: { disco: { bpm: BPM, tracks: DISCO_TRACKS } },
    util: { mtof, hit },
  };
})(typeof window !== 'undefined' ? window : globalThis);
