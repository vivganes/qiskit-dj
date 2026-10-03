"""Physics, free-play example and API tests (Qiskit SDK v2 state vector simulation)."""
import json
import re
from pathlib import Path

import numpy as np
import pytest
from qiskit.quantum_info import DensityMatrix, Statevector

from app import app
from qdj import simulator as sim

S2 = np.sqrt(0.5)


def circ(*columns):
    """circ("H.", "CX") -> circuit; '.' empty, C = control, M = measure."""
    names = {"C": "CTRL"}
    return [[None if ch == "." else {"type": names.get(ch, ch)} for ch in col] for col in columns]


def probs(*columns):
    return sim.probabilities(sim.statevector(circ(*columns)))


# ---- basics ----------------------------------------------------------------

def test_two_qubits_four_tracks():
    assert sim.NUM_QUBITS == 2 and sim.DIM == 4 and sim.NUM_STEPS == 10


def test_empty_circuit_stays_on_00():
    np.testing.assert_allclose(probs(), [1, 0, 0, 0], atol=1e-12)


def test_labels_read_left_to_right():
    # X on q0 only -> |10>, which is basis index 2 (q0 is the leftmost bit).
    np.testing.assert_allclose(probs("X."), [0, 0, 1, 0], atol=1e-12)
    np.testing.assert_allclose(probs(".X"), [0, 1, 0, 0], atol=1e-12)


def test_h_makes_even_superposition_and_twice_undoes_it():
    np.testing.assert_allclose(probs("H."), [.5, 0, .5, 0], atol=1e-12)
    np.testing.assert_allclose(probs("H.", "H."), [1, 0, 0, 0], atol=1e-12)
    np.testing.assert_allclose(probs("HH"), [.25] * 4, atol=1e-12)


def test_y_flips_with_phase():
    sv = sim.statevector(circ("Y."))
    np.testing.assert_allclose(sv.data, [0, 0, 1j, 0], atol=1e-12)


def test_z_changes_phase_not_probability():
    sv = sim.statevector(circ("H.", "Z."))
    np.testing.assert_allclose(sim.probabilities(sv), [.5, 0, .5, 0], atol=1e-12)
    np.testing.assert_allclose(sv.data, [S2, 0, -S2, 0], atol=1e-12)


def test_h_z_h_is_x_interference():
    np.testing.assert_allclose(probs("H.", "Z.", "H."), [0, 0, 1, 0], atol=1e-12)


# ---- CNOT / entanglement ---------------------------------------------------

@pytest.mark.parametrize("start,expected", [("..", 0), (".X", 1), ("X.", 3), ("XX", 2)])
def test_cnot_truth_table(start, expected):
    cols = [start] if start != ".." else []
    p = probs(*cols, "CX")
    assert p[expected] == pytest.approx(1)


def test_ctrl_works_from_either_qubit():
    assert probs("XX", "XC")[1] == pytest.approx(1)  # q1 controls q0: |11> -> |01>


def test_bell_pair_always_agrees():
    np.testing.assert_allclose(probs("H.", "CX"), [.5, 0, 0, .5], atol=1e-12)
    np.testing.assert_allclose(probs("H.", "CX", ".X"), [0, .5, .5, 0], atol=1e-12)


def test_ctrl_controls_every_other_gate_in_column():
    # one ctrl on q0, targets: only q1 is left, so check controlled-Z and controlled-Y
    sv = sim.statevector(circ("XX", "CZ"))
    np.testing.assert_allclose(sv.data, [0, 0, 0, -1], atol=1e-12)
    sv = sim.statevector(circ("X.", "CY"))
    np.testing.assert_allclose(sv.data, [0, 0, 0, 1j], atol=1e-12)


def test_ctrl_without_target_does_nothing_and_warns():
    assert probs("C.")[0] == pytest.approx(1)
    assert sim.analyze_column(sim.validate(circ("C."))[0])["warnings"]


def test_probabilities_normalised_for_random_circuits():
    rng = np.random.default_rng(1)
    kinds = ".HXYZC"
    for _ in range(50):
        cols = ["".join(rng.choice(list(kinds), 2)) for _ in range(rng.integers(0, 10))]
        assert probs(*cols).sum() == pytest.approx(1)


# ---- free-play examples ----------------------------------------------------

def load_examples():
    text = (Path(__file__).parent.parent / "static/js/examples.js").read_text()
    return {n: s for n, s in re.findall(r"name: '([^']+)', set: '([^']+)'", text)}


def decode(text):
    return circ(*text.split("|"))


EXPECTED = {
    "Coin flip": [.5, 0, .5, 0],
    "Dice roll": [.25] * 4,
    "Interference": [0, 0, 1, 0],
}


def test_examples_are_exactly_the_documented_ones():
    assert set(load_examples()) == set(EXPECTED)


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_example_probabilities(name):
    circuit = decode(load_examples()[name])
    np.testing.assert_allclose(sim.probabilities(sim.statevector(circuit)), EXPECTED[name], atol=1e-12)
    np.testing.assert_allclose(sim.exact_distribution(circuit), EXPECTED[name], atol=1e-12)


def test_interference_cancels_at_the_middle_step():
    states = sim.step_states(decode(load_examples()["Interference"]))
    np.testing.assert_allclose(sim.probabilities(states[2]), [.5, 0, .5, 0], atol=1e-12)
    np.testing.assert_allclose(sim.probabilities(states[3]), [0, 0, 1, 0], atol=1e-12)


# ---- state vector vs density matrix ----------------------------------------

