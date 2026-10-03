/*
 * Quantum DJ — track set for the 2-qubit booth.
 *
 * The real songs come from audio files (see song-loader.js and the songs list in
 * the 2-qubit booth). If a file can't be read, its slot falls back to the ORIGINAL
 * placeholder groove synthesized below: tabla, dhol, tanpura drone and harmonium,
 * all in D with one shared chord loop (D – C – G – D) so any mix still sounds musical.
 * The melodies are not taken from any song.
 */
(function (root) {
  'use strict';
  const { mtof, hit } = root.QuantumAudio.util;

  const BPM = 96;
  const ROOTS = [38, 36, 43, 38];                                   // D2 C2 G2 D2
  const TRIADS = [[62, 66, 69], [60, 64, 67], [59, 62, 67], [62, 66, 69]];
  const SCALE = [62, 64, 66, 69, 71, 74, 76, 78, 81];               // D major pentatonic+

  // ---- instruments (called with `this` = Engine) ----
  function dayan(t, out, freq, level) {        // tabla right hand: ringing "na / tin"
    this.tone(t, out, freq, 0.004, { type: 'sine', gain: level, release: 0.22 });
    this.tone(t, out, freq * 2.01, 0.003, { type: 'sine', gain: level * 0.3, release: 0.07 });
    this.noiseHit(t, out, { type: 'bandpass', freq: 3200, q: 2, level: level * 0.35, decay: 0.012 });
  }

  function bayan(t, out, level) {              // tabla left hand: bass "ghe" with a pitch rise
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(72, t);
    o.frequency.exponentialRampToValueAtTime(108, t + 0.16);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + 0.45);
  }

  function dholSlap(t, out, level) {           // dhol treble side
    this.noiseHit(t, out, { type: 'bandpass', freq: 950, q: 1.2, level, decay: 0.09 });
    this.tone(t, out, 320, 0.02, { type: 'triangle', gain: level * 0.6, release: 0.06 });
  }

  function pluck(t, out, midi, level) {        // sitar-ish pluck
    this.tone(t, out, mtof(midi), 0.01, { type: 'sawtooth', gain: level, cutoff: 900, q: 6, sweep: 5200, release: 0.45, voices: 2, detune: 9 });
  }

  function harmonium(t, out, notes, dur, level) {
    this.chord(t, out, notes, dur, { type: 'square', gain: level, attack: 0.07, release: 0.3, cutoff: 1500, voices: 2, detune: 7 });
  }

  const TRACKS = [
    {
      title: 'Festival Drums', style: 'celebration dhol groove', color: '#3987e5',
      play(s, t, out) {
        const bar = s >> 4, i = s & 15;
        if (hit('x..x..x.x..x..x.', i)) this.kick(t, out, 0.85);
        if (hit('..x...x...x...x.', i)) dholSlap.call(this, t, out, 0.45);
        if (i % 2 === 1) this.hat(t, out, false, 0.05);
        if (i === 2 || i === 10) harmonium.call(this, t, out, TRIADS[bar].map((n) => n + 12), this.stepDur * 1.5, 0.16);
        const line = [0, 2, 4, 3, 2, 4, 5, 4];
        if (i % 2 === 0) pluck.call(this, t, out, SCALE[(line[i / 2] + bar) % SCALE.length], 0.13);
        if (i === 0 || i === 8) this.tone(t, out, mtof(ROOTS[bar] + 12), this.stepDur * 3, { type: 'triangle', gain: 0.3, release: 0.08 });
      },
    },
    {
      title: 'Express Rhythm', style: 'galloping train-rhythm tabla', color: '#d95926',
      play(s, t, out) {
        const bar = s >> 4, i = s & 15;
        if (hit('x.xxx.xxx.xxx.xx', i)) dayan.call(this, t, out, i % 4 === 0 ? 620 : 880, i % 4 === 0 ? 0.32 : 0.16);
        if (hit('x.....x.x.....x.', i)) bayan.call(this, t, out, 0.7);
        if (i === 0) harmonium.call(this, t, out, TRIADS[bar], this.stepDur * 7, 0.18);
        if (i === 8) harmonium.call(this, t, out, TRIADS[bar], this.stepDur * 6, 0.14);
        if (i % 4 === 0) this.tone(t, out, mtof(ROOTS[bar] + 12), this.stepDur * 2, { type: 'sine', gain: 0.35, release: 0.1 });
      },
    },
    {
      title: 'Sunrise Drone', style: 'tanpura drone & claps', color: '#199e70',
      play(s, t, out) {
        const bar = s >> 4, i = s & 15;
        if (i % 4 === 0) {
          const drone = [57, 62, 62, 50][i / 4];             // Pa Sa Sa Sa(low)
          this.tone(t, out, mtof(drone), this.stepDur * 3, { type: 'sawtooth', gain: 0.07, attack: 0.03, release: 1.4, cutoff: 1300, q: 3, sweep: 2200 });
        }
        if (hit('x..x..x...x..x..', i)) this.clap(t, out, 0.22);
        if (i === 0) harmonium.call(this, t, out, TRIADS[bar].concat(TRIADS[bar][0] - 12), this.stepDur * 14, 0.14);
        const phrase = [[0, 5], [6, 4], [8, 3], [12, 2]];
        const n = phrase.find(([st]) => st === i);
        if (n) this.tone(t, out, mtof(SCALE[(n[1] + (bar === 2 ? 1 : 0)) % SCALE.length]), this.stepDur * 3,
          { type: 'triangle', gain: 0.16, attack: 0.04, release: 0.4 });
      },
    },
    {
      title: 'Anthem Strings', style: 'strings & toms', color: '#c98500',
      play(s, t, out) {
        const bar = s >> 4, i = s & 15;
        if (i === 0) this.chord(t, out, TRIADS[bar].map((n) => n + 12).concat(TRIADS[bar][0]), this.stepDur * 15,
          { type: 'sawtooth', gain: 0.17, attack: 0.35, release: 0.6, cutoff: 1900, voices: 3, detune: 12 });
        if (hit('x.........x.x...', i)) this.kick(t, out, 0.75);
        if (i === 4 || i === 12) this.snare(t, out, 0.25, 0.35);
        if (i % 4 === 0) {
          const rise = [0, 1, 2, 3][i / 4] + bar;
          this.tone(t, out, mtof(SCALE[rise % SCALE.length] + 12), this.stepDur * 3.5,
            { type: 'sawtooth', gain: 0.08, attack: 0.08, release: 0.3, cutoff: 2600, voices: 2, detune: 10 });
        }
        if (i === 0) this.tone(t, out, mtof(ROOTS[bar]), this.stepDur * 15, { type: 'sine', gain: 0.4, attack: 0.1, release: 0.4 });
      },
    },
  ];

  // `name` is what the UI shows; the song loader updates it once a file is loaded.
  TRACKS.forEach((tr) => { tr.name = tr.title + ' · demo beat'; });

  root.QuantumAudio.TRACK_SETS.booth = { bpm: BPM, tracks: TRACKS };
})(typeof window !== 'undefined' ? window : globalThis);
