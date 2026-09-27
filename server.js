'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { DIFFICULTIES, generate, findHint } = require('./server/sudoku');

const PORT = process.env.PORT || 3000;
const HINT_LIMIT = 3;
const MAX_PLAYERS = 8;
const ROOM_TTL_MS = 30 * 60 * 1000; // empty rooms are deleted after 30 minutes
const COLORS = ['#f03e3e', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#e64980', '#5f3dc4'];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server);

// All game state lives in memory. Restarting the server clears every room.
const rooms = new Map();

// ---------- helpers ----------

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isCell = (i) => Number.isInteger(i) && i >= 0 && i < 81;
const connected = (room) => [...room.players.values()].filter((p) => p.connected);

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to avoid confusion
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

// A "sheet" is one board being solved: shared by the team in co-op, one per player in versus.
function freshSheet(puzzle) {
  return {
    board: puzzle.slice(),
    owners: new Array(81).fill(null), // who placed each value (player id or 'hint')
    mistakes: 0,
    hints: 0,
    status: 'playing', // playing | won | lost
    finalTime: null,
    rank: null,
  };
}

const sheetFor = (room, player) => (room.mode === 'coop' ? room.team : player.sheet);
const elapsed = (room) => (room.pausedAt ?? Date.now()) - room.startedAt - room.pausedMs;

function resetPlayer(room, player) {
  player.sheet = freshSheet(room.puzzle);
  player.placed = 0;
  player.mistakes = 0;
  player.hints = 0;
  player.cursor = null;
}

function startGame(room, opts) {
  const difficulty = DIFFICULTIES[opts.difficulty] ? opts.difficulty : 'easy';
  const mode = opts.mode === 'versus' ? 'versus' : 'coop';
  const mistakeLimit = [0, 3, 5].includes(Number(opts.mistakeLimit)) ? Number(opts.mistakeLimit) : 3;
  const { puzzle, solution } = generate(difficulty);

  Object.assign(room, {
    difficulty, mode, mistakeLimit, puzzle, solution,
    gameId: room.gameId + 1,
    startedAt: Date.now(),
    pausedAt: null,
    pausedBy: null,
    pausedMs: 0,
    status: 'playing',
    team: freshSheet(puzzle),
  });
  for (const p of room.players.values()) resetPlayer(room, p);
}

function progress(room, sheet) {
  let total = 0, done = 0;
  for (let i = 0; i < 81; i++) {
    if (room.puzzle[i]) continue;
    total++;
    if (sheet.board[i] === room.solution[i]) done++;
  }
  return total ? Math.round((done * 100) / total) : 100;
}

function finishSheet(room, sheet, status) {
  sheet.status = status;
  sheet.finalTime = elapsed(room);
  if (status === 'won' && room.mode === 'versus') {
    sheet.rank = 1 + [...room.players.values()].filter((p) => p.sheet !== sheet && p.sheet.status === 'won').length;
  }
}

function updateRoomStatus(room) {
  if (room.mode === 'coop') {
    room.status = room.team.status;
  } else {
    const active = connected(room);
    room.status = active.length && active.every((p) => p.sheet.status !== 'playing') ? 'finished' : 'playing';
  }
  if (room.status !== 'playing' && room.pausedAt) {
    room.pausedMs += Date.now() - room.pausedAt;
    room.pausedAt = null;
  }
}

function pushChat(room, msg) {
  room.chat.push(msg);
  if (room.chat.length > 60) room.chat.shift();
  io.to(room.code).emit('chat', msg);
}

const say = (room, text) => pushChat(room, { system: true, text, t: Date.now() });

// Each player gets their own view: in versus mode nobody sees another player's numbers.
function viewFor(room, me) {
  const sheet = sheetFor(room, me);
  const errors = [];
  for (let i = 0; i < 81; i++) if (sheet.board[i] && sheet.board[i] !== room.solution[i]) errors.push(i);

  return {
    code: room.code,
    gameId: room.gameId,
    mode: room.mode,
    difficulty: room.difficulty,
    mistakeLimit: room.mistakeLimit,
    hintLimit: HINT_LIMIT,
    status: room.status,
    startedAt: room.startedAt,
    pausedAt: room.pausedAt,
    pausedBy: room.pausedBy,
    pausedMs: room.pausedMs,
    serverNow: Date.now(),
    puzzle: room.puzzle,
    board: sheet.board,
    owners: sheet.owners,
    errors,
    mistakes: sheet.mistakes,
    hints: sheet.hints,
    sheetStatus: sheet.status,
    finalTime: sheet.finalTime,
    rank: sheet.rank,
    me: me.id,
    players: [...room.players.values()].map((p) => {
      const s = sheetFor(room, p);
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        connected: p.connected,
        placed: p.placed,
        mistakes: p.mistakes,
        hints: p.hints,
        cursor: room.mode === 'coop' ? p.cursor : null,
        progress: progress(room, s),
        status: s.status,
        finalTime: s.finalTime,
        rank: s.rank,
      };
    }),
  };
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.connected) io.to(p.socketId).emit('state', viewFor(room, p));
  }
}

