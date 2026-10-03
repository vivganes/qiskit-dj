/*
 * Quantum DJ — songs for the 2-qubit booth.
 *
 * Each slot plays, in order of priority:
 *   1. a file the teacher picked in the Songs panel (kept only in this browser, IndexedDB)
 *   2. the song listed for it in QDJ_CONFIG.songs (e.g. songs/track1.mp3)
 *   3. the synthesized demo beat from tracks-booth.js
 *
 * Songs are streamed through the mixer, so volume/phase work on them like on the synth.
 *
 * Over http(s) the listed files are fetched directly. From file:// that does not work:
 * browsers block fetch() there, and Web Audio outputs silence for a file:// <audio> src
 * (CORS). So each song also has an embedded copy, mp3s/<name>.mp3.js, made by
 * `npm run songs` and loaded with a <script> tag, which file:// pages are allowed to do.
 * The copy alone is enough (the MP3 can be deleted); over http it is the fallback.
 * Neither exists on a student's computer unless they add songs: slots then play demo beats.
 */
(function () {
  'use strict';
  const QDJ = window.QDJ;
  const Q = window.Quantum;
  const tracks = QDJ.tracks;
  const $ = (id) => document.getElementById(id);
  const DB_NAME = 'quantum-dj-songs';
  const STORE = 'slots';

  const SONGS = (window.QDJ_CONFIG && window.QDJ_CONFIG.songs) || [];
  const isHttp = /^https?:$/.test(location.protocol);

  tracks.forEach((t, i) => {
    t.defaultTitle = (SONGS[i] && SONGS[i].title) || t.title;
    t.demoStyle = t.style;
  });
  // source: '' (demo beat) | 'file' (picked by the teacher) | 'bundled' (from QDJ_CONFIG.songs)
  const slots = tracks.map(() => ({ title: null, start: 0, blob: null, fileName: '', url: null, el: null, source: '', note: '' }));

  // --------------------------------------------------------------- IndexedDB
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'slot' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const dbReady = openDb().catch(() => null);

  async function saveSlot(i) {
    const db = await dbReady;
    if (!db) return;
    const s = slots[i];
    const keepBlob = s.source === 'file' ? s.blob : null; // bundled songs are re-read, not copied
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ slot: i, title: s.title, start: s.start, blob: keepBlob, fileName: keepBlob ? s.fileName : '' });
      tx.oncomplete = tx.onerror = tx.onabort = resolve; // quota errors just mean "not remembered"
    });
  }

  async function loadSaved() {
    const db = await dbReady;
    if (!db) return [];
    return new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  // --------------------------------------------------------------- applying songs
  function titleFromFile(name) {
    return name.replace(/\.[^.]+$/, '').replace(/^[\d\s._-]+/, '').replace(/[_]+/g, ' ').trim() || name;
  }

  function updateTrackInfo(i) {
    const s = slots[i], t = tracks[i];
    t.title = s.title || t.defaultTitle;
    t.name = s.el ? t.title : t.title + ' · demo beat';
    t.style = s.el ? `song file: ${s.fileName}` : `placeholder ${t.demoStyle} (load a song file to hear the real one)`;
  }

  /** Attach an audio blob to slot i and route it into the mixer. */
  function attach(i, { blob, fileName, source }) {
    const s = slots[i];
    detach(i, false);
    s.blob = blob;
    s.fileName = fileName;
    s.source = source;
    s.url = URL.createObjectURL(blob);
    const el = new Audio();
    el.preload = 'auto';
    el.src = s.url;
    el.addEventListener('loadedmetadata', () => {
      if (s.start > 0 && s.start < el.duration) el.currentTime = s.start;
      renderRow(i);
    });
    // loop back to the chosen start point instead of the very beginning
    el.addEventListener('ended', () => { el.currentTime = s.start < el.duration ? s.start : 0; el.play().catch(() => {}); });
    el.addEventListener('error', () => {
      if (slots[i].el !== el) return; // an old element being torn down
      QDJ.say(`Could not play "${fileName}". Try an MP3 or M4A file.`);
      detach(i);
    });
    s.el = el;
    QDJ.engine.setMedia(i, el);
    updateTrackInfo(i);
  }

  function detach(i, refresh = true) {
    const s = slots[i];
    if (s.el) {
      QDJ.engine.setMedia(i, null);
      s.el.removeAttribute('src');
      s.el.load();
    }
    if (s.url) URL.revokeObjectURL(s.url);
    Object.assign(s, { blob: null, fileName: '', url: null, el: null, source: '', note: '' });
    updateTrackInfo(i);
    if (refresh) { renderRow(i); QDJ.refreshTracks(); }
  }

  async function pickFile(i, file, useFileTitle) {
    if (!file) return;
    if (useFileTitle || !slots[i].title) slots[i].title = titleFromFile(file.name);
    attach(i, { blob: file, fileName: file.name, source: 'file' });
    renderRow(i);
    QDJ.refreshTracks();
    await saveSlot(i);
  }

  // --------------------------------------------------------------- UI
  const rows = [];
  function buildRows() {
    const list = $('song-rows');
    tracks.forEach((t, i) => {
      const li = document.createElement('li');
      li.className = 'song-row';
      li.style.setProperty('--track', t.color);

      const ket = document.createElement('span');
      ket.className = 'song-ket';
      ket.textContent = Q.ketLabel(i);

      const title = document.createElement('input');
      title.type = 'text';
      title.className = 'song-title';
      title.maxLength = 60;
      title.placeholder = t.defaultTitle;
      title.setAttribute('aria-label', `Song title for ${Q.ketLabel(i)}`);
      title.addEventListener('change', () => {
        slots[i].title = title.value.trim() || null;
        updateTrackInfo(i);
        QDJ.refreshTracks();
        saveSlot(i);
      });

      const pick = document.createElement('label');
      pick.className = 'btn ghost small';
      pick.textContent = 'Choose file…';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.hidden = true;
      input.addEventListener('change', () => { pickFile(i, input.files[0], false); input.value = ''; });
      pick.appendChild(input);

      const startWrap = document.createElement('label');
      startWrap.className = 'song-start';
      startWrap.textContent = 'start at ';
      const start = document.createElement('input');
      start.type = 'number';
      start.min = '0';
      start.step = '1';
      start.value = '0';
      start.setAttribute('aria-label', `Start ${Q.ketLabel(i)} at this many seconds (for example, the chorus)`);
      start.addEventListener('change', () => {
        slots[i].start = Math.max(0, Math.round(+start.value || 0));
        const el = slots[i].el;
        if (el && el.duration && slots[i].start < el.duration) el.currentTime = slots[i].start;
        saveSlot(i);
      });
      startWrap.append(start, document.createTextNode(' s'));

      const status = document.createElement('span');
      status.className = 'song-status';

      const remove = document.createElement('button');
      remove.className = 'btn ghost small';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        detach(i);
        await saveSlot(i);
        loadBundled(i); // fall back to the song from the mp3s folder, if there is one
      });

      li.append(ket, title, pick, startWrap, status, remove);
      list.appendChild(li);
      rows.push({ title, start, status, remove });
    });

    $('songs-multi').addEventListener('change', async (e) => {
      const files = [...e.target.files].slice(0, tracks.length);
      for (let k = 0; k < files.length; k++) await pickFile(k, files[k], true);
      e.target.value = '';
      if (files.length) QDJ.say(`Loaded ${files.length} song${files.length > 1 ? 's' : ''} in the order you picked them.`);
    });
  }

  function renderRow(i) {
    const r = rows[i], s = slots[i];
    if (!r) return;
    r.title.value = s.title || '';
    r.start.value = String(s.start || 0);
    r.remove.disabled = s.source !== 'file';
    r.remove.title = s.source === 'file' ? 'Remove your file and go back to the default song' : '';
    if (s.el) {
      const dur = s.el.duration;
      const len = Number.isFinite(dur) ? ` (${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')})` : '';
      r.status.textContent = (s.source === 'file' ? 'your file: ' : '') + s.fileName + len;
      r.status.classList.add('loaded');
    } else {
      r.status.textContent = s.note || 'demo beat (no file yet)';
      r.status.classList.remove('loaded');
    }
  }

  // --------------------------------------------------------------- bundled songs
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => { el.remove(); resolve(); };
      el.onerror = () => { el.remove(); reject(new Error('missing ' + src)); };
      document.head.appendChild(el);
    });
  }

  /** The song as a Blob: the MP3 itself when served over http(s), else its embedded .js copy. */
  async function readSong(file) {
    if (isHttp) {
      try {
        // fetched as a blob so "start at" can always seek (not every server supports range requests)
        const res = await fetch(encodeURI(file), { cache: 'no-cache' });
        if (res.ok) return res.blob();
      } catch (e) { /* fall through to the embedded copy */ }
    }
    await loadScript(encodeURI(file) + '.js');
    const store = window.QDJ_SONG_DATA || {};
    const dataUrl = store[file];
    delete store[file]; // free the big string once it's a blob
    if (!dataUrl) throw new Error(`${file}.js has no song data`);
    return (await fetch(dataUrl)).blob();
  }

  /** Can the browser open this audio file at all? (works from file://, unlike fetch) */
  function audioExists(url) {
    return new Promise((resolve) => {
      const a = new Audio();
      const done = (ok) => { a.removeAttribute('src'); resolve(ok); };
      a.preload = 'metadata';
      a.onloadedmetadata = () => done(true);
      a.onerror = () => done(false);
      setTimeout(() => done(false), 4000);
      a.src = encodeURI(url);
    });
  }

  async function loadBundled(i) {
    const entry = SONGS[i];
    const s = slots[i];
    if (!entry || !entry.file || s.source === 'file') return;
    const name = entry.file.split('/').pop();
    s.note = `loading ${name}…`;
    renderRow(i);
    try {
      const blob = await readSong(entry.file);
      if (slots[i].source === 'file') return; // the teacher picked a file meanwhile
      attach(i, { blob, fileName: name, source: 'bundled' });
    } catch (e) {
      // No song on this computer is normal (e.g. a student's copy): say how to add one.
      const mp3ButNoCopy = !isHttp && await audioExists(entry.file);
      s.note = mp3ButNoCopy
        ? `found ${name} but not its .js copy: run "npm run songs" (see README)`
        : 'demo beat: use Choose file… to play your own song';
    }
    updateTrackInfo(i);
    renderRow(i);
    QDJ.refreshTracks();
  }

  // --------------------------------------------------------------- startup
  async function init() {
    buildRows();
    const saved = await loadSaved();
    const savedSlots = new Set();
    saved.forEach((rec) => {
      const i = rec.slot;
      if (!slots[i]) return;
      savedSlots.add(i);
      slots[i].title = rec.title || null;
      slots[i].start = rec.start || 0;
      if (rec.blob) attach(i, { blob: rec.blob, fileName: rec.fileName || 'saved song', source: 'file' });
    });
    tracks.forEach((_, i) => {
      if (!savedSlots.has(i) && SONGS[i] && SONGS[i].start) slots[i].start = Math.max(0, +SONGS[i].start || 0);
      updateTrackInfo(i);
      renderRow(i);
    });
    QDJ.refreshTracks();
    await Promise.all(tracks.map((_, i) => loadBundled(i)));
  }

  init();
})();
