'use strict';

// Puzzle generation, solving and hint logic. Boards are flat arrays of 81 numbers (0 = empty).

const DIFFICULTIES = {
  easy: { label: 'Easy', clues: 40 },
  medium: { label: 'Medium', clues: 33 },
  hard: { label: 'Hard', clues: 28 },
  expert: { label: 'Expert', clues: 24 },
};

const ROW = [], COL = [], BOX = [];
for (let i = 0; i < 81; i++) {
  ROW[i] = Math.floor(i / 9);
  COL[i] = i % 9;
  BOX[i] = Math.floor(ROW[i] / 3) * 3 + Math.floor(COL[i] / 3);
}

const UNITS = { row: [], column: [], box: [] };
for (let k = 0; k < 9; k++) {
  UNITS.row.push([...Array(81).keys()].filter((i) => ROW[i] === k));
  UNITS.column.push([...Array(81).keys()].filter((i) => COL[i] === k));
  UNITS.box.push([...Array(81).keys()].filter((i) => BOX[i] === k));
}

const PEERS = [...Array(81).keys()].map((i) =>
  [...Array(81).keys()].filter((j) => j !== i && (ROW[j] === ROW[i] || COL[j] === COL[i] || BOX[j] === BOX[i]))
);

function popcount(x) {
  let n = 0;
  while (x) { x &= x - 1; n++; }
  return n;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Backtracking solver using bitmasks and the "fewest candidates first" heuristic.
// Returns how many solutions it found (stops counting at `limit`).
// When `out` is given, the first solution is copied into it.
function solve(grid, { limit = 1, randomize = false, out = null } = {}) {
  const g = grid.slice();
  const rows = new Int32Array(9), cols = new Int32Array(9), boxes = new Int32Array(9);
  for (let i = 0; i < 81; i++) {
    if (!g[i]) continue;
    const bit = 1 << g[i];
    if ((rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]) & bit) return 0;
    rows[ROW[i]] |= bit; cols[COL[i]] |= bit; boxes[BOX[i]] |= bit;
  }

  let count = 0;
  (function search() {
    let best = -1, bestMask = 0, bestCount = 10;
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      const mask = ~(rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]) & 0x3fe;
      const n = popcount(mask);
      if (n < bestCount) {
        best = i; bestMask = mask; bestCount = n;
        if (n <= 1) break;
      }
    }
    if (best === -1) {
      count++;
      if (out && count === 1) for (let i = 0; i < 81; i++) out[i] = g[i];
      return;
    }
    if (bestCount === 0) return;

    const digits = [];
    for (let d = 1; d <= 9; d++) if (bestMask & (1 << d)) digits.push(d);
    if (randomize) shuffle(digits);

    const r = ROW[best], c = COL[best], x = BOX[best];
    for (const d of digits) {
      const bit = 1 << d;
      g[best] = d; rows[r] |= bit; cols[c] |= bit; boxes[x] |= bit;
      search();
      g[best] = 0; rows[r] &= ~bit; cols[c] &= ~bit; boxes[x] &= ~bit;
      if (count >= limit) return;
    }
  })();
  return count;
}

// Builds a random full solution, then removes clues in symmetric pairs while the
// puzzle still has exactly one solution. Fewer clues = harder puzzle.
function generate(difficulty = 'easy') {
  const target = (DIFFICULTIES[difficulty] || DIFFICULTIES.easy).clues;
  let best = null;

  for (let attempt = 0; attempt < 6; attempt++) {
    const solution = new Array(81).fill(0);
    solve(solution, { randomize: true, out: solution });

    const puzzle = solution.slice();
    let clues = 81;
    for (const i of shuffle([...Array(41).keys()])) {
      if (clues <= target) break;
      const j = 80 - i;
      const a = puzzle[i], b = puzzle[j];
      puzzle[i] = 0; puzzle[j] = 0;
      if (solve(puzzle, { limit: 2 }) === 1) clues -= i === j ? 1 : 2;
      else { puzzle[i] = a; puzzle[j] = b; }
    }

    if (!best || clues < best.clues) best = { puzzle, solution, clues };
    if (clues <= target) break;
  }
  return best;
}

function candidateMask(board, i) {
  let used = 0;
  for (const p of PEERS[i]) used |= 1 << board[p];
  return ~used & 0x3fe;
}

// Name of the unit (row/column/box) where `digit` has only one possible spot: cell i.
function hiddenSingleUnit(board, i, digit) {
  const bit = 1 << digit;
  const unitIndex = { row: ROW[i], column: COL[i], box: BOX[i] };
  for (const name of ['row', 'column', 'box']) {
    const others = UNITS[name][unitIndex[name]].filter((j) => j !== i && !board[j]);
    if (!others.some((j) => candidateMask(board, j) & bit)) return name;
  }
  return null;
}

// Picks the most "logical" cell to reveal next and explains why it has that value.
// `board` may contain wrong entries; they are ignored when reasoning.
function findHint(board, solution, preferIdx = null) {
  const known = board.map((v, i) => (v === solution[i] ? v : 0));

  const describe = (i) => {
    const d = solution[i];
    const mask = candidateMask(known, i);
    if (popcount(mask) === 1) {
      return { score: 0, reason: `Only ${d} fits here — every other number already appears in this cell's row, column or box.` };
    }
    const unit = hiddenSingleUnit(known, i, d);
    if (unit) return { score: 1, reason: `${d} has only one possible spot in this ${unit}.` };
    return { score: 2 + popcount(mask), reason: `This cell must be ${d}. It's a tricky one — look for pairs that eliminate candidates.` };
  };

  if (Number.isInteger(preferIdx) && preferIdx >= 0 && preferIdx < 81 && !known[preferIdx]) {
    return { idx: preferIdx, value: solution[preferIdx], ...describe(preferIdx) };
  }

  let options = [], bestScore = Infinity;
  for (let i = 0; i < 81; i++) {
    if (known[i]) continue;
    const info = { idx: i, ...describe(i) };
    if (info.score < bestScore) { options = [info]; bestScore = info.score; }
    else if (info.score === bestScore) options.push(info);
  }
  if (!options.length) return null;
  const pick = options[Math.floor(Math.random() * options.length)];
  return { ...pick, value: solution[pick.idx] };
}

module.exports = { DIFFICULTIES, generate, solve, findHint };
