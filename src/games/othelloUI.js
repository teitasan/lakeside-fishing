import { BLACK, WHITE, EMPTY } from './othelloLogic.js';
import { t, applyDom } from '../i18n.js';

export class OthelloUI {
  constructor(game, sync) {
    this.game = game;
    this.sync = sync;
    this.open = false;
    this.state = null;

    const style = document.createElement('style');
    style.textContent = `
#othello-modal{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(3,7,12,.72);backdrop-filter:blur(6px);z-index:35;pointer-events:auto;padding:16px}
#othello-modal.open{display:flex}
#othello-panel{width:min(92vw,420px);background:linear-gradient(180deg,#0f1824,#0a111a);border:1px solid rgba(245,207,107,.35);border-radius:14px;padding:16px 18px 18px;box-shadow:0 18px 48px rgba(0,0,0,.45)}
#othello-panel h2{margin:0 0 8px;font-size:18px;color:var(--gold,#f5cf6b);letter-spacing:.06em}
#othello-status{font-size:13px;line-height:1.5;color:#dbe6f5;margin-bottom:10px;min-height:2.8em}
#othello-board{display:grid;grid-template-columns:repeat(8,1fr);gap:2px;background:#1a5c36;border:2px solid #0d3d22;border-radius:6px;padding:4px;margin:0 auto 12px;width:min(72vw,320px);aspect-ratio:1}
.othello-cell{aspect-ratio:1;border-radius:3px;background:#2d8f4e;display:flex;align-items:center;justify-content:center;cursor:default;position:relative}
.othello-cell.legal{cursor:pointer;box-shadow:inset 0 0 0 2px rgba(245,207,107,.75)}
.othello-cell.legal::after{content:'';width:28%;height:28%;border-radius:50%;background:rgba(0,0,0,.28)}
.othello-cell.my-turn.legal:hover{background:#349e59}
.othello-stone{width:78%;height:78%;border-radius:50%;box-shadow:inset 0 -2px 4px rgba(0,0,0,.35),0 1px 2px rgba(0,0,0,.35)}
.othello-stone.black{background:radial-gradient(circle at 30% 28%,#666,#111)}
.othello-stone.white{background:radial-gradient(circle at 30% 28%,#fff,#cfcfcf)}
#othello-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
#othello-actions .btn{font-size:13px;padding:8px 16px}
#othello-score{font-size:12px;color:#aab5c0;margin-bottom:8px}
body:not(.playing) #othello-modal{display:none!important}
`;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.id = 'othello-modal';
    this.root.innerHTML = `
<div id="othello-panel" role="dialog" aria-modal="true">
  <h2 data-i18n="ui.othello.title"></h2>
  <div id="othello-score"></div>
  <div id="othello-status"></div>
  <div id="othello-board" aria-label="Othello board"></div>
  <div id="othello-actions">
    <button type="button" class="btn ghost" id="othello-pass" data-i18n="ui.othello.pass"></button>
    <button type="button" class="btn ghost" id="othello-close" data-i18n="ui.othello.close"></button>
  </div>
</div>`;
    document.body.appendChild(this.root);

    this.statusEl = this.root.querySelector('#othello-status');
    this.scoreEl = this.root.querySelector('#othello-score');
    this.boardEl = this.root.querySelector('#othello-board');
    this.passBtn = this.root.querySelector('#othello-pass');
    this.closeBtn = this.root.querySelector('#othello-close');

    this.boardEl.addEventListener('click', (e) => this._onBoardClick(e));
    this.passBtn.addEventListener('click', () => this.sync.requestPass());
    this.closeBtn.addEventListener('click', () => this.close());
    this._cells = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'othello-cell';
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        cell.setAttribute('aria-label', `${r},${c}`);
        this.boardEl.appendChild(cell);
        this._cells.push(cell);
      }
    }
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    if (!this.game.multiplayer || !this.game.mp?.connected) return;
    this.open = true;
    this.root.classList.add('open');
    this.game.ui.openModal = 'othello';
    if (document.pointerLockElement) document.exitPointerLock();
    this.sync.requestOpen();
    applyDom(this.root);
    this.render();
    this.game.audio?.click();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('open');
    if (this.game.ui.openModal === 'othello') this.game.ui.openModal = null;
    this.sync.requestClose();
    this.game.audio?.click();
  }

  setState(state) {
    this.state = state;
    if (this.open) this.render();
  }

  render() {
    const s = this.state;
    if (!s) {
      this.statusEl.textContent = t('ui.othello.connecting');
      this.scoreEl.textContent = '';
      this._renderBoard(null, []);
      this.passBtn.disabled = true;
      return;
    }

    const myId = this.game.mp?.id;
    const blackName = this._name(s.black);
    const whiteName = this._name(s.white);
    this.scoreEl.textContent = s.counts
      ? t('ui.othello.score', { black: s.counts.black, white: s.counts.white, blackName, whiteName })
      : '';

    if (s.status === 'waiting') {
      this.statusEl.textContent = t('ui.othello.waiting');
    } else if (s.status === 'finished') {
      if (s.winner === 'draw') this.statusEl.textContent = t('ui.othello.draw');
      else if (s.winner === myId) this.statusEl.textContent = t('ui.othello.win');
      else this.statusEl.textContent = t('ui.othello.lose', { name: this._name(s.winner) });
    } else if (s.spectator) {
      this.statusEl.textContent = t('ui.othello.spectating', { name: this._name(s.turn) });
    } else if (s.turn === myId) {
      this.statusEl.textContent = t('ui.othello.yourTurn');
    } else {
      this.statusEl.textContent = t('ui.othello.opponentTurn', { name: this._name(s.turn) });
    }

    const myTurn = s.status === 'playing' && s.turn === myId && !s.spectator;
    const legal = myTurn ? (s.legal || []) : [];
    this._renderBoard(s.board, legal, myTurn);
    this.passBtn.disabled = !(myTurn && legal.length === 0);
  }

  _renderBoard(board, legal, myTurn = false) {
    const legalSet = new Set(legal.map(({ r, c }) => `${r},${c}`));
    for (const cell of this._cells) {
      const r = +cell.dataset.r;
      const c = +cell.dataset.c;
      cell.className = 'othello-cell';
      cell.disabled = true;
      cell.innerHTML = '';
      const key = `${r},${c}`;
      if (legalSet.has(key)) {
        cell.classList.add('legal');
        cell.disabled = false;
        if (myTurn) cell.classList.add('my-turn');
      }
      const stone = board?.[r]?.[c];
      if (stone === BLACK || stone === WHITE) {
        const el = document.createElement('div');
        el.className = `othello-stone ${stone === BLACK ? 'black' : 'white'}`;
        cell.appendChild(el);
      }
    }
  }

  _onBoardClick(e) {
    const cell = e.target.closest('.othello-cell');
    if (!cell || cell.disabled || !cell.classList.contains('legal')) return;
    this.sync.requestMove(+cell.dataset.r, +cell.dataset.c);
  }

  _name(id) {
    if (!id) return '—';
    if (id === this.game.mp?.id) return t('ui.othello.you');
    const remote = this.game.remotePlayers?.nameOf?.(id);
    return remote || id.slice(0, 6);
  }
}
