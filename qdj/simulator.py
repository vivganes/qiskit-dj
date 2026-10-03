"""Quantum DJ booth simulator (2 qubits) built on Qiskit SDK v2.

Simulator only: nothing here ever talks to a real quantum computer.

Circuit format (same as the browser): a list of columns, each column a list of
NUM_QUBITS cells, each cell ``None`` or ``{"type": "H" | "X" | "Y" | "Z" | "CTRL" | "M"}``.
``M`` (mid-set measurement) is not on the deck in V1 but is supported here so the
density-matrix path can be tested.

Basis labels read left to right: ``|10>`` means q0=1, q1=0, i.e. index = q0*2 + q1.
Qiskit is little-endian, so booth qubit ``q`` is Qiskit qubit ``NUM_QUBITS - 1 - q``;
with that mapping Qiskit's basis index equals the booth's.
"""
from __future__ import annotations

import numpy as np
from qiskit import QuantumCircuit
from qiskit.circuit.library import HGate, XGate, YGate, ZGate
from qiskit.primitives import StatevectorSampler
from qiskit.quantum_info import DensityMatrix, Operator, Statevector

NUM_QUBITS = 2
NUM_STEPS = 10
DIM = 1 << NUM_QUBITS

GATES = {"H": HGate, "X": XGate, "Y": YGate, "Z": ZGate}
CELL_TYPES = set(GATES) | {"CTRL", "M"}


class CircuitError(ValueError):
    """The submitted circuit is malformed."""


def _qk(q: int) -> int:
    """Booth qubit index -> Qiskit qubit index."""
    return NUM_QUBITS - 1 - q


def validate(circuit) -> list[list[str | None]]:
    """Return the circuit as columns of gate-type strings (or None), or raise CircuitError."""
    if not isinstance(circuit, list) or len(circuit) > NUM_STEPS:
        raise CircuitError(f"circuit must be a list of at most {NUM_STEPS} columns")
    columns = []
    for column in circuit:
        if not isinstance(column, list) or len(column) != NUM_QUBITS:
            raise CircuitError(f"each column needs exactly {NUM_QUBITS} cells")
        row = []
        for cell in column:
            if cell is None:
                row.append(None)
                continue
            kind = cell.get("type") if isinstance(cell, dict) else None
            if kind not in CELL_TYPES:
                raise CircuitError(f"unknown gate: {kind!r}")
            row.append(kind)
        columns.append(row)
    return columns


def analyze_column(column) -> dict:
    """Controls, targets and measured qubits of a column, plus teaching warnings."""
    controls = [q for q, t in enumerate(column) if t == "CTRL"]
    targets = [q for q, t in enumerate(column) if t in GATES]
    measures = [q for q, t in enumerate(column) if t == "M"]
    warnings = []
    if controls and measures:
        warnings.append("Measurement cannot be controlled — the ● is ignored for M.")
    if controls and not targets:
        warnings.append("A control ● needs another gate in the same column to control.")
    return {"controls": controls, "targets": targets, "swaps": [], "measures": measures,
            "warnings": warnings}


def column_circuit(column) -> QuantumCircuit:
    """The unitary part of one column. A ● controls every other gate in the column."""
    info = analyze_column(column)
    qc = QuantumCircuit(NUM_QUBITS)
    ctrl_qubits = [_qk(q) for q in info["controls"]]
    for q in info["targets"]:
        gate = GATES[column[q]]()
        if ctrl_qubits:
            qc.append(gate.control(len(ctrl_qubits)), ctrl_qubits + [_qk(q)])
        else:
            qc.append(gate, [_qk(q)])
    return qc


def build_circuit(columns) -> QuantumCircuit:
    """Whole circuit; rejects mid-set measurement (use exact_distribution for those)."""
    qc = QuantumCircuit(NUM_QUBITS)
    for column in columns:
        if "M" in column:
            raise CircuitError("mid-set measurement has no single state vector")
        qc.compose(column_circuit(column), inplace=True)
    return qc


def initial_state() -> Statevector:
    return Statevector.from_int(0, DIM)


def statevector(circuit) -> Statevector:
    """Final state vector of a measurement-free circuit."""
    return initial_state().evolve(build_circuit(validate(circuit)))


def step_states(circuit, steps: int = NUM_STEPS) -> list[Statevector]:
    """states[k] = state after the first k columns, for k = 0..steps."""
    columns = validate(circuit)
    columns += [[None] * NUM_QUBITS] * (steps - len(columns))
    state = initial_state()
    states = [state]
    for column in columns[:steps]:
        if "M" in column:
            raise CircuitError("mid-set measurement has no single state vector")
        state = state.evolve(column_circuit(column))
        states.append(state)
    return states


def probabilities(state) -> np.ndarray:
    """Exact outcome probabilities from the amplitudes."""
    return np.asarray(state.probabilities(), dtype=float)


def _dephase(rho: DensityMatrix, qubit: int) -> DensityMatrix:
    """Measure `qubit` and forget the result: rho -> P0 rho P0 + P1 rho P1."""
    out = np.zeros((DIM, DIM), dtype=complex)
    for outcome in (0, 1):
        proj = np.zeros((DIM, DIM))
        for i in range(DIM):
            if (i >> (NUM_QUBITS - 1 - qubit)) & 1 == outcome:
                proj[i, i] = 1
        out += proj @ rho.data @ proj
    return DensityMatrix(out)


def density_matrix(circuit) -> DensityMatrix:
    """Final density matrix, including mid-set measurements (as dephasing)."""
    rho = DensityMatrix(initial_state())
    for column in validate(circuit):
        rho = rho.evolve(Operator(column_circuit(column)))
        for q in analyze_column(column)["measures"]:
            rho = _dephase(rho, q)
    return rho


def exact_distribution(circuit) -> np.ndarray:
    """Exact probability of each final outcome, with or without mid-set measurements."""
    return np.clip(np.asarray(density_matrix(circuit).probabilities(), dtype=float), 0, 1)


def sample(circuit, shots: int = 1, seed: int | None = None) -> list[int]:
    """Counts per basis state after `shots` full-set measurements (a "drop")."""
    columns = validate(circuit)
    if any("M" in c for c in columns):
        counts = density_matrix(circuit).sample_counts(shots) if seed is None else \
            _seeded_dm_counts(circuit, shots, seed)
    else:
        qc = build_circuit(columns)
        qc.measure_all()
        result = StatevectorSampler(seed=seed).run([qc], shots=shots).result()
        counts = result[0].data.meas.get_counts()
    out = [0] * DIM
    for bits, n in counts.items():
        out[int(bits.replace(" ", ""), 2)] += n
    return out


def _seeded_dm_counts(circuit, shots, seed):
    dm = density_matrix(circuit)
    dm.seed(seed)
    return dm.sample_counts(shots)


def column_infos(circuit) -> list[dict]:
    return [analyze_column(c) for c in validate(circuit)]
