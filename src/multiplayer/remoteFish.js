import * as THREE from 'three';
import { Fish, createFishMaterial } from '../fish.js?v=20260827-lkwgfx';
import { REAL_FISH } from '../data.js';
import { Vec3Stream, recvTimeSec, INTERP_DELAY_SEC, INTERP_DELAY_5HZ } from './interpolation.js';

const SPECIES = new Map(REAL_FISH.map((sp) => [sp.id, sp]));
const _dir = new THREE.Vector3();

export class RemoteFishSchool {
  constructor(scene, causticsUniforms = null) {
    this.scene = scene;
    this.causticsUniforms = causticsUniforms;
    this.geoCache = new Map();
    this.map = new Map();
    this.streams = new Map();
    this._interpDelay = INTERP_DELAY_SEC;
  }

  _delayFor(items) {
    if (items?._hz != null && items._hz <= 5) return INTERP_DELAY_5HZ;
    if (items?._hz != null && items._hz >= 10) return INTERP_DELAY_SEC;
    return this._interpDelay;
  }

  _ensureStream(id, x, y, z, tSec, delaySec) {
    let stream = this.streams.get(id);
    if (!stream || stream.delaySec !== delaySec) {
      stream = new Vec3Stream(delaySec);
      stream.snap(x, y, z);
      this.streams.set(id, stream);
    } else stream.push(tSec, x, y, z);
    return stream;
  }

  _spawnFish(s, tSec, delaySec) {
    const sp = SPECIES.get(s.speciesId);
    if (!sp || !s.id) return null;
    const f = new Fish(this.geoCache, () => createFishMaterial(0.4, this.causticsUniforms));
    this.scene.add(f.mesh);
    f.spawn(sp, s.length, new THREE.Vector3(s.x, s.y, s.z), { albino: !!s.albino });
    f.networkId = s.id;
    f.networkState = s.state;
    f.networkOwner = s.ownerPlayerId || null;
    this.map.set(s.id, f);
    this._ensureStream(s.id, s.x, s.y, s.z, tSec, delaySec);
    return f;
  }

  _updateFishMeta(f, s) {
    f.networkState = s.state;
    f.networkOwner = s.ownerPlayerId || null;
  }

  _applyPositions(f, s, tSec, delaySec) {
    if (f.state === 'hooked') return;
    this._ensureStream(s.id, s.x, s.y, s.z, tSec, delaySec);
  }

  applySnapshot(items) {
    const mode = items?._mode || 'full';
    const delaySec = this._delayFor(items);
    this._interpDelay = delaySec;
    const tSec = recvTimeSec(items);

    if (mode === 'delta') {
      for (const id of items._removed || []) {
        const f = this.map.get(id);
        if (!f) continue;
        f.despawn();
        this.scene.remove(f.mesh);
        this.map.delete(id);
        this.streams.delete(id);
      }
      for (const s of items._added || []) {
        if (this.map.has(s.id)) continue;
        this._spawnFish(s, tSec, delaySec);
      }
      for (const s of items._fish || []) {
        const f = this.map.get(s.id);
        if (!f) continue;
        this._updateFishMeta(f, s);
        this._applyPositions(f, s, tSec, delaySec);
      }
      return;
    }

    const seen = new Set();
    for (const s of items || []) {
      if (!s?.id) continue;
      seen.add(s.id);
      let f = this.map.get(s.id);
      if (!f) f = this._spawnFish(s, tSec, delaySec);
      else {
        this._updateFishMeta(f, s);
        this._applyPositions(f, s, tSec, delaySec);
      }
    }
    for (const [id, f] of this.map) {
      if (seen.has(id)) continue;
      f.despawn();
      this.scene.remove(f.mesh);
      this.map.delete(id);
      this.streams.delete(id);
    }
  }

  get(id) { return this.map.get(id) || null; }

  update(dt) {
    const now = performance.now() * 0.001;
    for (const [id, f] of this.map) {
      if (!f.active || f.state === 'hooked' || f.state === 'landed') continue;
      const stream = this.streams.get(id);
      if (!stream) continue;
      const oldX = f.pos.x, oldZ = f.pos.z;
      if (stream.sample(now, f.pos)) {
        f.mesh.position.copy(f.pos);
        const dx = f.pos.x - oldX, dz = f.pos.z - oldZ;
        if (dx * dx + dz * dz > 1e-7) {
          _dir.set(dx, 0, dz).normalize();
          f._orient(dt, _dir, 0);
          f._wiggle(dt, 2.2, 0.07);
        }
      }
    }
  }

  dispose() {
    for (const f of this.map.values()) {
      f.despawn();
      this.scene.remove(f.mesh);
    }
    this.map.clear();
    this.streams.clear();
  }
}
