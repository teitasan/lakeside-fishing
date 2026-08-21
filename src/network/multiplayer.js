const PROTO = 3;
const SEND_HZ = 10;
export const MULTIPLAYER_SEED = 123456789;
export const MP_SESSION_KEY = 'lakeside-fishing-mp-join';
export const MP_NAME_KEY = 'lakeside-fishing-mp-name';

export class MultiplayerClient {
  constructor() {
    this.ws = null; this.id = null; this.connected = false; this.name = '';
    this.onWelcome = null; this.onJoin = null; this.onLeave = null; this.onState = null;
    this.onVisual = null;
    this.onFishSnapshot = null; this.onFishReserved = null; this.onFishHooked = null;
    this.onFishEscaped = null; this.onFishCaught = null; this.onWeather = null;
    this.onClose = null; this.onError = null;
    this._lastSendAt = 0; this._lastSent = '';
    this._lastVisualAt = 0; this._lastVisual = '';
    this._reconnectTimer = null; this._closedByUser = false;
  }

  connect(name) {
    this.name = name || this.name || 'angler';
    this._closedByUser = false;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try { ws = new WebSocket(`${proto}//${location.host}/ws`); }
    catch (e) { this._scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', v: PROTO, name: this.name }));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.t) {
        case 'welcome': this.connected = true; this.id = m.id; this.onWelcome?.(m); break;
        case 'join': this.onJoin?.(m); break;
        case 'leave': this.onLeave?.(m); break;
        case 's': this.onState?.(m); break;
        case 'v': this.onVisual?.(m); break;
        case 'fish_snapshot': this.onFishSnapshot?.(m.fish || []); break;
        case 'fish_reserved': this.onFishReserved?.(m); break;
        case 'fish_hooked': this.onFishHooked?.(m); break;
        case 'fish_escaped': this.onFishEscaped?.(m); break;
        case 'fish_caught': this.onFishCaught?.(m); break;
        case 'weather': this.onWeather?.(m.weather); break;
        case 'error': this.onError?.(m.code); break;
      }
    };
    ws.onclose = () => {
      const was = this.connected; this.connected = false;
      if (was) this.onClose?.();
      if (!this._closedByUser) this._scheduleReconnect();
    };
    ws.onerror = () => { if (!this.connected) this.onError?.('connect'); };
  }

  _scheduleReconnect() {
    if (this._closedByUser || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closedByUser) this.connect(this.name);
    }, 1500);
  }

  _send(obj) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(obj)); return true;
  }

  sendState(x, y, z, yaw, a) {
    if (!this.connected) return;
    const now = performance.now();
    if (now - this._lastSendAt < 1000 / SEND_HZ) return;
    const s = { t: 's', x: round2(x), y: round2(y), z: round2(z), yaw: Math.round(yaw * 1000) / 1000, a };
    const key = `${s.x},${s.y},${s.z},${s.yaw},${s.a}`;
    if (key === this._lastSent && now - this._lastSendAt < 1000) return;
    this._lastSendAt = now; this._lastSent = key; this._send(s);
  }

  /** 他人から見える釣り姿勢・竿・ウキ・糸の状態。最大10Hz。 */
  sendVisual(v) {
    if (!this.connected || !v) return;
    const now = performance.now();
    if (now - this._lastVisualAt < 1000 / SEND_HZ) return;
    const m = {
      t: 'v', fs: String(v.fs || 'idle').slice(0, 12),
      charge: round2(v.charge || 0), tension: round2(v.tension || 0), reeling: round2(v.reeling || 0),
      rod: String(v.rod || 'bamboo').slice(0, 16), bait: String(v.bait || 'worm').slice(0, 16),
      rarity: Math.max(0, Math.min(5, v.rarity | 0)),
      bx: round2(v.bx || 0), by: round2(v.by || 0), bz: round2(v.bz || 0),
      line: !!v.line,
    };
    const key = JSON.stringify(m);
    if (key === this._lastVisual && now - this._lastVisualAt < 1000) return;
    this._lastVisualAt = now; this._lastVisual = key; this._send(m);
  }

  setBait(bait) { this._send({ t: 'bait', ...bait }); }
  clearBait() { this._send({ t: 'bait_clear' }); }
  hookFish(fishId) { this._send({ t: 'hook', fishId }); }
  fightUpdate(fishId, x, y, z) { this._send({ t: 'fight', fishId, x: round2(x), y: round2(y), z: round2(z) }); }
  endFight(fishId, result) { this._send({ t: 'fight_end', fishId, result }); }

  close() {
    this._closedByUser = true; this.connected = false;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    try { this.ws?.close(); } catch (e) { /* noop */ }
  }
}
const round2 = (v) => Math.round(v * 100) / 100;
