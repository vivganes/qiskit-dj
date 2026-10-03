/* Quantum DJ — UI controller. */
(function () {
  'use strict';

  // Page-level settings, e.g. <script>window.QDJ_CONFIG = { qubits: 2, steps: 10, trackSet: 'booth' }</script>
  const CONFIG = window.QDJ_CONFIG || {};
  const Q = window.Quantum;
  const { Engine, TRACK_SETS } = window.QuantumAudio;
  const TRACK_SET = TRACK_SETS[CONFIG.trackSet || 'disco'];
  const TRACKS = TRACK_SET.tracks;
  const BPM = TRACK_SET.bpm;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = CONFIG.storeKey || 'quantum-dj-v1';
  if (TRACKS.length !== Q.DIM) console.error(`Track set has ${TRACKS.length} tracks but ${Q.NUM_QUBITS} qubits need ${Q.DIM}.`);
  const STEPS = Q.NUM_STEPS;
  const BEAT_MS = 60000 / BPM;
  const DIRS = ['front', 'front-right', 'right', 'behind-right', 'behind', 'behind-left', 'left', 'front-left'];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const engine = new Engine(TRACK_SET);
  const app = {
    circuit: Q.emptyCircuit(),
    playhead: STEPS,        // number of columns applied to what you hear
    floor: null,            // { index, prob } after a drop
    solo: null,             // previewed track index
    tool: null,             // armed gate type, or 'ERASE'
    history: [],
    shots: null,            // { counts, total }
    autoTimer: null,
    focus: null,            // { col, q } to refocus after a re-render
    sim: { states: Array.from({ length: STEPS + 1 }, () => Q.zeroState()), columns: [], measurements: [] },
    exact: new Float64Array(Q.DIM).fill(0),
    freeText: '',
    version: 0,             // guards against out-of-order /api/compute replies
  };

  // --------------------------------------------------------------- helpers
  const fmtPct = (p) => {
    const v = Math.round(p * 1000) / 10;
    return (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)) + '%';
  };
  const dirWord = (deg) => DIRS[Math.round(deg / 45) % 8];
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  /** Number of columns up to and including the last one with a gate. */
  function usedColumns() {
    for (let c = STEPS - 1; c >= 0; c--) if (app.circuit[c].some(Boolean)) return c + 1;
    return 0;
  }
  const isLive = () => app.playhead >= usedColumns();
  const hearingState = () => app.sim.states[Math.min(app.playhead, STEPS)];

  let statusTimer = null;
  function say(message) {
    const s = $('deck-status');
    s.textContent = message;
    s.dataset.transient = '1';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { delete s.dataset.transient; renderWarnings(); }, 3500);
  }

  // --------------------------------------------------------------- Flask API
  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }
  const cleanCircuit = () => app.circuit.map((col) => col.map((c) => (c ? { type: c.type } : null)));
  const toState = (s) => ({ re: Float64Array.from(s.re), im: Float64Array.from(s.im) });

  // --------------------------------------------------------------- storage
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ free: Q.encodeCircuit(app.circuit) }));
    } catch (e) { /* storage may be disabled (private mode); the app still works */ }
  }

  function load() {
    try {
      app.freeText = JSON.parse(localStorage.getItem(STORE_KEY) || '{}').free || '';
    } catch (e) { /* ignore corrupt storage */ }
  }

  // --------------------------------------------------------------- model updates
  /** Ask the server (Qiskit) for the state after every step and the exact outcome distribution. */
  async function recompute() {
    const version = ++app.version;
    try {
      const r = await api('/api/compute', { circuit: cleanCircuit() });
      if (version !== app.version) return;
      app.sim = { states: r.states.map(toState), columns: r.columns, measurements: [] };
      app.exact = Float64Array.from(r.exact);
    } catch (e) {
      say('Could not reach the simulator: ' + e.message);
    }
  }

  /** Call after any edit to the board. */
  async function circuitChanged() {
    stopAuto();
    app.playhead = STEPS;
    app.floor = null;
    app.solo = null;
    app.shots = null;
    save();
    await recompute();
    render();
  }

  function setCell(col, q, cell) {
    const cur = app.circuit[col][q];
    app.circuit[col][q] = cell;
    return true;
  }

  function resetTake() {
    app.playhead = STEPS;
    app.floor = null;
    app.solo = null;
    app.shots = null;
    app.history = [];
  }

  // --------------------------------------------------------------- audio
  function updateAudio() {
    let mix;
    if (app.floor) {
      mix = TRACKS.map((_, i) => ({ gain: i === app.floor.index ? 1 : 0, phaseDeg: 0 }));
    } else if (app.solo != null) {
      mix = TRACKS.map((_, i) => ({ gain: i === app.solo ? 1 : 0, phaseDeg: 0 }));
    } else {
      const s = hearingState();
      const ph = Q.phases(s);
      mix = TRACKS.map((_, i) => ({ gain: Math.hypot(s.re[i], s.im[i]), phaseDeg: ph[i] }));
    }
    engine.setMix(mix);
  }

  function startMusic() {
    if (!engine.isRunning) {
      engine.start();
      updateAudio();
      renderSoundButton();
    }
  }

  function renderSoundButton() {
    const b = $('btn-sound');
    b.setAttribute('aria-pressed', String(engine.isRunning));
    b.innerHTML = engine.isRunning ? '<span aria-hidden="true">■</span> Stop music' : '<span aria-hidden="true">▶</span> Start music';
  }

  // --------------------------------------------------------------- rendering
  function render() {
    renderPalette();
    renderBoard();
    renderTransport();
    renderRecords();
    renderFloorText();
    renderHistory();
    renderChart();
    renderWarnings();
    updateAudio();
  }

  /** Lighter update when only the playhead / floor changed. */
  function renderHearing() {
    renderBoard();
    renderTransport();
    renderRecords();
    renderFloorText();
    renderHistory();
    updateAudio();
  }

  function makePuck(cell, opts = {}) {
    const g = Q.GATES[cell.type];
    const p = el('div', 'puck ' + (cell.hidden ? 'hidden-gate' : g.family));
    if (cell.hidden) {
      p.textContent = '?';
    } else if (cell.type === 'CTRL') {
      p.classList.add('ctrl');
    } else {
      p.textContent = g.label;
    }
    if (opts.result != null) p.appendChild(el('span', 'result', '=' + opts.result));
    return p;
  }

  function renderPalette() {
    const pal = $('palette');
    pal.textContent = '';
    Q.PALETTE_ORDER.forEach((type) => {
      const g = Q.GATES[type];
      const b = el('button', 'pal-btn');
      b.dataset.type = type;
      b.setAttribute('aria-pressed', String(app.tool === type));
      b.setAttribute('aria-label', `${g.name} gate`);
      b.title = `${g.name}: ${g.info}`;
      b.appendChild(makePuck({ type }));
      pal.appendChild(b);
    });
    $('btn-erase').setAttribute('aria-pressed', String(app.tool === 'ERASE'));
  }

  function renderBoard() {
    const board = $('board');
    board.textContent = '';
    const labels = el('div', 'qlabels');
    for (let q = 0; q < Q.NUM_QUBITS; q++) {
      const l = el('div', 'qlabel', 'q' + q);
      l.appendChild(el('span', 'ket', '|0⟩'));
      labels.appendChild(l);
    }
    board.appendChild(labels);

    const used = usedColumns();
    const stepping = app.playhead < used;
    const measured = new Map();

    for (let c = 0; c < STEPS; c++) {
      const col = el('div', 'bcol');
      col.dataset.col = c;
      const info = app.sim.columns[c] || { warnings: [] };
      if (info.warnings.length) col.classList.add('warn');
      if (stepping && c >= app.playhead) col.classList.add('future');
      if (stepping && c === app.playhead - 1) col.classList.add('current');
      if (stepping && app.playhead === 0 && c === 0) col.classList.add('at-start');

      const head = el('button', 'bcol-head', String(c + 1));
      head.dataset.head = c;
      head.title = `Hear the mix after step ${c + 1}`;
      col.appendChild(head);

      const hidden = app.circuit[c].some((x) => x && x.hidden);
      const involved = info.controls.concat(info.targets, info.swaps.length === 2 ? info.swaps : []);
      if (!hidden && involved.length > 1 && (info.controls.length || info.swaps.length === 2)) {
        const lo = Math.min(...involved), hi = Math.max(...involved);
        const line = el('div', 'connector');
        line.style.top = `calc(22px + var(--cell) * ${lo + 0.5})`;
        line.style.height = `calc(var(--cell) * ${hi - lo})`;
        col.appendChild(line);
      }

      for (let q = 0; q < Q.NUM_QUBITS; q++) {
        const cell = app.circuit[c][q];
        const slot = el('button', 'slot');
        slot.dataset.col = c;
        slot.dataset.q = q;
        slot.setAttribute('role', 'gridcell');
        slot.appendChild(el('span', 'groove'));
        let label = `Step ${c + 1}, qubit q${q}: `;
        if (cell) {
          const key = c + ',' + q;
          const showResult = cell.type === 'M' && measured.has(key) && (!stepping || c < app.playhead);
          slot.appendChild(makePuck(cell, { result: showResult ? measured.get(key) : null }));
          label += cell.hidden ? 'hidden mystery gate' : Q.GATES[cell.type].name;
          if (showResult) label += `, measured ${measured.get(key)}`;
        } else {
          label += 'empty';
        }
        slot.setAttribute('aria-label', label);
        col.appendChild(slot);
      }
      board.appendChild(col);
    }
    if (app.focus) {
      const s = board.querySelector(`.slot[data-col="${app.focus.col}"][data-q="${app.focus.q}"]`);
      if (s) s.focus({ preventScroll: true });
      app.focus = null;
    }
  }

  function renderTransport() {
    const used = usedColumns();
    const label = $('playhead-label');
    if (used === 0) label.textContent = 'Empty deck: hearing ' + Q.ketLabel(0);
    else if (app.playhead >= used) label.textContent = 'Hearing: the whole set';
    else if (app.playhead === 0) label.textContent = 'Hearing: the start (before step 1)';
    else label.textContent = `Hearing: after step ${app.playhead} of ${used}`;
    $('btn-first').disabled = used === 0 || app.playhead === 0;
    $('btn-back').disabled = used === 0 || app.playhead === 0;
    $('btn-fwd').disabled = isLive();
    $('btn-last').disabled = isLive();
    $('btn-auto').disabled = used === 0;
    $('btn-auto').setAttribute('aria-pressed', String(!!app.autoTimer));
  }

  function renderWarnings() {
    const s = $('deck-status');
    if (s.dataset.transient) return;
    const msgs = [];
    app.sim.columns.forEach((info, c) => info.warnings.forEach((w) => msgs.push(`Step ${c + 1}: ${w}`)));
    s.textContent = msgs[0] || '';
  }

  // records -------------------------------------------------------------
  const recordEls = [];
  function buildRecords() {
    const list = $('records');
    TRACKS.forEach((t, i) => {
      const li = el('li');
      const b = el('button', 'record');
      b.style.setProperty('--track', t.color);
      b.dataset.i = i;
      const wrap = el('div', 'disc-wrap');
      const disc = el('div', 'disc');
      const lab = el('div', 'disc-label');
      disc.appendChild(lab);
      const arrow = el('div', 'phase-arrow');
      wrap.append(disc, arrow);
      const main = el('div', 'rec-main');
      const title = el('div', 'rec-title');
      const name = el('span', 'rec-name', t.name);
      title.append(el('span', 'rec-ket', Q.ketLabel(i)), name);
      const meter = el('div', 'meter');
      const fill = el('div', 'meter-fill');
      meter.appendChild(fill);
      main.append(title, meter);
      const nums = el('div', 'rec-nums');
      const prob = el('div', 'rec-prob');
      const phase = el('div', 'rec-phase');
      nums.append(prob, phase);
      b.append(wrap, main, nums);
      b.title = `${t.name} — ${t.style}. Click to preview.`;
      b.addEventListener('click', () => {
        startMusic();
        app.floor = null;
        app.solo = app.solo === i ? null : i;
        renderHearing();
        if (app.solo != null) say(`Previewing ${Q.ketLabel(i)} ${TRACKS[i].name} on its own. Click it again to go back to the mix.`);
      });
      li.appendChild(b);
      list.appendChild(li);
      recordEls.push({ b, disc, lab, arrow, fill, prob, phase, name });
    });
  }

  /** Call after changing TRACKS[i].name / .style (e.g. when a song file is loaded). */
  function refreshTracks() {
    recordEls.forEach((r, i) => {
      r.name.textContent = TRACKS[i].name;
      r.b.title = `${TRACKS[i].name} — ${TRACKS[i].style}. Click to preview.`;
    });
    renderRecords();
    renderFloorText();
    renderHistory();
    renderChart();
  }

  function renderRecords() {
    const s = hearingState();
    const probs = Q.probabilities(s);
    const ph = Q.phases(s);
    recordEls.forEach((r, i) => {
      const p = probs[i];
      const silent = p < 1e-6;
      r.b.classList.toggle('silent', silent);
      r.b.classList.toggle('solo', app.solo === i);
      r.b.classList.toggle('winner', !!app.floor && app.floor.index === i);
      r.fill.style.width = (p * 100).toFixed(2) + '%';
      r.prob.textContent = fmtPct(p);
      r.phase.textContent = silent ? '—' : `${Math.round(ph[i])}° ${dirWord(ph[i])}`;
      r.arrow.style.transform = `rotate(${ph[i]}deg)`;
      r.lab.style.transform = `scale(${0.55 + 0.45 * Math.sqrt(p)})`;
      const audible = app.floor ? app.floor.index === i : app.solo != null ? app.solo === i : !silent;
      r.disc.classList.toggle('spinning', engine.isRunning && audible && !reducedMotion);
      r.b.setAttribute('aria-label', `${Q.ketLabel(i)} ${TRACKS[i].name}: ${fmtPct(p)} chance` +
        (silent ? '' : `, phase ${Math.round(ph[i])} degrees, ${dirWord(ph[i])}`) + '. Click to preview.');
    });
  }

  // floor text & history --------------------------------------------------
  function renderFloorText() {
    const banner = $('floor-banner');
    if (app.floor) {
      const t = TRACKS[app.floor.index];
      banner.textContent = `The floor hears ${Q.ketLabel(app.floor.index)} ${t.name} — it had a ${fmtPct(app.floor.prob)} chance.`;
    } else if (app.solo != null) {
      banner.textContent = `Previewing ${Q.ketLabel(app.solo)} ${TRACKS[app.solo].name}`;
    } else if (!engine.isRunning) {
      banner.textContent = 'Press "Start music", then "Drop to the floor" to measure.';
    } else {
      banner.textContent = 'The DJ is cueing the mix in the headphones… the floor is waiting for the drop.';
    }
    $('btn-cue').disabled = !app.floor && app.solo == null;
  }

  function renderHistory() {
    const ol = $('drop-history');
    ol.textContent = '';
    app.history.forEach((i) => {
      const li = el('li', null, Q.ketLabel(i));
      li.style.setProperty('--track', TRACKS[i].color);
      li.title = TRACKS[i].name;
      ol.appendChild(li);
    });
    if (!app.history.length) ol.appendChild(el('li', null, 'none yet')).style.setProperty('--track', 'transparent');
  }

  // chart -------------------------------------------------------------------
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };

  function renderChart() {
    const chart = $('chart');
    chart.textContent = '';
    const W = 360, H = 190, ml = 36, mr = 6, mt = 8, mb = 26;
    const pw = W - ml - mr, ph = H - mt - mb;
    const shots = app.shots;
    const measured = shots ? shots.counts.map((n) => n / shots.total) : null;
    const predicted = Array.from(app.exact);
    const maxV = Math.max(...predicted, ...(measured || [0]));
    const yMax = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1].find((v) => v >= maxV - 1e-9) || 1;
    const y = (v) => mt + ph - (v / yMax) * ph;
    const band = pw / Q.DIM;
    const barW = Math.min(24, band * 0.6);

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': shots ? `Results of ${shots.total} drops compared with the predicted chances` : 'Predicted chances for each track' });
    const grid = svgEl('g', { class: 'grid' });
    for (let k = 0; k <= 4; k++) {
      const v = (yMax / 4) * k;
      const yy = y(v);
      if (k > 0) grid.appendChild(svgEl('line', { x1: ml, x2: W - mr, y1: yy, y2: yy }));
      const t = svgEl('text', { x: ml - 6, y: yy + 4, 'text-anchor': 'end', class: 'axis-text' });
      t.textContent = Math.round(v * 100) + '%';
      grid.appendChild(t);
    }
    svg.appendChild(grid);
    svg.appendChild(svgEl('line', { x1: ml, x2: W - mr, y1: y(0), y2: y(0), class: 'baseline' }));

    for (let i = 0; i < Q.DIM; i++) {
      const cx = ml + band * (i + 0.5);
      const g = svgEl('g', {});
      const hit = svgEl('rect', { x: cx - band / 2, y: mt, width: band, height: ph + mb, class: 'hit', tabindex: 0 });
      hit.setAttribute('aria-label', tooltipText(i, measured, predicted).join(', '));
      g.appendChild(hit);
      if (measured && measured[i] > 0) {
        const top = y(measured[i]);
        const h = y(0) - top;
        const r = Math.min(4, h, barW / 2);
        const x0 = cx - barW / 2, x1 = cx + barW / 2, yb = y(0);
        g.appendChild(svgEl('path', { class: 'bar',
          d: `M${x0},${yb} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x1 - r} Q${x1},${top} ${x1},${top + r} V${yb} Z` }));
      } else {
        g.appendChild(svgEl('g', { class: 'bar' })); // keeps the hover sibling rule simple
      }
      if (predicted[i] > 1e-6) {
        const py = y(predicted[i]);
        g.appendChild(svgEl('line', { class: 'pred', x1: cx - barW / 2 - 4, x2: cx + barW / 2 + 4, y1: py, y2: py }));
      }
      const xt = svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'x-text' });
      xt.textContent = Q.ketLabel(i);
      g.appendChild(xt);
      const show = () => showTooltip(i, measured, predicted, cx / W);
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', hideTooltip);
      hit.addEventListener('blur', hideTooltip);
      svg.appendChild(g);
    }
    if (!shots) {
      const t = svgEl('text', { x: ml + pw / 2, y: mt + ph * 0.42, 'text-anchor': 'middle', class: 'empty-text' });
      t.textContent = 'Lines show the prediction. Run drops to compare.';
      svg.appendChild(t);
    }
    chart.appendChild(svg);
    $('shots-sub').textContent = shots
      ? `${shots.total.toLocaleString()} drops of the whole set. Bars: what happened. Lines: what the math predicts.`
      : 'Each drop measures the whole set once. Compare what happens with what the math predicts.';
    renderTable(measured, predicted);
  }

  function tooltipText(i, measured, predicted) {
    const rows = [`${Q.ketLabel(i)} ${TRACKS[i].name}`];
    if (measured) rows.push(`measured ${app.shots.counts[i]} of ${app.shots.total} (${fmtPct(measured[i])})`);
    rows.push(`predicted ${fmtPct(predicted[i])}`);
    return rows;
  }

  function showTooltip(i, measured, predicted, fx) {
    const tt = $('chart-tooltip');
    tt.textContent = '';
    const head = el('div', null, `${Q.ketLabel(i)} ${TRACKS[i].name}`);
    tt.appendChild(head);
    if (measured) {
      const row = el('div', 'tt-row');
      const key = el('span', 'tt-key');
      key.style.background = 'var(--series-1)';
      row.append(key, el('strong', null, fmtPct(measured[i])), el('span', null, `measured (${app.shots.counts[i]} / ${app.shots.total})`));
      tt.appendChild(row);
    }
    const row2 = el('div', 'tt-row');
    const key2 = el('span', 'tt-key');
    key2.style.background = 'var(--text-primary)';
    row2.append(key2, el('strong', null, fmtPct(predicted[i])), el('span', null, 'predicted'));
    tt.appendChild(row2);
    tt.hidden = false;
    const chartBox = $('chart').getBoundingClientRect();
    const rootBox = tt.parentElement.getBoundingClientRect();
    const x = chartBox.left - rootBox.left + fx * chartBox.width;
    const left = Math.max(0, Math.min(x - tt.offsetWidth / 2, rootBox.width - tt.offsetWidth));
    tt.style.left = left + 'px';
    tt.style.top = (chartBox.top - rootBox.top - 4) + 'px';
  }
  function hideTooltip() { $('chart-tooltip').hidden = true; }

  function renderTable(measured, predicted) {
    const table = $('chart-table');
    table.textContent = '';
    const head = el('tr');
    ['Track', 'Name', 'Measured', 'Measured %', 'Predicted %'].forEach((h) => head.appendChild(el('th', null, h)));
    table.appendChild(head);
    for (let i = 0; i < Q.DIM; i++) {
      const tr = el('tr');
      tr.append(
        el('td', null, Q.ketLabel(i)), el('td', null, TRACKS[i].name),
        el('td', null, measured ? String(app.shots.counts[i]) : '—'),
        el('td', null, measured ? fmtPct(measured[i]) : '—'),
        el('td', null, fmtPct(predicted[i])),
      );
      table.appendChild(tr);
    }
  }

  // --------------------------------------------------------------- actions
  async function drop() {
    startMusic();
    stopAuto();
    const steps = Math.min(app.playhead, STEPS);
    try {
      const r = await api('/api/drop', { circuit: cleanCircuit(), steps });
      app.floor = { index: r.index, prob: r.probabilities[r.index] };
    } catch (e) { say('Could not drop: ' + e.message); return; }
    app.solo = null;
    app.history.unshift(app.floor.index);
    app.history.length = Math.min(app.history.length, 16);
    flashUntil = performance.now() + 600;
    renderHearing();
  }

  async function runShots(n) {
    try {
      const r = await api('/api/drop', { circuit: cleanCircuit(), shots: n });
      app.shots = { counts: r.counts, total: n };
    } catch (e) { say('Could not run the set: ' + e.message); return; }
    renderChart();
  }

  function setPlayhead(p) {
    const used = usedColumns();
    app.playhead = Math.max(0, Math.min(p, used >= STEPS ? STEPS : used));
    if (app.playhead >= used) app.playhead = STEPS;
    app.floor = null;
    app.solo = null;
    renderHearing();
  }

  function stopAuto() {
    if (app.autoTimer) {
      clearInterval(app.autoTimer);
      app.autoTimer = null;
    }
  }

  function toggleAuto() {
    if (app.autoTimer) { stopAuto(); renderTransport(); return; }
    startMusic();
    setPlayhead(0);
    app.autoTimer = setInterval(() => {
      if (app.playhead >= usedColumns()) { stopAuto(); renderTransport(); return; }
      setPlayhead(app.playhead + 1);
    }, BEAT_MS * 4);
    renderTransport();
  }

  function share() {
    const text = Q.encodeCircuit(app.circuit);
    const url = location.href.split('#')[0] + '#set=' + encodeURIComponent(text);
    const done = () => say('Link copied! Anyone who opens it gets this board in Free play.');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, () => window.prompt('Copy this link:', url));
    } else {
      window.prompt('Copy this link:', url);
    }
  }

  function describeGate(type) {
    const g = Q.GATES[type];
    const info = $('gate-info');
    info.textContent = '';
    info.append(el('b', null, `${g.label} — ${g.name}. `), document.createTextNode(g.info));
  }

  // --------------------------------------------------------------- board input
  let drag = null;
  let suppressClickUntil = 0; // a drag must not also count as a click
  const clickSuppressed = () => performance.now() < suppressClickUntil;

  function slotAt(x, y) {
    const e = document.elementFromPoint(x, y);
    return e && e.closest('.slot');
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const pal = e.target.closest('.pal-btn');
    const slot = e.target.closest('.slot');
    if (pal && !pal.disabled) {
      drag = { from: 'palette', type: pal.dataset.type, x: e.clientX, y: e.clientY, moved: false };
    } else if (slot) {
      const col = +slot.dataset.col, q = +slot.dataset.q;
      const cell = app.circuit[col][q];
      if (cell) drag = { from: 'board', col, q, cell, x: e.clientX, y: e.clientY, moved: false };
    }
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
    const ghost = $('drag-ghost');
    if (!drag.moved) {
      drag.moved = true;
      ghost.textContent = '';
      const cell = drag.from === 'palette' ? { type: drag.type } : drag.cell;
      ghost.appendChild(makePuck(cell));
      ghost.hidden = false;
      document.body.style.cursor = 'grabbing';
    }
    e.preventDefault();
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
    document.querySelectorAll('.slot.drop-target').forEach((s) => s.classList.remove('drop-target'));
    const s = slotAt(e.clientX, e.clientY);
    if (s) s.classList.add('drop-target');
  }

  function onPointerUp(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    suppressClickUntil = performance.now() + 350;
    $('drag-ghost').hidden = true;
    document.body.style.cursor = '';
    document.querySelectorAll('.slot.drop-target').forEach((s) => s.classList.remove('drop-target'));
    const target = slotAt(e.clientX, e.clientY);
    if (d.from === 'palette') {
      if (!target) return;
      const col = +target.dataset.col, q = +target.dataset.q;
      const cell = { type: d.type };
      if (setCell(col, q, cell)) {
        describeGate(d.type);
        circuitChanged();
      }
    } else {
      if (target) {
        const col = +target.dataset.col, q = +target.dataset.q;
        if (col === d.col && q === d.q) return;
        app.circuit[d.col][d.q] = null;
        app.circuit[col][q] = d.cell;
      } else {
        app.circuit[d.col][d.q] = null;
        say('Gate removed.');
      }
      circuitChanged();
    }
  }

  function onBoardClick(e) {
    if (clickSuppressed()) return;
    const head = e.target.closest('.bcol-head');
    if (head) { stopAuto(); startMusic(); setPlayhead(+head.dataset.head + 1); return; }
    const slot = e.target.closest('.slot');
    if (!slot) return;
    const col = +slot.dataset.col, q = +slot.dataset.q;
    const cell = app.circuit[col][q];
    app.focus = { col, q };
    if (app.tool === 'ERASE') {
      if (cell) { app.circuit[col][q] = null; circuitChanged(); }
      return;
    }
    if (app.tool) {
      const newCell = { type: app.tool };
      if (setCell(col, q, newCell)) circuitChanged();
      return;
    }
    if (cell) {
      describeGate(cell.type);
      say('Drag it off the deck (or use the Eraser) to remove it.');
    } else {
      say('Pick a gate first: click one below, or drag it onto this slot.');
    }
  }

  const KEYMAP = { h: 'H', x: 'X', y: 'Y', z: 'Z', c: 'CTRL' };
  function onBoardKey(e) {
    const slot = e.target.closest('.slot');
    if (!slot) return;
    const col = +slot.dataset.col, q = +slot.dataset.q;
    const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (move) {
      e.preventDefault();
      const nc = Math.max(0, Math.min(STEPS - 1, col + move[0]));
      const nq = Math.max(0, Math.min(Q.NUM_QUBITS - 1, q + move[1]));
      const n = $('board').querySelector(`.slot[data-col="${nc}"][data-q="${nq}"]`);
      if (n) n.focus();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (app.circuit[col][q] && setCell(col, q, null)) { app.focus = { col, q }; circuitChanged(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.length === 1 ? (e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase()) : '';
    const type = KEYMAP[key];
    if (!type) return;
    e.preventDefault();
    const cell = { type };
    if (setCell(col, q, cell)) {
      app.focus = { col, q };
      describeGate(type);
      circuitChanged();
    }
  }

  // --------------------------------------------------------------- dance floor canvas
  let lastBeatAt = performance.now();
  let beatCount = 0;
  let flashUntil = 0;
  let celebrateUntil = 0;
  engine.onBeat(() => { lastBeatAt = performance.now(); beatCount++; });

  const DANCERS = Array.from({ length: 11 }, (_, i) => ({
    x: 0.06 + (i / 10) * 0.88 + (i % 2 ? 0.015 : -0.015),
    depth: i % 3,
    hue: (i * 37) % 360,
    offset: (i * 0.37) % 1,
    style: i % 4,
  }));

  function hash(a, b, c) {
    let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function drawFloor() {
    const canvas = $('floor-canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = cw, H = ch;
    const now = performance.now();
    const playing = engine.isRunning;
    const beatPhase = playing ? Math.min(1, (now - lastBeatAt) / BEAT_MS) : 0;
    const pulse = playing && !reducedMotion ? Math.pow(1 - beatPhase, 2) : 0.3;
    const active = app.floor ? app.floor.index : app.solo;
    const probs = Q.probabilities(hearingState());
    const celebrating = now < celebrateUntil;

    ctx.fillStyle = '#07060f';
    ctx.fillRect(0, 0, W, H);

    // light beams
    if (active != null && playing) {
      const color = TRACKS[active].color;
      for (let k = 0; k < 4; k++) {
        const sx = W * (0.15 + k * 0.23);
        const ang = reducedMotion ? 0 : Math.sin(now / 900 + k * 1.7) * 0.5;
        const ex = sx + Math.sin(ang) * H * 1.4;
        const grad = ctx.createLinearGradient(sx, 0, ex, H);
        grad.addColorStop(0, hexA(color, 0.45 * (0.5 + pulse / 2)));
        grad.addColorStop(1, hexA(color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(sx - 4, 0); ctx.lineTo(sx + 4, 0);
        ctx.lineTo(ex + 50, H); ctx.lineTo(ex - 50, H);
        ctx.closePath(); ctx.fill();
      }
    }

    // perspective floor tiles: the patchwork mirrors the mix (cue) or the dropped track
    const horizon = H * 0.45, rows = 6, cols = 14;
    const cumul = [];
    let acc = 0;
    for (let i = 0; i < Q.DIM; i++) { acc += probs[i]; cumul.push(acc); }
    const tick = active != null ? beatCount : Math.floor(now / 1500);
    for (let r = 0; r < rows; r++) {
      const y0 = horizon + (H - horizon) * Math.pow(r / rows, 1.4);
      const y1 = horizon + (H - horizon) * Math.pow((r + 1) / rows, 1.4);
      const spread0 = 0.55 + 0.45 * (r / rows), spread1 = 0.55 + 0.45 * ((r + 1) / rows);
      for (let c = 0; c < cols; c++) {
        const u0 = (c / cols - 0.5), u1 = ((c + 1) / cols - 0.5);
        let color, alpha;
        const h = hash(r, c, tick);
        if (active != null) {
          color = TRACKS[active].color;
          alpha = (h > 0.45 ? 0.75 : 0.22) * (0.45 + 0.55 * pulse);
        } else {
          const pick = hash(r, c, 7);
          let idx = cumul.findIndex((v) => pick < v - 1e-9);
          if (idx < 0) idx = 0;
          color = TRACKS[idx].color;
          alpha = 0.14 + 0.1 * h;
        }
        if (celebrating) { color = TRACKS[(r + c + beatCount) % TRACKS.length].color; alpha = 0.7; }
        if (now < flashUntil) alpha = Math.min(1, alpha + (flashUntil - now) / 600);
        ctx.fillStyle = hexA(color, alpha);
        ctx.beginPath();
        ctx.moveTo(W / 2 + u0 * W * spread0 * 1.1 + 1, y0 + 1);
        ctx.lineTo(W / 2 + u1 * W * spread0 * 1.1 - 1, y0 + 1);
        ctx.lineTo(W / 2 + u1 * W * spread1 * 1.1 - 1, y1 - 1);
        ctx.lineTo(W / 2 + u0 * W * spread1 * 1.1 + 1, y1 - 1);
        ctx.closePath(); ctx.fill();
      }
    }

    // dancers
    const dancing = playing && active != null;
    DANCERS.slice().sort((a, b) => a.depth - b.depth).forEach((d) => {
      const scale = 0.75 + d.depth * 0.18;
      const baseY = H * (0.78 + d.depth * 0.08);
      const x = d.x * W;
      const t = (beatPhase + d.offset * 0.25) % 1;
      const bounce = dancing && !reducedMotion ? Math.abs(Math.sin(t * Math.PI)) * 12 * scale : 0;
      const sway = !reducedMotion ? Math.sin(now / (dancing ? 260 : 900) + d.offset * 6) * (dancing ? 6 : 2) : 0;
      drawDancer(ctx, x + sway, baseY - bounce, scale, d, dancing, t, active);
    });

    // spectrum strip
    const spec = engine.spectrum();
    if (spec && playing) {
      const n = 48, bw = W / n;
      for (let i = 0; i < n; i++) {
        const v = spec[Math.floor(i * spec.length / n * 0.7)] / 255;
        ctx.fillStyle = `rgba(255,255,255,${0.05 + 0.12 * v})`;
        ctx.fillRect(i * bw + 1, H - v * 28, bw - 2, v * 28);
      }
    }
    requestAnimationFrame(drawFloor);
  }

  function drawDancer(ctx, x, y, s, d, dancing, t, active) {
    const body = dancing ? '#f2f0ff' : '#8a87a6';
    const glow = dancing ? TRACKS[active].color : null;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.lineCap = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = body;
    if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = 14; }
    const up = dancing ? (d.style % 2 ? Math.sin(t * Math.PI * 2) : 1) : -0.2;
    // legs
    ctx.beginPath();
    ctx.moveTo(0, -18); ctx.lineTo(-8, 0);
    ctx.moveTo(0, -18); ctx.lineTo(8, 0);
    // torso
    ctx.moveTo(0, -18); ctx.lineTo(0, -44);
    // arms
    ctx.moveTo(0, -40); ctx.lineTo(-12, -40 - 14 * up);
    ctx.moveTo(0, -40); ctx.lineTo(12, -40 - 14 * (d.style === 2 ? -up : up));
    ctx.stroke();
    ctx.beginPath();
    ctx.fillStyle = body;
    ctx.arc(0, -53, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  }

  // --------------------------------------------------------------- wiring
  function wire() {
    $('btn-sound').addEventListener('click', () => {
      if (engine.isRunning) engine.stop(); else startMusic();
      renderSoundButton();
      renderRecords();
      renderFloorText();
    });
    $('volume').addEventListener('input', (e) => engine.setMasterVolume(+e.target.value));
    $('btn-share').addEventListener('click', share);
    $('btn-help').addEventListener('click', () => $('help').showModal());

    $('btn-first').addEventListener('click', () => { stopAuto(); setPlayhead(0); });
    $('btn-back').addEventListener('click', () => { stopAuto(); setPlayhead(Math.min(app.playhead, usedColumns()) - 1); });
    $('btn-fwd').addEventListener('click', () => { stopAuto(); setPlayhead(app.playhead + 1); });
    $('btn-last').addEventListener('click', () => { stopAuto(); setPlayhead(STEPS); });
    $('btn-auto').addEventListener('click', toggleAuto);

    $('btn-erase').addEventListener('click', () => {
      app.tool = app.tool === 'ERASE' ? null : 'ERASE';
      renderPalette();
      $('gate-info').textContent = app.tool ? 'Eraser on: click gates on the deck to remove them.' : 'Eraser off.';
    });
    $('btn-clear').addEventListener('click', () => {
      let removed = false;
      app.circuit.forEach((col) => col.forEach((cell, q) => { if (cell) { col[q] = null; removed = true; } }));
      if (removed) circuitChanged();
    });

    $('palette').addEventListener('click', (e) => {
      if (clickSuppressed()) return;
      const b = e.target.closest('.pal-btn');
      if (!b || b.disabled) return;
      app.tool = app.tool === b.dataset.type ? null : b.dataset.type;
      renderPalette();
      if (app.tool) {
        describeGate(app.tool);
        $('gate-info').append(document.createTextNode(' Now click slots on the deck to place it.'));
      }
    });
    $('palette').addEventListener('mouseover', (e) => {
      const b = e.target.closest('.pal-btn');
      if (b && !app.tool) describeGate(b.dataset.type);
    });

    const board = $('board');
    board.addEventListener('click', onBoardClick);
    board.addEventListener('keydown', onBoardKey);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove, { passive: false });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', () => {
      drag = null;
      $('drag-ghost').hidden = true;
      document.body.style.cursor = '';
    });

    $('btn-drop').addEventListener('click', drop);
    $('btn-cue').addEventListener('click', () => { app.floor = null; app.solo = null; renderHearing(); });
    $('btn-clear-history').addEventListener('click', () => { app.history = []; renderHistory(); });
    $('btn-shots-100').addEventListener('click', () => runShots(100));
    $('btn-shots-1000').addEventListener('click', () => runShots(1000));
    $('btn-table').addEventListener('click', () => {
      const t = $('chart-table');
      t.hidden = !t.hidden;
      $('btn-table').setAttribute('aria-pressed', String(!t.hidden));
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && app.tool) { app.tool = null; renderPalette(); }
    });

    $('help-body').innerHTML = window.HELP_HTML;
    const gates = $('help-gates');
    Q.PALETTE_ORDER.forEach((type) => {
      const g = Q.GATES[type];
      const row = el('div', 'gate-row');
      row.appendChild(makePuck({ type }));
      const p = el('p');
      p.append(el('strong', null, g.name + ': '), document.createTextNode(g.info));
      row.appendChild(p);
      gates.appendChild(row);
    });
  }

  // --------------------------------------------------------------- free-play examples
  const EXAMPLES = window.Examples || []; // defined in js/examples.js

  function buildExamples() {
    const box = $('examples');
    EXAMPLES.forEach((ex) => {
      const b = el('button', 'btn ghost small', ex.name);
      b.title = ex.note;
      b.addEventListener('click', () => {
        if (usedColumns() > 0 && !window.confirm('Replace the current board with the "' + ex.name + '" example?')) return;
        app.circuit = Q.decodeCircuit(ex.set);
        app.history = [];
        $('example-note').textContent = ex.note;
        circuitChanged();
      });
      box.appendChild(b);
    });
  }

  // --------------------------------------------------------------- boot
  function boot() {
    load();
    const m = location.hash.match(/^#set=(.*)$/);
    if (m) {
      app.freeText = decodeURIComponent(m[1]);
      history.replaceState(null, '', location.pathname + location.search);
    }
    buildRecords();
    buildExamples();
    wire();
    app.circuit = Q.decodeCircuit(app.freeText);
    circuitChanged();
    renderSoundButton();
    requestAnimationFrame(drawFloor);
  }

  // used by add-ons (song-loader.js) and automated checks
  window.QDJ = { app, engine, tracks: TRACKS, refreshTracks, say, runShots, drop };
  boot();
})();
