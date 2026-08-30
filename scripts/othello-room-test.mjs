import assert from 'node:assert/strict';
import { OthelloRoom } from '../worker/room/othelloRoom.js';
import { BLACK, getLegalMoves } from '../src/games/othelloLogic.js';

const room = new OthelloRoom();

const a = room.open('player-a');
assert.equal(a.status, 'waiting');
assert.deepEqual(a.waiting, ['player-a']);

const b = room.open('player-b');
assert.equal(b.status, 'playing');
assert.equal(b.black, 'player-a');
assert.equal(b.white, 'player-b');
assert.equal(b.turn, 'player-a');
assert.equal(b.board[3][3], 2);
const snapA = room.snapshot('player-a');
assert.equal(snapA.legal.length, 4);
assert.equal(b.legal.length, 0, 'waiting player should not see legal moves on opponent turn');

const rejectTurn = room.move('player-b', { r: 2, c: 3 });
assert.equal(rejectTurn.ok, false);
assert.equal(rejectTurn.reason, 'not_turn');

const rejectIllegal = room.move('player-a', { r: 0, c: 0 });
assert.equal(rejectIllegal.ok, false);
assert.equal(rejectIllegal.reason, 'illegal_move');

const ok = room.move('player-a', { r: 2, c: 3 });
assert.equal(ok.ok, true);
assert.equal(room.snapshot('player-a').turn, 'player-b');

const snapB = room.snapshot('player-b');
assert.ok(snapB.legal.length > 0);
const [r, c] = [snapB.legal[0].r, snapB.legal[0].c];
room.move('player-b', { r, c });

const dup = room.open('player-a');
assert.equal(dup.status, 'playing');

room.dropPlayer('player-b');
const afterDrop = room.snapshot('player-a');
assert.equal(afterDrop.status, 'finished');
assert.equal(afterDrop.winner, 'player-a');

const room2 = new OthelloRoom();
room2.open('x');
room2.open('y');
const color = room2.snapshot('x').yourColor;
assert.equal(color, BLACK);
const legal = getLegalMoves(room2.board, BLACK);
assert.ok(legal.length > 0);
const passReject = room2.move('x', { pass: true });
assert.equal(passReject.ok, false);
assert.equal(passReject.reason, 'has_moves');

console.log('OK othello room');
