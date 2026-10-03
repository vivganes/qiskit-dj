/*
 * Quantum DJ — browser-side helpers for the 2-qubit booth.
 *
 * All quantum simulation happens on the server (Flask + Qiskit, see /api/compute and /api/drop).
 * This file only holds what the UI needs to draw and store a circuit: gate catalog, ket labels,
 * amplitude → probability/phase conversion and the compact share-link encoding.
 *
 * Basis ordering: the label |q0 q1> is read left-to-right, so q0 is the most significant bit
 * (index = q0*2 + q1; track 2 is |10>).
 *
 * A circuit is an array of columns; each column is an array of NUM_QUBITS cells.
 * A cell is null or { type }. A CTRL dot controls every other gate in the same column.
 */
(function (root) {
  'use strict';

  const GATES = {
    H:    { label: 'H',  name: 'Hadamard', family: 'mix',
            info: 'Mixer. Splits one track into an even 50/50 mix — or merges a mix back into one track.' },
    X:    { label: 'X',  name: 'NOT (bit flip)', family: 'flip',
            info: 'Flips a qubit 0 ↔ 1. Like flicking a switch: it swaps which tracks are playing.' },
    Y:    { label: 'Y',  name: 'Y flip', family: 'flip',
            info: 'Flips 0 ↔ 1 and also rotates the phase (direction) of the sound.' },
    Z:    { label: 'Z',  name: 'Phase flip (180°)', family: 'phase',
            info: 'Moves tracks where this qubit is 1 to come from BEHIND you. Volume does not change.' },
    CTRL: { label: '●',  name: 'Control', family: 'link',
            info: 'Links qubits. Other gates in the same column only act when this qubit is 1. Control + X = CNOT.' },
  };

  const PALETTE_ORDER = ['H', 'X', 'Y', 'Z', 'CTRL'];

  function create(NUM_QUBITS, NUM_STEPS) {
    const DIM = 1 << NUM_QUBITS;

    function ketLabel(index) {
      let s = '';
      for (let q = 0; q < NUM_QUBITS; q++) s += (index >> (NUM_QUBITS - 1 - q)) & 1;
      return '|' + s + '⟩';
    }

    function zeroState() {
      const re = new Float64Array(DIM);
      re[0] = 1;
      return { re, im: new Float64Array(DIM) };
    }

    function emptyCircuit(steps) {
      const c = [];
      for (let i = 0; i < (steps || NUM_STEPS); i++) c.push(new Array(NUM_QUBITS).fill(null));
      return c;
    }

    function probabilities(state) {
      const p = new Float64Array(DIM);
      for (let i = 0; i < DIM; i++) p[i] = state.re[i] ** 2 + state.im[i] ** 2;
      return p;
    }

    /** Phase in degrees in [0, 360). */
    function phases(state) {
      const out = new Float64Array(DIM);
      for (let i = 0; i < DIM; i++) {
        let deg = (Math.atan2(state.im[i], state.re[i]) * 180) / Math.PI;
        if (deg < 0) deg += 360;
        if (deg > 359.9995) deg = 0;
        out[i] = deg;
      }
      return out;
    }

    // ---- compact (de)serialization for share links ----
    const CODE = { H: 'H', X: 'X', Y: 'Y', Z: 'Z', CTRL: 'C' };
    const DECODE = Object.fromEntries(Object.entries(CODE).map(([k, v]) => [v, k]));

    /** e.g. "H.|CX" — '|' separates columns, '.' is empty. */
    function encodeCircuit(circuit) {
      let last = -1;
      circuit.forEach((col, i) => { if (col.some(Boolean)) last = i; });
      return circuit.slice(0, last + 1)
        .map((col) => col.map((cell) => (cell ? CODE[cell.type] : '.')).join('')).join('|');
    }

    function decodeCircuit(text, steps) {
      const circuit = emptyCircuit(steps);
      if (!text) return circuit;
      text.split('|').slice(0, circuit.length).forEach((colText, ci) => {
        for (let q = 0; q < NUM_QUBITS && q < colText.length; q++) {
          const type = DECODE[colText[q]];
          if (type) circuit[ci][q] = { type };
        }
      });
      return circuit;
    }

    return {
      NUM_QUBITS, DIM, NUM_STEPS, GATES, PALETTE_ORDER,
      ketLabel, zeroState, emptyCircuit, probabilities, phases, encodeCircuit, decodeCircuit,
    };
  }

  const config = root.QDJ_CONFIG || {};
  const api = create(config.qubits || 2, config.steps || 10);
  api.create = create;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Quantum = api;
})(typeof window !== 'undefined' ? window : globalThis);
