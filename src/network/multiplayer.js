import { multiplayerWsUrl } from '../config/runtime.js';

const PROTO = 4, SEND_HZ = 10;
export const MULTIPLAYER_SEED = 123456789, MP_SESSION_KEY = 'lakeside-fishing-mp-join', MP_NAME_KEY = 'lakeside-fishing-mp-name';

const r = (v) => Math.round(v * 100) / 100;

export class MultiplayerClient {
  constructor() {
    this.ws = null;
    this.id = null;
    this.connected = false;
    this.name = '';
    this.onWelcome = this.onJoin = this.onLeave = this.onState = this.onVisual = null;
    this.onPlayerSnapshot = this.onPlayerOut = this.onFishSnapshot = this.onFishReserved = this.onFishHooked = null;
    this.onFishHookRejected = this.onFishEscaped = this.onFishCaught = this.onWeather = null;
    this.onChat = this.onSystem = this.onClose = this.onError = null;
    this._reconnectTimer = null;
    this._closedByUser = false;
    this._reconnecting = false;
    this._lastFlushAt = 0;
    this._staged = null;
    this._staticRod = null;
    this._staticBait = null;
    this._staticRarity = null;
    this._lastSentKey = '';
  }

  connect(name) {
    this.name = name || this.name || 'angler';
    this._closedByUser = false;
    this._reconnecting = !!this.id;
    this._resetSession();
    let ws;
    try { ws = new WebSocket(multiplayerWsUrl()); } catch (e) { this._scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', v: PROTO, name: this.name }));
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      const recvAt = performance.now();
      m._recvAt = recvAt;
      if (m.t === 'welcome') { this.connected = true; this.id = m.id; }
      if (m.t === 'fish_snapshot') {
        const payload = this._normalizeFishSnapshot(m, recvAt);
        this.onFishSnapshot?.(payload);
        return;
      }
      if (m.t === 'player_snapshot') {
        for (const p of m.players || []) {
          p._recvAt = recvAt;
          if (this.onPlayerSnapshot) this.onPlayerSnapshot(p);
          else {
            this.onState?.(p);
            if (p.fs || p.line != null) this.onVisual?.(p);
          }
        }
        for (const id of m.removed || []) {
          if (this.onPlayerOut) this.onPlayerOut({ id });
          else this.onLeave?.({ id, outOfRange: true });
        }
        return;
      }
      if (m.t === 'weather') {
        this.onWeather?.(m.weather, m);
        if (m.text) this.onSystem?.({ text: m.text, ts: Date.now() });
        return;
      }
      const h = {
        welcome: this.onWelcome, join: this.onJoin, leave: this.onLeave,
        s: this.onState, v: this.onVisual,
        fish_reserved: this.onFishReserved, fish_hooked: this.onFishHooked,
        fish_hook_rejected: this.onFishHookRejected, fish_escaped: this.onFishEscaped,
        fish_caught: this.onFishCaught, chat: this.onChat, system: this.onSystem, error: this.onError,
      };
      h[m.t]?.(m);
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      if (was) this.onClose?.();
      if (!this._closedByUser) this._scheduleReconnect();
    };
    ws.onerror = () => { if (!this.connected) this.onError?.('connect'); };
  }

  _normalizeFishSnapshot(m, recvAt) {
    const mode = m.mode || m.fishMode || 'full';
    if (mode === 'delta') {
      const payload = { _mode: 'delta', _added: m.added || [], _removed: m.removed || [], _fish: m.fish || [] };
      payload._recvAt = recvAt;
      payload._hz = m.hz;
      return payload;
    }
    const fish = m.fish || [];
    fish._mode = 'full';
    fish._recvAt = recvAt;
    fish._hz = m.hz;
    return fish;
  }

  _scheduleReconnect() {
    if (this._closedByUser || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closedByUser) this.connect(this.name);
    }, 1500);
  }

  _resetSession() {
    this._lastFlushAt = 0;
    this._staged = null;
    this._staticRod = null;
    this._staticBait = null;
    this._staticRarity = null;
    this._lastSentKey = '';
  }

  _send(o) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(o));
    return true;
  }

  sendChat(text) {
    const s = String(text || '').trim().slice(0, 120);
    if (s) this._send({ t: 'chat', text: s });
  }

  sendState(x, y, z, yaw, a) {
    if (!this.connected) return;
    this._stage({ x: r(x), y: r(y), z: r(z), yaw: Math.round(yaw * 1000) / 1000, a });
  }

  sendVisual(v) {
    if (!this.connected || !v) return;
    const patch = {
      fs: String(v.fs || 'idle').slice(0, 12),
      charge: r(v.charge || 0),
      tension: r(v.tension || 0),
      reeling: r(v.reeling || 0),
      bx: r(v.bx || 0), by: r(v.by || 0), bz: r(v.bz || 0),
      line: !!v.line,
    };
    const rod = String(v.rod || 'bamboo').slice(0, 16);
    const bait = String(v.bait || 'worm').slice(0, 16);
    const rarity = Math.max(0, Math.min(5, v.rarity | 0));
    if (rod !== this._staticRod) { patch.rod = rod; this._staticRod = rod; }
    if (bait !== this._staticBait) { patch.bait = bait; this._staticBait = bait; }
    if (rarity !== this._staticRarity) { patch.rarity = rarity; this._staticRarity = rarity; }
    this._stage(patch);
  }

  fightUpdate(fishId, x, y, z) {
    if (!this.connected) return;
    this._stage({ fishId: String(fishId || ''), fx: r(x), fy: r(y), fz: r(z) });
  }

  _stage(patch) {
    this._staged = { ...(this._staged || {}), ...patch };
  }

  flushUpdate(force = false) {
    if (!this.connected || !this._staged) return;
    const now = performance.now();
    if (!force && now - this._lastFlushAt < 1000 / SEND_HZ) return;
    const s = this._staged;
    const key = JSON.stringify({
      ...s,
      rod: s.rod ?? this._staticRod,
      bait: s.bait ?? this._staticBait,
      rarity: s.rarity ?? this._staticRarity,
    });
    if (!force && key === this._lastSentKey && now - this._lastFlushAt < 1000) return;
    this._lastFlushAt = now;
    this._lastSentKey = key;
    this._staged = null;
    this._send({ t: 'u', ...s });
  }

  setBait(b) { this._send({ t: 'bait', ...b }); }
  clearBait() { this._send({ t: 'bait_clear' }); }
  hookFish(f) { this._send({ t: 'hook', fishId: f }); }
  endFight(f, result) { this._send({ t: 'fight_end', fishId: f, result }); }

  close() {
    this._closedByUser = true;
    this.connected = false;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    try { this.ws?.close(); } catch (e) { }
  }
}
