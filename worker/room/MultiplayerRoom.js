import { SharedWorld } from '../simulation/sharedWorld.js';
import { PLAYER_VIEW_R, FISH_VIEW_R } from '../simulation/world.js';
import { formatCatchSystemMessage } from '../../src/fishing/speciesDisplay.js';
import { OthelloRoom } from './othelloRoom.js';

const PROTO_V3 = 3, PROTO_V4 = 4;
const MAX_PLAYERS = 8, CLOCK_START = 6, HOURS_PER_SEC = 1 / 60, WORLD_LIMIT = 500;
const MIN_UPDATE_MS = 70, PUBLISH_MS = 100, SIM_MS = 100;
const FISH_HZ_NORMAL = 5, FISH_HZ_ACTIVE = 10, FISH_FULL_RESYNC_MS = 30000;
const W = { clear: '晴れ', cloudy: 'くもり', rain: '雨' };

const clamp01 = (v) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;

function playerInRange(viewer, target) {
  if (!viewer || !target || viewer.id === target.id) return false;
  if (viewer.fresh || target.fresh) return true;
  return Math.hypot(target.x - viewer.x, target.z - viewer.z) <= PLAYER_VIEW_R;
}

function fishSnapshotHz(p, world) {
  const fs = p.visual?.fs;
  if (p.fresh || fs === 'fight' || fs === 'landing' || fs === 'landed') return FISH_HZ_ACTIVE;
  if (['wait', 'nibble', 'bite', 'flight'].includes(fs)) return FISH_HZ_ACTIVE;
  for (const f of world.fishes.values()) {
    if (f.ownerPlayerId === p.id) return FISH_HZ_ACTIVE;
    if (f.targetBaitId === `b:${p.id}` && ['approaching', 'reserved', 'hooked'].includes(f.state)) return FISH_HZ_ACTIVE;
    if (f.state === 'hooked' && !p.fresh && Math.hypot(f.x - p.x, f.z - p.z) <= FISH_VIEW_R) return FISH_HZ_ACTIVE;
  }
  return FISH_HZ_NORMAL;
}

function makePlayer(p, includeStatic = false) {
  const v = p.visual || {};
  const out = {
    id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, a: p.a,
    fs: v.fs || 'idle', charge: v.charge || 0, tension: v.tension || 0,
    reeling: v.reeling || 0, rarity: v.rarity || 0,
    bx: v.bx || 0, by: v.by || 0, bz: v.bz || 0, line: !!v.line,
  };
  if (includeStatic) Object.assign(out, { name: p.name, rod: v.rod || 'bamboo', bait: v.bait || 'worm' });
  return out;
}

