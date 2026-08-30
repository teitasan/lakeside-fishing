import assert from 'node:assert/strict';
import {
  BLACK,
  WHITE,
  EMPTY,
  createBoard,
  getLegalMoves,
  applyMove,
  hasLegalMove,
  advanceAfterMove,
  advanceAfterPass,
  countStones,
  gameResult,
} from '../src/games/othelloLogic.js';

const board = createBoard();
assert.equal(board[3][3], WHITE);
assert.equal(board[3][4], BLACK);
assert.deepEqual(countStones(board), { black: 2, white: 2 });

const openingMoves = getLegalMoves(board, BLACK);
assert.equal(openingMoves.length, 4, 'black should have 4 opening moves');

const after = applyMove(board, BLACK, 2, 3);
assert.ok(after, 'standard opening move should succeed');
assert.equal(after[2][3], BLACK);
assert.equal(after[3][3], BLACK, 'flipped stone');

const illegal = applyMove(board, BLACK, 0, 0);
assert.equal(illegal, null, 'corner without flips is illegal');

const packed = createBoard();
for (let r = 0; r < 8; r++) {
  for (let c = 0; c < 8; c++) packed[r][c] = BLACK;
}
packed[7][7] = WHITE;
assert.ok(!hasLegalMove(packed, WHITE), 'single white stone cannot move');
const passNext = advanceAfterPass(packed, WHITE);
assert.equal(passNext.gameOver, true);

const mid = applyMove(board, BLACK, 2, 3);
const turn = advanceAfterMove(mid, BLACK);
assert.equal(turn.turnColor, WHITE);
assert.equal(turn.gameOver, false);

const counts = countStones(mid);
assert.ok(counts.black > counts.white, 'black should lead after first move');

console.log('OK othello logic');