function joinRoom(socket, room, data, ack) {
  if (socket.data.code && socket.data.code !== room.code) leaveRoom(socket, true);

  const id = clean(data.playerId, 40) || crypto.randomUUID();
  const name = clean(data.name, 16) || 'Player';
  let player = room.players.get(id);

  if (!player) {
    if (connected(room).length >= MAX_PLAYERS) return ack({ error: `That room is full (${MAX_PLAYERS} players max).` });
    if (room.players.size >= MAX_PLAYERS) {
      const idle = [...room.players.values()].find((p) => !p.connected);
      if (idle) room.players.delete(idle.id);
    }
    const used = new Set([...room.players.values()].map((p) => p.color));
    player = { id, name, color: COLORS.find((c) => !used.has(c)) || COLORS[0], connected: false };
    resetPlayer(room, player);
    room.players.set(id, player);
  }

  // Same player opened the game in another tab: move them to the new connection.
  if (player.connected && player.socketId !== socket.id) {
    const old = io.sockets.sockets.get(player.socketId);
    if (old) {
      old.leave(room.code);
      old.data.code = null;
      old.emit('kicked', 'You opened this game in another tab.');
    }
  }

  const wasConnected = player.connected;
  Object.assign(player, { name, socketId: socket.id, connected: true });
  socket.data.code = room.code;
  socket.data.playerId = id;
  socket.join(room.code);
  room.emptySince = null;

  ack({ ok: true, code: room.code, playerId: id, chat: room.chat });
  if (!wasConnected) say(room, `${name} joined`);
  updateRoomStatus(room);
  broadcast(room);
}

function leaveRoom(socket, explicit) {
  const room = rooms.get(socket.data.code);
  const id = socket.data.playerId;
  socket.data.code = null;
  if (!room) return;
  socket.leave(room.code);

  const player = room.players.get(id);
  if (!player || player.socketId !== socket.id) return;
  Object.assign(player, { connected: false, socketId: null, cursor: null });
  if (explicit) room.players.delete(id);
  say(room, `${player.name} left`);

  if (!connected(room).length) room.emptySince = Date.now();
  updateRoomStatus(room);
  broadcast(room);
}

// ---------- socket events ----------

