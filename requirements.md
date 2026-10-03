# Qiskit DJ Booth — Requirements Specification

## Overview

A browser-based classroom simulator that teaches quantum computing through music metaphor. Students build quantum circuits using gate pieces, hear superposition as a mix of audio tracks, and measure ("drop") to send one track to the dance floor.

Built on **Qiskit SDK v2 primitives** for state vector simulation and circuit representation.

---

## Core Requirements

### 1. Quantum State Simulation (2 Qubits Only)
- Support exactly **2 qubits** (default: 2, not configurable — only 2-qubit booth exists in V1)
- Full amplitude state vector tracking via Qiskit `initialize_statevector` or equivalent
- Exact probability calculation from amplitudes
- Density matrix support for mid-set measurement scenarios
- **IMPORTANT**: Use only Simulator.  Never run in a real quantum computer ever.

### 2. Gate Operations — Core Set Only (H, X, Y, Z, CNOT)
Each gate operates on one or more qubits:
- **H** (Hadamard): creates superposition from |0⟩ to equal mix of |0⟩ and |1⟩
- **X**: single-qubit bit flip — swaps |0⟩ ↔ |1⟩
- **Y**: single-qubit rotation with phase
- **Z**: single-qubit phase gate
- **CNOT (●+X)**: controlled qubit + target qubit — flips target when control is 1

Gate composition rules:
- Single ● controls every other gate in the same column
- Gates stack on circuit steps (default: 10)

**Future gates** (kept for later): S, T, R(θ), CZ, SWAP, Toffoli — these are **NOT** required for V1 and should not appear in the UI or code yet.

### 3. Audio Visualization
Uses Web Audio API to render quantum states as sound:
- **Superposition** → several tracks playing simultaneously in headphones
- **Amplitude** → track volume (volume² = probability)
- **Phase** → stereo direction: front=0°, right=90°, behind=180° (muffled), left=270°
- **Interference** → tracks from opposite directions canceling each other
- **Entanglement** → qubits always agreeing on measurements

Tracks correspond to basis states:

- 2 qubits = 4 tracks (|00⟩, |01⟩, |10⟩, |11⟩)
- All tracks in same key and tempo for clean superposition

### 4. Measurement ("Drop")
- Click "Drop to the floor" button
- Collapses superposition based on probabilities
- Sends ONE track to dance floor (the measured result)
- Records drop history visible to students
- Demonstrates: measurement gives only one outcome, not all possibilities

### 5. Circuit Board UI — Free Play Mode
- Grid of 2 qubit rows × circuit steps
- Drag-and-drop gate pieces onto slots
- Click a gate then click a slot as alternative placement
| Keyboard input: focus slot, type H/X/Y/Z/C/Shift+S/Shift+T/Delete
| Gate labels read left-to-right (|10⟩ means q0=1, q1=0)

### 6. Free Play Examples — Optional Starting Circuits (NOT Missions)
Simple one-click example circuits for demonstration:
- Coin flip — H gate → superposition of two outcomes
- Dice roll — multi-qubit superposition pattern
- Interference demo — H Z H cancellation visible in probability chart

These are optional starting points, not teaching missions. They exist for users who want to jump straight into seeing quantum behavior without building from scratch.

### 7. Test Suite (Python, using Qiskit SDK v2 primitives)
- Physics tests for each qubit count size via Qiskit state vector simulation
- Free-play example circuits tested for expected probabilities
- State vector predictions match density matrix calculations for mid-set measurement scenarios

---

## Architecture — Flask App
The UI code is already present in the reference folder `/home/vivek/source-codes/quantum-disco`.

Use `rahman.html` there as `index.html` here, as we are building only the 2 qubit version.

Also, rename the songs from `rahman` file to something appropriate for global audience.

The entire backend is a **Flask app** that serves both HTML templates and API endpoints:
- `templates/` — reused only the 2-qubit booth as `index.html`, rendered via Flask template inheritance or direct serving (no separate `rahman.html` file)
- `static/` — all JS files (`js/app.js`, `js/audio.js`, etc.) served as static assets, unchanged from original reference files
- `/api/compute` — JSON endpoint that takes a circuit definition and returns state vector + probabilities via Qiskit v2 primitives
- `/api/drop` — JSON endpoint that measures the current state and collapses to one outcome

The frontend JS stays identical: it calls Flask endpoints instead of running Node.js locally. No Node setup required for users; just `pip install flask qiskit`.

---

## Test Suite Source

Test suites are implemented in Python using Qiskit SDK v2 primitives:
- Physics tests for each qubit count size via state vector simulation
- Free-play example circuits tested for expected probabilities