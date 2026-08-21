/* ===========================================================
   マルチプレイのネットワーク層（WebSocket クライアント）
   ------------------------------------------------------------
   ゲーム本体からは connect / sendState と少数のコールバックしか触らない。
   プロトコルの対向は worker/room/MultiplayerRoom.js
   =========================================================== */

const PROTO = 1;
const SEND_HZ = 10;          // 位置の送信は最大 10Hz（描画 60fps とは独立）

/* みんなで遊ぶときの湖。全員が同じシードで生成するので地形の同期は要らない。
   ここを変えると全員の湖が変わる（サーバー側の魚を持つ段階でサーバーへ移す） */
export const MULTIPLAYER_SEED = 123456789;

/** タイトル → 再読み込みでマルチプレイ起動を伝える sessionStorage キー */
export const MP_SESSION_KEY = 'lakeside-fishing-mp-join';
/** 前回の名前を覚えておく localStorage キー */
export const MP_NAME_KEY = 'lakeside-fishing-mp-name';

export class MultiplayerClient {
  constructor() {
    this.ws = null;
    this.id = null;
    this.connected = false;
    // ゲーム側が差し込むコールバック
    this.onWelcome = null;   // ({ id, clock, players })
    this.onJoin = null;      // ({ id, name, x, y, z, yaw, a })
    this.onLeave = null;     // ({ id, name })
    this.onState = null;     // ({ id, x, y, z, yaw, a })
    this.onClose = null;     // ()            接続確立後に切れた
    this.onError = null;     // (code)        'connect' | 'version' | 'full'
    this._lastSendAt = 0;
    this._lastSent = '';
  }

  connect(name) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch (e) {
      if (this.onError) this.onError('connect');
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'join', v: PROTO, name }));
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.t) {
        case 'welcome':
          this.connected = true;
          this.id = m.id;
          if (this.onWelcome) this.onWelcome(m);
          break;
        case 'join': if (this.onJoin) this.onJoin(m); break;
        case 'leave': if (this.onLeave) this.onLeave(m); break;
        case 's': if (this.onState) this.onState(m); break;
        case 'error': if (this.onError) this.onError(m.code); break;
      }
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      if (was) {
        if (this.onClose) this.onClose();
      } else if (this.onError) {
        // 一度もつながらずに閉じた（サーバー無し・ネットワーク不通など）
        this.onError('connect');
      }
    };
  }

  /**
   * 自分の状態を送る。10Hz に間引き、変化が無ければ 1 秒 1 回まで落とす
   * （キープアライブを兼ねる）。a はアクション: idle|walk|run|charge|cast|wait|reel|fight
   */
  sendState(x, y, z, yaw, a) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
    const now = performance.now();
    if (now - this._lastSendAt < 1000 / SEND_HZ) return;
    const s = {
      t: 's',
      x: round2(x), y: round2(y), z: round2(z),
      yaw: Math.round(yaw * 1000) / 1000,
      a,
    };
    const key = `${s.x},${s.y},${s.z},${s.yaw},${s.a}`;
    if (key === this._lastSent && now - this._lastSendAt < 1000) return;
    this._lastSendAt = now;
    this._lastSent = key;
    this.ws.send(JSON.stringify(s));
  }

  close() {
    this.connected = false;
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* noop */ }
    }
  }
}

const round2 = (v) => Math.round(v * 100) / 100;