@pytest.mark.parametrize("cols", [(), ("H.",), ("HH", "CX"), ("H.", "Z.", "H."), ("H.", "CX", ".Y", "ZH")])
def test_state_vector_matches_density_matrix(cols):
    circuit = circ(*cols)
    sv = sim.statevector(circuit)
    np.testing.assert_allclose(sim.density_matrix(circuit).data, DensityMatrix(sv).data, atol=1e-12)
    np.testing.assert_allclose(sim.exact_distribution(circuit), sim.probabilities(sv), atol=1e-12)


def test_mid_set_measurement_destroys_interference():
    # H, measure, H: 50/50 instead of returning to |00>
    np.testing.assert_allclose(sim.exact_distribution(circ("H.", "M.", "H.")), [.5, 0, .5, 0], atol=1e-12)
    np.testing.assert_allclose(sim.exact_distribution(circ("H.", "H.")), [1, 0, 0, 0], atol=1e-12)


def test_measuring_a_bell_pair_keeps_qubits_agreeing():
    dist = sim.exact_distribution(circ("H.", "CX", "M."))
    np.testing.assert_allclose(dist, [.5, 0, 0, .5], atol=1e-12)
    rho = sim.density_matrix(circ("H.", "CX", "M."))
    assert abs(rho.data[0, 3]) < 1e-12          # coherence is gone
    assert rho.purity() == pytest.approx(.5)


def test_measurement_of_definite_state_changes_nothing():
    np.testing.assert_allclose(sim.exact_distribution(circ("X.", "M.")), [0, 0, 1, 0], atol=1e-12)


def test_step_states_have_one_state_per_step():
    states = sim.step_states(circ("H.", "CX"))
    assert len(states) == sim.NUM_STEPS + 1
    assert isinstance(states[0], Statevector)
    np.testing.assert_allclose(states[0].data, [1, 0, 0, 0])
    np.testing.assert_allclose(states[10].data, states[2].data)


# ---- drops -----------------------------------------------------------------

def test_drop_gives_one_outcome_from_the_possible_ones():
    for seed in range(20):
        counts = sim.sample(circ("H.", "CX"), 1, seed=seed)
        assert sum(counts) == 1 and (counts[0] or counts[3])


def test_many_drops_follow_the_probabilities():
    counts = np.array(sim.sample(circ("HH"), 4000, seed=7)) / 4000
    np.testing.assert_allclose(counts, [.25] * 4, atol=0.04)
    assert sim.sample(circ("X."), 50) == [0, 0, 50, 0]


def test_drop_with_mid_set_measurement():
    counts = sim.sample(circ("H.", "M.", "H."), 2000, seed=3)
    assert counts[1] == counts[3] == 0 and abs(counts[0] - 1000) < 150


# ---- validation and API ----------------------------------------------------

@pytest.mark.parametrize("bad", [
    [[{"type": "S"}, None]], [[None]], [[None, None, None]], "H", [[None, None]] * 11, [[{"nope": 1}, None]],
])
def test_bad_circuits_rejected(bad):
    with pytest.raises(sim.CircuitError):
        sim.validate(bad)


@pytest.fixture
def client():
    return app.test_client()


def wire(*columns):
    return json.loads(json.dumps(circ(*columns)))


def test_index_page_served(client):
    html = client.get("/").get_data(as_text=True)
    assert "Quantum DJ Booth" in html and "Drop to the floor" in html
    assert "rahman" not in html.lower()


def test_static_js_served(client):
    assert client.get("/static/js/app.js").status_code == 200


def test_api_compute(client):
    r = client.post("/api/compute", json={"circuit": wire("H.", "CX")})
    data = r.get_json()
    assert r.status_code == 200
    np.testing.assert_allclose(data["probabilities"], [.5, 0, 0, .5], atol=1e-9)
    np.testing.assert_allclose(data["exact"], data["probabilities"], atol=1e-9)
    assert len(data["states"]) == 11 and len(data["columns"]) == 10
    assert data["columns"][1]["controls"] == [0] and data["columns"][1]["targets"] == [1]


def test_api_drop_single_and_many(client):
    one = client.post("/api/drop", json={"circuit": wire("X.")}).get_json()
    assert one["index"] == 2 and one["counts"] == [0, 0, 1, 0]
    many = client.post("/api/drop", json={"circuit": wire("H."), "shots": 100}).get_json()
    assert sum(many["counts"]) == 100 and many["counts"][1] == many["counts"][3] == 0


def test_api_drop_at_earlier_step(client):
    r = client.post("/api/drop", json={"circuit": wire("X.", ".X"), "steps": 1}).get_json()
    assert r["index"] == 2


@pytest.mark.parametrize("payload", [
    {"circuit": [[{"type": "T"}, None]]},
    {"circuit": [[{"type": "H"}, None]], "shots": 0},
    {"circuit": [[{"type": "H"}, None]], "steps": 99},
])
def test_api_rejects_bad_input(client, payload):
    assert client.post("/api/drop", json=payload).status_code == 400


def test_api_reports_qiskit_engine(client):
    import qiskit
    for path in ("/api/compute", "/api/drop"):
        data = client.post(path, json={"circuit": wire("H.")}).get_json()
        assert data["engine"]["name"] == "qiskit"
        assert data["engine"]["version"] == qiskit.__version__


def test_browser_does_no_quantum_simulation():
    """The JS only draws; any gate maths in it would mean the browser is simulating."""
    js = "".join(p.read_text() for p in (Path(__file__).parent.parent / "static/js").glob("*.js"))
    for marker in ("SQRT1_2", "applyControlled", "exactDistribution", "Q.simulate", "Q.sample", "runShots(circuit"):
        assert marker not in js
    assert "/api/compute" in js and "/api/drop" in js
