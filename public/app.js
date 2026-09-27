(() => {
  'use strict';

  // ---------- constants & helpers ----------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const ROW = (i) => Math.floor(i / 9);
  const COL = (i) => i % 9;
  const BOX = (i) => Math.floor(ROW(i) / 3) * 3 + Math.floor(COL(i) / 3);
  const UNITS = [];
  for (let k = 0; k < 9; k++) {
    const r0 = Math.floor(k / 3) * 3, c0 = (k % 3) * 3;
    UNITS.push([...Array(9)].map((_, j) => k * 9 + j));
    UNITS.push([...Array(9)].map((_, j) => j * 9 + k));
    UNITS.push([...Array(9)].map((_, j) => (r0 + Math.floor(j / 3)) * 9 + c0 + (j % 3)));
  }
  const PEERS = [...Array(81).keys()].map((i) =>
    [...Array(81).keys()].filter((j) => j !== i && (ROW(j) === ROW(i) || COL(j) === COL(i) || BOX(j) === BOX(i)))
  );
  const isPeer = (a, b) => a !== b && (ROW(a) === ROW(b) || COL(a) === COL(b) || BOX(a) === BOX(b));

  const DIFF_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };
  const MODE_LABEL = { coop: 'Co-op', versus: 'Versus' };
  const FULL_NOTES = 0x3fe;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // localStorage can throw (private mode, blocked storage) — never let that break the game.
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };

  function randomName() {
    const adj = ['Swift', 'Clever', 'Sneaky', 'Happy', 'Brave', 'Lucky', 'Calm', 'Witty', 'Cosmic', 'Sunny'];
    const animal = ['Fox', 'Owl', 'Panda', 'Tiger', 'Otter', 'Koala', 'Falcon', 'Lynx', 'Llama', 'Gecko'];
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    return `${pick(adj)} ${pick(animal)}`;
  }

  // ---------- state ----------

  const S = {
    playerId: store.get('sudoku.playerId', null) || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)),
    code: null,
    view: null,
    errors: new Set(),
    selected: null,
    notesMode: false,
    notes: new Array(81).fill(0), // bitmask per cell, bit d = note d
    undo: [],
    pending: new Map(), // optimistic values shown until the server confirms
    fresh: new Set(),
    clockOffset: 0,
    lastSheetStatus: null,
    opts: Object.assign({ difficulty: 'easy', mode: 'coop', mistakeLimit: 3 }, store.get('sudoku.opts', {})),
  };
  store.set('sudoku.playerId', S.playerId);

  const socket = io();

  // ---------- theme ----------

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('meta[name="theme-color"]').content = theme === 'dark' ? '#0f1220' : '#4c6ef5';
  }
  applyTheme(store.get('sudoku.theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $$('.theme-toggle').forEach((btn) =>
    btn.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      store.set('sudoku.theme', next);
    })
  );

  // ---------- toasts & confetti ----------

  function toast(text, kind = '', ms = 3200) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    $('#toasts').append(el);
    setTimeout(() => el.classList.add('out'), ms);
    setTimeout(() => el.remove(), ms + 350);
  }

  function confetti() {
    const canvas = $('#confetti');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);
    const colors = ['#4c6ef5', '#f03e3e', '#fab005', '#40c057', '#be4bdb', '#15aabf', '#fd7e14'];
    const parts = Array.from({ length: 180 }, () => ({
      x: Math.random() * innerWidth,
      y: -20 - Math.random() * innerHeight * 0.5,
      vx: (Math.random() - 0.5) * 4,
      vy: 2 + Math.random() * 4,
      size: 5 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    const start = performance.now();
    (function frame(now) {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }
      if (now - start < 4000) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })(start);
  }

  // ---------- modal ----------

  const modal = $('#modal');
  function openModal(html) {
    $('#modalCard').innerHTML = html;
    modal.classList.remove('hidden');
    const first = $('#modalCard [data-autofocus]') || $('#modalCard button');
    if (first) first.focus();
  }
  function closeModal() { modal.classList.add('hidden'); }
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  // Segmented option pickers (difficulty / mode / mistake limit).
  function mountOpts(container) {
    container.replaceChildren($('#optsTpl').content.cloneNode(true));
    for (const seg of $$('.seg', container)) {
      const key = seg.dataset.opt;
      const sync = () => $$('button', seg).forEach((b) => b.classList.toggle('active', b.dataset.val === String(S.opts[key])));
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        S.opts[key] = key === 'mistakeLimit' ? Number(btn.dataset.val) : btn.dataset.val;
        store.set('sudoku.opts', S.opts);
        sync();
      });
      sync();
    }
  }

  // ---------- lobby ----------

  const nameInput = $('#nameInput');
  const codeInput = $('#codeInput');
  nameInput.value = store.get('sudoku.name', '') || randomName();
  mountOpts($('#lobbyOpts'));

  function showTab(tab) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $('#createPanel').classList.toggle('hidden', tab !== 'create');
    $('#joinPanel').classList.toggle('hidden', tab !== 'join');
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  function playerName() {
    const name = nameInput.value.trim().slice(0, 16) || randomName();
    nameInput.value = name;
    store.set('sudoku.name', name);
    return name;
  }

  function showScreen(name) {
    $('#lobby').classList.toggle('hidden', name !== 'lobby');
    $('#game').classList.toggle('hidden', name !== 'game');
  }

  function onJoined(res) {
    $('#createBtn').disabled = false;
    $('#joinBtn').disabled = false;
    if (!res || res.error) {
      toast(res ? res.error : 'Something went wrong.', 'error');
      S.code = null;
      history.replaceState(null, '', location.pathname);
      showScreen('lobby');
      return;
    }
    S.code = res.code;
    history.replaceState(null, '', `?room=${res.code}`);
    $('#messages').replaceChildren();
    res.chat.forEach(addMessage);
  }

  $('#createBtn').addEventListener('click', () => {
    $('#createBtn').disabled = true;
    socket.emit('create', { ...S.opts, name: playerName(), playerId: S.playerId }, onJoined);
  });

  function joinRoom(code) {
    code = code.trim().toUpperCase();
    if (code.length !== 5) return toast('Room codes are 5 characters long.', 'error');
    $('#joinBtn').disabled = true;
    socket.emit('join', { code, name: playerName(), playerId: S.playerId }, onJoined);
  }
  $('#joinBtn').addEventListener('click', () => joinRoom(codeInput.value));
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(codeInput.value); });
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

  $('#leaveBtn').addEventListener('click', () => {
    socket.emit('leave');
    S.code = null;
    S.view = null;
    closeModal();
    history.replaceState(null, '', location.pathname);
    showScreen('lobby');
  });

  // ---------- board ----------

  const boardEl = $('#board');
  const cells = [];
  for (let i = 0; i < 81; i++) {
    const el = document.createElement('div');
    el.dataset.i = i;
    el.setAttribute('role', 'gridcell');
    el.innerHTML = `<span class="val"></span><div class="notes">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(() => '<span></span>').join('')}</div><div class="fx"></div>`;
    const base = ['cell', `c${COL(i)}`, `r${ROW(i)}`];
    if (COL(i) % 3 === 2 && COL(i) !== 8) base.push('br');
    if (ROW(i) % 3 === 2 && ROW(i) !== 8) base.push('bb');
    const fx = el.querySelector('.fx');
    fx.addEventListener('animationend', () => { fx.className = 'fx'; });
    cells.push({ el, base: base.join(' '), val: el.querySelector('.val'), notes: [...el.querySelectorAll('.notes span')], fx });
    boardEl.append(el);
  }

  boardEl.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.cell');
    if (cell) select(Number(cell.dataset.i));
  });

  function animate(i, cls, delay = 0) {
    const fx = cells[i].fx;
    fx.className = 'fx';
    void fx.offsetWidth; // restart the animation
    fx.style.animationDelay = `${delay}ms`;
    fx.classList.add(cls);
  }

  const numpad = $('#numpad');
  for (let d = 1; d <= 9; d++) {
    const b = document.createElement('button');
    b.className = 'num';
    b.dataset.d = d;
    b.innerHTML = `<span class="n">${d}</span><span class="left"></span>`;
    b.addEventListener('click', () => input(d));
    numpad.append(b);
  }

  const valueAt = (i) => (S.pending.has(i) ? S.pending.get(i) : S.view.board[i]);
  const isCorrect = (i) => S.view.board[i] !== 0 && !S.errors.has(i) && !S.pending.has(i);
  const isLocked = (i) => S.view.puzzle[i] !== 0 || isCorrect(i);
  const canPlay = () => S.view && S.view.sheetStatus === 'playing' && !S.view.pausedAt;
  const playerById = (id) => S.view.players.find((p) => p.id === id);

  // ---------- rendering ----------

  function render() {
    const v = S.view;
    if (!v) return;
    const sel = S.selected;
    const selVal = sel !== null ? valueAt(sel) : 0;

    const clashes = new Set();
    for (const e of S.errors) for (const p of PEERS[e]) if (v.board[p] === v.board[e]) clashes.add(p);

    const cursors = new Map();
    if (v.mode === 'coop') {
      for (const p of v.players) if (p.id !== v.me && p.connected && p.cursor !== null) cursors.set(p.cursor, p.color);
    }

    const colorOf = new Map(v.players.map((p) => [p.id, p.color]));
    const counts = new Array(10).fill(0);

    for (let i = 0; i < 81; i++) {
      const c = cells[i];
      const val = valueAt(i);
      const given = v.puzzle[i] !== 0;
      const owner = v.owners[i];
      const cls = [c.base];

      if (val && !S.errors.has(i)) counts[val]++;
      if (given) cls.push('given');
      else if (val) cls.push(owner === 'hint' ? 'hinted' : 'user');
      if (S.errors.has(i) && !S.pending.has(i)) cls.push('error');
      if (sel !== null) {
        if (i === sel) cls.push('selected');
        else if (selVal && val === selVal) cls.push('same');
        else if (isPeer(i, sel)) cls.push('peer');
      }
      if (clashes.has(i)) cls.push('clash');
      if (S.fresh.has(i)) cls.push('fresh');

      if (cursors.has(i)) { cls.push('cursor'); c.el.style.setProperty('--cursor', cursors.get(i)); }
      if (v.mode === 'coop' && !given && val && owner && owner !== 'hint' && owner !== v.me && colorOf.has(owner)) {
        cls.push('owned');
        c.el.style.setProperty('--owner', colorOf.get(owner));
      }
      c.el.className = cls.join(' ');

      c.val.textContent = val || '';
      const mask = val ? 0 : S.notes[i];
      for (let d = 1; d <= 9; d++) {
        const span = c.notes[d - 1];
        const on = (mask >> d) & 1;
        span.textContent = on ? d : '';
        span.classList.toggle('hl', !!on && d === selVal);
      }
    }

    // number pad: how many of each digit are still missing
    for (const b of numpad.children) {
      const d = Number(b.dataset.d);
      const left = 9 - counts[d];
      b.querySelector('.left').textContent = left;
      b.classList.toggle('done', left <= 0);
      b.disabled = !canPlay();
    }
    numpad.classList.toggle('notes-mode', S.notesMode);

    // status bar
    $('#roomCode').textContent = v.code;
    $('#diffBadge').textContent = DIFF_LABEL[v.difficulty];
    $('#modeBadge').textContent = MODE_LABEL[v.mode];
    const mistakesEl = $('#mistakes');
    mistakesEl.textContent = v.mistakeLimit ? `${v.mistakes}/${v.mistakeLimit}` : v.mistakes;
    mistakesEl.classList.toggle('danger', v.mistakeLimit > 0 && v.mistakes >= v.mistakeLimit - 1);

    const paused = !!v.pausedAt;
    $('#boardWrap').classList.toggle('paused', paused);
    $('#pauseOverlay').classList.toggle('hidden', !paused);
    $('#pauseText').textContent = v.pausedBy ? `Paused by ${v.pausedBy}` : 'Paused';
    $('#pauseBtn use').setAttribute('href', paused ? '#i-play' : '#i-pause');
    $('#pauseBtn').disabled = v.status !== 'playing';

    $('#notesBtn').classList.toggle('on', S.notesMode);
    $('#notesState').textContent = S.notesMode ? 'ON' : 'OFF';
    const hintsLeft = v.hintLimit - v.hints;
    $('#hintCount').textContent = hintsLeft;
    for (const id of ['undoBtn', 'eraseBtn', 'notesBtn', 'autoBtn']) $(`#${id}`).disabled = !canPlay();
    $('#hintBtn').disabled = !canPlay() || hintsLeft <= 0;

    renderPlayers();
    tickTimer();
  }

  function renderPlayers() {
    const v = S.view;
    const list = $('#players');
    list.replaceChildren();
    const players = [...v.players].sort((a, b) => b.connected - a.connected);
    for (const p of players) {
      const li = document.createElement('li');
      li.className = 'player';
      const you = p.id === v.me ? ' <small>(you)</small>' : '';
      const away = p.connected ? '' : ' <small>· away</small>';
      let meta, stat = '', statCls = '';

      if (v.mode === 'coop') {
        meta = `${p.placed} placed · ${p.mistakes} ✗${p.hints ? ` · ${p.hints} 💡` : ''}`;
      } else {
        meta = `<div class="bar"><i style="width:${p.progress}%;background:${p.color}"></i></div>`;
        if (p.status === 'won') { stat = `🏆 #${p.rank} · ${fmtTime(p.finalTime)}`; statCls = 'won'; }
        else if (p.status === 'lost') { stat = 'Out'; statCls = 'lost'; }
        else stat = `${p.progress}%`;
      }

      li.innerHTML = `
        <div class="avatar ${p.connected ? '' : 'away'}" style="background:${p.color}">${esc(p.name.charAt(0).toUpperCase())}</div>
        <div style="min-width:0"><div class="pname">${esc(p.name)}${you}${away}</div><div class="pmeta">${meta}</div></div>
        <div class="pstat ${statCls}">${stat}</div>`;
      list.append(li);
    }
  }

  function currentTime() {
    const v = S.view;
    if (!v) return 0;
    if (v.finalTime !== null) return v.finalTime;
    const now = Date.now() + S.clockOffset;
    return (v.pausedAt ?? now) - v.startedAt - v.pausedMs;
  }
  function tickTimer() { if (S.view) $('#timer').textContent = fmtTime(currentTime()); }
  setInterval(tickTimer, 250);

  // ---------- notes persistence ----------

  const notesKey = () => `sudoku.notes.${S.view.code}.${S.view.gameId}`;
  function saveNotes() { if (S.view) store.set(notesKey(), S.notes); }
  function loadNotes() {
    const saved = store.get(notesKey(), null);
    S.notes = Array.isArray(saved) && saved.length === 81 ? saved : new Array(81).fill(0);
  }

  // Notes are personal, but every time a correct number lands we clean up
  // that number from the notes around it — just like modern Sudoku apps.
  function applyChanges(prev, v, errors) {
    const prevErrors = new Set(prev.errors);
    const correctNow = (i) => v.board[i] !== 0 && !errors.has(i);
    const correctBefore = (i) => prev.board[i] !== 0 && !prevErrors.has(i);
    const newlyCorrect = [];

    for (let i = 0; i < 81; i++) {
      if (v.board[i] !== prev.board[i]) S.fresh.add(i);
      if (correctNow(i) && !correctBefore(i)) {
        newlyCorrect.push(i);
        const bit = 1 << v.board[i];
        S.notes[i] = 0;
        for (const p of PEERS[i]) S.notes[p] &= ~bit;
        if (v.owners[i] !== v.me && v.owners[i] !== 'hint') animate(i, 'flash');
      }
    }

    // celebrate every row, column or box that just got completed
    for (const unit of UNITS) {
      if (unit.some((i) => newlyCorrect.includes(i)) && unit.every(correctNow)) {
        const origin = unit.find((i) => newlyCorrect.includes(i));
        unit.forEach((i) => animate(i, 'wave', (Math.abs(ROW(i) - ROW(origin)) + Math.abs(COL(i) - COL(origin))) * 45));
      }
    }
    if (newlyCorrect.length) saveNotes();
  }

  // ---------- input ----------

  function select(i) {
    if (!S.view) return;
    S.selected = i;
    socket.emit('select', { idx: i });
    render();
  }

  function input(d, asNote = false) {
    const v = S.view;
    const i = S.selected;
    if (!v || i === null || !canPlay() || isLocked(i)) return;

    if (S.notesMode || asNote) {
      if (valueAt(i)) return;
      S.undo.push({ type: 'note', idx: i, prev: S.notes[i] });
      S.notes[i] ^= 1 << d;
      saveNotes();
      render();
      return;
    }

    if (valueAt(i) === d) return;
    S.undo.push({ type: 'place', idx: i, value: d });
    S.pending.set(i, d);
    socket.emit('place', { idx: i, value: d });
    render();
  }

  function erase() {
    const v = S.view;
    const i = S.selected;
    if (!v || i === null || !canPlay() || isLocked(i)) return;
    if (valueAt(i)) {
      S.pending.set(i, 0);
      socket.emit('place', { idx: i, value: 0 });
    } else if (S.notes[i]) {
      S.undo.push({ type: 'note', idx: i, prev: S.notes[i] });
      S.notes[i] = 0;
      saveNotes();
    }
    render();
  }

  function undo() {
    if (!canPlay()) return;
    while (S.undo.length) {
      const step = S.undo.pop();
      if (step.type === 'note') {
        S.notes[step.idx] = step.prev;
      } else if (step.type === 'allNotes') {
        S.notes = step.prev;
      } else if (step.type === 'place') {
        // Correct numbers are locked, and a teammate may have changed the cell since — skip those.
        if (valueAt(step.idx) !== step.value || isCorrect(step.idx)) continue;
        S.pending.set(step.idx, 0);
        socket.emit('place', { idx: step.idx, value: 0 });
      }
      S.selected = step.idx ?? S.selected;
      saveNotes();
      render();
      return;
    }
    toast('Nothing to undo');
  }

  function autoNotes() {
    const v = S.view;
    if (!canPlay()) return;
    S.undo.push({ type: 'allNotes', prev: S.notes.slice() });
    const known = v.board.map((val, i) => (S.errors.has(i) ? 0 : val));
    for (let i = 0; i < 81; i++) {
      if (known[i]) { S.notes[i] = 0; continue; }
      let mask = FULL_NOTES;
      for (const p of PEERS[i]) mask &= ~(1 << known[p]);
      S.notes[i] = mask;
    }
    saveNotes();
    render();
    toast('✏️ Filled in all possible notes');
  }

  function toggleNotes() {
    S.notesMode = !S.notesMode;
    render();
  }

  function hint() {
    if (!canPlay()) return;
    if (S.view.hints >= S.view.hintLimit) return toast('No hints left for this game.', 'error');
    socket.emit('hint', { idx: S.selected });
  }

  function move(dr, dc) {
    const i = S.selected ?? 40;
    if (S.selected === null) return select(40);
    const r = (ROW(i) + dr + 9) % 9, c = (COL(i) + dc + 9) % 9;
    select(r * 9 + c);
  }

  $('#undoBtn').addEventListener('click', undo);
  $('#eraseBtn').addEventListener('click', erase);
  $('#notesBtn').addEventListener('click', toggleNotes);
  $('#autoBtn').addEventListener('click', autoNotes);
  $('#hintBtn').addEventListener('click', hint);
  $('#pauseBtn').addEventListener('click', () => socket.emit('pause'));
  $('#resumeBtn').addEventListener('click', () => socket.emit('pause'));

  document.addEventListener('keydown', (e) => {
    if (!modal.classList.contains('hidden')) {
      if (e.key === 'Escape') closeModal();
      return;
    }
    if (!S.view || $('#game').classList.contains('hidden')) return;
    if (e.target.closest('input, textarea')) return;
    if (e.altKey || e.metaKey) return;

    const digit = e.code.match(/^(?:Digit|Numpad)([1-9])$/);
    if (digit && !e.ctrlKey) {
      e.preventDefault();
      input(Number(digit[1]), e.shiftKey);
      return;
    }
    const key = e.key.toLowerCase();
    if (e.ctrlKey) {
      if (key === 'z') { e.preventDefault(); undo(); }
      return;
    }
    const actions = {
      arrowup: () => move(-1, 0),
      arrowdown: () => move(1, 0),
      arrowleft: () => move(0, -1),
      arrowright: () => move(0, 1),
      backspace: erase, delete: erase, 0: erase,
      n: toggleNotes, z: undo, u: undo, h: hint,
      a: autoNotes, p: () => socket.emit('pause'),
      escape: () => { S.selected = null; render(); },
    };
    if (actions[key]) {
      e.preventDefault();
      actions[key]();
    }
  });

  // ---------- players, invite, new game, help ----------

  $('#inviteBtn').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?room=${S.code}`;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: 'Play Sudoku with me!', text: `Join my Sudoku game (room ${S.code})`, url }); return; } catch { /* fall back to copy */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('🔗 Invite link copied! Send it to your friends.');
    } catch {
      toast(`Share this link: ${url}`, '', 8000);
    }
  });

  function openNewGame() {
    openModal(`
      <h2>New game</h2>
      <p class="sub">This starts a fresh puzzle for everyone in the room.</p>
      <div id="modalOpts"></div>
      <div class="modal-actions">
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="start" data-autofocus>Start</button>
      </div>`);
    mountOpts($('#modalOpts'));
    $('#modalCard [data-act="cancel"]').onclick = closeModal;
    $('#modalCard [data-act="start"]').onclick = () => {
      socket.emit('newGame', S.opts);
      closeModal();
    };
  }
  $('#newGameBtn').addEventListener('click', openNewGame);

  $('#helpBtn').addEventListener('click', () => {
    openModal(`
      <h2>How to play</h2>
      <p class="sub">Fill every row, column and 3×3 box with the numbers 1–9.</p>
      <ul class="help-list">
        <li><b>Co-op:</b> everyone fills the same board. Colored outlines show where teammates are.</li>
        <li><b>Versus:</b> everyone gets the same puzzle — first to finish wins.</li>
        <li><b>Notes</b> are private pencil marks. They clear themselves when a number is placed.</li>
        <li><b>Hints</b> reveal a cell and explain why it has to be that number.</li>
      </ul>
      <dl class="keys">
        <dt><kbd>1</kbd>–<kbd>9</kbd></dt><dd>Place a number</dd>
        <dt><kbd>Shift</kbd> + <kbd>1</kbd>–<kbd>9</kbd></dt><dd>Toggle a note</dd>
        <dt><kbd>←</kbd><kbd>↑</kbd><kbd>→</kbd><kbd>↓</kbd></dt><dd>Move around</dd>
        <dt><kbd>Backspace</kbd></dt><dd>Erase</dd>
        <dt><kbd>N</kbd></dt><dd>Notes mode on/off</dd>
        <dt><kbd>A</kbd></dt><dd>Auto-fill notes</dd>
        <dt><kbd>Ctrl</kbd> + <kbd>Z</kbd></dt><dd>Undo</dd>
        <dt><kbd>H</kbd></dt><dd>Hint</dd>
        <dt><kbd>P</kbd></dt><dd>Pause / resume</dd>
      </dl>
      <div class="modal-actions"><button class="btn primary" data-autofocus>Got it</button></div>`);
    $('#modalCard .btn').onclick = closeModal;
  });

  function showResult() {
    const v = S.view;
    const time = fmtTime(currentTime());
    const stats = `
      <div class="stats">
        <div><b>${time}</b><span>Time</span></div>
        <div><b>${v.mistakes}</b><span>Mistakes</span></div>
        <div><b>${v.hints}</b><span>Hints</span></div>
      </div>`;
    const actions = (extra) => `<div class="modal-actions">${extra}<button class="btn primary" data-act="new">New game</button></div>`;
    let html;

    if (v.mode === 'coop') {
      const team = [...v.players].sort((a, b) => b.placed - a.placed)
        .map((p) => `<li><span class="dot" style="background:${p.color}"></span>${esc(p.name)}<span class="right">${p.placed} placed</span></li>`).join('');
      html = v.sheetStatus === 'won'
        ? `<div class="modal-emoji">🎉</div><h2>Puzzle solved!</h2><p class="sub">${DIFF_LABEL[v.difficulty]} · ${v.players.length > 1 ? 'Great teamwork!' : 'Nicely done!'}</p>${stats}
           ${v.players.length > 1 ? `<ul class="standings">${team}</ul>` : ''}${actions('<button class="btn" data-act="close">View board</button>')}`
        : `<div class="modal-emoji">💥</div><h2>Out of mistakes</h2><p class="sub">You made ${v.mistakes} mistakes. Keep going without a limit, or start fresh?</p>${stats}
           ${actions('<button class="btn" data-act="continue">Keep playing</button>')}`;
    } else {
      const ranked = [...v.players].sort((a, b) =>
        (a.rank ?? 99) - (b.rank ?? 99) || (a.status === 'lost') - (b.status === 'lost') || b.progress - a.progress);
      const rows = ranked.map((p) => {
        const right = p.status === 'won' ? `#${p.rank} · ${fmtTime(p.finalTime)}` : p.status === 'lost' ? 'Out' : `${p.progress}%`;
        return `<li><span class="dot" style="background:${p.color}"></span>${esc(p.name)}${p.id === v.me ? ' (you)' : ''}<span class="right">${right}</span></li>`;
      }).join('');
      const medal = ['🥇', '🥈', '🥉'][v.rank - 1] || '🏁';
      html = v.sheetStatus === 'won'
        ? `<div class="modal-emoji">${medal}</div><h2>You finished #${v.rank}!</h2><p class="sub">${DIFF_LABEL[v.difficulty]} · Versus</p>${stats}`
        : `<div class="modal-emoji">💥</div><h2>You're out!</h2><p class="sub">Too many mistakes. Cheer on the others or start a new game.</p>${stats}`;
      html += `<ul class="standings">${rows}</ul>${actions('<button class="btn" data-act="close">View board</button>')}`;
    }

    openModal(html);
    const act = (name, fn) => { const b = $(`#modalCard [data-act="${name}"]`); if (b) b.onclick = fn; };
    act('close', closeModal);
    act('new', openNewGame);
    act('continue', () => { socket.emit('continue'); closeModal(); });
    if (v.sheetStatus === 'won') confetti();
  }

  // ---------- chat ----------

  function addMessage(msg) {
    const box = $('#messages');
    const el = document.createElement('div');
    el.className = msg.system ? 'msg system' : 'msg';
    if (msg.system) {
      el.textContent = msg.text;
    } else {
      const name = document.createElement('b');
      name.style.color = msg.color;
      name.textContent = `${msg.name}: `;
      const text = document.createElement('span');
      text.textContent = msg.text;
      if (/^\p{Extended_Pictographic}{1,3}$/u.test(msg.text)) text.className = 'big';
      el.append(name, text);
    }
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.append(el);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat', { text });
    input.value = '';
  });
  $$('.reactions button').forEach((b) => b.addEventListener('click', () => socket.emit('chat', { text: b.textContent })));

  // ---------- socket events ----------

  socket.on('state', (v) => {
    const prev = S.view;
    const isNewGame = !prev || prev.gameId !== v.gameId || prev.code !== v.code;
    const errors = new Set(v.errors);

    S.clockOffset = v.serverNow - Date.now();
    S.pending.clear();
    S.fresh.clear();

    if (isNewGame) {
      S.view = v;
      loadNotes();
      S.undo = [];
      S.selected = null;
      S.notesMode = false;
      S.lastSheetStatus = v.sheetStatus;
      closeModal();
    } else {
      applyChanges(prev, v, errors);
    }

    S.view = v;
    S.errors = errors;
    showScreen('game');
    render();

    if (v.sheetStatus !== S.lastSheetStatus) {
      const was = S.lastSheetStatus;
      S.lastSheetStatus = v.sheetStatus;
      if (was === 'playing') showResult();
      else if (v.sheetStatus === 'playing') closeModal();
    }
  });

  socket.on('cursor', ({ id, idx }) => {
    if (!S.view) return;
    const p = playerById(id);
    if (p) { p.cursor = idx; render(); }
  });

  socket.on('hintResult', ({ idx, reason }) => {
    S.selected = idx;
    render();
    animate(idx, 'glow');
    toast(`💡 ${reason}`, 'hint', 6000);
  });

  socket.on('chat', addMessage);
  socket.on('toast', ({ text }) => toast(text, 'error'));

  socket.on('kicked', (text) => {
    S.code = null;
    S.view = null;
    showScreen('lobby');
    toast(text, 'error', 6000);
  });

  socket.on('connect', () => {
    $('#offline').classList.add('hidden');
    // Automatically rejoin the room after a dropped connection.
    if (S.code) socket.emit('join', { code: S.code, name: playerName(), playerId: S.playerId }, onJoined);
  });
  socket.on('disconnect', () => {
    if (S.code) $('#offline').classList.remove('hidden');
  });

  // ---------- start ----------

  const roomFromUrl = new URLSearchParams(location.search).get('room');
  if (roomFromUrl) {
    codeInput.value = roomFromUrl.toUpperCase();
    showTab('join');
    if (store.get('sudoku.name', null)) joinRoom(roomFromUrl);
    else nameInput.focus();
  }
})();
