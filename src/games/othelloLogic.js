export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export const BOARD_SIZE = 8;

const DIRS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

export function opponent(color) {
  return color === BLACK ? WHITE : BLACK;
}

export function createBoard() {
  const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
  board[3][3] = WHITE;
  board[3][4] = BLACK;
  board[4][3] = BLACK;
  board[4][4] = WHITE;
  return board;
}

export function wouldFlip(board, color, r, c, dr, dc) {
  const opp = opponent(color);
  let rr = r + dr;
  let cc = c + dc;
  const flipped = [];
  while (rr >= 0 && rr < BOARD_SIZE && cc >= 0 && cc < BOARD_SIZE) {
    const cell = board[rr][cc];
    if (cell === opp) {
      flipped.push([rr, cc]);
      rr += dr;
      cc += dc;
      continue;
    }
    if (cell === color) return flipped.length ? flipped : null;
    return null;
  }
  return null;
}

export function getLegalMoves(board, color) {
  const moves = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] !== EMPTY) continue;
      for (const [dr, dc] of DIRS) {
        if (wouldFlip(board, color, r, c, dr, dc)) {
          moves.push([r, c]);
          break;
        }
      }
    }
  }
  return moves;
}

export function hasLegalMove(board, color) {
  return getLegalMoves(board, color).length > 0;
}

export function applyMove(board, color, r, c) {
  const legal = getLegalMoves(board, color);
  if (!legal.some(([lr, lc]) => lr === r && lc === c)) return null;
  const next = board.map((row) => [...row]);
  next[r][c] = color;
  for (const [dr, dc] of DIRS) {
    const flips = wouldFlip(next, color, r, c, dr, dc);
    if (flips) {
      for (const [fr, fc] of flips) next[fr][fc] = color;
    }
  }
  return next;
}

export function advanceAfterMove(board, movingColor) {
  const opp = opponent(movingColor);
  if (hasLegalMove(board, opp)) return { turnColor: opp, gameOver: false };
  if (hasLegalMove(board, movingColor)) return { turnColor: movingColor, gameOver: false };
  return { gameOver: true };
}

export function advanceAfterPass(board, passingColor) {
  const opp = opponent(passingColor);
  if (hasLegalMove(board, opp)) return { turnColor: opp, gameOver: false };
  return { gameOver: true };
}

export function countStones(board) {
  let black = 0;
  let white = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell === BLACK) black++;
      else if (cell === WHITE) white++;
    }
  }
  return { black, white };
}

export function gameResult(board) {
  const { black, white } = countStones(board);
  if (black > white) return 'black';
  if (white > black) return 'white';
  return 'draw';
}

export function playerColor(players, playerId) {
  if (playerId === players[0]) return BLACK;
  if (playerId === players[1]) return WHITE;
  return null;
}

export function turnPlayerId(players, turnColor) {
  return turnColor === BLACK ? players[0] : players[1];
}
