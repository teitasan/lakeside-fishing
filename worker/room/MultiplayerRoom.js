/* ===========================================================
   MultiplayerRoom（Durable Object）
   ------------------------------------------------------------
   1 ルーム = 1 オブジェクト。WebSocket Hibernation API を使うので、
   接続が張られたままでも誰も動いていなければ休止できる。

   第一版のプロトコル（クライアント側は src/network/multiplayer.js）:
     C→S: { t:'join', v, name }
          { t:'s', x, y, z, yaw, a }        位置・向き・アクション（最大10Hz）
     S→C: { t:'welcome', id, clock, players:[...] }
          { t:'join', id, name, x, y, z, yaw, a }
          { t:'leave', id, name }
          { t:'s', id, x, y, z, yaw, a }
          { t:'error', code }               'version' | 'full'
   =========================================================== */

const PROTO = 1;
const MAX_PLAYERS = 8;
/* ゲーム内時刻。クライアントの HOURS_PER_SEC (1/60) と同じ規則で、
   ルームが最初に作られた瞬間を 6 時としてサーバー実時間から一意に決まる */
const CLOCK_START = 6;
const HOURS_PER_SEC = 1 / 60;
const WORLD_LIMIT = 500;   // 座標の妥当性チェック（湖の外周は ~460m）

export class MultiplayerRoom {
  constructor(ctx) {
    this.ctx = ctx;
    /* ws -> player。休止から起きるとメモリは空になるが、恒久的な情報
       （id・name）は attachment に入れてあるので _restore で作り直せる。
       位置は次の状態メッセージ（≦100ms 後）ですぐ埋まる */
    this.players = new Map();
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket expected', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** ルームの時刻（時 0-24）。初回アクセス時の実時刻を起点に決まる */
  async _clock() {
    let epoch = await this.ctx.storage.get('clockEpoch');
    if (!epoch) {
      epoch = Date.now();
      await this.ctx.storage.put('clockEpoch', epoch);
    }
    return (CLOCK_START + ((Date.now() - epoch) / 1000) * HOURS_PER_SEC) % 24;
  }

  /** 休止明けなどでメモリに居ないプレイヤーを attachment から復元する */
  _restore(ws) {
    let p = this.players.get(ws);
    if (p) return p;
    let att = null;
    try { att = ws.deserializeAttachment(); } catch (e) { /* noop */ }
    if (!att || !att.joined) return null;
    p = { id: att.id, name: att.name, x: 0, y: 0, z: 0, yaw: 0, a: 'idle', fresh: true };
    this.players.set(ws, p);
    return p;
  }

  _joined() {
    const out = [];
    for (const sock of this.ctx.getWebSockets()) {
      const p = this._restore(sock);
      if (p) out.push({ sock, p });
    }
    return out;
  }

  _broadcast(obj, except = null) {
    const s = JSON.stringify(obj);
    for (const { sock } of this._joined()) {
      if (sock === except) continue;
      try { sock.send(s); } catch (e) { /* 切断中は無視 */ }
    }
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'join') {
      if (msg.v !== PROTO) {
        try {
          ws.send(JSON.stringify({ t: 'error', code: 'version' }));
          ws.close(4000, 'version');
        } catch (e) { /* noop */ }
        return;
      }
      if (this._joined().length >= MAX_PLAYERS) {
        try {
          ws.send(JSON.stringify({ t: 'error', code: 'full' }));
          ws.close(4001, 'full');
        } catch (e) { /* noop */ }
        return;
      }
      const id = crypto.randomUUID().slice(0, 8);
      const name = String(msg.name || '').slice(0, 12) || 'angler';
      const p = { id, name, x: 0, y: 0, z: 0, yaw: 0, a: 'idle', fresh: true };
      // join より先に他プレイヤーの一覧を取る（自分を含めないため）
      const others = this._joined().map(({ p: q }) => ({
        id: q.id, name: q.name, x: q.x, y: q.y, z: q.z, yaw: q.yaw, a: q.a,
      }));
      this.players.set(ws, p);
      ws.serializeAttachment({ joined: true, id, name });
      ws.send(JSON.stringify({ t: 'welcome', id, clock: await this._clock(), players: others }));
      this._broadcast({ t: 'join', id, name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, a: p.a }, ws);
      return;
    }

    const p = this._restore(ws);
    if (!p) return;   // join 前のメッセージは捨てる

    if (msg.t === 's') {
      const x = +msg.x, y = +msg.y, z = +msg.z, yaw = +msg.yaw;
      if (!isFinite(x) || !isFinite(y) || !isFinite(z) || !isFinite(yaw)) return;
      if (Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT || Math.abs(y) > 100) return;
      p.x = x; p.y = y; p.z = z; p.yaw = yaw;
      p.a = typeof msg.a === 'string' ? msg.a.slice(0, 12) : 'idle';
      p.fresh = false;
      this._broadcast({ t: 's', id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, a: p.a }, ws);
    }
  }

  webSocketClose(ws) { this._drop(ws); }
  webSocketError(ws) { this._drop(ws); }

  _drop(ws) {
    const p = this._restore(ws);
    this.players.delete(ws);
    try { ws.close(); } catch (e) { /* noop */ }
    if (p) this._broadcast({ t: 'leave', id: p.id, name: p.name }, ws);
  }
}