export class MultiplayerRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.players = new Map();
    this.world = new SharedWorld;
    this.simLoop = null;
    this.pubLoop = null;
    this.lastWeather = this.world.weather;
    this._publishDirty = true;
    this.othello = new OthelloRoom();
  }

  async fetch(r) {
    const u = new URL(r.url);
    if (u.pathname === '/api/voice/join') return this._voiceJoin(r);
    if (r.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket expected', { status: 426 });
    const pair = new WebSocketPair;
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async _cf(path, opt = {}) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${this.env.REALTIMEKIT_APP_ID}${path}`, {
      ...opt,
      headers: {
        authorization: `Bearer ${this.env.REALTIMEKIT_API_TOKEN}`,
        'content-type': 'application/json',
        ...(opt.headers || {}),
      },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(`RealtimeKit ${r.status}: ${JSON.stringify(j.errors || j)}`);
    return j;
  }

  async _voiceJoin(r) {
    try {
      if (!this.env.REALTIMEKIT_API_TOKEN) return new Response('RealtimeKit secret missing', { status: 503 });
      const b = await r.json();
      const playerId = String(b.playerId || '').slice(0, 36);
      const name = String(b.name || 'angler').slice(0, 32);
      if (!playerId) return new Response('playerId required', { status: 400 });
      let meetingId = await this.ctx.storage.get('voiceMeetingId');
      if (!meetingId) {
        const m = await this._cf('/meetings', { method: 'POST', body: JSON.stringify({ title: 'Lakeside Fishing lake-1' }) });
        meetingId = m.data?.id;
        if (!meetingId) throw new Error('meeting id missing');
        await this.ctx.storage.put('voiceMeetingId', meetingId);
      }
      let preset = await this.ctx.storage.get('voicePreset');
      if (!preset) {
        const p = await this._cf('/presets?per_page=100');
        preset = p.data?.[0]?.name;
        if (!preset) throw new Error('RealtimeKit preset missing');
        await this.ctx.storage.put('voicePreset', preset);
      }
      const p = await this._cf(`/meetings/${meetingId}/participants`, {
        method: 'POST',
        body: JSON.stringify({ name, custom_participant_id: playerId, preset_name: preset }),
      });
      return Response.json({ token: p.data?.token, participantId: p.data?.id });
    } catch (e) {
      console.error('[voice join]', e);
      return new Response(String(e.message || e), { status: 502 });
    }
  }

  async _clock() {
    let e = await this.ctx.storage.get('clockEpoch');
    if (!e) { e = Date.now(); await this.ctx.storage.put('clockEpoch', e); }
    this.epoch = e;
    return (CLOCK_START + (Date.now() - e) / 1000 * HOURS_PER_SEC) % 24;
  }

  _newPlayer(id, name, proto) {
    return {
      id, name, proto,
      x: 0, y: 0, z: 0, yaw: 0, a: 'idle', fresh: true,
      lastState: 0, lastFight: 0, lastVisual: 0, lastChat: 0, lastUpdate: 0,
      lastFishSnap: 0, lastFullFishResync: 0,
      visual: null, visualVersion: 0, dirty: true,
      visiblePlayers: new Set(),
      visiblePlayerVersions: new Map(),
      knownFishIds: new Set(),
      needsFishFull: true,
    };
  }

  _restore(ws) {
    let p = this.players.get(ws);
    if (p) return p;
    let a;
    try { a = ws.deserializeAttachment(); } catch (e) { }
    if (!a?.joined) return null;
    p = this._newPlayer(a.id, a.name, a.proto || PROTO_V3);
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

  _send(sock, o) {
    try { sock.send(JSON.stringify(o)); } catch (e) { }
  }

  _broadcast(o, except = null) {
    const s = JSON.stringify(o);
    for (const { sock } of this._joined()) {
      if (sock !== except) try { sock.send(s); } catch (e) { }
    }
  }

  _broadcastJoin(joiner, except = null) {
    for (const { sock, p } of this._joined()) {
      if (p === joiner || sock === except || !playerInRange(p, joiner)) continue;
      if ((p.proto || PROTO_V3) >= PROTO_V4) {
        p.visiblePlayers.add(joiner.id);
        p.visiblePlayerVersions.set(joiner.id, -1);
      }
      this._send(sock, { t: 'join', id: joiner.id, name: joiner.name, x: joiner.x, y: joiner.y, z: joiner.z, yaw: joiner.yaw, a: joiner.a });
    }
  }

  _broadcastLeave(leaver) {
    for (const { sock, p } of this._joined()) {
      if (p === leaver) continue;
      const v4 = (p.proto || PROTO_V3) >= PROTO_V4;
      const wasVisible = p.visiblePlayers.has(leaver.id);
      p.visiblePlayers.delete(leaver.id);
      p.visiblePlayerVersions.delete(leaver.id);
      if (!v4 || wasVisible) this._send(sock, { t: 'leave', id: leaver.id, name: leaver.name });
    }
  }

  _system(text) {
    this._broadcast({ t: 'system', text, ts: Date.now() });
  }

  _startLoops() {
    if (this.simLoop) return;
    this.simLoop = setInterval(() => this._simTick(), SIM_MS);
    this.pubLoop = setInterval(() => this._publishTick(), PUBLISH_MS);
  }

  _stopLoops() {
    if (this.simLoop) { clearInterval(this.simLoop); this.simLoop = null; }
    if (this.pubLoop) { clearInterval(this.pubLoop); this.pubLoop = null; }
  }

  _simTick() {
    const joined = this._joined();
    if (!joined.length) { this._stopLoops(); return; }
    this.world.hour = (CLOCK_START + ((Date.now() - (this.epoch ??= Date.now())) / 1000 * HOURS_PER_SEC)) % 24;
    this.world.tick(joined.map((x) => x.p));
    if (this.world.weather !== this.lastWeather) {
      const text = `天候が「${W[this.world.weather] || this.world.weather}」に変わった`;
      this.lastWeather = this.world.weather;
      for (const { sock, p } of joined) {
        if ((p.proto || PROTO_V3) >= PROTO_V4) this._send(sock, { t: 'weather', weather: this.world.weather, text });
        else {
          this._send(sock, { t: 'weather', weather: this.world.weather });
          this._send(sock, { t: 'system', text, ts: Date.now() });
        }
      }
      this._publishDirty = true;
    }
    if (this.world.consumeDirty()) this._publishDirty = true;
  }

  _publishTick() {
    const joined = this._joined();
    if (!joined.length) return;
    const now = Date.now();
    const anyPlayerDirty = joined.some(({ p }) => p.dirty);
    const anyFishDue = joined.some(({ p }) => {
      const interval = 1000 / fishSnapshotHz(p, this.world);
      return p.needsFishFull || now - p.lastFishSnap >= interval;
    });
    if (!anyPlayerDirty && !anyFishDue) return;
    if (anyFishDue) this.world.prepareFishRecords();

    for (const { sock, p: viewer } of joined) {
      if (anyPlayerDirty) {
        if ((viewer.proto || PROTO_V3) >= PROTO_V4) this._publishPlayerSnapshotV4(sock, viewer, joined, now);
        else this._publishPlayerRelayV3(sock, viewer, joined, now);
      }
      this._publishFishSnapshot(sock, viewer, now);
    }

    for (const { p } of joined) p.dirty = false;
    this._publishDirty = false;
  }

  _publishPlayerSnapshotV4(sock, viewer, joined, now) {
    const players = [];
    const removed = [];
    for (const { p: other } of joined) {
      if (other.id === viewer.id) continue;
      const inRange = playerInRange(viewer, other);
      const wasVisible = viewer.visiblePlayers.has(other.id);
      if (inRange) {
        viewer.visiblePlayers.add(other.id);
        const staticChanged = viewer.visiblePlayerVersions.get(other.id) !== other.visualVersion;
        if (!wasVisible || other.dirty || staticChanged) players.push(makePlayer(other, !wasVisible || staticChanged));
        if (!wasVisible || staticChanged) viewer.visiblePlayerVersions.set(other.id, other.visualVersion);
      } else if (wasVisible) {
        viewer.visiblePlayers.delete(other.id);
        viewer.visiblePlayerVersions.delete(other.id);
        removed.push(other.id);
      }
    }
    if (players.length || removed.length) {
      this._send(sock, { t: 'player_snapshot', players, removed });
    }
  }

  _publishPlayerRelayV3(sock, viewer, joined, now) {
    for (const { p: other } of joined) {
      if (other.id === viewer.id || !other.dirty) continue;
      if (!playerInRange(viewer, other)) continue;
      this._send(sock, { t: 's', id: other.id, x: other.x, y: other.y, z: other.z, yaw: other.yaw, a: other.a });
      if (other.visual) this._send(sock, { t: 'v', id: other.id, ...other.visual });
    }
  }

  _publishFishSnapshot(sock, viewer, now) {
    const hz = fishSnapshotHz(viewer, this.world);
    const interval = 1000 / hz;
    if (now - viewer.lastFishSnap < interval && !viewer.needsFishFull) return;
    viewer.lastFishSnap = now;

    const px = viewer.fresh ? null : viewer.x;
    const pz = viewer.fresh ? null : viewer.z;
    const proto = viewer.proto || PROTO_V3;
    const needFull = viewer.needsFishFull || (now - viewer.lastFullFishResync >= FISH_FULL_RESYNC_MS);

    if (proto >= PROTO_V4 && !needFull) {
      const delta = this.world.fishSnapshotDelta(viewer.id, px, pz, viewer.knownFishIds);
      if (!delta.added.length && !delta.fish.length && !delta.removed.length) return;
      for (const id of delta.removed) viewer.knownFishIds.delete(id);
      for (const f of delta.added) viewer.knownFishIds.add(f.id);
      for (const f of delta.fish) viewer.knownFishIds.add(f.id);
      this._send(sock, { t: 'fish_snapshot', mode: 'delta', hz, added: delta.added, fish: delta.fish, removed: delta.removed });
      return;
    }

    const fish = this.world.fishSnapshotFull(viewer.id, px, pz);
    viewer.knownFishIds = new Set(fish.map((f) => f.id));
    viewer.needsFishFull = false;
    viewer.lastFullFishResync = now;
    if (proto >= PROTO_V4) {
      this._send(sock, { t: 'fish_snapshot', mode: 'full', hz, fish });
    } else {
      this._send(sock, { t: 'fish_snapshot', fish });
    }
  }

  _applyState(p, m) {
    const x = +m.x, y = +m.y, z = +m.z, yaw = +m.yaw;
    if (![x, y, z, yaw].every(Number.isFinite) || Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT || Math.abs(y) > 100) return false;
    Object.assign(p, { x, y, z, yaw, a: typeof m.a === 'string' ? m.a.slice(0, 12) : 'idle', fresh: false });
    return true;
  }

  _applyVisual(p, m) {
    const bx = +m.bx, by = +m.by, bz = +m.bz;
    if (![bx, by, bz].every(Number.isFinite)) return false;
    const prev = p.visual || {};
    const numberOr = (value, fallback = 0) => Number.isFinite(+value) ? +value : fallback;
    const rod = String(m.rod || prev.rod || 'bamboo').slice(0, 16);
    const bait = String(m.bait || prev.bait || 'worm').slice(0, 16);
    if (!p.visual || rod !== prev.rod || bait !== prev.bait) p.visualVersion += 1;
    const v = {
      fs: String(m.fs || prev.fs || 'idle').slice(0, 12),
      charge: clamp01(numberOr(m.charge, prev.charge || 0)),
      tension: clamp01(numberOr(m.tension, prev.tension || 0)),
      reeling: clamp01(numberOr(m.reeling, prev.reeling || 0)),
      rod,
      bait,
      rarity: Math.max(0, Math.min(5, +(m.rarity ?? prev.rarity ?? 0) || 0)),
      bx, by, bz,
      line: m.line != null ? !!m.line : !!prev.line,
    };
    p.visual = v;
    return true;
  }

  _applyFight(p, m, now) {
    if (now - p.lastFight < MIN_UPDATE_MS) return;
    p.lastFight = now;
    this.world.fightUpdate(p.id, String(m.fishId || ''), m);
    this._publishDirty = true;
  }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join') {
      const proto = +m.v;
      if (proto !== PROTO_V3 && proto !== PROTO_V4) {
        ws.send(JSON.stringify({ t: 'error', code: 'version' }));
        ws.close(4000, 'version');
        return;
      }
      if (this._joined().length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ t: 'error', code: 'full' }));
        ws.close(4001, 'full');
        return;
      }
      const id = crypto.randomUUID().slice(0, 8);
      const name = String(m.name || '').slice(0, 12) || 'angler';
      const p = this._newPlayer(id, name, proto);
      const joined = this._joined();
      const players = joined.map((x) => ({ id: x.p.id, name: x.p.name, x: x.p.x, y: x.p.y, z: x.p.z, yaw: x.p.yaw, a: x.p.a }));
      const visuals = joined.filter((x) => x.p.visual).map((x) => ({ id: x.p.id, ...x.p.visual }));
      this.players.set(ws, p);
      for (const { p: other } of joined) {
        p.visiblePlayers.add(other.id);
        p.visiblePlayerVersions.set(other.id, other.visualVersion);
      }
      ws.serializeAttachment({ joined: true, id, name, proto });
      if (!this.epoch) this.epoch = await this.ctx.storage.get('clockEpoch') || Date.now();
      const welcome = {
        t: 'welcome', id, v: proto, clock: await this._clock(),
        weather: this.world.weather, players, visuals,
        fish: this.world.fishSnapshotFull(id, null, null),
      };
      if (proto >= PROTO_V4) welcome.fishMode = 'full';
      for (const f of welcome.fish) p.knownFishIds.add(f.id);
      p.needsFishFull = false;
      p.lastFullFishResync = Date.now();
      ws.send(JSON.stringify(welcome));
      this._broadcastJoin(p, ws);
      this._startLoops();
      return;
    }

    const p = this._restore(ws);
    if (!p) return;
    const now = Date.now();

    if (m.t === 'chat') {
      if (now - p.lastChat < 500) return;
      p.lastChat = now;
      const text = String(m.text || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
      if (text) this._broadcast({ t: 'chat', id: p.id, name: p.name, text, ts: now });
      return;
    }

    if (m.t === 'u') {
      if ((p.proto || PROTO_V3) < PROTO_V4) return;
      if (now - p.lastUpdate < MIN_UPDATE_MS) return;
      p.lastUpdate = now;
      let changed = false;
      if (this._applyState(p, m)) changed = true;
      if (this._applyVisual(p, m)) changed = true;
      if (m.fishId && [+m.fx, +m.fy, +m.fz].every(Number.isFinite)) {
        this._applyFight(p, { fishId: m.fishId, x: +m.fx, y: +m.fy, z: +m.fz }, now);
        changed = true;
      }
      if (changed) { p.dirty = true; this._publishDirty = true; }
      return;
    }

    if (m.t === 's') {
      if (now - p.lastState < MIN_UPDATE_MS) return;
      p.lastState = now;
      if (!this._applyState(p, m)) return;
      p.dirty = true;
      this._publishDirty = true;
      return;
    }

    if (m.t === 'v') {
      if (now - p.lastVisual < MIN_UPDATE_MS) return;
      p.lastVisual = now;
      if (!this._applyVisual(p, m)) return;
      p.dirty = true;
      this._publishDirty = true;
      return;
    }

    if (m.t === 'bait') {
      this.world.setBait(p.id, m);
      this._publishDirty = true;
      return;
    }

    if (m.t === 'bait_clear') {
      this.world.setBait(p.id, null);
      this._publishDirty = true;
      return;
    }

    if (m.t === 'hook') {
      const fishId = String(m.fishId || '');
      const f = this.world.fishes.get(fishId);
      let reason = null;
      if (!f) reason = 'missing';
      else if (f.state === 'hooked') reason = f.ownerPlayerId === p.id ? 'already' : 'taken';
      else if (f.state === 'reserved' && f.ownerPlayerId !== p.id) reason = 'owned';
      else if (f.state === 'approaching' && f.targetBaitId !== `b:${p.id}`) reason = 'not_yours';
      else if (f.state !== 'reserved' && f.state !== 'approaching') reason = 'invalid';
      if (!reason && this.world.hook(p.id, fishId)) {
        this._broadcast({ t: 'fish_hooked', fishId, playerId: p.id });
        this._publishDirty = true;
      } else {
        try { ws.send(JSON.stringify({ t: 'fish_hook_rejected', fishId, playerId: p.id, reason: reason || 'conflict' })); } catch (e) { }
      }
      return;
    }

    if (m.t === 'fight') {
      this._applyFight(p, m, now);
      return;
    }

    if (m.t === 'fight_end') {
      const id = String(m.fishId || '');
      const result = m.result === 'caught' ? 'caught' : 'escaped';
      const f = this.world.fishes.get(id);
      const caught = f ? { speciesId: f.speciesId, length: f.length } : null;
      const e = this.world.endFight(p.id, id, result);
      if (e) {
        this._broadcast({ t: e.removed ? 'fish_caught' : 'fish_escaped', fishId: id, playerId: p.id });
        if (e.removed && caught) this._system(formatCatchSystemMessage(p.name, caught.length, caught.speciesId));
        this._publishDirty = true;
      }
      return;
    }

    if (m.t === 'othello_open') {
      this.othello.open(p.id);
      this._broadcastOthelloState();
      return;
    }

    if (m.t === 'othello_close') {
      this.othello.close(p.id);
      return;
    }

    if (m.t === 'othello_move') {
      const result = this.othello.move(p.id, m);
      if (!result.ok) {
        try { ws.send(JSON.stringify({ t: 'othello_reject', reason: result.reason || 'rejected' })); } catch (e) { }
        return;
      }
      this._broadcastOthelloState();
    }
  }

  _broadcastOthelloState() {
    for (const { sock, p } of this._joined()) {
      this._send(sock, { t: 'othello_state', ...this.othello.snapshot(p.id) });
    }
  }

  webSocketClose(ws) { this._drop(ws); }
  webSocketError(ws) { this._drop(ws); }

  _drop(ws) {
    const p = this._restore(ws);
    this.players.delete(ws);
    try { ws.close(); } catch (e) { }
    if (p) {
      this.othello.dropPlayer(p.id);
      this.world.dropPlayer(p.id);
      this._broadcastLeave(p);
      this._broadcastOthelloState();
      this._publishDirty = true;
    }
  }
}
