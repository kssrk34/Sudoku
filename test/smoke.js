'use strict';

// End-to-end check: starts the server, connects two players and plays full games.
// Run with: npm test

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const { DIFFICULTIES, generate, solve } = require('../server/sudoku');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;

function check(name, fn) {
  return Promise.resolve(fn()).then(() => console.log(`  ✓ ${name}`));
}

const nextState = (socket, pred = () => true) =>
  new Promise((resolve) => {
    const handler = (s) => { if (pred(s)) { socket.off('state', handler); resolve(s); } };
    socket.on('state', handler);
  });

const emit = (socket, event, data) => new Promise((resolve) => socket.emit(event, data, resolve));

function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
  });
}

function solutionOf(puzzle) {
  const out = new Array(81).fill(0);
  assert.strictEqual(solve(puzzle, { limit: 2, out }), 1, 'puzzle must have exactly one solution');
  return out;
}

async function main() {
  console.log('Generator');
  for (const level of Object.keys(DIFFICULTIES)) {
    await check(`${level}: unique solution, ~${DIFFICULTIES[level].clues} clues`, () => {
      const t = Date.now();
      const { puzzle, solution, clues } = generate(level);
      const solved = solutionOf(puzzle);
      assert.deepStrictEqual(solved, solution);
      assert.ok(clues <= DIFFICULTIES[level].clues + 4, `${level} has ${clues} clues`);
      assert.ok(Date.now() - t < 3000, 'generation should be fast');
    });
  }

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT } });
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('running') && resolve()));

  const a = await connect();
  const b = await connect();
  try {
    console.log('Co-op');
    const aState = nextState(a);
    const created = await emit(a, 'create', { name: 'Alice', playerId: 'alice', difficulty: 'easy', mode: 'coop', mistakeLimit: 3 });
    assert.ok(created.ok && created.code.length === 5);
    let s = await aState;
    const solution = solutionOf(s.puzzle);

    await check('second player joins the same room', async () => {
      const bState = nextState(b);
      const joined = await emit(b, 'join', { code: created.code.toLowerCase(), name: 'Bob', playerId: 'bob' });
      assert.ok(joined.ok);
      const bs = await bState;
      assert.strictEqual(bs.players.length, 2);
      assert.deepStrictEqual(bs.puzzle, s.puzzle);
      assert.strictEqual(bs.solution, undefined, 'solution must never be sent to clients');
    });

    await check('unknown room is rejected', async () => {
      const c = await connect();
      const res = await emit(c, 'join', { code: 'ZZZZZ', name: 'Eve', playerId: 'eve' });
      assert.ok(res.error);
      c.close();
    });

    const empty = s.puzzle.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);

    await check('wrong number counts a mistake for the whole team', async () => {
      const idx = empty[0];
      const wrong = (solution[idx] % 9) + 1;
      const next = nextState(b, (x) => x.mistakes === 1);
      a.emit('place', { idx, value: wrong });
      const bs = await next;
      assert.deepStrictEqual(bs.errors, [idx]);
      assert.strictEqual(bs.board[idx], wrong);
    });

    await check('givens cannot be overwritten', async () => {
      const given = s.puzzle.findIndex((v) => v);
      a.emit('place', { idx: given, value: (s.puzzle[given] % 9) + 1 });
      a.emit('chat', { text: 'ping' }); // anything to force a round trip
      await new Promise((r) => a.once('chat', r));
      const next = nextState(a);
      a.emit('select', { idx: 0 });
      b.emit('place', { idx: empty[1], value: solution[empty[1]] });
      const as = await next;
      assert.strictEqual(as.board[given], s.puzzle[given]);
    });

    await check('hint reveals a cell with an explanation', async () => {
      const hinted = new Promise((r) => b.once('hintResult', r));
      b.emit('hint', {});
      const h = await hinted;
      assert.strictEqual(h.value, solution[h.idx]);
      assert.ok(h.reason.length > 10);
    });

    await check('teammate cursors are shared', async () => {
      const got = new Promise((r) => b.once('cursor', r));
      a.emit('select', { idx: 42 });
      const c = await got;
      assert.deepStrictEqual(c, { id: 'alice', idx: 42 });
    });

    await check('filling every cell wins the game for both players', async () => {
      const won = nextState(b, (x) => x.sheetStatus === 'won');
      for (const idx of empty) a.emit('place', { idx, value: solution[idx] });
      const bs = await won;
      assert.strictEqual(bs.status, 'won');
      assert.ok(bs.finalTime >= 0);
    });

    console.log('Versus');
    await check('boards are private and players are ranked', async () => {
      const aNew = nextState(a, (x) => x.mode === 'versus');
      const bNew = nextState(b, (x) => x.mode === 'versus');
      a.emit('newGame', { difficulty: 'medium', mode: 'versus', mistakeLimit: 3 });
      const [as] = await Promise.all([aNew, bNew]);
      const sol = solutionOf(as.puzzle);
      const cells = as.puzzle.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);

      const bSees = nextState(b, (x) => x.players.find((p) => p.id === 'alice').progress > 0);
      a.emit('place', { idx: cells[0], value: sol[cells[0]] });
      const bs = await bSees;
      assert.strictEqual(bs.board[cells[0]], 0, "Bob must not see Alice's numbers");

      const bWon = nextState(b, (x) => x.sheetStatus === 'won');
      for (const idx of cells) b.emit('place', { idx, value: sol[idx] });
      assert.strictEqual((await bWon).rank, 1);

      const aWon = nextState(a, (x) => x.sheetStatus === 'won');
      for (const idx of cells) a.emit('place', { idx, value: sol[idx] });
      const final = await aWon;
      assert.strictEqual(final.rank, 2);
      assert.strictEqual(final.status, 'finished');
    });

    await check('mistake limit knocks a player out', async () => {
      const aNew = nextState(a, (x) => x.difficulty === 'hard');
      a.emit('newGame', { difficulty: 'hard', mode: 'coop', mistakeLimit: 3 });
      const as = await aNew;
      const sol = solutionOf(as.puzzle);
      const idx = as.puzzle.findIndex((v) => !v);
      const lost = nextState(a, (x) => x.sheetStatus === 'lost');
      for (const off of [1, 2, 3]) a.emit('place', { idx, value: ((sol[idx] + off - 1) % 9) + 1 });
      const ls = await lost;
      assert.strictEqual(ls.mistakes, 3);

      const resumed = nextState(a, (x) => x.sheetStatus === 'playing');
      a.emit('continue');
      assert.strictEqual((await resumed).mistakeLimit, 0);
    });

    console.log('\nAll checks passed ✅');
  } finally {
    a.close();
    b.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