io.on('connection', (socket) => {
  // A bad message from one client should never crash the server for everyone.
  const on = (event, handler) =>
    socket.on(event, (...args) => {
      try {
        handler(...args);
      } catch (err) {
        console.error(`Error handling "${event}":`, err);
      }
    });

  const context = () => {
    const room = rooms.get(socket.data.code);
    const player = room && room.players.get(socket.data.playerId);
    return player && player.socketId === socket.id ? { room, player } : null;
  };

  const tell = (text) => socket.emit('toast', { text });

  on('create', (data, ack) => {
    if (typeof ack !== 'function') return;
    const room = { code: makeCode(), players: new Map(), chat: [], gameId: 0, emptySince: null };
    startGame(room, data || {});
    rooms.set(room.code, room);
    joinRoom(socket, room, data || {}, ack);
  });

  on('join', (data, ack) => {
    if (typeof ack !== 'function') return;
    const code = clean(data?.code, 8).toUpperCase();
    const room = rooms.get(code);
    if (!room) return ack({ error: `Room ${code} was not found. It may have expired.` });
    joinRoom(socket, room, data, ack);
  });

  on('leave', () => leaveRoom(socket, true));
  on('disconnect', () => leaveRoom(socket, false));

  on('place', (data) => {
    const ctx = context();
    if (!ctx) return;
    const { room, player } = ctx;
    const idx = data?.idx, value = data?.value;
    if (!isCell(idx) || !Number.isInteger(value) || value < 0 || value > 9) return;
    if (room.pausedAt) return;

    const sheet = sheetFor(room, player);
    if (sheet.status !== 'playing') return;
    if (room.puzzle[idx] || sheet.board[idx] === room.solution[idx]) return; // givens and correct cells are locked
    if (sheet.board[idx] === value) return;

    sheet.board[idx] = value;
    sheet.owners[idx] = value ? player.id : null;

    if (value && value === room.solution[idx]) {
      player.placed++;
    } else if (value) {
      sheet.mistakes++;
      player.mistakes++;
      if (room.mistakeLimit && sheet.mistakes >= room.mistakeLimit) {
        finishSheet(room, sheet, 'lost');
        say(room, room.mode === 'coop' ? `💥 Out of mistakes! The team made ${sheet.mistakes}.` : `💥 ${player.name} is out of mistakes`);
      }
    }

    if (sheet.status === 'playing' && sheet.board.every((v, i) => v === room.solution[i])) {
      finishSheet(room, sheet, 'won');
      const time = formatTime(sheet.finalTime);
      say(room, room.mode === 'coop' ? `🎉 Puzzle solved in ${time}!` : `🏆 ${player.name} finished #${sheet.rank} in ${time}`);
    }

    updateRoomStatus(room);
    broadcast(room);
  });

  on('hint', (data) => {
    const ctx = context();
    if (!ctx) return;
    const { room, player } = ctx;
    const sheet = sheetFor(room, player);
    if (room.pausedAt || sheet.status !== 'playing') return;
    if (sheet.hints >= HINT_LIMIT) return tell('No hints left for this game.');

    const hint = findHint(sheet.board, room.solution, data?.idx ?? null);
    if (!hint) return;

    sheet.board[hint.idx] = hint.value;
    sheet.owners[hint.idx] = 'hint';
    sheet.hints++;
    player.hints++;
    socket.emit('hintResult', { idx: hint.idx, value: hint.value, reason: hint.reason });
    if (room.mode === 'coop') say(room, `💡 ${player.name} used a hint (${HINT_LIMIT - sheet.hints} left)`);

    if (sheet.board.every((v, i) => v === room.solution[i])) {
      finishSheet(room, sheet, 'won');
      say(room, room.mode === 'coop' ? `🎉 Puzzle solved in ${formatTime(sheet.finalTime)}!` : `🏆 ${player.name} finished #${sheet.rank}`);
    }
    updateRoomStatus(room);
    broadcast(room);
  });

  on('select', (data) => {
    const ctx = context();
    if (!ctx) return;
    const { room, player } = ctx;
    player.cursor = isCell(data?.idx) ? data.idx : null;
    if (room.mode === 'coop') socket.to(room.code).emit('cursor', { id: player.id, idx: player.cursor });
  });

  on('pause', () => {
    const ctx = context();
    if (!ctx) return;
    const { room, player } = ctx;
    if (room.status !== 'playing') return;
    if (room.pausedAt) {
      room.pausedMs += Date.now() - room.pausedAt;
      room.pausedAt = null;
      room.pausedBy = null;
      say(room, `▶️ ${player.name} resumed the game`);
    } else {
      room.pausedAt = Date.now();
      room.pausedBy = player.name;
      say(room, `⏸️ ${player.name} paused the game`);
    }
    broadcast(room);
  });

  on('continue', () => {
    const ctx = context();
    if (!ctx) return;
    const { room, player } = ctx;
    if (room.mode !== 'coop' || room.team.status !== 'lost') return;
    Object.assign(room.team, { status: 'playing', finalTime: null });
    room.mistakeLimit = 0;
    say(room, `${player.name} chose to keep going — mistake limit removed`);
    updateRoomStatus(room);
    broadcast(room);
  });

  on('newGame', (data) => {
    const ctx = context();
    if (!ctx) return;
    const { room, player } = ctx;
    startGame(room, data || {});
    const label = DIFFICULTIES[room.difficulty].label;
    say(room, `${player.name} started a new ${label} ${room.mode === 'coop' ? 'co-op' : 'versus'} game`);
    broadcast(room);
  });

  on('chat', (data) => {
    const ctx = context();
    if (!ctx) return;
    const { room, player } = ctx;
    const text = clean(data?.text, 200);
    const now = Date.now();
    if (!text || now - (player.lastChat || 0) < 300) return;
    player.lastChat = now;
    pushChat(room, { id: player.id, name: player.name, color: player.color, text, t: now });
  });
});

function formatTime(ms) {
  const t = Math.floor(ms / 1000);
  const m = Math.floor(t / 60), s = t % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) rooms.delete(code);
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Sudoku Together is running at http://localhost:${PORT}`);
});
