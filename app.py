"""Flask app: serves the 2-qubit booth and the Qiskit-backed API."""
import qiskit
from flask import Flask, jsonify, render_template, request

from qdj import simulator as sim

app = Flask(__name__)


@app.errorhandler(sim.CircuitError)
def bad_circuit(err):
    return jsonify(error=str(err)), 400


def _circuit():
    body = request.get_json(silent=True) or {}
    return body.get("circuit", []), body


ENGINE = {"name": "qiskit", "version": qiskit.__version__, "backend": "local statevector simulator"}


def _round(a):
    return [round(float(x), 12) + 0.0 for x in a]


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/compute")
def compute():
    """State vector after every step, probabilities, and the exact outcome distribution."""
    circuit, _ = _circuit()
    states = sim.step_states(circuit)
    return jsonify(
        engine=ENGINE,
        states=[{"re": _round(s.data.real), "im": _round(s.data.imag)} for s in states],
        probabilities=_round(sim.probabilities(states[-1])),
        exact=_round(sim.exact_distribution(circuit)),
        columns=sim.column_infos(circuit) + [sim.analyze_column([None] * sim.NUM_QUBITS)] * (
            sim.NUM_STEPS - len(circuit)),
    )


@app.post("/api/drop")
def drop():
    """Measure the state after `steps` columns. One shot returns the outcome; more return counts."""
    circuit, body = _circuit()
    steps = body.get("steps", sim.NUM_STEPS)
    shots = body.get("shots", 1)
    if not isinstance(steps, int) or not 0 <= steps <= sim.NUM_STEPS:
        raise sim.CircuitError("steps out of range")
    if not isinstance(shots, int) or not 1 <= shots <= 10000:
        raise sim.CircuitError("shots must be between 1 and 10000")
    circuit = circuit[:steps]
    counts = sim.sample(circuit, shots)
    probs = sim.exact_distribution(circuit)
    return jsonify(engine=ENGINE, index=counts.index(max(counts)) if shots == 1 else None, counts=counts,
                   probabilities=_round(probs))


if __name__ == "__main__":
    app.run(debug=True)
