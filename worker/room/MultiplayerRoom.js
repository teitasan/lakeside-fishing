import { SharedWorld } from '../simulation/world.js';
const PROTO = 2, MAX_PLAYERS = 8, CLOCK_START = 6, HOURS_PER_SEC = 1 / 60, WORLD_LIMIT = 500, MIN_STATE_MS = 70;

export class MultiplayerRoom {
  constructor(ctx) {
    this.ctx = ctx; this.players = new Map(); this.world = new SharedWorld();
    this.loop = null; this.lastSnapshot = 0; this.lastWeather = this.world.weather;
  }
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket expected', { status: 426 });
    const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async _clock() {
    let epoch = await this.ctx.storage.get('clockEpoch');
    if (!epoch) { epoch = Date.now(); await this.ctx.storage.put('clockEpoch', epoch); }
    return (CLOCK_START + ((Date.now() - epoch) / 1000) * HOURS_PER_SEC) % 24;
  }
  _restore(ws) {
    let p = this.players.get(ws); if (p) return p;
    let att = null; try { att = ws.deserializeAttachment(); } catch (e) {}
    if (!att?.joined) return null;
    p = { id: att.id, name: att.name, x: 0, y: 0, z: 0, yaw: 0, a: 'idle', fresh: true, lastState: 0, lastFight: 0 };
    this.players.set(ws, p); return p;
  }
  _joined() {
    const out = [];
    for (const sock of this.ctx.getWebSockets()) { const p = this._restore(sock); if (p) out.push({ sock, p }); }
    return out;
  }
  _broadcast(obj, except = null) {
    const s = JSON.stringify(obj);
    for (const { sock } of this._joined()) if (sock !== except) { try { sock.send(s); } catch (e) {} }
  }
  _startLoop() {
    if (this.loop) return;
    this.loop = setInterval(() => {
      const joined = this._joined();
      if (!joined.length) { clearInterval(this.loop); this.loop = null; return; }
      this.world.tick(joined.map(({ p }) => p));
      if (this.world.weather !== this.lastWeather) {
        this.lastWeather = this.world.weather; this._broadcast({ t: 'weather', weather: this.world.weather });
      }
      const now = Date.now();
      if (now - this.lastSnapshot >= 100) {
        this.lastSnapshot = now; this._broadcast({ t: 'fish_snapshot', fish: this.world.snapshot() });
      }
    }, 100);
  }
  async webSocketMessage(ws, raw) {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') {
      if (msg.v !== PROTO) { try { ws.send(JSON.stringify({ t: 'error', code: 'version' })); ws.close(4000, 'version'); } catch (e) {} return; }
      if (this._joined().length >= MAX_PLAYERS) { try { ws.send(JSON.stringify({ t: 'error', code: 'full' })); ws.close(4001, 'full'); } catch (e) {} return; }
      const id = crypto.randomUUID().slice(0, 8), name = String(msg.name || '').slice(0, 12) || 'angler';
      const p = { id, name, x: 0, y: 0, z: 0, yaw: 0, a: 'idle', fresh: true, lastState: 0, lastFight: 0 };
      const others = this._joined().map(({ p: q }) => ({ id: q.id, name: q.name, x: q.x, y: q.y, z: q.z, yaw: q.yaw, a: q.a }));
      this.players.set(ws, p); ws.serializeAttachment({ joined: true, id, name });
      ws.send(JSON.stringify({ t: 'welcome', id, clock: await this._clock(), weather: this.world.weather, players: others, fish: this.world.snapshot() }));
      this._broadcast({ t: 'join', id, name, x: 0, y: 0, z: 0, yaw: 0, a: 'idle' }, ws);
      this._startLoop(); return;
    }
    const p = this._restore(ws); if (!p) return;
    const now = Date.now();
    if (msg.t === 's') {
      if (now - p.lastState < MIN_STATE_MS) return; p.lastState = now;
      const x = +msg.x, y = +msg.y, z = +msg.z, yaw = +msg.yaw;
      if (![x, y, z, yaw].every(Number.isFinite)) return;
      if (Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT || Math.abs(y) > 100) return;
      Object.assign(p, { x, y, z, yaw, a: typeof msg.a === 'string' ? msg.a.slice(0, 12) : 'idle', fresh: false });
      this._broadcast({ t: 's', id: p.id, x, y, z, yaw, a: p.a }, ws); return;
    }
    if (msg.t === 'bait') { this.world.setBait(p.id, msg); return; }
    if (msg.t === 'bait_clear') { this.world.setBait(p.id, null); return; }
    if (msg.t === 'hook') {
      if (this.world.hook(p.id, String(msg.fishId || ''))) this._broadcast({ t: 'fish_hooked', fishId: msg.fishId, playerId: p.id });
      return;
    }
    if (msg.t === 'fight') {
      if (now - p.lastFight < MIN_STATE_MS) return; p.lastFight = now;
      this.world.fightUpdate(p.id, String(msg.fishId || ''), msg); return;
    }
    if (msg.t === 'fight_end') {
      const fishId = String(msg.fishId || ''), result = msg.result === 'caught' ? 'caught' : 'escaped';
      const ended = this.world.endFight(p.id, fishId, result);
      if (ended) this._broadcast({ t: ended.removed ? 'fish_caught' : 'fish_escaped', fishId, playerId: p.id });
    }
  }
  webSocketClose(ws) { this._drop(ws); }
  webSocketError(ws) { this._drop(ws); }
  _drop(ws) {
    const p = this._restore(ws); this.players.delete(ws); try { ws.close(); } catch (e) {}
    if (p) { this.world.dropPlayer(p.id); this._broadcast({ t: 'leave', id: p.id, name: p.name }, ws); }
  }
}
