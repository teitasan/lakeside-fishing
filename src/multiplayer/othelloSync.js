import { applyMove, getLegalMoves, hasLegalMove, playerColor, turnPlayerId } from '../games/othelloLogic.js';
import { t } from '../i18n.js';

export class MultiplayerOthelloSync {
  constructor(game, mp, ui) {
    this.game = game;
    this.mp = mp;
    this.ui = ui;
    this.state = null;
    this._lastRejectAt = 0;
  }

  requestOpen() {
    if (!this.mp?.connected) return;
    this.mp.sendOthelloOpen();
  }

  requestClose() {
    if (!this.mp?.connected) return;
    this.mp.sendOthelloClose();
  }

  requestMove(r, c) {
    if (!this._canAct()) return;
    if (!this._validateMove(r, c)) return;
    this.mp.sendOthelloMove({ r, c });
  }

  requestPass() {
    if (!this._canAct()) return;
    if (!this._validatePass()) return;
    this.mp.sendOthelloMove({ pass: true });
  }

  onState(m) {
    this.state = m;
    this.ui?.setState(m);
  }

  onReject(m) {
    this._lastRejectAt = performance.now();
    const key = `ui.othello.reject.${m.reason || 'unknown'}`;
    this.game.ui?.toast?.(t(key), 'bad');
  }

  _canAct() {
    const s = this.state;
    const myId = this.mp?.id;
    return !!s && s.status === 'playing' && s.turn === myId && !s.spectator;
  }

  _validateMove(r, c) {
    const s = this.state;
    if (!s?.board || s.turn !== this.mp?.id) return false;
    const color = playerColor(s.players, this.mp.id);
    if (!color || turnPlayerId(s.players, s.turnColor) !== this.mp.id) return false;
    const legal = getLegalMoves(s.board, s.turnColor);
    if (!legal.some(([lr, lc]) => lr === r && lc === c)) return false;
    return !!applyMove(s.board, s.turnColor, r, c);
  }

  _validatePass() {
    const s = this.state;
    if (!s?.board || s.turn !== this.mp?.id) return false;
    return !hasLegalMove(s.board, s.turnColor);
  }
}
