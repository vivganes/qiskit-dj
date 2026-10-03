/* Quantum DJ — "How it works" content. Trusted markup, sized to the booth (2 or 3 qubits). */
(function (root) {
  'use strict';
  const Q = root.Quantum;
  const n = Q.NUM_QUBITS, dim = Q.DIM;
  const qubitList = Array.from({ length: n }, (_, q) => 'q' + q).join(', ');
  const example = 2;                                     // |10>
  const exampleBits = Q.ketLabel(example).slice(1, -1).split('')
    .map((b, q) => `q${q} = ${b}`).join(', ');

  root.HELP_HTML = `
  <h2>How the Quantum DJ Booth works</h2>
  <p>This simulator is inspired by the <strong>Quantum Computer Disco</strong> exhibit at Miraikan in Tokyo.
  There, visitors become a DJ: they put round "gate" pieces into grooves on a DJ table to build a real
  quantum program, listen to the result in headphones, and then "send" it to the dance floor.</p>

  <h3>The big idea</h3>
  <table>
    <tr><th>In the booth</th><th>In a quantum computer</th></tr>
    <tr><td>${n} switches on the deck (${qubitList})</td><td>${n} <strong>qubits</strong></td></tr>
    <tr><td>${dim} records: ${Q.ketLabel(0)} … ${Q.ketLabel(dim - 1)}</td><td>the 2<sup>${n}</sup> = ${dim} <strong>basis states</strong> (possible answers)</td></tr>
    <tr><td>Gate pieces on the deck, read left to right</td><td>a <strong>quantum circuit</strong> (the program)</td></tr>
    <tr><td>Hearing several tracks at once in the headphones</td><td><strong>superposition</strong></td></tr>
    <tr><td>Volume of a track</td><td>the <strong>amplitude</strong>; its square is the probability of that answer</td></tr>
    <tr><td>Direction the sound comes from (front, right, behind, left)</td><td>the <strong>phase</strong> of the amplitude</td></tr>
    <tr><td>Tracks from opposite directions cancelling out</td><td><strong>interference</strong></td></tr>
    <tr><td>● control pieces linking qubits so they always match</td><td><strong>entanglement</strong></td></tr>
    <tr><td>"Drop to the floor": dancers hear ONE track</td><td><strong>measurement</strong>: the superposition collapses to one random answer</td></tr>
  </table>

  <h3>Reading the records</h3>
  <p>Read a label like <strong>${Q.ketLabel(example)}</strong> left to right: ${exampleBits}. The bar shows the chance
  that this track is picked when you drop to the floor. The arrow on the record is its phase:
  pointing up = 0° (in front of you), right = 90°, down = 180° (behind you, sounds muffled), left = 270°.
  Only <em>differences</em> in direction between tracks matter physically — turning every track by the same
  amount (a "global phase") changes nothing you can ever measure.</p>

  <h3>Stepping through the set</h3>
  <p>Use ⏮ ◀ ▶ ⏭ (or click a column number) to hear the state after each step. ▶▶ plays the program one
  step per bar of music, so you can hear each gate change the mix.</p>

  <h3>The gates</h3>
  <div id="help-gates"></div>

  <h3>Linking gates in a column</h3>
  <p>A <strong>●</strong> control makes every other gate in the <em>same column</em> act only when that qubit is 1.
  ● + X is a CNOT (it flips the other qubit only when the ● qubit is 1).</p>

  <h3>Keyboard</h3>
  <p>Click a slot, then type <strong>H X Y Z</strong> or <strong>C</strong> for ●. Delete removes. Arrow keys move between slots.</p>

  <h3>Teacher notes</h3>
  <ul>
    <li>The <strong>Free play examples</strong> (coin flip, dice roll, interference) are optional starting circuits.</li>
    <li>This booth has ${n} qubits and ${Q.NUM_STEPS} steps.</li>
    <li>"Run 100 drops" is great for discussing probability vs. a single random result.</li>
    <li><strong>Share board</strong> copies a link to the current set — students can hand in their programs this way.</li>
    <li>The Flask server simulates your circuit with Qiskit (simulator only, never real quantum hardware); no accounts are needed.</li>
    <li>The simulation is exact (a state vector of ${dim} complex amplitudes). The music mapping is a teaching metaphor: real quantum computers don't play music!</li>
  </ul>`;
})(typeof window !== 'undefined' ? window : globalThis);
