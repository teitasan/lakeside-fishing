import {
  BLACK,
  WHITE,
  createBoard,
  applyMove,
  getLegalMoves,
  hasLegalMove,
  advanceAfterMove,
  advanceAfterPass,
  countStones,
  gameResult,
  playerColor,
  turnPlayerId,
} from '../../src/games/othelloLogic.js';

export class OthelloRoom {
  constructor() {
    this.reset();
  }

  reset() {
    this.status = 'idle';
    this.waiting = [];
    this.players = [];
    this.board = null;
    this.turnColor = BLACK;
    this.winner = null;
  }

  open(playerId) {
    if (this.status === 'playing') {
      return this.snapshot(playerId, { spectator: !this.players.includes(playerId) });
    }
    if (this.status === 'finished') this.reset();

    if (this.status === 'idle') {
      this.status = 'waiting';
      this.waiting = [playerId];
    } else if (this.status === 'waiting') {
      if (this.waiting.includes(playerId)) return this.snapshot(playerId);
      const opponentId = this.waiting.find((id) => id !== playerId);
      if (!opponentId) {
        this.waiting.push(playerId);
        return this.snapshot(playerId);
      }
      this.players = [opponentId, playerId];
      this.waiting = [];
      this.board = createBoard();
      this.turnColor = BLACK;
      this.winner = null;
      this.status = 'playing';
    }
    return this.snapshot(playerId);
  }

  close(playerId) {
    const waitIdx = this.waiting.indexOf(playerId);
    if (waitIdx >= 0) this.waiting.splice(waitIdx, 1);
    if (this.status === 'waiting' && this.waiting.length === 0) this.status = 'idle';
  }

  dropPlayer(playerId) {
    this.close(playerId);
    if (this.status === 'playing' && this.players.includes(playerId)) {
      const other = this.players.find((id) => id !== playerId);
      this.status = 'finished';
      this.winner = other || 'draw';
    }
  }

  move(playerId, payload = {}) {
    if (this.status !== 'playing') return { ok: false, reason: 'not_playing' };
    const color = playerColor(this.players, playerId);
    if (!color) return { ok: false, reason: 'not_player' };
    const expected = turnPlayerId(this.players, this.turnColor);
    if (playerId !== expected) return { ok: false, reason: 'not_turn' };

    if (payload.pass) {
      if (hasLegalMove(this.board, this.turnColor)) return { ok: false, reason: 'has_moves' };
      const next = advanceAfterPass(this.board, this.turnColor);
      if (next.gameOver) {
        this.status = 'finished';
        this.winner = this._resolveWinner();
      } else {
        this.turnColor = next.turnColor;
      }
      return { ok: true };
    }

    const r = +payload.r;
    const c = +payload.c;
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r > 7 || c < 0 || c > 7) {
      return { ok: false, reason: 'invalid_pos' };
    }
    const nextBoard = applyMove(this.board, this.turnColor, r, c);
    if (!nextBoard) return { ok: false, reason: 'illegal_move' };
    this.board = nextBoard;
    const next = advanceAfterMove(this.board, this.turnColor);
    if (next.gameOver) {
      this.status = 'finished';
      this.winner = this._resolveWinner();
    } else {
      this.turnColor = next.turnColor;
    }
    return { ok: true };
  }

  _resolveWinner() {
    const result = gameResult(this.board);
    if (result === 'draw') return 'draw';
    return result === 'black' ? this.players[0] : this.players[1];
  }

  snapshot(forPlayerId, extra = {}) {
    const turn = this.status === 'playing' ? turnPlayerId(this.players, this.turnColor) : null;
    const yourColor = playerColor(this.players, forPlayerId);
    const legal = this.status === 'playing' && turn === forPlayerId
      ? getLegalMoves(this.board, this.turnColor).map(([r, c]) => ({ r, c }))
      : [];
    return {
      status: this.status,
      waiting: [...this.waiting],
      players: [...this.players],
      black: this.players[0] || null,
      white: this.players[1] || null,
      board: this.board ? this.board.map((row) => [...row]) : null,
      turn,
      turnColor: this.turnColor,
      winner: this.winner,
      you: forPlayerId,
      yourColor,
      legal,
      counts: this.board ? countStones(this.board) : null,
      ...extra,
    };
  }
}
